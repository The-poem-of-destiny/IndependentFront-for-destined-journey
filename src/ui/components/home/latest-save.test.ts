import { describe, expect, it } from 'vitest';
import type { SaveSlot } from '@engine/types';
import { findLatestSave } from './latest-save';

function makeSave(id: string, updatedAt: number): SaveSlot {
  return {
    id,
    name: id,
    slot: 0,
    createdAt: 1,
    updatedAt,
    activeSnapshotId: null,
    metadata: {
      characterName: id,
      userName: '测试玩家',
      gameStartTime: '复兴纪元',
      totalTurns: 0,
    },
  };
}

describe('findLatestSave', () => {
  it('无存档时返回 null', () => {
    expect(findLatestSave([])).toBeNull();
  });

  it('不依赖列表顺序，按 updatedAt 选择最新存档', () => {
    const older = makeSave('older', 100);
    const latest = makeSave('latest', 300);
    const middle = makeSave('middle', 200);

    expect(findLatestSave([older, latest, middle])).toBe(latest);
  });
});
