/**
 * 玩家编辑与更新块修订的规划层（状态树协议 T10，§11.2–11.4、§12.3、§7.2「更新块补差」）
 *
 * 纯函数：试算、单行反向 op（更新块撤销）、补差规划、记录改写、撤销凭据指纹。落库往返见 tests/core/state/state-manager.player-edit.test.ts。
 */

import { describe, expect, it } from 'vitest';
import type { StateUpdateOpRecord, StateUpdateRecord } from '../../../src/core/types/types';
import {
  applyRevisionToRecord,
  inverseOpsOf,
  planUpdateBlockRevision,
  playerEditFingerprint,
  previewPlayerEdit,
  revisionBlockReason,
  type PlayerEditOp,
} from '../../../src/core/variables/state-tree-edit';
import { parseTreePatchBlock } from '../../../src/core/variables/state-tree-patch';
import { translateTreeOps } from '../../../src/core/variables/state-tree-translator';
import { makeInput } from './state-tree-fixture';

const snap = () => {
  const input = makeInput();
  return { characters: input.characters, profile: input.profile };
};

const rec = (r: Partial<StateUpdateOpRecord> & Pick<StateUpdateOpRecord, 'path' | 'op'>) =>
  ({ status: '已应用', ...r }) as StateUpdateOpRecord;

describe('previewPlayerEdit', () => {
  it('可写叶子：给出前值 → 后值，ok', () => {
    const p = previewPlayerEdit([{ op: 'replace', path: '/主角/金钱', value: 500 }], snap());
    expect(p.ok).toBe(true);
    expect(p.reasons).toEqual([]);
    expect(p.records[0]).toMatchObject({ before: 120, after: 500 });
    expect(p.translation?.patches.length).toBeGreaterThan(0);
  });

  it('时间路径整批拒绝', () => {
    const p = previewPlayerEdit(
      [
        { op: 'replace', path: '/主角/金钱', value: 500 },
        { op: 'delta', path: '/世界/时间', value: 30 },
      ],
      snap(),
    );
    expect(p.ok).toBe(false);
    expect(p.reasons.join()).toContain('时间');
  });

  it('只读键整批拒绝：路径、忽略前缀的写法、主角等级、对象值里嵌套的键', () => {
    for (const op of [
      { op: 'replace', path: '/主角/成长/_属性点', value: 9 },
      { op: 'replace', path: '/主角/成长/属性点', value: 9 },
      { op: 'replace', path: '/主角/成长/等级', value: 9 },
      { op: 'replace', path: '/主角/成长', value: { 累计经验值: 1000, 等级: 9 } },
      { op: 'replace', path: '/主角/生命值/上限', value: { _基础: 1, 额外: 3 } },
      { op: 'replace', path: '/世界', value: { 时间: '复兴纪元512年3月16日 08:00' } },
    ] as PlayerEditOp[]) {
      const p = previewPlayerEdit([op], snap());
      expect(p.ok, op.path).toBe(false);
      expect(p.reasons.length, op.path).toBeGreaterThan(0);
    }
  });

  it('任一条被丢弃 → 整批拒绝并回传原因', () => {
    const p = previewPlayerEdit(
      [
        { op: 'replace', path: '/主角/金钱', value: 500 },
        { op: 'replace', path: '/主角/不存在', value: 1 },
      ],
      snap(),
    );
    expect(p.ok).toBe(false);
    expect(p.reasons).toEqual(p.dropped);
    expect(p.reasons[0]).toContain('/主角/不存在');
  });

  it('玩家可删任意 NPC，主角不可删', () => {
    expect(previewPlayerEdit([{ op: 'remove', path: '/关系列表/布兰' }], snap()).ok).toBe(true);
    expect(previewPlayerEdit([{ op: 'remove', path: '/关系列表/艾琳' }], snap()).ok).toBe(false);
  });

  it('空批与坏 op 拒绝', () => {
    expect(previewPlayerEdit([], snap()).ok).toBe(false);
    expect(
      previewPlayerEdit([{ op: 'replace', path: '/主角/__proto__/x', value: 1 }], snap()).ok,
    ).toBe(false);
  });
});

