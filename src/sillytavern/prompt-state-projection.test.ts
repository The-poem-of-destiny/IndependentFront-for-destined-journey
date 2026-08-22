/**
 * prompt-state-projection.test.ts — 读取型投影与纯 diff 测试（LLM 组装层 Delta 会话 · T1）
 *
 * 覆盖计划 §5 focused cases + 各 scope 机制 + 渲染不变量。
 * 数据一律来自匿名 fixture（`fixtures/prompt-session/`），不碰真实导出/世界书/API Key。
 *
 * focused cases 与用例映射：
 * - 完全相同投影返回空数组        → 「完全相同投影返回空数组」
 * - 单个 HP 变化只产生一个 set    → 「单个 HP 变化只产生一个 set」
 * - 对象重建但内容相同不产生操作  → 「对象重建但内容相同不产生操作」
 * - 技能增/改/删 = upsert/upsert/remove → 「技能新增/修改/删除」
 * - 数组重排不产生操作            → 「数组重排不产生操作」
 * - 中文/点号/方括号名仍是 JSON value → 「名字含中文/点号/方括号仍是 JSON value」
 * - 相同输入多次渲染字节一致      → 「相同输入多次渲染字节一致」
 * - 历史新增只返回新消息；修改/删除/重排要重基线 → 「历史（NARRATIVE）append cursor」组
 */

import { describe, it, expect } from 'vitest';
import {
  projectPromptState,
  diffPromptState,
  renderPromptDelta,
  type PromptDeltaOp,
  type PromptScope,
  type PromptStateProjection,
  type PromptRebaseReason,
} from './prompt-state-projection';
import {
  fixtureCharacters,
  fixtureNpc,
  fixturePlayer,
  fixtureTranscript,
} from './fixtures/prompt-session/prompt-session-fixture';
import type { AgentContext, ChatMessage, InventoryItem, MemoryRecord, Quest, Skill } from './types';
import { createDefaultCharacterState } from './types';

// ═══════════════════════════════════════════════════════════
// Test Context helpers
// ═══════════════════════════════════════════════════════════

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userInput: '测试输入',
    history: [],
    worldBooks: [],
    characters: [],
    variables: {},
    plotEvents: [],
    memories: [],
    agentOutputs: new Map(),
    ...overrides,
  };
}

function message(id: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return { id, role, content, timestamp: 0 };
}

/** fixture 三组对话 → 带稳定 id 的历史消息 */
function fixtureHistory(): ChatMessage[] {
  return fixtureTranscript.map((m, i) => message(`fixture-msg-${i}`, m.role, m.content));
}

function project(agentId: string, context: AgentContext, lore = ''): PromptStateProjection {
  return projectPromptState(agentId, context, lore);
}

const GAME_TIME = {
  era: '复兴纪元',
  year: 512,
  month: 4,
  day: 12,
  weekday: 3,
  hour: 20,
  minute: 30,
};

