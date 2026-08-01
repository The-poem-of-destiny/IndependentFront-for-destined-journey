/**
 * combat-v3/replay.test.ts — replay harness 测试
 *
 * 验收对应（plan §2.1 / §2.6）：
 *   A0-5  同 fixture 跑两次 events 深相等且 hash 相同；无副作用
 *   A0-8  06/24 两场 fixture 能被 replay 解析（M0 = 结构合法 + 骰带可建）
 */

import { describe, expect, it } from 'vitest';
import case06Json from './fixtures/case-06-summon.fixture.json';
import case24Json from './fixtures/case-24-reflection.fixture.json';
import {
  FixtureValidationError,
  replayCombat,
  validateFixture,
  type ReplayReducer,
} from './replay';
import type { CombatFixture, DiceChannel } from './types';

const case06 = case06Json as unknown as CombatFixture;
const case24 = case24Json as unknown as CombatFixture;

const DEFAULT_SPLIT: Record<DiceChannel, number> = {
  attackHit: 32,
  initiative: 10,
  intentCheck: 7,
  statusContest: 6,
  procCheck: 5,
};

/** 60 个合法骰值（循环 1..20） */
function make60(): number[] {
  return Array.from({ length: 60 }, (_, i) => (i % 20) + 1);
}

/** 构造一个最小合法 fixture，供非法分支测试改动 */
function makeMinimalFixture(): CombatFixture {
  return {
    id: 'test-minimal',
    sourceCase: '',
    bundle: {
      combatId: 'test-1',
      combatType: '标准',
      units: [{ name: '甲', tier: 3, hp: 100, maxHp: 100 }],
      programs: [],
      resourceSnapshots: { FP: 1000 },
      rulesetRevision: 'v3-2026-07-31',
    },
    epochs: [
      {
        outputId: 'out-1',
        dice: make60(),
        channelSplit: { ...DEFAULT_SPLIT },
      },
    ],
    commands: [
      {
        commandId: 'c1',
        expectedRevision: 0,
        kind: 'DeclareAttack',
        actorId: '甲',
        cost: 'attack',
        payload: {},
      },
    ],
    expected: {
      milestones: [{ kind: 'terminal', reason: 'hp_zero', winner: '甲' }],
      eventHash: null,
    },
  };
}

describe('replayCombat — 合法路径', () => {
  it('合法 fixture 返回完整 ReplayResult（events 空 / hash 字符串 / milestones 回显 / tapeFinal 就位）', () => {
    const r = replayCombat(case24);
    expect(r.events).toEqual([]);
    expect(typeof r.hash).toBe('string');
    expect(r.hash.length).toBeGreaterThan(0);
    expect(r.milestones).toEqual(case24.expected.milestones);
    expect(r.tapeFinal).toBeDefined();
    expect(r.tapeFinal.current.channels.attackHit).toHaveLength(32);
  });

  it('同 fixture 跑两次 → events 深相等且 hash 相同（A0-5 确定性）', () => {
    const r1 = replayCombat(case06);
    const r2 = replayCombat(case06);
    expect(r1.events).toEqual(r2.events);
    expect(r1.hash).toBe(r2.hash);
    expect(r1.milestones).toEqual(r2.milestones);
    expect(r1.tapeFinal).toEqual(r2.tapeFinal);
  });

  it('replay 是纯函数：返回值可 JSON 序列化且往返一致（无函数/类引用、无外部副作用）', () => {
    const r = replayCombat(case24);
    const serialized = JSON.stringify(r);
    expect(serialized).toBeDefined();
    const back = JSON.parse(serialized) as ReturnType<typeof replayCombat>;
    expect(back.milestones).toEqual(r.milestones);
    expect(back.hash).toBe(r.hash);
  });

  it('改 fixture 核心字段 → hash 变（hash 敏感性）', () => {
    const r1 = replayCombat(case24);
    const cloned: CombatFixture = JSON.parse(JSON.stringify(case24)) as CombatFixture;
    cloned.id = 'changed-id';
    const r2 = replayCombat(cloned);
    expect(r1.hash).not.toBe(r2.hash);
  });

  it('忽略元数据字段：_synthetic/_provenance 不影响 hash', () => {
    const r1 = replayCombat(case24);
    const cloned: CombatFixture = JSON.parse(JSON.stringify(case24)) as CombatFixture;
    // 加一个无关顶层元数据字段
    (cloned as unknown as { _comment: string })._comment = 'changed comment';
    const r2 = replayCombat(cloned);
    expect(r1.hash).toBe(r2.hash);
  });
});

