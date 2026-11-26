/**
 * StateManager.commitPlayerEdit —— 玩家编辑写入口（状态树协议 T10，§11.2、§12.3、§7.2）
 *
 * 走真实 StateManager + fake-indexeddb：
 * - 玩家编辑往返：每个可写叶子编辑提交后读回新值；撤销（内核快照整体还原，审查 R4）后整档回到原样；
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
  saveMessage,
  saveSaveProfile,
} from '../../../src/core/persistence/database';
import { createStateManager } from '../../../src/core/state/state-manager';
import type { CharacterState, StateUpdateRecord } from '../../../src/core/types/types';
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
    it(`${cc.pattern}（${cc.path}）：提交读回新值，撤销后整档回到原样`, async () => {
      const sm = createStateManager(SAVE);
      const op: PlayerEditOp = { op: 'replace', path: cc.path, value: cc.c.value };
      const original = await dump();
      if (cc.rejected) {
        const snap = original;
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
      // 快照整体还原：新闻、升级、前值缺席的可选字段也一并回去（不再有豁免）
      const u = await sm.undoPlayerEdit(r.undo);
      if (!u.ok) throw new Error(`撤销失败：${u.reasons.join('；')}`);
      expect(await dump()).toEqual(original);
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
      const before = await dump();
      const r = await sm.commitPlayerEdit(ops);
      if (!r.ok) throw new Error(`${ops[0].path}：${r.reasons.join('；')}`);
      expect(await dump(), ops[0].path).not.toEqual(before);
      const u = await sm.undoPlayerEdit(r.undo);
      if (!u.ok) throw new Error(`撤销 ${ops[0].path}：${u.reasons.join('；')}`);
      // 快照整体还原：被删人物连同 id、内部字段一起回来
      expect(await dump(), ops[0].path).toEqual(before);
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

  // 回归（审查 A8）：档案写入曾走 profileChanges 旁路、按旧名落，同批改名后提交报「角色不存在: 布兰」
  const renameBatches: Array<[string, PlayerEditOp[]]> = [
    [
      '先写档案再改名',
      [
        { op: 'replace', path: '/关系列表/布兰/档案/性格', value: '沉稳' },
        { op: 'move', from: '/关系列表/布兰', path: '/关系列表/布兰特' },
      ],
    ],
    [
      '先改名再写档案',
      [
        { op: 'move', from: '/关系列表/布兰', path: '/关系列表/布兰特' },
        { op: 'replace', path: '/关系列表/布兰特/档案/性格', value: '沉稳' },
      ],
    ],
  ];
  for (const [name, ops] of renameBatches) {
    it(`同批档案写入与改名：${name}，试算与提交都通过，新名读回新值`, async () => {
      const r = await createStateManager(SAVE).commitPlayerEdit(ops);
      if (!r.ok) throw new Error(r.reasons.join('；'));
      const chars = await getCharacters(SAVE);
      expect(chars.some((c) => c.name === '布兰')).toBe(false);
      expect(chars.find((c) => c.name === '布兰特')?.personality).toBe('沉稳');
      expect(at(await loadTree(), '/关系列表/布兰特/档案/性格')).toBe('沉稳');
    });
  }

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

describe('修改器撤销：内核快照整体还原（审查 R4）', () => {
  const player = async () => (await getCharacters(SAVE)).find((c) => c.id === 'player-id')!;

  it('额外改 −9999（当前值被钳到 1）后撤销：当前值回到 300、上限回原值', async () => {
    const sm = createStateManager(SAVE);
    const original = await dump();
    const before = await player();
    const r = await sm.commitPlayerEdit([
      { op: 'replace', path: '/主角/生命值/上限/额外', value: -9999 },
    ]);
    if (!r.ok) throw new Error(r.reasons.join('；'));
    expect((await player()).hp).toBe(1);
    const u = await sm.undoPlayerEdit(r.undo);
    expect(u.ok).toBe(true);
    const after = await player();
    expect(after.hp).toBe(300);
    expect(after.maxHp).toBe(before.maxHp);
    expect(await dump()).toEqual(original);
  });

  it('穿戴顶替后撤销：被顶下的长剑回到装备位，新武器消失', async () => {
    const sm = createStateManager(SAVE);
    const original = await dump();
    const r = await sm.commitPlayerEdit([
      {
        op: 'add',
        path: '/主角/装备/短剑',
        value: { 位置: '武器', 类型: '武器', 描述: '轻巧的短剑' },
      },
    ]);
    if (!r.ok) throw new Error(r.reasons.join('；'));
    const displaced = (await player()).inventory;
    expect(displaced.find((i) => i.name === '短剑')?.equippedSlot).toBe('武器');
    expect(displaced.find((i) => i.name === '长剑')?.equippedSlot ?? null).toBeNull();
    const u = await sm.undoPlayerEdit(r.undo);
    expect(u.ok).toBe(true);
    const inv = (await player()).inventory;
    expect(inv.find((i) => i.name === '长剑')?.equippedSlot).toBe('武器');
    expect(inv.some((i) => i.name === '短剑')).toBe(false);
    expect(await dump()).toEqual(original);
  });

  it('删 NPC 后撤销：id、年龄锚点、投影外的内部字段原样回来', async () => {
    const bran = (await getCharacters(SAVE)).find((c) => c.name === '布兰')!;
    await saveCharacter({
      ...bran,
      ageAnchor: { startAge: 31, month: 5, day: 2 },
      customFields: { secret: '内部字段' },
      introducedBy: 'turn-3',
    });
    const original = (await getCharacters(SAVE)).find((c) => c.name === '布兰')!;
    const sm = createStateManager(SAVE);
    const r = await sm.commitPlayerEdit([{ op: 'remove', path: '/关系列表/布兰' }]);
    if (!r.ok) throw new Error(r.reasons.join('；'));
    expect((await getCharacters(SAVE)).some((c) => c.name === '布兰')).toBe(false);
    const u = await sm.undoPlayerEdit(r.undo);
    expect(u.ok).toBe(true);
    const back = (await getCharacters(SAVE)).find((c) => c.name === '布兰')!;
    expect(back.id).toBe(original.id);
    expect(back.ageAnchor).toEqual({ startAge: 31, month: 5, day: 2 });
    expect(back.customFields).toEqual({ secret: '内部字段' });
    expect(back).toEqual(original);
  });

  it('撤销前状态已被别处改过（指纹不符）：拒绝并说明，状态一字不动', async () => {
    const sm = createStateManager(SAVE);
    const r = await sm.commitPlayerEdit([{ op: 'replace', path: '/主角/金钱', value: 500 }]);
    if (!r.ok) throw new Error(r.reasons.join('；'));
    // 别处（AI 补丁）又改了主角
    await sm.commitChatState([
      { op: 'update_character', target: 'characters.艾琳', value: { money: 42 } },
    ]);
    const snap = await dump();
    const u = await sm.undoPlayerEdit(r.undo);
    expect(u.ok).toBe(false);
    if (!u.ok) {
      expect(u.reasons[0]).toContain('艾琳');
      expect(u.reasons[0]).toContain('又被别处改过');
    }
    expect(await dump()).toEqual(snap);
    expect((await player()).money).toBe(42);
  });

  it('凭据不属于当前存档：拒绝', async () => {
    const r = await createStateManager(SAVE).commitPlayerEdit([
      { op: 'replace', path: '/主角/金钱', value: 500 },
    ]);
    if (!r.ok) throw new Error(r.reasons.join('；'));
    const u = await createStateManager('另一个存档').undoPlayerEdit(r.undo);
    expect(u.ok).toBe(false);
    expect((await player()).money).toBe(500);
  });

  it('连续两次修改按栈序撤销：逐次回到每一步之前', async () => {
    const sm = createStateManager(SAVE);
    const s0 = await dump();
    const r1 = await sm.commitPlayerEdit([{ op: 'replace', path: '/主角/金钱', value: 1 }]);
    if (!r1.ok) throw new Error(r1.reasons.join('；'));
    const s1 = await dump();
    const r2 = await sm.commitPlayerEdit([
      { op: 'replace', path: '/主角/金钱', value: 2 },
      { op: 'delta', path: '/命运点数', value: 3 },
    ]);
    if (!r2.ok) throw new Error(r2.reasons.join('；'));
    expect((await sm.undoPlayerEdit(r2.undo)).ok).toBe(true);
    expect(await dump()).toEqual(s1);
    expect((await sm.undoPlayerEdit(r1.undo)).ok).toBe(true);
    expect(await dump()).toEqual(s0);
  });
});

describe('更新块修订：状态提交与本楼记录写回同一事务（审查 R4）', () => {
  /** 一楼 AI 写入（金钱 120 → 100），记录写在 assistant 消息 a2 上。 */
  async function seedFloor(): Promise<StateUpdateRecord> {
    const r = await createStateManager(SAVE).commitPlayerEdit([
      { op: 'replace', path: '/主角/金钱', value: 100 },
    ]);
    if (!r.ok) throw new Error(r.reasons.join());
    const update: StateUpdateRecord = { deltaMinutes: 0, ops: r.records };
    await saveMessage({
      id: 'a2',
      role: 'assistant',
      content: '第 2 楼正文',
      timestamp: 2,
      saveId: SAVE,
      turn: 2,
      storyTurnStatus: 'accepted',
      stateUpdates: update,
    });
    return update;
  }

  it('记录写回失败（本楼消息不存在 / 没有记录）：状态一并回滚', async () => {
    await seedFloor();
    await saveMessage({
      id: 'a-no-record',
      role: 'assistant',
      content: '没有记录的一楼',
      timestamp: 3,
      saveId: SAVE,
    });
    const snap = await dump();
    for (const messageId of ['不存在的楼', 'a-no-record']) {
      const r = await createStateManager(SAVE).commitPlayerEdit(
        [{ op: 'replace', path: '/主角/金钱', value: 7 }],
        { record: { messageId, index: 0, revision: { kind: 'revert' } } },
      );
      expect(r.ok, messageId).toBe(false);
      if (!r.ok) expect(r.reasons[0]).toContain('记录写回失败');
      expect(await dump(), messageId).toEqual(snap);
    }
  });

  it('修订后从修改器撤销：状态与该楼记录一并还原，之后再修订该行不报冲突', async () => {
    const update = await seedFloor();
    const sm = createStateManager(SAVE);
    const revision = { kind: 'revert' as const };
    const plan = planUpdateBlockRevision(update.ops[0], revision, await loadSnapshot());
    if (plan.kind !== 'ok') throw new Error(JSON.stringify(plan));
    const r = await sm.commitPlayerEdit(plan.ops, {
      record: { messageId: 'a2', index: 0, revision },
    });
    if (!r.ok) throw new Error(r.reasons.join('；'));
    expect((await player()).money).toBe(120);
    const revised = (await getDatabase().messages.get('a2'))!.stateUpdates!;
    expect(revised.ops[0]).toMatchObject({ status: '已手动修订', after: 120 });
    expect(r.stateUpdates).toEqual(revised);
    // 正文不变（§12.3）
    expect((await getDatabase().messages.get('a2'))!.content).toBe('第 2 楼正文');

    const u = await sm.undoPlayerEdit(r.undo);
    expect(u.ok).toBe(true);
    if (u.ok) expect(u.message).toEqual({ id: 'a2', stateUpdates: update });
    expect((await player()).money).toBe(100);
    const restored = (await getDatabase().messages.get('a2'))!.stateUpdates!;
    expect(restored).toEqual(update);

    // 记录与状态一致：再修订这一行不再按现值报冲突（ui/AGENTS.md 旧「已知限制」作废）
    const again = planUpdateBlockRevision(restored.ops[0], revision, await loadSnapshot());
    expect(again.kind).toBe('ok');
  });

  it('本楼记录在撤销前又被改过：指纹不符，拒绝', async () => {
    const update = await seedFloor();
    const sm = createStateManager(SAVE);
    const revision = { kind: 'revert' as const };
    const plan = planUpdateBlockRevision(update.ops[0], revision, await loadSnapshot());
    if (plan.kind !== 'ok') throw new Error(plan.kind);
    const r = await sm.commitPlayerEdit(plan.ops, {
      record: { messageId: 'a2', index: 0, revision },
    });
    if (!r.ok) throw new Error(r.reasons.join('；'));
    const row = (await getDatabase().messages.get('a2'))!;
    await getDatabase().messages.put({ ...row, stateUpdates: { deltaMinutes: 0, ops: [] } });
    const u = await sm.undoPlayerEdit(r.undo);
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.reasons[0]).toContain('本楼更新记录');
    expect((await player()).money).toBe(120);
  });

  const player = async () => (await getCharacters(SAVE)).find((c) => c.id === 'player-id')!;
});

afterEach(() => {
  vi.clearAllMocks();
});
