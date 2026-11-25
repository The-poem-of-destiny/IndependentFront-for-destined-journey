/**
 * 状态树读写对称闸门（状态树协议 §7.2，核心闸门）
 *
 * 夹具状态投影出的每个非只读叶子：`replace` 成新值 → `translateTreeOps` → 真实 `StateManager`
 * （fake-indexeddb）提交 → 再投影，读回新值。每个名字字典的 add / remove / move 同理。
 *
 * 三道闸：
 * 1. 词表（`listStateTreePaths()`）里每个节点都登记了翻译规则，否则红。
 * 2. 每个可写叶子、每个名字字典都在本文件有往返用例，否则红（新增叶子必须补用例）。
 * 3. 翻译产物闸门：合法 op 的产物都过 `validateStatePatch` 与 `PatchRehearsal` 预演。
 *
 * 档案文字字段走 character_updates 通道（§5.5），这里按 StateManager 接纳叙事更新的口径
 * （`{...character, ...profile_changes}`）落库后再读回。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllData,
  createDefaultSaveProfile,
  getCharacters,
  getSaveProfile,
  initializeDatabase,
  saveCharacter,
  saveSaveProfile,
} from '../../../src/core/persistence/database';
import { createStateManager } from '../../../src/core/state/state-manager';
import { PatchRehearsal } from '../../../src/core/state/patch-rehearsal';
import { validateStatePatch } from '../../../src/core/state/patch-rules';
import { advanceTime, formatGameTime } from '../../../src/core/time/time-system';
import type { CharacterState } from '../../../src/core/types/types';
import { parseTreePatchBlock } from '../../../src/core/variables/state-tree-patch';
import {
  buildStateTree,
  type StateTreeValue,
} from '../../../src/core/variables/state-tree-projection';
import { listStateTreePaths } from '../../../src/core/variables/state-tree-spec';
import {
  readStateTreeValue,
  stateTreeTranslationRuleOf,
  translateTreeOps,
  type TreeTranslateActor,
  type TreeTranslateResult,
} from '../../../src/core/variables/state-tree-translator';
import { GAME_TIME, makeInput, makeNpc, makePlayer } from './state-tree-fixture';

const SAVE = 'save-1';

const ASCENSION: CharacterState['ascension'] = {
  enabled: false,
  elements: [
    { name: '火之要素', description: '火', effects: [], effectDescriptions: { 燃: '灼烧' } },
  ],
  authority: [{ name: '权能甲', description: '权', effects: [], costDescription: '10MP' }],
  law: [{ name: '法则甲', description: '法', effects: [], costDescription: '无' }],
  deityPosition: '',
  divineKingdom: { name: '', description: '' },
};

/** 夹具：主角与布兰带同样的随身条目，人物相对路径的用例两边共用。 */
function fixtureCharacters(): CharacterState[] {
  const player = makePlayer({ ascension: structuredClone(ASCENSION) });
  const carried = makePlayer();
  const bran = makeNpc('布兰', {
    present: true,
    appearance: '高个子',
    inventory: structuredClone(carried.inventory),
    skills: structuredClone(carried.skills),
    statusEffects: structuredClone(carried.statusEffects),
    ascension: structuredClone(ASCENSION),
  });
  const input = makeInput();
  const others = input.characters.filter((c) => c.name !== '艾琳' && c.name !== '布兰');
  return [player, bran, ...others];
}

async function seed(): Promise<void> {
  await initializeDatabase();
  await clearAllData();
  for (const c of fixtureCharacters()) await saveCharacter(c);
  const input = makeInput();
  const profile = createDefaultSaveProfile(SAVE);
  Object.assign(profile, structuredClone(input.profile));
  await saveSaveProfile(profile);
}

async function loadTree(): Promise<StateTreeValue> {
  const characters = await getCharacters(SAVE);
  const profile = (await getSaveProfile(SAVE))!;
  return buildStateTree(
    { characters, profile },
    { visibility: { mode: 'all' }, newsLimit: Number.MAX_SAFE_INTEGER },
  );
}

type RawOp = { op: string; path: string; value?: unknown; from?: string };

