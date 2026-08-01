/**
 * combat-v3/dice-tape.ts — 分通道骰带核心（M0）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §四（DiceTape 全章）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §2.2 / §2.6
 *
 * 验收点（plan §2.1 A0-1~A0-4）：
 *   A0-1  draw 只推进目标通道 cursor，其余通道 cursor 完全不变
 *   A0-2  通道耗尽时返回 { exhausted: true }，不返回骰值、不推进任何 cursor
 *   A0-3  beginEpoch 后各通道 cursor 归 0，旧 epoch 进 exhausted[]，旧余骰不可再取
 *   A0-4  splitSixty 按 DEFAULT_CHANNEL_SPLIT (32/10/7/6/5) 切分；输入长度 ≠ 60 时抛错
 *
 * 铁律（plan §1.3 1/2）：本目录内禁用 Math.random / new Function / eval，
 * no-nondeterminism.test.ts 会扫描断言。所有骰值只能由调用方传入。
 *
 * 全部纯函数 + 不可变：返回新对象，不 mutate 入参；数组用 slice 复制。
 */

import {
  CHANNEL_ORDER,
  DEFAULT_CHANNEL_SPLIT,
  type DiceChannel,
  type DiceEpoch,
  type DiceTapeState,
} from './types';

// ──────────────────────────────────────────────────────────────────────────────
// 公共类型
// ──────────────────────────────────────────────────────────────────────────────

/**
 * draw 的返回值：要么成功取到骰值并产出新 tape，要么通道耗尽（不推进任何 cursor）。
 *
 * - 成功：返回 { rolls, tape }，tape 是新对象（不可变），原 tape 不被修改
 * - 耗尽：返回 { exhausted: true, channel }，不返回骰值、不推进任何 cursor
 *         （架构 §四 4.4：dispatch 冻结 frame + 返回 BeginOutput，由 coordinator 注骰）
 */
export type DrawResult =
  { rolls: number[]; tape: DiceTapeState } | { exhausted: true; channel: DiceChannel };

// ──────────────────────────────────────────────────────────────────────────────
// createTape
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 由 DiceEpoch 构造初始 DiceTapeState。
 *
 * 校验（A0-4 间接）：epoch.channels 各通道长度必须严格等于 DEFAULT_CHANNEL_SPLIT
 * 对应值，不等则抛错——防止 fixture 写错预算导致 cursor 语义崩坏。
 *
 * cursors 字段允许为空对象，缺省的通道自动补 0（fixture 可能只给 channels，
 * cursors 由 createTape 补全）；若调用方给了非零 cursor 也会被原样接受
 * （RestoreCombat 场景）。
 */
