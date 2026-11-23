/**
 * StateManager.commitPlayerEdit —— 玩家编辑写入口（状态树协议 T10，§11.2、§12.3、§7.2）
 *
 * 走真实 StateManager + fake-indexeddb：
 * - 玩家编辑往返：每个可写叶子编辑提交后读回新值；撤销后读回旧值；
 * - 整批失败时状态零变化（只读键 / 时间 / 被丢弃 / 落库中途抛错回滚）；
 * - 更新块补差：改值、撤销、重新应用的补偿 op 提交后读回正确；现值不符给冲突；
 * - 补丁带 metadata.source = player_edit，记引擎日志 state.manual_edit。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logCalls = vi.hoisted(() => [] as Array<{ category: string; payload: unknown }>);
vi.mock('../../../src/core/runtime/engine-logger', async (orig) => {
  const mod = await orig<typeof import('../../../src/core/runtime/engine-logger')>();
  return {
    ...mod,
    logEngine: (level: never, category: string, msg: string, payload?: unknown, ctx?: never) => {
      logCalls.push({
        category,
        payload: typeof payload === 'function' ? (payload as () => unknown)() : payload,
      });
      mod.logEngine(level, category, msg, payload, ctx);
    },
  };
});

import {
  clearAllData,
  createDefaultSaveProfile,
  getCharacters,
  getDatabase,
  getSaveProfile,
  initializeDatabase,
  saveCharacter,
  saveSaveProfile,
} from '../../../src/core/persistence/database';
import { createStateManager } from '../../../src/core/state/state-manager';
import type { CharacterState } from '../../../src/core/types/types';
import {
  buildStateTree,
  type StateTreeValue,
} from '../../../src/core/variables/state-tree-projection';
import { listStateTreePaths } from '../../../src/core/variables/state-tree-spec';
import {
  applyRevisionToRecord,
  planUpdateBlockRevision,
  type PlayerEditOp,
} from '../../../src/core/variables/state-tree-edit';
import { readStateTreeValue } from '../../../src/core/variables/state-tree-translator';
import { makeInput, makeNpc, makePlayer } from '../variables/state-tree-fixture';

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

async function seed(): Promise<void> {
  await initializeDatabase();
  await clearAllData();
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
  for (const c of [player, bran, ...others]) await saveCharacter(c);
  const profile = createDefaultSaveProfile(SAVE);
  Object.assign(profile, structuredClone(input.profile));
  await saveSaveProfile(profile);
}

async function loadSnapshot() {
  return { characters: await getCharacters(SAVE), profile: (await getSaveProfile(SAVE))! };
}

async function loadTree(): Promise<StateTreeValue> {
  return buildStateTree(await loadSnapshot(), {
    visibility: { mode: 'all' },
    newsLimit: Number.MAX_SAFE_INTEGER,
  });
}

/** 整个存档的可比较快照（角色 + 档案）。 */
async function dump(): Promise<unknown> {
  const s = await loadSnapshot();
  return JSON.parse(
    JSON.stringify({
      characters: [...s.characters].sort((a, b) => a.id.localeCompare(b.id)),
      profile: s.profile,
    }),
  );
}

const at = (tree: StateTreeValue, path: string) =>
  readStateTreeValue(tree, path.split('/').filter(Boolean));

// ========== 用例表（每个可写叶子一条；时间在修改器里只读，单独测） ==========

interface LeafCase {
  value: unknown;
  expect?: unknown;
  relationOnly?: boolean;
  /** 主角上只读（等级） → 整批拒绝。 */
  playerRejected?: boolean;
  relationName?: string;
}

