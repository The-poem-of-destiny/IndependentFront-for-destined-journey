import { describe, expect, it } from 'vitest';
import {
  buildDirectPatches,
  parseDirectOutput,
  type DirectTurnDraft,
  type ParseDirectOutputOptions,
} from '../../../src/core/agents/direct-output';
import type { DirectDicePool } from '../../../src/core/agents/direct-dice';
import { createDefaultCharacterState, type CharacterState } from '../../../src/core/types/types';

type Row = Record<string, any>;

const POOL: DirectDicePool = [{ sides: 20, values: [7] }];

/** 合规的最小 direct_updates */
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
  return `<maintext>铁匠抬头看了你一眼。</maintext><options>1. 等待\n2. 离开</options><character_updates>${JSON.stringify({ characters: [] })}</character_updates><direct_updates>${inner}</direct_updates>`;
}

function parse(data: unknown, options?: ParseDirectOutputOptions): DirectTurnDraft {
  return parseDirectOutput(wrap(JSON.stringify(data)), POOL, options);
}

/** 合规的完整人物实体（铁匠） */
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

function withEntity(entity: Row): Row {
  const data = updates();
  data.entities.push(entity);
  return data;
}

function player(): CharacterState {
  return createDefaultCharacterState({ id: 'p', saveId: 's', name: '旅人', type: 'player' });
}

/** 新人物组装后的 add_character 值 */
function assembled(draft: DirectTurnDraft): CharacterState {
  const built = buildDirectPatches(draft, {
    characters: [player()],
    definitions: [],
    sourceTurnKey: 'u',
  });
  return built.characters[1];
}

function fullStatus(): Row {
  return {
    name: '专注',
    owner: '铁匠',
    description: '心无旁骛',
    category: '增益',
    stacks: 1,
    remainingTime: null,
    timeUnit: '分钟',
  };
}

describe('合规输入不触发归一化', () => {
  it('完整实体、效果与状态的 normalized 缺席', () => {
    const data = withEntity(smith());
    data.entities[0].output.statuses = [fullStatus()];
    data.effects.push({
      owner: '旅人',
      action: 'add',
      value: { ...fullStatus(), name: '鼓舞', owner: undefined },
    });
    data.state = { characters: { delta: [{ name: '旅人', path: 'hp', amount: -5 }] } };
    const draft = parse(data);
    expect(draft.normalized).toBeUndefined();
  });
});

describe('N1 direct_updates 内文剥壳', () => {
  it('```json 围栏被剥除后接纳', () => {
    const draft = parseDirectOutput(wrap('```json\n' + JSON.stringify(updates()) + '\n```'), POOL);
    expect(draft.normalized).toEqual(['direct_updates：已剥除 JSON 外的围栏或说明文字']);
  });
  it('剥壳后仍不是 JSON 照旧拒收', () => {
    expect(() => parseDirectOutput(wrap('```json\n{坏掉的\n```'), POOL)).toThrow(
      'direct_updates 不是合法 JSON',
    );
  });
});

describe('N2 顶层分区补齐', () => {
  it('缺失或 null 的分区补空值、version 缺失补 1', () => {
    const draft = parse({ world: null, combat: null });
    expect(draft.updates).toMatchObject({
      version: 1,
      world: {},
      time: { delta_time: 0 },
      entities: [],
      state: {},
      effects: [],
      plot: {},
      diceUsed: [],
    });
    expect(draft.normalized?.length).toBeGreaterThan(0);
    expect(draft.normalized).toContain('direct_updates.world：缺失，已补空值');
  });
  it('结构化战斗关闭时 combat 缺失补 null', () => {
    const { combat: _combat, ...rest } = updates();
    const draft = parse(rest, { structuredCombat: false });
    expect(draft.updates.combat).toBeNull();
    expect(draft.normalized).toBeUndefined();
  });
  it('version 存在但不为 1、分区类型错误、开启战斗缺 combat 仍拒', () => {
    expect(() => parse({ ...updates(), version: 2 })).toThrow('v1 分区不完整');
    expect(() => parse({ ...updates(), time: 'oops' })).toThrow('time 必须是对象');
    const { combat: _combat, ...rest } = updates();
    expect(() => parse(rest)).toThrow('v1 分区不完整');
  });
});

