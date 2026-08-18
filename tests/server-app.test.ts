import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { getRequestListener } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BFF_ROUTE_PREFIXES, buildHonoApp, isBffRoute, OPAQUE_ORIGIN_ERROR } from '../server/app';
import { CONTENT_DIR_NOT_CONFIGURED } from '../server/routes/content';

describe('BFF origin boundary', () => {
  it('rejects requests from opaque sandbox origins before routing', async () => {
    const response = await buildHonoApp().request('/api/status', {
      headers: { Origin: 'null' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: OPAQUE_ORIGIN_ERROR });
  });

  it('keeps ordinary app origins working', async () => {
    const response = await buildHonoApp().request('/api/status', {
      headers: { Origin: 'http://localhost:5173' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, service: 'fated-poem-bff' });
  });
});

describe('BFF response encoding boundary', () => {
  it('does not advertise Brotli after Node fetch has decoded the upstream body', async () => {
    const payload = JSON.stringify({ choices: [{ message: { content: 'ok' } }] });
    const compressed = brotliCompressSync(Buffer.from(payload));
    const upstream = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Encoding': 'br',
        });
        response.end(compressed);
      });
    });

    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = upstream.address() as AddressInfo;
      const response = await buildHonoApp().request('/api/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Target-Base-URL': `http://127.0.0.1:${address.port}`,
        },
        body: JSON.stringify({ messages: [], stream: false }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ choices: [{ message: { content: 'ok' } }] });
      expect(response.headers.get('content-encoding')).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe('BFF image passthrough', () => {
  // 🔴 图像生成 v1 §12.1: /api/image/generate 必须复用 forward() 的管道直通。
  // 任何一条会 `await res.json()` / `res.text()` 的实现都会在非法 UTF-8 字节处
  // 塞进 U+FFFD 把 zip 悄悄读坏 —— 不报错，只是解不开。本用例喂的正是一段
  // 全非法 UTF-8 的字节，读坏了这里立刻现形。
  it('forwards zip bytes verbatim and keeps the upstream content-type', async () => {
    // 'PK\x03\x04' 开头（zip 魔数），其余是刻意挑的非法 UTF-8 字节
    const zipBytes = Buffer.from('504b030489fffe8081c0c1f5eda08000010203efbf', 'hex');
    const upstream = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, {
          'Content-Type': 'application/x-zip-compressed',
          'X-Seen-Accept': String(request.headers.accept ?? ''),
          'X-Seen-Auth': String(request.headers.authorization ?? ''),
          'X-Seen-Url': String(request.url ?? ''),
        });
        response.end(zipBytes);
      });
    });

    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = upstream.address() as AddressInfo;
      const response = await buildHonoApp().request('/api/image/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-zip-compressed',
          Authorization: 'Bearer nai-token',
          'X-Target-Base-URL': `http://127.0.0.1:${address.port}`,
        },
        body: JSON.stringify({ model: 'nai-diffusion-4-5-full', action: 'generate', input: 'a' }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/x-zip-compressed');
      // 路径后缀由本路由补，Accept 与 Authorization 由 forward() 透传（§12.1 第 3/4 条）
      expect(response.headers.get('x-seen-url')).toBe('/ai/generate-image');
      expect(response.headers.get('x-seen-accept')).toBe('application/x-zip-compressed');
      expect(response.headers.get('x-seen-auth')).toBe('Bearer nai-token');

      const received = Buffer.from(await response.arrayBuffer());
      expect(received.equals(zipBytes)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe('BFF ComfyUI passthrough', () => {
  // 🔴 图像 v2 C10 的三条透传。这里最要紧的一条是 **query 不许丢**：
  // `forward(c, suffix)` 拼的上游 URL 就是 `X-Target-Base-URL + suffix`，
  // 它**根本不看请求自己的查询串** —— 路由不自己把 query 拼进 suffix 的话，
  // `/view` 会打成一个没有 filename 的裸路径，ComfyUI 回 400，而报错里一个字
  // 都不会提到「参数丢了」。
  //
  // 第二条是 `/view` 的字节原样过（PNG 里全是非法 UTF-8 字节，读坏了立刻现形）。

  /** 起一台把「我看到的 URL」回显在头里的假上游 */
  async function startEcho(body: Buffer, contentType: string) {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, {
          'Content-Type': contentType,
          'X-Seen-Url': String(request.url ?? ''),
          'X-Seen-Method': String(request.method ?? ''),
        });
        response.end(body);
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });
    const address = upstream.address() as AddressInfo;
    return {
      base: `http://127.0.0.1:${address.port}`,
      close: () =>
        new Promise<void>((resolve, reject) => {
          upstream.close((error) => (error ? reject(error) : resolve()));
        }),
    };
  }

  it('POST /comfy/prompt 打到上游 /prompt，请求体原样过', async () => {
    const echo = await startEcho(Buffer.from('{"prompt_id":"p1"}'), 'application/json');
    try {
      const response = await buildHonoApp().request('/api/image/comfy/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Target-Base-URL': echo.base },
        body: JSON.stringify({ prompt: { '3': { class_type: 'KSampler' } } }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('x-seen-url')).toBe('/prompt');
      expect(response.headers.get('x-seen-method')).toBe('POST');
    } finally {
      await echo.close();
    }
  });

  it('GET /comfy/history/:id 把 id 插进路径并转义', async () => {
    const echo = await startEcho(Buffer.from('{}'), 'application/json');
    try {
      const app = buildHonoApp();

      const plain = await app.request(`/api/image/comfy/history/abc-123`, {
        headers: { 'X-Target-Base-URL': echo.base },
      });
      expect(plain.headers.get('x-seen-url')).toBe('/history/abc-123');
      expect(plain.headers.get('x-seen-method')).toBe('GET');

      // 上游的 prompt_id 是 uuid，但转义是白拿的一道保险
      const weird = await app.request(`/api/image/comfy/history/${encodeURIComponent('a b/c')}`, {
        headers: { 'X-Target-Base-URL': echo.base },
      });
      expect(weird.headers.get('x-seen-url')).toBe('/history/a%20b%2Fc');
    } finally {
      await echo.close();
    }
  });

  it('🔴 GET /comfy/view 把查询串一起带上，PNG 字节逐字节原样过', async () => {
    // 魔数真、其余是刻意挑的非法 UTF-8 字节：被按文本读过一次就会现形
    const png = Buffer.from('89504e470d0a1a0a80fffec0c1eda0000102efbf', 'hex');
    const echo = await startEcho(png, 'image/png');
    try {
      const response = await buildHonoApp().request(
        '/api/image/comfy/view?filename=a%20b%26c.png&subfolder=sub&type=output',
        { headers: { 'X-Target-Base-URL': echo.base } },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      // query 丢了的话这里会是光秃秃的 `/view`
      expect(response.headers.get('x-seen-url')).toBe(
        '/view?filename=a%20b%26c.png&subfolder=sub&type=output',
      );

      const received = Buffer.from(await response.arrayBuffer());
      expect(received.equals(png)).toBe(true);
    } finally {
      await echo.close();
    }
  });

  // 🔴 取消善后的两条（2026-08-08 审查补）。没有它们，前端的「取消」只停自己的轮询，
  // ComfyUI 那头照跑不误 —— 显卡照占、图照落进输出目录，而随后那次重试还要排在
  // 这张被遗弃的图后面。
  it('POST /comfy/queue 打到上游 /queue，删除指令原样过', async () => {
    const echo = await startEcho(Buffer.from('{}'), 'application/json');
    try {
      const response = await buildHonoApp().request('/api/image/comfy/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Target-Base-URL': echo.base },
        body: JSON.stringify({ delete: ['p1'] }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('x-seen-url')).toBe('/queue');
      expect(response.headers.get('x-seen-method')).toBe('POST');
    } finally {
      await echo.close();
    }
  });

  it('GET /comfy/queue 同一条路由 —— 发 /interrupt 之前要先问「跑的是不是我们这张」', async () => {
    const echo = await startEcho(Buffer.from('{"queue_running":[]}'), 'application/json');
    try {
      const response = await buildHonoApp().request('/api/image/comfy/queue', {
        headers: { 'X-Target-Base-URL': echo.base },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('x-seen-url')).toBe('/queue');
      expect(response.headers.get('x-seen-method')).toBe('GET');
    } finally {
      await echo.close();
    }
  });

  it('POST /comfy/interrupt 打到上游 /interrupt', async () => {
    const echo = await startEcho(Buffer.from('{}'), 'application/json');
    try {
      const response = await buildHonoApp().request('/api/image/comfy/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Target-Base-URL': echo.base },
        body: '{}',
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('x-seen-url')).toBe('/interrupt');
      expect(response.headers.get('x-seen-method')).toBe('POST');
    } finally {
      await echo.close();
    }
  });
});