/** 翻译 → 产物闸门 → 真实 StateManager 提交 → 时间推进 → 档案改动落库 → 再投影。 */
async function roundtrip(
  ops: RawOp[],
  actor: TreeTranslateActor = 'ai',
): Promise<{ tree: StateTreeValue; result: TreeTranslateResult }> {
  const characters = await getCharacters(SAVE);
  const profile = (await getSaveProfile(SAVE))!;
  const parsed = parseTreePatchBlock({ version: 2, patch: ops });
  if (parsed.kind !== 'patch') throw new Error(`解析失败：${parsed.kind}`);
  expect(parsed.dropped).toEqual([]);
  const result = translateTreeOps(parsed.ops, { characters, profile }, { actor });

  // 翻译产物闸门：静态校验 + 按顺序预演
  const shadow = structuredClone(characters);
  const rehearsal = new PatchRehearsal(shadow);
  for (const p of result.patches) {
    validateStatePatch(p);
    if (p.op === 'add_character') shadow.push(p.value as CharacterState);
    else rehearsal.vet(p)();
  }

  const sm = createStateManager(SAVE);
  await sm.commitDomainCommand(result.patches);
  if (result.deltaMinutes > 0) await sm.applyTimeAdvance(result.deltaMinutes);
  // 档案文字字段已随补丁落（审查 A8），翻译层不再产 profileChanges 旁路
  expect(result.profileChanges).toEqual([]);
  return { tree: await loadTree(), result };
}

const at = (tree: StateTreeValue, path: string) =>
  readStateTreeValue(tree, path.split('/').filter(Boolean));

// ========== 用例表 ==========

/** 一条叶子往返：写 `value`（缺省 replace），读回 `expect`（缺省等于 value）。 */
interface LeafCase {
  value: unknown;
  op?: 'replace' | 'delta';
  expect?: unknown;
  /** 只对关系列表人物写（主角没有这个键或只读）。 */
  relationOnly?: boolean;
  /** 主角上应被丢弃（等级）。 */
  playerDropped?: boolean;
  /** 关系列表上换个人物（数量只有怪物有）。 */
  relationName?: string;
  /** 以谁的身份写（缺省 AI）。`档案/类别` 对 AI 只读，往返走玩家；AI 侧的丢弃在翻译层单测钉住。 */
  actor?: TreeTranslateActor;
}

