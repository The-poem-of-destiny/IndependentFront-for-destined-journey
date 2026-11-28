/**
 * state-tree-projection.ts — 状态树投影（状态树协议 T4，§3.1、§3.4）
 */
import { describe, expect, it } from 'vitest';
import {
  buildStateTree,
  DEFAULT_STATE_TREE_NEWS_LIMIT,
  isStateTreePersonSummary,
  UNCATEGORIZED_NEWS_COLUMN,
  type StateTreeObject,
} from '../../../src/core/variables/state-tree-projection';
import {
  findChildSpec,
  listStateTreePaths,
  STATE_TREE_SPEC,
  type StateTreeBranchSpec,
  type StateTreeLeafKind,
} from '../../../src/core/variables/state-tree-spec';
import type { CharacterState } from '../../../src/core/types/types';
import { baseResourceCaps } from '../../../src/core/character/resource-caps';
import { formatGameTime } from '../../../src/core/time/time-system';
import { characterAge } from '../../../src/core/character/character-age';
import { GAME_TIME, makeInput, makeNpc, makePlayer } from './state-tree-fixture';

const obj = (v: unknown) => v as StateTreeObject;

function branch(parent: StateTreeBranchSpec, key: string): StateTreeBranchSpec {
  const s = findChildSpec(parent, key);
  if (!s || s.type !== 'branch') throw new Error(key);
  return s;
}

function entry(parent: StateTreeBranchSpec, key: string): StateTreeBranchSpec {
  const s = findChildSpec(parent, key);
  if (!s || s.type !== 'record' || s.entry.type !== 'branch') throw new Error(key);
  return s.entry;
}