describe('N3 plot 纠正', () => {
  it('pre/post 为 null 时删键', () => {
    const draft = parse({ ...updates(), plot: { pre: null, post: { ok: true } } });
    expect(draft.updates.plot).toEqual({ post: { ok: true } });
    expect(draft.normalized).toEqual(['plot.pre：为 null，已删除']);
  });
  it('剧情关闭时非空 plot 整体丢弃', () => {
    const draft = parse({ ...updates(), plot: { pre: { a: 1 } } }, { plotEnabled: false });
    expect(draft.updates.plot).toEqual({});
    expect(draft.normalized).toEqual(['plot：剧情系统未启用，已丢弃']);
  });
  it('剧情开启时 pre 非对象仍拒', () => {
    expect(() => parse({ ...updates(), plot: { pre: '触发' } })).toThrow('剧情判断 必须是对象');
  });
});

describe('N4 随身列表补空数组', () => {
  it('output 与 character 的列表缺失或 null 补 []，statuses null 补 []', () => {
    const entity = smith();
    entity.output.skills = null;
    delete entity.output.character.equipment;
    entity.output.statuses = null;
    const draft = parse(withEntity(entity));
    const output = draft.updates.entities[0].output;
    expect(output.skills).toEqual([]);
    expect(output.statuses).toEqual([]);
    expect(output.character!.equipment).toEqual([]);
    expect(draft.normalized).toContain('entities[0].output.skills：缺失，已补默认值');
  });
  it('列表是其他非数组类型仍拒', () => {
    const entity = smith();
    entity.output.inventory = { name: '铁锭' };
    expect(() => parse(withEntity(entity))).toThrow('entities[0].output.inventory 必须是数组');
    const status = smith();
    status.output.statuses = '专注';
    expect(() => parse(withEntity(status))).toThrow('entities[0].output.statuses 必须是数组');
  });
});