describe('inverseOpsOf（更新块单行撤销）', () => {
  it('增量按实际前后差反向；覆盖还原前值', () => {
    expect(
      inverseOpsOf(
        rec({ path: '/主角/生命值/当前', op: 'delta', value: -500, before: 300, after: 0 }),
      ),
    ).toEqual([{ op: 'delta', path: '/主角/生命值/当前', value: 300 }]);
    expect(
      inverseOpsOf(rec({ path: '/主角/金钱', op: 'replace', value: 5, before: 120, after: 5 })),
    ).toEqual([{ op: 'replace', path: '/主角/金钱', value: 120 }]);
  });

  it('add ↔ remove；被删条目按前值重建并剥只读键', () => {
    expect(
      inverseOpsOf(
        rec({ path: '/主角/背包/火把', op: 'add', value: { 数量: 1 }, after: { 数量: 1 } }),
      ),
    ).toEqual([{ op: 'remove', path: '/主角/背包/火把' }]);
    expect(
      inverseOpsOf(
        rec({
          path: '/关系列表/布兰',
          op: 'remove',
          before: { 档案: { _年龄: 20, 种族: '人类' }, 成长: { 等级: 3, _属性: { 力量: 5 } } },
        }),
      ),
    ).toEqual([
      {
        op: 'add',
        path: '/关系列表/布兰',
        value: { 档案: { 种族: '人类' }, 成长: { 等级: 3, 属性: { 力量: 5 } } },
      },
    ]);
  });

  it('move 反向：从装备移出的穿回原槽', () => {
    expect(
      inverseOpsOf(
        rec({
          path: '/主角/背包/长剑',
          from: '/主角/装备/长剑',
          op: 'move',
          before: { 位置: '武器', 数量: 1 },
          after: { 数量: 1 },
        }),
      ),
    ).toEqual([{ op: 'move', from: '/主角/背包/长剑', path: '/主角/装备/长剑', value: '武器' }]);
  });

  it('丢弃行、折叠兄弟行、时间行不产 op', () => {
    const rows = [
      rec({ path: '/主角/金钱', op: 'replace', value: 1, status: '已丢弃', before: 1, after: 1 }),
      rec({
        path: '/主角/背包/长剑',
        op: 'remove',
        status: '已纠正',
        note: '已与第 2 条折叠成 move',
        foldedInto: 1,
        foldKind: 'fold',
        before: { 数量: 1 },
      }),
      rec({ path: '/世界/时间', op: 'delta', value: 30 }),
    ];
    for (const r of rows) expect(inverseOpsOf(r), r.path).toEqual([]);
  });
});

describe('playerEditFingerprint（撤销凭据指纹，审查 R4）', () => {
  it('键序无关、忽略 undefined 字段；值变了指纹就变', () => {
    const a = playerEditFingerprint({
      characters: { x: { name: '甲', hp: 1, note: undefined } as never },
    });
    const b = playerEditFingerprint({ characters: { x: { hp: 1, name: '甲' } as never } });
    expect(a).toBe(b);
    expect(playerEditFingerprint({ characters: { x: { hp: 2, name: '甲' } as never } })).not.toBe(
      a,
    );
  });

  it('角色不存在（null）与档案 / 记录是否参与，都会反映在指纹里', () => {
    const none = playerEditFingerprint({ characters: { x: null } });
    expect(none).not.toBe(playerEditFingerprint({ characters: {} }));
    expect(playerEditFingerprint({ characters: {}, stateUpdates: null })).not.toBe(
      playerEditFingerprint({ characters: {} }),
    );
  });
});