/** 人物相对路径模式 → 用例。占位：背包 {物品名}=治疗药水，装备=长剑，技能=斩击，状态=流血。 */
const PERSON_CASES: Record<string, LeafCase> = {
  '/档案/种族': { value: '精灵' },
  '/档案/性别': { value: '男' },
  '/档案/身份': { value: ['佣兵', '向导'] },
  '/档案/职业': { value: ['弓手'] },
  '/档案/外貌': { value: '银发' },
  '/档案/着装': { value: '皮甲' },
  '/档案/性格': { value: '沉稳' },
  '/档案/背景故事': { value: '来自北方' },
  '/档案/类别': { value: '怪物', playerDropped: true, actor: 'player' },
  '/成长/等级': { value: 8, playerDropped: true },
  '/成长/累计经验值': { value: 2500 },
  '/生命值/当前': { value: 1 },
  '/法力值/当前': { value: 1 },
  '/体力值/当前': { value: 1 },
  '/生命值/上限/额外': { value: 10 },
  '/法力值/上限/额外': { value: 10 },
  '/体力值/上限/额外': { value: 10 },
  '/金钱': { value: 777 },
  '/当前行动': { value: '巡逻' },
  '/心里话': { value: '想家' },
  ...itemCases('背包'),
  ...itemCases('装备'),
  '/装备/{物品名}/位置': { value: '副手' },
  '/技能/{技能名}/品质': { value: '稀有' },
  '/技能/{技能名}/类型': { value: '被动' },
  '/技能/{技能名}/消耗': { value: '12MP' },
  '/技能/{技能名}/冷却': { value: 3 },
  '/技能/{技能名}/标签': { value: ['剑'] },
  '/技能/{技能名}/效果': { value: { 破甲: '无视护甲' } },
  '/技能/{技能名}/描述': { value: '新的剑技' },
  '/技能/{技能名}/威力': { value: 55 },
  '/技能/{技能名}/关联属性': { value: '敏捷' },
  '/技能/{技能名}/伤害类型': { value: '能量' },
  '/技能/{技能名}/规则文本': { value: '规则' },
  '/状态效果/{状态名}/类型': { value: '增益' },
  '/状态效果/{状态名}/描述': { value: '血流不止' },
  '/状态效果/{状态名}/效果': { value: { 失血: '每回合损失更多生命' } },
  '/状态效果/{状态名}/层数': { value: 3 },
  '/状态效果/{状态名}/层数上限': { value: 9 },
  '/状态效果/{状态名}/剩余时间': { value: '5小时' },
  '/状态效果/{状态名}/来源': { value: '陷阱' },
  '/登神长阶/是否开启': { value: true },
  '/登神长阶/要素/{要素名}/描述': { value: '烈焰' },
  '/登神长阶/要素/{要素名}/效果': { value: { 焚: '持续燃烧' } },
  '/登神长阶/权能/{权能名}/描述': { value: '新权能' },
  '/登神长阶/权能/{权能名}/效果': { value: { 号令: '指挥' } },
  '/登神长阶/权能/{权能名}/消耗': { value: '20MP' },
  '/登神长阶/法则/{法则名}/描述': { value: '新法则' },
  '/登神长阶/法则/{法则名}/效果': { value: { 定: '静止' } },
  '/登神长阶/法则/{法则名}/消耗': { value: '30SP' },
  '/登神长阶/神位': { value: '火神' },
  '/登神长阶/神国/名称': { value: '炎国' },
  '/登神长阶/神国/描述': { value: '燃烧的国度' },
  '/在场': { value: false, relationOnly: true },
  '/地点': { value: '王都/广场', relationOnly: true },
  '/好感度': { value: 66, relationOnly: true },
  '/数量': { value: 7, relationOnly: true, relationName: '哥布林' },
};

function itemCases(dict: '背包' | '装备'): Record<string, LeafCase> {
  const p = `/${dict}/{物品名}`;
  return {
    [`${p}/品质`]: { value: '史诗' },
    [`${p}/类型`]: { value: '材料' },
    [`${p}/数量`]: { value: 5 },
    [`${p}/标签`]: { value: ['新'] },
    [`${p}/效果`]: { value: { 回复: '恢复体力' } },
    [`${p}/描述`]: { value: '新描述' },
    [`${p}/属性`]: { value: { 攻击力: 3 } },
    [`${p}/耐久/当前`]: { value: 7 },
    [`${p}/耐久/上限`]: { value: 60 },
    [`${p}/规则文本`]: { value: '规则' },
  };
}

/** 顶层用例（非人物）。 */
const ROOT_CASES: Record<string, LeafCase & { path: string }> = {
  '/世界/时间': {
    path: '/世界/时间',
    value: 45,
    op: 'delta',
    expect: formatGameTime(advanceTime(GAME_TIME, 45)),
  },
  '/世界/地点': { path: '/世界/地点', value: '王都/南门' },
  '/命运点数': { path: '/命运点数', value: 50 },
  '/任务列表/{任务名}/状态': { path: '/任务列表/寻找钥匙/状态', value: '已完成' },
  '/任务列表/{任务名}/关注度': { path: '/任务列表/寻找钥匙/关注度', value: '低' },
  '/任务列表/{任务名}/进展': { path: '/任务列表/寻找钥匙/进展', value: '找到线索' },
  '/任务列表/{任务名}/详情': { path: '/任务列表/寻找钥匙/详情', value: '钥匙在井里' },
  '/任务列表/{任务名}/目标': { path: '/任务列表/寻找钥匙/目标', value: '下井' },
  '/任务列表/{任务名}/奖励': { path: '/任务列表/寻找钥匙/奖励', value: '一枚金币' },
  '/新闻/{栏目}/{标题}': { path: '/新闻/王都/号外', value: '国王出巡' },
  '/变量': { path: '/变量/user/线索', value: ['钥匙', '地图'] },
};

const PERSON_PREFIXES = { 主角: '/主角', 关系列表: '/关系列表/{人物名}' } as const;

