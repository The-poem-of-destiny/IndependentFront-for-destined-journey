/**
 * 影子后值与真实落库的多 op 序列对照（审查报告 R5 前置安全网）
 *
 * 翻译层（`state-tree-translator.ts`）手写镜像 StateManager 各处理器维护一份「影子」状态，
 * 用它算出每条 op 的记录后值。本文件用多 op 序列逐条对照：
 *
 * 1. 整批翻译，拿到每条 op 的记录后值 `records[i].after`；
 * 2. 从同一份种子重新开始，把前 i+1 条 op 经翻译层 → 真实 `StateManager`（fake-indexeddb）
 *    提交（含时间推进）→ 重新投影，读 `records[i].path` 处的值；
 * 3. 断言两者相等。
 *
 * 前缀提交的理由：同一路径在序列里可能被写多次，只有「写到这条为止」的真实落库值才对得上
 * 这条记录的后值。序列都按自然顺序书写（不靠「新建人物先落」的重排，也不写会被折叠的删加对），
 * 前缀翻译与整批翻译的前 i+1 条处理过程一致。
 *
 * 现存分歧用 `it.fails` 标注，每条在注释里写清分歧点；后续抽共享 reducer 取代影子时，
 * 这些用例应当转绿，届时把 `it.fails` 改回 `it`。
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
import type { CharacterState } from '../../../src/core/types/types';
import { parseTreePatchBlock } from '../../../src/core/variables/state-tree-patch';
import {
  buildStateTree,
  type StateTreeValue,
} from '../../../src/core/variables/state-tree-projection';
import {
  readStateTreeValue,
  translateTreeOps,
  type TreeTranslateResult,
} from '../../../src/core/variables/state-tree-translator';
import { makeInput, makeNpc } from './state-tree-fixture';

const SAVE = 'save-1';

type RawOp = { op: string; path: string; value?: unknown; from?: string };

/** 夹具人物 + 可选的额外人物（零上限怪物等）。 */
async function seed(extra: CharacterState[] = []): Promise<void> {
  await initializeDatabase();
  await clearAllData();
  const input = makeInput();
  for (const c of [...input.characters, ...extra]) await saveCharacter(structuredClone(c));
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

/** 对当前落库状态翻译一批 op（不提交）。 */
async function translate(ops: RawOp[]): Promise<TreeTranslateResult> {
  const characters = await getCharacters(SAVE);
  const profile = (await getSaveProfile(SAVE))!;
  const parsed = parseTreePatchBlock({ version: 2, patch: ops });
  if (parsed.kind !== 'patch') throw new Error(`解析失败：${parsed.kind}`);
  expect(parsed.dropped).toEqual([]);
  return translateTreeOps(parsed.ops, { characters, profile }, { actor: 'ai' });
}

/** 翻译 → 真实 StateManager 提交 → 时间推进 → 再投影。 */
async function commit(ops: RawOp[]): Promise<StateTreeValue> {
  const result = await translate(ops);
  const sm = createStateManager(SAVE);
  await sm.commitDomainCommand(result.patches);
  if (result.deltaMinutes > 0) await sm.applyTimeAdvance(result.deltaMinutes);
  return loadTree();
}

/** 建人后续写序列（主序列与「新人物年龄」分歧共用）。 */
const SMITH_OPS: RawOp[] = [
  {
    op: 'add',
    path: '/关系列表/铁匠',
    value: {
      档案: { 种族: '矮人' },
      成长: { 等级: 3, 属性: { 力量: 6, 敏捷: 4, 体质: 7, 智力: 3, 精神: 4 } },
      地点: '王都/铁匠铺',
      在场: true,
      金钱: 10,
    },
  },
  { op: 'delta', path: '/关系列表/铁匠/金钱', value: 5 },
  { op: 'delta', path: '/关系列表/铁匠/生命值/当前', value: -3 },
  { op: 'add', path: '/关系列表/铁匠/背包/铁锤', value: { 类型: '工具', 描述: '沉' } },
  { op: 'replace', path: '/关系列表/铁匠/好感度', value: 15 },
];

/** 零上限怪物：法力上限为 0（基础不为 0，额外缺席读作 −基础）。 */
function zeroCapMonster(): CharacterState {
  return makeNpc('史莱姆', { type: 'monster', present: true, mp: 0, maxMp: 0 });
}

const at = (tree: StateTreeValue, path: string) =>
  readStateTreeValue(tree, path.split('/').filter(Boolean));

interface ParityRow {
  index: number;
  path: string;
  status: string;
  recorded: unknown;
  persisted: unknown;
}

/**
 * 逐条对照：整批翻译的记录后值 vs 前缀真实落库后再投影的值。
 * 返回对照表，调用方断言（`expect(rows).toEqual(...)` 风格，失败时一次看到全部分歧）。
 */
async function parity(ops: RawOp[], extra: CharacterState[] = []): Promise<ParityRow[]> {
  await seed(extra);
  const full = await translate(ops);
  expect(full.records).toHaveLength(ops.length);
  const rows: ParityRow[] = [];
  for (let i = 0; i < ops.length; i++) {
    await seed(extra);
    const tree = await commit(ops.slice(0, i + 1));
    const rec = full.records[i];
    rows.push({
      index: i,
      path: rec.path,
      status: rec.status,
      recorded: rec.after,
      persisted: at(tree, rec.path),
    });
  }
  return rows;
}

/** 删掉值里的一个子路径（两侧同删；只用于把已登记为 `it.fails` 的分歧点从主序列里摘出去）。 */
function omitPath(value: unknown, path: string[]): unknown {
  if (value === undefined) return value;
  const copy = structuredClone(value) as Record<string, unknown>;
  let node: Record<string, unknown> | undefined = copy;
  for (const k of path.slice(0, -1)) node = node?.[k] as Record<string, unknown> | undefined;
  if (node) delete node[path[path.length - 1]];
  return copy;
}

/**
 * 断言整条序列每条 op 都落了（没有被丢），且记录后值与真实落库值逐条相等。
 * `omit`：第 i 条对照前两侧同删的子路径 —— 只许填已在下方「已知分歧」里用 `it.fails` 单独钉住的点。
 */
async function expectParity(
  ops: RawOp[],
  extra: CharacterState[] = [],
  omit: Record<number, string[]> = {},
): Promise<void> {
  const rows = await parity(ops, extra);
  expect(rows.filter((r) => r.status === '已丢弃')).toEqual([]);
  for (const r of rows) {
    const sub = omit[r.index];
    const recorded = sub ? omitPath(r.recorded, sub) : r.recorded;
    const persisted = sub ? omitPath(r.persisted, sub) : r.persisted;
    expect(recorded, `第 ${r.index + 1} 条（${r.path}）记录后值 vs 落库值`).toEqual(persisted);
  }
}

describe('影子后值 = 真实落库：多 op 序列', () => {
  beforeEach(() => seed());

  it('资源：加额外上限 → 当前值超写被钳 → 再扣', async () => {
    await expectParity([
      { op: 'delta', path: '/主角/生命值/上限/额外', value: 100 },
      { op: 'replace', path: '/主角/生命值/当前', value: 999999 },
      { op: 'delta', path: '/主角/生命值/当前', value: -50 },
      { op: 'replace', path: '/主角/法力值/上限/额外', value: -700 },
      { op: 'delta', path: '/主角/法力值/当前', value: 5 },
      { op: 'delta', path: '/关系列表/布兰/体力值/上限/额外', value: 20 },
      { op: 'delta', path: '/关系列表/布兰/体力值/当前', value: 15 },
    ]);
  });

  it('经验：累计经验跨级升级 → 升级后写资源', async () => {
    await expectParity([
      { op: 'delta', path: '/主角/成长/累计经验值', value: 3000 },
      { op: 'delta', path: '/主角/生命值/当前', value: 100 },
      { op: 'replace', path: '/主角/成长/累计经验值', value: 9000 },
      { op: 'replace', path: '/主角/体力值/当前', value: 2 },
    ]);
  });

  it('NPC 等级推层级 → 再写上限与当前', async () => {
    await expectParity([
      { op: 'replace', path: '/关系列表/布兰/成长/等级', value: 12 },
      { op: 'delta', path: '/关系列表/布兰/生命值/上限/额外', value: 30 },
      { op: 'replace', path: '/关系列表/布兰/生命值/当前', value: 99999 },
    ]);
  });

  it('物品：新增 → 加量 → 穿戴顶替原装备 → 消耗', async () => {
    await expectParity([
      { op: 'add', path: '/主角/背包/火把', value: { 类型: '消耗品', 数量: 2, 描述: '照明' } },
      { op: 'delta', path: '/主角/背包/火把/数量', value: 3 },
      { op: 'add', path: '/主角/背包/短剑', value: { 类型: '装备', 描述: '轻巧' } },
      { op: 'move', from: '/主角/背包/短剑', path: '/主角/装备/短剑', value: '武器' },
      { op: 'delta', path: '/主角/背包/治疗药水/数量', value: -1 },
      { op: 'replace', path: '/主角/背包/长剑/描述', value: '换下来的剑' },
    ]);
  });

  it('物品：给 NPC 加物品 → 改耐久 → 卸下', async () => {
    await expectParity([
      {
        op: 'add',
        path: '/关系列表/布兰/装备/铁盾',
        value: { 位置: '副手', 描述: '旧盾', 耐久: { 当前: 10, 上限: 20 } },
      },
      { op: 'delta', path: '/关系列表/布兰/装备/铁盾/耐久/当前', value: 5 },
      { op: 'move', from: '/关系列表/布兰/装备/铁盾', path: '/关系列表/布兰/背包/铁盾' },
    ]);
  });

  it('状态：新增 → 叠层 → 改层数上限 → 超上限再叠', async () => {
    await expectParity([
      {
        op: 'add',
        path: '/主角/状态效果/中毒',
        value: { 类型: '减益', 层数: 1, 剩余时间: '3回合', 描述: '毒' },
      },
      { op: 'delta', path: '/主角/状态效果/中毒/层数', value: 2 },
      { op: 'delta', path: '/主角/状态效果/流血/层数', value: 1 },
      { op: 'replace', path: '/主角/状态效果/流血/剩余时间', value: '2小时' },
      { op: 'delta', path: '/主角/状态效果/流血/层数', value: 10 },
      { op: 'remove', path: '/主角/状态效果/祝福' },
    ]);
  });

  it('技能：新学 → 改消耗 → 改名 → 改名后续写', async () => {
    await expectParity([
      { op: 'add', path: '/主角/技能/火球', value: { 类型: '主动', 消耗: '10MP', 描述: '火' } },
      { op: 'replace', path: '/主角/技能/火球/消耗', value: '5SP' },
      { op: 'move', from: '/主角/技能/斩击', path: '/主角/技能/重斩' },
      { op: 'replace', path: '/主角/技能/重斩/威力', value: 40 },
      { op: 'replace', path: '/主角/技能/直觉/消耗', value: '' },
    ]);
  });

  it('人物改名后续写：好感度跟着搬 → 写好感 / 金钱 / 地点', async () => {
    await expectParity([
      { op: 'move', from: '/关系列表/卡拉', path: '/关系列表/卡拉丽' },
      { op: 'delta', path: '/关系列表/卡拉丽/好感度', value: 25 },
      { op: 'delta', path: '/关系列表/卡拉丽/金钱', value: 5 },
      { op: 'replace', path: '/关系列表/卡拉丽/地点', value: '王都/广场' },
    ]);
  });

  it('建人后续写：新人物 → 金钱 / 资源 / 背包 / 好感', async () => {
    // 第 1 条的 `档案/_年龄` 是已知分歧，单独钉在下方「已知分歧」里
    await expectParity(SMITH_OPS, [], { 0: ['档案', '_年龄'] });
  });

  it('任务 / 变量 / 好感 / 命运点', async () => {
    await expectParity([
      { op: 'add', path: '/任务列表/送信', value: { 目标: '把信送到北门' } },
      { op: 'replace', path: '/任务列表/送信/状态', value: '已完成' },
      { op: 'replace', path: '/任务列表/寻找钥匙/进展', value: '找到线索' },
      { op: 'delta', path: '/命运点数', value: -2 },
      { op: 'delta', path: '/关系列表/布兰/好感度', value: 90 },
      { op: 'delta', path: '/关系列表/卡拉/好感度', value: -5 },
      { op: 'replace', path: '/变量/user/线索', value: ['钥匙', '地图'] },
      { op: 'delta', path: '/变量/sys/计数', value: 2 },
      { op: 'add', path: '/变量/user/新键', value: { 甲: 1 } },
    ]);
  });

  it('减没再加：药水用光后再拿 / 金钱花光后再赚', async () => {
    await expectParity([
      { op: 'delta', path: '/主角/背包/治疗药水/数量', value: -3 },
      { op: 'add', path: '/主角/背包/治疗药水', value: { 类型: '消耗品', 数量: 2 } },
      { op: 'delta', path: '/主角/背包/治疗药水/数量', value: 1 },
      { op: 'delta', path: '/主角/金钱', value: -500 },
      { op: 'delta', path: '/主角/金钱', value: 30 },
      { op: 'delta', path: '/关系列表/布兰/金钱', value: -10 },
      { op: 'delta', path: '/关系列表/布兰/金钱', value: 4 },
    ]);
  });

  it('时间与地点：推进时间 → 换地点 → 再推进', async () => {
    await expectParity([
      { op: 'delta', path: '/世界/时间', value: 30 },
      { op: 'replace', path: '/世界/地点', value: '王都/南门' },
      { op: 'delta', path: '/世界/时间', value: 90 },
      { op: 'replace', path: '/关系列表/布兰/在场', value: false },
    ]);
  });

  it('零上限怪物：写额外上限 → 写法力当前值', async () => {
    await expectParity(
      [
        { op: 'delta', path: '/关系列表/史莱姆/法力值/上限/额外', value: 3 },
        { op: 'replace', path: '/关系列表/史莱姆/体力值/当前', value: 1 },
        { op: 'replace', path: '/关系列表/史莱姆/法力值/上限/额外', value: -990 },
        { op: 'delta', path: '/关系列表/史莱姆/法力值/当前', value: 50 },
      ],
      [zeroCapMonster()],
    );
  });

  it('装备改名后续写：改名 → 写描述 / 耐久', async () => {
    // 第 1 条整件物品的 `类型` 是已知分歧（旧式 type），单独钉在下方「已知分歧」里
    await expectParity(
      [
        { op: 'move', from: '/主角/装备/长剑', path: '/主角/装备/宝剑' },
        { op: 'replace', path: '/主角/装备/宝剑/描述', value: '改名后的剑' },
        { op: 'delta', path: '/主角/装备/宝剑/耐久/当前', value: -5 },
      ],
      [],
      { 0: ['类型'] },
    );
  });
});

/**
 * 已知分歧清单（共享 reducer 任务的验收依据）：每条只断言分歧那一个点，
 * 修好后 `it.fails` 会因「意外通过」而变红，届时改回 `it`。
 */
describe('影子后值 = 真实落库：已知分歧（待共享 reducer 修复）', () => {
  beforeEach(() => seed());

  // 分歧点：零上限怪物（maxMp=0）写法力当前值 5。翻译层按有效上限 max(1, 基础+额外)=1 纠正，
  // 记录说明「已钳到 1」、记录值 1、补丁 set_mp 1；真实 StateManager 按 maxMp=0 钳成 0。
  // 记录后值本身读影子得 0（影子 set_mp 也按 maxMp 钳），与落库一致 —— 分歧在记录的写入值与说明。
  it.fails('零上限怪物写法力：记录写「已钳到 1」，落库为 0', async () => {
    const op: RawOp = { op: 'replace', path: '/关系列表/史莱姆/法力值/当前', value: 5 };
    await seed([zeroCapMonster()]);
    const result = await translate([op]);
    const persisted = at(await commit([op]), '/关系列表/史莱姆/法力值/当前');
    expect(persisted).toBe(0);
    expect(result.records[0].value).toBe(persisted);
  });

  // 分歧点：带旧式 `type`（「武器」，不在物品类型词表内）的已穿戴装备改名（move 到新名字）。
  // 影子把整件物品 JSON 克隆过去，记录后值仍带 `类型: 武器`；真实 add_item 对 type 做
  // normalizeItemType，认不出的旧式值归一成 undefined，落库再投影没有 `类型`。
  it.fails('带旧式 type 的装备改名：记录后值含类型，落库丢类型', async () => {
    const rows = await parity([{ op: 'move', from: '/主角/装备/长剑', path: '/主角/装备/宝剑' }]);
    const recorded = rows[0].recorded as Record<string, unknown>;
    const persisted = rows[0].persisted as Record<string, unknown>;
    expect(recorded['类型']).toBe('武器');
    expect(recorded['类型']).toEqual(persisted['类型']);
  });

  // 分歧点：新建人物。真实 applyAddCharacter 经 ensureCharacterAge 补年龄锚点，投影出只读
  // `档案/_年龄`；影子直接 push 翻译层组装的人物，不补年龄锚点，记录后值没有 `_年龄`。
  it.fails('新建人物：记录后值缺 档案/_年龄，落库有', async () => {
    const rows = await parity(SMITH_OPS.slice(0, 1));
    const recorded = rows[0].recorded as { 档案: Record<string, unknown> };
    const persisted = rows[0].persisted as { 档案: Record<string, unknown> };
    expect(persisted['档案']['_年龄']).toBeDefined();
    expect(recorded['档案']['_年龄']).toEqual(persisted['档案']['_年龄']);
  });
});