describe('BFF base URL 规范化（SEC-09）', () => {
  // 🔴 各路由把上游路径写死在 suffix 里，靠的是「suffix 一定会拼上去」这个前提。
  // base 末尾一个 `#` 就能把它整段吃进 fragment（fetch 不发 fragment），BFF 随即
  // 沦为任意主机 + 任意路径的取回器。下面第一条就是那次实测的回归钉子。

  /** 起一台把「我看到的 URL」回显在头里的假上游 */
  async function startEcho() {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Seen-Url': String(request.url ?? ''),
        });
        response.end('{}');
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });
    const address = upstream.address() as AddressInfo;
    return {
      base: `http://127.0.0.1:${address.port}`,
      close: () =>
        new Promise<void>((resolve, reject) => {
          upstream.close((error) => (error ? reject(error) : resolve()));
        }),
    };
  }

  it('🔴 base 末尾的 `#` 吃不掉 suffix —— 上游拿到的路径仍以约定 suffix 结尾', async () => {
    const echo = await startEcho();
    try {
      const response = await buildHonoApp().request(
        '/api/image/comfy/view?filename=x.png&type=output',
        { headers: { 'X-Target-Base-URL': `${echo.base}/data/stolen.json#` } },
      );

      expect(response.status).toBe(200);
      // 修之前这里是光秃秃的 `/data/stolen.json` —— suffix 整段进了 fragment
      expect(response.headers.get('x-seen-url')).toBe(
        '/data/stolen.json/view?filename=x.png&type=output',
      );
    } finally {
      await echo.close();
    }
  });

  it('base 自带的 query 同样吃不掉 suffix', async () => {
    const echo = await startEcho();
    try {
      const response = await buildHonoApp().request('/api/image/comfy/view?filename=x.png', {
        headers: { 'X-Target-Base-URL': `${echo.base}/data/stolen.json?a=1` },
      });

      expect(response.headers.get('x-seen-url')).toBe('/data/stolen.json/view?filename=x.png');
    } finally {
      await echo.close();
    }
  });

  it('base 带 path 时照旧保留（不是被剃成 origin）', async () => {
    const echo = await startEcho();
    try {
      const response = await buildHonoApp().request('/api/image/comfy/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Target-Base-URL': `${echo.base}/a/b` },
        body: '{}',
      });

      expect(response.headers.get('x-seen-url')).toBe('/a/b/prompt');
    } finally {
      await echo.close();
    }
  });

  it('base 尾部斜杠照旧剃掉（不产生 //）', async () => {
    const echo = await startEcho();
    try {
      const response = await buildHonoApp().request('/api/image/comfy/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Target-Base-URL': `${echo.base}/a/b//` },
        body: '{}',
      });

      expect(response.headers.get('x-seen-url')).toBe('/a/b/prompt');
    } finally {
      await echo.close();
    }
  });

  it('过得了 ^https?:// 但 URL 解析不了的 base → 400（此前一路走到 fetch 才 502）', async () => {
    const response = await buildHonoApp().request('/api/image/comfy/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Target-Base-URL': 'http://' },
      body: '{}',
    });

    expect(response.status).toBe(400);
  });
});

