/**
 * attribute-allocation.test.ts — 自由属性点分配（真实 DB 集成）
 *
 * 走 fake-indexeddb + 真实 StateManager，验证「点一下 → 点数 -1、属性 +1」这条链
 * 真的落库，而不是只在内存里对。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDefaultCharacterState } from './types';
import { clearAllData, initializeDatabase, saveCharacter, getCharacters } from './database';
import { allocateAttributePoint } from './attribute-allocation';

const SAVE_ID = 'save-attr-001';

beforeEach(async () => {
  try {
    await clearAllData();
  } catch {
    /* 首次运行时库还不存在 */
  }
  await initializeDatabase();
});

async function seedHero(overrides: Record<string, unknown> = {}) {
  const char = createDefaultCharacterState({
    id: 'char-hero',
    saveId: SAVE_ID,
    name: '测试主角',
    type: 'player',
    tier: 1,
    level: 3,
    freeAttrPoints: 2,
    attributes: { str: 5, dex: 5, con: 5, int: 5, spi: 5 },
    ...overrides,
  });
  await saveCharacter(char);
  return char;
}

async function readHero() {
  const chars = await getCharacters(SAVE_ID);
  return chars.find((c) => c.id === 'char-hero')!;
}

describe('allocateAttributePoint', () => {
  it('成功路径：点数 -1、指定属性 +1，其余维度不动', async () => {
    await seedHero();

    const result = await allocateAttributePoint(SAVE_ID, '测试主角', 'str');

    expect(result.ok).toBe(true);
    const after = await readHero();
    expect(after.freeAttrPoints).toBe(1);
    expect(after.attributes).toEqual({ str: 6, dex: 5, con: 5, int: 5, spi: 5 });
  });

  it('「主角」别名可寻址（铁律1 同口径）', async () => {
    await seedHero();

    const result = await allocateAttributePoint(SAVE_ID, '主角', 'spi');

    expect(result.ok).toBe(true);
    expect((await readHero()).attributes.spi).toBe(6);
  });

  it('分配不写 level/tier → 不会顺带触发升级自动加点', async () => {
    await seedHero({ freeAttrPoints: 3 });

    await allocateAttributePoint(SAVE_ID, '测试主角', 'dex');

    const after = await readHero();
    expect(after.level).toBe(3);
    expect(after.tier).toBe(1);
    // 3 - 1 = 2；若 level/tier 被写进 patch，这里会因自动发放变成 3
    expect(after.freeAttrPoints).toBe(2);
  });

  it('没有可用点数 → ok:false 且状态不变', async () => {
    await seedHero({ freeAttrPoints: 0 });

    const result = await allocateAttributePoint(SAVE_ID, '测试主角', 'str');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('没有可用的自由属性点');
    const after = await readHero();
    expect(after.attributes.str).toBe(5);
    expect(after.freeAttrPoints).toBe(0);
  });

  it('已达当前层级属性上限 → ok:false 且状态不变（T1 上限 8）', async () => {
    await seedHero({ attributes: { str: 8, dex: 5, con: 5, int: 5, spi: 5 } });

    const result = await allocateAttributePoint(SAVE_ID, '测试主角', 'str');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('属性已达当前层级上限');
    const after = await readHero();
    expect(after.attributes.str).toBe(8);
    expect(after.freeAttrPoints).toBe(2);
  });

  it('上限只挡满了的那一维，别的维度照常分配', async () => {
    await seedHero({ attributes: { str: 8, dex: 5, con: 5, int: 5, spi: 5 } });

    const result = await allocateAttributePoint(SAVE_ID, '测试主角', 'dex');

    expect(result.ok).toBe(true);
    expect((await readHero()).attributes.dex).toBe(6);
  });

  it('角色不存在 → ok:false', async () => {
    await seedHero();

    const result = await allocateAttributePoint(SAVE_ID, '查无此人', 'int');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('角色不存在');
  });
});
