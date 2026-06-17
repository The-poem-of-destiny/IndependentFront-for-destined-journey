/**
 * char-query.ts — 角色查询系统测试
 *
 * 覆盖所有导出函数：getChar / getChars / getCharsByType / getPlayer / getNpcs /
 * getMonsters / findByName / filterByLocation / filterByTier / filterByRank /
 * getPresentCharacters / summarizeChar / summarizeChars / comparePower /
 * isStrongerThan / getIdentities / getOccupations / hasIdentity / hasAscension /
 * getElements / getAuthorities / getLaws / $char namespace
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDefaultCharacterState } from './types';
import type { CharacterState } from './types';

// ---- Mocks ----
const mockGetCharacter = vi.fn();
const mockGetCharacters = vi.fn();
const mockGetCharactersByType = vi.fn();

vi.mock('./database', () => ({
  getCharacter: (...args: any[]) => mockGetCharacter(...args),
  getCharacters: (...args: any[]) => mockGetCharacters(...args),
  getCharactersByType: (...args: any[]) => mockGetCharactersByType(...args),
}));

import {
  getChar,
  getChars,
  getCharsByType,
  getPlayer,
  getNpcs,
  getMonsters,
  findByName,
  filterByLocation,
  filterByTier,
  filterByRank,
  getPresentCharacters,
  summarizeChar,
  summarizeChars,
  comparePower,
  isStrongerThan,
  getIdentities,
  getOccupations,
  hasIdentity,
  hasAscension,
  getElements,
  getAuthorities,
  getLaws,
  $char,
} from './char-query';

// ---- Helpers ----
function makeChar(overrides: Partial<CharacterState> = {}): CharacterState {
  return createDefaultCharacterState({
    id: `char_${Math.random().toString(36).slice(2, 8)}`,
    name: '测试角色',
    type: 'npc',
    location: '王都·中心广场',
    level: 5,
    tier: 2,
    tierName: '中坚',
    hp: 200,
    maxHp: 200,
    identity: ['冒险者', '剑士'],
    occupation: ['战士'],
    ascension: { enabled: false, elements: {}, authority: {}, law: {}, deityPosition: '', divineKingdom: { name: '', description: '' } },
    ...overrides,
  });
}

function makePlayer(overrides: Partial<CharacterState> = {}): CharacterState {
  return makeChar({ id: 'player_1', type: 'player', name: '主角', level: 10, tier: 3, tierName: '精英', hp: 500, maxHp: 500, ...overrides });
}

// ---- Async query tests ----

describe('getChar', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('找到角色时返回 CharacterState', async () => {
    const c = makeChar();
    mockGetCharacter.mockResolvedValue(c);
    await expect(getChar(c.id)).resolves.toBe(c);
    expect(mockGetCharacter).toHaveBeenCalledWith(c.id);
  });

  it('未找到角色时返回 undefined', async () => {
    mockGetCharacter.mockResolvedValue(undefined);
    await expect(getChar('nonexistent')).resolves.toBeUndefined();
  });
});

describe('getChars', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('不传 saveId 时返回全部角色', async () => {
    const chars = [makeChar(), makeChar()];
    mockGetCharacters.mockResolvedValue(chars);
    await expect(getChars()).resolves.toBe(chars);
    expect(mockGetCharacters).toHaveBeenCalledWith(undefined);
  });

  it('传入 saveId 时透传', async () => {
    const chars = [makeChar()];
    mockGetCharacters.mockResolvedValue(chars);
    await expect(getChars('save_1')).resolves.toBe(chars);
    expect(mockGetCharacters).toHaveBeenCalledWith('save_1');
  });
});

describe('getCharsByType', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('按 npc 类型过滤', async () => {
    const npcs = [makeChar({ type: 'npc' }), makeChar({ type: 'npc' })];
    mockGetCharactersByType.mockResolvedValue(npcs);
    await expect(getCharsByType('npc')).resolves.toBe(npcs);
    expect(mockGetCharactersByType).toHaveBeenCalledWith('npc');
  });

  it('按 monster 类型过滤', async () => {
    const monsters = [makeChar({ type: 'monster' })];
    mockGetCharactersByType.mockResolvedValue(monsters);
    await expect(getCharsByType('monster')).resolves.toBe(monsters);
    expect(mockGetCharactersByType).toHaveBeenCalledWith('monster');
  });
});

describe('getPlayer', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('存在玩家角色时返回', async () => {
    const player = makePlayer();
    const npc = makeChar({ type: 'npc' });
    mockGetCharacters.mockResolvedValue([npc, player]);
    await expect(getPlayer('save_1')).resolves.toBe(player);
  });

  it('不存在玩家时返回 undefined', async () => {
    const npcs = [makeChar({ type: 'npc' }), makeChar({ type: 'npc' })];
    mockGetCharacters.mockResolvedValue(npcs);
    await expect(getPlayer()).resolves.toBeUndefined();
  });
});

describe('getNpcs', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('返回所有 NPC', async () => {
    const npcs = [makeChar({ type: 'npc' }), makeChar({ type: 'npc' })];
    mockGetCharactersByType.mockResolvedValue(npcs);
    await expect(getNpcs()).resolves.toBe(npcs);
    expect(mockGetCharactersByType).toHaveBeenCalledWith('npc');
  });
});

describe('getMonsters', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('返回所有怪物', async () => {
    const monsters = [makeChar({ type: 'monster' }), makeChar({ type: 'monster' })];
    mockGetCharactersByType.mockResolvedValue(monsters);
    await expect(getMonsters()).resolves.toBe(monsters);
    expect(mockGetCharactersByType).toHaveBeenCalledWith('monster');
  });
});

// ---- Pure function tests ----

describe('findByName', () => {
  it('找到匹配名称的角色', () => {
    const chars = [makeChar({ name: '艾丽西亚' }), makeChar({ name: '贝尔' })];
    expect(findByName(chars, '艾丽西亚')).toBe(chars[0]);
  });

  it('未找到时返回 undefined', () => {
    const chars = [makeChar({ name: '艾丽西亚' })];
    expect(findByName(chars, '不存在')).toBeUndefined();
  });
});

describe('filterByLocation', () => {
  it('返回匹配位置的角色', () => {
    const a = makeChar({ location: '酒馆' });
    const b = makeChar({ location: '广场' });
    const c = makeChar({ location: '酒馆' });
    expect(filterByLocation([a, b, c], '酒馆')).toEqual([a, c]);
  });

  it('无匹配时返回空数组', () => {
    const chars = [makeChar({ location: '酒馆' })];
    expect(filterByLocation(chars, '广场')).toEqual([]);
  });
});

describe('filterByTier', () => {
  it('返回匹配层级的角色', () => {
    const a = makeChar({ tier: 1, tierName: '普通' });
    const b = makeChar({ tier: 2, tierName: '中坚' });
    const c = makeChar({ tier: 1, tierName: '普通' });
    expect(filterByTier([a, b, c], 1)).toEqual([a, c]);
  });

  it('无匹配时返回空数组', () => {
    const chars = [makeChar({ tier: 1 })];
    expect(filterByTier(chars, 7)).toEqual([]);
  });
});

describe('filterByRank', () => {
  it('返回匹配冒险者等级的角色', () => {
    const a = makeChar({ adventurerRank: 'B' });
    const b = makeChar({ adventurerRank: 'S' });
    const c = makeChar({ adventurerRank: 'B' });
    expect(filterByRank([a, b, c], 'B')).toEqual([a, c]);
  });

  it('无匹配时返回空数组', () => {
    const chars = [makeChar({ adventurerRank: 'D' })];
    expect(filterByRank(chars, 'S')).toEqual([]);
  });
});

describe('getPresentCharacters', () => {
  const reference = makePlayer({ location: '地下城·第一层' });

  it('包含同位置的其它角色', () => {
    const ally = makeChar({ location: '地下城·第一层' });
    const chars = [reference, ally, makeChar({ location: '酒馆' })];
    expect(getPresentCharacters(chars, reference)).toEqual([ally]);
  });

  it('排除自己', () => {
    const sameName = makeChar({ id: reference.id, location: '地下城·第一层', type: 'player' });
    const chars = [reference, sameName];
    const result = getPresentCharacters(chars, reference);
    // 两者 id 相同，都会被排除（只排除 reference.id）
    expect(result.find(c => c.id === reference.id)).toBeUndefined();
  });

  it('不同位置的角色不计入', () => {
    const other = makeChar({ location: '酒馆' });
    const chars = [reference, other];
    expect(getPresentCharacters(chars, reference)).toEqual([]);
  });
});

// ---- Summarize tests ----

describe('summarizeChar', () => {
  it('包含类型/名称', () => {
    const c = makeChar({ type: 'npc', name: '守卫队长' });
    expect(summarizeChar(c)).toContain('[npc:守卫队长]');
  });

  it('包含 HP 信息', () => {
    const c = makeChar({ hp: 150, maxHp: 200 });
    expect(summarizeChar(c)).toContain('HP:150/200');
  });

  it('包含位置信息', () => {
    const c = makeChar({ location: '王都·中心广场' });
    expect(summarizeChar(c)).toContain('位置:王都·中心广场');
  });

  it('包含等级和层级名', () => {
    const c = makeChar({ level: 5, tierName: '中坚' });
    expect(summarizeChar(c)).toContain('Lv.5');
    expect(summarizeChar(c)).toContain('中坚');
  });
});

describe('summarizeChars', () => {
  it('多个角色用换行符分隔', () => {
    const a = makeChar({ name: '角色A' });
    const b = makeChar({ name: '角色B' });
    const result = summarizeChars([a, b]);
    expect(result).toContain('角色A');
    expect(result).toContain('角色B');
    expect(result).toContain('\n');
  });
});

// ---- Comparison tests ----

describe('comparePower', () => {
  it('更高等级/层级的角色战力更高', () => {
    const low = makeChar({ level: 1, tier: 1, attributes: { str: 10, dex: 10, con: 10, int: 10, spi: 10 } });
    const high = makeChar({ level: 10, tier: 3, attributes: { str: 20, dex: 20, con: 20, int: 20, spi: 20 } });
    expect(comparePower(high, low)).toBeGreaterThan(0);
    expect(comparePower(low, high)).toBeLessThan(0);
  });

  it('相同属性时返回 0', () => {
    const attr = { str: 15, dex: 15, con: 15, int: 15, spi: 15 };
    const a = makeChar({ level: 5, tier: 2, attributes: attr });
    const b = makeChar({ level: 5, tier: 2, attributes: attr });
    expect(comparePower(a, b)).toBe(0);
  });
});

describe('isStrongerThan', () => {
  it('战力差 >20 时返回 true', () => {
    const weak = makeChar({ level: 1, tier: 1, attributes: { str: 10, dex: 10, con: 10, int: 10, spi: 10 } });
    const strong = makeChar({ level: 10, tier: 3, attributes: { str: 25, dex: 25, con: 25, int: 25, spi: 25 } });
    expect(isStrongerThan(strong, weak)).toBe(true);
  });

  it('战力差 <=20 时返回 false', () => {
    const a = makeChar({ level: 5, tier: 2, attributes: { str: 15, dex: 15, con: 15, int: 15, spi: 15 } });
    const b = makeChar({ level: 5, tier: 2, attributes: { str: 16, dex: 15, con: 15, int: 15, spi: 15 } });
    // difference = (5*10+2*50+75) - (5*10+2*50+76) = -1
    expect(isStrongerThan(a, b)).toBe(false);
  });
});

// ---- Identity / occupation tests ----

describe('getIdentities', () => {
  it('返回身份标签数组', () => {
    const c = makeChar({ identity: ['冒险者', '剑圣'] });
    expect(getIdentities(c)).toEqual(['冒险者', '剑圣']);
  });

  it('无身份时返回空数组', () => {
    const c = makeChar({ identity: [] });
    expect(getIdentities(c)).toEqual([]);
  });
});

describe('getOccupations', () => {
  it('返回职业标签数组', () => {
    const c = makeChar({ occupation: ['战士', '铁匠'] });
    expect(getOccupations(c)).toEqual(['战士', '铁匠']);
  });
});

describe('hasIdentity', () => {
  it('拥有该身份时返回 true', () => {
    const c = makeChar({ identity: ['冒险者', '剑圣'] });
    expect(hasIdentity(c, '剑圣')).toBe(true);
  });

  it('不拥有该身份时返回 false', () => {
    const c = makeChar({ identity: ['冒险者'] });
    expect(hasIdentity(c, '商人')).toBe(false);
  });
});

// ---- Ascension tests ----

describe('hasAscension', () => {
  it('登神长阶启用时返回 true', () => {
    const c = makeChar({
      ascension: { enabled: true, elements: { fire: { name: '火', description: '火焰要素', effects: [] } }, authority: {}, law: {}, deityPosition: '', divineKingdom: { name: '', description: '' } },
    });
    expect(hasAscension(c)).toBe(true);
  });

  it('登神长阶未启用时返回 false', () => {
    const c = makeChar();
    expect(hasAscension(c)).toBe(false);
  });
});

describe('getElements', () => {
  it('返回要素列表', () => {
    const c = makeChar({
      ascension: {
        enabled: true,
        elements: { fire: { name: '火', description: '炎之要素', effects: [] }, water: { name: '水', description: '水之要素', effects: [] } },
        authority: {},
        law: {},
        deityPosition: '',
        divineKingdom: { name: '', description: '' },
      },
    });
    expect(getElements(c)).toEqual(['fire', 'water']);
  });

  it('无要素时返回空数组', () => {
    const c = makeChar();
    expect(getElements(c)).toEqual([]);
  });
});

describe('getAuthorities', () => {
  it('返回权能列表', () => {
    const c = makeChar({
      ascension: {
        enabled: true,
        elements: {},
        authority: { combat: { name: '战斗', description: '战斗权能', effects: [], costDescription: '消耗SP' } },
        law: {},
        deityPosition: '',
        divineKingdom: { name: '', description: '' },
      },
    });
    expect(getAuthorities(c)).toEqual(['combat']);
  });
});

describe('getLaws', () => {
  it('返回法则列表', () => {
    const c = makeChar({
      ascension: {
        enabled: true,
        elements: {},
        authority: {},
        law: { gravity: { name: '重力', description: '重力法则', effects: [], costDescription: '消耗MP+SP' } },
        deityPosition: '',
        divineKingdom: { name: '', description: '' },
      },
    });
    expect(getLaws(c)).toEqual(['gravity']);
  });
});

// ---- $char namespace ----

describe('$char namespace', () => {
  it('包含所有导出方法', () => {
    expect($char).toBeDefined();
    expect(typeof $char.getChar).toBe('function');
    expect(typeof $char.getChars).toBe('function');
    expect(typeof $char.getCharsByType).toBe('function');
    expect(typeof $char.getPlayer).toBe('function');
    expect(typeof $char.getNpcs).toBe('function');
    expect(typeof $char.getMonsters).toBe('function');
    expect(typeof $char.findByName).toBe('function');
    expect(typeof $char.filterByLocation).toBe('function');
    expect(typeof $char.filterByTier).toBe('function');
    expect(typeof $char.filterByRank).toBe('function');
    expect(typeof $char.getPresentCharacters).toBe('function');
    expect(typeof $char.summarizeChar).toBe('function');
    expect(typeof $char.summarizeChars).toBe('function');
    expect(typeof $char.comparePower).toBe('function');
    expect(typeof $char.isStrongerThan).toBe('function');
    expect(typeof $char.getIdentities).toBe('function');
    expect(typeof $char.getOccupations).toBe('function');
    expect(typeof $char.hasIdentity).toBe('function');
    expect(typeof $char.hasAscension).toBe('function');
    expect(typeof $char.getElements).toBe('function');
    expect(typeof $char.getAuthorities).toBe('function');
    expect(typeof $char.getLaws).toBe('function');
  });

  it('$char.getChar 与顶层 getChar 是同一个函数', () => {
    expect($char.getChar).toBe(getChar);
  });

  it('$char.findByName 可以正常调用', () => {
    const chars = [makeChar({ name: '尤莉' })];
    expect($char.findByName(chars, '尤莉')?.name).toBe('尤莉');
  });
});
