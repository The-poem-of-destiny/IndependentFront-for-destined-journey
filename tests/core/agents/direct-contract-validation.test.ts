/**
 * 直出校验按契约类型表（DIRECT_VALUE_TYPES）检查值类型，以及归一化 / 校验器分工的回归用例
 * （2026-11-25 整合审查 R1 + A2：update / modify / upsert 不查值类型；normalize 与 output 交叠）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildDirectPatches,
  parseDirectOutput,
  type DirectTurnDraft,
} from '../../../src/core/agents/direct-output';
import {
  DIRECT_CHARACTER_FIELDS,
  DIRECT_EFFECT_REMOVE_KEYS,
  DIRECT_EFFECT_UPDATE_KEYS,
  DIRECT_ITEM_MODIFY_KEYS,
  DIRECT_QUEST_UPSERT_KEYS,
  DIRECT_SECTIONS,
  DIRECT_VALUE_TYPES,
  emptyDirectSections,
  emptyDirectUpdates,
} from '../../../src/core/agents/direct-contract';
import { normalizeDirectUpdates } from '../../../src/core/agents/direct-normalize';
import type { DirectDicePool } from '../../../src/core/agents/direct-dice';
import { createDefaultCharacterState, type StatePatch } from '../../../src/core/types/types';

type Row = Record<string, any>;

const POOL: DirectDicePool = [{ sides: 20, values: [7] }];

function updates(): Row {
  return {
    version: 1,
    world: {},
    time: { delta_time: 0 },
    entities: [],
    state: {},
    effects: [],
    plot: {},
    combat: null,
    diceUsed: [],
  };
}

function wrap(inner: string): string {
  return `<maintext>铁匠抬头看了你一眼。</maintext><character_updates>${JSON.stringify({ characters: [] })}</character_updates><direct_updates>${inner}</direct_updates>`;
}

function parse(data: unknown): DirectTurnDraft {
  return parseDirectOutput(wrap(JSON.stringify(data)), POOL);
}

function patchesOf(draft: DirectTurnDraft): StatePatch[] {
  const player = createDefaultCharacterState({
    id: 'p',
    saveId: 's',
    name: '旅人',
    type: 'player',
  });
  return buildDirectPatches(draft, { characters: [player], definitions: [], sourceTurnKey: 'u' })
    .patches;
}

/** 补丁里有没有提到某个名字（不依赖具体 op 名） */
function mentions(patches: StatePatch[], name: string): boolean {
  return patches.some((patch) => JSON.stringify(patch).includes(name));
}

function smith(): Row {
  return {
    kind: 'character',
    placement: { location: '铁匠铺', present: true },
    output: {
      skills: [],
      equipment: [],
      inventory: [],
      character: {
        name: '铁匠',
        race: '人类',
        gender: '男',
        tier: 1,
        level: 1,
        attributes: { str: 5, dex: 5, con: 5, int: 5, spi: 5 },
        identity: ['铁匠'],
        occupation: [],
        background: '在城里长大',
        appearance: '围裙',
        clothing: '工作服',
        personality: '直率',
        likes: '打铁',
        skills: [],
        equipment: [],
        inventory: [],
        ascension: {
          enabled: false,
          path: '',
          description: '',
          elements: [],
          authorities: [],
          laws: [],
        },
      },
    },
  };
}

describe('契约类型表', () => {
  it('每张类型表的键集合与对应白名单一致', () => {
    const keys = (table: object) => Object.keys(table).sort();
    expect(keys(DIRECT_VALUE_TYPES.characterReplace)).toEqual([...DIRECT_CHARACTER_FIELDS].sort());
    expect(keys(DIRECT_VALUE_TYPES.itemModify)).toEqual([...DIRECT_ITEM_MODIFY_KEYS].sort());
    expect(keys(DIRECT_VALUE_TYPES.questUpsert)).toEqual([...DIRECT_QUEST_UPSERT_KEYS].sort());
    expect(keys(DIRECT_VALUE_TYPES.effectUpdate)).toEqual([...DIRECT_EFFECT_UPDATE_KEYS].sort());
    expect(keys(DIRECT_VALUE_TYPES.effectRemove)).toEqual([...DIRECT_EFFECT_REMOVE_KEYS].sort());
  });

  it('分区空骨架只有一份：键序同 DIRECT_SECTIONS，每次调用返回新对象', () => {
    expect(Object.keys(emptyDirectUpdates())).toEqual([...DIRECT_SECTIONS]);
    expect(emptyDirectUpdates()).toEqual(updates());
    const a = emptyDirectSections();
    const b = emptyDirectSections();
    expect(a).toEqual(b);
    expect(a.entities).not.toBe(b.entities);
  });

  it('没写 direct_updates 区块时用同一份空骨架', () => {
    const draft = parseDirectOutput(
      `<maintext>风停了。</maintext><character_updates>{"characters":[]}</character_updates>`,
      POOL,
    );
    expect(draft.updatesMissing).toBe(true);
    expect(draft.updates).toEqual(emptyDirectUpdates());
  });
});

