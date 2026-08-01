/**
 * combat-v3/dice-tape.test.ts — 分通道骰带测试（M0，plan §2.6）
 *
 * 覆盖验收点 A0-1~A0-4：
 *   - draw 只推进目标通道 cursor
 *   - draw 越界返回 exhausted 且不推进任何 cursor
 *   - beginEpoch 重置全部 cursor 并归档旧 epoch（旧余骰不可再取）
 *   - splitSixty 按 32-10-7-6-5 切分 / 输入非 60 抛错
 *   - createTape 通道长度不匹配抛错
 *   - 多次 draw 跨通道互不干扰
 *   - 不可变保护：原 tape 不被 mutate
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CHANNEL_SPLIT,
  type DiceChannel,
  type DiceEpoch,
  type DiceTapeState,
} from './types';
import { beginEpoch, createTape, draw, splitSixty } from './dice-tape';

// ──────────────────────────────────────────────────────────────────────────────
// 测试辅助：构造合法的 DiceEpoch
// ──────────────────────────────────────────────────────────────────────────────

/** 构造一个全 10 的合法 epoch（各通道长度等于 DEFAULT_CHANNEL_SPLIT） */
function makeEpoch(
  outputId = 'out-1',
  diceValue = 10,
): DiceEpoch {
  const channels: Record<DiceChannel, number[]> = {
    attackHit: Array(DEFAULT_CHANNEL_SPLIT.attackHit).fill(diceValue),
    initiative: Array(DEFAULT_CHANNEL_SPLIT.initiative).fill(diceValue),
    intentCheck: Array(DEFAULT_CHANNEL_SPLIT.intentCheck).fill(diceValue),
    statusContest: Array(DEFAULT_CHANNEL_SPLIT.statusContest).fill(diceValue),
    procCheck: Array(DEFAULT_CHANNEL_SPLIT.procCheck).fill(diceValue),
  };
  return {
    outputId,
    batchHash: `hash-${outputId}`,
    channels,
    cursors: {
      attackHit: 0,
      initiative: 0,
      intentCheck: 0,
      statusContest: 0,
      procCheck: 0,
    },
  };
}

/** 构造指定通道使用指定骰值的 epoch，其余通道全 10 */
function makeEpochWithChannel(
  channel: DiceChannel,
  values: number[],
  outputId = 'out-1',
): DiceEpoch {
  const epoch = makeEpoch(outputId);
  // 覆盖目标通道的骰值
  const channelValues = [...values];
  while (channelValues.length < DEFAULT_CHANNEL_SPLIT[channel]) {
    channelValues.push(10);
  }
  (epoch.channels as Record<DiceChannel, number[]>)[channel] = channelValues.slice(
    0,
    DEFAULT_CHANNEL_SPLIT[channel],
  );
  return epoch;
}

// ──────────────────────────────────────────────────────────────────────────────
// createTape
// ──────────────────────────────────────────────────────────────────────────────

