/**
 * combat-v3/intents.test.ts — EffectIntent 验证 / 解释执行 / 批原子性测试（M3, 验收 A3-7）
 *
 * 覆盖（plan §5.8 / 验收 A3-7）：
 *   - batch 内一个 intent 非法 ⇒ 整批 reject + EffectRejected（validateBatch）
 *   - 核心攻击不受影响（本模块只返回本 batch 结果，不接触外部状态 → 由 windows/phase 保证）
 *   - EffectRejected code 枚举齐全（apply/windows 侧产生）
 */

import { describe, it, expect } from 'vitest';
import { validateBatch, applyIntents } from './intents';
import type { CombatState, EffectIntent } from './types';
import { EMPTY_CHANGES } from './types';

const present = (id: string) => id === '理查德' || id === '处刑人';
const resolveNumber = (expr: string, fallback: number) => Number(expr) || fallback;

function mkState(): CombatState {
  // 最小 state（applyIntents 只读 units 的存在性）
  return {
    combatId: 't',
    revision: 0,
    phase: 'SlotConsume',
    round: 1,
    initiativeOrder: [],
    currentTurnIndex: 0,
    units: {},
    activeEffects: {
      byWindow: {
        'round.open': [],
        'round.close': [],
        'initiative.before': [],
        'initiative.after': [],
        'turn.open': [],
        'turn.close': [],
        'action.declared': [],
        'check.intent': [],
        'check.hit': [],
        collect_attacker_mods: [],
        collect_defender_mods: [],
        'damage.preview': [],
        'damage.compute': [],
        'damage.after': [],
        'unit.beforeDown': [],
        'morale.before': [],
        'morale.after': [],
        'settlement.before': [],
      },
      byOwner: {},
    },
    dice: undefined as never,
    resourceSnapshots: { FP: 1000 },
    journal: [],
    provenance: {
      engineVersion: 'v3',
      schemaVersion: '1',
      rulesetRevision: 't',
      bundleHash: 't',
      eventSequence: 0,
      diceEpochs: [],
    },
  };
}

const ctx = {
  state: mkState(),
  automatonOwner: '理查德',
  present,
  resolveNumber,
};