describe('planUpdateBlockRevision（§12.3 补差）', () => {
  // 夹具主角生命值当前 300；记录「−30」已应用，现值 270 —— 构造一份现值为 270 的快照
  const snapAt = (hp: number) => {
    const s = snap();
    s.characters = s.characters.map((c) => (c.type === 'player' ? { ...c, hp } : c));
    return s;
  };
  const hpRec = rec({
    path: '/主角/生命值/当前',
    op: 'delta',
    value: -30,
    before: 300,
    after: 270,
  });

  it('改值：增量按差额补（−30 改 −10 补 +20）', () => {
    const plan = planUpdateBlockRevision(hpRec, { kind: 'edit', value: -10 }, snapAt(270));
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.ops).toEqual([{ op: 'delta', path: '/主角/生命值/当前', value: 20 }]);
    expect(plan.preview.records[0]).toMatchObject({ before: 270, after: 290 });
  });

  it('改值：钳制过的增量按「前值 + 新增量」与现值求差', () => {
    const clamped = rec({
      path: '/主角/生命值/当前',
      op: 'delta',
      value: -500,
      before: 300,
      after: 0,
    });
    const plan = planUpdateBlockRevision(clamped, { kind: 'edit', value: -100 }, snapAt(0));
    expect(plan.kind === 'ok' && plan.ops).toEqual([
      { op: 'delta', path: '/主角/生命值/当前', value: 200 },
    ]);
  });

  it('改值：覆盖型按目标值设', () => {
    const plan = planUpdateBlockRevision(
      rec({ path: '/主角/金钱', op: 'replace', value: 100, before: 50, after: 120 }),
      { kind: 'edit', value: 80 },
      snap(),
    );
    expect(plan.kind === 'ok' && plan.ops).toEqual([
      { op: 'replace', path: '/主角/金钱', value: 80 },
    ]);
  });

  it('撤销：增量反向补回前值', () => {
    const plan = planUpdateBlockRevision(hpRec, { kind: 'revert' }, snapAt(270));
    expect(plan.kind === 'ok' && plan.ops).toEqual([
      { op: 'delta', path: '/主角/生命值/当前', value: 30 },
    ]);
  });

  it('撤销：新增条目 → remove', () => {
    const s = snap();
    const tree = previewPlayerEdit(
      [{ op: 'add', path: '/主角/背包/火把', value: { 类型: '消耗品', 数量: 2 } }],
      s,
    );
    const added = tree.records[0];
    // 现值里没有火把 → 冲突；强制则仍产 remove（再由试算拒绝：条目不存在）
    expect(planUpdateBlockRevision(added, { kind: 'revert' }, s).kind).toBe('conflict');
  });

  it('重新应用：被丢弃的行改好后重新提交', () => {
    const dropped = rec({
      path: '/主角/装备/木盾',
      op: 'add',
      value: { 位置: '手持' },
      status: '已丢弃',
      note: '槽位认不出',
    });
    const plan = planUpdateBlockRevision(
      dropped,
      { kind: 'reapply', value: { 位置: '副手', 描述: '木头盾牌' } },
      snap(),
    );
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.ops).toEqual([
      { op: 'add', path: '/主角/装备/木盾', value: { 位置: '副手', 描述: '木头盾牌' } },
    ]);
    expect(plan.preview.records[0].after).toMatchObject({ 位置: '副手' });
  });

  it('重新应用仍不成立 → invalid 带原因', () => {
    const dropped = rec({
      path: '/主角/装备/木盾',
      op: 'add',
      value: { 位置: '手持' },
      status: '已丢弃',
    });
    const plan = planUpdateBlockRevision(dropped, { kind: 'reapply' }, snap());
    expect(plan.kind).toBe('invalid');
  });

  it('新增一条', () => {
    const plan = planUpdateBlockRevision(
      null,
      { kind: 'append', op: { op: 'delta', path: '/关系列表/布兰/好感度', value: 5 } },
      snap(),
    );
    expect(plan.kind === 'ok' && plan.preview.records[0]).toMatchObject({ before: 30, after: 35 });
  });

  it('现值与记录的后值不符 → 冲突（含现值），不静默覆盖；force 时按目标值', () => {
    const plan = planUpdateBlockRevision(hpRec, { kind: 'edit', value: -10 }, snapAt(200));
    expect(plan).toEqual({
      kind: 'conflict',
      path: '/主角/生命值/当前',
      expected: 270,
      current: 200,
    });
    const forced = planUpdateBlockRevision(hpRec, { kind: 'edit', value: -10 }, snapAt(200), {
      force: true,
    });
    // 目标 = 前值 300 + (−10) = 290，现值 200 → 补 +90
    expect(forced.kind === 'ok' && forced.ops).toEqual([
      { op: 'delta', path: '/主角/生命值/当前', value: 90 },
    ]);
    const forcedRevert = planUpdateBlockRevision(hpRec, { kind: 'revert' }, snapAt(200), {
      force: true,
    });
    expect(forcedRevert.kind === 'ok' && forcedRevert.ops).toEqual([
      { op: 'replace', path: '/主角/生命值/当前', value: 300 },
    ]);
  });

  it('时间、累计经验值、新建人物、登神长阶不可修订', () => {
    const rows = [
      rec({ path: '/世界/时间', op: 'delta', value: 30 }),
      rec({ path: '/主角/成长/累计经验值', op: 'delta', value: 100, before: 900, after: 1000 }),
      rec({ path: '/关系列表/铁匠', op: 'add', value: {}, after: {} }),
      rec({
        path: '/主角/登神长阶/是否开启',
        op: 'replace',
        value: true,
        before: false,
        after: true,
      }),
    ];
    for (const r of rows) {
      expect(revisionBlockReason(r), r.path).toBeTruthy();
      expect(planUpdateBlockRevision(r, { kind: 'revert' }, snap()).kind, r.path).toBe('blocked');
    }
    expect(revisionBlockReason(hpRec)).toBeNull();
  });

  it('动作不对 → invalid', () => {
    expect(planUpdateBlockRevision(hpRec, { kind: 'reapply' }, snapAt(270)).kind).toBe('invalid');
    expect(
      planUpdateBlockRevision(
        rec({ path: '/主角/金钱', op: 'replace', value: 1, status: '已丢弃' }),
        { kind: 'edit', value: 2 },
        snap(),
      ).kind,
    ).toBe('invalid');
    expect(
      planUpdateBlockRevision(
        rec({ path: '/主角/背包/绳子', op: 'remove', before: { 数量: 1 } }),
        { kind: 'edit', value: 2 },
        snap(),
      ).kind,
    ).toBe('invalid');
  });
});

