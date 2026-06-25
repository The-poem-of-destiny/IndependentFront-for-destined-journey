/**
 * context-visibility 测试 (Phase 8)
 */

import { describe, it, expect } from 'vitest';
import {
  VISIBILITY_MATRIX,
  ZONE_IDS,
  getAgentZoneVisibility,
  buildZoneContext,
  filterZoneContent,
  buildZoneSection,
} from './context-visibility';
import type {
  AgentContext, CharacterState, MemoryRecord, PlotEvent,
  ZoneId, VisibilityLevel, VariableZone,
} from './types';

// ========== Helpers ==========

function makeCharacter(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'char_001',
    type: 'npc',
    name: '测试角色',
    race: '人类',
    identity: ['冒险者'],
    occupation: ['战士'],
    tier: 2,
    tierName: '中坚',
    level: 5,
    totalExp: 200,
    expToNext: 800,
    attributes: { str: 12, dex: 8, con: 10, int: 7, spi: 5 },
    freeAttrPoints: 0,
    hp: 85, maxHp: 100,
    mp: 40, maxMp: 50,
    sp: 30, maxSp: 50,
    ascension: {
      enabled: false,
      elements: {},
      authority: {},
      law: {},
      deityPosition: '',
      divineKingdom: { name: '', description: '' },
    },
    equipment: [
      {
        slot: 'weapon', itemId: 'eq_001', name: '铁剑',
        description: '一把朴素但保养良好的铁剑',
        stats: { 攻击力: 15 }, effects: { '锋刃': '攻击时附带轻微出血效果' },
        scripts: { onHit: '$resource.modifyHp(target, -5);' },
      },
    ],
    skills: [
      {
        id: 'sk_001', name: '重击', description: '集中力量进行一次势大力沉的斩击',
        type: 'active', cost: { type: 'SP', amount: 15 }, cooldown: 3,
        effects: { '破甲': '无视目标30%防御力' },
        scripts: { execute: '$dice.roll("2d6"); $resource.modifyHp(target, -dmg);' },
      },
    ],
    inventory: [
      {
        id: 'inv_001', name: '治疗药水', description: '散发草药香气的红色液体',
        quantity: 2, type: 'consumable', rarity: '普通',
        effects: { '治疗': '饮用后恢复少量生命值' },
        scripts: { use: '$resource.modifyHp(owner, 20);' },
      },
    ],
    statusEffects: [
      {
        id: 'se_001', name: '轻微烧伤', description: '左手背被烧红的铁钳烫伤',
        category: '减益', stacks: 1, remainingTime: 15, timeUnit: '分钟',
        source: '锻造事故', effects: {},
        effectDescriptions: { '灼痛': '每10分钟受到1点伤害' },
        scripts: { tick: '$resource.modifyHp(owner, -1);' },
        onApply: 'init',
        onTick: 'tick',
        onRemove: 'cleanup',
      },
    ],
    money: 50,
    location: '白曜城-铁匠铺',
    adventurerRank: 'D',
    currentAction: '正在锻造',
    customFields: {
      appearance: '身材结实的年轻男子',
      background: '在边境锻造坊长大',
      personality: '内向但心地善良',
      relationships: {
        npc_002: { name: '老铁匠', status: '友好', affinity: 45, bond: '师徒' },
      },
    },
    ...overrides,
  };
}

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'MEM0001',
    content: '主角首次抵达白曜城，通过城门守卫登记了冒险者身份。',
    hiddenLine: '暗线: 守卫注意到了主角的异样配剑',
    keywords: ['白曜城', '冒险者公会', '城门'],
    importance: 7,
    timeRange: { start: '光辉纪元001年-05月-20日', end: '光辉纪元001年-05月-20日' },
    relatedCharacterIds: ['player'],
    embedding: [],
    realTimestamp: Date.now(),
    ...overrides,
  };
}

function makePlotEvent(overrides: Partial<PlotEvent> = {}): PlotEvent {
  return {
    id: 'evt_001',
    saveId: 'save_001',
    title: '铁匠的请求',
    description: '铁匠向主角提出了收集矿石的委托。',
    status: 'active',
    triggerCondition: "{{location}} 包含 '铁匠铺'",
    childrenIds: [],
    order: 100,
    relatedCharacterIds: ['npc_001'],
    depth: 1,
    worldLineChanged: false,
    ...overrides,
  };
}

function makeAgentContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userInput: '我推开铁匠铺的门',
    history: [],
    lorebookMatches: [],
    worldBooks: [],
    characters: [makeCharacter({ id: 'player', type: 'player', name: '凯恩' })],
    variables: {
      '时间': '光辉纪元001年-05月-24日-16:30',
      '位置': '白曜城-市集',
      '天气': '晴朗',
      '季节': '春季',
    },
    plotEvents: [makePlotEvent()],
    memories: [makeMemory()],
    agentOutputs: new Map(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
// 1. 可见性矩阵完整性
// ═══════════════════════════════════════════════════════════

describe('Visibility Matrix', () => {
  it('covers all registered agents', () => {
    const registered = [
      'memory_recall', 'plot_pre_check', 'story', 'vars_update',
      'char_update', 'memory_summary', 'plot_post_check', 'plot_outline',
      'craft_gen', 'char_gen', 'item_gen',
      'plot_check', 'plot_correct', // v3 stubs
    ];
    for (const id of registered) {
      expect(VISIBILITY_MATRIX[id]).toBeDefined();
    }
  });

  it('each agent has exactly 8 zone keys', () => {
    for (const [agentId, matrix] of Object.entries(VISIBILITY_MATRIX)) {
      const keys = Object.keys(matrix);
      expect(keys).toHaveLength(8);
      for (const zid of ZONE_IDS) {
        expect(keys).toContain(zid);
      }
    }
  });

  it('all visibility values are valid', () => {
    const validLevels: VisibilityLevel[] = ['FULL', 'NARRATIVE', 'SUMMARY', 'KEYS', 'NONE'];
    for (const matrix of Object.values(VISIBILITY_MATRIX)) {
      for (const level of Object.values(matrix)) {
        expect(validLevels).toContain(level);
      }
    }
  });
});

describe('getAgentZoneVisibility', () => {
  it('returns correct matrix for known agent', () => {
    const result = getAgentZoneVisibility('story');
    expect(result.npc).toBe('NARRATIVE');
    expect(result.outline).toBe('SUMMARY');
    expect(result.variable).toBe('NONE');
  });

  it('returns DEFAULT_VISIBILITY for unknown agent', () => {
    const result = getAgentZoneVisibility('nonexistent_agent');
    for (const level of Object.values(result)) {
      expect(level).toBe('NONE');
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 3. buildZoneContext
// ═══════════════════════════════════════════════════════════

describe('buildZoneContext', () => {
  it('creates all 8 zones', () => {
    const ctx = makeAgentContext();
    const zones = buildZoneContext(ctx);
    for (const zid of ZONE_IDS) {
      expect(zones[zid]).toBeDefined();
    }
  });

  it('memory zone contains entries with all required fields', () => {
    const ctx = makeAgentContext({ memories: [makeMemory()] });
    const zones = buildZoneContext(ctx);
    const entries = zones.memory.content.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('MEM0001');
    expect(entries[0].content).toContain('白曜城');
    expect(entries[0].hiddenLine).toContain('暗线');
    expect(entries[0].keywords).toContain('白曜城');
    expect(entries[0].importance).toBe(7);
  });

  it('npc zone contains all characters', () => {
    const ctx = makeAgentContext({
      characters: [
        makeCharacter({ id: 'p1', type: 'player', name: '凯恩' }),
        makeCharacter({ id: 'n1', type: 'npc', name: '老铁匠' }),
      ],
    });
    const zones = buildZoneContext(ctx);
    expect(zones.npc.content.characters).toHaveLength(2);
  });

  it('world zone extracts world-state keys', () => {
    const ctx = makeAgentContext({
      variables: { '时间': '下午', '位置': '铁匠铺', '天气': '晴', 'user_count': 5 },
    });
    const zones = buildZoneContext(ctx);
    expect(zones.world.content['时间']).toBe('下午');
    expect(zones.world.content['位置']).toBe('铁匠铺');
    expect(zones.world.content['天气']).toBe('晴');
    // user_count is not a world key → goes to variable zone
    expect(zones.world.content['user_count']).toBeUndefined();
  });

  it('quest zone contains plot events with status', () => {
    const ctx = makeAgentContext({
      plotEvents: [makePlotEvent({ id: 'evt_001', status: 'active' })],
    });
    const zones = buildZoneContext(ctx);
    expect(zones.quest.content.events).toHaveLength(1);
    expect(zones.quest.content.events[0].status).toBe('active');
  });

  it('variable zone partitions user/sys namespaces', () => {
    const ctx = makeAgentContext({
      variables: { 'sys.reputation': 50, 'user.flag_tutorial': true, 'other': 42 },
    });
    const zones = buildZoneContext(ctx);
    expect(zones.variable.content.sys).toHaveProperty('sys.reputation', 50);
    expect(zones.variable.content.user).toHaveProperty('user.flag_tutorial', true);
    // non-world, non-prefixed → user bucket
    expect(zones.variable.content.user).toHaveProperty('other', 42);
  });
});

// ═══════════════════════════════════════════════════════════
// 4-7. filterZoneContent — 所有可见性级别
// ═══════════════════════════════════════════════════════════

describe('filterZoneContent — NONE', () => {
  it('returns null for NONE visibility', () => {
    const result = filterZoneContent('memory', { entries: [] }, 'NONE', 'test');
    expect(result).toBeNull();
  });
});

describe('filterZoneContent — FULL', () => {
  it('returns non-null string with content', () => {
    const result = filterZoneContent('world', { time: '16:30' }, 'FULL', 'test');
    expect(result).not.toBeNull();
    expect(result).toContain('16:30');
  });
});

describe('filterZoneContent — SUMMARY', () => {
  it('memory SUMMARY strips hiddenLine', () => {
    const content = {
      entries: [{
        id: 'MEM0001', content: '测试正文内容', hiddenLine: '暗线内容',
        keywords: ['测试'], importance: 5, timeRange: { start: '001-01-01', end: '001-01-01' },
      }],
    };
    const result = filterZoneContent('memory', content, 'SUMMARY', 'test');
    expect(result).not.toBeNull();
    expect(result).toContain('测试正文内容');
    expect(result).not.toContain('暗线内容');
  });

  it('quest SUMMARY only shows active events', () => {
    const content = {
      events: [
        { id: 'evt_001', title: '活跃任务', status: 'active', description: '进行中' },
        { id: 'evt_002', title: '待触发任务', status: 'pending', description: '等待中' },
      ],
    };
    const result = filterZoneContent('quest', content, 'SUMMARY', 'test');
    expect(result).not.toBeNull();
    expect(result).toContain('活跃任务');
    expect(result).not.toContain('待触发任务');
  });

  it('outline SUMMARY only shows current chapter', () => {
    const content = {
      chapters: [
        { title: '第一章', summary: '抵达白曜城', status: 'completed' },
        { title: '第二章', summary: '深入矿场', status: 'active' },
      ],
    };
    const result = filterZoneContent('outline', content, 'SUMMARY', 'test');
    expect(result).not.toBeNull();
    expect(result).toContain('第二章'); // active chapter
    expect(result).not.toContain('第一章'); // completed
  });

  it('npc SUMMARY only shows HP/MP/SP/location/action/status', () => {
    const char1 = makeCharacter({ id: 'p1', type: 'player', name: '凯恩' });
    const content = { characters: [char1] };
    const result = filterZoneContent('npc', content, 'SUMMARY', 'test');
    expect(result).not.toBeNull();
    // Should contain basic status
    expect(result).toContain('HP: 85/100');
    expect(result).toContain('[你]'); // player type → [你]
    // Should NOT contain attributes numeric detail
    expect(result).not.toContain('力量12');
    // Should NOT contain equipment details
    expect(result).not.toContain('attack');
  });
});

describe('filterZoneContent — KEYS', () => {
  it('memory KEYS only shows id + importance + keywords', () => {
    const content = {
      entries: [{
        id: 'MEM0001', content: '不应该出现正文', hiddenLine: '不应该出现暗线',
        keywords: ['测试'], importance: 7,
      }],
    };
    const result = filterZoneContent('memory', content, 'KEYS', 'test');
    expect(result).not.toBeNull();
    expect(result).toContain('MEM0001');
    expect(result).toContain('重要度:7');
    expect(result).not.toContain('不应该出现正文');
    expect(result).not.toContain('不应该出现暗线');
  });

  it('npc KEYS only shows id/name/race/type/tier', () => {
    const char1 = makeCharacter({ id: 'p1', type: 'player', name: '凯恩' });
    const char2 = makeCharacter({ id: 'n1', type: 'npc', name: '老铁匠' });
    const content = { characters: [char1, char2] };
    const result = filterZoneContent('npc', content, 'KEYS', 'test');
    expect(result).not.toBeNull();
    expect(result).toContain('凯恩');
    expect(result).toContain('老铁匠');
    expect(result).toContain('T2');
    // Should NOT contain attributes
    expect(result).not.toContain('力量12');
    // Should NOT contain equipment
    expect(result).not.toContain('铁剑');
    // Should NOT contain scripts
    expect(result).not.toContain('$resource');
  });
});

// ═══════════════════════════════════════════════════════════
// 8. filterZoneContent — NARRATIVE
// ═══════════════════════════════════════════════════════════

describe('filterZoneContent — NARRATIVE', () => {
  const ctx = makeAgentContext();

  it('strips equipment stats but keeps effects', () => {
    const char = makeCharacter();
    const content = { characters: [char] };
    const result = filterZoneContent('npc', content, 'NARRATIVE', 'story', ctx);
    expect(result).not.toBeNull();
    // Effects description should be kept
    expect(result).toContain('锋刃');
    // Stats numeric should be stripped (equipment.stats 不渲染)
    expect(result).not.toContain('+15攻击');
    // Scripts should be stripped
    expect(result).not.toContain('$resource');
  });

  it('strips skill cost/cooldown but keeps effects', () => {
    const char = makeCharacter();
    const content = { characters: [char] };
    const result = filterZoneContent('npc', content, 'NARRATIVE', 'story', ctx);
    expect(result).not.toBeNull();
    // Skill name and description should be kept
    expect(result).toContain('重击');
    expect(result).toContain('势大力沉');
    // Effects should be kept
    expect(result).toContain('破甲');
    // Cost/cooldown should be stripped (resource line has SP, so check for cost-related patterns)
    expect(result).not.toContain('SP消耗');
    expect(result).not.toContain('冷却');
    // Scripts should be stripped
    expect(result).not.toContain('$dice');
  });

  it('strips inventory stats but keeps effects and description', () => {
    const content = { characters: [makeCharacter()] };
    const result = filterZoneContent('npc', content, 'NARRATIVE', 'story', ctx);
    expect(result).not.toBeNull();
    expect(result).toContain('治疗药水');
    expect(result).toContain('散发草药香气');
    expect(result).toContain('治疗');
    // Scripts should be stripped
    expect(result).not.toContain('$resource.modifyHp(owner');
  });

  it('strips statusEffect scripts/onApply/onTick/onRemove but keeps effectDescriptions', () => {
    const content = { characters: [makeCharacter()] };
    const result = filterZoneContent('npc', content, 'NARRATIVE', 'story', ctx);
    expect(result).not.toBeNull();
    expect(result).toContain('轻微烧伤');
    expect(result).toContain('灼痛');
    // Scripts and hooks should be stripped
    expect(result).not.toContain('onApply');
    expect(result).not.toContain('onTick');
    expect(result).not.toContain('onRemove');
    expect(result).not.toContain('$resource.modifyHp(owner, -1)');
  });

  it('ascension shows only enabled state and category names', () => {
    const char = makeCharacter({
      ascension: {
        enabled: true,
        elements: { '炎之要素': {} as any },
        authority: { '锻冶权能': {} as any },
        law: {},
        deityPosition: '',
        divineKingdom: { name: '', description: '' },
      },
    });
    const content = { characters: [char] };
    const result = filterZoneContent('npc', content, 'NARRATIVE', 'story', ctx);
    expect(result).not.toBeNull();
    expect(result).toContain('登神长阶');
    expect(result).toContain('炎之要素');
    expect(result).toContain('锻冶权能');
    // Internal details should be stripped
    expect(result).not.toContain('elements');
    expect(result).not.toContain('authority');
  });

  it('reads appearance/background/personality from customFields', () => {
    const content = { characters: [makeCharacter()] };
    const result = filterZoneContent('npc', content, 'NARRATIVE', 'story', ctx);
    expect(result).not.toBeNull();
    expect(result).toContain('身材结实的年轻男子'); // appearance
    expect(result).toContain('在边境锻造坊长大'); // background
    expect(result).toContain('内向但心地善良'); // personality
  });

  it('includes relationships with affinity values', () => {
    const content = { characters: [makeCharacter()] };
    const result = filterZoneContent('npc', content, 'NARRATIVE', 'story', ctx);
    expect(result).not.toBeNull();
    expect(result).toContain('老铁匠');
    expect(result).toContain('友好');
    expect(result).toContain('师徒');
  });

  it('adds warning note about stripped numeric stats', () => {
    const content = { characters: [makeCharacter()] };
    const result = filterZoneContent('npc', content, 'NARRATIVE', 'story', ctx);
    expect(result).not.toBeNull();
    expect(result).toContain('自然语言描述'); // warning note
  });
});

// ═══════════════════════════════════════════════════════════
// 9. buildZoneSection — 向后兼容
// ═══════════════════════════════════════════════════════════

describe('buildZoneSection backward compatibility', () => {
  it('returns empty string when ctx.zones is undefined', () => {
    const ctx = makeAgentContext();
    ctx.zones = undefined;
    const result = buildZoneSection('story', ctx);
    expect(result).toBe('');
  });

  it('returns non-empty string when ctx.zones is populated', () => {
    const ctx = makeAgentContext();
    ctx.zones = buildZoneContext(ctx);
    const result = buildZoneSection('story', ctx);
    expect(result).not.toBe('');
    // Story agent sees NARRATIVE npc
    expect(result).toContain('凯恩');
  });

  it('respects visibility levels — story does not see variable zone', () => {
    const ctx = makeAgentContext({
      variables: { 'user.flag': true, '时间': '16:30', '位置': '铁匠铺' },
    });
    ctx.zones = buildZoneContext(ctx);
    const result = buildZoneSection('story', ctx);
    // Story has variable: NONE, should not appear
    expect(result).not.toContain('user.flag');
    // But world state should appear (FULL)
    expect(result).toContain('16:30');
  });

  it('respects visibility levels — char_gen only sees npc KEYS', () => {
    const ctx = makeAgentContext();
    ctx.zones = buildZoneContext(ctx);
    const result = buildZoneSection('char_gen', ctx);
    // Should show name/race/type
    expect(result).toContain('凯恩');
    // Should NOT show equipment scripts
    expect(result).not.toContain('$resource');
  });
});

// ═══════════════════════════════════════════════════════════
// 10. char_update per-call filtering
// ═══════════════════════════════════════════════════════════

describe('char_update per-call filtering', () => {
  it('target character gets FULL format, others get KEYS', () => {
    const ctx = makeAgentContext({
      characters: [
        makeCharacter({ id: 'player', type: 'player', name: '凯恩' }),
        makeCharacter({ id: 'npc_001', type: 'npc', name: '老铁匠' }),
      ],
      targetCharacterId: 'player',
    });
    ctx.zones = buildZoneContext(ctx);
    const result = buildZoneSection('char_update', ctx);

    // Target (player) gets FULL — should see attributes
    expect(result).toContain('目标角色: player');
    // Others (npc_001) should appear as KEYS only
    expect(result).toContain('老铁匠');
  });

  it('without targetCharacterId, all characters go through normal filter', () => {
    const ctx = makeAgentContext({
      characters: [
        makeCharacter({ id: 'player', type: 'player', name: '凯恩' }),
        makeCharacter({ id: 'npc_001', type: 'npc', name: '老铁匠' }),
      ],
    });
    ctx.zones = buildZoneContext(ctx);
    const result = buildZoneSection('char_update', ctx);
    // All characters should be present
    expect(result).toContain('凯恩');
    expect(result).toContain('老铁匠');
  });
});

// ═══════════════════════════════════════════════════════════
// 11. Integration — story Agent NARRATIVE output
// ═══════════════════════════════════════════════════════════

describe('Integration: story Agent NARRATIVE output', () => {
  it('produces narrative-formatted character data without scripts or numeric stats', () => {
    const ctx = makeAgentContext({
      characters: [
        makeCharacter({
          id: 'player', type: 'player', name: '凯恩',
          equipment: [{
            slot: 'weapon', itemId: 'eq_001', name: '精铁长剑',
            description: '剑刃闪烁着冷冽的寒光',
            stats: { 攻击力: 25, 暴击率: 5 },
            effects: { '锋刃': '攻击时附带轻微出血' },
            scripts: { onCrit: '$resource.modifyHp(target, -30);' },
          }],
        }),
      ],
    });
    ctx.zones = buildZoneContext(ctx);
    const result = buildZoneSection('story', ctx);

    // Basic character info
    expect(result).toContain('凯恩');
    expect(result).toContain('人类');
    expect(result).toContain('T2');

    // Equipment flavor text — YES
    expect(result).toContain('精铁长剑');
    expect(result).toContain('剑刃闪烁着冷冽的寒光');
    expect(result).toContain('锋刃');

    // Equipment numeric stats — NO (stats 字典不渲染)
    expect(result).not.toContain('+15攻击');
    // Effects description value may contain '攻击' in narrative context but not as a stat
    expect(result).not.toContain('stats');

    // Scripts — NO
    expect(result).not.toContain('$resource');
    expect(result).not.toContain('onCrit');

    // Warning note
    expect(result).toContain('自然语言描述');
  });
});
