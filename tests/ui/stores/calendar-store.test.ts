import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { SaveCalendar } from '../../../src/core/types/types-calendar';

const engine = vi.hoisted(() => ({
  getSaveCalendar: vi.fn(),
  persistCalendarMode: vi.fn(),
  persistCalendarEntry: vi.fn(),
  removeCalendarEntry: vi.fn(),
  persistCalendarHidden: vi.fn(),
  persistCalendarLocalRegionOnly: vi.fn(),
}));
vi.mock('@engine/calendar/calendar-store', () => engine);

import { useCalendarStore } from '../../../src/ui/stores/calendar-store';

const row = (saveId: string, patch: Partial<SaveCalendar> = {}): SaveCalendar => ({
  saveId,
  mode: 'normal',
  entries: [],
  hiddenKinds: [],
  hiddenRegions: [],
  hiddenKeys: [],
  localRegionOnly: false,
  updatedAt: 0,
  ...patch,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
});

describe('calendar-store（界面侧）', () => {
  it('读到之前是 null —— 不拿默认的普通模式顶替', async () => {
    const pending = deferred<SaveCalendar>();
    engine.getSaveCalendar.mockReturnValueOnce(pending.promise);
    const store = useCalendarStore();
    const loading = store.load('a');
    expect(store.calendar).toBeNull();
    pending.resolve(row('a', { mode: 'immersive' }));
    await loading;
    expect(store.calendar?.mode).toBe('immersive');
  });

  it('切档竞态：无论哪个先返回，留下的都是最近一次请求的存档', async () => {
    const store = useCalendarStore();
    for (const firstToResolve of ['a', 'b'] as const) {
      const a = deferred<SaveCalendar>();
      const b = deferred<SaveCalendar>();
      engine.getSaveCalendar.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
      const loadA = store.load('a');
      const loadB = store.load('b');
      if (firstToResolve === 'a') {
        a.resolve(row('a'));
        await loadA;
        expect(store.calendar).toBeNull(); // 过期结果不接纳
        b.resolve(row('b'));
      } else {
        b.resolve(row('b'));
        await loadB;
        a.resolve(row('a'));
      }
      await Promise.all([loadA, loadB]);
      expect(store.calendar?.saveId, `先返回的是 ${firstToResolve}`).toBe('b');
    }
  });

  it('读取失败：记下失败的存档并把错误抛给调用方，日历保持 null', async () => {
    engine.getSaveCalendar.mockRejectedValueOnce(new Error('boom'));
    const store = useCalendarStore();
    await expect(store.load('a')).rejects.toThrow('boom');
    expect(store.calendar).toBeNull();
    expect(store.failedSaveId).toBe('a');
    engine.getSaveCalendar.mockResolvedValueOnce(row('a'));
    await store.load('a');
    expect(store.failedSaveId).toBeNull();
    expect(store.calendar?.saveId).toBe('a');
  });

  it('写入后以引擎返回的行替换；别的存档的回执不接纳', async () => {
    engine.getSaveCalendar.mockResolvedValueOnce(row('a'));
    const store = useCalendarStore();
    await store.load('a');
    engine.persistCalendarHidden.mockResolvedValueOnce(row('a', { hiddenKeys: ['k'] }));
    await store.setHidden('a', { key: 'k' }, true);
    expect(engine.persistCalendarHidden).toHaveBeenCalledWith('a', { key: 'k' }, true);
    expect(store.calendar?.hiddenKeys).toEqual(['k']);
    engine.persistCalendarMode.mockResolvedValueOnce(row('other', { mode: 'immersive' }));
    await store.setMode('other', 'immersive');
    expect(store.calendar?.saveId).toBe('a');
    expect(store.calendar?.mode).toBe('normal');
  });
});