describe('applyRevisionToRecord', () => {
  const update: StateUpdateRecord = {
    deltaMinutes: 30,
    ops: [
      rec({ path: '/主角/生命值/当前', op: 'delta', value: -30, before: 300, after: 270 }),
      rec({ path: '/主角/装备/木盾', op: 'add', value: { 位置: '手持' }, status: '已丢弃' }),
    ],
  };

  it('改值：行标「已手动修订」，值与后值取新', () => {
    const next = applyRevisionToRecord(update, 0, { kind: 'edit', value: -10 }, [
      rec({ path: '/主角/生命值/当前', op: 'delta', value: 20, before: 270, after: 290 }),
    ]);
    expect(next.ops[0]).toMatchObject({
      status: '已手动修订',
      value: -10,
      before: 300,
      after: 290,
    });
    expect(update.ops[0].status).toBe('已应用');
    expect(next.deltaMinutes).toBe(30);
  });

  it('撤销：后值回到前值', () => {
    const next = applyRevisionToRecord(update, 0, { kind: 'revert' }, [
      rec({ path: '/主角/生命值/当前', op: 'delta', value: 30, before: 270, after: 300 }),
    ]);
    expect(next.ops[0]).toMatchObject({ status: '已手动修订', after: 300 });
  });

  it('重新应用：值换新、后值取提交结果', () => {
    const next = applyRevisionToRecord(update, 1, { kind: 'reapply', value: { 位置: '副手' } }, [
      rec({ path: '/主角/装备/木盾', op: 'add', value: { 位置: '副手' }, after: { 位置: '副手' } }),
    ]);
    expect(next.ops[1]).toMatchObject({
      status: '已手动修订',
      value: { 位置: '副手' },
      after: { 位置: '副手' },
    });
  });

  it('新增：追加新行', () => {
    const next = applyRevisionToRecord(
      update,
      null,
      { kind: 'append', op: { op: 'delta', path: '/关系列表/布兰/好感度', value: 5 } },
      [rec({ path: '/关系列表/布兰/好感度', op: 'delta', value: 5, before: 30, after: 35 })],
    );
    expect(next.ops).toHaveLength(3);
    expect(next.ops[2]).toMatchObject({ status: '已手动修订', after: 35 });
  });
});

