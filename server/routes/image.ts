import { Hono } from 'hono';
import { forward } from './proxy';

const app = new Hono();

/**
 * POST /api/image/generate — 文生图透传（v1 = NovelAI）。
 * 上游：`${X-Target-Base-URL}/ai/generate-image`（前端传 `https://image.novelai.net`）
 *
 * 🔴 **复用 `forward()`，一行都不许自己写**（设计 §12.1 第 2 条）。
 * `forward()` 已经是 `new Response(upstream.body, …)` 的管道直通，并且在
 * `STRIP_RESP_HEADERS` 里剥掉了 `content-encoding` —— zip 字节原样过。
 *
 * 🔴 **绝不要**在这条路径上写 `await res.json()` / `await res.text()`：
 * NAI 的成功响应是 `application/x-zip-compressed` 的二进制 zip，
 * 任何一次「按文本读」都会在非法 UTF-8 字节处产生替换字符（U+FFFD），
 * 把 zip 悄悄读坏 —— 不报错，只是解不开。二进制的读法归前端
 * （`image-client.ts` 用 `arrayBuffer()`），本层只做管道。
 *
 * `Accept: application/x-zip-compressed` 由前端设置，`forward()` 已透传；
 * SSRF 黑名单与 `Authorization` 透传沿用 `forward()` 的既有行为，本文件不动它们。
 */
app.post('/generate', (c) => forward(c, '/ai/generate-image'));

/**
 * ── ComfyUI 三条透传（图像 v2 / C10）──────────────────────────────
 *
 * 上游：`${X-Target-Base-URL}/prompt` `/history/{id}` `/view?…`
 * （前端传 `http://127.0.0.1:8188`；`forward()` 的 SSRF 名单本来就放行 localhost，
 *  见 `proxy.ts` 里那段注释 —— 本地 LLM 需要它，本地 ComfyUI 同理。）
 *
 * 🔴 **同样是 `forward()` 一行，不自己写**（与上面那条同一条纪律）。`/view` 回的是
 * PNG 字节，任何一次 `res.json()` / `res.text()` 都会把它按文本读坏；`forward()` 是
 * `new Response(upstream.body, …)` 的管道直通，字节原样过。
 *
 * 🔴 **`forward(c, suffix)` 不读请求的查询串** —— 它拼的上游 URL 就是
 * `X-Target-Base-URL + suffix` 那么直白。所以 GET 路由必须**自己**把 query 拼进 suffix，
 * 否则 `/view` 会打成没有 `filename` 的裸路径，ComfyUI 回 400、而报错里一个字都不会提到
 * 「参数丢了」。`:id` 同理，得自己插值（并转义）。
 */
app.post('/comfy/prompt', (c) => forward(c, '/prompt'));

app.get('/comfy/history/:id', (c) =>
  forward(c, `/history/${encodeURIComponent(c.req.param('id'))}`),
);

app.get('/comfy/view', (c) => forward(c, `/view${new URL(c.req.url).search}`));

/**
 * ── 取消善后的两条（2026-08-08 审查补）──────────────────────────
 *
 * 前端 abort 掉的只是自己的轮询，ComfyUI 那头照跑不误 —— 显卡照占、图照落进输出目录，
 * 而用户随手按的「重试」会排在那张被遗弃的图后面。所以取消时要够得着这两条上游接口:
 *
 * - `POST /queue`   —— 带 `{"delete":["<prompt_id>"]}` **点名删**掉还在排队的那一项
 * - `GET  /queue`   —— 看**正在跑的**是不是我们这张（`/interrupt` 不收 prompt_id，
 *                      盲发会掐掉用户自己在界面里跑的另一张图）
 * - `POST /interrupt` —— 掐掉当前正在跑的那个
 *
 * 🔴 与上面几条同一条纪律: `forward()` 一行，本层不读体、不判、不改。
 */
app.on(['GET', 'POST'], '/comfy/queue', (c) => forward(c, '/queue'));

app.post('/comfy/interrupt', (c) => forward(c, '/interrupt'));

export { app as imageRoutes };
