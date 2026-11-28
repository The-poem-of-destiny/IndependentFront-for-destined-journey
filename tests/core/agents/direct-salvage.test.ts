/**
 * 直出结果按最小单元丢弃：坏单元删掉并记入 dropped，正文与其余更新照常接纳。
 * 只有结构外壳（正文信封 / direct_updates 区块 / JSON / 原型污染 / world 系统段 / 结构化战斗）整楼拒收。
 */
import { describe, expect, it } from 'vitest';
import {
  buildDirectPatches,
  parseDirectOutput,
  type DirectTurnDraft,
  type ParseDirectOutputOptions,
} from '../../../src/core/agents/direct-output';
import type { DirectDicePool } from '../../../src/core/agents/direct-dice';
import {
  createDefaultCharacterState,
  type CharacterState,
  type StatePatch,
} from '../../../src/core/types/types';

type Row = Record<string, any>;

const POOL: DirectDicePool = [{ sides: 20, values: [7] }];
const BODY = '<maintext>铁匠抬头看了你一眼。</maintext><options>1. 等待\n2. 离开</options>';

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

function reply(inner: string, characters: unknown[] = []): string {
  return `${BODY}<character_updates>${JSON.stringify({ characters })}</character_updates><direct_updates>${inner}</direct_updates>`;
}

function parse(data: unknown, options?: ParseDirectOutputOptions, characters?: unknown[]) {
  return parseDirectOutput(reply(JSON.stringify(data), characters), POOL, options);
}

function player(): CharacterState {
  return createDefaultCharacterState({ id: 'p', saveId: 's', name: '旅人', type: 'player' });
}

function build(draft: DirectTurnDraft, characters: CharacterState[] = [player()]) {
  return buildDirectPatches(draft, { characters, definitions: [], sourceTurnKey: 'u' });
}

function targets(draft: DirectTurnDraft): string[] {
  return build(draft).patches.map((patch) => patch.target);
}

/** 正文与选项原样保留 */
function expectBodyKept(draft: DirectTurnDraft): void {
  expect(draft.content).toBe('铁匠抬头看了你一眼。');
  expect(draft.options).toEqual(['等待', '离开']);
}

/** 作为「其余更新」哨兵的好感度行 */
function withSentinel(data: Row): Row {
  data.state.affections ??= {};
  data.state.affections.set = [...(data.state.affections.set ?? []), { name: '莉娜', value: 30 }];
  return data;
}