/** 改夹具主角：返回新快照（不碰共享夹具）。 */
function snapWithPlayer(
  edit: (p: ReturnType<typeof snap>['characters'][number]) => void,
): ReturnType<typeof snap> {
  const s = snap();
  s.characters = s.characters.map((c) => {
    if (c.type !== 'player') return c;
    const copy = structuredClone(c);
    edit(copy);
    return copy;
  });
  return s;
}

/** AI 身份翻译一批 op，取记录（模拟本楼记录）。 */
function aiRecords(ops: PlayerEditOp[], s = snap()): StateUpdateOpRecord[] {
  const parsed = parseTreePatchBlock({ version: 2, patch: ops });
  if (parsed.kind !== 'patch') throw new Error(parsed.kind);
  return translateTreeOps(parsed.ops, s, { actor: 'ai' }).records;
}

describe('审查修复：叠加型 add 的改值（第 4 条）', () => {
  // 药水 3，AI add {数量:2} → 5；玩家把这行改成 {数量:1}，意图 = 4
  const stacked = () =>
    aiRecords([{ op: 'add', path: '/主角/背包/治疗药水', value: { 数量: 2 } }])[0];
  const atFive = () =>
    snapWithPlayer((p) => {
      p.inventory.find((i) => i.name === '治疗药水')!.quantity = 5;
    });

  it('背包物品按「新增量 − 原增量」补数量差额，不按目标值覆盖', () => {
    const r = stacked();
    expect(r.before).toMatchObject({ 数量: 3 });
    expect(r.after).toMatchObject({ 数量: 5 });
    const plan = planUpdateBlockRevision(r, { kind: 'edit', value: { 数量: 1 } }, atFive());
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.ops).toEqual([{ op: 'delta', path: '/主角/背包/治疗药水/数量', value: -1 }]);
    expect(plan.preview.records[0]).toMatchObject({ before: 5, after: 4 });
    expect(revisionBlockReason(r, 'edit')).toBeNull();
  });

  it('叠加到已有状态上的 add：改值封锁（只能撤销），撤销照常', () => {
    const r = aiRecords([{ op: 'add', path: '/主角/状态效果/流血', value: { 层数: 1 } }])[0];
    expect(r.before).toBeDefined();
    const s = snapWithPlayer((p) => {
      p.statusEffects.find((e) => e.name === '流血')!.stacks = 3;
    });
    expect(revisionBlockReason(r, 'edit')).toContain('只能撤销');
    expect(revisionBlockReason(r)).toBeNull();
    expect(planUpdateBlockRevision(r, { kind: 'edit', value: { 层数: 2 } }, s).kind).toBe(
      'blocked',
    );
    expect(planUpdateBlockRevision(r, { kind: 'revert' }, s).kind).toBe('ok');
  });

  it('整块 / 已有人物整对象 add、变量数组插入：改值封锁', () => {
    for (const r of [
      rec({
        path: '/主角/背包',
        op: 'add',
        value: { 治疗药水: { 数量: 1 } },
        before: {},
        after: {},
      }),
      rec({ path: '/关系列表/布兰', op: 'add', value: {}, before: {}, after: {} }),
      rec({
        path: '/变量/user/线索/-',
        op: 'add',
        value: '地图',
        before: ['钥匙'],
        after: ['钥匙', '地图'],
      }),
    ])
      expect(revisionBlockReason(r, 'edit'), r.path).toContain('只能撤销');
  });

  it('非叠加的 add（新物品）仍按整对象覆盖，不受影响', () => {
    const r = aiRecords([{ op: 'add', path: '/主角/背包/火把', value: { 数量: 2 } }])[0];
    expect(revisionBlockReason(r, 'edit')).toBeNull();
  });
});

