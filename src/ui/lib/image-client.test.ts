/**
 * image-client.test.ts — 唯一网络接触点的行为固定（图像生成 v1 / 阶段 E）
 *
 * ⚠️ 本文件**绝不发真实网络请求**。`globalThis.fetch` 在 beforeEach 里被替换成
 * 一个会抛的哨兵：任何一条忘了注入 mock 的路径都会当场炸出「真实网络」而不是
 * 静悄悄地去连 NovelAI（那是要花 Anlas 的）。
 *
 * 🔴 本文件最要紧的一组断言是「二进制不被当文本读」：
 * 成功路径必须只调 `arrayBuffer()`、**一次都不调 `text()`**，且字节逐字节还原。
 * 反向证据也钉在这里 —— 同一份 zip 经 UTF-8 往返会被改坏，那正是 §12.1 第 2 条
 * 禁止 `await res.json()` 的原因。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import type { NaiRequestBody } from '@engine/image-providers/novelai';
import {
  IMAGE_BFF_ENDPOINT,
  NAI_IMAGE_API_BASE,
  NAI_ZIP_ACCEPT,
  classifyImageHttpStatus,
  generateNaiImage,
  resetImageClient,
  resolveImageBaseUrl,
  setImageFetch,
  summarizeUpstreamDetail,
  type ImageFetchInit,
  type ImageFetchLike,
  type ImageResponseLike,
} from './image-client';

// ═══════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════

const ZIP_CONTENT_TYPE = 'application/x-zip-compressed';

/** 十六进制串 → 字节（空白随意，方便按语义分组） */
function hexBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * 一张「PNG」—— 魔数真，内容是**故意挑的非法 UTF-8 字节序列**。
 *
 * 0x89 / 0xFF 0xFE / 0x80 单独出现都不是合法 UTF-8 起始/续接字节，
 * 一旦有人在链路上按文本读一次，它们会被替换成 U+FFFD 且**不报任何错**。
 * 用它当载荷，「读坏了」才会在断言里现形而不是蒙混过去。
 */
function evilPng(): Uint8Array {
  // 前 8 字节是 PNG 签名（`parseNaiZip` 认它），其余全是非法 UTF-8 字节
  return hexBytes('89504e470d0a1a0a fffe8081c0c1f5ff 000102eda080efbf');
}

function naiZip(entries: Record<string, Uint8Array> = { 'image_0.png': evilPng() }): Uint8Array {
  return zipSync(entries);
}

function requestBody(): NaiRequestBody {
  return {
    model: 'nai-diffusion-4-5-full',
    action: 'generate',
    input: 'tavern interior, 1girl',
    parameters: {} as NaiRequestBody['parameters'],
  };
}

interface FakeResponseOpts {
  ok?: boolean;
  status?: number;
  statusText?: string;
  contentType?: string;
  bytes?: Uint8Array;
  text?: string;
  /** 让 arrayBuffer() 炸 */
  arrayBufferThrows?: boolean;
  /** 让 text() 炸 */
  textThrows?: boolean;
}

/** 造一个假响应，并把 arrayBuffer / text 都换成可断言的 spy */
function fakeResponse(opts: FakeResponseOpts = {}) {
  const status = opts.status ?? 200;
  const contentType = opts.contentType ?? ZIP_CONTENT_TYPE;
  const bytes = opts.bytes ?? naiZip();
  const arrayBuffer = vi.fn(async () => {
    if (opts.arrayBufferThrows) throw new Error('body stream failed');
    return bytes.slice().buffer as ArrayBuffer;
  });
  const text = vi.fn(async () => {
    if (opts.textThrows) throw new Error('body already consumed');
    return opts.text ?? '';
  });
  const res: ImageResponseLike = {
    ok: opts.ok ?? status < 400,
    status,
    statusText: opts.statusText ?? '',
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer,
    text,
  };
  return { res, arrayBuffer, text };
}

/** 记录调用参数的 fetch mock */
function stubFetch(res: ImageResponseLike) {
  const calls: Array<{ url: string; init?: ImageFetchInit }> = [];
  const impl: ImageFetchLike = async (url, init) => {
    calls.push({ url, init });
    return res;
  };
  setImageFetch(impl);
  return calls;
}

beforeEach(() => {
  resetImageClient();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('测试里不允许发真实网络请求');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetImageClient();
});

// ═══════════════════════════════════════════════════════════
// 🔴 二进制不被当文本读
// ═══════════════════════════════════════════════════════════