describe('effects update 值类型', () => {
  it('remainingTime 写成文本：只丢该行并记 dropped，不出补丁', () => {
    const data = updates();
    data.effects.push(
      { owner: '旅人', action: 'update', value: { name: '鼓舞', remainingTime: '3小时' } },
      { owner: '旅人', action: 'update', value: { name: '专注', remainingTime: 30 } },
    );
    const draft = parse(data);
    expect(draft.content).toBe('铁匠抬头看了你一眼。');
    expect(draft.updates.effects).toEqual([
      { owner: '旅人', action: 'update', value: { name: '专注', remainingTime: 30 } },
    ]);
    expect(draft.dropped).toEqual([
      'effects[0]：value.remainingTime 必须是非负数值或 null，已忽略',
    ]);
    expect(mentions(patchesOf(draft), '鼓舞')).toBe(false);
  });

  // 第 2 波审查跟进：非正 stacks 按旧行为收下（StateManager 忽略非正层数、时长照改），不丢整行
  it('remainingTime 为 null（改为永久）照收；stacks 非正数照收不丢行，stacks 不是数值才丢', () => {
    const data = updates();
    data.effects.push(
      { owner: '旅人', action: 'update', value: { name: '鼓舞', remainingTime: null } },
      { owner: '旅人', action: 'update', value: { name: '专注', stacks: -1 } },
      { owner: '旅人', action: 'update', value: { name: '迟缓', stacks: '两层' } },
    );
    const draft = parse(data);
    expect(draft.updates.effects.map((effect) => effect.value.name)).toEqual(['鼓舞', '专注']);
    expect(draft.dropped).toEqual(['effects[2]：value.stacks 必须是数值，已忽略']);
  });

  it('update 的 stacks 为 null 当缺席剥掉、记纠正，remainingTime 照改', () => {
    const data = updates();
    data.effects.push({
      owner: '旅人',
      action: 'update',
      value: { name: '鼓舞', remainingTime: 3, stacks: null },
    });
    const draft = parse(data);
    expect(draft.dropped).toBeUndefined();
    expect(draft.updates.effects).toEqual([
      { owner: '旅人', action: 'update', value: { name: '鼓舞', remainingTime: 3 } },
    ]);
    expect(draft.normalized).toEqual(['effects[0].value.stacks：为 null，已按未填写处理']);
    const patch = patchesOf(draft).find((p) => p.op === 'update_status_effect');
    expect(patch?.value).toEqual({ name: '鼓舞', remainingTime: 3 });
  });

  it('update 的 stacks 为 0 照常落补丁（层数由 StateManager 忽略，时长照改）', () => {
    const data = updates();
    data.effects.push({
      owner: '旅人',
      action: 'update',
      value: { name: '鼓舞', remainingTime: 3, stacks: 0 },
    });
    const draft = parse(data);
    expect(draft.dropped).toBeUndefined();
    const patch = patchesOf(draft).find((p) => p.op === 'update_status_effect');
    expect(patch?.value).toEqual({ name: '鼓舞', remainingTime: 3, stacks: 0 });
  });

  it('只写 stacks: null 时没有可改字段：丢该行', () => {
    const data = updates();
    data.effects.push({ owner: '旅人', action: 'update', value: { name: '鼓舞', stacks: null } });
    const draft = parse(data);
    expect(draft.updates.effects).toEqual([]);
    expect(draft.dropped).toEqual(['effects[0]：效果更新只能改 remainingTime／stacks，已忽略']);
    // 被丢的行不再留「null 已按未填写处理」的纠正（一个单元只记一条）
    expect(draft.normalized).toBeUndefined();
  });

  it('stacks: null 与坏时长同行：整行丢弃，单元内纠正一并撤回', () => {
    const data = updates();
    data.effects.push({
      owner: '旅人',
      action: 'update',
      value: { name: '专注', stacks: null, remainingTime: '3小时' },
    });
    const draft = parse(data);
    expect(draft.updates.effects).toEqual([]);
    expect(draft.dropped).toHaveLength(1);
    expect(draft.normalized).toBeUndefined();
  });
});