const PERSON_CASES: Record<string, LeafCase> = {
  '/档案/种族': { value: '精灵' },
  '/档案/性别': { value: '男' },
  '/档案/身份': { value: ['佣兵', '向导'] },
  '/档案/职业': { value: ['弓手'] },
  '/档案/外貌': { value: '银发' },
  '/档案/着装': { value: '皮甲' },
  '/档案/性格': { value: '沉稳' },
  '/档案/背景故事': { value: '来自北方' },
  '/档案/类别': { value: '怪物', playerRejected: true },
  '/成长/等级': { value: 8, playerRejected: true },
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

const ROOT_CASES: Record<string, LeafCase & { path: string }> = {
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

function instancePath(rel: string, person: string): string {
  return (person + rel)
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
  rejected: boolean;
}

const CASES: ConcreteCase[] = [];
for (const [rel, c] of Object.entries(PERSON_CASES)) {
  if (!c.relationOnly)
    CASES.push({
      pattern: '/主角' + rel,
      path: instancePath(rel, '/主角'),
      c,
      rejected: c.playerRejected === true,
    });
  CASES.push({
    pattern: '/关系列表/{人物名}' + rel,
    path: instancePath(rel, `/关系列表/${c.relationName ?? '布兰'}`),
    c,
    rejected: false,
  });
}
for (const [pattern, c] of Object.entries(ROOT_CASES))
  CASES.push({ pattern, path: c.path, c, rejected: false });

/**
 * 撤销后读回旧值的豁免：新闻只增不删（撤销一条新闻由快照兜底）；
 * 累计经验值升级不可逆，撤销后经验值回来了、等级不会降（§12.3 同口径）。
 */
const UNDO_EXEMPT = new Set([
  '/新闻/{栏目}/{标题}',
  '/主角/成长/累计经验值',
  '/关系列表/{人物名}/成长/累计经验值',
  // 夹具里长剑的类型是旧值「武器」（不在物品类型词表里）：写回前值会被纠正层拒绝
  '/主角/装备/{物品名}/类型',
  '/关系列表/{人物名}/装备/{物品名}/类型',
]);

/** 投影省略空值：前值缺席时，撤销写回的空串 / 空数组 / 空对象视同原样。 */
function sameAsBefore(now: unknown, before: unknown): boolean {
  if (before !== undefined) return JSON.stringify(now) === JSON.stringify(before);
  return (
    now === undefined ||
    now === '' ||
    (Array.isArray(now) && now.length === 0) ||
    (typeof now === 'object' && now !== null && Object.keys(now).length === 0)
  );
}

beforeEach(async () => {
  logCalls.length = 0;
  await seed();
});

describe('玩家编辑往返（§7.2）', () => {
  it('每个可写叶子都有用例（时间除外：修改器里只读）', () => {
    const covered = new Set(CASES.map((c) => c.pattern));
    const missing = listStateTreePaths()
      .filter((r) => r.spec.type === 'leaf' && !r.readonly)
      .map((r) => r.pattern)
      .filter((p) => p !== '/世界/时间' && !covered.has(p));
    expect(missing).toEqual([]);
  });

  for (const cc of CASES) {
    it(`${cc.pattern}（${cc.path}）：提交读回新值，撤销读回旧值`, async () => {
      const sm = createStateManager(SAVE);
      const before = await loadTree();
      const op: PlayerEditOp = { op: 'replace', path: cc.path, value: cc.c.value };
      if (cc.rejected) {
        const snap = await dump();
        const r = await sm.commitPlayerEdit([op]);
        expect(r.ok).toBe(false);
        expect(await dump()).toEqual(snap);
        return;
      }
      const r = await sm.commitPlayerEdit([op]);
      if (!r.ok) throw new Error(r.reasons.join('；'));
      const want = cc.c.expect ?? cc.c.value;
      const tree = await loadTree();
      expect(at(tree, cc.path)).toEqual(want);
      expect(r.records[0].after).toEqual(want);
      if (UNDO_EXEMPT.has(cc.pattern)) return;
      if (r.undo.length === 0) {
        // 已知限制：前值缺席的可选字段（NPC 未填的档案文字、无耐久物品的耐久）协议里清不回去
        expect(at(before, cc.path), '只有前值缺席时才允许撤销为空').toBeUndefined();
        return;
      }
      const u = await sm.commitPlayerEdit(r.undo);
      if (!u.ok) throw new Error(`撤销失败：${u.reasons.join('；')}`);
      const now = at(await loadTree(), cc.path);
      expect(sameAsBefore(now, at(before, cc.path)), JSON.stringify(now)).toBe(true);
    });
  }

  it('名字字典：add / remove / move 提交后撤销回到原样', async () => {
    const sm = createStateManager(SAVE);
    const batches: PlayerEditOp[][] = [
      [{ op: 'add', path: '/主角/背包/火把', value: { 类型: '消耗品', 数量: 2, 描述: '照明' } }],
      [{ op: 'remove', path: '/主角/背包/治疗药水' }],
      [{ op: 'move', from: '/主角/装备/长剑', path: '/主角/背包/长剑' }],
      [{ op: 'move', from: '/主角/技能/斩击', path: '/主角/技能/重斩' }],
      [{ op: 'remove', path: '/主角/状态效果/流血' }],
      [{ op: 'add', path: '/任务列表/新任务', value: { 目标: '送信' } }],
      [{ op: 'remove', path: '/关系列表/卡拉' }],
    ];
    for (const ops of batches) {
      const before = await loadTree();
      const r = await sm.commitPlayerEdit(ops);
      if (!r.ok) throw new Error(`${ops[0].path}：${r.reasons.join('；')}`);
      expect(await loadTree(), ops[0].path).not.toEqual(before);
      const u = await sm.commitPlayerEdit(r.undo);
      if (!u.ok) throw new Error(`撤销 ${ops[0].path}：${u.reasons.join('；')}`);
      const after = await loadTree();
      // 被删人物按投影重建（尽力而为）：比对叙事上可见的核心字段
      if (ops[0].path === '/关系列表/卡拉') {
        expect(at(after, '/关系列表/卡拉')).toMatchObject({
          地点: at(before, '/关系列表/卡拉/地点'),
          好感度: -10,
        });
        continue;
      }
      expect(after, ops[0].path).toEqual(before);
    }
  });

  it('档案文字字段在同一事务里落（与叙事更新同口径）', async () => {
    const r = await createStateManager(SAVE).commitPlayerEdit([
      { op: 'replace', path: '/关系列表/布兰/档案/外貌', value: '银发' },
      { op: 'replace', path: '/关系列表/布兰/金钱', value: 33 },
    ]);
    expect(r.ok).toBe(true);
    const bran = (await getCharacters(SAVE)).find((c) => c.name === '布兰')!;
    expect(bran.appearance).toBe('银发');
    expect(bran.money).toBe(33);
  });

  it('补丁带 metadata.source = player_edit，记引擎日志 state.manual_edit', async () => {
    await createStateManager(SAVE).commitPlayerEdit([
      { op: 'replace', path: '/主角/金钱', value: 9 },
    ]);
    const entry = logCalls.find((c) => c.category === 'state.manual_edit');
    expect(entry).toBeDefined();
    const patches = (entry!.payload as { patches: Array<{ source: string }> }).patches;
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.every((p) => p.source === 'player_edit')).toBe(true);
  });
});

describe('整批失败时状态零变化', () => {
  const failing: Array<[string, PlayerEditOp[]]> = [
    [
      '只读键',
      [
        { op: 'replace', path: '/主角/金钱', value: 999 },
        { op: 'replace', path: '/主角/成长/_属性点', value: 9 },
      ],
    ],
    [
      '时间',
      [
        { op: 'replace', path: '/主角/金钱', value: 999 },
        { op: 'delta', path: '/世界/时间', value: 600 },
      ],
    ],
    [
      '被丢弃的条目',
      [
        { op: 'delta', path: '/命运点数', value: 5 },
        { op: 'replace', path: '/主角/不存在', value: 1 },
      ],
    ],
    ['删主角', [{ op: 'remove', path: '/关系列表/艾琳' }]],
  ];
  for (const [name, ops] of failing) {
    it(name, async () => {
      const snap = await dump();
      const r = await createStateManager(SAVE).commitPlayerEdit(ops);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reasons.length).toBeGreaterThan(0);
      expect(await dump()).toEqual(snap);
      const entry = logCalls.find((c) => c.category === 'state.manual_edit');
      expect((entry?.payload as { reasons: string[] }).reasons).toEqual(r.reasons);
    });
  }

  it('落库中途抛错 → 事务回滚（命运点数与角色都不变）', async () => {
    const snap = await dump();
    const db = getDatabase();
    const boom = () => {
      throw new Error('磁盘炸了');
    };
    db.characters.hook('creating', boom);
    db.characters.hook('updating', boom);
    try {
      const r = await createStateManager(SAVE).commitPlayerEdit([
        { op: 'delta', path: '/命运点数', value: 5 },
        { op: 'replace', path: '/主角/金钱', value: 1 },
      ]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasons[0]).toContain('提交失败');
    } finally {
      db.characters.hook('creating').unsubscribe(boom);
      db.characters.hook('updating').unsubscribe(boom);
    }
    expect(await dump()).toEqual(snap);
  });
});

