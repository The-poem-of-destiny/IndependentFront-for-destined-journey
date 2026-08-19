import type { SaveSlot } from '@engine/types';

/**
 * 按存档更新时间选出继续游戏的目标。
 *
 * 不依赖调用方的数组顺序：数据库当前会按 updatedAt 倒序返回，但首页按钮的行为不应
 * 因列表展示顺序调整而改变。旧数据若缺少时间戳，按 0 处理并让任何有效时间戳优先。
 */
export function findLatestSave(saves: readonly SaveSlot[]): SaveSlot | null {
  let latest: SaveSlot | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const save of saves) {
    const timestamp = Number.isFinite(save.updatedAt) ? save.updatedAt : 0;
    if (!latest || timestamp > latestTimestamp) {
      latest = save;
      latestTimestamp = timestamp;
    }
  }

  return latest;
}
