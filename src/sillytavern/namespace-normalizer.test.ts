/**
 * namespace-normalizer 单元测试 — stat_data.* ↔ engine 命名空间双向映射 (Layer 1/5)
 *
 * 覆盖: FLAT_TO_ENGINE / flatToEngine / engineToFlat /
 *       normalizeVariables / denormalizeVariables
 */

import { describe, it, expect } from 'vitest';
import {
  FLAT_TO_ENGINE,
  flatToEngine,
  engineToFlat,
  normalizeVariables,
  denormalizeVariables,
} from './namespace-normalizer';

// ========== FLAT_TO_ENGINE 映射表 ==========

describe('FLAT_TO_ENGINE mapping table', () => {
  it('contains expected 主角 stat mappings', () => {
    expect(FLAT_TO_ENGINE['stat_data.主角.HP']).toBe('char.player.hp');
    expect(FLAT_TO_ENGINE['stat_data.主角.MP']).toBe('char.player.mp');
    expect(FLAT_TO_ENGINE['stat_data.主角.SP']).toBe('char.player.sp');
    expect(FLAT_TO_ENGINE['stat_data.主角.maxHP']).toBe('char.player.maxHp');
    expect(FLAT_TO_ENGINE['stat_data.主角.等级']).toBe('char.player.level');
    expect(FLAT_TO_ENGINE['stat_data.主角.生命层级']).toBe('char.player.tier');
    expect(FLAT_TO_ENGINE['stat_data.主角.力量']).toBe('char.player.str');
    expect(FLAT_TO_ENGINE['stat_data.主角.金钱']).toBe('char.player.money');
  });

  it('contains expected 世界 stat mappings', () => {
    expect(FLAT_TO_ENGINE['stat_data.世界.地点']).toBe('sys.world.location');
    expect(FLAT_TO_ENGINE['stat_data.世界.时间']).toBe('sys.world.time');
    expect(FLAT_TO_ENGINE['stat_data.世界.年']).toBe('sys.world.year');
  });

  it('contains expected 系统 stat mappings', () => {
    expect(FLAT_TO_ENGINE['stat_data.命运点数']).toBe('sys.fp');
    expect(FLAT_TO_ENGINE['stat_data.任务列表']).toBe('sys.quests');
  });
});

// ========== flatToEngine ==========

describe('flatToEngine', () => {
  // --- 精确匹配 ---
  it('exact match: stat_data.主角.HP → char.player.hp', () => {
    expect(flatToEngine('stat_data.主角.HP')).toBe('char.player.hp');
  });

  it('exact match: stat_data.世界.时间 → sys.world.time', () => {
    expect(flatToEngine('stat_data.世界.时间')).toBe('sys.world.time');
  });

  it('exact match: stat_data.命运点数 → sys.fp', () => {
    expect(flatToEngine('stat_data.命运点数')).toBe('sys.fp');
  });

  it('exact match: stat_data.事件.标题 → sys.events.title', () => {
    expect(flatToEngine('stat_data.事件.标题')).toBe('sys.events.title');
  });

  // --- 前缀匹配 ---
  it('prefix match: stat_data.主角.X → char.player.X (unknown suffix)', () => {
    expect(flatToEngine('stat_data.主角.自定义属性')).toBe('char.player.自定义属性');
  });

  it('prefix match: stat_data.世界.天气 → sys.world.天气', () => {
    expect(flatToEngine('stat_data.世界.天气')).toBe('sys.world.天气');
  });

  it('prefix match: stat_data.事件.新字段 → sys.events.新字段', () => {
    expect(flatToEngine('stat_data.事件.新字段')).toBe('sys.events.新字段');
  });

  it('generic stat_data prefix: stat_data.未知键 → sys.未知键', () => {
    expect(flatToEngine('stat_data.未知键')).toBe('sys.未知键');
  });

  // --- 透传（不匹配的路径）---
  it('passthrough: unknown path returned as-is', () => {
    expect(flatToEngine('some.random.path')).toBe('some.random.path');
  });

  it('passthrough: already engine-prefixed path returned as-is', () => {
    expect(flatToEngine('char.player.hp')).toBe('char.player.hp');
    expect(flatToEngine('sys.world.location')).toBe('sys.world.location');
  });

  it('passthrough: empty string returned as-is', () => {
    expect(flatToEngine('')).toBe('');
  });

  // --- 边界情况 ---
  it('stat_data.主角 (no suffix dot) exact match to char.player', () => {
    expect(flatToEngine('stat_data.主角')).toBe('char.player');
  });

  it('stat_data.世界 (no suffix dot) exact match to sys.world', () => {
    expect(flatToEngine('stat_data.世界')).toBe('sys.world');
  });

  it('stat_data.事件.已完成事件 exact match takes priority over prefix', () => {
    // This key exists in FLAT_TO_ENGINE, so exact match fires
    expect(flatToEngine('stat_data.事件.已完成事件')).toBe('sys.events.completed');
  });
});