/** 断言 actual 的键是 spec 子键按词表顺序的子序列（键序固定、不出词表外的键）。 */
function expectSpecOrder(actual: StateTreeObject, spec: StateTreeBranchSpec) {
  const specKeys = spec.children.map((c) => c.key);
  const keys = Object.keys(actual);
  for (const k of keys) expect(specKeys).toContain(k);
  const positions = keys.map((k) => specKeys.indexOf(k));
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

/** 递归收集所有键名。 */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

/** 递归断言没有 undefined 值。 */
function expectNoUndefined(value: unknown, path = ''): void {
  expect(value, path).not.toBeUndefined();
  if (Array.isArray(value)) value.forEach((v, i) => expectNoUndefined(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) expectNoUndefined(v, `${path}/${k}`);
  }
}

describe('buildStateTree 骨架', () => {
  const tree = buildStateTree(makeInput());

  it('根键按 §3.1 顺序：世界 / 命运点数 / 主角 / 关系列表 / 任务列表 / 新闻 / 变量', () => {
    expect(Object.keys(tree)).toEqual([
      '世界',
      '命运点数',
      '主角',
      '关系列表',
      '任务列表',
      '新闻',
      '变量',
    ]);
  });

  it('世界：时间用 formatGameTime 规范串，地点是主角位置，带时段 / 天气 / 回合', () => {
    expect(tree['世界']).toEqual({
      时间: formatGameTime(GAME_TIME),
      地点: '王都/北门',
      _时段: '傍晚',
      _天气: '小雨',
      _回合: 7,
    });
  });

  it('缺天气 / 回合时不出对应键', () => {
    const t = buildStateTree(makeInput({ weather: undefined, turn: undefined }));
    expect(Object.keys(obj(t['世界']))).toEqual(['时间', '地点', '_时段']);
  });

  it('命运点数原样', () => {
    expect(tree['命运点数']).toBe(42);
  });

  it('变量原样深拷贝，不共享引用', () => {
    const input = makeInput();
    const t = buildStateTree(input);
    expect(t['变量']).toEqual(input.profile.variables);
    expect(t['变量']).not.toBe(input.profile.variables);
  });

  it('全树无 undefined 值', () => {
    expectNoUndefined(tree);
  });

  it('没有主角时不出主角键，关系列表与任务列表仍恒出现', () => {
    const t = buildStateTree({
      characters: [makeNpc('布兰')],
      profile: { ...makeInput().profile, quests: {} },
    });
    expect(t['主角']).toBeUndefined();
    expect(t['关系列表']).toBeDefined();
    expect(t['任务列表']).toEqual({});
    expect(obj(t['世界'])['地点']).toBeUndefined();
  });
});

describe('人物节点', () => {
  const tree = buildStateTree(makeInput());
  const player = obj(tree['主角']);
  const playerSpec = branch(STATE_TREE_SPEC, '主角');
  const relationSpec = entry(STATE_TREE_SPEC, '关系列表');

  it('主角键序固定、遵循词表，且没有地点 / 在场 / 好感度', () => {
    expectSpecOrder(player, playerSpec);
    expect(player['地点']).toBeUndefined();
    expect(player['在场']).toBeUndefined();
    expect(player['好感度']).toBeUndefined();
    expect(Object.keys(player)).toEqual([
      '档案',
      '成长',
      '生命值',
      '法力值',
      '体力值',
      '金钱',
      '当前行动',
      '心里话',
      '背包',
      '装备',
      '技能',
      '状态效果',
      '登神长阶',
    ]);
  });

  it('两次投影键序逐个一致（字节稳定）', () => {
    const a = JSON.stringify(buildStateTree(makeInput()));
    const b = JSON.stringify(buildStateTree(makeInput()));
    expect(a).toBe(b);
  });

  it('档案：年龄按游戏时间现算，给定生日才出 _生日', () => {
    const profile = obj(player['档案']);
    expectSpecOrder(profile, branch(playerSpec, '档案'));
    const expectedAge = characterAge(makePlayer(), GAME_TIME);
    expect(expectedAge).not.toBeNull();
    expect(profile['_年龄']).toBe(expectedAge);
    expect(profile['_生日']).toBe('3月10日');
    expect(profile['性别']).toBe('女');
    expect(profile['身份']).toEqual(['冒险者']);
    expect(profile['外貌']).toBeUndefined();
    expect(profile['类别']).toBeUndefined();

    const noBirthday = buildStateTree(
      makeInput({ characters: [makePlayer({ customFields: {} })] }),
    );
    const p2 = obj(obj(noBirthday['主角'])['档案']);
    expect(p2['_年龄']).toBe(characterAge(makePlayer(), GAME_TIME));
    expect(p2['_生日']).toBeUndefined();

    const noAnchor = buildStateTree(
      makeInput({ characters: [makePlayer({ ageAnchor: undefined })] }),
    );
    expect(obj(obj(noAnchor['主角'])['档案'])['_年龄']).toBeUndefined();
  });

  it('成长：等级 / 经验 / 属性按词表键名', () => {
    expect(player['成长']).toEqual({
      _生命层级: 2,
      等级: 6,
      累计经验值: 900,
      _升级所需经验: 1200,
      _属性点: 0,
      _属性: { 力量: 10, 敏捷: 8, 体质: 12, 智力: 6, 精神: 9 },
    });
  });

  it('旧档角色（无 *Bonus）的上限投影为 {_基础, 额外}，基础 + 额外 = 原上限', () => {
    const base = baseResourceCaps(2, { str: 10, dex: 8, con: 12, int: 6, spi: 9 });
    expect(player['生命值']).toEqual({ 当前: 300, 上限: { _基础: base.hp, 额外: 5000 - base.hp } });
    expect(player['法力值']).toEqual({ 当前: 20, 上限: { _基础: base.mp, 额外: 777 - base.mp } });
    expect(player['体力值']).toEqual({ 当前: 3, 上限: { _基础: base.sp, 额外: 3 - base.sp } });
  });

  it('新档角色有 *Bonus 时额外取字段值', () => {
    const t = buildStateTree(
      makeInput({ characters: [makePlayer({ maxHpBonus: 25, maxMpBonus: -3, maxSpBonus: 0 })] }),
    );
    const base = baseResourceCaps(2, { str: 10, dex: 8, con: 12, int: 6, spi: 9 });
    expect(obj(t['主角'])['生命值']).toEqual({ 当前: 300, 上限: { _基础: base.hp, 额外: 25 } });
    expect(obj(obj(obj(t['主角'])['法力值'])['上限'])['额外']).toBe(-3);
  });

  it('背包只放未穿戴物品、不带位置；装备只放已穿戴物品、带位置，两者互不重复', () => {
    const bag = obj(player['背包']);
    const equip = obj(player['装备']);
    expect(Object.keys(bag)).toEqual(['治疗药水', '绳子']);
    expect(Object.keys(equip)).toEqual(['长剑', '旧护符']);
    for (const name of Object.keys(bag)) expect(equip[name]).toBeUndefined();
    for (const item of Object.values(bag)) expect(obj(item)['位置']).toBeUndefined();

    expect(bag['治疗药水']).toEqual({
      品质: '普通',
      类型: '消耗品',
      数量: 3,
      标签: [],
      描述: '恢复体力',
    });
    expect(equip['长剑']).toEqual({
      品质: '稀有',
      类型: '武器',
      位置: '武器',
      标签: ['金属'],
      效果: { 锋利: '攻击附带流血' },
      描述: '一把好剑',
      属性: { 攻击力: 15 },
      耐久: { 当前: 40, 上限: 50 },
    });
    expectSpecOrder(obj(equip['长剑']), entry(playerSpec, '装备'));
    expectSpecOrder(obj(bag['治疗药水']), entry(playerSpec, '背包'));
  });

  it('装备的数量只在大于 1 时出现', () => {
    const equip = obj(player['装备']);
    expect(obj(equip['长剑'])['数量']).toBeUndefined();
    expect(obj(equip['旧护符'])['数量']).toBe(2);
    expect(obj(equip['旧护符'])['位置']).toBe('饰品');
  });

  it('技能：消耗用 formatSkillCost（costText 优先），类型与关联属性转中文', () => {
    const skills = obj(player['技能']);
    expect(Object.keys(skills)).toEqual(['斩击', '直觉']);
    expect(skills['斩击']).toEqual({
      品质: '普通',
      类型: '主动',
      消耗: '10SP',
      冷却: 0,
      描述: '基础剑技',
      威力: 30,
      关联属性: '力量',
      伤害类型: '物理',
    });
    expect(obj(skills['直觉'])['消耗']).toBe('每天一次');
    expect(obj(skills['直觉'])['类型']).toBe('被动');
    expectSpecOrder(obj(skills['斩击']), entry(playerSpec, '技能'));
  });

  it('无消耗的技能不出消耗键', () => {
    const t = buildStateTree(
      makeInput({
        characters: [makePlayer({ skills: [{ name: '冥想', description: '', type: 'passive' }] })],
      }),
    );
    expect(obj(obj(obj(t['主角'])['技能'])['冥想'])['消耗']).toBeUndefined();
  });

  it('状态效果：剩余时间用 formatDuration（durationText 优先），效果取词条，不投数值 effects', () => {
    const statuses = obj(player['状态效果']);
    expect(statuses['流血']).toEqual({
      类型: '减益',
      描述: '持续失血',
      效果: { 失血: '每回合损失生命' },
      层数: 2,
      层数上限: 5,
      剩余时间: '3回合',
      来源: '战斗-狼',
    });
    expect(obj(statuses['祝福'])['剩余时间']).toBe('直到离开城镇');
    expect(obj(statuses['祝福'])['效果']).toBeUndefined();
    expectSpecOrder(obj(statuses['流血']), entry(playerSpec, '状态效果'));
  });

  it('登神长阶：按名作键，旧数据只有 effects 数组时合并成一条词条', () => {
    const t = buildStateTree(
      makeInput({
        characters: [
          makePlayer({
            ascension: {
              enabled: true,
              elements: [
                { name: '火', description: '火之要素', effects: ['灼烧', '照明'] },
                {
                  name: '风',
                  description: '风之要素',
                  effects: [],
                  effectDescriptions: { 迅捷: '移动加快' },
                },
              ],
              authority: [
                { name: '焚天', description: '权能', effects: [], costDescription: '25% MP' },
              ],
              law: [],
              deityPosition: '',
              divineKingdom: { name: '', description: '' },
            },
          }),
        ],
      }),
    );
    expect(obj(t['主角'])['登神长阶']).toEqual({
      是否开启: true,
      要素: {
        火: { 描述: '火之要素', 效果: { 效果: '灼烧；照明' } },
        风: { 描述: '风之要素', 效果: { 迅捷: '移动加快' } },
      },
      权能: { 焚天: { 描述: '权能', 消耗: '25% MP' } },
      法则: {},
      神位: '',
      神国: { 名称: '', 描述: '' },
    });
  });

  it('关系列表全量人物带在场 / 地点 / 好感度，键序遵循词表', () => {
    const relations = obj(tree['关系列表']);
    const bran = obj(relations['布兰']);
    expectSpecOrder(bran, relationSpec);
    expect(bran['在场']).toBe(true);
    expect(bran['地点']).toBe('王都/酒馆');
    expect(bran['好感度']).toBe(30);
    expect(obj(bran['档案'])['外貌']).toBe('高个子');
    expect(bran['数量']).toBeUndefined();
  });

  it('怪物 / 召唤物带类别与数量', () => {
    const goblin = obj(obj(tree['关系列表'])['哥布林']);
    expect(obj(goblin['档案'])['类别']).toBe('怪物');
    expect(goblin['数量']).toBe(3);
    expect(goblin['好感度']).toBe(0);
  });
});

describe('可见性', () => {
  it('缺省：主角、在场角色全量，其余摘要 {在场:false, 地点, 好感度}', () => {
    const relations = obj(buildStateTree(makeInput())['关系列表']);
    expect(Object.keys(relations)).toEqual(['布兰', '卡拉', '哥布林']);
    expect(isStateTreePersonSummary(relations['布兰'])).toBe(false);
    expect(isStateTreePersonSummary(relations['哥布林'])).toBe(false);
    expect(relations['卡拉']).toEqual({ 在场: false, 地点: '王都/酒馆', 好感度: -10 });
    expect(isStateTreePersonSummary(relations['卡拉'])).toBe(true);
  });

  it('focus：调用方点名的角色给全量（不在场也一样）', () => {
    const relations = obj(
      buildStateTree(makeInput(), { visibility: { mode: 'focus', fullNames: ['卡拉'] } })[
        '关系列表'
      ],
    );
    const kara = obj(relations['卡拉']);
    expect(isStateTreePersonSummary(kara)).toBe(false);
    expect(kara['在场']).toBe(false);
    expect(kara['好感度']).toBe(-10);
    expect(kara['档案']).toBeDefined();
  });

  it('focus：fullNames 接受 Set', () => {
    const relations = obj(
      buildStateTree(makeInput(), { visibility: { mode: 'focus', fullNames: new Set(['卡拉']) } })[
        '关系列表'
      ],
    );
    expect(isStateTreePersonSummary(relations['卡拉'])).toBe(false);
  });

  it('all：全部全量', () => {
    const relations = obj(buildStateTree(makeInput(), { visibility: { mode: 'all' } })['关系列表']);
    for (const node of Object.values(relations)) expect(isStateTreePersonSummary(node)).toBe(false);
  });

  it('摘要角色缺好感度时为 0', () => {
    const input = makeInput();
    const t = buildStateTree({ ...input, profile: { ...input.profile, affections: {} } });
    expect(obj(obj(t['关系列表'])['卡拉'])['好感度']).toBe(0);
  });
});

describe('任务与新闻', () => {
  it('任务按插入顺序，字段转中文键', () => {
    const quests = obj(buildStateTree(makeInput())['任务列表']);
    expect(Object.keys(quests)).toEqual(['寻找钥匙', '护送商队']);
    expect(quests['寻找钥匙']).toEqual({
      状态: '进行中',
      关注度: '高',
      进展: '',
      详情: '',
      目标: '找到钥匙',
      奖励: '',
    });
  });

  it('新闻按栏目分组，只投最近若干条，空栏目落未分类', () => {
    const news = buildStateTree(makeInput(), { newsLimit: 2 })['新闻'];
    expect(news).toEqual({
      王都: { 集市开张: '热闹' },
      [UNCATEGORIZED_NEWS_COLUMN]: { 边境告急: '兽人来袭' },
    });
  });

  it('缺省条数为 DEFAULT_STATE_TREE_NEWS_LIMIT，newsLimit 为 0 时新闻为空对象', () => {
    const input = makeInput();
    const many = Array.from({ length: DEFAULT_STATE_TREE_NEWS_LIMIT + 5 }, (_, i) => ({
      id: `n${i}`,
      title: `标题${i}`,
      content: `正文${i}`,
      category: '栏目',
      publishedAt: i,
      read: false,
    }));
    const t = buildStateTree({ ...input, profile: { ...input.profile, news: many } });
    const column = obj(obj(t['新闻'])['栏目']);
    expect(Object.keys(column)).toHaveLength(DEFAULT_STATE_TREE_NEWS_LIMIT);
    expect(Object.keys(column)[0]).toBe('标题5');
    expect(buildStateTree(input, { newsLimit: 0 })['新闻']).toEqual({});
  });
});

describe('不含账务键', () => {
  it('输出不出现 id / saveId / definition / introducedBy / customFields / ageAnchor 等内核字段', () => {
    const keys = allKeys(buildStateTree(makeInput(), { visibility: { mode: 'all' } }));
    for (const banned of [
      'id',
      'saveId',
      'definition',
      'introducedBy',
      'customFields',
      'ageAnchor',
      'equippedSlot',
      'maxHp',
      'maxHpBonus',
      'carryMinutes',
      'sourceKey',
      'lifecycle',
      'secret',
      'publishedAt',
      'read',
    ]) {
      expect(keys.has(banned), banned).toBe(false);
    }
  });

  it('名字为 __proto__ 时按普通键输出，不污染原型', () => {
    const t = buildStateTree(
      makeInput({ characters: [makePlayer(), makeNpc('__proto__', { present: true })] }),
    );
    const relations = obj(t['关系列表']);
    expect(Object.prototype.hasOwnProperty.call(relations, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(relations)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(t))['关系列表']['__proto__']).toBeDefined();
  });
});

describe('纯函数', () => {
  it('不改入参', () => {
    const input = makeInput();
    const before = JSON.stringify(input);
    buildStateTree(input, { visibility: { mode: 'all' } });
    expect(JSON.stringify(input)).toBe(before);
  });
});

// ========== 词表驱动（L6）：投影从词表读键 → 字段 ==========

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

interface KernelLeaf {
  /** 树上的键路径（相对实体节点）。 */
  readonly path: readonly string[];
  /** 内核字段路径（相对实体源对象）。 */
  readonly kernelPath: readonly string[];
  readonly kind: StateTreeLeafKind;
}

/**
 * 收集实体分支下所有带 `kernel` 的叶子：无 `kernel` 的分支是同源分组；有 `kernel` 且源上是对象的分支下钻
 * （`_属性` / `神国`），源上是标量的（资源三项与其 `上限`）仍同源。字典与派生节点不收。
 */
function kernelLeaves(
  spec: StateTreeBranchSpec,
  src: Row,
  relation: boolean,
  path: string[] = [],
  kernelPath: string[] = [],
): KernelLeaf[] {
  const out: KernelLeaf[] = [];
  for (const c of spec.children) {
    if (c.derived || (c.relationOnly && !relation)) continue;
    if (c.type === 'leaf') {
      if (c.kernel) {
        out.push({ path: [...path, c.key], kernelPath: [...kernelPath, c.kernel], kind: c.leaf });
      }
    } else if (c.type === 'branch') {
      const sub = c.kernel === undefined ? undefined : src[c.kernel];
      if (c.kernel !== undefined && isRow(sub)) {
        out.push(...kernelLeaves(c, sub, relation, [...path, c.key], [...kernelPath, c.kernel]));
      } else {
        out.push(...kernelLeaves(c, src, relation, [...path, c.key], kernelPath));
      }
    }
  }
  return out;
}

/** 与原值不同、类型合乎叶子种类的哨兵值。 */
function sentinelFor(kind: StateTreeLeafKind, current: unknown): unknown {
  if (kind === 'boolean') return !current;
  if (kind === 'textArray') return ['哨兵'];
  if (kind === 'effectDict') return { 哨兵: '哨兵词条' };
  if (kind === 'numberDict') return { 哨兵: 7 };
  if (
    typeof current === 'number' ||
    kind === 'number' ||
    kind === 'stacks' ||
    kind === 'quantity'
  ) {
    return (typeof current === 'number' ? current : 0) + 1;
  }
  return '哨兵';
}

function getPath(root: unknown, path: readonly string[]): unknown {
  let cur = root;
  for (const k of path) cur = isRow(cur) ? cur[k] : undefined;
  return cur;
}

function withSentinel<T extends object>(src: T, leaf: KernelLeaf): { src: T; sentinel: unknown } {
  const copy = structuredClone(src) as Row;
  let cur = copy;
  for (const k of leaf.kernelPath.slice(0, -1)) cur = cur[k] as Row;
  const last = leaf.kernelPath[leaf.kernelPath.length - 1];
  const sentinel = sentinelFor(leaf.kind, cur[last]);
  cur[last] = sentinel;
  return { src: copy as T, sentinel };
}

/**
 * 逐个叶子写哨兵值、投影读回：`project(源)` 返回该实体在树上的节点。
 * `transformed` 是投影登记了值变换的内核字段（读到的不是原值），必须真在词表里，免得名单过期。
 */
function expectKernelLeavesRead<T extends object>(
  spec: StateTreeBranchSpec,
  base: T,
  project: (src: T) => unknown,
  transformed: readonly string[],
  relation = false,
): number {
  const leaves = kernelLeaves(spec, base as Row, relation);
  const kernels = new Set(leaves.map((l) => l.kernelPath[l.kernelPath.length - 1]));
  for (const k of transformed) expect(kernels.has(k), `变换名单里的 ${k} 不在词表`).toBe(true);
  let checked = 0;
  for (const leaf of leaves) {
    if (transformed.includes(leaf.kernelPath[leaf.kernelPath.length - 1])) continue;
    const { src, sentinel } = withSentinel(base, leaf);
    expect(getPath(project(src), leaf.path), leaf.path.join('/')).toEqual(sentinel);
    checked++;
  }
  return checked;
}

const PLAYER_NODE = branch(STATE_TREE_SPEC, '主角');
const RELATION_NODE = entry(STATE_TREE_SPEC, '关系列表');
/** 上限拆分：额外由 readResourceCaps 读出（缺席时按现上限 − 基础推）。 */
const PERSON_TRANSFORMED = ['maxHpBonus', 'maxMpBonus', 'maxSpBonus'];
/** 关系专属：类别（中文标签）、好感度（读档案）、在场（布尔化）、数量（只集群出）。 */
const RELATION_TRANSFORMED = [...PERSON_TRANSFORMED, 'type', 'affections', 'present', 'quantity'];

function playerTree(player: CharacterState): unknown {
  return buildStateTree(makeInput({ characters: [player] }))['主角'];
}

describe('词表驱动：带 kernel 的叶子逐个写哨兵值，投影在对应键读到', () => {
  it('词表里每个叶子都有 kernel 或派生标识（投影不另写键 → 字段）', () => {
    const orphans = listStateTreePaths()
      .filter((r) => r.spec.type === 'leaf' && !r.spec.kernel && !r.spec.derived)
      .map((r) => r.pattern);
    expect(orphans).toEqual([]);
  });

  it('派生节点都只读且不带 kernel', () => {
    const derived = listStateTreePaths().filter((r) => r.spec.derived);
    expect(new Set(derived.map((r) => r.spec.key))).toEqual(
      new Set(['_年龄', '_生日', '_基础', '_时段', '_天气', '_回合']),
    );
    for (const r of derived) {
      expect(r.readonly, r.pattern).toBe(true);
      expect(r.spec.kernel, r.pattern).toBeUndefined();
    }
  });

  it('主角', () => {
    const n = expectKernelLeavesRead(PLAYER_NODE, makePlayer(), playerTree, PERSON_TRANSFORMED);
    expect(n).toBeGreaterThan(20);
  });

  it('关系列表人物（含关系专属键）', () => {
    const n = expectKernelLeavesRead(
      RELATION_NODE,
      makeNpc('布兰', { present: true }),
      (npc) =>
        obj(buildStateTree(makeInput({ characters: [makePlayer(), npc] }))['关系列表'])['布兰'],
      RELATION_TRANSFORMED,
      true,
    );
    expect(n).toBeGreaterThan(20);
  });

  it('背包 / 装备物品', () => {
    const player = makePlayer();
    const inv = player.inventory ?? [];
    const bagIdx = inv.findIndex((i) => i.name === '治疗药水');
    const equipIdx = inv.findIndex((i) => i.name === '长剑');
    const treeWith = (idx: number, item: (typeof inv)[number]) => {
      const next = [...inv];
      next[idx] = item;
      return playerTree({ ...player, inventory: next });
    };
    // 治疗药水没有耐久字段：补上，耐久两项才有原值可替换
    const bagItem = { ...inv[bagIdx], durability: 1, maxDurability: 2 };
    expectKernelLeavesRead(
      entry(PLAYER_NODE, '背包'),
      bagItem,
      (i) => getPath(treeWith(bagIdx, i), ['背包', '治疗药水']),
      [],
    );
    expectKernelLeavesRead(
      entry(PLAYER_NODE, '装备'),
      inv[equipIdx],
      (i) => getPath(treeWith(equipIdx, i), ['装备', '长剑']),
      [],
    );
  });

  it('技能 / 状态效果', () => {
    const player = makePlayer();
    const skill = (player.skills ?? [])[0];
    const status = (player.statusEffects ?? [])[0];
    expectKernelLeavesRead(
      entry(PLAYER_NODE, '技能'),
      skill,
      (s) => getPath(playerTree({ ...player, skills: [s] }), ['技能', skill.name]),
      ['type', 'cost', 'relevantAttribute'],
    );
    expectKernelLeavesRead(
      entry(PLAYER_NODE, '状态效果'),
      status,
      (s) => getPath(playerTree({ ...player, statusEffects: [s] }), ['状态效果', status.name]),
      ['remainingTime'],
    );
  });

  it('登神条目（要素 / 权能 / 法则）', () => {
    const asc = branch(PLAYER_NODE, '登神长阶');
    const detail = {
      name: '火',
      description: '火之要素',
      effects: [],
      effectDescriptions: { 灼烧: '附带灼烧' },
      costDescription: '10 MP',
    };
    const recordKernels: Array<[string, 'elements' | 'authority' | 'law']> = [
      ['要素', 'elements'],
      ['权能', 'authority'],
      ['法则', 'law'],
    ];
    for (const [key, kernel] of recordKernels) {
      expect(findChildSpec(asc, key)?.kernel).toBe(kernel);
      expectKernelLeavesRead(
        entry(asc, key),
        detail,
        (d) => {
          const player = makePlayer();
          const ascension = { ...player.ascension, [kernel]: [d] } as CharacterState['ascension'];
          return getPath(playerTree({ ...player, ascension }), ['登神长阶', key, '火']);
        },
        [],
      );
    }
  });

  it('任务条目', () => {
    const input = makeInput();
    const quests = input.profile.quests ?? {};
    expectKernelLeavesRead(
      entry(STATE_TREE_SPEC, '任务列表'),
      quests['寻找钥匙'],
      (q) =>
        obj(
          buildStateTree({ ...input, profile: { ...input.profile, quests: { 寻找钥匙: q } } })[
            '任务列表'
          ],
        )['寻找钥匙'],
      [],
    );
  });

  it('根与世界：命运点数读 fp，世界地点读主角 location', () => {
    const input = makeInput();
    const t = buildStateTree({ ...input, profile: { ...input.profile, fp: 4321 } });
    expect(t['命运点数']).toBe(4321);
    const moved = buildStateTree(
      makeInput({ characters: [makePlayer({ location: '哨兵/地点' })] }),
    );
    expect(obj(moved['世界'])['地点']).toBe('哨兵/地点');
  });
});

describe('宽松形状与词表驱动前的投影逐字一致（审查发现 3）', () => {
  /** 存量档的宽松形状：类型上不合法，按运行时数据构造。 */
  const loose = <T>(v: unknown) => v as T;
  const playerOf = (overrides: Record<string, unknown>) =>
    obj(
      buildStateTree(
        makeInput({ characters: [makePlayer(loose<Partial<CharacterState>>(overrides))] }),
      )['主角'],
    );
  const withItem = (item: Record<string, unknown>) =>
    playerOf({ inventory: [{ name: '剑', quantity: 1, ...item }] });

  it('文本数组 / 词条字典 / 数值字典为 null 时不出键', () => {
    const bag = obj(obj(withItem({ tags: null, effects: null, stats: null })['背包'])['剑']);
    for (const k of ['标签', '效果', '属性']) expect(bag, k).not.toHaveProperty(k);
    const equip = obj(obj(withItem({ equippedSlot: '武器', stats: null })['装备'])['剑']);
    expect(equip).not.toHaveProperty('属性');

    const profile = obj(playerOf({ identity: null, occupation: null })['档案']);
    expect(profile).not.toHaveProperty('身份');
    expect(profile).not.toHaveProperty('职业');

    const skill = obj(
      obj(
        playerOf({
          skills: [{ name: '斩', description: '', type: 'active', tags: null, effects: null }],
        })['技能'],
      )['斩'],
    );
    expect(skill).not.toHaveProperty('标签');
    expect(skill).not.toHaveProperty('效果');

    const status = obj(
      obj(
        playerOf({
          statusEffects: [
            {
              name: '流血',
              description: '',
              category: '减益',
              stacks: 1,
              remainingTime: 3,
              timeUnit: '回合',
              source: '',
              effects: {},
              effectDescriptions: null,
            },
          ],
        })['状态效果'],
      )['流血'],
    );
    expect(status).not.toHaveProperty('效果');
  });

  it('效果为数组 / 分号串、身份为字符串时沿用旧投影的展开结果', () => {
    expect(obj(obj(withItem({ effects: ['锋利', '坚固'] })['背包'])['剑'])['效果']).toEqual({
      0: '锋利',
      1: '坚固',
    });
    expect(obj(obj(withItem({ effects: '锋;利' })['背包'])['剑'])['效果']).toEqual({
      0: '锋',
      1: ';',
      2: '利',
    });
    expect(obj(playerOf({ identity: '骑士' })['档案'])['身份']).toEqual(['骑', '士']);
  });

  it('登神长阶 / 神国为非对象真值时出空壳；清单为字符串时按字符展开', () => {
    const asc = obj(playerOf({ ascension: '开启' })['登神长阶']);
    expect(asc).toEqual({ 要素: {}, 权能: {}, 法则: {} });
    const kingdom = obj(
      playerOf({
        ascension: { enabled: true, elements: '空间', authority: [], law: [], divineKingdom: 1 },
      })['登神长阶'],
    );
    expect(kingdom['要素']).toEqual({ undefined: {} });
    expect(kingdom['神国']).toEqual({});
  });

  it('登神清单是旧 Record 形状时不抛错，按空清单投影', () => {
    const asc = obj(
      playerOf({
        ascension: { enabled: true, elements: { 火: { name: '火', description: 'x' } } },
      })['登神长阶'],
    );
    expect(asc['要素']).toEqual({});
  });
});