function instancePath(relPattern: string, personPath: string): string {
  return (personPath + relPattern)
    .replace('/背包/{物品名}', '/背包/治疗药水')
    .replace('/装备/{物品名}', '/装备/长剑')
    .replace('{技能名}', '斩击')
    .replace('{状态名}', '流血')
    .replace('{要素名}', '火之要素')
    .replace('{权能名}', '权能甲')
    .replace('{法则名}', '法则甲');
}

interface ConcreteCase {
  pattern: string;
  path: string;
  c: LeafCase;
  dropped: boolean;
}

function concreteCases(): ConcreteCase[] {
  const out: ConcreteCase[] = [];
  for (const [rel, c] of Object.entries(PERSON_CASES)) {
    if (!c.relationOnly) {
      out.push({
        pattern: PERSON_PREFIXES.主角 + rel,
        path: instancePath(rel, '/主角'),
        c,
        dropped: c.playerDropped === true,
      });
    }
    out.push({
      pattern: PERSON_PREFIXES.关系列表 + rel,
      path: instancePath(rel, `/关系列表/${c.relationName ?? '布兰'}`),
      c,
      dropped: false,
    });
  }
  for (const [pattern, c] of Object.entries(ROOT_CASES))
    out.push({ pattern, path: c.path, c, dropped: false });
  return out;
}

const CASES = concreteCases();

// ========== 闸门 ==========

describe('读写对称闸门：登记', () => {
  it('词表里每个节点都登记了翻译规则', () => {
    const missing = listStateTreePaths()
      .map((r) => r.pattern)
      .filter((p) => stateTreeTranslationRuleOf(p) === undefined);
    expect(missing).toEqual([]);
  });

  it('只读叶子登记为 readonly，可写叶子不是', () => {
    for (const row of listStateTreePaths()) {
      if (row.spec.type !== 'leaf') continue;
      const rule = stateTreeTranslationRuleOf(row.pattern);
      if (row.readonly) expect(rule, row.pattern).toBe('readonly');
      else expect(rule, row.pattern).not.toBe('readonly');
    }
  });

  it('每个可写叶子都有往返用例', () => {
    const covered = new Set(CASES.map((c) => c.pattern));
    const missing = listStateTreePaths()
      .filter((r) => r.spec.type === 'leaf' && !r.readonly)
      .map((r) => r.pattern)
      .filter((p) => !covered.has(p));
    expect(missing).toEqual([]);
  });

  it('每个名字字典都有 add / remove / move 往返用例', () => {
    const covered = new Set(Object.keys(RECORD_CASES).flatMap(expandRecordPattern));
    const missing = listStateTreePaths()
      .filter((r) => r.spec.type === 'record')
      .map((r) => r.pattern)
      .filter((p) => !covered.has(p));
    expect(missing).toEqual([]);
  });
});

describe('读写对称闸门：叶子 replace 往返', () => {
  beforeEach(seed);

  for (const cc of CASES) {
    it(`${cc.pattern}（${cc.path}）`, async () => {
      const before = await loadTree();
      const op: RawOp = { op: cc.c.op ?? 'replace', path: cc.path, value: cc.c.value };
      const { tree, result } = await roundtrip([op], cc.c.actor);
      expect(result.records).toHaveLength(1);
      const rec = result.records[0];
      if (cc.dropped) {
        expect(rec.status).toBe('已丢弃');
        expect(result.patches).toEqual([]);
        expect(at(tree, cc.path)).toEqual(at(before, cc.path));
        return;
      }
      expect(result.dropped).toEqual([]);
      expect(rec.status).not.toBe('已丢弃');
      const want = cc.c.expect ?? cc.c.value;
      expect(at(tree, cc.path)).toEqual(want);
      // 记录的后值就是读回的新值；前值是写入前的投影
      expect(rec.after).toEqual(want);
      expect(rec.before).toEqual(at(before, cc.path));
    });
  }
});

// ========== 名字字典 ==========

interface RecordStep {
  ops: RawOp[];
  check: (tree: StateTreeValue) => void;
  /** 期望整条被丢弃（新闻只增不删）。 */
  dropped?: boolean;
  actor?: TreeTranslateActor;
}