describe('N5 登神状态纠正', () => {
  it('回归：laws 为字符串数组时接纳，组装出完整法则', () => {
    const entity = smith();
    entity.output.character.ascension.laws = ['统御法则'];
    const draft = parse(withEntity(entity));
    expect(draft.normalized?.length).toBeGreaterThan(0);
    expect(assembled(draft).ascension.law[0]).toEqual({
      name: '统御法则',
      description: '',
      effects: [],
      costDescription: '',
    });
  });
  it('ascension 缺失或 null 补未登神默认对象', () => {
    const entity = smith();
    entity.output.character.ascension = null;
    const draft = parse(withEntity(entity));
    expect(draft.updates.entities[0].output.character!.ascension).toEqual({
      enabled: false,
      path: '',
      description: '',
      elements: [],
      authorities: [],
      laws: [],
      deityPosition: '',
      divineKingdom: { name: '', description: '' },
    });
    expect(draft.normalized).toEqual([
      'entities[0].output.character.ascension：缺失，已补未登神默认值',
    ]);
  });
  it('键别名、enabled 推断、条目默认值、法则 effects 并入 passiveEffects、神国文本', () => {
    const entity = smith();
    entity.output.character.ascension = {
      authority: [{ name: '铸造权能', effects: '点石成铁' }],
      law: [{ name: '锻造法则', effects: ['火候'] }],
      elements: ['火之要素'],
      divineKingdom: '熔炉之国',
    };
    const draft = parse(withEntity(entity));
    const asc = draft.updates.entities[0].output.character!.ascension as unknown as Row;
    expect(asc).toMatchObject({
      enabled: true,
      path: '',
      description: '',
      elements: [{ name: '火之要素', description: '', effects: [] }],
      authorities: [
        { name: '铸造权能', description: '', effects: ['点石成铁'], costDescription: '' },
      ],
      laws: [
        {
          name: '锻造法则',
          description: '',
          passiveEffects: ['火候'],
          activeEffects: [],
          costDescription: '',
        },
      ],
      divineKingdom: { name: '熔炉之国', description: '' },
    });
    expect(asc).not.toHaveProperty('authority');
    expect(asc).not.toHaveProperty('law');
    expect(assembled(draft).ascension.law[0].effects).toEqual(['火候']);
  });
  it('loadout 顶层 ascension 缺席保持缺席，给出时按同口径纠正', () => {
    const data = updates();
    data.entities.push(
      { kind: 'loadout', owner: '旅人', output: { skills: [], equipment: [], inventory: [] } },
      {
        kind: 'loadout',
        owner: '旅人',
        output: { skills: [], equipment: [], inventory: [], ascension: { laws: ['统御法则'] } },
      },
    );
    const draft = parse(data);
    expect(draft.updates.entities[0].output).not.toHaveProperty('ascension');
    expect(draft.updates.entities[1].output.ascension?.laws[0]).toMatchObject({
      name: '统御法则',
      passiveEffects: [],
    });
  });
  it('人物实体的 ascension 写在 output 顶层而 character 内没有：搬进人物并保留登神', () => {
    const entity = smith();
    delete entity.output.character.ascension;
    entity.output.ascension = {
      enabled: true,
      path: '战争',
      description: '以战止战',
      elements: [],
      authorities: [],
      laws: [{ name: '统御法则', description: '号令', passiveEffects: [], activeEffects: [] }],
    };
    const draft = parse(withEntity(entity));
    const output = draft.updates.entities[0].output;
    expect(output).not.toHaveProperty('ascension');
    expect(output.character!.ascension).toMatchObject({ enabled: true, path: '战争' });
    expect(draft.normalized).toContain(
      'entities[0].output.ascension：已搬进 entities[0].output.character.ascension',
    );
    const character = assembled(draft);
    expect(character.ascension.enabled).toBe(true);
    expect(character.ascension.law[0].name).toBe('统御法则');
  });
  it('人物实体的 output 顶层与 character 内同时写 ascension 时拒收', () => {
    const entity = smith();
    entity.output.ascension = { ...entity.output.character.ascension, enabled: true };
    expect(() => parse(withEntity(entity))).toThrow(
      'entities[0].output.ascension 与 entities[0].output.character.ascension 同时出现',
    );
  });
  it('人物内登神条目缺名（无 name / 空串 / 空文本条目）丢弃并记 note，不整楼拒收', () => {
    const entity = smith();
    entity.output.character.ascension.laws = [
      { description: '无名' },
      { name: '统御法则', description: '号令' },
      { name: '  ', description: '空白名' },
    ];
    entity.output.character.ascension.elements = [''];
    const draft = parse(withEntity(entity));
    const asc = draft.updates.entities[0].output.character!.ascension as unknown as Row;
    expect(asc.laws.map((law: Row) => law.name)).toEqual(['统御法则']);
    expect(asc.elements).toEqual([]);
    const label = 'entities[0].output.character.ascension';
    expect(draft.normalized).toEqual(
      expect.arrayContaining([
        `${label}.laws[0]：缺少名字，已忽略`,
        `${label}.laws[2]：缺少名字，已忽略`,
        `${label}.elements[0]：缺少名字，已忽略`,
        // 留下的条目按模型原文下标记 note
        `${label}.laws[1].passiveEffects：缺失，已补默认值`,
      ]),
    );
    expect(assembled(draft).ascension.law.map((law: Row) => law.name)).toEqual(['统御法则']);
  });
  it('loadout 顶层登神条目缺名同口径丢弃；全部丢弃后缺 enabled 推断为 false', () => {
    const data = updates();
    data.entities.push({
      kind: 'loadout',
      owner: '旅人',
      output: {
        skills: [],
        equipment: [],
        inventory: [],
        ascension: { authorities: [{ description: '无名权能' }] },
      },
    });
    const draft = parse(data);
    const asc = draft.updates.entities[0].output.ascension as unknown as Row;
    expect(asc.authorities).toEqual([]);
    expect(asc.enabled).toBe(false);
    expect(draft.normalized).toEqual(
      expect.arrayContaining([
        'entities[0].output.ascension.authorities[0]：缺少名字，已忽略',
        'entities[0].output.ascension.enabled：缺失，已按条目推断',
      ]),
    );
  });
  it('人物 elements 丢弃缺名条目时连带删除 output 顶层同下标效果，存活条目拿到原对应效果', () => {
    const entity = smith();
    entity.output.character.ascension.elements = [{ description: '无名' }, { name: '火' }];
    entity.output.elements = [
      { effectDescriptions: { 灼烧: '甲' } },
      { effectDescriptions: { 灼烧: '乙' } },
    ];
    const draft = parse(withEntity(entity));
    expect(draft.updates.entities[0].output.elements).toEqual([
      { effectDescriptions: { 灼烧: '乙' } },
    ]);
    expect(draft.normalized).toEqual(
      expect.arrayContaining([
        'entities[0].output.character.ascension.elements[0]：缺少名字，已忽略',
        'entities[0].output.elements[0]：对应的登神条目缺少名字，已连带删除',
      ]),
    );
    const elements = assembled(draft).ascension.elements;
    expect(elements.map((e) => e.name)).toEqual(['火']);
    expect(elements[0].effectDescriptions).toEqual({ 灼烧: '乙' });
  });
  it('loadout authorities 丢弃缺名条目时连带删除 output 顶层同下标效果（从后往前删不错位）', () => {
    const data = updates();
    data.entities.push({
      kind: 'loadout',
      owner: '旅人',
      output: {
        skills: [],
        equipment: [],
        inventory: [],
        ascension: {
          authorities: [
            { description: '无名甲' },
            { name: '铸造权能' },
            { name: '' },
            { name: '统御权能' },
          ],
        },
        authorities: [
          { effectDescriptions: { 甲: '甲' } },
          { effectDescriptions: { 乙: '乙' } },
          { effectDescriptions: { 丙: '丙' } },
          { effectDescriptions: { 丁: '丁' } },
        ],
      },
    });
    const draft = parse(data);
    expect(draft.normalized).toEqual(
      expect.arrayContaining([
        'entities[0].output.authorities[0]：对应的登神条目缺少名字，已连带删除',
        'entities[0].output.authorities[2]：对应的登神条目缺少名字，已连带删除',
      ]),
    );
    const built = buildDirectPatches(draft, {
      characters: [player()],
      definitions: [],
      sourceTurnKey: 'u',
    });
    const patch = built.patches.find(
      (p) => p.op === 'update_character' && p.metadata?.kind === 'ascension',
    );
    expect(patch).toBeDefined();
    const authority = (patch!.value as { ascension: CharacterState['ascension'] }).ascension
      .authority;
    expect(authority.map((a) => [a.name, a.effectDescriptions])).toEqual([
      ['铸造权能', { 乙: '乙' }],
      ['统御权能', { 丁: '丁' }],
    ]);
  });
  it('output 顶层效果数组短于缺名条目下标时不越界删除', () => {
    const entity = smith();
    entity.output.character.ascension.elements = [{ name: '火' }, { description: '无名' }];
    entity.output.elements = [{ effectDescriptions: { 灼烧: '甲' } }];
    const draft = parse(withEntity(entity));
    expect(draft.updates.entities[0].output.elements).toEqual([
      { effectDescriptions: { 灼烧: '甲' } },
    ]);
    expect(draft.normalized).not.toContain(
      'entities[0].output.elements[1]：对应的登神条目缺少名字，已连带删除',
    );
    expect(assembled(draft).ascension.elements[0].effectDescriptions).toEqual({ 灼烧: '甲' });
  });
  it('enabled 类型错误仍拒', () => {
    const badEnabled = smith();
    badEnabled.output.character.ascension.enabled = 'yes';
    expect(() => parse(withEntity(badEnabled))).toThrow('登神状态不完整');
  });
});

