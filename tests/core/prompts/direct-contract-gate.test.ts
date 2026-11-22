/**
 * 直出契约漂移闸门：协议文本（buildDirectProtocol）、契约常量（direct-contract.ts）
 * 与校验器（parseDirectOutput / buildDirectPatches）三者必须说同一件事。
 * 改了白名单却没改协议、或协议教了校验器不收的形状，这里会红。
 */
import { describe, expect, it } from 'vitest';
import * as contract from '../../../src/core/agents/direct-contract';
import {
  buildDirectPatches,
  parseDirectOutput,
  type DirectTurnDraft,
} from '../../../src/core/agents/direct-output';
import type { DirectDicePool } from '../../../src/core/agents/direct-dice';
import {
  buildDirectProtocol,
  DIRECT_OUTPUT_REMINDER,
} from '../../../src/core/prompts/direct-prompt';
import { CHARACTER_UPDATE_PROTOCOL } from '../../../src/core/character/character-chronicle';
import { LIST_FIELDS, TEXT_FIELDS } from '../../../src/core/character/character-updates';
import {
  EQUIP_SLOTS,
  ITEM_TYPES,
  QUEST_STATUSES,
  RARITY_LEVELS,
  STATUS_CATEGORIES,
} from '../../../src/core/content/field-enums';
import { createDefaultCharacterState, type CharacterState } from '../../../src/core/types/types';

type Row = Record<string, any>;

const variants = [
  ['结构化战斗开启', true],
  ['结构化战斗关闭', false],
] as const;

/** 契约常量里不进协议文本的清单：原型污染键只由校验器拒收，不该教给模型 */
const NOT_IN_PROTOCOL = new Set<string>(['DIRECT_FORBIDDEN_KEYS']);

/** 把契约模块的每个导出展平成「常量名（对象按子键展开为 名.子键）→ 词表」 */
function contractLists(): Array<[string, readonly string[]]> {
  const out: Array<[string, readonly string[]]> = [];
  for (const [name, value] of Object.entries(contract)) {
    if (NOT_IN_PROTOCOL.has(name)) continue;
    if (Array.isArray(value)) out.push([name, value]);
    else
      for (const [sub, list] of Object.entries(value as Row))
        out.push([`${name}.${sub}`, list as string[]]);
  }
  return out;
}

/**
 * 每份清单必须在协议的哪几行（按行首定位）里、以什么形式出现：
 * - token：每个词以独立标识符出现（前后不接 ASCII 字母数字下划线，`id` 不会被 `identity` 冒充）；
 * - key：每个词以 `词:` / `词?:` 的键形式出现；
 * - 函数：由清单拼出的整段片段原样出现（对应协议里按常量插值的地方）。
 * 新增契约常量却没在这里登记一条规则，闸门会红。
 */