interface RecordCase {
  add: RecordStep;
  remove: RecordStep;
  move: RecordStep;
}

/** 人物下的字典用 `{P}` 占位，主角与布兰各跑一遍。 */
const RECORD_CASES: Record<string, RecordCase> = {
  '{P}/背包': {
    add: {
      ops: [{ op: 'add', path: '{P}/背包/火把', value: { 类型: '消耗品', 数量: 2, 描述: '照明' } }],
      check: (t) => expect(at(t, '{P}/背包/火把')).toMatchObject({ 数量: 2, 描述: '照明' }),
    },
    remove: {
      ops: [{ op: 'remove', path: '{P}/背包/治疗药水' }],
      check: (t) => expect(at(t, '{P}/背包/治疗药水')).toBeUndefined(),
    },
    move: {
      ops: [{ op: 'move', from: '{P}/背包/治疗药水', path: '{P}/背包/大治疗药水' }],
      check: (t) => {
        expect(at(t, '{P}/背包/治疗药水')).toBeUndefined();
        expect(at(t, '{P}/背包/大治疗药水')).toMatchObject({ 数量: 3, 描述: '恢复体力' });
      },
    },
  },
  '{P}/装备': {
    add: {
      ops: [{ op: 'add', path: '{P}/装备/木盾', value: { 位置: '副手', 描述: '木头盾牌' } }],
      check: (t) =>
        expect(at(t, '{P}/装备/木盾')).toMatchObject({ 位置: '副手', 描述: '木头盾牌' }),
    },
    remove: {
      ops: [{ op: 'remove', path: '{P}/装备/长剑' }],
      check: (t) => {
        expect(at(t, '{P}/装备/长剑')).toBeUndefined();
        expect(at(t, '{P}/背包/长剑')).toBeUndefined();
      },
    },
    move: {
      ops: [{ op: 'move', from: '{P}/装备/长剑', path: '{P}/背包/长剑' }],
      check: (t) => {
        expect(at(t, '{P}/装备/长剑')).toBeUndefined();
        expect(at(t, '{P}/背包/长剑')).toMatchObject({ 数量: 1, 描述: '一把好剑' });
      },
    },
  },
  '{P}/技能': {
    add: {
      ops: [
        { op: 'add', path: '{P}/技能/火球', value: { 类型: '主动', 消耗: '10MP', 描述: '火' } },
      ],
      check: (t) => expect(at(t, '{P}/技能/火球')).toMatchObject({ 类型: '主动', 消耗: '10MP' }),
    },
    remove: {
      ops: [{ op: 'remove', path: '{P}/技能/斩击' }],
      check: (t) => expect(at(t, '{P}/技能/斩击')).toBeUndefined(),
    },
    move: {
      ops: [{ op: 'move', from: '{P}/技能/斩击', path: '{P}/技能/重斩' }],
      check: (t) => {
        expect(at(t, '{P}/技能/斩击')).toBeUndefined();
        expect(at(t, '{P}/技能/重斩')).toMatchObject({ 消耗: '10SP', 威力: 30 });
      },
    },
  },
  '{P}/状态效果': {
    add: {
      ops: [
        {
          op: 'add',
          path: '{P}/状态效果/中毒',
          value: { 类型: '减益', 剩余时间: '3回合', 描述: '毒' },
        },
      ],
      check: (t) =>
        expect(at(t, '{P}/状态效果/中毒')).toMatchObject({ 类型: '减益', 剩余时间: '3回合' }),
    },
    remove: {
      ops: [{ op: 'remove', path: '{P}/状态效果/流血' }],
      check: (t) => expect(at(t, '{P}/状态效果/流血')).toBeUndefined(),
    },
    move: {
      ops: [{ op: 'move', from: '{P}/状态效果/流血', path: '{P}/状态效果/大出血' }],
      check: (t) => {
        expect(at(t, '{P}/状态效果/流血')).toBeUndefined();
        expect(at(t, '{P}/状态效果/大出血')).toMatchObject({ 层数: 2, 剩余时间: '3回合' });
      },
    },
  },
  ...ascensionRecord('要素', '火之要素', {}),
  ...ascensionRecord('权能', '权能甲', { 消耗: '10MP' }),
  ...ascensionRecord('法则', '法则甲', { 消耗: '无' }),
  '/关系列表': {
    add: {
      ops: [
        {
          op: 'add',
          path: '/关系列表/铁匠',
          value: {
            档案: { 种族: '矮人' },
            成长: { 等级: 3, 属性: { 力量: 6, 敏捷: 4, 体质: 7, 智力: 3, 精神: 4 } },
            地点: '王都/铁匠铺',
            在场: true,
          },
        },
      ],
      check: (t) =>
        expect(at(t, '/关系列表/铁匠')).toMatchObject({
          档案: { 种族: '矮人' },
          成长: { 等级: 3 },
          地点: '王都/铁匠铺',
          在场: true,
        }),
    },
    remove: {
      ops: [{ op: 'remove', path: '/关系列表/哥布林' }],
      check: (t) => expect(at(t, '/关系列表/哥布林')).toBeUndefined(),
    },
    move: {
      ops: [{ op: 'move', from: '/关系列表/卡拉', path: '/关系列表/卡拉丽' }],
      check: (t) => {
        expect(at(t, '/关系列表/卡拉')).toBeUndefined();
        expect(at(t, '/关系列表/卡拉丽')).toMatchObject({ 好感度: -10 });
      },
    },
  },
  '/任务列表': {
    add: {
      ops: [{ op: 'add', path: '/任务列表/新任务', value: { 目标: '送信' } }],
      check: (t) =>
        expect(at(t, '/任务列表/新任务')).toMatchObject({ 状态: '进行中', 目标: '送信' }),
    },
    remove: {
      ops: [{ op: 'remove', path: '/任务列表/护送商队' }],
      check: (t) => expect(at(t, '/任务列表/护送商队')).toBeUndefined(),
    },
    move: {
      ops: [{ op: 'move', from: '/任务列表/寻找钥匙', path: '/任务列表/找钥匙' }],
      check: (t) => {
        expect(at(t, '/任务列表/寻找钥匙')).toBeUndefined();
        expect(at(t, '/任务列表/找钥匙')).toMatchObject({ 关注度: '高', 目标: '找到钥匙' });
      },
    },
  },
  '/新闻': {
    add: {
      ops: [{ op: 'add', path: '/新闻/边境', value: { 告急: '兽人来袭' } }],
      check: (t) => expect(at(t, '/新闻/边境/告急')).toBe('兽人来袭'),
    },
    remove: {
      ops: [{ op: 'remove', path: '/新闻/王都' }],
      dropped: true,
      check: (t) => expect(at(t, '/新闻/王都/旧闻')).toBe('很久以前'),
    },
    move: {
      ops: [{ op: 'move', from: '/新闻/王都', path: '/新闻/京城' }],
      dropped: true,
      check: (t) => expect(at(t, '/新闻/京城')).toBeUndefined(),
    },
  },
  '/新闻/{栏目}': {
    add: {
      ops: [{ op: 'add', path: '/新闻/王都/号外', value: '国王出巡' }],
      check: (t) => expect(at(t, '/新闻/王都/号外')).toBe('国王出巡'),
    },
    remove: {
      ops: [{ op: 'remove', path: '/新闻/王都/旧闻' }],
      dropped: true,
      check: (t) => expect(at(t, '/新闻/王都/旧闻')).toBe('很久以前'),
    },
    move: {
      ops: [{ op: 'move', from: '/新闻/王都/旧闻', path: '/新闻/王都/新闻' }],
      dropped: true,
      check: (t) => expect(at(t, '/新闻/王都/新闻')).toBeUndefined(),
    },
  },
};

