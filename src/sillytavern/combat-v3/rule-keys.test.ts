/**
 * combat-v3/rule-keys.test.ts — closed RuleKey 解析 + divinity 压制（M4）
 *
 * 覆盖（plan §7.4）：
 *   - 四个 RuleKey 各 1 组：通过 / 门槛不足 / merge policy（merge 冲突合并用）
 *   - divinity 差 1~5 级压制值（±20%/40%/60%/80%/100%）
 *   - 差 ≥5 → { certain: true }（调用方跳过掷骰 = 不消费骰子，A4-4）
 *   - suppressionAsModifier 攻守视角换算
 */

import { describe, expect, it } from 'vitest';
import {
  RULE_KEYS,
  canForceTerminal,
  divinitySuppression,
  resolveOverride,
  suppressionAsModifier,
  type RuleKey,
} from './rule-keys';

const ALL_KEYS: readonly RuleKey[] = [
  'terminal.forceTerminal',
  'morale.forceState',
  'action.freezeSlot',
  'death.threshold',
];

describe('four RuleKeys 注册齐全（架构 §八 8.2）', () => {
  it('四把锁全部注册，divinity 门槛 = 5（法则级）', () => {
    expect(ALL_KEYS).toHaveLength(4);
    for (const k of ALL_KEYS) {
      expect(RULE_KEYS[k], `RuleKey「${k}」未注册`).toBeDefined();
      expect(RULE_KEYS[k].divinityThreshold).toBe(5);
    }
  });
});

describe('resolveOverride — terminal.forceTerminal', () => {
  it('divinity ≥ 5 通过、载荷合法 → applied（first_wins merge）', () => {
    const r = resolveOverride('terminal.forceTerminal', 5, {
      reason: '认知剥夺',
      winner: 'player',
    });
    expect(r.kind).toBe('applied');
    if (r.kind === 'applied') expect(r.merge).toBe('first_wins');
  });
  it('divinity < 5 → not_applied（法则级门槛）', () => {
    const r = resolveOverride('terminal.forceTerminal', 4, { reason: 'x' });
    expect(r.kind).toBe('not_applied');
    if (r.kind === 'not_applied') expect(r.reason).toMatch(/门槛/);
  });
  it('载荷缺 reason → not_applied', () => {
    const r = resolveOverride('terminal.forceTerminal', 6, { winner: 'player' });
    expect(r.kind).toBe('not_applied');
  });
});

describe('resolveOverride — morale.forceState', () => {
  it('通过 → applied（max_hp merge：冲突取 divinity 高者）', () => {
    const r = resolveOverride('morale.forceState', 5, {
      state: '濒死反扑',
      ignoreHpThreshold: true,
    });
    expect(r.kind).toBe('applied');
    if (r.kind === 'applied') expect(r.merge).toBe('max_hp');
  });
  it('门槛不足 → not_applied', () => {
    const r = resolveOverride('morale.forceState', 4, { state: '濒死反扑' });
    expect(r.kind).toBe('not_applied');
  });
  it('载荷缺 state → not_applied', () => {
    const r = resolveOverride('morale.forceState', 6, { ignoreHpThreshold: true });
    expect(r.kind).toBe('not_applied');
  });
});

describe('resolveOverride — action.freezeSlot', () => {
  it('通过 → applied（max_rounds merge：同目标同槽取 rounds 最大）', () => {
    const r = resolveOverride('action.freezeSlot', 5, {
      targetId: '处刑人',
      slotType: 'attack',
      rounds: 2,
    });
    expect(r.kind).toBe('applied');
    if (r.kind === 'applied') expect(r.merge).toBe('max_rounds');
  });
  it('门槛不足 → not_applied', () => {
    const r = resolveOverride('action.freezeSlot', 3, {
      targetId: 'x',
      slotType: 'both',
      rounds: 1,
    });
    expect(r.kind).toBe('not_applied');
  });
  it('slotType 非法 → not_applied', () => {
    const r = resolveOverride('action.freezeSlot', 6, {
      targetId: 'x',
      slotType: 'weird',
      rounds: 1,
    });
    expect(r.kind).toBe('not_applied');
  });
  it('rounds < 1 → not_applied', () => {
    const r = resolveOverride('action.freezeSlot', 6, {
      targetId: 'x',
      slotType: 'action',
      rounds: 0,
    });
    expect(r.kind).toBe('not_applied');
  });
});

describe('resolveOverride — death.threshold', () => {
  it('通过 → applied（max_hp merge：取 hp 高者，charges 各自消耗）', () => {
    const r = resolveOverride('death.threshold', 6, { alive: true, hp: 30 });
    expect(r.kind).toBe('applied');
    if (r.kind === 'applied') expect(r.merge).toBe('max_hp');
  });
  it('divinity < 5 → not_applied（v2 死亡红线显式修订，须法则级）', () => {
    const r = resolveOverride('death.threshold', 4, { alive: true, hp: 30 });
    expect(r.kind).toBe('not_applied');
  });
  it('alive 非 true → not_applied', () => {
    const r = resolveOverride('death.threshold', 6, { alive: false, hp: 30 });
    expect(r.kind).toBe('not_applied');
  });
});

describe('canForceTerminal（内核内部 forceTerminal 出口）', () => {
  it('divinity ≥5 → true；<5 → false', () => {
    expect(canForceTerminal(5)).toBe(true);
    expect(canForceTerminal(6)).toBe(true);
    expect(canForceTerminal(4)).toBe(false);
  });
});

describe('divinitySuppression（架构 §八 8.3 压制表）', () => {
  it('差 1~4 → certain:false，幅度 0.2/0.4/0.6/0.8', () => {
    for (const [diff, magnitude] of [
      [1, 0.2],
      [2, 0.4],
      [3, 0.6],
      [4, 0.8],
    ] as const) {
      const r = divinitySuppression(5 + diff, 5);
      expect(r.certain).toBe(false);
      if (!r.certain) expect(r.magnitude).toBe(magnitude);
    }
  });
  it('差 ≥5 → certain:true，方向=攻高（±100% 必成/必败）', () => {
    expect(divinitySuppression(10, 5)).toEqual({ certain: true, direction: 1 });
    expect(divinitySuppression(6, 1)).toEqual({ certain: true, direction: 1 });
  });
  it('守方 div 高 ≥5 → certain:true，方向=-1', () => {
    expect(divinitySuppression(0, 6)).toEqual({ certain: true, direction: -1 });
  });
  it('差 ≤0 → magnitude 0，方向跟随高低', () => {
    const even = divinitySuppression(5, 5);
    expect(even.certain).toBe(false);
    if (!even.certain) expect(even.magnitude).toBe(0);
    const lower = divinitySuppression(4, 5);
    if (!lower.certain) expect(lower.direction).toBe(-1);
  });
});

describe('suppressionAsModifier（压制 → 对抗检定加值）', () => {
  it('攻高 4 级：攻方视角 +0.8，守方视角 −0.8', () => {
    const s = divinitySuppression(9, 5);
    expect(suppressionAsModifier(s, true)).toBe(0.8);
    expect(suppressionAsModifier(s, false)).toBe(-0.8);
  });
  it('守高 3 级：攻方视角 −0.6', () => {
    const s = divinitySuppression(2, 5);
    expect(suppressionAsModifier(s, true)).toBe(-0.6);
  });
  it('certain（≥5）：攻高必成 → ±100 量级加值', () => {
    const s = divinitySuppression(10, 0);
    expect(suppressionAsModifier(s, true)).toBe(100);
    expect(suppressionAsModifier(s, false)).toBe(-100);
  });
});
