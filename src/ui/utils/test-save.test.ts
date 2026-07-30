/**
 * test-save.ts 的数据库准备逻辑 (`ensureDb`) 回归测试。
 *
 * 这里只关心两件事，也正是两个 bug 的所在:
 * 1. **清完必须补种** —— `clearAllData()` 是 `db.delete()`，会把 `initializeDatabase()`
 *    播下的默认预设/设置一起删掉。曾经的写法在"先点保留、再点清空"这一种点击顺序下
 *    会跳过补种，留下一个"清空了但没初始化"的库。
 * 2. **清失败不能记成清过了** —— `clearedThisLoad` 曾经在 `await clearAllData()`
 *    **之前**置位且错误被吞掉，于是一次失败的清空会永久堵死本次加载内的重试，
 *    按钮却仍宣称「清空重建」。
 *
 * 手法: 每个用例用 `vi.resetModules()` 重新 import，模拟一次全新的**页面加载**
 * （`initialized` / `clearedThisLoad` 都是模块级变量）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  clearThrows: false,
}));

vi.mock('@engine/database', () => ({
  initializeDatabase: vi.fn(async () => {
    h.calls.push('init');
  }),
  clearAllData: vi.fn(async () => {
    h.calls.push('clear');
    if (h.clearThrows) throw new Error('DatabaseBlockedError: 另一个标签页占着连接');
  }),
  saveSaveSlot: vi.fn(async () => {}),
  saveCharacters: vi.fn(async () => {}),
  saveSaveProfile: vi.fn(async () => {}),
  savePlotEvents: vi.fn(async () => {}),
  saveMemory: vi.fn(async () => {}),
}));

/** 模拟一次全新页面加载，拿到一份干净模块状态。 */
async function freshPageLoad() {
  vi.resetModules();
  return await import('./test-save');
}

beforeEach(() => {
  h.calls = [];
  h.clearThrows = false;
  vi.restoreAllMocks();
});

describe('ensureDb — 点击矩阵', () => {
  it('① 只点「清空重建」: 先清库，再补种', async () => {
    const m = await freshPageLoad();
    await m.createTestSave();

    expect(h.calls).toEqual(['clear', 'init']);
  });

  it('② 连点两次「清空重建」: 每次加载最多清一次，也只播种一次', async () => {
    const m = await freshPageLoad();
    await m.createTestSave();
    await m.createTestSave();

    // 第二下: clearedThisLoad 已真 → 不再清；initialized 已真 → 不再播种
    expect(h.calls).toEqual(['clear', 'init']);
  });

  it('③ 先「保留数据」再「清空重建」: 清完仍然会补种 (核心回归)', async () => {
    const m = await freshPageLoad();
    await m.createTestSavePreservingData(); // 这一下把 initialized 置真
    await m.createTestSave();               // 清库把默认数据删了 → 必须重新播种

    expect(h.calls).toEqual(['init', 'clear', 'init']);

    // 断言得更直白些: 清库之后必须还有至少一次播种，
    // 否则就是"清空了但没初始化"的坏状态。
    const lastClear = h.calls.lastIndexOf('clear');
    expect(h.calls.slice(lastClear).includes('init')).toBe(true);
  });

  it('④ 连点两次「保留数据」: 只播种一次，一次都不清', async () => {
    const m = await freshPageLoad();
    await m.createTestSavePreservingData();
    await m.createTestSavePreservingData();

    expect(h.calls).toEqual(['init']);
    expect(h.calls).not.toContain('clear');
  });
});

describe('ensureDb — 清库失败', () => {
  it('⑤ 清库失败不静默: 会 console.warn 说明这次没清成', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.clearThrows = true;

    const m = await freshPageLoad();
    await m.createTestSave();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('清空数据库失败');
    // 失败了也仍然要保证库是可用的
    expect(h.calls).toEqual(['clear', 'init']);
  });

  it('⑥ 清库失败不记成「已清过」: 下一次点击仍会重试', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.clearThrows = true;

    const m = await freshPageLoad();
    await m.createTestSave(); // 第一下: 清失败

    h.clearThrows = false;
    await m.createTestSave(); // 第二下: 应当重试清库，并在清完后补种

    expect(h.calls).toEqual(['clear', 'init', 'clear', 'init']);
  });

  it('⑦ 清库成功后才置位: 成功那次之后不再重复清', async () => {
    const m = await freshPageLoad();
    await m.createTestSave();
    await m.createTestSave();
    await m.createTestSavePreservingData();

    expect(h.calls.filter((c) => c === 'clear')).toHaveLength(1);
  });
});