describe('replayCombat — 骰带可建', () => {
  it('单 epoch：tapeFinal 各通道长度正确（A0-8 骰带消费前置）', () => {
    const r = replayCombat(case24);
    expect(r.tapeFinal.current.channels.attackHit).toHaveLength(32);
    expect(r.tapeFinal.current.channels.initiative).toHaveLength(10);
    expect(r.tapeFinal.current.channels.intentCheck).toHaveLength(7);
    expect(r.tapeFinal.current.channels.statusContest).toHaveLength(6);
    expect(r.tapeFinal.current.channels.procCheck).toHaveLength(5);
    expect(r.tapeFinal.epochSeq).toBe(0);
    expect(r.tapeFinal.exhausted).toHaveLength(0);
  });

  it('多 epoch 续杯：旧 epoch 归档、cursor 归零、epochSeq 递增', () => {
    const f = makeMinimalFixture();
    f.epochs = [
      f.epochs[0],
      {
        outputId: 'out-2',
        dice: Array(60).fill(10),
        channelSplit: { ...DEFAULT_SPLIT },
      },
      {
        outputId: 'out-3',
        dice: Array(60).fill(5),
        channelSplit: { ...DEFAULT_SPLIT },
      },
    ];
    const r = replayCombat(f);
    expect(r.tapeFinal.epochSeq).toBe(2);
    expect(r.tapeFinal.exhausted).toHaveLength(2);
    expect(r.tapeFinal.current.outputId).toBe('out-3');
    expect(r.tapeFinal.current.cursors.attackHit).toBe(0);
    expect(r.tapeFinal.current.cursors.procCheck).toBe(0);
  });

  it('06/24 两场 fixture 都能被 replay 解析（A0-8）', () => {
    expect(() => replayCombat(case06)).not.toThrow();
    expect(() => replayCombat(case24)).not.toThrow();
    const r6 = replayCombat(case06);
    const r4 = replayCombat(case24);
    expect(r6.milestones.length).toBeGreaterThan(0);
    expect(r4.milestones.length).toBeGreaterThan(0);
    expect(r6.tapeFinal.current.channels.attackHit).toHaveLength(32);
    expect(r4.tapeFinal.current.channels.attackHit).toHaveLength(32);
  });
});

describe('replayCombat — reducer 注入缝', () => {
  it('传 reducer 不报错（M1 起实装驱动，M0 仅预留参数）', () => {
    const stubTape = replayCombat(case24).tapeFinal;
    const reducer: ReplayReducer = () => ({
      events: [],
      tape: stubTape,
    });
    expect(() => replayCombat(case24, reducer)).not.toThrow();
    // M0 不调用 reducer，events 仍恒为 []
    expect(replayCombat(case24, reducer).events).toEqual([]);
  });
});

describe('validateFixture — 非法输入', () => {
  it('dice 非 60 个抛错', () => {
    const f = makeMinimalFixture();
    (f.epochs[0] as unknown as { dice: number[] }).dice = [1, 2, 3];
    expect(() => validateFixture(f)).toThrow(FixtureValidationError);
    expect(() => validateFixture(f)).toThrow(/dice 必须恰好 60/);
  });

  it('dice 含越界值（0）抛错', () => {
    const f = makeMinimalFixture();
    (f.epochs[0] as unknown as { dice: number[] }).dice = Array(59).fill(10).concat([0]);
    expect(() => validateFixture(f)).toThrow(/1\.\.20/);
  });

  it('dice 含越界值（21）抛错', () => {
    const f = makeMinimalFixture();
    (f.epochs[0] as unknown as { dice: number[] }).dice = Array(59).fill(10).concat([21]);
    expect(() => validateFixture(f)).toThrow(/1\.\.20/);
  });

  it('channelSplit 非默认预算抛错', () => {
    const f = makeMinimalFixture();
    (f.epochs[0] as unknown as { channelSplit: Record<DiceChannel, number> }).channelSplit = {
      attackHit: 31,
      initiative: 11,
      intentCheck: 7,
      statusContest: 6,
      procCheck: 5,
    };
    expect(() => validateFixture(f)).toThrow(/必须为 32/);
  });

  it('milestone kind 非法抛错', () => {
    const f = makeMinimalFixture();
    (f.expected.milestones[0] as { kind: string }).kind = 'unknown_kind';
    expect(() => validateFixture(f)).toThrow(/kind 非法/);
  });

  it('commandId 重复抛错', () => {
    const f = makeMinimalFixture();
    f.commands = [
      {
        commandId: 'c1',
        expectedRevision: 0,
        kind: 'DeclareAttack',
        actorId: '甲',
        cost: 'attack',
        payload: {},
      },
      {
        commandId: 'c1',
        expectedRevision: 1,
        kind: 'PassAttack',
        actorId: '甲',
        cost: 'attack',
        payload: {},
      },
    ];
    expect(() => validateFixture(f)).toThrow(/commandId 重复/);
  });

  it('commandId 空字符串抛错', () => {
    const f = makeMinimalFixture();
    f.commands = [
      {
        commandId: '',
        expectedRevision: 0,
        kind: 'DeclareAttack',
        actorId: '甲',
        cost: 'attack',
        payload: {},
      },
    ];
    expect(() => validateFixture(f)).toThrow(/commandId 必须是非空字符串/);
  });

  it('epochs 为空抛错', () => {
    const f = makeMinimalFixture();
    f.epochs = [];
    expect(() => validateFixture(f)).toThrow(/epochs 至少 1 个/);
  });

  it('id 为空抛错', () => {
    const f = makeMinimalFixture();
    f.id = '';
    expect(() => validateFixture(f)).toThrow(/id 必须是非空字符串/);
  });
});
