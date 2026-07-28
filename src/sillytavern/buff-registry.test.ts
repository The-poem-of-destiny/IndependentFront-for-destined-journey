/**
 * buff-registry 测试 (M2 战斗 v2 · 组 B)
 *
 * 覆盖: buffIdOf / lifecycleOf / apply (added/refreshed/stacked/maxStacks/stackable)
 *       / remove (按 buffId / 按裸 name) / tick (round.start 增益 / round.end 减益 / 战斗型递减
 *       / 持续型不递减 / 到期进 expired / 不同 lifecycle 共存)
 *
 * 对齐: docs/reference/combat-system-architecture.md §5.2/§5.3/§5.4
 */
import { describe, it, expect } from 'vitest';
import {
  BuffRegistry,
  buffIdOf,
  lifecycleOf,
  applyBuff,
  removeBuff,
  tickBuffs,
} from './buff-registry';
import type { StatusEffect } from './types';

/** 构造一个 StatusEffect，便于测试 */
function makeEffect(overrides: Partial<StatusEffect> = {}): StatusEffect {
  return {
    name: '灼烧',
    description: '每回合失去5%生命值',
    category: '减益',
    stacks: 1,
    remainingTime: 3,
    timeUnit: '回合',
    source: '魔法-灼烧之剑;净化',
    effects: {},
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
describe('buffIdOf', () => {
  it('有 sourceKey → `${sourceKey}.${name}`', () => {
    const e = makeEffect({ name: '流血', sourceKey: '幽怨之剑' });
    expect(buffIdOf(e)).toBe('幽怨之剑.流血');
  });

  it('无 sourceKey → 裸 name（系统/环境 buff）', () => {
    const e = makeEffect({ name: '暴雨' });
    expect(buffIdOf(e)).toBe('暴雨');
  });

  it('sourceKey 为空字符串 → 视为无前缀（兜底）', () => {
    const e = makeEffect({ name: '暴雨', sourceKey: '' });
    expect(buffIdOf(e)).toBe('暴雨');
  });
});

// ═══════════════════════════════════════════════════════════
describe('lifecycleOf', () => {
  it('显式 lifecycle 给定 → 直接用', () => {
    expect(lifecycleOf(makeEffect({ lifecycle: '持续' }))).toBe('持续');
    expect(lifecycleOf(makeEffect({ lifecycle: '触发' }))).toBe('触发');
    expect(lifecycleOf(makeEffect({ lifecycle: '条件' }))).toBe('条件');
    expect(lifecycleOf(makeEffect({ lifecycle: '战斗' }))).toBe('战斗');
  });

  it('缺省 + timeUnit="回合" → 战斗', () => {
    expect(lifecycleOf(makeEffect({ timeUnit: '回合', remainingTime: 3 }))).toBe('战斗');
  });

  it('缺省 + remainingTime=null → 持续（永久）', () => {
    expect(
      lifecycleOf(makeEffect({ timeUnit: '小时', remainingTime: null })),
    ).toBe('持续');
  });

  it('缺省 + timeUnit=分钟 + remainingTime 非 null → 战斗（脱战按战斗型处理）', () => {
    expect(
      lifecycleOf(makeEffect({ timeUnit: '分钟', remainingTime: 10 })),
    ).toBe('战斗');
  });

  it('显式 lifecycle 优先于 timeUnit 推导', () => {
    // timeUnit=回合但显式声明持续 → 取持续
    expect(
      lifecycleOf(
        makeEffect({ timeUnit: '回合', remainingTime: 3, lifecycle: '持续' }),
      ),
    ).toBe('持续');
  });
});

// ═══════════════════════════════════════════════════════════
describe('apply (BuffRegistry.apply / applyBuff)', () => {
  it('异源（不同 buffId）→ added，index=-1，merged=newEffect', () => {
    const existing = [makeEffect({ name: '流血', sourceKey: '幽怨之剑' })];
    const newEffect = makeEffect({ name: '流血', sourceKey: '毒瓶' }); // 不同 sourceKey
    const r = applyBuff(existing, newEffect);
    expect(r.action).toBe('added');
    expect(r.index).toBe(-1);
    expect(r.merged).toBe(newEffect);
  });

  it('同源刷新时间（不增层，stacks=0）→ refreshed，取 max(remainingTime)', () => {
    const existing = [
      makeEffect({
        name: '流血',
        sourceKey: '幽怨之剑',
        stacks: 2,
        remainingTime: 2,
      }),
    ];
    const newEffect = makeEffect({
      name: '流血',
      sourceKey: '幽怨之剑',
      stacks: 0, // 不增层
      remainingTime: 5, // 比现有的 2 长 → 刷新到 5
    });
    const r = applyBuff(existing, newEffect);
    expect(r.action).toBe('refreshed');
    expect(r.index).toBe(0);
    expect(r.merged.remainingTime).toBe(5);
    expect(r.merged.stacks).toBe(2); // 不增层
  });

  it('同源刷新时间（newEffect.remainingTime 更短 → 取 max，保持现有的）', () => {
    const existing = [
      makeEffect({
        name: '流血',
        sourceKey: '幽怨之剑',
        stacks: 1,
        remainingTime: 5,
      }),
    ];
    const newEffect = makeEffect({
      name: '流血',
      sourceKey: '幽怨之剑',
      stacks: 0,
      remainingTime: 2, // 比现有的 5 短 → 取 5
    });
    const r = applyBuff(existing, newEffect);
    expect(r.action).toBe('refreshed');
    expect(r.merged.remainingTime).toBe(5);
  });

  it('同源增层（stacks>0）→ stacked，stacks 累加', () => {
    const existing = [
      makeEffect({
        name: '流血',
        sourceKey: '幽怨之剑',
        stacks: 1,
        remainingTime: 3,
      }),
    ];
    const newEffect = makeEffect({
      name: '流血',
      sourceKey: '幽怨之剑',
      stacks: 2, // 增 2 层
      remainingTime: 5,
    });
    const r = applyBuff(existing, newEffect);
    expect(r.action).toBe('stacked');
    expect(r.index).toBe(0);
    expect(r.merged.stacks).toBe(3); // 1+2
    expect(r.merged.remainingTime).toBe(5); // 同时刷新
  });

  it('maxStacks 上限：累加后超过上限被钳制', () => {
    const existing = [
      makeEffect({
        name: '流血',
        sourceKey: '幽怨之剑',
        stacks: 3,
        remainingTime: 3,
        maxStacks: 5,
      }),
    ];
    const newEffect = makeEffect({
      name: '流血',
      sourceKey: '幽怨之剑',
      stacks: 4, // 3+4=7 → 钳到 5
      remainingTime: 5,
    });
    const r = applyBuff(existing, newEffect);
    expect(r.action).toBe('stacked');
    expect(r.merged.stacks).toBe(5); // 钳制
  });

  it('maxStacks 已满：再叠加不增层 → refreshed（而非 stacked）', () => {
    const existing = [
      makeEffect({
        name: '流血',
        sourceKey: '幽怨之剑',
        stacks: 5,
        remainingTime: 2,
        maxStacks: 5,
      }),
    ];
    const newEffect = makeEffect({
      name: '流血',
      sourceKey: '幽怨之剑',
      stacks: 2, // 已满 5，无法再增
      remainingTime: 6,
    });
    const r = applyBuff(existing, newEffect);
    // 实际未增层 → refreshed
    expect(r.action).toBe('refreshed');
    expect(r.merged.stacks).toBe(5);
    expect(r.merged.remainingTime).toBe(6); // 仍刷新
  });

  it('stackable=false：永不增层，仅刷新', () => {
    const existing = [
      makeEffect({
        name: '护盾',
        sourceKey: '神官',
        stacks: 1,
        remainingTime: 2,
        stackable: false,
      }),
    ];
    const newEffect = makeEffect({
      name: '护盾',
      sourceKey: '神官',
      stacks: 3, // 试图增层
      remainingTime: 5,
    });
    const r = applyBuff(existing, newEffect);
    expect(r.action).toBe('refreshed'); // 不增层
    expect(r.merged.stacks).toBe(1);
    expect(r.merged.remainingTime).toBe(5);
  });

  it('裸名 buff（无 sourceKey）：同名同裸名视为同源刷新', () => {
    const existing = [
      makeEffect({ name: '暴雨', sourceKey: undefined, stacks: 1, remainingTime: 2 }),
    ];
    const newEffect = makeEffect({
      name: '暴雨',
      sourceKey: undefined,
      stacks: 1,
      remainingTime: 5,
    });
    const r = applyBuff(existing, newEffect);
    expect(r.action).toBe('stacked');
    expect(r.merged.stacks).toBe(2);
  });

  it('remainingTime=null（永久）+ newEffect.remainingTime 非 null → 保持 null', () => {
    const existing = [
      makeEffect({
        name: '光环',
        sourceKey: '神器',
        stacks: 1,
        remainingTime: null,
      }),
    ];
    const newEffect = makeEffect({
      name: '光环',
      sourceKey: '神器',
      stacks: 0,
      remainingTime: 5, // 试图给永久 buff 加时间
    });
    const r = applyBuff(existing, newEffect);
    expect(r.action).toBe('refreshed');
    expect(r.merged.remainingTime).toBe(null); // 永久 buff 不被覆盖成有限
  });

  it('OOP 包装 BuffRegistry.apply 与纯函数 applyBuff 行为一致', () => {
    const registry = new BuffRegistry();
    const existing = [makeEffect({ name: '流血', sourceKey: '剑', stacks: 1 })];
    const newEffect = makeEffect({ name: '流血', sourceKey: '剑', stacks: 2 });
    const r1 = applyBuff(existing, newEffect);
    const r2 = registry.apply(existing, newEffect);
    expect(r2).toEqual(r1);
  });

  it('apply 不修改原数组（纯函数）', () => {
    const existing = [
      makeEffect({ name: '流血', sourceKey: '剑', stacks: 1, remainingTime: 3 }),
    ];
    const newEffect = makeEffect({ name: '流血', sourceKey: '剑', stacks: 2 });
    applyBuff(existing, newEffect);
    // 原数组未变
    expect(existing[0].stacks).toBe(1);
    expect(existing[0].remainingTime).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════
describe('remove (BuffRegistry.remove / removeBuff)', () => {
  it('按完整 buffId（含 `.`）精确移除单个实例', () => {
    const existing = [
      makeEffect({ name: '流血', sourceKey: '幽怨之剑' }),
      makeEffect({ name: '流血', sourceKey: '毒瓶' }),
      makeEffect({ name: '灼烧', sourceKey: '幽怨之剑' }),
    ];
    const r = removeBuff(existing, '幽怨之剑.流血');
    expect(r.removed).toHaveLength(1);
    expect(r.removed[0].sourceKey).toBe('幽怨之剑');
    expect(r.removed[0].name).toBe('流血');
    expect(r.remaining).toHaveLength(2);
    expect(r.remaining.map((e) => buffIdOf(e))).toEqual([
      '毒瓶.流血',
      '幽怨之剑.灼烧',
    ]);
  });

  it('按裸 name 移除所有同名（跨所有 sourceKey 前缀）', () => {
    const existing = [
      makeEffect({ name: '流血', sourceKey: '幽怨之剑' }),
      makeEffect({ name: '流血', sourceKey: '毒瓶' }),
      makeEffect({ name: '灼烧', sourceKey: '幽怨之剑' }),
    ];
    const r = removeBuff(existing, '流血');
    expect(r.removed).toHaveLength(2); // 两个不同源的"流血"都被移除
    expect(r.remaining).toHaveLength(1);
    expect(r.remaining[0].name).toBe('灼烧');
  });

  it('移除裸 name 包含同名环境 buff（无 sourceKey）', () => {
    const existing = [
      makeEffect({ name: '暴雨', sourceKey: undefined }),
      makeEffect({ name: '晴天', sourceKey: undefined }),
    ];
    const r = removeBuff(existing, '暴雨');
    expect(r.removed).toHaveLength(1);
    expect(r.remaining).toHaveLength(1);
    expect(r.remaining[0].name).toBe('晴天');
  });

  it('移除不存在的 buffId → remaining 不变，removed 为空', () => {
    const existing = [makeEffect({ name: '流血', sourceKey: '剑' })];
    const r = removeBuff(existing, '幽怨之剑.灼烧');
    expect(r.removed).toHaveLength(0);
    expect(r.remaining).toHaveLength(1);
  });

  it('remove 不修改原数组', () => {
    const existing = [makeEffect({ name: '流血', sourceKey: '剑' })];
    removeBuff(existing, '剑.流血');
    expect(existing).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
describe('tick (BuffRegistry.tick / tickBuffs)', () => {
  it('round.start 只处理增益（category=增益）', () => {
    const existing = [
      makeEffect({ name: '攻击强化', category: '增益', remainingTime: 3 }),
      makeEffect({ name: '流血', category: '减益', remainingTime: 3 }),
      makeEffect({ name: '混乱', category: '特殊', remainingTime: 3 }),
    ];
    const r = tickBuffs(existing, 'round.start');
    // 增益 remainingTime: 3→2；减益/特殊不动
    const buff = r.remaining.find((e) => e.name === '攻击强化');
    expect(buff?.remainingTime).toBe(2);
    expect(r.remaining.find((e) => e.name === '流血')?.remainingTime).toBe(3);
    expect(r.remaining.find((e) => e.name === '混乱')?.remainingTime).toBe(3);
    expect(r.expired).toHaveLength(0);
  });

  it('round.end 只处理减益/特殊（category=减益 或 特殊）', () => {
    const existing = [
      makeEffect({ name: '攻击强化', category: '增益', remainingTime: 3 }),
      makeEffect({ name: '流血', category: '减益', remainingTime: 3 }),
      makeEffect({ name: '混乱', category: '特殊', remainingTime: 3 }),
    ];
    const r = tickBuffs(existing, 'round.end');
    // 增益不动；减益/特殊 -1
    expect(r.remaining.find((e) => e.name === '攻击强化')?.remainingTime).toBe(3);
    expect(r.remaining.find((e) => e.name === '流血')?.remainingTime).toBe(2);
    expect(r.remaining.find((e) => e.name === '混乱')?.remainingTime).toBe(2);
  });

  it('战斗型递减 remainingTime', () => {
    const existing = [
      makeEffect({ name: '流血', category: '减益', remainingTime: 2 }),
    ];
    const r = tickBuffs(existing, 'round.end');
    expect(r.remaining[0].remainingTime).toBe(1);
  });

  it('持续型不递减（lifecycle=持续，永久 buff）', () => {
    const existing = [
      makeEffect({
        name: '光环',
        category: '减益',
        remainingTime: null,
        lifecycle: '持续',
      }),
    ];
    const r = tickBuffs(existing, 'round.end');
    expect(r.remaining).toHaveLength(1);
    expect(r.remaining[0].remainingTime).toBe(null);
    expect(r.expired).toHaveLength(0);
  });

  it('触发型不递减（lifecycle=触发）', () => {
    const existing = [
      makeEffect({
        name: '反射',
        category: '增益',
        remainingTime: null,
        lifecycle: '触发',
      }),
    ];
    const r = tickBuffs(existing, 'round.start');
    expect(r.remaining).toHaveLength(1);
    expect(r.expired).toHaveLength(0);
  });

  it('条件型不递减（lifecycle=条件）', () => {
    const existing = [
      makeEffect({
        name: '中毒',
        category: '减益',
        remainingTime: 5,
        lifecycle: '条件',
      }),
    ];
    const r = tickBuffs(existing, 'round.end');
    expect(r.remaining).toHaveLength(1);
    expect(r.remaining[0].remainingTime).toBe(5); // 不递减
    expect(r.expired).toHaveLength(0);
  });

  it('到期（remainingTime 减到 0）→ 进 expired', () => {
    const existing = [
      makeEffect({ name: '流血', category: '减益', remainingTime: 1 }),
    ];
    const r = tickBuffs(existing, 'round.end');
    expect(r.remaining).toHaveLength(0);
    expect(r.expired).toHaveLength(1);
    expect(r.expired[0].name).toBe('流血');
  });

  it('不同 lifecycle 共存（精确断言）：战斗型递减进 remaining，其他原样保留', () => {
    const existing = [
      makeEffect({ name: '流血', category: '减益', remainingTime: 2 }),
      makeEffect({
        name: '诅咒',
        category: '减益',
        remainingTime: null,
        lifecycle: '持续',
      }),
      makeEffect({
        name: '中毒',
        category: '减益',
        remainingTime: 5,
        lifecycle: '条件',
      }),
    ];
    const r = tickBuffs(existing, 'round.end');
    // 三种都还在 remaining（流血 2→1 未到期；诅咒/中毒不递减）
    expect(r.remaining).toHaveLength(3);
    expect(r.expired).toHaveLength(0);
    expect(r.remaining.find((e) => e.name === '流血')?.remainingTime).toBe(1);
    expect(r.remaining.find((e) => e.name === '诅咒')?.remainingTime).toBe(null);
    expect(r.remaining.find((e) => e.name === '中毒')?.remainingTime).toBe(5);
  });

  it('不同类别共存：round.start 同时有增益递减、减益不动', () => {
    const existing = [
      makeEffect({ name: '攻击强化', category: '增益', remainingTime: 2 }),
      makeEffect({ name: '流血', category: '减益', remainingTime: 5 }),
    ];
    const r = tickBuffs(existing, 'round.start');
    expect(r.remaining).toHaveLength(2);
    expect(r.expired).toHaveLength(0);
    // 增益递减，减益不动
    expect(r.remaining.find((e) => e.name === '攻击强化')?.remainingTime).toBe(1);
    expect(r.remaining.find((e) => e.name === '流血')?.remainingTime).toBe(5);
  });

  it('remainingTime=null 的战斗型增益（异常数据）→ 原样保留，不崩', () => {
    const existing = [
      makeEffect({
        name: '光环',
        category: '增益',
        remainingTime: null,
        lifecycle: '战斗', // 显式战斗但 remainingTime=null
      }),
    ];
    const r = tickBuffs(existing, 'round.start');
    expect(r.remaining).toHaveLength(1);
    expect(r.expired).toHaveLength(0);
  });

  it('tick 不修改原数组', () => {
    const existing = [
      makeEffect({ name: '流血', category: '减益', remainingTime: 3 }),
    ];
    tickBuffs(existing, 'round.end');
    expect(existing[0].remainingTime).toBe(3);
  });
});
