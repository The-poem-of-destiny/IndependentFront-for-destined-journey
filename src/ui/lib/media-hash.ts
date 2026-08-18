/**
 * media-hash.ts — 前端侧的**转发壳**，实现已迁到 `@engine/media-hash`。
 *
 * 为什么搬家: `content-source.ts`（引擎，pack 分节 hash）与素材/音频三条前端写入路径
 * 都要算同一份 SHA-256，而实现住在 `src/ui/lib/` 时，引擎只能反向 import 前端 ——
 * 那正是分层闸门（`tests/layering-gate.test.ts` + eslint `no-restricted-imports`）
 * 要消灭的六条反向边之一。哈希是纯计算、零 DOM 依赖（`crypto.subtle` 惰性取），
 * 天然属于引擎侧。
 *
 * 🔴 **本文件不许长出第二份实现**（原文件头那条「全项目唯一一份实现」照旧生效，
 *    只是那份实现现在住在引擎）。它存在的唯一理由是让既有前端消费方
 *    （asset-zip / asset-store / audio-store / scene-image-seams）的 import 路径不变。
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md §4.4 / D12 / D18
 */

export { isMediaHashAvailable, hashMediaBytes, hashMediaBlob } from '@engine/media-hash';