describe('审查修复：把条目减没的那条可撤销、可改值（第 5 条）', () => {
  const usedUp = () => aiRecords([{ op: 'delta', path: '/主角/背包/治疗药水/数量', value: -3 }])[0];
  const noPotion = () =>
    snapWithPlayer((p) => {
      p.inventory = p.inventory.filter((i) => i.name !== '治疗药水');
    });

  it('撤销：按条目整对象前值 add 回来', () => {
    const r = usedUp();
    expect(inverseOpsOf(r)).toEqual([
      { op: 'add', path: '/主角/背包/治疗药水', value: expect.objectContaining({ 数量: 3 }) },
    ]);
    const plan = planUpdateBlockRevision(r, { kind: 'revert' }, noPotion());
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.preview.records[0].after).toMatchObject({ 数量: 3, 类型: '消耗品' });
  });

  it('改值：先重建再设成「前值 + 新增量」（−3 改 −2 → 剩 1）', () => {
    const plan = planUpdateBlockRevision(usedUp(), { kind: 'edit', value: -2 }, noPotion());
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.ops).toEqual([
      { op: 'add', path: '/主角/背包/治疗药水', value: expect.objectContaining({ 数量: 1 }) },
    ]);
    expect(plan.preview.records[0].after).toMatchObject({ 数量: 1 });
  });

  it('状态层数减到 0：撤销与改值同样重建', () => {
    const r = aiRecords([{ op: 'delta', path: '/主角/状态效果/流血/层数', value: -2 }])[0];
    const s = snapWithPlayer((p) => {
      p.statusEffects = p.statusEffects.filter((e) => e.name !== '流血');
    });
    const revert = planUpdateBlockRevision(r, { kind: 'revert' }, s);
    expect(revert.kind === 'ok' && revert.preview.records[0].after).toMatchObject({ 层数: 2 });
    const edit = planUpdateBlockRevision(r, { kind: 'edit', value: -1 }, s);
    expect(edit.kind === 'ok' && edit.preview.records[0].after).toMatchObject({ 层数: 1 });
  });

  it('缺整对象前值的旧记录：判 blocked 并说明原因', () => {
    const { entryBefore: _drop, ...old } = usedUp();
    expect(revisionBlockReason(old)).toContain('减没');
    expect(planUpdateBlockRevision(old, { kind: 'revert' }, noPotion()).kind).toBe('blocked');
  });
});

