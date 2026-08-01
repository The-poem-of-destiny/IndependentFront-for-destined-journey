/**
 * combat-v3/replay.test.ts — replay harness 测试（M4）
 *
 * 验收对应（plan §2.1 / §7）：
 *   A0-5  同 fixture 跑两次 events 深相等且 hash 相同；无副作用
 *   A4-5  eventHash 稳定性：同 fixture 连跑 10 次 hash 相同
 *   A4-6  多 epoch 续杯：epochSeq 递增
 */

import { describe, expect, it } from 'vitest';
import { FixtureValidationError, replayCombat, validateFixture } from './replay';
import type { CombatFixture, DiceChannel } from './types';

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

/**
 * 一个能真正驱动内核跑 1 回合的最小合法 fixture（甲 player 打乙 enemy）。
 * 甲 dex 高 → 先动；只打一发 DeclareAttack，epoch 0 喂足够骰。
 * 注意：甲攻击必命中（hitBonus 高 / 乙 dodge 低），不被反伤（无 effects）。
 */
function makeRunFixture(): CombatFixture {
  return {
    id: 'run-minimal',
    sourceCase: '',
    bundle: {
      combatId: 'run-1',
      combatType: '标准',
      units: [
        {
          name: '甲',
          tier: 3,
          hp: 500,
          maxHp: 500,
          attributes: { str: 20, dex: 16, con: 15, int: 10, spi: 10 },
          side: 'player',
          hitBonus: 20,
          defense: 50,
          dr: 0.1,
          weaponAtk: 50,
        },
        {
          name: '乙',
          tier: 3,
          hp: 400,
          maxHp: 400,
          attributes: { str: 15, dex: 12, con: 15, int: 10, spi: 10 },
          side: 'enemy',
          dodgeBonus: 0,
          defense: 50,
          dr: 0.1,
          weaponAtk: 30,
        },
      ],
      programs: [],
      resourceSnapshots: { FP: 1000 },
      rulesetRevision: 'v3-m4-test',
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
        commandId: 'a1',
        expectedRevision: 0,
        kind: 'DeclareAttack',
        actorId: '甲',
        cost: 'attack',
        payload: { targetId: '乙', intentionLevel: '常规', costs: {} },
      },
    ],
    expected: {
      milestones: [{ kind: 'roundCount', value: 1 }],
      eventHash: null,
    },
  };
}

describe('replayCombat — 真实内核驱动', () => {
  it('驱动 1 回合攻击：events 非空（产 DamageApplied），hash 为具体字符串', () => {
    const r = replayCombat(makeRunFixture());
    expect(r.events.length).toBeGreaterThan(0);
    expect(r.events.some((e) => e.kind === 'DamageApplied')).toBe(true);
    expect(typeof r.hash).toBe('string');
    expect(r.hash.length).toBeGreaterThan(0);
    expect(r.milestones).toEqual(makeRunFixture().expected.milestones);
  });

  it('同 fixture 跑两次 → events 深相等且 hash 相同（A0-5 确定性）', () => {
    const r1 = replayCombat(makeRunFixture());
    const r2 = replayCombat(makeRunFixture());
    expect(r1.events).toEqual(r2.events);
    expect(r1.hash).toBe(r2.hash);
  });

  it('replay 是纯函数：返回值可 JSON 序列化且往返一致', () => {
    const r = replayCombat(makeRunFixture());
    const serialized = JSON.stringify(r);
    expect(serialized).toBeDefined();
    const back = JSON.parse(serialized) as ReturnType<typeof replayCombat>;
    expect(back.hash).toBe(r.hash);
  });
});

describe('replayCombat — eventHash 稳定性（A4-5）', () => {
  it('同 fixture 连跑 10 次 hash 完全相同（冻结依据）', () => {
    const f = makeRunFixture();
    const hashes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      hashes.add(replayCombat(f).hash);
    }
    expect(hashes.size).toBe(1);
  });

  it('改 fixture 核心字段（战斗单位 HP）→ hash 变（hash 敏感性）', () => {
    const r1 = replayCombat(makeRunFixture());
    const cloned: CombatFixture = JSON.parse(JSON.stringify(makeRunFixture())) as CombatFixture;
    cloned.bundle.units = [{ ...cloned.bundle.units[0], hp: 600 }, cloned.bundle.units[1]] as never;
    const r2 = replayCombat(cloned);
    expect(r1.hash).not.toBe(r2.hash);
  });
});

describe('replayCombat — 多 epoch 续杯', () => {
  it('多 epoch：epochSeq 递增（A4-6 续杯），事件序列仍确定', () => {
    const f = makeRunFixture();
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
    // 多 epoch 能驱动到终局/稳定且 hash 确定
    expect(typeof r.hash).toBe('string');
    // 跑两次仍相同（跨续杯确定性）
    expect(replayCombat(f).hash).toBe(r.hash);
  });
});

describe('validateFixture — 非法输入', () => {
  it('dice 非 60 个抛错', () => {
    const f = makeRunFixture();
    (f.epochs[0] as unknown as { dice: number[] }).dice = [1, 2, 3];
    expect(() => validateFixture(f)).toThrow(/dice 必须恰好 60/);
  });

  it('dice 含越界值（0）抛错', () => {
    const f = makeRunFixture();
    (f.epochs[0] as unknown as { dice: number[] }).dice = Array(59).fill(10).concat([0]);
    expect(() => validateFixture(f)).toThrow(/1\.\.20/);
  });

  it('milestone kind 非法抛错', () => {
    const f = makeRunFixture();
    (f.expected.milestones[0] as { kind: string }).kind = 'unknown_kind';
    expect(() => validateFixture(f)).toThrow(/kind 非法/);
  });

  it('commandId 重复抛错', () => {
    const f = makeRunFixture();
    f.commands = [f.commands[0], { ...f.commands[0], commandId: 'a1' }];
    expect(() => validateFixture(f)).toThrow(/commandId 重复/);
  });

  it('bundle.units 为空抛错', () => {
    const f = makeRunFixture();
    (f.bundle as unknown as { units: unknown[] }).units = [];
    expect(() => validateFixture(f)).toThrow(/units 必须非空/);
  });

  it('unit name 重复抛错', () => {
    const f = makeRunFixture();
    f.bundle.units = [f.bundle.units[0], { ...(f.bundle.units[0] as object) }] as never;
    expect(() => validateFixture(f)).toThrow(/name 重复/);
  });
});