// ========== engineToFlat ==========

describe('engineToFlat', () => {
  // --- 反向精确匹配 ---
  it('reverse exact: char.player.hp → stat_data.主角.HP', () => {
    expect(engineToFlat('char.player.hp')).toBe('stat_data.主角.HP');
  });

  it('reverse exact: sys.world.time → stat_data.世界.时间', () => {
    expect(engineToFlat('sys.world.time')).toBe('stat_data.世界.时间');
  });

  it('reverse exact: sys.fp → stat_data.命运点数', () => {
    expect(engineToFlat('sys.fp')).toBe('stat_data.命运点数');
  });

  it('reverse exact: char.player.tier → stat_data.主角.生命层级', () => {
    expect(engineToFlat('char.player.tier')).toBe('stat_data.主角.生命层级');
  });

  // --- 反向前缀匹配 ---
  it('reverse prefix: char.player.Custom → stat_data.主角.Custom', () => {
    expect(engineToFlat('char.player.Custom')).toBe('stat_data.主角.Custom');
  });

  it('reverse prefix: sys.world.天气 → stat_data.世界.天气', () => {
    expect(engineToFlat('sys.world.天气')).toBe('stat_data.世界.天气');
  });

  it('reverse prefix: sys.events.描述 → stat_data.事件.描述', () => {
    expect(engineToFlat('sys.events.描述')).toBe('stat_data.事件.描述');
  });

  it('reverse generic sys prefix: sys.任意键 → stat_data.任意键', () => {
    expect(engineToFlat('sys.任意键')).toBe('stat_data.任意键');
  });

  // --- 透传 ---
  it('reverse passthrough: unknown engine path returned as-is', () => {
    expect(engineToFlat('unknown.namespace.path')).toBe('unknown.namespace.path');
  });

  it('reverse passthrough: already flat stat_data path returned as-is', () => {
    expect(engineToFlat('stat_data.主角.HP')).toBe('stat_data.主角.HP');
  });

  it('reverse passthrough: empty string', () => {
    expect(engineToFlat('')).toBe('');
  });

  it('reverse: char.player (no further suffix) → stat_data.主角 (reverse prefix)', () => {
    // 'char.player' doesn't have a dot suffix, so startsWith('char.player.') is false.
    // It falls through all prefix checks and is returned as-is.
    // But wait — reverse lookup in FLAT_TO_ENGINE values: 'char.player' IS a value.
    expect(engineToFlat('char.player')).toBe('stat_data.主角');
  });
});

// ========== normalizeVariables ==========