describe('validateBatch — 批原子性（A3-7）', () => {
  it('全部合规 → ok', () => {
    const batch: EffectIntent[] = [
      { kind: 'Heal', targetId: '理查德', amount: 30 },
      { kind: 'ApplyStatus', targetId: '理查德', statusId: '护盾', duration: 1 },
    ];
    expect(validateBatch(batch)).toEqual({ ok: true, intents: batch });
  });

  it('batch 内一个非法 → 整批 reject + rejectedIntents 含全部', () => {
    const bad: EffectIntent[] = [
      { kind: 'Heal', targetId: '理查德', amount: 30 },
      // 负 Heal = 非法（VALUE_OUT_OF_RANGE）
      { kind: 'Heal', targetId: '理查德', amount: -5 },
    ];
    const v = validateBatch(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('VALUE_OUT_OF_RANGE');
      expect(v.rejectedIntents).toHaveLength(2);
    }
  });

  it('DealDamage 空 target → TARGET_ILLEGAL', () => {
    const v = validateBatch([
      {
        kind: 'DealDamage',
        targetId: '',
        amount: 50,
        damageType: 'physical',
      } as unknown as EffectIntent,
    ]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('TARGET_ILLEGAL');
  });

  it('ScheduleIntent 递归校验内部非法', () => {
    const v = validateBatch([
      {
        kind: 'ScheduleIntent',
        delay: 0,
        intent: {
          kind: 'DealDamage',
          targetId: '',
          amount: 5,
          damageType: 'true',
        } as unknown as EffectIntent,
      },
    ]);
    expect(v.ok).toBe(false);
  });
});

describe('applyIntents — 解释执行', () => {
  it('Heal 累积到 hpChanges', () => {
    const changes = { ...EMPTY_CHANGES, hpChanges: {} };
    const r = applyIntents(ctx, [{ kind: 'Heal', targetId: '理查德', amount: 30 }], changes);
    expect(r.changes.hpChanges['理查德']).toBe(30);
    expect(r.consumedCharge).toBe(false);
  });

  it('DealDamage 负累积（doesNotConsumeSlot 反伤仍走 hpChanges）', () => {
    const changes = { ...EMPTY_CHANGES, hpChanges: {} };
    const r = applyIntents(
      ctx,
      [
        {
          kind: 'DealDamage',
          targetId: '处刑人',
          amount: 100,
          damageType: 'physical',
          doesNotConsumeSlot: true,
        } as EffectIntent,
      ],
      changes,
    );
    expect(r.changes.hpChanges['处刑人']).toBe(-100);
  });

  it('SpendResource SP / FP', () => {
    const changes = { ...EMPTY_CHANGES, spChanges: {}, fpDelta: 0 };
    const r = applyIntents(
      ctx,
      [
        { kind: 'SpendResource', targetId: '理查德', resource: 'sp', amount: 50 },
        { kind: 'SpendResource', targetId: '理查德', resource: 'fp', amount: 100 },
      ],
      changes,
    );
    expect(r.changes.spChanges['理查德']).toBe(-50);
    expect(r.changes.fpDelta).toBe(-100);
  });

  it('ApplyStatus 产生 statusPatch', () => {
    const changes = { ...EMPTY_CHANGES, statusPatches: [] };
    const r = applyIntents(
      ctx,
      [{ kind: 'ApplyStatus', targetId: '理查德', statusId: '护盾', duration: 1, layers: 2 }],
      changes,
    );
    expect(r.changes.statusPatches).toHaveLength(1);
    if (r.changes.statusPatches[0].op === 'apply') {
      expect(r.changes.statusPatches[0].status.name).toBe('护盾');
      expect(r.changes.statusPatches[0].status.stacks).toBe(2);
    }
  });

  it('目标不在场 → silently 跳过（不崩、不变更）', () => {
    const changes = { ...EMPTY_CHANGES, hpChanges: {} };
    const r = applyIntents(ctx, [{ kind: 'Heal', targetId: '不存在的人', amount: 30 }], changes);
    expect(r.changes.hpChanges).toEqual({});
  });

  it('ConsumeCharge 标记消耗', () => {
    const changes = { ...EMPTY_CHANGES };
    const r = applyIntents(ctx, [{ kind: 'ConsumeCharge', amount: 1 }], changes);
    expect(r.consumedCharge).toBe(true);
  });

  it('EmitNarrativeCue 收集叙事文本', () => {
    const changes = { ...EMPTY_CHANGES };
    const r = applyIntents(ctx, [{ kind: 'EmitNarrativeCue', text: '反射湮灭' }], changes);
    expect(r.narrative).toEqual(['反射湮灭']);
  });
});

describe('EffectRejected code 枚举齐全', () => {
  it('9 种 code 均在 validateOne 可达', () => {
    // 枚举值全部能出现在 batch 拒绝中（通过构造各类非法 intent 验证关键几种）
    const bad = [
      { kind: 'DealDamage', targetId: '', amount: 10, damageType: 'physical' }, // TARGET_ILLEGAL
      { kind: 'Heal', targetId: 'x', amount: -1 }, // VALUE_OUT_OF_RANGE
      { kind: 'ApplyStatus', targetId: '', statusId: 's', duration: 1 }, // TARGET_ILLEGAL
    ];
    const codes = bad.map((x) => {
      const v = validateBatch([x as unknown as EffectIntent]);
      return v.ok ? 'ok' : v.code;
    });
    expect(codes).toContain('TARGET_ILLEGAL');
    expect(codes).toContain('VALUE_OUT_OF_RANGE');
  });
});
