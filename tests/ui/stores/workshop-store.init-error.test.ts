/**
 * workshop-store 启动失败路径（W-01 / W-03，2026-11-14）
 *
 * 断言：init() 失败时记下原因、ready 保持 false、可以重试；读库失败不再伪装成「尚未安装」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const h = vi.hoisted(() => ({
  worldbookInit: vi.fn(async () => {}),
  beautifierInit: vi.fn(async () => {}),
  toArray: vi.fn(async () => [] as unknown[]),
}));

vi.mock('../../../src/ui/stores/worldbook-store', () => ({
  useWorldBookStore: () => ({ init: h.worldbookInit, getBook: () => undefined }),
}));
vi.mock('../../../src/ui/stores/beautifier-store', () => ({
  useBeautifierStore: () => ({ init: h.beautifierInit, userRules: [] }),
}));
vi.mock('@engine/persistence/database', () => ({
  getDatabase: () => ({ workshopProjects: { toArray: h.toArray } }),
}));

import { useWorkshopStore } from '../../../src/ui/stores/workshop-store';

beforeEach(() => {
  vi.clearAllMocks();
  h.worldbookInit.mockImplementation(async () => {});
  h.beautifierInit.mockImplementation(async () => {});
  h.toArray.mockImplementation(async () => []);
  setActivePinia(createPinia());
});

describe('workshop-store init 失败', () => {
  it('前置初始化失败时记下原因、ready 保持 false', async () => {
    h.worldbookInit.mockRejectedValueOnce(new Error('世界书读取失败'));
    const store = useWorkshopStore();

    await expect(store.init()).rejects.toThrow('世界书读取失败');
    expect(store.ready).toBe(false);
    expect(store.initError).toBe('世界书读取失败');
  });

  it('读已装项目失败时报错，而不是当作「尚未安装」', async () => {
    h.toArray.mockRejectedValueOnce(new Error('IndexedDB 不可用'));
    const store = useWorkshopStore();

    await expect(store.init()).rejects.toThrow('IndexedDB 不可用');
    expect(store.ready).toBe(false);
    expect(store.initError).toBe('IndexedDB 不可用');
  });

  it('失败后再次调用会重试，成功时清掉错误', async () => {
    h.toArray.mockRejectedValueOnce(new Error('暂时失败'));
    h.toArray.mockResolvedValueOnce([{ id: 'p1' }]);
    const store = useWorkshopStore();

    await expect(store.init()).rejects.toThrow('暂时失败');
    await store.init();

    expect(store.ready).toBe(true);
    expect(store.initError).toBe('');
    expect(store.projects).toHaveLength(1);
  });
});
