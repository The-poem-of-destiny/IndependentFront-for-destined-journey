/**
 * character-appearance-store.test.ts —— 会话副本（D56）
 *
 * 🔴 本店的存在理由是**让自动写入可以被撤销**。所以这里的重点不是「写进去了没有」，
 * 而是三件更容易做错的事：
 *   ① 与基线等价的 patch 不落库（否则「重置」变成重置回一堆基线复制品）
 *   ② 逐回合**叠加**而不是替换（AI 这回合只报衣服，上回合的疤不该消失）
 *   ③ 改回基线值的槽要能**缩回去**（覆盖层只增不减 = 永远回不到干净状态）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { createPinia, setActivePinia } from 'pinia';

import { EMPTY_APPEARANCE, type CharacterAppearance } from '@engine/character-appearance';
import { getCharacterAppearances } from '@engine/database';
import { useCharacterAppearanceStore } from './character-appearance-store';

const SAVE = 'save_a';
const OTHER = 'save_b';

const ALICE: CharacterAppearance = {
  ...EMPTY_APPEARANCE,
  count: '1girl',
  hairColor: 'silver hair',
  hairStyle: 'very long hair',
  eyes: 'golden eyes',
  outfit: 'white mage robe',
};

async function freshStore(saveId = SAVE) {
  setActivePinia(createPinia());
  const store = useCharacterAppearanceStore();
  await store.load(saveId);
  await store.resetAll();
  return store;
}

beforeEach(async () => {
  const s = await freshStore(OTHER);
  await s.resetAll();
});

describe('自动写入', () => {
  it('换装：落一行，且只记差异的那个槽', async () => {
    const store = await freshStore();
    await store.applyPatch('艾莉丝', ALICE, { outfit: 'travel cloak' });

    expect(store.patchOf('艾莉丝')).toEqual({ outfit: 'travel cloak' });
    // 身份槽没被抄进覆盖层 —— 覆盖层只记差异
    expect(store.patchOf('艾莉丝')).not.toHaveProperty('hairColor');

    const rows = await getCharacterAppearances(SAVE);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('艾莉丝');
  });

  /**
   * 🔴 v1.3 的核心：**没有基线的角色，AI 即兴出来的那份也落这里**，差量基准是全空。
   *
   * 此前这种角色走的是「AI 现建一份**全局基线**」（D57 原版），而全局意味着 A 周目的
   * 即兴成了 B 周目的定义，且两个重置口都够不着它 —— 设置页却正写着「初始设定不受影响」。
   * 现在基线只有用户能写，这条断言就是那个保证的落点。
   */
  it('🔴 没有基线的角色：即兴外貌整份落会话层（差量基准是全空）', async () => {
    const store = await freshStore();
    await store.applyPatch('无名剑客', EMPTY_APPEARANCE, {
      count: '1boy',
      hairColor: 'black hair',
      outfit: 'worn leather armor',
    });

    // 全空基线下，「差异」就是它报的全部内容 —— 一个槽都不该丢
    expect(store.patchOf('无名剑客')).toEqual({
      count: '1boy',
      hairColor: 'black hair',
      outfit: 'worn leather armor',
    });
    // 落的是**本存档**的行；基线表（imagePresets）本轮一个字节都没写
    const rows = await getCharacterAppearances(SAVE);
    expect(rows.map((r) => r.name)).toEqual(['无名剑客']);
    expect(rows[0].saveId).toBe(SAVE);

    // 而且它照样能被单角色重置口清掉 —— 这正是「自动写入可接受」的前提
    await store.resetOne('无名剑客');
    expect(store.patchOf('无名剑客')).toBeUndefined();
  });

  it('🔴 与基线等价的 patch 不落库（每张图写一行噪音会毁掉重置）', async () => {
    const store = await freshStore();
    const res = await store.applyPatch('艾莉丝', ALICE, {
      hairColor: 'silver hair',
      outfit: 'white mage robe',
    });

    expect(res.ok).toBe(true);
    expect(store.rows).toHaveLength(0);
    expect(await getCharacterAppearances(SAVE)).toHaveLength(0);
  });

  it('🔴 逐回合叠加：这回合报衣服，上回合的疤还在', async () => {
    const store = await freshStore();
    await store.applyPatch('艾莉丝', ALICE, { features: 'scar on face' });
    await store.applyPatch('艾莉丝', ALICE, { outfit: 'travel cloak' });

    expect(store.patchOf('艾莉丝')).toEqual({
      features: 'scar on face',
      outfit: 'travel cloak',
    });
  });

  it('🔴 改回基线值的槽会缩回去 —— 覆盖层不能只增不减', async () => {
    const store = await freshStore();
    await store.applyPatch('艾莉丝', ALICE, { outfit: 'travel cloak' });
    expect(store.patchOf('艾莉丝')).toEqual({ outfit: 'travel cloak' });

    // 换回了那件白袍
    await store.applyPatch('艾莉丝', ALICE, { outfit: 'white mage robe' });

    // 整行消失，而不是留一个等于基线的槽
    expect(store.patchOf('艾莉丝')).toBeUndefined();
    expect(await getCharacterAppearances(SAVE)).toHaveLength(0);
  });

  it('resolve = 基线 + 本档覆盖', async () => {
    const store = await freshStore();
    await store.applyPatch('艾莉丝', ALICE, {
      hairStyle: 'short hair',
      features: 'scar on face',
    });

    const out = store.resolve('艾莉丝', ALICE);
    expect(out.hairStyle).toBe('short hair');
    expect(out.features).toBe('scar on face');
    expect(out.hairColor).toBe('silver hair'); // 基线原样
  });

  it('没有覆盖的角色 → 原样返回基线', async () => {
    const store = await freshStore();
    expect(store.resolve('没人画过的人', ALICE)).toEqual(ALICE);
  });

  it('没载入存档时拒绝写入，而不是写到一个说不清的地方', async () => {
    setActivePinia(createPinia());
    const store = useCharacterAppearanceStore();
    const res = await store.applyPatch('艾莉丝', ALICE, { outfit: 'x' });
    expect(res.ok).toBe(false);
  });
});