describe('N6 实体初始状态 owner 补全', () => {
  it('人物实体与 loadout 的状态缺 owner 时补归属名并补默认字段', () => {
    const entity = smith();
    entity.output.statuses = [{ name: '专注' }];
    const data = withEntity(entity);
    data.entities.push({
      kind: 'loadout',
      owner: '旅人',
      output: { skills: [], equipment: [], inventory: [], statuses: [{ name: '疲惫' }] },
    });
    const draft = parse(data);
    expect(draft.updates.entities[0].output.statuses![0]).toEqual({
      name: '专注',
      owner: '铁匠',
      description: '',
      category: '特殊',
      stacks: 1,
      timeUnit: '分钟',
    });
    expect(draft.updates.entities[1].output.statuses![0].owner).toBe('旅人');
    expect(draft.normalized).toContain(
      'entities[0].output.statuses[0].owner：缺失，已补为「铁匠」',
    );
  });
  it('实体 statuses 缺 remainingTime 时不补（与 HEAD 相同：保留已有效果的时长）', () => {
    const data = updates();
    data.entities.push({
      kind: 'loadout',
      owner: '旅人',
      output: {
        skills: [],
        equipment: [],
        inventory: [],
        statuses: [
          {
            name: '中毒',
            owner: '旅人',
            description: '毒素',
            category: '减益',
            stacks: 1,
            timeUnit: '分钟',
          },
        ],
      },
    });
    const draft = parse(data);
    const status = draft.updates.entities[0].output.statuses![0];
    expect(status).not.toHaveProperty('remainingTime');
    expect(draft.normalized).toBeUndefined();
    const built = buildDirectPatches(draft, {
      characters: [player()],
      definitions: [],
      sourceTurnKey: 'u',
    });
    const patch = built.patches.find((p) => p.op === 'add_status_effect');
    expect(patch).toBeDefined();
    expect((patch!.value as Row).remainingTime).toBeUndefined();
  });
  it('owner 给了但不符仍拒', () => {
    const entity = smith();
    entity.output.statuses = [{ ...fullStatus(), owner: '旅人' }];
    expect(() => parse(withEntity(entity))).toThrow('实体初始状态的归属错误');
  });
});