function smith(name = '铁匠'): Row {
  return {
    kind: 'character',
    placement: { location: '铁匠铺', present: true },
    output: {
      skills: [],
      equipment: [],
      inventory: [],
      character: {
        name,
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

describe('真机触发样本：fp 写成空对象', () => {
  it('fp:{} 静默删除不记 note、不产 fp 补丁，好感度照常生效', () => {
    const inner = JSON.stringify(updates()).replace(
      '"state":{}',
      '"state":{"items":{},"affections":{"set":[{"name":"X","value":12}]},"fp":{},"quests":{}}',
    );
    const draft = parseDirectOutput(reply(inner), POOL);
    expectBodyKept(draft);
    expect(draft.normalized).toBeUndefined();
    expect(draft.dropped).toBeUndefined();
    expect(draft.updates.state).not.toHaveProperty('fp');
    const patches = build(draft).patches;
    expect(patches.some((patch) => patch.target === 'profile.fp')).toBe(false);
    expect(patches.map((patch) => patch.target)).toContain('affections.X');
  });
  it('fp 为 null 或 {delta:null} 也静默删除', () => {
    for (const fp of [null, { delta: null }]) {
      const data = withSentinel(updates());
      data.state.fp = fp;
      const draft = parse(data);
      expect(draft.dropped).toBeUndefined();
      expect(draft.updates.state).not.toHaveProperty('fp');
      expect(targets(draft)).toEqual(['affections.莉娜']);
    }
  });
  it('fp 写了别的键却没有 delta（如 {amount:-3}）：有损，记 dropped', () => {
    for (const fp of [{ amount: -3 }, { note: '无变化', delta: null }]) {
      const data = withSentinel(updates());
      data.state.fp = fp;
      const draft = parse(data);
      expectBodyKept(draft);
      expect(draft.dropped).toEqual(['state.fp：缺少 delta，已忽略']);
      expect(draft.updates.state).not.toHaveProperty('fp');
      expect(targets(draft)).toEqual(['affections.莉娜']);
    }
  });
  it('fp.delta 不是数值：删掉 fp 并记 dropped，其余照收', () => {
    const data = withSentinel(updates());
    data.state.fp = { delta: '一点' };
    const draft = parse(data);
    expectBodyKept(draft);
    expect(draft.dropped).toEqual(['state.fp：fp.delta 必须为数值，已忽略']);
    expect(targets(draft)).toEqual(['affections.莉娜']);
  });
  it('fp 不是对象：删掉并记 dropped；合法 fp 剥多余键后照收', () => {
    const bad = withSentinel(updates());
    bad.state.fp = 3;
    expect(parse(bad).dropped).toEqual(['state.fp：必须是对象，已忽略']);
    const extra = withSentinel(updates());
    extra.state.fp = { delta: 2, reason: '奇遇' };
    const draft = parse(extra);
    expect(draft.dropped).toEqual(['state.fp：含未支持的字段 reason，已剥除']);
    expect(targets(draft)).toEqual(expect.arrayContaining(['profile.fp', 'affections.莉娜']));
  });
});

describe('实体平铺 / 缺字段', () => {
  it('loadout 平铺人物字段：剥键、保留物品', () => {
    const data = withSentinel(updates());
    data.entities.push({
      kind: 'loadout',
      owner: '旅人',
      output: {
        name: '旅人',
        race: '人类',
        skills: [],
        equipment: [],
        inventory: [{ name: '铁锭', description: '原料', quantity: 2 }],
      },
    });
    const draft = parse(data);
    expectBodyKept(draft);
    expect(draft.dropped).toEqual(['entities[0].output：含未支持的字段 name、race，已剥除']);
    const patches = build(draft).patches;
    expect(patches.find((p) => p.op === 'add_item')?.value).toMatchObject({ name: '铁锭' });
    expect(patches.map((p) => p.target)).toContain('affections.莉娜');
  });
  it('人物缺 name 丢该实体，另一个实体照建', () => {
    const data = withSentinel(updates());
    const nameless = smith();
    delete nameless.output.character.name;
    data.entities.push(nameless, smith('学徒'));
    const draft = parse(data);
    expectBodyKept(draft);
    expect(draft.dropped).toEqual([
      'entities[0]：output.character.name 名字／引用不能为空，已忽略',
    ]);
    const built = build(draft);
    expect(built.characters.map((c) => c.name)).toEqual(['旅人', '学徒']);
    expect(built.patches.map((p) => p.target)).toContain('affections.莉娜');
  });
});

describe('登神形状偏差', () => {
  it('ascension.laws 写成对象、条目含非对象：只丢坏的部分，人物照建', () => {
    const data = withSentinel(updates());
    const entity = smith();
    entity.output.character.ascension.laws = { 统御法则: '号令' };
    entity.output.character.ascension.elements = [42, null, { name: '火' }];
    data.entities.push(entity);
    const draft = parse(data);
    expectBodyKept(draft);
    const label = 'entities[0].output.character.ascension';
    expect(draft.dropped).toEqual([
      `${label}.elements[0]：不是对象，已忽略`,
      `${label}.elements[1]：不是对象，已忽略`,
      `${label}.laws：不是数组，已忽略`,
    ]);
    const built = build(draft);
    const character = built.characters[1];
    expect(character.name).toBe('铁匠');
    expect(character.ascension.law).toEqual([]);
    expect(character.ascension.elements.map((e) => e.name)).toEqual(['火']);
    expect(built.patches.map((p) => p.target)).toContain('affections.莉娜');
  });
  it('人物 ascension 不是对象：按未登神处理；loadout 的删键不改登神', () => {
    const data = withSentinel(updates());
    const entity = smith();
    entity.output.character.ascension = '未登神';
    data.entities.push(entity, {
      kind: 'loadout',
      owner: '旅人',
      output: { skills: [], equipment: [], inventory: [], ascension: [] },
    });
    const draft = parse(data);
    expect(draft.dropped).toEqual([
      'entities[0].output.character.ascension：不是对象，已按未登神处理',
      'entities[1].output.ascension：不是对象，已忽略',
    ]);
    expect(draft.updates.entities[1].output).not.toHaveProperty('ascension');
    expect(build(draft).characters[1].ascension.enabled).toBe(false);
  });
});

describe('state 单元', () => {
  it('未知的操作键与子键被剥除并记 dropped，合法操作照收', () => {
    const data = withSentinel(updates());
    data.state.affections.add = [{ name: '莉娜', value: 5 }];
    data.state.mood = { joy: 1 };
    const draft = parse(data);
    expectBodyKept(draft);
    expect(draft.dropped).toEqual([
      'state：含未支持的字段 mood，已剥除',
      'state.affections：含未支持的字段 add，已剥除',
    ]);
    expect(targets(draft)).toEqual(['affections.莉娜']);
  });
  it('操作值不是数组、子键不是对象：只删那一项', () => {
    const data = withSentinel(updates());
    data.state.affections.delta = { name: '莉娜', amount: 1 };
    data.state.quests = '无';
    const draft = parse(data);
    expect(draft.dropped).toEqual([
      'state.affections.delta：必须是数组，已忽略',
      'state.quests：必须是对象，已忽略',
    ]);
    expect(targets(draft)).toEqual(['affections.莉娜']);
  });
  it('单条坏好感度只丢那一行', () => {
    const data = withSentinel(updates());
    data.state.affections.set.unshift({ name: 'X', value: '很高' });
    const draft = parse(data);
    expectBodyKept(draft);
    expect(draft.dropped).toEqual(['state.affections.set[0]：好感度必须为数值，已忽略']);
    expect(targets(draft)).toEqual(['affections.莉娜']);
  });
  it('物品修改剥掉未知改动键；什么都不剩时丢整行', () => {
    const data = withSentinel(updates());
    data.state.items = {
      modify: [
        { owner: '旅人', target: '铁', changes: { glow: true } },
        { owner: '旅人', target: '铁', changes: { description: '生锈的铁', glow: true } },
      ],
    };
    const draft = parse(data);
    // 被丢的行只记一条最终结果
    expect(draft.dropped).toEqual([
      'state.items.modify[0]：物品修改没有可改的字段，已忽略',
      'state.items.modify[1].changes：含未支持的字段 glow，已剥除',
    ]);
    expect((draft.updates.state as Row).items.modify).toEqual([
      { owner: '旅人', target: '铁', changes: { description: '生锈的铁' } },
    ]);
  });
});

describe('time / world / effects / plot 单元', () => {
  it('delta_time 非法按 0 处理；缺失补 0 只记 normalized', () => {
    const bad = withSentinel(updates());
    bad.time = { delta_time: -5, note: 'x' };
    const draft = parse(bad);
    expect(draft.updates.time).toEqual({ delta_time: 0 });
    expect(draft.dropped).toEqual([
      'time：含未支持的字段 note，已剥除',
      'time.delta_time：必须是非负分钟数，已按 0 处理',
    ]);
    const missing = parse({ ...updates(), time: {} });
    expect(missing.normalized).toEqual(['time.delta_time：缺失，已补 0']);
    expect(missing.dropped).toBeUndefined();
  });
  it('world 坏行与非有限数值只丢那一行', () => {
    const data = withSentinel(updates());
    data.world = { replace: [{ path: '' }, { path: '世界.天气', value: '晴' }], tile_ops: 'x' };
    const inner = JSON.stringify(data).replace(
      '"value":"晴"',
      '"value":"晴"},{"path":"世界.数","value":1e999',
    );
    const draft = parseDirectOutput(reply(inner), POOL);
    expectBodyKept(draft);
    expect(draft.updates.world).toEqual({ replace: [{ path: '世界.天气', value: '晴' }] });
    expect(draft.dropped).toEqual([
      'world.replace[0]：path 名字／引用不能为空，已忽略',
      'world.replace[2]：value 数值必须有限，已忽略',
      'world.tile_ops：必须是数组，已忽略',
    ]);
    expect(targets(draft)).toContain('affections.莉娜');
  });
  it('effects 行的多余键剥除，坏行丢弃', () => {
    const data = withSentinel(updates());
    data.effects.push(
      { owner: '旅人', action: 'remove', value: { name: '中毒' }, note: '解毒' },
      { owner: '旅人', action: 'heal', value: { name: '流血' } },
    );
    const draft = parse(data);
    expect(draft.updates.effects).toEqual([
      { owner: '旅人', action: 'remove', value: { name: '中毒' } },
    ]);
    expect(draft.dropped).toEqual([
      'effects[0]：含未支持的字段 note，已剥除',
      'effects[1]：效果动作无效，已忽略',
    ]);
    expect(targets(draft)).toEqual(expect.arrayContaining(['characters.旅人', 'affections.莉娜']));
  });
  it('plot 多余键剥除、坏子键丢弃', () => {
    const draft = parse({
      ...withSentinel(updates()),
      plot: { pre: [], post: { ok: 1 }, mid: {} },
    });
    expect(draft.updates.plot).toEqual({ post: { ok: 1 } });
    expect(draft.dropped).toEqual([
      'plot：含未支持的字段 mid，已剥除',
      'plot.pre：剧情判断 必须是对象，已忽略',
    ]);
  });
});

describe('character_updates 不再连坐整楼', () => {
  it('缺失或 JSON 坏掉：记入 dropped，direct_updates 照收', () => {
    const data = JSON.stringify(withSentinel(updates()));
    const missing = parseDirectOutput(`${BODY}<direct_updates>${data}</direct_updates>`, POOL);
    expectBodyKept(missing);
    expect(missing.dropped).toEqual(['character_updates：缺少 character_updates 区块，已忽略']);
    expect(targets(missing)).toEqual(['affections.莉娜']);
    const broken = parseDirectOutput(
      `${BODY}<character_updates>{坏</character_updates><direct_updates>${data}</direct_updates>`,
      POOL,
    );
    expect(broken.dropped).toEqual(['character_updates：角色更新未保存：JSON 格式无效。']);
    expect(broken.characterUpdates).toEqual([]);
    expect(targets(broken)).toEqual(['affections.莉娜']);
  });
});

describe('连锁丢弃', () => {
  it('人物实体被丢：引用它的叙事更新、状态、效果、归属物一并丢弃，其余照收', () => {
    const data = withSentinel(updates());
    const broken = smith();
    broken.output.character.tier = 99;
    data.entities.push(broken, {
      kind: 'loadout',
      owner: '铁匠',
      output: {
        skills: [],
        equipment: [],
        inventory: [{ name: '铁锤', description: '沉重', quantity: 1 }],
      },
    });
    data.state.characters = {
      replace: [
        { name: '铁匠', path: 'thoughts', value: '炉火' },
        { name: '旅人', path: 'thoughts', value: '饿了' },
      ],
    };
    data.effects.push({
      owner: '铁匠',
      action: 'add',
      value: {
        name: '专注',
        description: '',
        category: '增益',
        stacks: 1,
        remainingTime: null,
        timeUnit: '分钟',
      },
    });
    const narrative = [{ name: '铁匠', profile_changes: { personality: '直率' }, chronicle: [] }];
    const draft = parse(data, undefined, narrative);
    expectBodyKept(draft);
    expect(draft.dropped).toEqual(['entities[0]：人物层级无效，已忽略']);
    const built = build(draft);
    expect(built.characters.map((c) => c.name)).toEqual(['旅人']);
    expect(built.characterUpdates).toEqual([]);
    expect(built.dropped).toEqual([
      'character_updates：人物 铁匠 缺少完整实体，已忽略',
      'entities[1]：物品归属人物 铁匠 不存在，已忽略',
      'update_character（characters.铁匠）：角色不存在: 铁匠，已忽略',
      'add_status_effect（characters.铁匠）：角色不存在: 铁匠，已忽略',
    ]);
    expect(built.patches.map((p) => p.target).sort()).toEqual(
      ['affections.莉娜', 'characters.旅人'].sort(),
    );
  });
  it('人物已存在：丢那个实体，不整楼拒收', () => {
    const data = withSentinel(updates());
    data.entities.push(smith('旅人'));
    const draft = parse(data);
    const built = build(draft);
    expect(built.dropped).toEqual(['entities[0]：人物 旅人 已存在，已忽略']);
    expect(built.patches.map((p) => p.target)).toEqual(['affections.莉娜']);
  });
  it('替换目标不在身上：整条替换丢弃（不只加不删）；在身上：照常 remove + add', () => {
    const data = withSentinel(updates());
    data.entities.push({
      kind: 'loadout',
      owner: '旅人',
      output: {
        skills: [],
        equipment: [],
        inventory: [
          { name: '钢锭', description: '精炼', quantity: 1, replace: '不存在的东西' },
          { name: '钢块', description: '精炼', quantity: 1, replace: '铁' },
          { name: '炭', description: '燃料', quantity: 1 },
        ],
      },
    });
    const built = build(parse(data), [richPlayer()]);
    expect(built.dropped).toEqual([
      'entities[0].output.inventory[0]（钢锭 替换 不存在的东西）：remove_item：物品不存在: 不存在的东西，已忽略',
    ]);
    expect(built.patches.filter((p) => p.op === 'remove_item').map((p) => p.value)).toEqual([
      { name: '铁' },
    ]);
    const added = built.patches
      .filter((p) => p.op === 'add_item')
      .map((p) => (p.value as Row).name);
    expect(added.sort()).toEqual(['炭', '钢块'].sort());
    expect(built.patches.map((p) => p.target)).toContain('affections.莉娜');
  });
});

describe('替换成对预演', () => {
  /** 身上只有一把旧剑、会旧剑技的主角 */
  function swordsman(): CharacterState {
    return createDefaultCharacterState({
      id: 'p',
      saveId: 's',
      name: '旅人',
      type: 'player',
      inventory: [{ name: '旧剑', quantity: 1 }],
      skills: [{ name: '旧剑技' } as CharacterState['skills'][number]],
    });
  }
  function loadout(inventory: Row[], skills: Row[] = []): Row {
    return { kind: 'loadout', owner: '旅人', output: { skills, equipment: [], inventory } };
  }
  const addNames = (patches: StatePatch[]) =>
    patches.filter((p) => p.op === 'add_item').map((p) => (p.value as Row).name);

  it('同一归属物里两条都替换旧剑：按条目各成一组，第二组删旧失败时连新的也不加并点名', () => {
    const data = withSentinel(updates());
    data.entities.push(
      loadout([
        { name: '铁锭', description: '', quantity: 1, replace: '旧剑' },
        { name: '木柄', description: '', quantity: 1, replace: '旧剑' },
      ]),
    );
    const built = build(parse(data), [swordsman()]);
    expect(built.dropped).toEqual([
      'entities[0].output.inventory[1]（木柄 替换 旧剑）：remove_item：物品不存在: 旧剑，已忽略',
    ]);
    expect(built.patches.filter((p) => p.op === 'remove_item')).toHaveLength(1);
    expect(addNames(built.patches)).toEqual(['铁锭']);
    expect(built.patches.map((p) => p.target)).toContain('affections.莉娜');
  });
  it('两个归属物各替换旧剑：第二个的删旧失败，它的加新也一并丢弃', () => {
    const data = withSentinel(updates());
    data.entities.push(
      loadout([{ name: '铁锭', description: '', quantity: 1, replace: '旧剑' }]),
      loadout([{ name: '木柄', description: '', quantity: 1, replace: '旧剑' }]),
    );
    const built = build(parse(data), [swordsman()]);
    expect(built.dropped).toEqual([
      'entities[1].output.inventory[0]（木柄 替换 旧剑）：remove_item：物品不存在: 旧剑，已忽略',
    ]);
    expect(addNames(built.patches)).toEqual(['铁锭']);
  });
  it('技能替换同样成对：会的照换，不会的整组丢', () => {
    const data = withSentinel(updates());
    data.entities.push(
      loadout(
        [],
        [
          { name: '新剑技', description: '', replace: '旧剑技' },
          { name: '飞剑', description: '', replace: '御剑术' },
        ],
      ),
    );
    const built = build(parse(data), [swordsman()]);
    expect(built.dropped).toEqual([
      'entities[0].output.skills[1]（飞剑 替换 御剑术）：remove_skill：技能不存在: 御剑术，已忽略',
    ]);
    expect(built.patches.filter((p) => p.op === 'remove_skill').map((p) => p.value)).toEqual([
      { name: '旧剑技' },
    ]);
    expect(
      built.patches.filter((p) => p.op === 'add_skill').map((p) => (p.value as Row).name),
    ).toEqual(['新剑技']);
  });
});

/** 身上带物品与技能的主角（物品预演用） */
function richPlayer(): CharacterState {
  return createDefaultCharacterState({
    id: 'p',
    saveId: 's',
    name: '旅人',
    type: 'player',
    aliases: ['阿旅'],
    inventory: [
      { name: '铁', quantity: 2 },
      { name: '短剑', quantity: 1 },
    ],
    skills: [{ name: '斩击' } as CharacterState['skills'][number]],
  });
}

describe('复审补充：提交时必抛的补丁在建补丁阶段先丢', () => {
  it('转移的接收方 / 来源是本楼被丢的实体：只丢那条转移', () => {
    const data = withSentinel(updates());
    const ella = smith('艾拉');
    ella.output.character.tier = 9;
    data.entities.push(ella);
    data.state.items = {
      transfer: [
        { from: '旅人', to: '艾拉', target: '铁', quantity: 1 },
        { from: '艾拉', to: '旅人', target: '铁', quantity: 1 },
      ],
      consume: [{ owner: '旅人', target: '铁', quantity: 1 }],
    };
    const draft = parse(data);
    expectBodyKept(draft);
    const built = build(draft, [richPlayer()]);
    expect(built.dropped).toEqual([
      'transfer_item（characters.旅人）：角色不存在: 艾拉，已忽略',
      'transfer_item（characters.艾拉）：角色不存在: 艾拉，已忽略',
    ]);
    expect(built.patches.map((p) => p.op).sort()).toEqual(['remove_item', 'set_affection'].sort());
  });
  it('world 行缺 value、equip 槽位不在枚举、replace 不是文本：解析阶段就丢那一行 / 那一条', () => {
    const data = withSentinel(updates());
    data.world = { replace: [{ path: '世界.天气' }, { path: '世界.季节', value: '秋' }] };
    data.state.items = {
      equip: [
        { owner: '旅人', target: '短剑', slot: '尾巴' },
        { owner: '旅人', target: '短剑', slot: '武器' },
      ],
    };
    data.entities.push({
      kind: 'loadout',
      owner: '旅人',
      output: {
        skills: [],
        equipment: [],
        inventory: [
          { name: '钢锭', description: '精炼', quantity: 1, replace: true },
          { name: '炭', description: '燃料', quantity: 1 },
        ],
      },
    });
    const draft = parse(data);
    expectBodyKept(draft);
    expect(draft.dropped).toEqual([
      'world.replace[0]：缺少 value，已忽略',
      'entities[0].output.inventory[0]：replace 名字／引用不能为空，已忽略',
      'state.items.equip[0]：无法识别的装备槽位：尾巴，已忽略',
    ]);
    const built = build(draft, [richPlayer()]);
    expect(built.dropped).toEqual([]);
    expect(built.patches.map((p) => p.op)).toEqual(
      expect.arrayContaining(['add_item', 'equip_item', 'set_variable', 'set_affection']),
    );
    expect(built.patches.some((p) => p.op === 'remove_item')).toBe(false);
  });
  it('equip 引用的物品来自被丢的归属物条目：丢 equip 补丁', () => {
    const data = withSentinel(updates());
    data.entities.push({
      kind: 'loadout',
      owner: '旅人',
      output: {
        skills: [],
        equipment: [],
        inventory: [{ name: '长枪', description: '', quantity: 0 }],
      },
    });
    data.state.items = { equip: [{ owner: '旅人', target: '长枪', slot: '武器' }] };
    const draft = parse(data);
    expect(draft.dropped).toEqual([
      'entities[0].output.inventory[0]：物品数量必须为正整数，已忽略',
    ]);
    const built = build(draft, [richPlayer()]);
    expect(built.dropped).toEqual(['equip_item（characters.旅人）：物品不存在: 长枪，已忽略']);
    expect(built.patches.map((p) => p.target)).toEqual(['affections.莉娜']);
  });
  it('卸下缺名字（只剩空引用）：预演不再放行，只丢那条卸下并记 dropped', () => {
    const data = withSentinel(updates());
    data.state.items = { equip: [{ owner: '旅人', target: '短剑', slot: '武器' }] };
    const draft = parse(data);
    // 直出契约里的卸下总按名字；这里在解析之后塞一条没有名字的卸下，模拟预演收到「不带名字」的补丁
    (draft.updates.state as Row).characters = { remove: [{ name: '旅人', path: 'equipment' }] };
    const built = build(draft, [richPlayer()]);
    expect(built.dropped).toEqual([
      'unequip_item（characters.旅人）：unequip_item 需要 value.name 或 value.slot，已忽略',
    ]);
    expect(built.patches.map((p) => p.op)).toEqual(expect.arrayContaining(['equip_item']));
    expect(built.patches.some((p) => p.op === 'unequip_item')).toBe(false);
  });
  it('其余库存 / 技能问题：不存在的物品、数量不足、自我转移、堆叠穿戴、删不存在的技能各丢一条', () => {
    const data = withSentinel(updates());
    data.state.items = {
      consume: [
        { owner: '旅人', target: '金币袋', quantity: 1 },
        { owner: '旅人', target: '铁', quantity: 5 },
      ],
      transfer: [{ from: '旅人', to: '阿旅', target: '铁', quantity: 1 }],
      equip: [{ owner: '旅人', target: '铁', slot: '武器' }],
    };
    data.state.characters = {
      remove: [
        { name: '旅人', path: 'skills', target: '飞行' },
        { name: '旅人', path: 'skills', target: '斩击' },
      ],
    };
    const built = build(parse(data), [richPlayer()]);
    expect(built.dropped).toEqual([
      'remove_skill（characters.旅人）：技能不存在: 飞行，已忽略',
      'remove_item（characters.旅人）：物品不存在: 金币袋，已忽略',
      'remove_item（characters.旅人）：物品「铁」库存不足: 持有 2，需要 5，已忽略',
      'equip_item（characters.旅人）：堆叠物品不可直接穿戴: 铁（数量 2），请先拆分为单件，已忽略',
      'transfer_item（characters.旅人）：transfer_item 不允许自我转移: 旅人，已忽略',
    ]);
    expect(built.patches.map((p) => p.op).sort()).toEqual(['remove_skill', 'set_affection'].sort());
  });
  it('实体在建补丁时才被丢（已存在）：同名的 effects 行不再被当成重复', () => {
    const data = withSentinel(updates());
    const twin = smith('旅人');
    twin.output.statuses = [
      {
        name: '专注',
        owner: '旅人',
        description: '',
        category: '增益',
        stacks: 1,
        remainingTime: null,
        timeUnit: '分钟',
      },
    ];
    data.entities.push(twin);
    data.effects.push({ owner: '旅人', action: 'remove', value: { name: '专注' } });
    const draft = parse(data);
    expect(draft.dropped).toBeUndefined();
    const built = build(draft);
    expect(built.dropped).toEqual(['entities[0]：人物 旅人 已存在，已忽略']);
    expect(built.patches.map((p) => p.op)).toContain('remove_status_effect');
  });
  it('实体留下时，与其初始状态同名的 effects 行在建补丁时丢弃', () => {
    const data = withSentinel(updates());
    const entity = smith();
    entity.output.statuses = [{ name: '专注', owner: '铁匠' }];
    data.entities.push(entity);
    data.effects.push({ owner: '铁匠', action: 'remove', value: { name: '专注' } });
    const built = build(parse(data));
    expect(built.dropped).toEqual(['effects[0]：状态效果重复声明（实体初始状态已写过），已忽略']);
    expect(built.patches.map((p) => p.op)).not.toContain('remove_status_effect');
  });
  // 审查 R2：原文路径曾靠模块级 WeakMap 按对象身份传递，草稿被克隆（如跨 worker / 存草稿）后退化成校验后下标
  it('草稿被克隆后建补丁的丢弃说明仍指模型原文路径（实体与 effects 行）', () => {
    const data = withSentinel(updates());
    const twin = smith('旅人');
    const keeper = smith();
    keeper.output.statuses = [{ name: '专注', owner: '铁匠' }];
    // entities[0] 解析期就被丢，留下的两行原文下标是 1、2
    data.entities.push({ kind: 'nonsense' }, twin, keeper);
    data.effects.push(
      { owner: '铁匠', action: 'explode', value: { name: '灼烧' } },
      { owner: '铁匠', action: 'remove', value: { name: '专注' } },
    );
    const draft = parse(data);
    expect(draft.entityPaths).toEqual(['entities[1]', 'entities[2]']);
    expect(draft.effectPaths).toEqual(['effects[1]']);
    const built = build(structuredClone(draft));
    expect(built.dropped).toEqual([
      'entities[1]：人物 旅人 已存在，已忽略',
      'effects[1]：状态效果重复声明（实体初始状态已写过），已忽略',
    ]);
  });
  it('草稿携带解析口径：stateProtocol / structuredCombat / plotEnabled', () => {
    const draft = parse(updates(), { structuredCombat: false, plotEnabled: false });
    expect(draft).toMatchObject({
      stateProtocol: 'legacy',
      structuredCombat: false,
      plotEnabled: false,
    });
    const tree = parseDirectOutput(
      reply(JSON.stringify({ version: 2, patch: [], plot: {}, diceUsed: [] })),
      POOL,
      { stateProtocol: 'tree' },
    );
    expect(tree).toMatchObject({
      stateProtocol: 'tree',
      structuredCombat: true,
      plotEnabled: true,
    });
  });
  it('一个单元只记一条 note：effects update 剥键后只剩 name 被丢时只记丢弃', () => {
    const data = withSentinel(updates());
    data.effects.push({ owner: '旅人', action: 'update', value: { name: '专注', foo: 1 } });
    expect(parse(data).dropped).toEqual([
      'effects[0]：效果更新只能改 remainingTime／stacks，已忽略',
    ]);
  });
  it('「主角」与别名按提交时同一份规则解析，不被连锁过滤误丢', () => {
    const data = withSentinel(updates());
    data.state.characters = {
      delta: [{ name: '主角', path: 'hp', amount: -5 }],
      replace: [{ name: '阿旅', path: 'thoughts', value: '饿了' }],
    };
    data.effects.push({ owner: '玩家', action: 'remove', value: { name: '中毒' } });
    const built = build(parse(data), [richPlayer()]);
    expect(built.dropped).toEqual([]);
    expect(built.patches.map((p) => p.target).sort()).toEqual(
      ['affections.莉娜', 'characters.主角', 'characters.阿旅', 'characters.玩家'].sort(),
    );
  });
});

describe('零个 direct_updates 开标签', () => {
  it('按空更新接纳并标 updatesMissing', () => {
    const draft = parseDirectOutput(
      `${BODY}<character_updates>${JSON.stringify({ characters: [] })}</character_updates>`,
      POOL,
    );
    expectBodyKept(draft);
    expect(draft.updatesMissing).toBe(true);
    expect(draft.dropped).toBeUndefined();
    expect(draft.updates).toMatchObject({ version: 1, entities: [], combat: null, diceUsed: [] });
    expect(build(draft).patches).toEqual([]);
  });
});

describe('仍整楼拒收', () => {
  const valid = JSON.stringify(updates());
  const cases: Array<[string, string, string]> = [
    ['正文信封缺失', `<direct_updates>${valid}</direct_updates>`, '需要一个完整的 maintext'],
    [
      '正文为空',
      `<maintext></maintext><character_updates>{"characters":[]}</character_updates><direct_updates>${valid}</direct_updates>`,
      '正文为空',
    ],
    [
      'direct_updates 不止一个',
      reply(valid) + `<direct_updates>${valid}</direct_updates>`,
      '需要一个完整的 direct_updates 区块',
    ],
    [
      'direct_updates 未闭合',
      `${BODY}<direct_updates>${valid}`,
      '需要一个完整的 direct_updates 区块',
    ],
    ['direct_updates 非法 JSON', reply('{坏'), 'direct_updates 不是合法 JSON'],
    ['direct_updates 顶层不是对象', reply('[]'), 'direct_updates 必须是对象'],
    [
      '原型污染键',
      reply(valid.replace('"state":{}', '"state":{"__proto__":{"x":1}}')),
      '不允许模型填写 __proto__',
    ],
    [
      'world 写系统状态段',
      reply(valid.replace('"world":{}', '"world":{"replace":[{"path":"worldFlags.x","value":1}]}')),
      'world 不能写系统状态',
    ],
    ['结构化战斗缺 combat', reply(valid.replace(',"combat":null', '')), 'v1 分区不完整'],
    [
      '结构化战斗 combat 不是对象',
      reply(valid.replace('"combat":null', '"combat":"进行中"')),
      'combat 必须是对象',
    ],
    [
      '结构化战斗 combat 含非有限数值',
      reply(valid.replace('"combat":null', '"combat":{"meta":{"round":1e999}}')),
      'combat 含非有限数值',
    ],
  ];
  it.each(cases)('%s', (_name, raw, message) => {
    expect(() => parseDirectOutput(raw, POOL)).toThrow(`直出结果无效：`);
    expect(() => parseDirectOutput(raw, POOL)).toThrow(message);
  });
  it('结构化战斗关闭时坏 combat 只被忽略', () => {
    const raw = reply(valid.replace('"combat":null', '"combat":"进行中"'));
    const draft = parseDirectOutput(raw, POOL, { structuredCombat: false });
    expect(draft.combatIgnored).toBe(true);
    expect(draft.dropped).toBeUndefined();
  });
});

describe('合规输入', () => {
  it('normalized / dropped / updatesMissing 全部缺席', () => {
    const data = withSentinel(updates());
    data.entities.push(smith());
    const draft = parse(data);
    expect(draft.normalized).toBeUndefined();
    expect(draft.dropped).toBeUndefined();
    expect(draft.updatesMissing).toBeUndefined();
    const built = build(draft);
    expect(built.dropped).toEqual([]);
    expect(built.patches.map((p) => p.target)).toEqual(['characters.铁匠', 'affections.莉娜']);
  });
});
