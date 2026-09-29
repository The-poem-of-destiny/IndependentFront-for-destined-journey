/**
 * prompt-session-store.ts — Delta 会话的 Dexie 持久化实现（问题 2，2026-09-26）
 *
 * 用途：给 `prompt-session-assembler` 的注入缝提供生产实现，使页面**刷新后**能续用
 *       上一轮的 wire transcript，省掉一次冷基线（缓存未命中）。设计真源：
 *       docs/planning/2026-08-22-llm-assembly-delta-architecture-scratch.md（§5.2 修订）。
 *
 * 关键约定：
 * - 本模块是 assembler 缝的**唯一**生产实现；由 `game-pipeline` 安装。引擎默认不装，
 *   于是所有不碰游戏的引擎单测保持纯内存行为、零 Dexie 依赖。
 * - 所有读写走 `withSaveWriteLock`（per-saveId FIFO）：既与 state-manager 的提交串行，
 *   也保证「save 后 delete」的时序 —— 回退发生在同一存档时不会出现「删除被在途 save 覆盖」。
 * - 落库前 `JSON` 往返切断 Vue Proxy（引擎侧不 import 前端 `db-write`，JSON 往返同口径）。
 * - 该表是 rebuildable 缓存：不进 FullBackup / 单存档导出；删存档由 `deleteSaveSlot`
 *   级联删（database.ts v26）。
 */

import { getDatabase } from '../persistence/database';
import { withSaveWriteLock } from '../state/state-write-queue';
import { promptSessionKey } from './prompt-session-assembler';
import type { PromptSessionStore } from './prompt-session-assembler';

/** 落库前切断响应式代理（与 UI 层 `db-write.detach` 同口径，但引擎侧不依赖前端模块）。 */
function detach<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 会话持久化的 Dexie 实现（生产安装用）。 */
export function createDexiePromptSessionStore(): PromptSessionStore {
  const db = () => getDatabase();
  return {
    load(saveId, agentId) {
      return withSaveWriteLock(saveId, async () => {
        const row = await db().promptSessions.get(promptSessionKey(saveId, agentId));
        return row ? detach(row) : null;
      });
    },
    save(record) {
      return withSaveWriteLock(record.saveId, async () => {
        await db().promptSessions.put(detach(record));
      });
    },
    delete(saveId, agentId) {
      return withSaveWriteLock(saveId, async () => {
        if (agentId === undefined) {
          await db().promptSessions.where('saveId').equals(saveId).delete();
        } else {
          await db().promptSessions.delete(promptSessionKey(saveId, agentId));
        }
      });
    },
  };
}