describe('二进制读法（§12.1 第 2 条）', () => {
  it('成功路径只调 arrayBuffer()，一次都不调 text()', async () => {
    const { res, arrayBuffer, text } = fakeResponse();
    stubFetch(res);

    const result = await generateNaiImage({ token: 'tk', body: requestBody() });

    expect(result.ok).toBe(true);
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
  });

  it('zip 字节逐字节原样过，含非法 UTF-8 序列也不失真', async () => {
    const png = evilPng();
    const { res } = fakeResponse({ bytes: naiZip({ 'image_0.png': png }) });
    stubFetch(res);

    const result = await generateNaiImage({ token: 'tk', body: requestBody() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(1);
    expect(Array.from(result.images[0])).toEqual(Array.from(png));
    expect(result.contentType).toBe(ZIP_CONTENT_TYPE);
  });

  it('反证：同一份 zip 经 UTF-8 往返会被改坏 —— 所以那条路必须堵死', () => {
    const zip = naiZip();
    const roundTripped = new TextEncoder().encode(new TextDecoder().decode(zip));
    // 不是「长度可能不同」而已 —— 内容真的变了，且**不会报任何错**
    expect(Array.from(roundTripped)).not.toEqual(Array.from(zip));
  });

  it('响应对象没有 arrayBuffer（类型层已堵，运行时兜底）→ bad-response', async () => {
    setImageFetch(async () => ({ ok: true, status: 200 }) as unknown as ImageResponseLike);
    const result = await generateNaiImage({ token: 'tk', body: requestBody() });
    expect(result).toMatchObject({ ok: false, kind: 'bad-response' });
  });

  it('arrayBuffer() 自己炸了 → bad-response，且不改用 text() 兜底', async () => {
    const { res, text } = fakeResponse({ arrayBufferThrows: true });
    stubFetch(res);

    const result = await generateNaiImage({ token: 'tk', body: requestBody() });

    expect(result).toMatchObject({ ok: false, kind: 'bad-response', retryable: true });
    expect(text).not.toHaveBeenCalled();
  });

  it('空响应体 → bad-response', async () => {
    const { res } = fakeResponse({ bytes: new Uint8Array(0) });
    stubFetch(res);
    const result = await generateNaiImage({ token: 'tk', body: requestBody() });
    expect(result).toMatchObject({ ok: false, kind: 'bad-response' });
  });
});

// ═══════════════════════════════════════════════════════════
// 请求形状
// ═══════════════════════════════════════════════════════════

describe('请求形状', () => {
  it('POST 到同源 BFF，四个 header 齐全，body 是序列化后的请求体', async () => {
    const { res } = fakeResponse();
    const calls = stubFetch(res);
    const body = requestBody();

    await generateNaiImage({ token: '  tk-123  ', body });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(IMAGE_BFF_ENDPOINT);
    expect(calls[0].init?.method).toBe('POST');
    const headers = calls[0].init?.headers ?? {};
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Accept).toBe(NAI_ZIP_ACCEPT);
    // token 两端空白被剃掉，且带 Bearer 前缀
    expect(headers.Authorization).toBe('Bearer tk-123');
    expect(headers['X-Target-Base-URL']).toBe(NAI_IMAGE_API_BASE);
    expect(JSON.parse(calls[0].init?.body ?? '{}')).toEqual(body);
  });

  it('自定义端点被采用，尾斜杠剃掉', async () => {
    const { res } = fakeResponse();
    const calls = stubFetch(res);

    await generateNaiImage({
      token: 'tk',
      body: requestBody(),
      baseUrl: '  https://mirror.example.com//  ',
    });

    expect(calls[0].init?.headers?.['X-Target-Base-URL']).toBe('https://mirror.example.com');
  });

  it('空 baseUrl 回落到 NAI 官方端点', async () => {
    const { res } = fakeResponse();
    const calls = stubFetch(res);
    await generateNaiImage({ token: 'tk', body: requestBody(), baseUrl: '   ' });
    expect(calls[0].init?.headers?.['X-Target-Base-URL']).toBe(NAI_IMAGE_API_BASE);
  });

  it('没有令牌 → auth，且一次请求都不发', async () => {
    const { res } = fakeResponse();
    const calls = stubFetch(res);

    const result = await generateNaiImage({ token: '   ', body: requestBody() });

    expect(result).toMatchObject({
      ok: false,
      kind: 'auth',
      retryable: false,
      message: 'NovelAI 令牌无效或已过期，去设置里重填',
    });
    expect(calls).toHaveLength(0);
  });

  it('环境里没有 fetch → network，不抛', async () => {
    resetImageClient();
    vi.stubGlobal('fetch', undefined);
    const result = await generateNaiImage({ token: 'tk', body: requestBody() });
    expect(result).toMatchObject({ ok: false, kind: 'network' });
  });
});

// ═══════════════════════════════════════════════════════════
// 端点地址归一化（2026-08-05 真机连坑两次）
//
// 这一组守的是同一件事: 这一格填错时，**报错必须指着这一格**。
// 两次真机失败分别被上游报成「模型枚举非法」与「header 非法」，
// 都要人从一句无关的话倒推回一个没被提及的输入框。
// ═══════════════════════════════════════════════════════════

describe('resolveImageBaseUrl', () => {
  it('空 / 全空白 → 官方出图端点', () => {
    expect(resolveImageBaseUrl(undefined)).toEqual({ ok: true, base: NAI_IMAGE_API_BASE });
    expect(resolveImageBaseUrl('   ')).toEqual({ ok: true, base: NAI_IMAGE_API_BASE });
  });

  it('漏掉协议 → 补 https（不改变打给谁）', () => {
    expect(resolveImageBaseUrl('image.novelai.net')).toEqual({
      ok: true,
      base: 'https://image.novelai.net',
    });
    expect(resolveImageBaseUrl('  mirror.example.com/nai/  ')).toEqual({
      ok: true,
      base: 'https://mirror.example.com/nai',
    });
  });

  it('已有协议就不动它（http 也放行 —— 本地代理要用）', () => {
    expect(resolveImageBaseUrl('http://127.0.0.1:8080')).toEqual({
      ok: true,
      base: 'http://127.0.0.1:8080',
    });
  });

  it('整条完整 URL 粘进来 → 剃掉 BFF 会自己补的那段路径', () => {
    expect(resolveImageBaseUrl('https://image.novelai.net/ai/generate-image')).toEqual({
      ok: true,
      base: 'https://image.novelai.net',
    });
  });

  it('填成文本/账户域 → 本地早退，且**不静默改写**', () => {
    const out = resolveImageBaseUrl('https://api.novelai.net');
    expect(out.ok).toBe(false);
    // 报错必须点名两个域，否则用户还是不知道该往哪改
    if (!out.ok) {
      expect(out.message).toContain('image.novelai.net');
      expect(out.message).toContain('api.novelai.net');
    }
  });

  it('协议不是 http/https → 早退', () => {
    expect(resolveImageBaseUrl('ftp://example.com').ok).toBe(false);
    // `javascript:` 之类连 `//` 都没有，会先被补成 https —— 那是可接受的归一化结果
    expect(resolveImageBaseUrl('ws://example.com').ok).toBe(false);
  });

  it('解析不出来的串 → 早退而不是抛', () => {
    expect(resolveImageBaseUrl('https://').ok).toBe(false);
  });
});

describe('端点地址填错 → 一次上游请求都不发', () => {
  it('文本/账户域 → bad-request、不可重试、零请求', async () => {
    const { res } = fakeResponse();
    const calls = stubFetch(res);

    const result = await generateNaiImage({
      token: 'tk',
      body: requestBody(),
      baseUrl: 'https://api.novelai.net',
    });

    expect(result).toMatchObject({ ok: false, kind: 'bad-request', retryable: false });
    // 同一份配置再发一百次也是同样的结果 —— 不该白烧一次往返
    expect(calls).toHaveLength(0);
  });

  it('漏协议的地址被补好后照常发出去', async () => {
    const { res } = fakeResponse();
    const calls = stubFetch(res);

    await generateNaiImage({
      token: 'tk',
      body: requestBody(),
      baseUrl: 'image.novelai.net',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].init?.headers?.['X-Target-Base-URL']).toBe(NAI_IMAGE_API_BASE);
  });
});

// ═══════════════════════════════════════════════════════════
// §12.2 错误分类表 —— 逐格
// ═══════════════════════════════════════════════════════════

describe('§12.2 错误分类', () => {
  const cases: Array<{
    status: number;
    kind: string;
    message: string;
    retryable: boolean;
  }> = [
    {
      status: 401,
      kind: 'auth',
      message: 'NovelAI 令牌无效或已过期，去设置里重填',
      retryable: false,
    },
    {
      status: 402,
      kind: 'payment',
      message: 'Anlas 不足，或这次的尺寸/步数超出了免费额度',
      retryable: false,
    },
    { status: 429, kind: 'rate-limit', message: 'NovelAI 限流了，过一会儿再试', retryable: true },
    { status: 500, kind: 'upstream', message: 'NovelAI 服务端出错了', retryable: true },
    { status: 502, kind: 'upstream', message: 'NovelAI 服务端出错了', retryable: true },
    { status: 503, kind: 'upstream', message: 'NovelAI 服务端出错了', retryable: true },
  ];

  for (const c of cases) {
    it(`${c.status} → ${c.kind}（文案与可重试位照表）`, async () => {
      const { res } = fakeResponse({ status: c.status, ok: false, text: '{"message":"nope"}' });
      stubFetch(res);

      const result = await generateNaiImage({ token: 'tk', body: requestBody() });

      expect(result).toMatchObject({
        ok: false,
        kind: c.kind,
        message: c.message,
        retryable: c.retryable,
      });
    });
  }

  it('400 → bad-request，文案带上游摘要', async () => {
    const { res } = fakeResponse({
      status: 400,
      ok: false,
      text: '{"message":"steps must be <= 50"}',
    });
    stubFetch(res);

    const result = await generateNaiImage({ token: 'tk', body: requestBody() });

    expect(result).toMatchObject({ ok: false, kind: 'bad-request', retryable: false });
    if (result.ok) return;
    expect(result.message).toBe('请求被拒绝：steps must be <= 50');
  });

  it('表里没列的 4xx（403/404）不乐观归类，落到不可重试的 bad-request', async () => {
    for (const status of [403, 404, 418]) {
      const { res } = fakeResponse({ status, ok: false, text: 'blocked' });
      stubFetch(res);
      const result = await generateNaiImage({ token: 'tk', body: requestBody() });
      expect(result).toMatchObject({ ok: false, kind: 'bad-request', retryable: false });
    }
  });

  it('错误体读不出来时，失败本身不变成另一种失败', async () => {
    const { res } = fakeResponse({ status: 500, ok: false, textThrows: true });
    stubFetch(res);
    const result = await generateNaiImage({ token: 'tk', body: requestBody() });
    expect(result).toMatchObject({ ok: false, kind: 'upstream', message: 'NovelAI 服务端出错了' });
  });

  it('detail 只带上游原文与状态码，UI 文案里除 400 外一律不含它', async () => {
    const { res } = fakeResponse({ status: 401, ok: false, text: 'token expired at 2026-01-01' });
    stubFetch(res);
    const result = await generateNaiImage({ token: 'tk', body: requestBody() });
    if (result.ok) return;
    expect(result.detail).toContain('token expired');
    expect(result.message).not.toContain('token expired');
  });

  it('fetch 自己炸了 → network', async () => {
    setImageFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await generateNaiImage({ token: 'tk', body: requestBody() });
    expect(result).toMatchObject({
      ok: false,
      kind: 'network',
      message: '连不上 NovelAI，检查网络或代理',
      retryable: true,
    });
  });

  it('🔴 content-type 说是 JSON 但字节是 zip → 成功（判定来自 parseNaiZip：字节是权威）', async () => {
    // 2026-08-04 真机：NAI 成功响应报的是 `binary/octet-stream`。此前这里判死 content-type，
    // 于是一张已扣点数的图被自己扔掉。header 会变、zip 本地文件头不会 —— 信后者。
    const { res } = fakeResponse({ contentType: 'application/json' });
    stubFetch(res);
    const result = await generateNaiImage({ token: 'tk', body: requestBody() });
    expect(result.ok).toBe(true);
  });

  it('真机实测的 binary/octet-stream 也照样解出图', async () => {
    const { res } = fakeResponse({ contentType: 'binary/octet-stream' });
    stubFetch(res);
    const result = await generateNaiImage({ token: 'tk', body: requestBody() });
    expect(result.ok).toBe(true);
  });

  it('字节根本不是 zip → bad-response（这条防线没被削弱）', async () => {
    const { res } = fakeResponse({
      contentType: 'application/json',
      bytes: strToU8('{"statusCode":400,"message":"nope"}'),
    });
    stubFetch(res);
    const result = await generateNaiImage({ token: 'tk', body: requestBody() });
    expect(result).toMatchObject({
      ok: false,
      kind: 'bad-response',
      message: 'NovelAI 返回了看不懂的内容',
    });
  });

  it('zip 里没有图 → bad-response', async () => {
    const { res } = fakeResponse({ bytes: naiZip({ 'readme.txt': strToU8('nope') }) });
    stubFetch(res);
    const result = await generateNaiImage({ token: 'tk', body: requestBody() });
    expect(result).toMatchObject({ ok: false, kind: 'bad-response' });
  });
});

// ═══════════════════════════════════════════════════════════
// 超时与取消
// ═══════════════════════════════════════════════════════════

/** 一个永远挂着、只在收到 abort 时才 reject 的 fetch —— 模拟上游不响应 */
function hangingFetch(): ImageFetchLike {
  return (_url, init) =>
    new Promise<ImageResponseLike>((_resolve, reject) => {
      const onAbort = (): void =>
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (init?.signal?.aborted) onAbort();
      else init?.signal?.addEventListener('abort', onAbort);
    });
}

describe('超时与取消', () => {
  it('超时 → network（表里网络/超时同一格），detail 说明是超时', async () => {
    setImageFetch(hangingFetch());

    const result = await generateNaiImage({
      token: 'tk',
      body: requestBody(),
      timeoutMs: 5,
    });

    expect(result).toMatchObject({
      ok: false,
      kind: 'network',
      message: '连不上 NovelAI，检查网络或代理',
      retryable: true,
    });
    if (result.ok) return;
    expect(result.detail).toContain('超过');
  });

  it('调用方已取消 → aborted，且一次请求都不发', async () => {
    const { res } = fakeResponse();
    const calls = stubFetch(res);
    const ctrl = new AbortController();
    ctrl.abort();

    const result = await generateNaiImage({
      token: 'tk',
      body: requestBody(),
      signal: ctrl.signal,
    });

    expect(result).toMatchObject({
      ok: false,
      kind: 'aborted',
      message: '已取消',
      retryable: true,
    });
    expect(calls).toHaveLength(0);
  });

  it('飞行中取消 → aborted 而不是 network', async () => {
    setImageFetch(hangingFetch());
    const ctrl = new AbortController();

    const pending = generateNaiImage({
      token: 'tk',
      body: requestBody(),
      signal: ctrl.signal,
      timeoutMs: 10_000,
    });
    ctrl.abort();

    expect(await pending).toMatchObject({ ok: false, kind: 'aborted', message: '已取消' });
  });

  it('外部信号被透传给 fetch，调用方能自己掐断', async () => {
    const { res } = fakeResponse();
    const calls = stubFetch(res);
    const ctrl = new AbortController();

    await generateNaiImage({ token: 'tk', body: requestBody(), signal: ctrl.signal });

    expect(calls[0].init?.signal).toBeDefined();
    expect(calls[0].init?.signal?.aborted).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 纯函数
// ═══════════════════════════════════════════════════════════

describe('summarizeUpstreamDetail', () => {
  it('从 {message} / {error} / {detail} 里挑出那句话', () => {
    expect(summarizeUpstreamDetail('{"message":"bad steps"}')).toBe('bad steps');
    expect(summarizeUpstreamDetail('{"error":"missing header"}')).toBe('missing header');
    expect(summarizeUpstreamDetail('{"detail":"nope"}')).toBe('nope');
  });

  it('不是 JSON 就用原文，不编内容', () => {
    expect(summarizeUpstreamDetail('<html>502 Bad Gateway</html>')).toBe(
      '<html>502 Bad Gateway</html>',
    );
  });

  it('空白与空串返回 undefined', () => {
    expect(summarizeUpstreamDetail('')).toBeUndefined();
    expect(summarizeUpstreamDetail('   \n\t ')).toBeUndefined();
    expect(summarizeUpstreamDetail(undefined)).toBeUndefined();
  });

  it('折叠换行，超长截断（UI 里那句话不该是一整页栈信息）', () => {
    const long = 'x'.repeat(500);
    const out = summarizeUpstreamDetail(`{"message":"${long}"}`) ?? '';
    expect(out.length).toBeLessThan(200);
    expect(out.endsWith('…')).toBe(true);
    expect(summarizeUpstreamDetail('a\n\nb\tc')).toBe('a b c');
  });
});

describe('classifyImageHttpStatus', () => {
  it('状态码分类与 generateNaiImage 走同一张表', () => {
    expect(classifyImageHttpStatus(401).kind).toBe('auth');
    expect(classifyImageHttpStatus(402).kind).toBe('payment');
    expect(classifyImageHttpStatus(429).kind).toBe('rate-limit');
    expect(classifyImageHttpStatus(400).kind).toBe('bad-request');
    expect(classifyImageHttpStatus(500).kind).toBe('upstream');
    expect(classifyImageHttpStatus(504).kind).toBe('upstream');
  });

  it('没有 detail 时 400 的文案不带那个冒号', () => {
    expect(classifyImageHttpStatus(400).message).toBe('请求被拒绝');
  });

  it('每一格都带 ok:false，判别联合的判别位不能漏', () => {
    for (const status of [400, 401, 402, 429, 500]) {
      expect(classifyImageHttpStatus(status).ok).toBe(false);
    }
  });
});
