/**
 * MEM 编号跨存档唯一性回归测试（真库，fake-indexeddb 由 src/test-setup.ts 注入）。
 *
 * 修的是一个**静默丢数据**的 bug：`memories` 的 `id` 是**全局主键**（`saveId` 只是索引），
 * 而 `generateMemoryId()` 当初只扫「本存档」的 MEM 编号 —— 于是两个存档会各自铸出
 * `MEM000001`，后写的那条 `saveMemory()`（Dexie `put`）把先写的那条**覆盖掉**：
 * 不报错、行数不涨、另一个周目的记忆内容悄悄变成了这个周目的。
 *
 * 🔴 单测 `memory-summarizer.test.ts` 里那些用例全部 mock 掉了数据库，**证明不了**
 *    真库上不会撞主键 —— 这个文件走真表，断言的是「两条都还在」。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { MemoryRecord } from './types';
import {
  getDatabase,
  initializeDatabase,
  clearAllData,
  getMemories,
  getAllMemoryIds,
  saveMemory,
} from './database';
import { generateMemoryId } from './memory-summarizer';

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'MEM000001',
    saveId: 'save_a',
    createdAt: Date.now(),
    realTimestamp: Date.now(),
    timeRange: { start: '001-01-01', end: '001-01-02' },
    content: '这是一条测试记忆，内容足够长以满足最低字数要求。'.repeat(4),
    hiddenLine: '暗线内容：测试暗线数据',
    keywords: ['测试', '记忆'],
    relatedCharacterIds: [],
    importance: 5,
    ...overrides,
  };
}

beforeEach(async () => {
  try {
    await clearAllData();
  } catch {
    /* 首次运行时库还不存在 */
  }
  await initializeDatabase();
});

describe('generateMemoryId — 跨存档编号唯一性', () => {
  it('存档 B 生成的编号不得与存档 A 已有的任何编号相同', async () => {
    await saveMemory(makeMemory({ saveId: 'save_a', id: 'MEM000001' }));
    await saveMemory(makeMemory({ saveId: 'save_a', id: 'MEM000002' }));

    const idForB = await generateMemoryId();

    expect(idForB).toBe('MEM000003');
    expect(await getAllMemoryIds()).not.toContain(idForB);
  });

  it('两个存档各写一条后，两条都还在（撞号会静默覆盖，行数不涨）', async () => {
    await saveMemory(makeMemory({ saveId: 'save_a', content: '存档 A 的记忆'.repeat(20) }));

    const idForB = await generateMemoryId();
    await saveMemory(
      makeMemory({ saveId: 'save_b', id: idForB, content: '存档 B 的记忆'.repeat(20) }),
    );

    expect(await getDatabase().memories.count()).toBe(2);

    const a = await getMemories('save_a');
    const b = await getMemories('save_b');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].content).toContain('存档 A');
    expect(b[0].content).toContain('存档 B');
  });

  it('连续发号在跨存档写入下不重复（3 个存档各取一号）', async () => {
    const ids: string[] = [];
    for (const saveId of ['save_a', 'save_b', 'save_c']) {
      const id = await generateMemoryId();
      ids.push(id);
      await saveMemory(makeMemory({ saveId, id }));
    }

    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(['MEM000001', 'MEM000002', 'MEM000003']);
    expect(await getDatabase().memories.count()).toBe(3);
  });

  it('空库时从 MEM000001 起（编号语义未变）', async () => {
    expect(await getAllMemoryIds()).toEqual([]);
    expect(await generateMemoryId()).toBe('MEM000001');
  });
});