describe('两个重置口（D56）', () => {
  it('resetOne：只清这个角色，别人的正确变化不受牵连', async () => {
    const store = await freshStore();
    await store.applyPatch('艾莉丝', ALICE, { outfit: 'travel cloak' });
    await store.applyPatch('格雷', ALICE, { features: 'scar on face' });

    await store.resetOne('艾莉丝');

    expect(store.patchOf('艾莉丝')).toBeUndefined();
    expect(store.patchOf('格雷')).toEqual({ features: 'scar on face' });
    expect(await getCharacterAppearances(SAVE)).toHaveLength(1);
  });

  it('resetAll：整档回到基线', async () => {
    const store = await freshStore();
    await store.applyPatch('艾莉丝', ALICE, { outfit: 'travel cloak' });
    await store.applyPatch('格雷', ALICE, { features: 'scar on face' });

    await store.resetAll();

    expect(store.rows).toHaveLength(0);
    expect(await getCharacterAppearances(SAVE)).toHaveLength(0);
  });

  it('重置之后再出图，resolve 回到基线', async () => {
    const store = await freshStore();
    await store.applyPatch('艾莉丝', ALICE, { hairStyle: 'short hair' });
    await store.resetOne('艾莉丝');
    expect(store.resolve('艾莉丝', ALICE)).toEqual(ALICE);
  });
});

describe('🔴 按存档隔离', () => {
  it('两个存档里的同名角色互不干扰', async () => {
    const a = await freshStore(SAVE);
    await a.applyPatch('艾莉丝', ALICE, { outfit: 'travel cloak' });

    const b = await freshStore(OTHER);
    expect(b.patchOf('艾莉丝')).toBeUndefined();
    await b.applyPatch('艾莉丝', ALICE, { outfit: 'armor' });

    // 切回去，第一个存档的覆盖还在原样
    const backToA = useCharacterAppearanceStore();
    await backToA.load(SAVE);
    expect(backToA.patchOf('艾莉丝')).toEqual({ outfit: 'travel cloak' });
  });

  it('resetAll 只清当前存档', async () => {
    const a = await freshStore(SAVE);
    await a.applyPatch('艾莉丝', ALICE, { outfit: 'travel cloak' });

    const b = await freshStore(OTHER);
    await b.applyPatch('艾莉丝', ALICE, { outfit: 'armor' });
    await b.resetAll();

    expect(await getCharacterAppearances(OTHER)).toHaveLength(0);
    expect(await getCharacterAppearances(SAVE)).toHaveLength(1);
  });
});
