/**
 * combat-v3/summon-pool.test.ts — 预生成召唤物池（M3.5，§6.4 可选增强）
 *
 * 验收（plan §6.8）：CharGenRequest 优先查池（幂等查找 / key 归一化）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SUMMON_POOL, summonPoolKey, lookupSummon } from './summon-pool';
import type { SummonedUnitDefinition } from './types';

function mkDef(name: string): SummonedUnitDefinition {
  return {
    name,
    race: '亡灵',
    tier: 1,
    level: 5,
    attributes: { str: 5, dex: 6, con: 5, int: 0, spi: 0 },
    hp: 350,
    mp: 0,
    sp: 200,
    defense: 30,
    dr: 0,
    penetration: 0,
    hitBonus: 5,
    dodgeBonus: 0,
    weaponAtk: 30,
    divinity: 1,
    side: 'player',
  };
}

// 测试结束时恢复空池（M3.5 内容由离线脚本填充，测试不得泄漏）
afterEach(() => {
  for (const k of Object.keys(SUMMON_POOL)) delete (SUMMON_POOL as Record<string, unknown>)[k];
});

describe('summonPoolKey', () => {
  it('归一化「种族-层级-定位」', () => {
    expect(summonPoolKey({ race: '亡灵', tier: 1, role: '近战' })).toBe('亡灵-1-近战');
  });

  it('缺省字段宽容兜底（不崩）', () => {
    expect(summonPoolKey({})).toBe('*-x-*');
    expect(summonPoolKey({ tier: 3 })).toBe('*-3-*');
  });
});

describe('lookupSummon', () => {
  beforeEach(() => {
    (SUMMON_POOL as Record<string, SummonedUnitDefinition>)['亡灵-1-近战'] = mkDef('食尸鬼');
  });

  it('精确命中', () => {
    expect(lookupSummon({ race: '亡灵', tier: 1, role: '近战' })?.name).toBe('食尸鬼');
  });

  it('未命中返回 undefined（走实时 char_gen）', () => {
    expect(lookupSummon({ race: '元素', tier: 2, role: '近战' })).toBeUndefined();
  });
});