function ascensionRecord(
  key: string,
  existing: string,
  extra: Record<string, string>,
): Record<string, RecordCase> {
  const p = `{P}/登神长阶/${key}`;
  return {
    [p]: {
      add: {
        ops: [
          {
            op: 'add',
            path: `${p}/新${key}`,
            value: { 描述: '新的', 效果: { 甲: '乙' }, ...extra },
          },
        ],
        check: (t) =>
          expect(at(t, `${p}/新${key}`)).toMatchObject({ 描述: '新的', 效果: { 甲: '乙' } }),
      },
      remove: {
        ops: [{ op: 'remove', path: `${p}/${existing}` }],
        check: (t) => expect(at(t, `${p}/${existing}`)).toBeUndefined(),
      },
      move: {
        ops: [{ op: 'move', from: `${p}/${existing}`, path: `${p}/改名${key}` }],
        check: (t) => {
          expect(at(t, `${p}/${existing}`)).toBeUndefined();
          expect(at(t, `${p}/改名${key}`)).toMatchObject({ 描述: expect.any(String) });
        },
      },
    },
  };
}

/** `{P}/…` → 主角与关系列表两种路径模式。 */
function expandRecordPattern(key: string): string[] {
  if (!key.startsWith('{P}')) return [key];
  return [key.replace('{P}', '/主角'), key.replace('{P}', '/关系列表/{人物名}')];
}

