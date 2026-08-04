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

export { app as imageRoutes };