describe('normalizeVariables', () => {
  it('converts flat stat_data keys into namespaced engine tree', () => {
    const flat = {
      'stat_data.主角.HP': 100,
      'stat_data.主角.MP': 50,
      'stat_data.世界.时间': '正午',
    };
    const result = normalizeVariables(flat);
    expect(result).toEqual({
      user: {},
      sys: {
        world: { time: '正午' },
      },
      char: {
        player: { hp: 100, mp: 50 },
      },
      world: {},
      temp: {},
    });
  });

  it('returns all five namespaces even when input is empty', () => {
    const result = normalizeVariables({});
    expect(result).toEqual({
      user: {},
      sys: {},
      char: {},
      world: {},
      temp: {},
    });
  });

  it('handles keys that map to sys namespace (generic stat_data prefix)', () => {
    const flat = {
      'stat_data.命运点数': 3,
      'stat_data.任务列表': ['quest1', 'quest2'],
    };
    const result = normalizeVariables(flat);
    expect(result).toEqual({
      user: {},
      sys: { fp: 3, quests: ['quest1', 'quest2'] },
      char: {},
      world: {},
      temp: {},
    });
  });

  it('preserves array values', () => {
    const flat = {
      'stat_data.主角.背包': ['药水', '剑', '盾'],
    };
    const result = normalizeVariables(flat);
    expect(result.char.player.inventory).toEqual(['药水', '剑', '盾']);
  });

  it('preserves object values (deeply nested — not recursed into by normalizeVariables)', () => {
    // normalizeVariables does NOT recurse into values; it only maps top-level keys.
    // Object values are placed as-is at the resolved engine path.
    const flat = {
      'stat_data.主角.装备': { 武器: '铁剑', 防具: '皮甲' },
    };
    const result = normalizeVariables(flat);
    expect(result.char.player.equipment).toEqual({ 武器: '铁剑', 防具: '皮甲' });
  });

  it('handles mixed namespaces in single input', () => {
    const flat = {
      'stat_data.主角.HP': 80,
      'stat_data.世界.月': 6,
      'stat_data.事件.阶段': '第二章',
      'stat_data.命运点数': 5,
    };
    const result = normalizeVariables(flat);
    expect(result.char.player.hp).toBe(80);
    expect(result.sys.world.month).toBe(6);
    expect(result.sys.events.phase).toBe('第二章');
    expect(result.sys.fp).toBe(5);
  });

  it('passthrough keys end up in the first segment namespace', () => {
    // 'user.customSetting' → flatToEngine returns 'user.customSetting' (passthrough)
    // split by '.' → ['user', 'customSetting'] → ns='user'
    const flat = {
      'user.customSetting': 'enabled',
    };
    const result = normalizeVariables(flat);
    expect(result.user.customSetting).toBe('enabled');
  });
});

// ========== denormalizeVariables ==========

describe('denormalizeVariables', () => {
  it('converts namespaced engine tree to flat stat_data keys', () => {
    const engine = {
      char: { player: { hp: 100, mp: 50 } },
      sys: { world: { time: '黄昏' }, fp: 3 },
      user: {},
      world: {},
      temp: {},
    };
    const result = denormalizeVariables(engine);
    expect(result).toEqual({
      'stat_data.主角.HP': 100,
      'stat_data.主角.MP': 50,
      'stat_data.世界.时间': '黄昏',
      'stat_data.命运点数': 3,
    });
  });

  it('returns empty object for empty input', () => {
    expect(denormalizeVariables({})).toEqual({});
  });

  it('preserves array values in denormalized output', () => {
    const engine = {
      char: { player: { inventory: ['剑', '盾'] } },
      sys: {},
      user: {},
      world: {},
      temp: {},
    };
    const result = denormalizeVariables(engine);
    expect(result['stat_data.主角.背包']).toEqual(['剑', '盾']);
  });

  it('recursively flattens deeply nested objects into individual flat keys', () => {
    const engine = {
      char: {
        player: {
          equipment: { 武器: '铁剑', 防具: '皮甲' },
        },
      },
      sys: {},
      user: {},
      world: {},
      temp: {},
    };
    const result = denormalizeVariables(engine);
    // denormalizeVariables recurses into nested objects, flattening each leaf
    expect(result['stat_data.主角.equipment.武器']).toBe('铁剑');
    expect(result['stat_data.主角.equipment.防具']).toBe('皮甲');
    // The intermediate object node is not present as a flat key
  });

  it('handles unknown engine paths via passthrough', () => {
    const engine = {
      unknown: { key: 'value' },
      sys: {},
      user: {},
      char: {},
      world: {},
      temp: {},
    };
    const result = denormalizeVariables(engine);
    expect(result['unknown.key']).toBe('value');
  });
});

