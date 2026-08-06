/**
 * image-tag-bank-store.test.ts — 词库落库口（图像 v1.4）
 *
 * 用 fake-indexeddb 跑真 Dexie（与 image-preset-store.test.ts 同口径）：
 * 这一层的价值全在「真的写进去了、真的读得回来」，mock 掉 db 就什么都没证明。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { createPinia, setActivePinia } from 'pinia';
import { useImageTagBankStore } from './image-tag-bank-store';
import { getDatabase } from '@engine/database';

/** 一份最小的 ST 世界书 JSON */
const LOREBOOK = {
  entries: {
    '0': {
      uid: 0,
      key: ['温泉'],
      comment: '[场景]：温泉',
      content: '- 温泉：onsen, hot spring',
    },
    '1': {
      uid: 1,
      key: ['兽耳', '猫耳'],
      comment: '[特征]：兽耳',
      content: '- 兽耳：animal ears/cat ears',
    },
  },
};

describe('useImageTagBankStore', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    await getDatabase().imageTagBanks.clear();
  });

  it('导入 → 落库 → 读得回来', async () => {
    const store = useImageTagBankStore();
    await store.init();

    const result = await store.importFromJson(LOREBOOK, '我的词库', 'tags.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plan.stats.imported).toBe(2);
    expect(result.value.bank.name).toBe('我的词库');

    // 换一个 store 实例重新读库 —— 证明是真的写进了 Dexie
    setActivePinia(createPinia());
    const reloaded = useImageTagBankStore();
    await reloaded.init();
    expect(reloaded.banks).toHaveLength(1);
    expect(reloaded.enabledEntries).toHaveLength(2);
  });

  it('🔴 一条都读不出来时不落库 —— 空词库在列表里没法解释自己', async () => {
    const store = useImageTagBankStore();
    await store.init();

    const result = await store.importFromJson({ entries: { a: { uid: 1, comment: '' } } }, 'x');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('没读出任何标签条目');
    expect(store.banks).toHaveLength(0);
  });

  it('有跳过项但也有成功项时照常落库，报告随之返回', async () => {
    const store = useImageTagBankStore();
    await store.init();

    const result = await store.importFromJson(
      {
        entries: {
          a: { uid: 1, comment: '[场景]：好的', content: '- 好的：rooftop' },
          b: { uid: 2, comment: '[场景]：坏的', content: '' },
        },
      },
      'x',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plan.stats.imported).toBe(1);
    expect(result.value.plan.stats.skipped).toBe(1);
    expect(result.value.plan.notes.some((n) => n.kind === 'skipped')).toBe(true);
  });

  it('整本停用后 enabledEntries 立刻为空（不必删就能试）', async () => {
    const store = useImageTagBankStore();
    await store.init();
    const imported = await store.importFromJson(LOREBOOK, '词库');
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    expect(store.enabledEntries).toHaveLength(2);
    await store.setEnabled(imported.value.bank.id, false);
    expect(store.enabledEntries).toHaveLength(0);
    // 条目还在库里，只是不生效
    expect(store.totalEntries).toBe(2);
  });

  it('catalogueChars 报的是目录真实字符数，供设置页说明每张图的成本', async () => {
    const store = useImageTagBankStore();
    await store.init();
    expect(store.catalogueChars).toBe(0);

    await store.importFromJson(LOREBOOK, '词库');
    expect(store.catalogueChars).toBeGreaterThan(0);
    // 目录只列名字，不含标签本体
    expect(store.catalogueChars).toBeLessThan(500);
  });

  it('改名与删除', async () => {
    const store = useImageTagBankStore();
    await store.init();
    const imported = await store.importFromJson(LOREBOOK, '旧名');
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const id = imported.value.bank.id;

    expect((await store.rename(id, '新名')).ok).toBe(true);
    expect(store.banks[0].name).toBe('新名');

    expect((await store.rename(id, '   ')).ok).toBe(false);
    expect(store.banks[0].name).toBe('新名');

    expect((await store.remove(id)).ok).toBe(true);
    expect(store.banks).toHaveLength(0);
    expect(await getDatabase().imageTagBanks.count()).toBe(0);
  });

  it('操作已不存在的词库 → not-found，不抛', async () => {
    const store = useImageTagBankStore();
    await store.init();
    const r = await store.remove('没有这本');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not-found');
  });

  it('多本合并生效，停用的那本不参与', async () => {
    const store = useImageTagBankStore();
    await store.init();
    const a = await store.importFromJson(LOREBOOK, 'A');
    const b = await store.importFromJson(
      { entries: { z: { uid: 9, comment: '[场景]：屋顶', content: '- 屋顶：rooftop' } } },
      'B',
    );
    expect(a.ok && b.ok).toBe(true);
    expect(store.enabledEntries).toHaveLength(3);

    if (!a.ok) return;
    await store.setEnabled(a.value.bank.id, false);
    expect(store.enabledEntries.map((e) => e.name)).toEqual(['屋顶']);
  });
});