describe('items.modify changes 值类型', () => {
  it('changes.stats 写成文本：只丢该行并记 dropped，不出补丁', () => {
    const data = updates();
    data.state = {
      items: {
        modify: [
          { owner: '旅人', target: '短剑', changes: { stats: 'abc' } },
          { owner: '旅人', target: '皮甲', changes: { description: '缝补过' } },
        ],
      },
    };
    const draft = parse(data);
    expect((draft.updates.state as Row).items.modify).toEqual([
      { owner: '旅人', target: '皮甲', changes: { description: '缝补过' } },
    ]);
    expect(draft.dropped).toEqual([
      'state.items.modify[0]：changes.stats 必须是值全为数值的对象，已忽略',
    ]);
    expect(mentions(patchesOf(draft), '短剑')).toBe(false);
  });

  it('耐久为负、tags 不是文本数组、effects 值不是文本：各丢该行', () => {
    const data = updates();
    data.state = {
      items: {
        modify: [
          { owner: '旅人', target: '甲', changes: { durability: -3 } },
          { owner: '旅人', target: '乙', changes: { tags: ['锋利', 3] } },
          { owner: '旅人', target: '丙', changes: { effects: { 锋利: 5 } } },
          { owner: '旅人', target: '丁', changes: { stats: { 攻击: 3 }, tags: ['锋利'] } },
        ],
      },
    };
    const draft = parse(data);
    expect((draft.updates.state as Row).items.modify.map((row: Row) => row.target)).toEqual(['丁']);
    expect(draft.dropped).toEqual([
      'state.items.modify[0]：changes.durability 必须是非负数值，已忽略',
      'state.items.modify[1]：changes.tags 必须是文本数组，已忽略',
      'state.items.modify[2]：changes.effects 必须是值全为文本的对象，已忽略',
    ]);
  });
});

describe('quests.upsert 白名单与值类型', () => {
  it('白名单外的键被剥除并记 note（每行合成一条），不记 dropped', () => {
    const data = updates();
    data.state = {
      quests: { upsert: [{ name: '寻剑', progress: '已到铁匠铺', secret: '幕后', level: 3 }] },
    };
    const draft = parse(data);
    expect((draft.updates.state as Row).quests.upsert).toEqual([
      { name: '寻剑', progress: '已到铁匠铺' },
    ]);
    expect(draft.normalized).toEqual([
      'state.quests.upsert[0]：任务没有字段 secret、level，已剥除',
    ]);
    expect(draft.dropped).toBeUndefined();
    const quest = patchesOf(draft).find((patch) => patch.op === 'update_quest');
    expect(quest?.value).toEqual({ name: '寻剑', progress: '已到铁匠铺' });
  });

  it('字段值不是文本：只丢该行', () => {
    const data = updates();
    data.state = {
      quests: {
        upsert: [
          { name: '寻剑', progress: 3 },
          { name: '护送', status: '进行中' },
        ],
      },
    };
    const draft = parse(data);
    expect((draft.updates.state as Row).quests.upsert).toEqual([
      { name: '护送', status: '进行中' },
    ]);
    expect(draft.dropped).toEqual(['state.quests.upsert[0]：progress 必须是文本，已忽略']);
  });

  it('可选字段为 null（reward: null）当缺席剥掉、记纠正，该行照常落', () => {
    const data = updates();
    data.state = {
      quests: { upsert: [{ name: '寻剑', status: '已完成', reward: null }] },
    };
    const draft = parse(data);
    expect(draft.dropped).toBeUndefined();
    expect(draft.normalized).toEqual(['state.quests.upsert[0].reward：为 null，已按未填写处理']);
    const quest = patchesOf(draft).find((patch) => patch.op === 'update_quest');
    expect(quest?.value).toEqual({ name: '寻剑', status: '已完成' });
  });

  it('多余键很多时一行只记一条，按 5 个键与单键 24 字截断', () => {
    const long = '很'.repeat(30);
    const row: Row = { name: '寻剑', status: '进行中' };
    for (const key of ['a', 'b', 'c', 'd', long, 'f', 'g']) row[key] = 1;
    const data = updates();
    data.state = { quests: { upsert: [row] } };
    const draft = parse(data);
    expect((draft.updates.state as Row).quests.upsert).toEqual([
      { name: '寻剑', status: '进行中' },
    ]);
    expect(draft.normalized).toEqual([
      `state.quests.upsert[0]：任务没有字段 a、b、c、d、${'很'.repeat(24)}… 等 7 个，已剥除`,
    ]);
  });
});