type Rule = { lines: string[]; form: 'token' | 'key' | ((list: readonly string[]) => string) };
const slash = (list: readonly string[]): string => list.join('/');
const RULES: Record<string, Rule> = {
  DIRECT_SECTIONS: { lines: ['{"version":1'], form: 'token' },
  DIRECT_WORLD_KEYS: { lines: ['world：'], form: 'key' },
  DIRECT_WORLD_RESERVED_SEGMENTS: { lines: ['world：'], form: slash },
  'DIRECT_ENTITY_ROW_KEYS.character': { lines: ['1. {kind:"character"'], form: 'key' },
  'DIRECT_ENTITY_ROW_KEYS.loadout': { lines: ['2. {kind:"loadout"'], form: 'key' },
  DIRECT_ENTITY_OUTPUT_KEYS: { lines: ['实体结构：'], form: 'token' },
  DIRECT_ENTITY_OUTER_KEYS: {
    lines: ['实体结构：'],
    form: (list) => `output 顶层只放 ${slash(list)}`,
  },
  DIRECT_ENTITY_LIST_KEYS: { lines: ['实体结构：'], form: 'key' },
  DIRECT_CHARACTER_TEXT_FIELDS: { lines: ['人物字段除'], form: 'token' },
  DIRECT_CHARACTER_LIST_FIELDS: { lines: ['人物字段除'], form: 'key' },
  DIRECT_ATTRIBUTE_KEYS: {
    lines: ['人物字段除'],
    form: (list) => `attributes:{${list.join(',')}}`,
  },
  DIRECT_ASCENSION_LIST_KEYS: { lines: ['人物字段除'], form: 'key' },
  DIRECT_STATE_KEYS: { lines: ['characters:{', 'items:{', 'affections:{'], form: 'key' },
  DIRECT_CHARACTER_OPERATIONS: { lines: ['characters:{'], form: 'key' },
  DIRECT_CHARACTER_FIELDS: {
    lines: ['characters:{'],
    form: (list) => `replace 允许 ${slash(list)}`,
  },
  DIRECT_DELTA_PATHS: { lines: ['characters:{'], form: (list) => `delta 仅 ${slash(list)}` },
  DIRECT_REMOVE_PATHS: {
    lines: ['characters:{'],
    form: (list) => `path:${list.map((path) => `"${path}"`).join('或')}`,
  },
  DIRECT_ITEM_OPERATIONS: { lines: ['items:{'], form: 'key' },
  DIRECT_ITEM_MODIFY_KEYS: { lines: ['items:{'], form: (list) => `changes 只含 ${slash(list)}` },
  DIRECT_AFFECTION_OPERATIONS: { lines: ['affections:{'], form: 'key' },
  DIRECT_QUEST_OPERATIONS: { lines: ['affections:{'], form: 'key' },
  DIRECT_EFFECT_ROW_KEYS: { lines: ['effects:['], form: 'token' },
  DIRECT_EFFECT_ACTIONS: {
    lines: ['effects:['],
    form: (list) => `action:${list.map((action) => `"${action}"`).join('|')}`,
  },
  DIRECT_EFFECT_UPDATE_KEYS: {
    lines: ['effects:['],
    form: (list) => `update 只给 ${list.join(',')}`,
  },
  DIRECT_EFFECT_REMOVE_KEYS: {
    lines: ['effects:['],
    form: (list) => `remove 只给 ${list.join(',')}`,
  },
  DIRECT_EFFECT_CATEGORIES: { lines: ['effects:['], form: (list) => `category(${slash(list)})` },
  DIRECT_EFFECT_TIME_UNITS: { lines: ['effects:['], form: (list) => `timeUnit(${slash(list)})` },
  DIRECT_PLOT_KEYS: { lines: ['plot:'], form: 'key' },
  DIRECT_STRIPPED_KEYS: { lines: ['禁止输出裸'], form: (list) => `任何 ${slash(list)}；` },
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 按规则检查一份清单，返回缺失项（空数组 = 通过） */
function missingFor(protocol: string, name: string, list: readonly string[]): string[] {
  const rule = RULES[name];
  if (!rule) return [`${name}：没有登记闸门规则`];
  const lines = rule.lines.map((prefix) => {
    const found = protocol.split('\n').filter((line) => line.startsWith(prefix));
    return found.length === 1 ? found[0] : undefined;
  });
  if (lines.some((line) => line === undefined)) return [`${name}：定位行不唯一或不存在`];
  const scope = lines as string[];
  if (typeof rule.form === 'function') {
    const fragment = rule.form(list);
    return scope.some((line) => line.includes(fragment)) ? [] : [`${name}：缺片段 ${fragment}`];
  }
  const suffix = rule.form === 'key' ? String.raw`\??:` : String.raw`(?![A-Za-z0-9_])`;
  return list
    .filter(
      (word) =>
        !scope.some((line) =>
          new RegExp(String.raw`(?<![A-Za-z0-9_])${escapeRegExp(word)}${suffix}`).test(line),
        ),
    )
    .map((word) => `${name}:${word}`);
}

/**
 * field-enums 词表：与契约清单同款，定位到协议里插值该词表的那一行（行首唯一），
 * 断言插值片段完整出现在该行 —— 全文子串判断会被别处的同名词（如「稀有」）冒充。
 */
const ENUM_RULES: Array<[string, readonly string[], string, (list: readonly string[]) => string]> =
  [
    ['EQUIP_SLOTS', EQUIP_SLOTS, '装备：', (list) => `slot:${slash(list)}之一`],
    ['ITEM_TYPES', ITEM_TYPES, '物品：', (list) => `type:${slash(list)}之一`],
    ['RARITY_LEVELS', RARITY_LEVELS, '物品：', (list) => `quality/rarity 取 ${slash(list)}。`],
    ['QUEST_STATUSES', QUEST_STATUSES, 'affections:{', (list) => `status?:${slash(list)},`],
    ['STATUS_CATEGORIES', STATUS_CATEGORIES, 'effects:[', (list) => `category(${slash(list)})`],
  ];

/** 按行首定位唯一一行，再判断片段是否在该行内；返回缺失说明（空数组 = 通过） */
function missingEnum(protocol: string, name: string, prefix: string, fragment: string): string[] {
  const found = protocol.split('\n').filter((line) => line.startsWith(prefix));
  if (found.length !== 1) return [`${name}：定位行不唯一或不存在`];
  return found[0].includes(fragment) ? [] : [`${name}：缺片段 ${fragment}`];
}

describe('闸门 1：协议覆盖契约常量与枚举词表', () => {
  it.each(variants)('%s：每份契约清单在对应协议行内按规定形式出现', (_label, structured) => {
    const text = buildDirectProtocol(structured);
    const missing = contractLists().flatMap(([name, list]) => missingFor(text, name, list));
    expect(missing).toEqual([]);
  });

  it('每条闸门规则都对应一个现存的契约清单', () => {
    const names = new Set(contractLists().map(([name]) => name));
    expect(Object.keys(RULES).filter((name) => !names.has(name))).toEqual([]);
  });

  it.each(variants)('%s：骨架 JSON 的顶层键恰为 DIRECT_SECTIONS', (_label, structured) => {
    const line = buildDirectProtocol(structured)
      .split('\n')
      .find((l) => l.startsWith('{"version":1'));
    expect(Object.keys(JSON.parse(line!))).toEqual([...contract.DIRECT_SECTIONS]);
  });

  it.each(variants)('%s：原型污染键不出现在协议里', (_label, structured) => {
    const text = buildDirectProtocol(structured);
    expect(contract.DIRECT_FORBIDDEN_KEYS.filter((key) => text.includes(key))).toEqual([]);
  });

  it.each(variants)('%s：field-enums 词表完整出现在对应协议行内', (_label, structured) => {
    const text = buildDirectProtocol(structured);
    const missing = ENUM_RULES.flatMap(([name, list, prefix, form]) =>
      missingEnum(text, name, prefix, form(list)),
    );
    expect(missing).toEqual([]);
  });

  it('field-enums 闸门能抓到被删掉的品质枚举句', () => {
    const text = buildDirectProtocol(true);
    const [, list, prefix, form] = ENUM_RULES.find(([name]) => name === 'RARITY_LEVELS')!;
    const fragment = form(list);
    // 品质词在协议别处（如层级表的 qualityCap）仍会出现，全文子串判断会在这里空转
    const stripped = text.replace(fragment, '');
    expect(stripped).not.toBe(text);
    expect(missingEnum(stripped, 'RARITY_LEVELS', prefix, fragment)).toEqual([
      `RARITY_LEVELS：缺片段 ${fragment}`,
    ]);
  });

  it('character_updates 协议列出 profile_changes 白名单', () => {
    for (const key of [...TEXT_FIELDS, ...LIST_FIELDS])
      expect(CHARACTER_UPDATE_PROTOCOL).toContain(key);
  });

  it('两种口径仍只差 combat 一行且行数相同', () => {
    const on = buildDirectProtocol(true).split('\n');
    const off = buildDirectProtocol(false).split('\n');
    expect(off).toHaveLength(on.length);
    expect(on.filter((line, i) => line !== off[i])).toHaveLength(1);
  });
});

describe('闸门：直出请求末尾的输出格式提醒', () => {
  const TAGS = ['maintext', 'options', 'character_updates', 'direct_updates'] as const;
  const firstOrder = (text: string) =>
    TAGS.map((tag) => ({ tag, at: text.indexOf(`<${tag}>`) }))
      .filter((t) => t.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((t) => t.tag);

  it.each(variants)('外壳标签首次出现顺序与协议「输出顺序：」行一致（%s）', (_, structured) => {
    const line = buildDirectProtocol(structured)
      .split('\n')
      .find((l) => l.startsWith('输出顺序：'));
    expect(line).toBeDefined();
    expect(firstOrder(line!)).toEqual([...TAGS]);
    expect(firstOrder(DIRECT_OUTPUT_REMINDER)).toEqual([...TAGS]);
  });

  it('提醒要求 <beat/> 分节、足够短，且不提「思维链」', () => {
    expect(DIRECT_OUTPUT_REMINDER).toContain('<beat/>');
    expect(DIRECT_OUTPUT_REMINDER.length).toBeLessThanOrEqual(300);
    expect(DIRECT_OUTPUT_REMINDER).not.toContain('思维链');
  });
});

const EMPTY_UPDATES = JSON.stringify({ characters: [] });

function wrap(
  updates: string,
  characterUpdates = EMPTY_UPDATES,
  body = '神殿的钟声响起。',
): string {
  return `<maintext>${body}</maintext><options>1. 等待\n2. 离开</options><character_updates>${characterUpdates}</character_updates><direct_updates>${updates}</direct_updates>`;
}

describe('闸门 2：协议里的骨架示例能过校验', () => {
  it.each(variants)('%s：骨架 JSON 原样接纳且无纠正', (_label, structured) => {
    const line = buildDirectProtocol(structured)
      .split('\n')
      .find((l) => l.startsWith('{"version":1'));
    expect(line).toBeDefined();
    const draft = parseDirectOutput(wrap(line!), [{ sides: 20, values: [7] }], {
      structuredCombat: structured,
    });
    expect(draft.normalized).toBeUndefined();
    expect(draft.dropped).toBeUndefined();
    expect(draft.updates.version).toBe(1);
  });
});

// ── 闸门 3：覆盖全部已文档化形状的最大样例 ──

const POOL: DirectDicePool = [
  { sides: 6, values: [3] },
  { sides: 20, values: [12, 5] },
];

function existing(): CharacterState[] {
  return [
    createDefaultCharacterState({
      id: 'p',
      saveId: 's',
      name: '旅人',
      type: 'player',
      // 最大样例引用的旧物品 / 旧技能（替换、脱下）须真在身上：建补丁会按库存预演，查不到的丢弃
      inventory: [
        { name: '铁', quantity: 2 },
        { name: '旧盾', quantity: 1, equippedSlot: '副手' },
        { name: '旧帽', quantity: 1, equippedSlot: '头部' },
      ],
      skills: [{ name: '旧剑技' } as CharacterState['skills'][number]],
    }),
    createDefaultCharacterState({ id: 'c', saveId: 's', name: '同伴', type: 'npc' }),
  ];
}

function status(name: string, owner: string): Row {
  return {
    name,
    owner,
    description: `${name}的描述`,
    category: '增益',
    stacks: 1,
    maxStacks: 3,
    remainingTime: null,
    timeUnit: '小时',
    effectDescriptions: { 庇护: '受到的伤害降低' },
    protocolText: `${name}：受到的伤害降低。`,
    tags: ['神术'],
  };
}

/** 完整登神状态：三类条目都是对象 */
function fullAscension(): Row {
  return {
    enabled: true,
    path: '黎明之道',
    description: '以晨光为途登上神座',
    elements: [{ name: '晨光', description: '光之要素', effects: ['照亮黑暗'] }],
    authorities: [
      {
        name: '破晓',
        description: '驱散夜幕的权能',
        effects: ['驱散黑暗'],
        costDescription: '消耗大量 MP',
      },
    ],
    laws: [
      {
        name: '昼夜轮转',
        description: '掌控昼夜交替的法则',
        passiveEffects: ['白昼时恢复加快'],
        activeEffects: ['强行令黎明降临'],
        costDescription: '一日只能发动一次',
      },
    ],
    deityPosition: '黎明之神',
    divineKingdom: { name: '晨曦殿', description: '永不落日的神国' },
  };
}

function mythicPriest(): Row {
  return {
    kind: 'character',
    placement: { location: '神殿', present: true },
    output: {
      skills: [],
      equipment: [],
      inventory: [],
      statuses: [status('神威', '神官')],
      character: {
        name: '神官',
        race: '人类',
        gender: '女',
        tier: 7,
        level: 25,
        attributes: { str: 12, dex: 14, con: 15, int: 18, spi: 20 },
        identity: ['大神官'],
        occupation: ['祭司'],
        background: '自幼侍奉黎明',
        appearance: '金色长发',
        clothing: '白色法袍',
        personality: '温和而坚定',
        likes: '晨祷',
        thoughts: '她在等一个预言中的人。',
        skills: [
          {
            name: '圣光',
            description: '召唤圣光',
            type: 'active',
            quality: '神话',
            cost: { type: 'MP', amount: 50 },
            cooldown: 2,
            skillPower: 300,
            relevantAttribute: 'spi',
            damageType: '能量',
            effects: { 灼烧: '对亡灵额外伤害' },
            protocolText: '圣光：对目标造成能量伤害。',
            tags: ['神术'],
          },
        ],
        equipment: [
          {
            name: '晨星杖',
            description: '镶着晨星的法杖',
            slot: '武器',
            quality: '神话',
            stats: { 精神: 5 },
            durability: 100,
            tags: ['法杖'],
          },
        ],
        inventory: [
          {
            name: '圣水',
            description: '祝福过的水',
            quantity: 3,
            type: '消耗品',
            rarity: '稀有',
            protocolText: '饮用后恢复 MP。',
          },
        ],
        ascension: fullAscension(),
      },
    },
  };
}

function travellerLoadout(): Row {
  return {
    kind: 'loadout',
    owner: '旅人',
    output: {
      skills: [
        { name: '晨光斩', description: '带着晨光的斩击', type: 'active', replace: '旧剑技' },
      ],
      equipment: [{ name: '短剑', description: '一把短剑', slot: '武器', stats: { 攻击力: 3 } }],
      inventory: [{ name: '药水', description: '恢复体力', quantity: 2, type: '消耗品' }],
      statuses: [status('受洗', '旅人')],
      ascension: {
        ...fullAscension(),
        laws: [],
        authorities: [],
        deityPosition: '',
        divineKingdom: { name: '', description: '' },
      },
    },
  };
}

function maximalUpdates(): Row {
  return {
    version: 1,
    world: {
      replace: [{ path: '世界.局势', value: '紧张' }],
      insert: [{ path: '世界.传闻', value: '黎明将至', index: 0 }],
      tile_ops: [{ op: 'tile_history_note', tile: '晨曦镇', text: '神官现身' }],
    },
    time: { delta_time: 30 },
    entities: [mythicPriest(), travellerLoadout()],
    state: {
      characters: {
        replace: [
          { name: '旅人', path: 'hp', value: 50 },
          { name: '旅人', path: 'location', value: '神殿' },
          { name: '同伴', path: 'present', value: true },
          { name: '同伴', path: 'currentAction', value: '祈祷' },
        ],
        delta: [
          { name: '旅人', path: 'mp', amount: -5 },
          { name: '旅人', path: 'totalExp', amount: 20 },
        ],
        remove: [{ name: '旅人', path: 'equipment', target: '旧盾' }],
      },
      items: {
        consume: [{ owner: '旅人', target: '铁', quantity: 1 }],
        equip: [{ owner: '旅人', target: '短剑', slot: '武器' }],
        unequip: [{ owner: '旅人', target: '旧帽' }],
        transfer: [{ from: '旅人', to: '同伴', target: '铁', quantity: 1 }],
        modify: [
          {
            owner: '旅人',
            target: '短剑',
            changes: { description: '受过祝福的短剑', rarity: '稀有', durability: 9, tags: ['圣'] },
          },
        ],
      },
      affections: { set: [{ name: '同伴', value: 10 }], delta: [{ name: '神官', amount: 5 }] },
      fp: { delta: 1 },
      quests: {
        upsert: [
          {
            name: '寻找黎明',
            status: '进行中',
            priority: '高',
            progress: '见到了神官',
            detail: '神官提及预言',
            objective: '前往晨曦殿',
            reward: '神官的祝福',
          },
        ],
        remove: [{ name: '旧委托' }],
      },
    },
    effects: [
      {
        owner: '旅人',
        action: 'add',
        value: {
          name: '祝福',
          description: '晨光庇护',
          category: '增益',
          stacks: 1,
          remainingTime: 60,
          timeUnit: '分钟',
        },
      },
      { owner: '同伴', action: 'update', value: { name: '中毒', remainingTime: 5, stacks: 2 } },
      { owner: '旅人', action: 'remove', value: { name: '疲惫' } },
    ],
    plot: {
      pre: {
        triggeredEvents: [{ title: '神官现身', reason: '旅人抵达神殿' }],
        relevantBackground: '黎明预言',
        outlineRelevance: '主线第一章',
      },
      post: {
        worldLineChanged: false,
        changeLevel: 'minor',
        outlineChanges: { action: 'none', changes: '' },
        eventUpdates: [{ title: '神官现身', action: 'complete', changes: {} }],
        newChildEvents: [
          {
            title: '前往晨曦殿',
            description: '神官邀请旅人同行',
            parentTitle: '神官现身',
            triggerCondition: '旅人答应',
            depth: 1,
          },
        ],
      },
    },
    combat: null,
    diceUsed: [
      { sides: 20, index: 0, purpose: '交涉检定', target: '神官' },
      { sides: 20, index: 1, purpose: '感知检定', target: '旅人' },
      { sides: 6, index: 0, purpose: '祝福时长', target: '旅人' },
    ],
  };
}

const CHARACTER_UPDATES = JSON.stringify({
  characters: [
    {
      name: '神官',
      profile_changes: { goals: '迎接预言中的人' },
      chronicle: [
        {
          title: '侍奉黎明',
          summary: '她在神殿中长大并成为大神官。',
          time: { kind: 'past', label: '少年时期' },
          importance: 8,
          impact: '一生的信仰',
          location: '神殿',
          people: ['神官'],
        },
        {
          title: '遇见旅人',
          summary: '她在神殿接待了旅人。',
          time: { kind: 'this_turn' },
          importance: 7,
        },
      ],
    },
    { name: '旅人', profile_changes: {}, chronicle: [] },
  ],
});

describe('闸门 3：最大样例零纠正通过并能建补丁', () => {
  it.each(variants)(
    '%s：parseDirectOutput 无 normalized，buildDirectPatches 成功',
    (_l, structured) => {
      const raw = wrap(
        JSON.stringify(maximalUpdates()),
        CHARACTER_UPDATES,
        '钟声响起。\n<beat enter="神官"/>\n神官走下台阶。',
      );
      const draft: DirectTurnDraft = parseDirectOutput(raw, POOL, { structuredCombat: structured });
      expect(draft.normalized).toBeUndefined();
      expect(draft.dropped).toBeUndefined();
      expect(draft.flattenedCharacters).toBeUndefined();
      expect(draft.combatIgnored).toBeUndefined();
      expect(draft.characterUpdates.map((u) => u.name)).toEqual(['神官', '旅人']);
      const built = buildDirectPatches(draft, {
        characters: existing(),
        definitions: [],
        sourceTurnKey: 'u',
      });
      // 最大样例必须一条不丢地建成补丁（预演把提交时会抛的补丁提前丢掉，这里不该有）
      expect(built.dropped).toEqual([]);
      const priest = built.characters.find((c) => c.name === '神官');
      expect(priest?.ascension.law[0]?.name).toBe('昼夜轮转');
      expect(priest?.ascension.authority[0]?.costDescription).toBe('消耗大量 MP');
      const ops = new Set(built.patches.map((p) => p.op));
      for (const op of [
        'add_character',
        'update_character',
        'add_skill',
        'add_item',
        'add_status_effect',
        'update_status_effect',
        'remove_status_effect',
        'update_quest',
        'remove_quest',
      ])
        expect(ops).toContain(op);
    },
  );
});

describe('character_updates 的无损纠正并入 normalized', () => {
  it('代码围栏与缺 chronicle 各记一条，带 character_updates 前缀', () => {
    const body = JSON.stringify({ characters: [{ name: '旅人', profile_changes: {} }] });
    const fenced = `\`\`\`json\n${body}\n\`\`\``;
    const raw = wrap(
      '{"version":1,"world":{},"time":{"delta_time":0},"entities":[],"state":{},"effects":[],"plot":{},"combat":null,"diceUsed":[]}',
      fenced,
    );
    const draft = parseDirectOutput(raw, POOL);
    expect(draft.normalized).toHaveLength(2);
    expect(draft.normalized!.every((note) => note.startsWith('character_updates：'))).toBe(true);
  });
});