// ========== 往返一致性 ==========

describe('round-trip', () => {
  it('flat → normalize → denormalize yields identical flat keys for known paths', () => {
    const original = {
      'stat_data.主角.HP': 100,
      'stat_data.主角.MP': 50,
      'stat_data.世界.时间': '正午',
      'stat_data.命运点数': 3,
    };
    const normalized = normalizeVariables(original);
    const roundTripped = denormalizeVariables(normalized);
    expect(roundTripped).toEqual(original);
  });

  it('engine → denormalize → normalize yields equivalent engine tree', () => {
    const original = {
      char: { player: { hp: 80, mp: 40 } },
      sys: { world: { time: '深夜' }, fp: 2 },
      user: { setting: 'on' },
      world: {},
      temp: {},
    };
    const flat = denormalizeVariables(original);
    const roundTripped = normalizeVariables(flat);
    expect(roundTripped).toEqual(original);
  });

  it('round-trip preserves scalar values exactly', () => {
    const original = {
      'stat_data.主角.HP': 999,
      'stat_data.主角.等级': 50,
      'stat_data.世界.年': 1024,
    };
    const result = denormalizeVariables(normalizeVariables(original));
    expect(result['stat_data.主角.HP']).toBe(999);
    expect(result['stat_data.主角.等级']).toBe(50);
    expect(result['stat_data.世界.年']).toBe(1024);
  });
});

// ========== 边界与特殊场景 ==========

describe('edge cases', () => {
  it('stat_data.主角.xxx with no dot suffix for 主角 goes to exact match', () => {
    // 'stat_data.主角' is exact → char.player
    expect(flatToEngine('stat_data.主角')).toBe('char.player');
    expect(engineToFlat('char.player')).toBe('stat_data.主角');
  });

  it('stat_data with no further segments maps to sys via generic prefix', () => {
    // 'stat_data' → startsWith('stat_data.')? No, no dot.
    // So it falls through all checks and is returned as-is.
    expect(flatToEngine('stat_data')).toBe('stat_data');
  });

  it('custom keys under stat_data.世界 are correctly nested', () => {
    const flat = {
      'stat_data.世界.天气': '晴朗',
      'stat_data.世界.温度': 28,
    };
    const result = normalizeVariables(flat);
    expect(result.sys.world.天气).toBe('晴朗');
    expect(result.sys.world.温度).toBe(28);
  });

  it('multiple levels of nesting survive round-trip', () => {
    // path like sys.world.region.name → stat_data.世界.region.name
    const enginePath = 'sys.world.region.name';
    const flatPath = engineToFlat(enginePath);
    expect(flatPath).toBe('stat_data.世界.region.name');
    // Reverse
    expect(flatToEngine(flatPath)).toBe(enginePath);
  });

  it('null and false values are preserved', () => {
    const flat = {
      'stat_data.主角.HP': null,
      'stat_data.事件.已完成事件': false,
    };
    const normalized = normalizeVariables(flat);
    expect(normalized.char.player.hp).toBeNull();
    expect(normalized.sys.events.completed).toBe(false);

    const roundTripped = denormalizeVariables(normalized);
    expect(roundTripped['stat_data.主角.HP']).toBeNull();
    expect(roundTripped['stat_data.事件.已完成事件']).toBe(false);
  });

  it('number 0 is preserved (not falsy-treated)', () => {
    const flat = { 'stat_data.主角.HP': 0 };
    const normalized = normalizeVariables(flat);
    expect(normalized.char.player.hp).toBe(0);
    const roundTripped = denormalizeVariables(normalized);
    expect(roundTripped['stat_data.主角.HP']).toBe(0);
  });
});