describe('state.characters.replace 按类型表检查', () => {
  it('沿用既有文案：资源值 / present / 文本字段', () => {
    const data = updates();
    data.state = {
      characters: {
        replace: [
          { name: '旅人', path: 'hp', value: 'abc' },
          { name: '旅人', path: 'present', value: 'yes' },
          { name: '旅人', path: 'thoughts', value: 3 },
          { name: '旅人', path: 'location', value: '铁匠铺' },
        ],
      },
    };
    const draft = parse(data);
    expect(draft.dropped).toEqual([
      'state.characters.replace[0]：资源值无效，已忽略',
      'state.characters.replace[1]：present 必须是布尔值，已忽略',
      'state.characters.replace[2]：人物字段必须为文本，已忽略',
    ]);
    expect((draft.updates.state as Row).characters.replace).toEqual([
      { name: '旅人', path: 'location', value: '铁匠铺' },
    ]);
  });
});

describe('归一化与校验器分工', () => {
  it('归一化不再产出 dropped（有损丢弃全归校验器）', () => {
    const data = updates();
    const entity = smith();
    entity.output.character.ascension.laws = { name: '坏' };
    data.entities.push(entity);
    const result = normalizeDirectUpdates(data, { structuredCombat: true, plotEnabled: true });
    expect(result).not.toHaveProperty('dropped');
    // 坏形状原样留给校验器
    expect(data.entities[0].output.character.ascension.laws).toEqual({ name: '坏' });
  });

  it('effects remove 的多余键只在归一化剥一次（记 note，不记 dropped）', () => {
    const data = updates();
    data.effects.push({ owner: '旅人', action: 'remove', value: { name: '中毒', stacks: 2 } });
    const draft = parse(data);
    expect(draft.updates.effects[0].value).toEqual({ name: '中毒' });
    expect(draft.normalized).toEqual(['effects[0].value.stacks：移除效果不需要，已剥除']);
    expect(draft.dropped).toBeUndefined();
  });

  it('登神坏条目随实体一起被丢时只记实体那一条', () => {
    const entity = smith();
    entity.output.character.ascension.laws = [{ description: '无名' }];
    delete entity.output.character.tier;
    const data = updates();
    data.entities.push(entity);
    const draft = parse(data);
    expect(draft.updates.entities).toEqual([]);
    expect(draft.dropped).toEqual(['entities[0]：人物层级无效，已忽略']);
  });

  it('关闭结构化战斗时 combat 里的原型污染键不拒收（combat 先被丢弃，再扫描）', () => {
    const raw = JSON.stringify(updates()).replace(
      '"combat":null',
      '"combat":{"__proto__":{"x":1}}',
    );
    const draft = parseDirectOutput(wrap(raw), POOL, { structuredCombat: false });
    expect(draft.combatIgnored).toBe(true);
  });

  it('原型污染键整楼拒收（扫描只此一处，先于归一化）', () => {
    const raw = JSON.stringify(updates()).replace(
      '"state":{}',
      '"state":{"quests":{"upsert":[{"name":"寻剑","__proto__":{"x":1}}]}}',
    );
    expect(() => parseDirectOutput(wrap(raw), POOL)).toThrow(
      '直出结果无效：不允许模型填写 __proto__',
    );
  });
});