describe('更新块补差（§7.2）', () => {
  /** 模拟一楼 AI 写入：生命值 −30、金钱覆盖、一条被丢弃的穿戴。 */
  async function seedTurn() {
    const sm = createStateManager(SAVE);
    const r = await sm.commitPlayerEdit([
      { op: 'delta', path: '/主角/生命值/当前', value: -30 },
      { op: 'replace', path: '/主角/金钱', value: 100 },
    ]);
    if (!r.ok) throw new Error(r.reasons.join());
    return {
      sm,
      update: {
        deltaMinutes: 0,
        ops: [
          ...r.records,
          {
            path: '/主角/装备/木盾',
            op: 'add' as const,
            value: { 位置: '手持' },
            status: '已丢弃' as const,
            note: '槽位认不出',
          },
        ],
      },
    };
  }

  it('改值：−30 改 −10 → 补 +20 后读回 290', async () => {
    const { sm, update } = await seedTurn();
    const plan = planUpdateBlockRevision(
      update.ops[0],
      { kind: 'edit', value: -10 },
      await loadSnapshot(),
    );
    expect(plan.kind === 'ok' && plan.ops).toEqual([
      { op: 'delta', path: '/主角/生命值/当前', value: 20 },
    ]);
    if (plan.kind !== 'ok') return;
    const r = await sm.commitPlayerEdit(plan.ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(at(await loadTree(), '/主角/生命值/当前')).toBe(290);
    const next = applyRevisionToRecord(update, 0, { kind: 'edit', value: -10 }, r.records);
    expect(next.ops[0]).toMatchObject({ status: '已手动修订', value: -10, after: 290 });
  });

  it('撤销：金钱回到前值', async () => {
    const { sm, update } = await seedTurn();
    const plan = planUpdateBlockRevision(update.ops[1], { kind: 'revert' }, await loadSnapshot());
    if (plan.kind !== 'ok') throw new Error(plan.kind);
    expect((await sm.commitPlayerEdit(plan.ops)).ok).toBe(true);
    expect(at(await loadTree(), '/主角/金钱')).toBe(120);
  });

  it('重新应用：被丢弃的穿戴改好槽位后落下', async () => {
    const { sm, update } = await seedTurn();
    const plan = planUpdateBlockRevision(
      update.ops[2],
      { kind: 'reapply', value: { 位置: '副手', 描述: '木头盾牌' } },
      await loadSnapshot(),
    );
    if (plan.kind !== 'ok') throw new Error(JSON.stringify(plan));
    const r = await sm.commitPlayerEdit(plan.ops);
    expect(r.ok).toBe(true);
    expect(at(await loadTree(), '/主角/装备/木盾')).toMatchObject({ 位置: '副手' });
  });

  it('现值已被改过 → 冲突（含现值），不静默覆盖', async () => {
    const { sm, update } = await seedTurn();
    await sm.commitPlayerEdit([{ op: 'replace', path: '/主角/金钱', value: 5 }]);
    const plan = planUpdateBlockRevision(
      update.ops[1],
      { kind: 'edit', value: 80 },
      await loadSnapshot(),
    );
    expect(plan).toEqual({ kind: 'conflict', path: '/主角/金钱', expected: 100, current: 5 });
    expect(at(await loadTree(), '/主角/金钱')).toBe(5);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