describe('BFF 路由前缀单一真源', () => {
  // 🔴 这一组钉的是「三处手工同步」那个坑：前缀清单此前在 server/app.ts 的 app.route()、
  // vite 的 configureServer、vite 的 configurePreviewServer 里各写一遍，漏改一处的症状
  // 不是报错而是「代码看着完全正确，请求 404」。现在只剩 BFF_ROUTE_TABLE 一处，
  // 下面三条分别钉：常量内容、常量与真实挂载一致、vite 不再自己抄一份。

  /** 真正挂在 app 上的路由（滤掉 app.use('*') 那两个全局中间件） */
  function mountedApiPaths(): string[] {
    return buildHonoApp()
      .routes.map((route) => route.path)
      .filter((path) => path.startsWith('/api/'));
  }

  it('常量内容被钉死 —— 加/删 BFF 路由时这条会红，提醒你顺带看一眼别处', () => {
    expect([...BFF_ROUTE_PREFIXES]).toEqual([
      '/api/chat',
      '/api/status',
      '/api/embeddings',
      '/api/models',
      '/api/image',
      '/api/worldbooks',
      '/api/defaults',
    ]);
  });

  it('每个前缀都真的挂了路由，且没有 /api 路由落在清单之外', () => {
    const paths = mountedApiPaths();
    expect(paths.length).toBeGreaterThan(0);

    for (const prefix of BFF_ROUTE_PREFIXES) {
      const mounted = paths.filter((path) => path === prefix || path.startsWith(`${prefix}/`));
      expect(mounted, `前缀 ${prefix} 在常量里，却没有任何路由挂在它下面`).not.toHaveLength(0);
    }

    for (const path of paths) {
      expect(isBffRoute(path), `路由 ${path} 挂在 app 上，却不被 isBffRoute 认领`).toBe(true);
    }
  });

  it('vite.config.ts 不再手抄前缀白名单，且 dev / preview 拿同一份 options', () => {
    const source = readFileSync(resolve(__dirname, '..', 'vite.config.ts'), 'utf8');

    // 判据用 `/api/` 后跟一个单词字符 —— 开头那道 `u.startsWith('/api/')` 的
    // 通用 opaque-origin 守卫是合法的，不该被这条误伤。
    expect(source.match(/startsWith\(['"]\/api\/\w/g)).toBeNull();
    expect(source).toContain('isBffRoute(');

    // dev 与 preview 两处都必须注入 contentDir，否则「preview 下写回 404」原地复活
    const injections = source.match(/buildHonoApp\(\s*\{\s*contentDir:\s*poemContentDir\s*\}/g);
    expect(injections).toHaveLength(2);
  });
});

describe('内容 overlay 写回路由（/api/worldbooks · /api/defaults）', () => {
  // 🔴 这两条端点此前只是 vite dev 中间件，preview 与生产必 404，而前端无条件 fetch。
  // 搬进 hono 之后 dev / preview 共用同一份实现，下面钉的是「搬家没搬坏」。

  let contentDir: string;

  beforeEach(() => {
    contentDir = mkdtempSync(join(tmpdir(), 'poem-content-'));
  });

  afterEach(() => {
    rmSync(contentDir, { recursive: true, force: true });
  });

  /** 配好 overlay 的 app */
  const configured = () => buildHonoApp({ contentDir });

  function putJson(app: ReturnType<typeof buildHonoApp>, path: string, body: string) {
    return app.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  }

  it('PUT /api/worldbooks/:id 写进 <overlay>/worldbooks/<id>.json，字节原样落盘', async () => {
    // 🔴 落盘的必须是**请求体本身**：前端送的是 2 空格缩进的 JSON，
    //    服务端若再 JSON.stringify 一遍，内容仓每次保存都会多出一整份无关 diff。
    const body = '{\n  "id": "core",\n  "name": "核心设定"\n}';
    const response = await putJson(configured(), '/api/worldbooks/core', body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(readFileSync(join(contentDir, 'worldbooks', 'core.json'), 'utf8')).toBe(body);
  });

  it('路径带不带 .json 都落到同一个文件（前端两处调用都不带）', async () => {
    const response = await putJson(configured(), '/api/worldbooks/core.json', '{"a":1}');

    expect(response.status).toBe(200);
    expect(readFileSync(join(contentDir, 'worldbooks', 'core.json'), 'utf8')).toBe('{"a":1}');
  });

  it('中文逐字节往返 —— chunk 边界切碎 UTF-8 会在这里现形（2026-08-08 真机）', async () => {
    // 「展示」曾被切成「展□□示」：每个 chunk 各自 toString() 在切分处产生 U+FFFD。
    // 🔴 替换字符只准算出来，**不写字面量** —— tests/ 归 encoding-invariants 那道闸门管，
    //    源码里躺一个真的 U+FFFD 会让它当场挂红（那正是它要抓的东西）。
    const replacementChar = String.fromCharCode(0xfffd);
    const body = JSON.stringify({ text: '展示、顿号与更长的一段中文内容'.repeat(400) });
    const response = await putJson(configured(), '/api/worldbooks/zh', body);

    expect(response.status).toBe(200);
    const written = readFileSync(join(contentDir, 'worldbooks', 'zh.json'), 'utf8');
    expect(written).toBe(body);
    expect(written).not.toContain(replacementChar);
  });

  it('目标子目录不存在时自动新建（对齐原中间件：允许新建文件）', async () => {
    expect(existsSync(join(contentDir, 'defaults'))).toBe(false);

    const response = await putJson(configured(), '/api/defaults/agent-config', '{"agents":{}}');

    expect(response.status).toBe(200);
    expect(readFileSync(join(contentDir, 'defaults', 'agent-config.json'), 'utf8')).toBe(
      '{"agents":{}}',
    );
  });

  it('/api/defaults 不带名字时落 agent-config.json（原中间件的兜底名）', async () => {
    for (const path of ['/api/defaults', '/api/defaults/']) {
      rmSync(join(contentDir, 'defaults'), { recursive: true, force: true });
      const response = await putJson(configured(), path, `{"from":"${path}"}`);

      expect(response.status, `${path} 应当落到兜底名`).toBe(200);
      expect(readFileSync(join(contentDir, 'defaults', 'agent-config.json'), 'utf8')).toBe(
        `{"from":"${path}"}`,
      );
    }
  });

  it('🔒 越界写被拒 400，且目标目录外一个字节都没动（P1-03）', async () => {
    const outside = join(contentDir, 'evil.json');
    mkdirSync(join(contentDir, 'worldbooks'), { recursive: true });
    writeFileSync(outside, 'original', 'utf8');

    const response = await putJson(configured(), '/api/worldbooks/%2e%2e%2fevil', 'pwned');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid path' });
    expect(readFileSync(outside, 'utf8')).toBe('original');
  });

  it('overlay 未配置 → 501 + 中文说明，且不落任何文件（占位内容碰不到）', async () => {
    for (const path of ['/api/worldbooks/core', '/api/defaults/agent-config']) {
      const response = await putJson(buildHonoApp(), path, '{"a":1}');

      expect(response.status, `${path} 未配置时应当 501`).toBe(501);
      expect(await response.json()).toEqual({ error: CONTENT_DIR_NOT_CONFIGURED });
    }
    expect(existsSync(join(contentDir, 'worldbooks'))).toBe(false);
    expect(existsSync(join(contentDir, 'defaults'))).toBe(false);
  });

  it('POST 与 PUT 同权（原中间件收两种方法）', async () => {
    const response = await configured().request('/api/worldbooks/core', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"via":"post"}',
    });

    expect(response.status).toBe(200);
    expect(readFileSync(join(contentDir, 'worldbooks', 'core.json'), 'utf8')).toBe(
      '{"via":"post"}',
    );
  });

  it('🔴 经 getRequestListener 走真 HTTP —— 大段中文跨 chunk 仍逐字节落盘', async () => {
    // 上面那些用例走的是 `app.request()`，**绕开了 node 适配层**；而 dev / preview
    // 真正跑的是 `getRequestListener(app.fetch)` + node 的 http server ——
    // 「chunk 边界切碎多字节中文」这个坑只在这条路径上存在。故这里起一台真服务器，
    // body 大到必然被 socket 拆成多个 chunk（约 200KB）。
    const listener = getRequestListener(buildHonoApp({ contentDir }).fetch);
    // listener 返回 Promise，而 http 的 handler 签名是 void —— 显式 `void` 掉
    // （vite 那两处走 `return honoListener(req, res)`，connect 的签名收得下）
    const server = createServer((request, response) => void listener(request, response));
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });

    try {
      const address = server.address() as AddressInfo;
      const body = JSON.stringify({ text: '展示、顿号与更长的一段中文内容'.repeat(8000) });
      expect(body.length).toBeGreaterThan(100_000);

      const response = await fetch(`http://127.0.0.1:${address.port}/api/worldbooks/big`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(readFileSync(join(contentDir, 'worldbooks', 'big.json'), 'utf8')).toBe(body);
    } finally {
      await new Promise<void>((done, reject) => {
        server.close((error) => (error ? reject(error) : done()));
      });
    }
  });
});
