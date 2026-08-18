import fs from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';

/**
 * 内容 overlay 写回路由 —— `PUT/POST /api/worldbooks/:id` 与 `PUT/POST /api/defaults/:name`。
 *
 * 🔴 这两条此前**只是 `vite.config.ts` 里的两段 dev 中间件**（D14），只注册在
 *    `configureServer` 分支里 —— 于是 `vite preview` 与任何非 dev 部署下它们必然 404，
 *    而前端是**无条件** fetch 的（WorldBookSection「保存为默认」/ settings-store
 *    的 agent-config 写回），只会 toast 一句「保存失败 (404)」。搬进 hono 之后
 *    dev 与 preview 共用同一份实现，行为一致。
 *
 * 🔴 overlay 目录未配置（`POEM_CONTENT_DIR` 没设）时回 **501 + 中文说明**，
 *    而不是让请求落到 SPA fallback 上拿回一个 200 的 index.html —— 那种「成功」
 *    正是 D14 当初否决 HTTP 探测的原因。前端判定 overlay 是否启用**照旧只看编译期的
 *    `__POEM_CONTENT_DIR__`**，本文件的 501 只是让误触时的提示说人话，不是新探测口。
 *
 * 🔒 越界写防御沿用原中间件的 canonical containment（P1-03）：仅拒 `'..'` 不够，
 *    Windows 绝对路径（`C:\evil`）经 `resolve` 会**吞掉**目标目录逃逸到任意位置。
 */

/** overlay 未配置时的应答文案（前端 toast 只显示状态码，这句给的是 devtools 里的真话） */
export const CONTENT_DIR_NOT_CONFIGURED =
  '内容目录未配置：未设置 POEM_CONTENT_DIR 环境变量，无法写回项目默认内容';

export interface ContentWriteOptions {
  /** overlay 根目录的绝对路径；`null` = 未配置 */
  contentDir: string | null;
  /** 写进 overlay 根目录下的哪个子目录（`worldbooks` / `defaults`） */
  subDir: string;
  /** 路径段为空时的兜底文件名；不给 = 空路径直接判非法 */
  fallbackName?: string;
}

/**
 * 造一条「把请求体原样写成 `<contentDir>/<subDir>/<name>.json`」的路由。
 *
 * 两个端点的差别只有 `subDir` 与「空路径怎么办」（`/api/defaults` 不带名字时
 * 落 `agent-config`，这是原中间件的行为），故共用同一份实现。
 */
export function createContentWriteRoutes(options: ContentWriteOptions): Hono {
  const app = new Hono();
  const handler = (c: Context) => writeContentFile(c, options);

  // 两条路由对应原中间件的两种 req.url：`/`（挂载点本身）与 `/<名字>`。
  // `:name{.*}` 的 `.*` 跨斜杠且允许为空 —— 带尾斜杠的 `/api/defaults/` 也要能落
  // agent-config（原中间件在这一格同样走兜底名）。
  app.on(['PUT', 'POST'], '/', handler);
  app.on(['PUT', 'POST'], '/:name{.*}', handler);

  return app;
}

async function writeContentFile(c: Context, options: ContentWriteOptions): Promise<Response> {
  const { contentDir, subDir, fallbackName } = options;
  if (contentDir === null) {
    return c.json({ error: CONTENT_DIR_NOT_CONFIGURED }, 501);
  }

  // `.json` 后缀可有可无（前端两处调用都不带，原中间件同样是剥了再拼回去）
  const raw = (c.req.param('name') ?? '').replace(/\.json$/, '');
  const name = raw || (fallbackName ?? '');
  if (!name) return c.json({ error: 'invalid path' }, 400);

  const targetDir = resolve(contentDir, subDir);
  const filePath = resolve(targetDir, `${name}.json`);
  // 🔒 P1-03 越界写防御：canonical containment（见文件头注释）
  const rel = relative(targetDir, filePath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return c.json({ error: 'invalid path' }, 400);
  }

  // 🔴 整个 body 读完再解码（2026-08-08 真机）：按 chunk 各自 `toString()` 会在
  //    多字节中文恰好被切成两半的地方产生 U+FFFD（"展示"曾被切成"展□□示"、顿号丢失）。
  //    `c.req.text()` 是「收完整个 body 再按 UTF-8 解一次」，天然没有切分问题。
  //    落盘的是**原样文本**：前端送来的是 2 空格缩进的 JSON，这里若再 JSON.stringify
  //    一遍，内容仓每次保存都会多出一整份无关 diff。
  const body = await c.req.text();
  try {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(filePath, body, 'utf-8');
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
  return c.json({ ok: true });
}
