/**
 * 战斗沙盒持久化（Phase 2 战斗重写）—— Dexie `combatSandboxes`（v27）
 *
 * 每存档至多一场在办战斗，主键 `saveId`；存权威 `CombatState` + 会话 transcript，
 * 供页面刷新后续战。
 *
 * 🔴 rebuildable 缓存：不进 FullBackup / 单存档导出，删存档由 `deleteSaveSlot` 级联删。
 * 🔴 读写走 `withSaveWriteLock`（与提交串行 + save/delete 时序），落库前 JSON 往返切断
 *    响应式代理 —— 承 `prompt-session-store.ts` 先例。
 */

import { getDatabase } from '../../persistence/database';
import { isProtectedContentInstalled, getPackRuntimeRevision } from '../../content/pack-runtime';
import { withSaveWriteLock } from '../../state/state-write-queue';
import type { CombatSandboxRecord } from './types';

/** 落库前切断响应式代理（引擎侧不依赖前端 db-write，JSON 往返同口径） */
function detach<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 读取某存档的在办战斗（无则 undefined） */
export async function getCombatSandbox(saveId: string): Promise<CombatSandboxRecord | undefined> {
  if (isProtectedContentInstalled()) return undefined;
  const revision = getPackRuntimeRevision();
  return withSaveWriteLock(saveId, async () => {
    if (isProtectedContentInstalled() || revision !== getPackRuntimeRevision()) return undefined;
    const row = await getDatabase().combatSandboxes.get(saveId);
    if (isProtectedContentInstalled() || revision !== getPackRuntimeRevision()) return undefined;
    return row ? detach(row) : undefined;
  });
}

/** 写入/覆盖某存档的在办战斗 */
export async function saveCombatSandbox(record: CombatSandboxRecord): Promise<void> {
  if (isProtectedContentInstalled()) return;
  const revision = getPackRuntimeRevision();
  await withSaveWriteLock(record.saveId, async () => {
    if (isProtectedContentInstalled() || revision !== getPackRuntimeRevision()) return;
    await getDatabase().combatSandboxes.put(detach(record));
  });
}

/** 删除某存档的在办战斗（终局收尾 / 手动放弃） */
export async function deleteCombatSandbox(saveId: string): Promise<void> {
  await withSaveWriteLock(saveId, async () => {
    await getDatabase().combatSandboxes.delete(saveId);
  });
}