describe('createTape', () => {
  it('正常构造初始 tape，epochSeq=0，exhausted 为空，cursors 全 0', () => {
    const epoch = makeEpoch();
    const tape = createTape(epoch);

    expect(tape.epochSeq).toBe(0);
    expect(tape.exhausted).toEqual([]);
    expect(tape.current.cursors).toEqual({
      attackHit: 0,
      initiative: 0,
      intentCheck: 0,
      statusContest: 0,
      procCheck: 0,
    });
  });

  it('通道长度不匹配时抛错（attackHit 短 1）', () => {
    const epoch = makeEpoch();
    // 故意把 attackHit 砍一颗
    const badChannels = {
      ...epoch.channels,
      attackHit: epoch.channels.attackHit.slice(0, DEFAULT_CHANNEL_SPLIT.attackHit - 1),
    };
    const badEpoch: DiceEpoch = {
      ...epoch,
      channels: badChannels as unknown as DiceEpoch['channels'],
    };

    expect(() => createTape(badEpoch)).toThrowError(/attackHit.*长度不匹配/);
  });

  it('通道长度不匹配时抛错（procCheck 多 1）', () => {
    const epoch = makeEpoch();
    const badChannels = {
      ...epoch.channels,
      procCheck: [
        ...epoch.channels.procCheck,
        5, // 多塞一颗
      ],
    };
    const badEpoch: DiceEpoch = {
      ...epoch,
      channels: badChannels as unknown as DiceEpoch['channels'],
    };

    expect(() => createTape(badEpoch)).toThrowError(/procCheck.*长度不匹配/);
  });

  it('cursors 缺省时自动补 0', () => {
    const epoch = makeEpoch();
    // 传入空 cursors
    const epochNoCursors: DiceEpoch = {
      outputId: epoch.outputId,
      batchHash: epoch.batchHash,
      channels: epoch.channels,
      cursors: {} as DiceEpoch['cursors'],
    };
    const tape = createTape(epochNoCursors);

    expect(tape.current.cursors.attackHit).toBe(0);
    expect(tape.current.cursors.procCheck).toBe(0);
  });

  it('不 mutate 入参 epoch 的 channels/cursors', () => {
    const epoch = makeEpoch();
    const originalChannels = epoch.channels.attackHit;
    const tape = createTape(epoch);

    // 取一颗骰后，原 epoch 的 channels 不应变
    draw(tape, 'attackHit', 1);
    expect(epoch.channels.attackHit).toBe(originalChannels);
    expect(epoch.channels.attackHit.length).toBe(DEFAULT_CHANNEL_SPLIT.attackHit);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// draw — A0-1 推进单通道
// ──────────────────────────────────────────────────────────────────────────────

describe('draw - 推进单通道 cursor', () => {
  it('draw attackHit 2 颗后只 attackHit cursor 变 2，其余通道不变', () => {
    const tape = createTape(makeEpochWithChannel('attackHit', [5, 12, 8]));

    const result = draw(tape, 'attackHit', 2);

    expect('rolls' in result).toBe(true);
    if ('rolls' in result) {
      expect(result.rolls).toEqual([5, 12]);
      expect(result.tape.current.cursors.attackHit).toBe(2);
      // 其余通道完全不变
      expect(result.tape.current.cursors.initiative).toBe(0);
      expect(result.tape.current.cursors.intentCheck).toBe(0);
      expect(result.tape.current.cursors.statusContest).toBe(0);
      expect(result.tape.current.cursors.procCheck).toBe(0);
    }
  });

  it('draw initiative 1 颗后只 initiative cursor 变 1', () => {
    const tape = createTape(makeEpochWithChannel('initiative', [15, 7]));
    const result = draw(tape, 'initiative', 1);

    if ('rolls' in result) {
      expect(result.rolls).toEqual([15]);
      expect(result.tape.current.cursors.initiative).toBe(1);
      expect(result.tape.current.cursors.attackHit).toBe(0);
    }
  });

  it('draw procCheck 1 颗后只 procCheck cursor 变 1', () => {
    const tape = createTape(makeEpochWithChannel('procCheck', [20]));
    const result = draw(tape, 'procCheck', 1);

    if ('rolls' in result) {
      expect(result.rolls).toEqual([20]);
      expect(result.tape.current.cursors.procCheck).toBe(1);
      expect(result.tape.current.cursors.attackHit).toBe(0);
    }
  });

  it('draw 0 颗是合法空取，cursor 不动', () => {
    const tape = createTape(makeEpoch());
    const result = draw(tape, 'attackHit', 0);

    if ('rolls' in result) {
      expect(result.rolls).toEqual([]);
      expect(result.tape.current.cursors.attackHit).toBe(0);
    }
  });

  it('draw 不 mutate 原 tape', () => {
    const tape = createTape(makeEpochWithChannel('attackHit', [5, 12]));
    const cursorBefore = tape.current.cursors.attackHit;

    draw(tape, 'attackHit', 2);

    expect(tape.current.cursors.attackHit).toBe(cursorBefore);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// draw — A0-2 越界耗尽
// ──────────────────────────────────────────────────────────────────────────────

describe('draw - 越界返回 exhausted', () => {
  it('attackHit 全部取完后第 33 次取 1 颗返回 exhausted', () => {
    const tape = createTape(makeEpoch());

    // 先把 attackHit 32 颗全部取完
    let current = tape;
    const full = draw(current, 'attackHit', DEFAULT_CHANNEL_SPLIT.attackHit);
    if ('rolls' in full) {
      current = full.tape;
    }

    // 再取 1 颗应耗尽
    const result = draw(current, 'attackHit', 1);
    expect('exhausted' in result).toBe(true);
    if ('exhausted' in result) {
      expect(result.exhausted).toBe(true);
      expect(result.channel).toBe('attackHit');
    }
  });

  it('耗尽时不返回任何骰值', () => {
    const tape = createTape(makeEpoch());
    // 把 procCheck 的 5 颗全部取走
    let current = tape;
    const full = draw(current, 'procCheck', DEFAULT_CHANNEL_SPLIT.procCheck);
    if ('rolls' in full) {
      current = full.tape;
    }

    const result = draw(current, 'procCheck', 1);
    expect('rolls' in result).toBe(false);
  });

  it('耗尽时不推进任何 cursor（包括目标通道本身）', () => {
    const tape = createTape(makeEpoch());
    // 取完 intentCheck 的 7 颗
    let current = tape;
    const full = draw(current, 'intentCheck', DEFAULT_CHANNEL_SPLIT.intentCheck);
    if ('rolls' in full) {
      current = full.tape;
    }
    const cursorBeforeExhausted = current.current.cursors.intentCheck;

    // 尝试再取 1 颗
    const result = draw(current, 'intentCheck', 1);
    expect('exhausted' in result).toBe(true);
    // cursor 没变
    expect(current.current.cursors.intentCheck).toBe(cursorBeforeExhausted);
  });

  it('部分越界也视为耗尽（剩 2 颗取 3 颗）', () => {
    const tape = createTape(makeEpoch());
    // statusContest 有 6 颗，先取 4 颗剩 2
    let current = tape;
    const first = draw(current, 'statusContest', 4);
    if ('rolls' in first) {
      current = first.tape;
    }

    // 再取 3 颗应耗尽（只有 2 颗可取）
    const result = draw(current, 'statusContest', 3);
    expect('exhausted' in result).toBe(true);
    // cursor 仍停在 4（未被部分推进）
    expect(current.current.cursors.statusContest).toBe(4);
  });

  it('n 为负数抛错', () => {
    const tape = createTape(makeEpoch());
    expect(() => draw(tape, 'attackHit', -1)).toThrowError(/非负整数/);
  });

  it('n 为非整数抛错', () => {
    const tape = createTape(makeEpoch());
    expect(() => draw(tape, 'attackHit', 1.5)).toThrowError(/非负整数/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// draw — 跨通道互不干扰（多次 draw）
// ──────────────────────────────────────────────────────────────────────────────

describe('draw - 多次跨通道互不干扰', () => {
  it('先取 attackHit 再取 initiative 再取 procCheck，各通道独立推进', () => {
    const tape = createTape(makeEpoch());

    const r1 = draw(tape, 'attackHit', 3);
    expect('rolls' in r1).toBe(true);
    if (!('rolls' in r1)) return;

    const r2 = draw(r1.tape, 'initiative', 2);
    expect('rolls' in r2).toBe(true);
    if (!('rolls' in r2)) return;

    const r3 = draw(r2.tape, 'procCheck', 1);
    expect('rolls' in r3).toBe(true);
    if (!('rolls' in r3)) return;

    expect(r3.tape.current.cursors.attackHit).toBe(3);
    expect(r3.tape.current.cursors.initiative).toBe(2);
    expect(r3.tape.current.cursors.procCheck).toBe(1);
    // 未触碰的通道仍为 0
    expect(r3.tape.current.cursors.intentCheck).toBe(0);
    expect(r3.tape.current.cursors.statusContest).toBe(0);
  });

  it('同通道连续取多次，cursor 累加', () => {
    const tape = createTape(makeEpoch());

    const r1 = draw(tape, 'attackHit', 5);
    const r2 = 'rolls' in r1 ? draw(r1.tape, 'attackHit', 10) : null;
    const r3 = r2 && 'rolls' in r2 ? draw(r2.tape, 'attackHit', 17) : null;

    expect(r3 && 'rolls' in r3).toBe(true);
    if (r3 && 'rolls' in r3) {
      expect(r3.tape.current.cursors.attackHit).toBe(32);
    }
  });

  it('同通道取到边界（恰好取完）不返回 exhausted', () => {
    const tape = createTape(makeEpoch());
    const result = draw(tape, 'attackHit', DEFAULT_CHANNEL_SPLIT.attackHit);
    expect('rolls' in result).toBe(true);
    if ('rolls' in result) {
      expect(result.rolls.length).toBe(DEFAULT_CHANNEL_SPLIT.attackHit);
      expect(result.tape.current.cursors.attackHit).toBe(
        DEFAULT_CHANNEL_SPLIT.attackHit,
      );
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// beginEpoch — A0-3 续杯归档
// ──────────────────────────────────────────────────────────────────────────────

describe('beginEpoch - 续杯归档', () => {
  it('beginEpoch 后旧 epoch 进 exhausted[]，epochSeq +1', () => {
    const tape = createTape(makeEpoch('out-1'));
    // 先消耗一些骰子让旧 epoch 有"余骰"
    const drawn = draw(tape, 'attackHit', 10);
    const beforeTape = 'rolls' in drawn ? drawn.tape : tape;

    const newEpoch = makeEpoch('out-2');
    const newTape = beginEpoch(beforeTape, newEpoch);

    expect(newTape.epochSeq).toBe(1);
    expect(newTape.exhausted.length).toBe(1);
    expect(newTape.exhausted[0].outputId).toBe('out-1');
    expect(newTape.current.outputId).toBe('out-2');
  });

  it('beginEpoch 后各通道 cursor 归 0', () => {
    const tape = createTape(makeEpoch());
    const drawn = draw(tape, 'attackHit', 5);
    const beforeTape = 'rolls' in drawn ? drawn.tape : tape;
    expect(beforeTape.current.cursors.attackHit).toBe(5);

    const newTape = beginEpoch(beforeTape, makeEpoch('out-2'));

    expect(newTape.current.cursors.attackHit).toBe(0);
    expect(newTape.current.cursors.initiative).toBe(0);
    expect(newTape.current.cursors.intentCheck).toBe(0);
    expect(newTape.current.cursors.statusContest).toBe(0);
    expect(newTape.current.cursors.procCheck).toBe(0);
  });

  it('旧 epoch 的余骰不可再取（耗尽的旧 epoch 不在 current 里）', () => {
    const tape = createTape(makeEpoch('out-1'));
    // 旧 epoch 只取了 10 颗 attackHit（剩 22），然后续杯
    const drawn = draw(tape, 'attackHit', 10);
    const beforeTape = 'rolls' in drawn ? drawn.tape : tape;

    const newTape = beginEpoch(beforeTape, makeEpoch('out-2'));

    // 新 tape 的 attackHit 通道是全新的 32 颗，不是旧 epoch 剩下的 22 颗
    expect(newTape.current.channels.attackHit.length).toBe(
      DEFAULT_CHANNEL_SPLIT.attackHit,
    );
    expect(newTape.current.cursors.attackHit).toBe(0);

    // 可以在新 epoch 里正常取 32 颗
    const fullDraw = draw(newTape, 'attackHit', DEFAULT_CHANNEL_SPLIT.attackHit);
    expect('rolls' in fullDraw).toBe(true);
  });

  it('多次续杯：exhausted[] 按序累积，epochSeq 单调递增', () => {
    let tape = createTape(makeEpoch('out-1'));
    tape = beginEpoch(tape, makeEpoch('out-2'));
    tape = beginEpoch(tape, makeEpoch('out-3'));

    expect(tape.epochSeq).toBe(2);
    expect(tape.exhausted.length).toBe(2);
    expect(tape.exhausted[0].outputId).toBe('out-1');
    expect(tape.exhausted[1].outputId).toBe('out-2');
    expect(tape.current.outputId).toBe('out-3');
  });

  it('beginEpoch 通道长度不匹配时抛错', () => {
    const tape = createTape(makeEpoch('out-1'));
    const badEpoch = makeEpoch('out-2');
    const badChannels = {
      ...badEpoch.channels,
      attackHit: badEpoch.channels.attackHit.slice(0, 10), // 砍短
    };
    const bad: DiceEpoch = {
      ...badEpoch,
      channels: badChannels as unknown as DiceEpoch['channels'],
    };

    expect(() => beginEpoch(tape, bad)).toThrowError(/attackHit.*长度不匹配/);
  });

  it('beginEpoch 不 mutate 原 tape', () => {
    const tape = createTape(makeEpoch('out-1'));
    const exhaustedBefore = tape.exhausted.length;

    beginEpoch(tape, makeEpoch('out-2'));

    expect(tape.exhausted.length).toBe(exhaustedBefore);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// splitSixty — A0-4 切分
// ──────────────────────────────────────────────────────────────────────────────

describe('splitSixty', () => {
  it('按 32-10-7-6-5 切分 60 颗骰子', () => {
    // 构造 60 个唯一值便于校验切分位置
    const dice = Array.from({ length: 60 }, (_, i) => i + 1);
    const channels = splitSixty(dice);

    expect(channels.attackHit.length).toBe(32);
    expect(channels.initiative.length).toBe(10);
    expect(channels.intentCheck.length).toBe(7);
    expect(channels.statusContest.length).toBe(6);
    expect(channels.procCheck.length).toBe(5);

    // 校验顺序：attackHit 取前 32，initiative 取接下来 10...
    expect(channels.attackHit[0]).toBe(1);
    expect(channels.attackHit[31]).toBe(32);
    expect(channels.initiative[0]).toBe(33);
    expect(channels.initiative[9]).toBe(42);
    expect(channels.intentCheck[0]).toBe(43);
    expect(channels.intentCheck[6]).toBe(49);
    expect(channels.statusContest[0]).toBe(50);
    expect(channels.statusContest[5]).toBe(55);
    expect(channels.procCheck[0]).toBe(56);
    expect(channels.procCheck[4]).toBe(60);
  });

  it('输入长度 59 抛错', () => {
    const dice = Array.from({ length: 59 }, (_, i) => i + 1);
    expect(() => splitSixty(dice)).toThrowError(/长度必须为 60.*59/);
  });

  it('输入长度 61 抛错', () => {
    const dice = Array.from({ length: 61 }, (_, i) => i + 1);
    expect(() => splitSixty(dice)).toThrowError(/长度必须为 60.*61/);
  });

  it('输入长度 0 抛错', () => {
    expect(() => splitSixty([])).toThrowError(/长度必须为 60.*0/);
  });

  it('返回的各通道是独立数组（修改不影响原 dice）', () => {
    const dice = Array.from({ length: 60 }, (_, i) => i + 1);
    const channels = splitSixty(dice);

    channels.attackHit[0] = 999;
    // 原 dice 的对应位置不应被改
    expect(dice[0]).toBe(1);
  });

  it('全 10 的骰子切分后各通道都是 10', () => {
    const dice = Array(60).fill(10);
    const channels = splitSixty(dice);

    for (const ch of Object.keys(channels) as DiceChannel[]) {
      for (const v of channels[ch]) {
        expect(v).toBe(10);
      }
    }
  });

  it('切分结果与 createTape 兼容', () => {
    // splitSixty → channels → DiceEpoch → createTape 应该能跑通
    const dice = Array.from({ length: 60 }, () => 15);
    const channels = splitSixty(dice);
    const epoch: DiceEpoch = {
      outputId: 'out-1',
      batchHash: 'test-hash',
      channels: channels as unknown as DiceEpoch['channels'],
      cursors: {} as DiceEpoch['cursors'],
    };
    const tape = createTape(epoch);

    expect(tape.epochSeq).toBe(0);
    expect(tape.current.channels.attackHit.length).toBe(32);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 端到端：splitSixty → createTape → draw → beginEpoch → draw
// ──────────────────────────────────────────────────────────────────────────────

describe('端到端集成', () => {
  it('完整生命周期：切分→建带→多通道取骰→续杯→新 epoch 取骰', () => {
    // 第一 epoch：60 颗全 1（便于断言取到的值）
    const dice1 = Array(60).fill(1);
    const channels1 = splitSixty(dice1);
    const epoch1: DiceEpoch = {
      outputId: 'out-1',
      batchHash: 'hash-1',
      channels: channels1 as unknown as DiceEpoch['channels'],
      cursors: {} as DiceEpoch['cursors'],
    };
    let tape: DiceTapeState = createTape(epoch1);

    // 从 attackHit 取 2 颗
    const r1 = draw(tape, 'attackHit', 2);
    expect('rolls' in r1).toBe(true);
    if ('rolls' in r1) {
      expect(r1.rolls).toEqual([1, 1]);
      tape = r1.tape;
    }

    // 从 initiative 取 1 颗
    const r2 = draw(tape, 'initiative', 1);
    expect('rolls' in r2).toBe(true);
    if ('rolls' in r2) {
      expect(r2.rolls).toEqual([1]);
      tape = r2.tape;
    }

    // 续杯到第二 epoch（全 20）
    const dice2 = Array(60).fill(20);
    const channels2 = splitSixty(dice2);
    const epoch2: DiceEpoch = {
      outputId: 'out-2',
      batchHash: 'hash-2',
      channels: channels2 as unknown as DiceEpoch['channels'],
      cursors: {} as DiceEpoch['cursors'],
    };
    tape = beginEpoch(tape, epoch2);

    // 验证：cursor 全归零，新 epoch 全 20
    expect(tape.current.cursors.attackHit).toBe(0);
    const r3 = draw(tape, 'attackHit', 1);
    expect('rolls' in r3).toBe(true);
    if ('rolls' in r3) {
      expect(r3.rolls).toEqual([20]);
    }

    // 旧 epoch 在 exhausted
    expect(tape.exhausted.length).toBe(1);
    expect(tape.epochSeq).toBe(1);
  });

  it('模拟第 07 场 9 次续杯：多次 beginEpoch 不丢数据', () => {
    let tape = createTape(makeEpoch('out-1'));

    for (let i = 2; i <= 10; i++) {
      // 每次续杯前消耗一颗让旧 epoch 非空
      const drawn = draw(tape, 'attackHit', 1);
      if ('rolls' in drawn) {
        tape = drawn.tape;
      }
      tape = beginEpoch(tape, makeEpoch(`out-${i}`));
    }

    expect(tape.epochSeq).toBe(9);
    expect(tape.exhausted.length).toBe(9);
    expect(tape.current.outputId).toBe('out-10');
    // 前 9 个 epoch 按序归档
    for (let i = 0; i < 9; i++) {
      expect(tape.exhausted[i].outputId).toBe(`out-${i + 1}`);
    }
  });
});
