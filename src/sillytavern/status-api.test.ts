/**
 * status-api 测试 (M2 战斗 v2 · 组 B)
 *
 * 覆盖: applyStatusIntents（新增→add patch + added / 同源刷新→add patch 覆盖 + refreshed/stacked）
 *       removeStatusIntents（remove patch + updated 剔除）
 */
import { describe, it, expect } from 'vitest';
import { applyStatusIntents, removeStatusIntents } from './status-api';
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
describe('applyStatusIntents', () => {
  it('新增（异源 buff）→ 生成 add_status_effect patch，action=added', () => {
    const existing: StatusEffect[] = [];
    const intents = [
      {
        target: 'hero',
        buffDef: {
          name: '流血',
          category: '减益' as const,
          sourceKey: '幽怨之剑',
          stacks: 1,
          remainingTime: 3,
          timeUnit: '回合' as const,
        },
      },
    ];
    const r = applyStatusIntents(existing, intents);
    expect(r.results).toEqual([{ action: 'added', buffId: '幽怨之剑.流血' }]);
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0]).toEqual({
      op: 'add_status_effect',
      target: 'characters.hero',
      value: intents[0].buffDef,
    });
    expect(r.updated).toHaveLength(1);
    expect(r.updated[0].name).toBe('流血');
  });

  it('同源刷新时间（stacks=0）→ add patch（覆盖）+ action=refreshed', () => {
    const existing = [
      makeEffect({
        name: '流血',
        sourceKey: '幽怨之剑',
        stacks: 2,
        remainingTime: 2,
      }),
    ];
    const intents = [
      {
        target: 'hero',
        buffDef: {
          name: '流血',
          category: '减益' as const,
          sourceKey: '幽怨之剑',
          stacks: 0,
          remainingTime: 5,
        },
      },
    ];
    const r = applyStatusIntents(existing, intents);
    expect(r.results[0].action).toBe('refreshed');
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0].op).toBe('add_status_effect');
    expect(r.patches[0].target).toBe('characters.hero');
    // patch value 是 merged（stacks=2 不变，remainingTime=5 刷新）
    const patched = r.patches[0].value as StatusEffect;
    expect(patched.stacks).toBe(2);
    expect(patched.remainingTime).toBe(5);
    // updated 反映合并后的状态
    expect(r.updated).toHaveLength(1);
    expect(r.updated[0].stacks).toBe(2);
    expect(r.updated[0].remainingTime).toBe(5);
  });

  it('同源增层（stacks>0）→ add patch（覆盖）+ action=stacked', () => {
    const existing = [
      makeEffect({
        name: '流血',
        sourceKey: '幽怨之剑',
        stacks: 1,
        remainingTime: 3,
      }),
    ];
    const intents = [
      {
        target: 'hero',
        buffDef: {
          name: '流血',
          category: '减益' as const,
          sourceKey: '幽怨之剑',
          stacks: 2,
          remainingTime: 5,
        },
      },
    ];
    const r = applyStatusIntents(existing, intents);
    expect(r.results[0].action).toBe('stacked');
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0].op).toBe('add_status_effect');
    const patched = r.patches[0].value as StatusEffect;
    expect(patched.stacks).toBe(3); // 1+2
    expect(patched.remainingTime).toBe(5);
  });

  it('多 intent 串行 fold：先新增后叠加', () => {
    const existing: StatusEffect[] = [];
    const intents = [
      {
        target: 'hero',
        buffDef: {
          name: '流血',
          category: '减益' as const,
          sourceKey: '剑',
          stacks: 1,
          remainingTime: 3,
        },
      },
      {
        target: 'hero',
        buffDef: {
          name: '流血',
          category: '减益' as const,
          sourceKey: '剑',
          stacks: 2,
          remainingTime: 5,
        },
      },
    ];
    const r = applyStatusIntents(existing, intents);
    expect(r.results).toEqual([
      { action: 'added', buffId: '剑.流血' },
      { action: 'stacked', buffId: '剑.流血' },
    ]);
    expect(r.patches).toHaveLength(2);
    expect(r.updated).toHaveLength(1);
    expect(r.updated[0].stacks).toBe(3); // 1+2
  });

  it('异源共存：两个不同 sourceKey 的同名 buff 都进 updated', () => {
    const existing: StatusEffect[] = [];
    const intents = [
      {
        target: 'hero',
        buffDef: {
          name: '流血',
          category: '减益' as const,
          sourceKey: '幽怨之剑',
          stacks: 1,
        },
      },
      {
        target: 'hero',
        buffDef: {
          name: '流血',
          category: '减益' as const,
          sourceKey: '毒瓶',
          stacks: 1,
        },
      },
    ];
    const r = applyStatusIntents(existing, intents);
    expect(r.results).toEqual([
      { action: 'added', buffId: '幽怨之剑.流血' },
      { action: 'added', buffId: '毒瓶.流血' },
    ]);
    expect(r.updated).toHaveLength(2);
  });

  it('空 intents → 空 patches，updated=existing 副本', () => {
    const existing = [makeEffect({ name: '流血', sourceKey: '剑' })];
    const r = applyStatusIntents(existing, []);
    expect(r.patches).toHaveLength(0);
    expect(r.results).toHaveLength(0);
    expect(r.updated).toEqual(existing);
    expect(r.updated).not.toBe(existing); // 是副本
  });

  it('不修改原数组', () => {
    const existing = [makeEffect({ name: '流血', sourceKey: '剑', stacks: 1 })];
    const intents = [
      {
        target: 'hero',
        buffDef: {
          name: '流血',
          category: '减益' as const,
          sourceKey: '剑',
          stacks: 2,
        },
      },
    ];
    applyStatusIntents(existing, intents);
    expect(existing[0].stacks).toBe(1); // 未被改
  });
});