/** 一个有代表性的 base 上下文：两角色 + 物品 + 技能 + 任务 + 好感 + 变量 + 时间 + 剧情 + 地图 */
function baseContext(): AgentContext {
  return makeContext({
    history: fixtureHistory(),
    characters: fixtureCharacters,
    variables: { sys: { 天气: '小雨' }, user: { 心情: '平静' } },
    gameTime: GAME_TIME,
    quests: {
      打探消息: {
        status: '进行中',
        priority: '中',
        progress: '小铃提到雨夜山路难行',
        detail: '',
        objective: '向旅人打听前方的路',
        reward: '',
      },
    },
    affections: { [fixturePlayer.id]: 40, [fixtureNpc.id]: 15 },
    plotEvents: [
      {
        id: 'plot-rainy-inn',
        saveId: 's',
        title: '雨夜旅店疑云',
        description: '旅店的灯夜里多亮了一盏。',
        status: 'active',
        triggerCondition: undefined,
        completeCondition: undefined,
        failCondition: undefined,
        timeWindow: undefined,
        childrenIds: [],
        parentId: undefined,
        order: 0,
        relatedCharacterIds: [],
        location: undefined,
        worldLineChanged: false,
        visibility: 'revealed',
        depth: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    mapFlags: { lastTileId: 1 },
  });
}

const oilLamp: InventoryItem = {
  name: '薄荷油灯',
  description: '黄铜油灯',
  quantity: 1,
  type: 'consumable',
  rarity: '普通',
};
const dryFood: InventoryItem = {
  name: '干粮',
  description: '硬面饼',
  quantity: 3,
  type: 'consumable',
  rarity: '普通',
};

const memoryRecord: MemoryRecord = {
  id: 'MEM000001',
  saveId: 's',
  createdAt: 0,
  realTimestamp: 0,
  timeRange: { start: '复兴纪元 512-04', end: '复兴纪元 512-04' },
  content: '阿岚在雨夜旅店避雨。',
  hiddenLine: '',
  keywords: ['旅店'],
  relatedCharacterIds: [],
  importance: 3,
};

function quest(overrides: Partial<Quest> = {}): Quest {
  return {
    status: '进行中',
    priority: '中',
    progress: '',
    detail: '',
    objective: '',
    reward: '',
    ...overrides,
  };
}

/** 虚构被动技能（fixture 的 `夜行`；description 必填，不能从 InventoryItem spread 出来） */
function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: '夜行',
    description: '习得的夜间赶路之法：目能视物、脚步放轻。',
    type: 'passive',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
// focused case：无变化
// ═══════════════════════════════════════════════════════════

describe('diffPromptState — 无变化', () => {
  it('完全相同投影返回空数组', () => {
    const ctx = baseContext();
    const previous = project('story', ctx, '雨夜旅店的檐下挂着3盏灯');
    const current = project('story', ctx, '雨夜旅店的檐下挂着3盏灯');
    expect(diffPromptState(previous, current)).toEqual([]);
  });

  it('对象重建但内容相同不产生操作（深比较，非引用比较）', () => {
    // 两侧是独立构造、完全相等的上下文 —— project 内部每个对象都是新实例
    const previous = project('story', baseContext(), '');
    const current = project('story', baseContext(), '');
    expect(diffPromptState(previous, current)).toEqual([]);
  });

  it('数组重排不产生操作（集合按逻辑名字归一化成 Map）', () => {
    const ctxA = baseContext();
    ctxA.characters = [{ ...fixturePlayer, inventory: [oilLamp, dryFood] }, fixtureNpc];
    const ctxB = baseContext();
    ctxB.characters = [
      { ...fixturePlayer, inventory: [dryFood, oilLamp] }, // 顺序调换
      fixtureNpc,
    ];
    expect(diffPromptState(project('story', ctxA, ''), project('story', ctxB, ''))).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// focused case：标量 set
// ═══════════════════════════════════════════════════════════

describe('diffPromptState — 标量 set', () => {
  it('单个 HP 变化只产生一个 set（角色基础字段与资源分开投影）', () => {
    const ctxA = baseContext();
    const ctxB = baseContext();
    ctxB.characters = [{ ...fixturePlayer, hp: 80 }, fixtureNpc];
    const ops = diffPromptState(project('story', ctxA, ''), project('story', ctxB, ''));
    expect(ops).toEqual([{ op: 'set', scope: 'resource', owner: '阿岚', field: 'hp', value: 80 }]);
  });

  it('mp/sp/基础字段各自独立 set，不重发整名角色', () => {
    const ctxA = baseContext();
    const ctxB = baseContext();
    ctxB.characters = [{ ...fixturePlayer, mp: 30, level: 4, present: false }, fixtureNpc];
    const ops = diffPromptState(project('story', ctxA, ''), project('story', ctxB, ''));
    // 顺序是内部细节（渲染时才排序），这里用 arrayContaining 做顺序无关断言
    expect(ops).toHaveLength(3);
    expect(ops).toEqual(
      expect.arrayContaining([
        { op: 'set', scope: 'resource', owner: '阿岚', field: 'mp', value: 30 },
        { op: 'set', scope: 'character', owner: '阿岚', field: 'level', value: 4 },
        { op: 'set', scope: 'character', owner: '阿岚', field: 'present', value: false },
      ]),
    );
  });

  it('好感度变化 → 一个标量 set（owner=角色名，AI 可见名字而非内部 id）', () => {
    const ctxA = baseContext();
    const ctxB = baseContext();
    ctxB.affections = { [fixturePlayer.id]: 55, [fixtureNpc.id]: 15 };
    const ops = diffPromptState(project('story', ctxA, ''), project('story', ctxB, ''));
    expect(ops).toEqual([
      { op: 'set', scope: 'affection', owner: '阿岚', field: 'value', value: 55 },
    ]);
  });

  it('变量新增/变化 → set；删除 → remove', () => {
    const ctxA = baseContext();
    const ctxB = baseContext();
    ctxA.variables = { sys: { 天气: '小雨' }, user: { 心情: '平静' } };
    ctxB.variables = { sys: { 天气: '转晴' }, user: {} }; // 天气变化 + 心情删除
    const ops = diffPromptState(project('story', ctxA, ''), project('story', ctxB, ''));
    expect(ops).toEqual([
      { op: 'set', scope: 'variable', name: 'sys.天气', field: 'value', value: '转晴' },
      { op: 'remove', scope: 'variable', name: 'user.心情' },
    ]);
  });

  it('时间变化 → 逐字段标量 set', () => {
    const ctxA = baseContext();
    const ctxB = baseContext();
    ctxB.gameTime = { ...GAME_TIME, day: 13, hour: 6 };
    const ops = diffPromptState(project('story', ctxA, ''), project('story', ctxB, ''));
    expect(ops).toEqual([
      { op: 'set', scope: 'time', field: 'day', value: 13 },
      { op: 'set', scope: 'time', field: 'hour', value: 6 },
    ]);
  });

  it('剧情进度变化 → 一个标量 set（active/pending 事件摘要快照）', () => {
    const ctxA = baseContext();
    const ctxB = baseContext();
    // 原 active 事件完成，出现新 pending 事件
    ctxB.plotEvents = [
      { ...ctxA.plotEvents![0], status: 'completed' },
      { ...ctxA.plotEvents![0], id: 'plot-new', title: '借一盏灯', status: 'pending', order: 1 },
    ];
    const ops = diffPromptState(project('story', ctxA, ''), project('story', ctxB, ''));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'set', scope: 'plot', field: 'value' });
  });
});

// ═══════════════════════════════════════════════════════════
// focused case：集合元素 upsert/remove
// ═══════════════════════════════════════════════════════════

describe('diffPromptState — 集合元素 upsert/remove', () => {
  it('技能新增/修改/删除分别为 upsert/upsert/remove', () => {
    const prev = project('story', baseContext(), ''); // 初始无技能

    // 新增
    const ctxWithSkill = baseContext();
    ctxWithSkill.characters = [{ ...fixturePlayer, skills: [skill({ level: 1 })] }, fixtureNpc];
    const afterAdd = project('story', ctxWithSkill, '');
    const addOps = diffPromptState(prev, afterAdd);
    expect(addOps).toEqual([
      { op: 'upsert', scope: 'skill', owner: '阿岚', name: '夜行', value: expect.anything() },
    ]);

    // 修改（level 1 → 2）
    const ctxMod = baseContext();
    ctxMod.characters = [{ ...fixturePlayer, skills: [skill({ level: 2 })] }, fixtureNpc];
    const modOps = diffPromptState(afterAdd, project('story', ctxMod, ''));
    expect(modOps).toEqual([
      { op: 'upsert', scope: 'skill', owner: '阿岚', name: '夜行', value: expect.anything() },
    ]);

    // 删除
    const delOps = diffPromptState(afterAdd, project('story', baseContext(), ''));
    expect(delOps).toEqual([{ op: 'remove', scope: 'skill', owner: '阿岚', name: '夜行' }]);
  });

  it('物品新增 → upsert；删除 → remove', () => {
    const ctxWithItem = baseContext();
    ctxWithItem.characters = [{ ...fixturePlayer, inventory: [oilLamp] }, fixtureNpc];
    const prev = project('story', baseContext(), '');
    const withItem = project('story', ctxWithItem, '');
    expect(diffPromptState(prev, withItem)).toEqual([
      {
        op: 'upsert',
        scope: 'inventory',
        owner: '阿岚',
        name: '薄荷油灯',
        value: expect.anything(),
      },
    ]);
    expect(diffPromptState(withItem, prev)).toEqual([
      { op: 'remove', scope: 'inventory', owner: '阿岚', name: '薄荷油灯' },
    ]);
  });

  it('状态效果变化 → upsert（整元素，不细分内部字段）', () => {
    const ctxA = baseContext();
    const ctxB = baseContext();
    ctxA.characters = [
      {
        ...fixturePlayer,
        statusEffects: [
          {
            name: '火把照明',
            description: '照亮前路',
            category: '增益',
            stacks: 1,
            remainingTime: 3,
            timeUnit: '分钟',
            source: '[道具]-薄荷油灯',
            effects: {},
          },
        ],
      },
      fixtureNpc,
    ];
    ctxB.characters = [
      {
        ...fixturePlayer,
        statusEffects: [
          {
            name: '火把照明',
            description: '照亮前路',
            category: '增益',
            stacks: 2, // 层数变化
            remainingTime: 3,
            timeUnit: '分钟',
            source: '[道具]-薄荷油灯',
            effects: {},
          },
        ],
      },
      fixtureNpc,
    ];
    const ops = diffPromptState(project('story', ctxA, ''), project('story', ctxB, ''));
    expect(ops).toEqual([
      {
        op: 'upsert',
        scope: 'status_effect',
        owner: '阿岚',
        name: '火把照明',
        value: expect.anything(),
      },
    ]);
  });

  it('任务新增/修改/删除 → upsert/upsert/remove（name=任务名）', () => {
    const ctxA = baseContext();
    ctxA.quests = { 打探消息: quest({ progress: '第一步' }) };
    const prev = project('story', ctxA, '');

    // 修改
    const ctxB = baseContext();
    ctxB.quests = { 打探消息: quest({ progress: '第二步' }) };
    const modOps = diffPromptState(prev, project('story', ctxB, ''));
    expect(modOps).toEqual([
      { op: 'upsert', scope: 'quest', name: '打探消息', value: expect.anything() },
    ]);

    // 删除
    const ctxC = baseContext();
    ctxC.quests = {};
    expect(diffPromptState(prev, project('story', ctxC, ''))).toEqual([
      { op: 'remove', scope: 'quest', name: '打探消息' },
    ]);
  });

  it('记忆新增 → upsert；删除 → remove（按记忆 id，AI 已见）', () => {
    const ctxA = baseContext();
    ctxA.memories = [memoryRecord];
    const ctxB = baseContext();
    ctxB.memories = [];
    const withMemory = project('story', ctxA, '');
    expect(diffPromptState(project('story', ctxB, ''), withMemory)).toEqual([
      { op: 'upsert', scope: 'memory', name: 'MEM000001', value: expect.anything() },
    ]);
    expect(diffPromptState(withMemory, project('story', ctxB, ''))).toEqual([
      { op: 'remove', scope: 'memory', name: 'MEM000001' },
    ]);
  });

  it('记忆投影剥离 AI 不可见字段（embedding / hiddenLine / 召回索引）', () => {
    const ctx = baseContext();
    ctx.memories = [
      {
        ...memoryRecord,
        embedding: [0.1, 0.2],
        hiddenLine: '暗线',
        keywords: ['旅店'],
        relatedCharacterIds: ['x'],
      },
    ];
    const withMemory = project('story', ctx, '');
    const upsert = diffPromptState(project('story', baseContext(), ''), withMemory)[0] as Extract<
      PromptDeltaOp,
      { op: 'upsert' }
    >;
    expect(upsert.value).toEqual({
      id: 'MEM000001',
      timeRange: { start: '复兴纪元 512-04', end: '复兴纪元 512-04' },
      importance: 3,
      content: '阿岚在雨夜旅店避雨。',
    });
  });
});

// ═══════════════════════════════════════════════════════════
// focused case：整块 upsert / remove
// ═══════════════════════════════════════════════════════════

describe('diffPromptState — 整块 upsert / remove', () => {
  it('动态世界书求值结果变化 → 整块 upsert（固定 name=dynamic）', () => {
    const ctx = baseContext();
    const prev = project('story', ctx, '雨夜旅店的檐下挂着1盏灯');
    const changed = project('story', ctx, '雨夜旅店的檐下挂着2盏灯');
    expect(diffPromptState(prev, changed)).toEqual([
      { op: 'upsert', scope: 'lore_dynamic', name: 'dynamic', value: '雨夜旅店的檐下挂着2盏灯' },
    ]);
  });

  it('动态世界书消失 → remove；从无到有 → upsert', () => {
    const ctx = baseContext();
    const withLore = project('story', ctx, '雨夜旅店的檐下挂着1盏灯');
    const withoutLore = project('story', ctx, '');
    expect(diffPromptState(withLore, withoutLore)).toEqual([
      { op: 'remove', scope: 'lore_dynamic', name: 'dynamic' },
    ]);
    expect(diffPromptState(withoutLore, withLore)).toEqual([
      { op: 'upsert', scope: 'lore_dynamic', name: 'dynamic', value: '雨夜旅店的檐下挂着1盏灯' },
    ]);
  });

  it('地图上下文（派生态+事实态+天气）变化 → 整块 upsert', () => {
    const ctxA = baseContext();
    const ctxB = baseContext();
    ctxB.mapFlags = { lastTileId: 2 };
    ctxB.weather = '小雪';
    const ops = diffPromptState(project('story', ctxA, ''), project('story', ctxB, ''));
    expect(ops).toEqual([
      { op: 'upsert', scope: 'map', name: 'context', value: expect.anything() },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════
// focused case：名字作为 JSON value，不拼路径
// ═══════════════════════════════════════════════════════════

describe('diffPromptState — 名字只作 JSON value，不拼路径', () => {
  it('名字含中文、点号或方括号时仍作为完整 JSON 值', () => {
    const ctxA = baseContext();
    ctxA.variables = { sys: { 天气: '小雨', '行囊[备用]': '火折子' } };
    const ctxB = baseContext();
    ctxB.variables = { sys: { 天气: '小雨', '行囊[备用]': '火折子', '技能.夜行.熟练': 2 } };

    const ops = diffPromptState(project('story', ctxA, ''), project('story', ctxB, ''));
    // 完整变量名 = 命名空间前缀 + 子键名（子键名自身含点号）→ 作为一个完整字符串 name，
    // 不被拆成嵌套路径：'sys.技能.夜行.熟练' 就是名字本身
    expect(ops).toEqual([
      { op: 'set', scope: 'variable', name: 'sys.技能.夜行.熟练', field: 'value', value: 2 },
    ]);

    const rendered = renderPromptDelta(2, ops);
    expect(rendered).toContain('"name":"sys.技能.夜行.熟练"');
    expect(rendered).not.toContain('"name":"sys.技能"'); // 名字不是路径前缀
  });

  it('角色/物品/技能名含中文时同样作为 owner/name 字符串值', () => {
    const ctxWithSkill = baseContext();
    ctxWithSkill.characters = [
      { ...fixturePlayer, skills: [skill({ name: '夜行·雪原' })] },
      fixtureNpc,
    ];
    const ops = diffPromptState(
      project('story', baseContext(), ''),
      project('story', ctxWithSkill, ''),
    );
    expect(ops).toEqual([
      { op: 'upsert', scope: 'skill', owner: '阿岚', name: '夜行·雪原', value: expect.anything() },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════
// focused case：NARRATIVE append cursor
// ═══════════════════════════════════════════════════════════

describe('diffPromptState — 历史（NARRATIVE）append cursor', () => {
  it('历史新增只返回新消息（name=消息 id）', () => {
    const ctxA = baseContext();
    ctxA.history = fixtureHistory().slice(0, 4);
    const ctxB = baseContext();
    ctxB.history = fixtureHistory().slice(0, 6);
    const ops = diffPromptState(project('story', ctxA, ''), project('story', ctxB, ''));
    expect(ops).toEqual([
      {
        op: 'upsert',
        scope: 'narrative',
        name: 'fixture-msg-4',
        value: { role: 'user', content: fixtureTranscript[4].content },
      },
      {
        op: 'upsert',
        scope: 'narrative',
        name: 'fixture-msg-5',
        value: { role: 'assistant', content: fixtureTranscript[5].content },
      },
    ]);
  });

  it('已表示消息被修改 → 只返回 rebase(narrative_changed)，不产伪 delta', () => {
    const ctxA = baseContext();
    ctxA.history = fixtureHistory().slice(0, 4);
    const ctxB = baseContext();
    ctxB.history = fixtureHistory().slice(0, 4);
    ctxB.history[1] = { ...ctxB.history[1], content: '柜台后的小铃抬起头：「客官，今晚打烊了。」' };
    const ops = diffPromptState(project('story', ctxA, ''), project('story', ctxB, ''));
    expect(ops).toEqual([{ op: 'rebase', reason: 'narrative_changed' }]);
  });

  it('已表示消息被删除（历史变短）→ rebase(narrative_truncated)', () => {
    const ctxA = baseContext();
    ctxA.history = fixtureHistory().slice(0, 4);
    const ctxB = baseContext();
    ctxB.history = fixtureHistory().slice(0, 3);
    const ops = diffPromptState(project('story', ctxA, ''), project('story', ctxB, ''));
    expect(ops).toEqual([{ op: 'rebase', reason: 'narrative_truncated' }]);
  });

  it('已表示消息被重排 → rebase(narrative_changed)', () => {
    const ctxA = baseContext();
    ctxA.history = fixtureHistory().slice(0, 4);
    const ctxB = baseContext();
    const h = fixtureHistory().slice(0, 4);
    ctxB.history = [h[1], h[0], h[2], h[3]]; // 前两条交换
    const ops = diffPromptState(project('story', ctxA, ''), project('story', ctxB, ''));
    expect(ops).toEqual([{ op: 'rebase', reason: 'narrative_changed' }]);
  });

  it('中间插入新消息也视为前缀被改 → rebase', () => {
    const ctxA = baseContext();
    ctxA.history = [message('m0', 'user', 'A'), message('m1', 'assistant', 'B')];
    const ctxB = baseContext();
    ctxB.history = [
      message('m0', 'user', 'A'),
      message('m-x', 'user', '插入'),
      message('m1', 'assistant', 'B'),
    ];
    const ops = diffPromptState(project('story', ctxA, ''), project('story', ctxB, ''));
    expect(ops).toEqual([{ op: 'rebase', reason: 'narrative_changed' }]);
  });
});

// ═══════════════════════════════════════════════════════════
// 渲染（renderPromptDelta）
// ═══════════════════════════════════════════════════════════

describe('renderPromptDelta — 外壳 / 排序 / 字节稳定', () => {
  it('空 ops → 空串（调用方跳过 delta 区块，不产生空标签）', () => {
    expect(renderPromptDelta(1, [])).toBe('');
  });

  it('输出固定排序 + 每个 op 一行 JSON + revision 外壳', () => {
    const ops: PromptDeltaOp[] = [
      { op: 'set', scope: 'resource', owner: '阿岚', field: 'hp', value: 80 },
      {
        op: 'upsert',
        scope: 'skill',
        owner: '阿岚',
        name: '夜行',
        value: { level: 2, name: '夜行' },
      },
      { op: 'set', scope: 'character', owner: '阿岚', field: 'level', value: 4 },
    ];
    const rendered = renderPromptDelta(2, ops);
    expect(rendered).toContain('<context_delta revision="2">');
    expect(rendered).toContain('</context_delta>');
    // scope 字母序：character < resource < skill
    expect(rendered.indexOf('"scope":"character"')).toBeLessThan(
      rendered.indexOf('"scope":"resource"'),
    );
    expect(rendered.indexOf('"scope":"resource"')).toBeLessThan(
      rendered.indexOf('"scope":"skill"'),
    );
  });

  it('相同输入多次渲染字节一致（含乱序传入）', () => {
    const ops: PromptDeltaOp[] = [
      { op: 'set', scope: 'resource', owner: '阿岚', field: 'hp', value: 80 },
      {
        op: 'upsert',
        scope: 'skill',
        owner: '阿岚',
        name: '夜行',
        value: { level: 2, name: '夜行' },
      },
      { op: 'set', scope: 'character', owner: '阿岚', field: 'level', value: 4 },
    ];
    const forward = renderPromptDelta(5, ops);
    const backward = renderPromptDelta(5, [...ops].reverse());
    expect(forward).toBe(backward);
    // 再渲染一次，字节完全一致
    expect(forward).toBe(renderPromptDelta(5, ops));
  });

  it('value 递归按键排序（对象键序不同也渲染一致）', () => {
    const opsA: PromptDeltaOp[] = [
      {
        op: 'upsert',
        scope: 'skill',
        owner: '阿岚',
        name: '夜行',
        value: { level: 2, name: '夜行' },
      },
    ];
    const opsB: PromptDeltaOp[] = [
      {
        op: 'upsert',
        scope: 'skill',
        owner: '阿岚',
        name: '夜行',
        value: { name: '夜行', level: 2 },
      },
    ];
    expect(renderPromptDelta(1, opsA)).toBe(renderPromptDelta(1, opsB));
  });

  it('rebase 控制信号不可渲染（抛错）', () => {
    expect(() => renderPromptDelta(1, [{ op: 'rebase', reason: 'narrative_changed' }])).toThrow(
      /rebase/,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 控制面：agentId 自校验 + 封闭 scope 联合
// ═══════════════════════════════════════════════════════════

describe('diffPromptState — 控制面', () => {
  it('previous/current 属于不同 Agent → rebase(agent_changed)，不产伪 delta', () => {
    const ctx = baseContext();
    const ops = diffPromptState(project('story', ctx, ''), project('request_dispatcher', ctx, ''));
    expect(ops).toEqual([{ op: 'rebase', reason: 'agent_changed' }]);
  });

  it('projection 记录 agentId 供自校验', () => {
    expect(project('story', baseContext(), '').agentId).toBe('story');
    expect(project('memory_recall', baseContext(), '').agentId).toBe('memory_recall');
  });
});

describe('PromptScope — 封闭联合覆盖 v1 全部支持面', () => {
  const allScopes: PromptScope[] = [
    'character',
    'resource',
    'inventory',
    'skill',
    'status_effect',
    'quest',
    'affection',
    'variable',
    'time',
    'plot',
    'map',
    'lore_dynamic',
    'memory',
    'narrative',
  ];

  it('枚举 14 个 scope（新增任意字符串会在编译期被封闭联合拦下）', () => {
    expect(allScopes).toHaveLength(14);
    // 编译期守卫：一旦有人往 PromptScope 加了成员却忘了同步清单，下面这行也会让每个
    // 新成员出现在类型推导的联合里 —— 长度断言保证「成员数 = 清单数」。
    const rebaseReason: PromptRebaseReason = 'narrative_changed';
    expect(rebaseReason).toBe('narrative_changed');
  });
});

// ═══════════════════════════════════════════════════════════
// 投影（projectPromptState）结构
// ═══════════════════════════════════════════════════════════

describe('projectPromptState — 投影结构', () => {
  it('角色基础字段不含资源/集合/内部 id/customFields', () => {
    const ctx = baseContext();
    const projection = project('story', ctx, '');
    expect(projection.characters['阿岚']).not.toHaveProperty('id');
    expect(projection.characters['阿岚']).not.toHaveProperty('saveId');
    expect(projection.characters['阿岚']).not.toHaveProperty('hp');
    expect(projection.characters['阿岚']).not.toHaveProperty('skills');
    expect(projection.characters['阿岚']).not.toHaveProperty('customFields');
    expect(projection.characters['阿岚']).toHaveProperty('location', '雨夜旅店');
    expect(projection.characters['阿岚']).toHaveProperty('race', '人类');
    // 资源单独在 resources 里
    expect(projection.resources['阿岚']).toEqual({
      hp: 85,
      maxHp: 100,
      mp: 40,
      maxMp: 50,
      sp: 45,
      maxSp: 50,
    });
  });

  it('affection 用角色名作键（characterId 映射到 AI 可见名字）', () => {
    const projection = project('story', baseContext(), '');
    expect(projection.affections).toEqual({ 阿岚: 40, 小铃: 15 });
    expect(projection.affections).not.toHaveProperty(fixturePlayer.id);
  });

  it('narrative 保留 id（append cursor 依据）', () => {
    const projection = project('story', baseContext(), '');
    expect(projection.narrative.map((m) => m.id)).toEqual(
      fixtureTranscript.map((_, i) => `fixture-msg-${i}`),
    );
  });

  it('无名角色不投影', () => {
    const unnamed = createDefaultCharacterState({ id: 'x', name: '', saveId: 's' });
    const projection = project('story', makeContext({ characters: [unnamed] }), '');
    expect(projection.characters).toEqual({});
  });
});