function bind(step: RecordStep, person: string): RecordStep {
  const sub = (s: string) => s.replace('{P}', person);
  return {
    ...step,
    ops: step.ops.map((o) => ({
      ...o,
      path: sub(o.path),
      ...(o.from ? { from: sub(o.from) } : {}),
    })),
    check: (tree) => step.check(rebind(tree, person)),
  };
}

/** 检查函数里的 `{P}` 路径：把树挂到一个 `{P}` 键下读。 */
function rebind(tree: StateTreeValue, person: string): StateTreeValue {
  const node = readStateTreeValue(tree, person.split('/').filter(Boolean));
  return { ...(tree as Record<string, StateTreeValue>), '{P}': node ?? null };
}

describe('读写对称闸门：名字字典 add / remove / move', () => {
  beforeEach(seed);

  for (const [key, rc] of Object.entries(RECORD_CASES)) {
    const persons = key.startsWith('{P}') ? ['/主角', '/关系列表/布兰'] : [''];
    for (const person of persons) {
      for (const kind of ['add', 'remove', 'move'] as const) {
        const step = person ? bind(rc[kind], person) : rc[kind];
        it(`${key.replace('{P}', person)} ${kind}`, async () => {
          const { tree, result } = await roundtrip(step.ops, step.actor);
          if (step.dropped) {
            expect(result.records.every((r) => r.status === '已丢弃')).toBe(true);
            expect(result.patches).toEqual([]);
          } else {
            expect(result.dropped).toEqual([]);
          }
          step.check(tree);
        });
      }
    }
  }
});

describe('读写对称闸门：成组写入', () => {
  beforeEach(seed);

  it('先 add 再穿戴、先 remove 再 add 按原顺序成立', async () => {
    const { tree, result } = await roundtrip([
      { op: 'add', path: '/主角/背包/短刀', value: { 类型: '装备', 描述: '锋利' } },
      { op: 'move', from: '/主角/背包/短刀', path: '/主角/装备/短刀', value: '副手' },
      { op: 'remove', path: '/主角/技能/直觉' },
      { op: 'add', path: '/主角/技能/直觉', value: { 类型: '主动', 描述: '重学' } },
    ]);
    expect(result.dropped).toEqual([]);
    expect(at(tree, '/主角/装备/短刀')).toMatchObject({ 位置: '副手', 描述: '锋利' });
    expect(at(tree, '/主角/技能/直觉')).toMatchObject({ 类型: '主动', 描述: '重学' });
  });

  it('新建人物先落：同批写它的叶子也成立', async () => {
    const { tree, result } = await roundtrip([
      { op: 'delta', path: '/关系列表/铁匠/金钱', value: 5 },
      {
        op: 'add',
        path: '/关系列表/铁匠',
        value: {
          成长: { 等级: 2, 属性: { 力量: 5, 敏捷: 5, 体质: 5, 智力: 5, 精神: 5 } },
          地点: '村',
          在场: true,
          金钱: 10,
        },
      },
    ]);
    expect(result.dropped).toEqual([]);
    expect(at(tree, '/关系列表/铁匠/金钱')).toBe(15);
  });
});