// ═══════════════════════════════════════════════════════════
describe('removeStatusIntents', () => {
  it('按完整 buffId 移除 → remove_status_effect patch + updated 剔除', () => {
    const existing = [
      makeEffect({ name: '流血', sourceKey: '幽怨之剑' }),
      makeEffect({ name: '流血', sourceKey: '毒瓶' }),
    ];
    const intents = [{ target: 'hero', buffIdOrName: '幽怨之剑.流血' }];
    const r = removeStatusIntents(existing, intents);
    expect(r.patches).toEqual([
      {
        op: 'remove_status_effect',
        target: 'characters.hero',
        value: '幽怨之剑.流血',
      },
    ]);
    expect(r.updated).toHaveLength(1);
    expect(r.updated[0].sourceKey).toBe('毒瓶');
  });

  it('按裸 name 移除所有同名 → updated 剔除所有匹配', () => {
    const existing = [
      makeEffect({ name: '流血', sourceKey: '幽怨之剑' }),
      makeEffect({ name: '流血', sourceKey: '毒瓶' }),
      makeEffect({ name: '灼烧', sourceKey: '幽怨之剑' }),
    ];
    const intents = [{ target: 'hero', buffIdOrName: '流血' }];
    const r = removeStatusIntents(existing, intents);
    expect(r.patches).toHaveLength(1);
    expect(r.updated).toHaveLength(1);
    expect(r.updated[0].name).toBe('灼烧');
  });

  it('多 intent 串行移除', () => {
    const existing = [
      makeEffect({ name: '流血', sourceKey: '剑' }),
      makeEffect({ name: '灼烧', sourceKey: '剑' }),
      makeEffect({ name: '中毒', sourceKey: '毒瓶' }),
    ];
    const intents = [
      { target: 'hero', buffIdOrName: '剑.流血' },
      { target: 'hero', buffIdOrName: '中毒' },
    ];
    const r = removeStatusIntents(existing, intents);
    expect(r.patches).toHaveLength(2);
    expect(r.updated).toHaveLength(1);
    expect(r.updated[0].name).toBe('灼烧');
  });

  it('移除不存在的 buffId → patch 仍生成，updated 不变', () => {
    const existing = [makeEffect({ name: '流血', sourceKey: '剑' })];
    const intents = [{ target: 'hero', buffIdOrName: '剑.灼烧' }];
    const r = removeStatusIntents(existing, intents);
    // 仍生成 remove patch（state-manager 自行判断实际有没有匹配）
    expect(r.patches).toHaveLength(1);
    expect(r.updated).toHaveLength(1);
    expect(r.updated[0].name).toBe('流血');
  });

  it('空 intents → 空 patches', () => {
    const existing = [makeEffect({ name: '流血', sourceKey: '剑' })];
    const r = removeStatusIntents(existing, []);
    expect(r.patches).toHaveLength(0);
    expect(r.updated).toEqual(existing);
  });

  it('不修改原数组', () => {
    const existing = [makeEffect({ name: '流血', sourceKey: '剑' })];
    removeStatusIntents(existing, [{ target: 'hero', buffIdOrName: '剑.流血' }]);
    expect(existing).toHaveLength(1); // 未被改
  });
});
