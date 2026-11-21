/**
 * create-custom-library-store 测试 —— 自制开局条目全局库（Dexie v35 `createCustomItems`）
 *
 * 真 Dexie + fake-indexeddb。覆盖：init 幂等与坏行收窄、按类别取、同类别同名替换、
 * 非 `custom_` id 拒收、删除；库被外部改写后 refresh 重读、save 按现读的库算替换、
 * 首次读失败下次重试。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { clearAllData, getCreateCustomItems, getDatabase } from '@engine/persistence/database';

// 只包一层读函数，让个别用例能模拟 IndexedDB 读失败；默认直通真实现
const readFailures = vi.hoisted(() => ({ remaining: 0 }));
vi.mock('@engine/persistence/database', async (importOriginal) => {
  const real = await importOriginal<typeof import('@engine/persistence/database')>();
  return {
    ...real,
    getCreateCustomItems: async () => {
      if (readFailures.remaining > 0) {
        readFailures.remaining--;
        throw new Error('模拟 IndexedDB 不可用');
      }
      return real.getCreateCustomItems();
    },
  };
});
import type { CatalogItem } from '@engine/content/start-catalog-mechanics';
import { useCreateCustomLibraryStore } from '../../../src/ui/stores/create-custom-library-store';

function mkItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'custom_skill_aaaa0001',
    name: '自制火花',
    category: 'skill',
    type: '主动',
    rarity: 'common',
    tag: [],
    effect: {},
    description: '一点火花',
    cost: 10,
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  readFailures.remaining = 0;
});

afterEach(async () => {
  await clearAllData();
});

describe('init / 读出', () => {
  it('空库 init 后 entries 为空；init 幂等', async () => {
    const store = useCreateCustomLibraryStore();
    await store.init();
    await store.init();
    expect(store.entries).toEqual([]);
  });

  it('坏行与主键对不上的行不显示，但不删库', async () => {
    const db = getDatabase();
    await db.createCustomItems.bulkPut([
      {
        id: 'custom_skill_good0001',
        category: 'skill',
        name: '好条目',
        createdAt: 1,
        updatedAt: 1,
        data: mkItem({ id: 'custom_skill_good0001', name: '好条目' }),
      },
      {
        id: 'custom_skill_bad00001',
        category: 'skill',
        name: '坏条目',
        createdAt: 1,
        updatedAt: 2,
        data: { ...mkItem({ id: 'custom_skill_bad00001' }), cost: -5 },
      },
      {
        id: 'custom_skill_mismatch',
        category: 'skill',
        name: '错位',
        createdAt: 1,
        updatedAt: 3,
        data: mkItem({ id: 'custom_skill_other' }),
      },
    ]);
    const store = useCreateCustomLibraryStore();
    await store.init();
    expect(store.entries.map((e) => e.id)).toEqual(['custom_skill_good0001']);
    expect(await getCreateCustomItems()).toHaveLength(3);
  });
});

describe('save', () => {
  it('收窄后落库，按类别可取，has 命中', async () => {
    const store = useCreateCustomLibraryStore();
    await store.init();
    const res = await store.save(mkItem({ name: '  自制火花  ' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.name).toBe('自制火花');
    expect(store.has('custom_skill_aaaa0001')).toBe(true);
    expect(store.byCategory('skill').map((e) => e.id)).toEqual(['custom_skill_aaaa0001']);
    expect(store.byCategory('item')).toEqual([]);
    expect((await getCreateCustomItems()).map((r) => r.id)).toEqual(['custom_skill_aaaa0001']);
  });

  it('同类别同名替换旧条目（库里只剩新的），不同类别同名并存', async () => {
    const store = useCreateCustomLibraryStore();
    await store.init();
    await store.save(mkItem({ id: 'custom_skill_old00001', name: '同名' }));
    await store.save(
      mkItem({ id: 'custom_item_same0001', name: '同名', category: 'item', quantity: 2 }),
    );
    await store.save(mkItem({ id: 'custom_skill_new00001', name: '同名', cost: 20 }));
    expect(store.byCategory('skill').map((e) => e.id)).toEqual(['custom_skill_new00001']);
    expect(store.byCategory('item').map((e) => e.id)).toEqual(['custom_item_same0001']);
    const rows = await getCreateCustomItems();
    expect(rows.map((r) => r.id).sort()).toEqual(['custom_item_same0001', 'custom_skill_new00001']);
  });

  it('非 custom_ id 拒收，不落库', async () => {
    const store = useCreateCustomLibraryStore();
    await store.init();
    const res = await store.save(mkItem({ id: 'sk_目录技能' }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('failed');
    expect(store.entries).toEqual([]);
    expect(await getCreateCustomItems()).toEqual([]);
  });

  it('新 store 实例 init 后读回已存条目', async () => {
    const store = useCreateCustomLibraryStore();
    await store.init();
    await store.save(mkItem());
    setActivePinia(createPinia());
    const fresh = useCreateCustomLibraryStore();
    await fresh.init();
    expect(fresh.entries.map((e) => e.id)).toEqual(['custom_skill_aaaa0001']);
  });
});

describe('remove', () => {
  it('删除后从 entries 与库中消失', async () => {
    const store = useCreateCustomLibraryStore();
    await store.init();
    await store.save(mkItem());
    const res = await store.remove('custom_skill_aaaa0001');
    expect(res.ok).toBe(true);
    expect(store.has('custom_skill_aaaa0001')).toBe(false);
    expect(await getCreateCustomItems()).toEqual([]);
  });

  it('非 custom_ id 拒绝；不存在的 id 回 not-found', async () => {
    const store = useCreateCustomLibraryStore();
    await store.init();
    const bad = await store.remove('sk_目录技能');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('failed');
    const missing = await store.remove('custom_skill_nope0001');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('not-found');
  });
});

describe('库被外部改写（整库备份导入不刷新页面）', () => {
  function rowOf(item: CatalogItem, updatedAt: number) {
    return {
      id: item.id,
      category: item.category,
      name: item.name,
      createdAt: 1,
      updatedAt,
      data: item,
    };
  }

  it('init 过的 store：refresh 读到外部换进来的新行，旧行消失', async () => {
    const store = useCreateCustomLibraryStore();
    await store.init();
    await store.save(mkItem({ id: 'custom_skill_old00001', name: '旧条目' }));

    const db = getDatabase();
    await db.createCustomItems.clear();
    await db.createCustomItems.put(
      rowOf(mkItem({ id: 'custom_skill_imp00001', name: '导入条目' }), 5),
    );

    await store.init(); // 已加载过，不重读
    expect(store.entries.map((e) => e.id)).toEqual(['custom_skill_old00001']);
    expect(await store.refresh()).toBe(true);
    expect(store.entries.map((e) => e.id)).toEqual(['custom_skill_imp00001']);
  });

  it('★ 内存是旧快照时 save 仍替换库里真正的同名行（不产生同名重复）', async () => {
    const store = useCreateCustomLibraryStore();
    await store.init(); // 内存：空

    // 外部（导入）写进一条同类别同名行，内存不知道
    await getDatabase().createCustomItems.put(
      rowOf(mkItem({ id: 'custom_skill_imp00001', name: '同名' }), 5),
    );

    const res = await store.save(mkItem({ id: 'custom_skill_new00001', name: '同名', cost: 30 }));
    expect(res.ok).toBe(true);
    const rows = await getCreateCustomItems();
    expect(rows.map((r) => r.id)).toEqual(['custom_skill_new00001']);
    expect(store.entries.map((e) => e.id)).toEqual(['custom_skill_new00001']);
  });

  it('save 时现读的库里其他外部新行也进内存视图', async () => {
    const store = useCreateCustomLibraryStore();
    await store.init();
    await getDatabase().createCustomItems.put(
      rowOf(
        mkItem({ id: 'custom_item_imp00001', name: '导入物品', category: 'item', quantity: 1 }),
        5,
      ),
    );
    await store.save(mkItem());
    expect(store.byCategory('item').map((e) => e.id)).toEqual(['custom_item_imp00001']);
  });
});

describe('读失败', () => {
  it('★ 首次读失败不算加载过：下次 init / refresh 重试并读到数据', async () => {
    await getDatabase().createCustomItems.put({
      id: 'custom_skill_aaaa0001',
      category: 'skill',
      name: '自制火花',
      createdAt: 1,
      updatedAt: 1,
      data: mkItem(),
    });
    const store = useCreateCustomLibraryStore();
    readFailures.remaining = 1;
    await store.init();
    expect(store.entries).toEqual([]);
    expect(store.loading).toBe(false);

    await store.init();
    expect(store.entries.map((e) => e.id)).toEqual(['custom_skill_aaaa0001']);
  });

  it('refresh 读失败返回 false 且保留现有内存视图', async () => {
    const store = useCreateCustomLibraryStore();
    await store.init();
    await store.save(mkItem());
    readFailures.remaining = 1;
    expect(await store.refresh()).toBe(false);
    expect(store.entries.map((e) => e.id)).toEqual(['custom_skill_aaaa0001']);
  });

  it('save 前读库失败时拒绝写入，返回 failed', async () => {
    const store = useCreateCustomLibraryStore();
    await store.init();
    readFailures.remaining = 1;
    const res = await store.save(mkItem());
    expect(res.ok).toBe(false);
    expect(await getCreateCustomItems()).toEqual([]);
  });
});