describe('N7 人物文本字段', () => {
  it('identity/occupation 文本转数组、缺失补 []，文本字段缺失或 null 补空串', () => {
    const entity = smith();
    const c = entity.output.character;
    c.identity = '铁匠';
    delete c.occupation;
    c.race = null;
    delete c.likes;
    const draft = parse(withEntity(entity));
    const character = draft.updates.entities[0].output.character!;
    expect(character.identity).toEqual(['铁匠']);
    expect(character.occupation).toEqual([]);
    expect(character.race).toBe('');
    expect(character.likes).toBe('');
    expect(draft.normalized).toContain('entities[0].output.character.identity：文本已转为数组');
  });
  it('硬性必填缺失或类型错误仍拒', () => {
    const noTier = smith();
    delete noTier.output.character.tier;
    expect(() => parse(withEntity(noTier))).toThrow('人物层级无效');
    const badIdentity = smith();
    badIdentity.output.character.identity = 3;
    expect(() => parse(withEntity(badIdentity))).toThrow('人物缺少 identity');
    const badRace = smith();
    badRace.output.character.race = 1;
    expect(() => parse(withEntity(badRace))).toThrow('人物缺少 race');
  });
});

describe('N8 effects 行纠正', () => {
  it('平铺行收进 value，add 补默认字段并归一分类', () => {
    const data = updates();
    data.effects.push(
      { owner: '旅人', action: 'add', name: '鼓舞', category: 'buff' },
      { owner: '旅人', action: 'remove', value: { name: '中毒', stacks: 2 } },
    );
    const draft = parse(data);
    expect(draft.updates.effects[0].value).toEqual({
      name: '鼓舞',
      description: '',
      category: '增益',
      stacks: 1,
      remainingTime: null,
      timeUnit: '分钟',
    });
    expect(draft.updates.effects[1].value).toEqual({ name: '中毒' });
    expect(draft.normalized).toContain('effects[0]：效果字段已收进 value');
    expect(draft.normalized).toContain(
      'effects[0].value.remainingTime：缺失，已补 null（按永久处理）',
    );
    expect(draft.normalized).toContain(
      'effects[0].value.category：「buff」不在分类枚举内，已映射为「增益」（效果名不变）',
    );
    expect(draft.normalized).toContain('effects[1].value.stacks：移除效果不需要，已剥除');
  });
  it('枚举外的分类文本映射为「特殊」，效果名保留', () => {
    const data = updates();
    data.effects.push({
      owner: '旅人',
      action: 'add',
      value: {
        name: '厄运诅咒',
        description: '霉运缠身',
        category: '诅咒',
        stacks: 1,
        remainingTime: 10,
        timeUnit: '分钟',
      },
    });
    const draft = parse(data);
    expect(draft.updates.effects[0].value).toMatchObject({ name: '厄运诅咒', category: '特殊' });
    expect(draft.normalized).toEqual([
      'effects[0].value.category：「诅咒」不在分类枚举内，已映射为「特殊」（效果名不变）',
    ]);
  });
  it('平铺 effects 行带 __proto__ 时拒收', () => {
    const data = updates();
    data.effects.push({ owner: '旅人', action: 'add', name: '鼓舞' });
    const raw = JSON.stringify(data).replace(
      '"name":"鼓舞"',
      '"name":"鼓舞","__proto__":{"description":"x","category":"增益","stacks":9,"remainingTime":5,"timeUnit":"回合"}',
    );
    expect(() => parseDirectOutput(wrap(raw), POOL)).toThrow('不允许模型填写 __proto__');
  });
  it('同一角色同名效果先 remove 再 add 仍拒（协议已写明只写一行）', () => {
    const data = updates();
    data.effects.push(
      { owner: '旅人', action: 'remove', value: { name: '中毒' } },
      {
        owner: '旅人',
        action: 'add',
        value: { ...fullStatus(), owner: undefined, name: '中毒', remainingTime: 10 },
      },
    );
    expect(() => parse(data)).toThrow('状态效果重复声明');
  });
  it('update 多余键、非法分类类型、非法层数仍拒', () => {
    const update = updates();
    update.effects.push({
      owner: '旅人',
      action: 'update',
      value: { name: '鼓舞', category: '增益' },
    });
    expect(() => parse(update)).toThrow('效果更新 含未支持的字段：category');
    const category = updates();
    category.effects.push({ owner: '旅人', action: 'add', value: { name: '鼓舞', category: 1 } });
    expect(() => parse(category)).toThrow('效果缺少描述／分类');
    const stacks = updates();
    stacks.effects.push({ owner: '旅人', action: 'add', value: { name: '鼓舞', stacks: 0 } });
    expect(() => parse(stacks)).toThrow('效果层数无效');
  });
});

