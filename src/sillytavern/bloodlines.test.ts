/**
 * bloodlines.ts — 血脉系统测试 (Phase 5)
 */
import { describe, it, expect } from 'vitest';
import {
  KNOWN_BLOODLINES,
  getBloodline,
  getBloodlineList,
  calcBloodlineModifiers,
} from './bloodlines';

// ========== KNOWN_BLOODLINES ==========

describe('KNOWN_BLOODLINES', () => {
  it('应有 23 个已知血脉（对齐世界书种族）', () => {
    const entries = Object.entries(KNOWN_BLOODLINES);
    expect(entries).toHaveLength(23);
  });

  it('human 的 statModifiers 应为空对象', () => {
    const human = KNOWN_BLOODLINES['human'];
    expect(human).toBeDefined();
    expect(human.statModifiers).toEqual({});
  });

  it('每个血脉应包含 name 和 description', () => {
    for (const [id, info] of Object.entries(KNOWN_BLOODLINES)) {
      expect(info.name, `${id} 缺少 name`).toBeTypeOf('string');
      expect(info.name.length, `${id} name 不应为空`).toBeGreaterThan(0);
      expect(info.description, `${id} 缺少 description`).toBeTypeOf('string');
      expect(info.description.length, `${id} description 不应为空`).toBeGreaterThan(0);
    }
  });

  it('每个血脉的 id 应为合法标识符', () => {
    const ids = Object.keys(KNOWN_BLOODLINES);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });
});

// ========== getBloodline ==========

describe('getBloodline', () => {
  it('传入 "dragon" 应返回完整信息（name / statModifiers / description）', () => {
    const result = getBloodline('dragonkin_north');
    expect(result).toBeDefined();
    expect(result!.name).toBe('北境龙裔');
    expect(result!.statModifiers).toEqual({ str: 2, con: 2 });
    expect(result!.description).toBe(
      '人形龙血传承者（1.8-2.2m），竖瞳，龙吼之力',
    );
  });

  it('传入 "vampire" 应返回包含负修正的血脉', () => {
    const result = getBloodline('vampire');
    expect(result).toBeDefined();
    expect(result!.statModifiers).toEqual({ dex: 2, con: -1, spi: 2 });
  });

  it('传入未知 id 应返回 undefined', () => {
    expect(getBloodline('unknown_bloodline')).toBeUndefined();
    expect(getBloodline('')).toBeUndefined();
    expect(getBloodline('__invalid__')).toBeUndefined();
  });
});

// ========== getBloodlineList ==========

describe('getBloodlineList', () => {
  it('应返回含 23 个条目的数组', () => {
    const list = getBloodlineList();
    expect(list).toHaveLength(23);
  });

  it('每个条目应包含 id / name / description / statModifiers', () => {
    const list = getBloodlineList();
    for (const item of list) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('description');
      expect(item).toHaveProperty('statModifiers');
      expect(typeof item.id).toBe('string');
      expect(typeof item.name).toBe('string');
    }
  });

  it('返回的 id 应与 KNOWN_BLOODLINES 的 key 完全一致', () => {
    const list = getBloodlineList();
    const ids = list.map((it) => it.id).sort();
    const expectedIds = Object.keys(KNOWN_BLOODLINES).sort();
    expect(ids).toEqual(expectedIds);
  });
});

// ========== calcBloodlineModifiers ==========

describe('calcBloodlineModifiers', () => {
  it('单血脉 dragon 应返回 { str: 2, con: 2 }', () => {
    const result = calcBloodlineModifiers(['dragonkin_north']);
    expect(result).toEqual({ str: 2, con: 2 });
  });

  it('空数组应返回 {}', () => {
    const result = calcBloodlineModifiers([]);
    expect(result).toEqual({});
  });

  it('human（空修正）应返回 {}', () => {
    const result = calcBloodlineModifiers(['human']);
    expect(result).toEqual({});
  });

  it('dragon + elf 复合应返回正确的组合修正', () => {
    // dragon: { str: 2, con: 2 }; elf: { dex: 2, int: 1 }
    const result = calcBloodlineModifiers(['dragonkin_north', 'elf']);
    expect(result).toEqual({ str: 2, con: 2, dex: 2, int: 1 });
  });

  it('未知 id 应被忽略不影响结果', () => {
    const result = calcBloodlineModifiers(['dragonkin_north', 'unknown', 'also_unknown']);
    expect(result).toEqual({ str: 2, con: 2 });
  });

  it('全部为未知 id 时应返回 {}', () => {
    const result = calcBloodlineModifiers(['unknown', 'nope']);
    expect(result).toEqual({});
  });

  it('同属性多来源应正确累加（dragon + dwarf 共 str: 2+1=3）', () => {
    // dragon: str:2, con:2; dwarf: str:1, con:2
    const result = calcBloodlineModifiers(['dragonkin_north', 'dwarf']);
    expect(result).toEqual({ str: 3, con: 4 });
  });

  it('正负修正应正确抵消（dragon + undead: con 2 + (-1) = 1）', () => {
    // dragon: { str: 2, con: 2 }; undead: { con: -1, spi: 2 }
    const result = calcBloodlineModifiers(['dragonkin_north', 'undead']);
    expect(result).toEqual({ str: 2, con: 1, spi: 2 });
  });

  it('三血脉亡灵+血族+魔族应正确累加（含多个共同属性）', () => {
    // undead:  { con: -1, spi: 2 }
    // vampire: { dex: 2, con: -1, spi: 2 }
    // demon:   { str: 2, spi: 1 }
    const result = calcBloodlineModifiers(['undead', 'vampire', 'demon']);
    expect(result).toEqual({ con: -2, spi: 5, dex: 2, str: 2 });
  });
});