describe('审查修复：变量数组插入的撤销（a）', () => {
  const withClues = (clues: string[]) => {
    const s = snap();
    s.profile = { ...s.profile, variables: { ...s.profile.variables, user: { 线索: clues } } };
    return s;
  };

  it('追加到末尾：记录父数组前后值，撤销把父数组整份写回（不再 replace …/-）', () => {
    const r = aiRecords([{ op: 'add', path: '/变量/user/线索/-', value: '地图' }])[0];
    expect(r).toMatchObject({ before: ['钥匙'], after: ['钥匙', '地图'] });
    expect(inverseOpsOf(r)).toEqual([{ op: 'replace', path: '/变量/user/线索', value: ['钥匙'] }]);
    const plan = planUpdateBlockRevision(r, { kind: 'revert' }, withClues(['钥匙', '地图']));
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.preview.translation?.patches).toEqual([
      { op: 'set_variable', target: 'variables.user.线索', value: ['钥匙'] },
    ]);
  });

  it('按下标插入：同样记父数组，撤销写回插入前', () => {
    const r = aiRecords([{ op: 'add', path: '/变量/user/线索/0', value: '地图' }])[0];
    expect(r).toMatchObject({ before: ['钥匙'], after: ['地图', '钥匙'] });
    expect(inverseOpsOf(r)).toEqual([{ op: 'replace', path: '/变量/user/线索', value: ['钥匙'] }]);
    expect(planUpdateBlockRevision(r, { kind: 'revert' }, withClues(['地图', '钥匙'])).kind).toBe(
      'ok',
    );
    // 父数组之后又被改过 → 冲突，不静默覆盖
    expect(planUpdateBlockRevision(r, { kind: 'revert' }, withClues(['别的'])).kind).toBe(
      'conflict',
    );
  });

  it('认不出插入前后的旧记录：撤销也判 blocked', () => {
    const old = rec({ path: '/变量/user/线索/-', op: 'add', value: '地图', after: '地图' });
    expect(revisionBlockReason(old)).toContain('无法定位');
    expect(planUpdateBlockRevision(old, { kind: 'revert' }, snap()).kind).toBe('blocked');
  });
});

describe('审查修复：新闻行只增不删（b）', () => {
  const news = rec({ path: '/新闻/王都/号外', op: 'add', value: '国王出巡', after: '国王出巡' });

  it('已应用的新闻行：撤销与改值都 blocked', () => {
    expect(revisionBlockReason(news)).toBe('新闻只增不删，无法在此撤销');
    expect(planUpdateBlockRevision(news, { kind: 'revert' }, snap()).kind).toBe('blocked');
    expect(planUpdateBlockRevision(news, { kind: 'edit', value: '改' }, snap()).kind).toBe(
      'blocked',
    );
  });

  it('被丢弃的新闻行仍可改好后重新应用', () => {
    const dropped = rec({ path: '/新闻/王都/号外', op: 'add', value: '', status: '已丢弃' });
    expect(revisionBlockReason(dropped)).toBeNull();
    expect(
      planUpdateBlockRevision(dropped, { kind: 'reapply', value: '国王出巡' }, snap()).kind,
    ).toBe('ok');
  });
});

describe('审查修复：叠到已穿戴物品上的背包 add（c）', () => {
  it('记录改成 装备/<物>/数量 的 delta，带数量前值；撤销只减回叠加量', () => {
    const r = aiRecords([{ op: 'add', path: '/主角/背包/旧护符', value: { 数量: 1 } }])[0];
    expect(r).toMatchObject({
      path: '/主角/装备/旧护符/数量',
      op: 'delta',
      value: 1,
      before: 2,
      after: 3,
      status: '已纠正',
    });
    expect(inverseOpsOf(r)).toEqual([{ op: 'delta', path: '/主角/装备/旧护符/数量', value: -1 }]);
    const s = snapWithPlayer((p) => {
      p.inventory.find((i) => i.name === '旧护符')!.quantity = 3;
    });
    const plan = planUpdateBlockRevision(r, { kind: 'revert' }, s);
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.preview.translation?.patches).toEqual([
      { op: 'remove_item', target: 'characters.艾琳', value: { name: '旧护符', quantity: 1 } },
    ]);
  });

  it('已穿戴的单件（投影省略数量 1）：撤销同样只减 1，不删整件', () => {
    const r = aiRecords([{ op: 'add', path: '/主角/背包/长剑', value: { 数量: 1 } }])[0];
    expect(r).toMatchObject({ path: '/主角/装备/长剑/数量', op: 'delta', after: 2 });
    expect(inverseOpsOf(r)).toEqual([{ op: 'delta', path: '/主角/装备/长剑/数量', value: -1 }]);
  });
});