describe('N9 条目默认字段', () => {
  it('装备 stats、背包数量、描述与 placement.present 缺失补默认', () => {
    const entity = smith();
    delete entity.placement.present;
    entity.output.equipment = [{ name: '铁锤', slot: '主手' }];
    entity.output.inventory = [{ name: '铁锭', description: '原料' }];
    entity.output.skills = [{ name: '锻打', type: 'active' }];
    const draft = parse(withEntity(entity));
    const row = draft.updates.entities[0] as Row;
    expect(row.placement.present).toBe(true);
    expect(row.output.equipment[0]).toMatchObject({ stats: {}, description: '' });
    expect(row.output.inventory[0].quantity).toBe(1);
    expect(row.output.skills[0].description).toBe('');
    expect(draft.normalized).toContain('entities[0].placement.present：缺失，已补 true');
  });
  it('数量非正整数、present 非布尔仍拒', () => {
    const quantity = smith();
    quantity.output.inventory = [{ name: '铁锭', description: '原料', quantity: 0 }];
    expect(() => parse(withEntity(quantity))).toThrow('物品数量必须为正整数');
    const present = smith();
    present.placement.present = 'yes';
    expect(() => parse(withEntity(present))).toThrow('placement.present 缺失');
  });
});

describe('N10 账务键剥除', () => {
  it('任意层级的 id/saveId/introducedBy/definition 被剥除', () => {
    const entity = smith();
    entity.output.character.id = 'npc-1';
    entity.output.character.definition = { id: 'x' };
    entity.output.skills = [{ name: '锻打', description: '敲打', saveId: 's' }];
    const data = withEntity(entity);
    data.state = {
      characters: {
        replace: [{ name: '旅人', path: 'thoughts', value: '饿了', introducedBy: 'u' }],
      },
    };
    const draft = parse(data);
    const output = draft.updates.entities[0].output as Row;
    expect(output.character).not.toHaveProperty('id');
    expect(output.character).not.toHaveProperty('definition');
    expect(output.skills[0]).not.toHaveProperty('saveId');
    expect(draft.normalized).toContain(
      'direct_updates.entities[0].output.character.id：模型不应填写，已剥除',
    );
  });
  it('world 各操作 value 里的 definition / id 不剥除，照旧拒收', () => {
    const data = updates();
    data.world = {
      replace: [{ path: '世界.术语', value: { name: '以太', definition: '魔力的源头' } }],
    };
    expect(() => parse(data)).toThrow('不允许模型填写 definition');
    const insert = updates();
    insert.world = { insert: [{ path: '世界.名录', value: { id: 'm1', name: '以太' } }] };
    expect(() => parse(insert)).toThrow('不允许模型填写 id');
  });
  it('world 系统状态段（如 profile）仍拒', () => {
    const data = updates();
    data.world = { replace: [{ path: '势力.profile.口号', value: 'x' }] };
    expect(() => parse(data)).toThrow('world 不能写系统状态');
  });
  it('平铺人物带 __proto__ 时拒收（不会被收拢成设原型）', () => {
    const entity = smith();
    const { skills, equipment, inventory, ...character } = entity.output.character;
    entity.output = { ...character, skills, equipment, inventory };
    delete entity.output.tier;
    delete entity.output.level;
    const raw = JSON.stringify(withEntity(entity)).replace(
      '"name":"铁匠"',
      '"name":"铁匠","__proto__":{"tier":7,"level":25}',
    );
    expect(() => parseDirectOutput(wrap(raw), POOL)).toThrow('不允许模型填写 __proto__');
  });
  it('原型污染键仍拒', () => {
    const proto = JSON.stringify(updates()).replace('"world":{}', '"world":{"__proto__":{"x":1}}');
    expect(() => parseDirectOutput(wrap(proto), POOL)).toThrow('不允许模型填写 __proto__');
    const data = withEntity(smith());
    data.entities[0].output.character.constructor = 'x';
    expect(() => parse(data)).toThrow('不允许模型填写 constructor');
  });
});