export function createTape(epoch: DiceEpoch): DiceTapeState {
  // 校验各通道长度与默认预算严格匹配
  for (const channel of CHANNEL_ORDER) {
    const expected = DEFAULT_CHANNEL_SPLIT[channel];
    const actual = epoch.channels[channel];
    if (!actual || actual.length !== expected) {
      throw new Error(
        `[combat-v3/dice-tape] createTape: 通道「${channel}」长度不匹配，` +
          `期望 ${expected}，实际 ${actual?.length ?? 0}（outputId=${epoch.outputId}）`,
      );
    }
  }

  // 补全 cursors（缺省通道补 0），返回新对象不 mutate 入参
  const normalizedCursors = normalizeCursors(epoch.cursors);

  return {
    epochSeq: 0,
    current: {
      outputId: epoch.outputId,
      batchHash: epoch.batchHash,
      // channels 用浅复制兜底，确保后续不可变操作不触及调用方原对象
      channels: copyChannels(epoch.channels),
      cursors: normalizedCursors,
    },
    exhausted: [],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// draw
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 从目标通道取 n 颗骰。
 *
 * 语义（架构 §四 4.5 + 验收 A0-1/A0-2）：
 *   - 成功：返回 { rolls, tape }。rolls 长度恰为 n；tape.current.cursors 中
 *     **只有目标通道** cursor 前进 n，其余通道完全不变
 *   - 耗尽：当 cursor + n > 通道长度时，返回 { exhausted: true, channel }。
 *     **不返回任何骰值**，**不推进任何通道的 cursor**（包括目标通道本身）
 *
 * n 必须 ≥ 0（负数抛错）。n = 0 是合法的空取（返回空数组，cursor 不动）。
 * 部分越界（cursor + n 超出但 n 大于剩余骰数）同样视为耗尽——不做部分推进。
 */
export function draw(tape: DiceTapeState, channel: DiceChannel, n: number): DrawResult {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`[combat-v3/dice-tape] draw: n 必须是非负整数，实际 ${n}`);
  }

  const current = tape.current;
  const cursor = current.cursors[channel];
  const pool = current.channels[channel];
  const end = cursor + n;

  // 越界检查：超出则耗尽，绝不部分推进
  if (end > pool.length) {
    return { exhausted: true, channel };
  }

  // 切片骰值（slice 是复制，不会暴露内部数组引用）
  const rolls = pool.slice(cursor, end);

  // 构造新 cursors：只改目标通道，其余通道完全保留原值
  const newCursors: Record<DiceChannel, number> = {
    attackHit: current.cursors.attackHit,
    initiative: current.cursors.initiative,
    intentCheck: current.cursors.intentCheck,
    statusContest: current.cursors.statusContest,
    procCheck: current.cursors.procCheck,
  };
  newCursors[channel] = end;

  // 构造新 epoch（channels 共享引用——它们从不被修改，复用避免无谓拷贝）
  const newCurrent: DiceEpoch = {
    outputId: current.outputId,
    batchHash: current.batchHash,
    channels: current.channels,
    cursors: newCursors,
  };

  return {
    rolls,
    tape: {
      epochSeq: tape.epochSeq,
      current: newCurrent,
      // exhausted 数组从不变更（只有 beginEpoch 才追加），直接共享引用
      exhausted: tape.exhausted,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// beginEpoch
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 续杯：切换到全新 epoch，旧 current 进 exhausted[]（验收 A0-3）。
 *
 * 语义（架构 §四 4.4）：
 *   - 旧 epoch 的余骰**全部作废**（进 exhausted），旧余骰不可再取
 *   - 新 epoch 各通道 cursor 归 0（由 createTape 的 normalize 逻辑保证）
 *   - 不做通道间借用（保 replay 干净，架构 §一 1.6 否决项）
 *
 * epochSeq 单调递增（+1）。
 * 入参 epoch 同样走 createTape 内部的通道长度校验（复用 normalize 逻辑），
 * 保证新 epoch 的 channels 长度合法。
 */
export function beginEpoch(tape: DiceTapeState, epoch: DiceEpoch): DiceTapeState {
  // 校验新 epoch 通道长度（与 createTape 同款校验）
  for (const channel of CHANNEL_ORDER) {
    const expected = DEFAULT_CHANNEL_SPLIT[channel];
    const actual = epoch.channels[channel];
    if (!actual || actual.length !== expected) {
      throw new Error(
        `[combat-v3/dice-tape] beginEpoch: 通道「${channel}」长度不匹配，` +
          `期望 ${expected}，实际 ${actual?.length ?? 0}（outputId=${epoch.outputId}）`,
      );
    }
  }

  // 旧 current 进 exhausted（用 slice 复制，避免调用方后续 mutate 影响）
  const newExhausted = [...tape.exhausted, tape.current];

  return {
    epochSeq: tape.epochSeq + 1,
    current: {
      outputId: epoch.outputId,
      batchHash: epoch.batchHash,
      channels: copyChannels(epoch.channels),
      cursors: normalizeCursors(epoch.cursors),
    },
    exhausted: newExhausted,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// splitSixty
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 把恰好 60 颗 d20 按 DEFAULT_CHANNEL_SPLIT (32/10/7/6/5) 切分到 5 个通道。
 *
 * 切分顺序遵循 CHANNEL_ORDER（attackHit / initiative / intentCheck /
 * statusContest / procCheck），与 DEFAULT_CHANNEL_SPLIT 字段顺序一致。
 *
 * 输入长度 ≠ 60 时抛错（验收 A0-4）。返回的每个通道数组是 slice 复制
 * （不暴露原数组引用），调用方可安全持有。
 */
export function splitSixty(dice: number[]): Record<DiceChannel, number[]> {
  if (dice.length !== 60) {
    throw new Error(`[combat-v3/dice-tape] splitSixty: 输入长度必须为 60，实际 ${dice.length}`);
  }

  const result = {} as Record<DiceChannel, number[]>;
  let offset = 0;
  for (const channel of CHANNEL_ORDER) {
    const size = DEFAULT_CHANNEL_SPLIT[channel];
    result[channel] = dice.slice(offset, offset + size);
    offset += size;
  }

  // 防御性断言：切完应该正好用完 60 颗
  if (offset !== 60) {
    throw new Error(`[combat-v3/dice-tape] splitSixty: 内部错误，切分总长度 ${offset} ≠ 60`);
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// 内部辅助函数
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 归一化 cursors：缺省通道补 0，返回新对象。
 *
 * RestoreCombat 场景可能给非零 cursor，原值保留；fixture / 新 epoch 一般只给
 * channels，cursors 为空对象，此处统一补全所有通道为 0。
 */
function normalizeCursors(
  cursors: Readonly<Record<DiceChannel, number>>,
): Readonly<Record<DiceChannel, number>> {
  return {
    attackHit: cursors.attackHit ?? 0,
    initiative: cursors.initiative ?? 0,
    intentCheck: cursors.intentCheck ?? 0,
    statusContest: cursors.statusContest ?? 0,
    procCheck: cursors.procCheck ?? 0,
  };
}

/**
 * 浅复制 channels 的各通道数组，防止调用方 mutate 影响 tape 内部状态。
 *
 * 外层 Record 是新对象，每个通道数组是 slice 复制（独立引用）。
 * channels 数值本身是原始 number，不存在深拷贝需求。
 */
function copyChannels(
  channels: Readonly<Record<DiceChannel, readonly number[]>>,
): Readonly<Record<DiceChannel, readonly number[]>> {
  return {
    attackHit: channels.attackHit.slice(),
    initiative: channels.initiative.slice(),
    intentCheck: channels.intentCheck.slice(),
    statusContest: channels.statusContest.slice(),
    procCheck: channels.procCheck.slice(),
  };
}