describe('复审修复：减没条目的行修订后不再重复重建（1）', () => {
  const ropeGone = () =>
    snapWithPlayer((p) => {
      p.inventory = p.inventory.filter((i) => i.name !== '绳子');
    });
  const usedRope = () => aiRecords([{ op: 'delta', path: '/主角/背包/绳子/数量', value: -1 }])[0];

  it('同一行连撤两次：第一次重建，行去掉整对象前值、后值写回；第二次无操作', () => {
    const r = usedRope();
    expect(r.entryBefore).toBeDefined();
    const first = planUpdateBlockRevision(r, { kind: 'revert' }, ropeGone());
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    const row = applyRevisionToRecord(
      { ops: [r], deltaMinutes: 0 },
      0,
      { kind: 'revert' },
      first.preview.records,
    ).ops[0];
    expect(row.entryBefore).toBeUndefined();
    expect(row.after).toBe(1);
    // 现状：绳子回来了（1 根）
    const second = planUpdateBlockRevision(row, { kind: 'revert' }, snap());
    expect(second).toEqual({ kind: 'invalid', reasons: ['修订前后没有差别'] });
  });

  it('条目现在已存在时不再整对象重建（强制撤销退回叶子覆盖）', () => {
    const plan = planUpdateBlockRevision(usedRope(), { kind: 'revert' }, snap(), { force: true });
    expect(plan.kind === 'ok' && plan.ops).toEqual([
      { op: 'replace', path: '/主角/背包/绳子/数量', value: 1 },
    ]);
  });

  it('改值后再改值：第一次重建并写后值，第二次按叶子补差、无冲突；再次减没时带上新的整对象前值', () => {
    const r = aiRecords([{ op: 'delta', path: '/主角/状态效果/流血/层数', value: -2 }])[0];
    const gone = snapWithPlayer((p) => {
      p.statusEffects = p.statusEffects.filter((e) => e.name !== '流血');
    });
    const first = planUpdateBlockRevision(r, { kind: 'edit', value: -1 }, gone);
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    const row = applyRevisionToRecord(
      { ops: [r], deltaMinutes: 0 },
      0,
      { kind: 'edit', value: -1 },
      first.preview.records,
    ).ops[0];
    expect(row.after).toBe(1);
    expect(row.entryBefore).toBeUndefined();
    const oneStack = snapWithPlayer((p) => {
      p.statusEffects.find((e) => e.name === '流血')!.stacks = 1;
    });
    const second = planUpdateBlockRevision(row, { kind: 'edit', value: -2 }, oneStack);
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.ops).toEqual([{ op: 'delta', path: '/主角/状态效果/流血/层数', value: -1 }]);
    const row2 = applyRevisionToRecord(
      { ops: [row], deltaMinutes: 0 },
      0,
      { kind: 'edit', value: -2 },
      second.preview.records,
    ).ops[0];
    expect(row2.entryBefore).toMatchObject({ 层数: 1 });
    expect(row2.after).toBeUndefined();
  });
});

describe('复审修复：补偿 op 落在下层路径时行后值跟着更新（2）', () => {
  it('药水叠加行改值两次无假冲突', () => {
    const r = aiRecords([{ op: 'add', path: '/主角/背包/治疗药水', value: { 数量: 2 } }])[0];
    const qty = (n: number) =>
      snapWithPlayer((p) => {
        p.inventory.find((i) => i.name === '治疗药水')!.quantity = n;
      });
    const first = planUpdateBlockRevision(r, { kind: 'edit', value: { 数量: 1 } }, qty(5));
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    const row = applyRevisionToRecord(
      { ops: [r], deltaMinutes: 0 },
      0,
      { kind: 'edit', value: { 数量: 1 } },
      first.preview.records,
    ).ops[0];
    expect(row.after).toMatchObject({ 数量: 4 });
    const second = planUpdateBlockRevision(row, { kind: 'edit', value: { 数量: 3 } }, qty(4));
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.ops).toEqual([{ op: 'delta', path: '/主角/背包/治疗药水/数量', value: 2 }]);
  });
});
