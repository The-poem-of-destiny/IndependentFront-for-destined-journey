/**
 * plugin-projection.ts —— 插件读投影（设计 §4.5 红线 A、§5.2）。
 */
import { describe, expect, it } from 'vitest';
import { buildStatData } from '../../../src/core/character/stat-projection';
import {
  PLUGIN_MESSAGES_VIEW_LIMIT,
  buildPluginView,
  type PluginProjectionInput,
  type PluginView,
} from '../../../src/core/plugins/plugin-projection';
import { PLUGIN_VIEWS } from '../../../src/core/plugins/plugin-surface';
import {
  createDefaultCharacterState,
  type ChatMessage,
  type PlotEvent,
  type SaveProfile,
  type SystemEvent,
} from '../../../src/core/types/types';

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz123456';

function makeInput(): PluginProjectionInput {
  const player = createDefaultCharacterState({
    id: 'p-1',
    saveId: 's-1',
    type: 'player',
    name: '艾琳',
    money: 120,
    location: '王都/集市',
    ageAnchor: { startAge: 18, month: 1, day: 1 },
    introducedBy: 'm-0',
    inventory: [{ id: 'old-item', name: '短剑', quantity: 1, equippedSlot: '主手' }],
    skills: [{ id: 'old-skill', name: '火球', description: '一团火', type: 'active' }],
    statusEffects: [
      {
        id: 'old-status',
        name: '鼓舞',
        description: '士气高昂',
        category: '增益',
        stacks: 1,
        remainingTime: 3,
        timeUnit: '回合',
        source: '技能-艾琳',
        effects: {},
      },
    ],
    customFields: { note: '随身笔记' },
  });
  const npc = createDefaultCharacterState({ id: 'n-1', saveId: 's-1', name: '老板' });
  const profile: SaveProfile = {
    saveId: 's-1',
    experienceMode: 'normal',
    fp: 7,
    fpHistory: [
      {
        id: 'tx',
        timestamp: 1,
        amount: 7,
        reason: '任务',
        balance: 7,
        source: 'task',
      },
    ],
    contracts: [],
    achievements: [],
    news: [
      {
        id: 'news-1',
        title: '集市开张',
        content: '王都集市今日开张',
        category: '城镇',
        publishedAt: 5,
        read: true,
      },
    ],
    quests: {
      寻剑: {
        status: '进行中',
        priority: '高',
        progress: '',
        detail: '',
        objective: '',
        reward: '',
      },
    },
    focusQuest: '寻剑',
    affections: { 老板: 10 },
    gameTime: { era: '复兴纪元', year: 1, month: 2, day: 3, hour: 9, minute: 0, weekday: 1 },
    variables: { user: { 心情: '好' }, sys: { 天数: 3 } },
    worldFlags: {
      map: { lastTileId: 't-1' },
      mapFacts: { 王都: { status: [] } },
      plugins: { other: { secret: 1 } },
    },
    updatedAt: 99,
  };
  const plotEvents: PlotEvent[] = [
    {
      id: 'pe-1',
      saveId: 's-1',
      title: '序章',
      description: '开端',
      status: 'active',
      childrenIds: [],
      order: 0,
      relatedCharacterIds: [],
      worldLineChanged: false,
      visibility: 'revealed',
      depth: 0,
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  const messages: ChatMessage[] = [
    { id: 'sys', role: 'system', content: '系统提示', timestamp: 1 },
    { id: 'u1', role: 'user', content: `我的密钥是 ${SECRET}`, timestamp: 2, turn: 1 },
    {
      id: 'a1',
      role: 'assistant',
      content: '你走进集市',
      timestamp: 3,
      turn: 1,
      storyTurnStatus: 'accepted',
      storyTurnKey: 'u1',
      preRewriteContent: '原文',
      saveId: 's-1',
    },
    { id: 'a2', role: 'assistant', content: '失败的尝试', timestamp: 4, storyTurnStatus: 'failed' },
    { id: 'a3', role: 'assistant', content: '等待中', timestamp: 5, storyTurnStatus: 'pending' },
    { id: 'd1', role: 'assistant', content: '诊断', timestamp: 6, diagnostic: true },
    {
      id: 'e1',
      role: 'assistant',
      content: '卡片',
      timestamp: 7,
      systemEvent: { type: 'craft' } as unknown as SystemEvent,
    },
  ];
  return {
    characters: [npc, player],
    profile,
    messages,
    plotEvents,
    run: { generating: false, inCombat: true, turn: 4, mode: 'agent' },
    weather: '小雨',
  };
}

const LEDGER_KEYS = [
  'saveId',
  'ageAnchor',
  'introducedBy',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'fpHistory',
];

/** 递归收集对象里出现过的全部键 */
function collectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

describe('buildPluginView 各投影的字段', () => {
  it('player：主角非账务字段，含金钱、五维、资源、位置，条目旧 id 被剥掉', () => {
    const input = makeInput();
    const view = buildPluginView('player', input) as Record<string, any>;
    const { id: _id, saveId: _s, ageAnchor: _a, introducedBy: _i, ...rest } = input.characters[1];
    const expected = JSON.parse(JSON.stringify(rest));
    expected.inventory = [{ name: '短剑', quantity: 1, equippedSlot: '主手' }];
    expected.skills = [{ name: '火球', description: '一团火', type: 'active' }];
    expected.statusEffects = [
      {
        name: '鼓舞',
        description: '士气高昂',
        category: '增益',
        stacks: 1,
        remainingTime: 3,
        timeUnit: '回合',
        source: '技能-艾琳',
        effects: {},
      },
    ];
    expect(view).toEqual(expected);
    expect(view.money).toBe(120);
    expect(view.location).toBe('王都/集市');
    expect(view.attributes).toEqual({ str: 10, dex: 10, con: 10, int: 10, spi: 10 });
    expect(view.hp).toBe(100);
  });

  it('player：没有主角时为 null，三个主角数组为空', () => {
    const input = makeInput();
    input.characters = input.characters.filter((c) => c.type !== 'player');
    expect(buildPluginView('player', input)).toBeNull();
    expect(buildPluginView('player.inventory', input)).toEqual([]);
    expect(buildPluginView('player.skills', input)).toEqual([]);
    expect(buildPluginView('player.statusEffects', input)).toEqual([]);
  });

  it('player.inventory / skills / statusEffects：主角对应数组', () => {
    const input = makeInput();
    expect(buildPluginView('player.inventory', input)).toEqual([
      { name: '短剑', quantity: 1, equippedSlot: '主手' },
    ]);
    expect(buildPluginView('player.skills', input)).toEqual([
      { name: '火球', description: '一团火', type: 'active' },
    ]);
    expect((buildPluginView('player.statusEffects', input) as any[])[0].name).toBe('鼓舞');
  });

  it('characters：全部角色，与 player 同口径', () => {
    const input = makeInput();
    const view = buildPluginView('characters', input) as Record<string, unknown>[];
    expect(view.map((c) => c.name)).toEqual(['老板', '艾琳']);
    expect(view[1]).toEqual(buildPluginView('player', input));
    for (const c of view) expect(c).not.toHaveProperty('id');
  });

  it('stats：与 EJS stats 面同一份推导', () => {
    const input = makeInput();
    expect(buildPluginView('stats', input)).toEqual(
      buildStatData({
        characters: [...input.characters],
        gameTime: input.profile.gameTime,
        fp: 7,
        turn: 4,
        weather: '小雨',
      }),
    );
  });

  it('vars / quests / affections / fp / time：档案对应字段', () => {
    const input = makeInput();
    expect(buildPluginView('vars', input)).toEqual(input.profile.variables);
    expect(buildPluginView('quests', input)).toEqual(input.profile.quests);
    expect(buildPluginView('affections', input)).toEqual({ 老板: 10 });
    expect(buildPluginView('fp', input)).toBe(7);
    expect(buildPluginView('time', input)).toEqual(input.profile.gameTime);
  });

  it('news：只给标题、正文、分类', () => {
    expect(buildPluginView('news', makeInput())).toEqual([
      { title: '集市开张', content: '王都集市今日开张', category: '城镇' },
    ]);
  });

  it('plot：剧情事件去掉 saveId 与时间戳，保留寻址用的 id', () => {
    const view = buildPluginView('plot', makeInput()) as Record<string, unknown>[];
    expect(view).toHaveLength(1);
    expect(view[0].id).toBe('pe-1');
    expect(Object.keys(view[0]).sort()).toEqual(
      [
        'id',
        'title',
        'description',
        'status',
        'childrenIds',
        'order',
        'relatedCharacterIds',
        'worldLineChanged',
        'visibility',
        'depth',
      ].sort(),
    );
  });

  it('map：只给 worldFlags.map 与 worldFlags.mapFacts，不带其他旗', () => {
    const input = makeInput();
    expect(buildPluginView('map', input)).toEqual({
      map: { lastTileId: 't-1' },
      mapFacts: { 王都: { status: [] } },
    });
    input.profile.worldFlags = {};
    expect(buildPluginView('map', input)).toEqual({ map: null, mapFacts: null });
  });

  it('run：{ generating, inCombat, turn, mode }', () => {
    expect(buildPluginView('run', makeInput())).toEqual({
      generating: false,
      inCombat: true,
      turn: 4,
      mode: 'agent',
    });
  });
});

describe('messages 投影', () => {
  it('只留已接纳的 user / assistant，排除系统事件、诊断与未接纳尝试', () => {
    const view = buildPluginView('messages', makeInput()) as { id: string }[];
    expect(view.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('只给 id、role、content、turn、timestamp', () => {
    const view = buildPluginView('messages', makeInput()) as Record<string, unknown>[];
    for (const m of view) {
      expect(Object.keys(m).sort()).toEqual(['content', 'id', 'role', 'timestamp', 'turn']);
    }
    expect(view[1]).toEqual({
      id: 'a1',
      role: 'assistant',
      content: '你走进集市',
      timestamp: 3,
      turn: 1,
    });
  });

  it('正文过脱敏', () => {
    const view = buildPluginView('messages', makeInput()) as { content: string }[];
    expect(view[0].content).not.toContain(SECRET);
    expect(view[0].content).toContain('[已隐藏的密钥]');
  });

  it(`最多给最近 ${PLUGIN_MESSAGES_VIEW_LIMIT} 条`, () => {
    const input = makeInput();
    input.messages = Array.from({ length: PLUGIN_MESSAGES_VIEW_LIMIT + 5 }, (_, i) => ({
      id: `m${i}`,
      role: 'user' as const,
      content: `第 ${i} 句`,
      timestamp: i,
    }));
    const view = buildPluginView('messages', input) as { id: string }[];
    expect(view).toHaveLength(PLUGIN_MESSAGES_VIEW_LIMIT);
    expect(view[0].id).toBe('m5');
    expect(view[view.length - 1].id).toBe(`m${PLUGIN_MESSAGES_VIEW_LIMIT + 4}`);
  });
});

describe('投影的安全性质', () => {
  it('每个投影都不含账务字段', () => {
    const input = makeInput();
    for (const view of PLUGIN_VIEWS) {
      const keys = collectKeys(buildPluginView(view, input));
      for (const key of LEDGER_KEYS) expect(keys.has(key), `${view} 含 ${key}`).toBe(false);
    }
    // 角色与条目一律不给 id（剧情事件、消息的 id 是寻址键，单独保留）
    for (const view of [
      'player',
      'characters',
      'player.inventory',
      'player.skills',
      'player.statusEffects',
    ] as PluginView[]) {
      expect(collectKeys(buildPluginView(view, input)).has('id'), view).toBe(false);
    }
  });

  it('输出是深拷贝：改输出不影响输入', () => {
    const input = makeInput();
    const snapshot = JSON.parse(JSON.stringify(input));
    for (const view of PLUGIN_VIEWS) {
      const out = buildPluginView(view, input);
      const mutate = (v: unknown): void => {
        if (Array.isArray(v)) {
          v.forEach(mutate);
          v.push('x');
        } else if (v && typeof v === 'object') {
          for (const [k, child] of Object.entries(v)) {
            mutate(child);
            (v as Record<string, unknown>)[k] = '被改了';
          }
        }
      };
      mutate(out);
    }
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  it('输出是纯 JSON：能原样 JSON 往返，也能过结构化克隆（含代理入参）', () => {
    const input = makeInput();
    const proxied = { ...input, profile: new Proxy(input.profile, {}) };
    for (const view of PLUGIN_VIEWS) {
      const out = buildPluginView(view, proxied);
      expect(JSON.parse(JSON.stringify(out))).toEqual(out);
      expect(() => structuredClone(out)).not.toThrow();
    }
  });

  it('输入类型不收设置、API 源之类的字段', () => {
    const input = makeInput();
    buildPluginView('vars', {
      ...input,
      // @ts-expect-error 投影输入不允许携带设置
      settings: { apiKey: SECRET },
    });
    buildPluginView('vars', {
      ...input,
      // @ts-expect-error 投影输入不允许携带 API 源
      apiEndpoints: [],
    });
    expect(buildPluginView('vars', input)).toEqual(input.profile.variables);
  });
});