describe('N11 delta 行 value 改 amount', () => {
  it('人物与好感度 delta 缺 amount 且 value 是数值时取 value', () => {
    const data = updates();
    data.state = {
      characters: { delta: [{ name: '旅人', path: 'hp', value: -10 }] },
      affections: { delta: [{ name: '铁匠', value: 5 }] },
    };
    const draft = parse(data);
    const state = draft.updates.state as Row;
    expect(state.characters.delta[0]).toEqual({ name: '旅人', path: 'hp', amount: -10 });
    expect(state.affections.delta[0]).toEqual({ name: '铁匠', amount: 5 });
    expect(draft.normalized).toEqual([
      'state.characters.delta[0]：value 已改为 amount',
      'state.affections.delta[0]：value 已改为 amount',
    ]);
  });
  it('value 不是数值仍拒', () => {
    const data = updates();
    data.state = { characters: { delta: [{ name: '旅人', path: 'hp', value: '-10' }] } };
    expect(() => parse(data)).toThrow('delta 只能用于资源／金钱／经验');
    const affection = updates();
    affection.state = { affections: { delta: [{ name: '铁匠', value: '5' }] } };
    expect(() => parse(affection)).toThrow('好感度必须为数值');
  });
});

describe('校验报错文案', () => {
  it('名字为空时报出路径', () => {
    const data = updates();
    data.effects.push({ owner: '', action: 'remove', value: { name: '中毒' } });
    expect(() => parse(data)).toThrow('effects[0].owner 名字／引用不能为空');
  });
  it('remove 非 skills/equipment 时指明状态效果走 effects', () => {
    const data = updates();
    data.state = {
      characters: { remove: [{ name: '旅人', path: 'statusEffects', target: '中毒' }] },
    };
    expect(() => parse(data)).toThrow(
      'state.characters.remove 只支持 skills／equipment（状态效果走 effects）',
    );
  });
});
