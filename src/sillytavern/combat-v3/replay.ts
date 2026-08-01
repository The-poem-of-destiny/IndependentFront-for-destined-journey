/**
 * combat-v3/replay.ts — replay harness（M0 版本）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §四 4.6（provenance 与 replay 语义）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §2.2 / §2.6 / §2.7
 *
 * 验收：
 *   A0-5  replayCombat 是纯函数：同 fixture 跑两次，events 深相等且 hash 相同；
 *         跑完不产生任何 DB/store 副作用
 *   A0-8  06/24 两场简版 fixture 的 milestone 断言通过
 *         （M0 = 结构合法 + 骰带可建；数值 milestone 由 M1 起内核就位后才真正断言）
 *
 * M0 版本：内核 reducer 未就位，replay 只做：
 *   ① fixture 结构校验（validateFixture）
 *   ② epochs 切分为骰带（splitSixty + createTape + beginEpoch），验证骰带可建
 *   ③ 计算稳定 hash（fixture 核心字段的规范化 djb2）
 *   ④ 回显 expected.milestones
 *   events 恒为 []（M1 起由 reducer 注入产出 DomainEvent）。
 *
 * reducer 注入缝：第二个参数 _reducer（M1+ 实装）。M0 不调用，commands 暂不驱动。
 *
 * 铁律（plan §1.3）：本文件零 Math.random / new Function / eval，
 * no-nondeterminism.test.ts 会扫描断言。djb2 用位运算 + charCodeAt，确定性。
 */

import { beginEpoch, createTape, splitSixty } from './dice-tape';
import {
  CHANNEL_ORDER,
  DEFAULT_CHANNEL_SPLIT,
  type CombatFixture,
  type DiceChannel,
  type DiceEpoch,
  type DiceTapeState,
  type Milestone,
  type MilestoneKind,
} from './types';

// ──────────────────────────────────────────────────────────────────────────────
// 公共类型
// ──────────────────────────────────────────────────────────────────────────────

/**
 * replay 的返回值。
 *
 * - events：M0 恒为空数组；M1 起由 reducer 产出 DomainEvent[]
 * - hash：基于 fixture 核心字段（忽略 _synthetic/_provenance 元数据）的稳定哈希；
 *         同 fixture 跑两次必然相同（验收 A0-5）。M4 起改基于 DomainEvent 序列。
 * - milestones：回显 fixture.expected.milestones，供 contract test 断言
 * - tapeFinal：replay 后骰带的最终状态，验证骰带可建（M0 阶段的核心产出）
 */
export interface ReplayResult {
  readonly events: readonly unknown[];
  readonly hash: string;
  readonly milestones: readonly Milestone[];
  readonly tapeFinal: DiceTapeState;
}

/**
 * reducer 注入缝（M1+ 实装）。
 *
 * M0 不调用。M1 起，replayCombat 会用真实内核 reduce 驱动 fixture.commands，
 * reducer 负责消费 tape 的骰子并产出 DomainEvent[] + 最终 tape。
 */
export interface ReplayReducer {
  (fixture: CombatFixture, tape: DiceTapeState): {
    events: readonly unknown[];
    tape: DiceTapeState;
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 主入口
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 重放一场 fixture 战斗。纯函数，无 DB/store 副作用（验收 A0-5）。
 *
 * M0：reducer 未就位，events 恒为 []，commands 不驱动；只验证 fixture 合法 +
 * 骰带可建 + 计算 hash + 回显 milestones。M1 起传 reducer 即可驱动完整流程。
 */
export function replayCombat(
  fixture: CombatFixture,
  _reducer?: ReplayReducer,
): ReplayResult {
  validateFixture(fixture);

  const tape = buildTape(fixture.epochs);

  // M0：reducer 未就位。M1 起在此处用 _reducer(fixture, tape) 产出 events + 最终 tape。
  // 当前预留参数，不调用——保证 M0 的 events 恒为 [] 且行为完全确定。
  const events: readonly unknown[] = [];

  const hash = hashFixture(fixture);

  return {
    events,
    hash,
    milestones: fixture.expected.milestones,
    tapeFinal: tape,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// fixture 结构校验
// ──────────────────────────────────────────────────────────────────────────────

const VALID_MILESTONE_KINDS: ReadonlySet<MilestoneKind> = new Set<MilestoneKind>([
  'damage',
  'reflected',
  'prevented',
  'statusApplied',
  'moraleChanged',
  'summoned',
  'terminal',
  'fpDelta',
  'roundCount',
]);

/**
 * fixture 校验失败错误。所有校验问题都抛这个类型，方便上层 catch 区分。
 */
export class FixtureValidationError extends Error {
  constructor(message: string) {
    super(`[combat-v3/replay] ${message}`);
    this.name = 'FixtureValidationError';
  }
}

/**
 * 校验 fixture 结构合法性。
 *
 * 校验项（M0 范围）：
 *   - id 非空字符串
 *   - epochs 至少 1 个
 *   - 每个 epoch.dice 恰好 60 个 1..20 整数
 *   - 每个 epoch.channelSplit === DEFAULT_CHANNEL_SPLIT（M0 只支持默认预算，
 *     与 splitSixty 的切分方式保持一致）
 *   - commands.commandId 唯一且非空
 *   - expected.milestones[].kind ∈ 9 种合法枚举
 *
 * 不校验 command kind（M1 内核 dispatch 时校验）和 milestone 的额外字段
 *（如 duration，TS 类型上的并集字段，运行时宽松）。
 */
export function validateFixture(fixture: CombatFixture): void {
  if (!fixture || typeof fixture.id !== 'string' || fixture.id.length === 0) {
    throw new FixtureValidationError('fixture.id 必须是非空字符串');
  }
  if (!Array.isArray(fixture.epochs) || fixture.epochs.length === 0) {
    throw new FixtureValidationError('fixture.epochs 至少 1 个');
  }
  if (!Array.isArray(fixture.commands)) {
    throw new FixtureValidationError('fixture.commands 必须是数组');
  }
  if (
    !fixture.expected ||
    !Array.isArray(fixture.expected.milestones)
  ) {
    throw new FixtureValidationError('fixture.expected.milestones 必须是数组');
  }

  for (let i = 0; i < fixture.epochs.length; i++) {
    validateEpoch(fixture.epochs[i], i);
  }

  const seenCommandIds = new Set<string>();
  for (let i = 0; i < fixture.commands.length; i++) {
    const cmd = fixture.commands[i];
    if (!cmd || typeof cmd.commandId !== 'string' || cmd.commandId.length === 0) {
      throw new FixtureValidationError(
        `commands[${i}].commandId 必须是非空字符串`,
      );
    }
    if (seenCommandIds.has(cmd.commandId)) {
      throw new FixtureValidationError(
        `commands[${i}].commandId 重复：「${cmd.commandId}」`,
      );
    }
    seenCommandIds.add(cmd.commandId);
  }

  for (let i = 0; i < fixture.expected.milestones.length; i++) {
    const m = fixture.expected.milestones[i];
    if (
      !m ||
      typeof m.kind !== 'string' ||
      !VALID_MILESTONE_KINDS.has(m.kind as MilestoneKind)
    ) {
      throw new FixtureValidationError(
        `expected.milestones[${i}].kind 非法：「${m?.kind}」`,
      );
    }
  }
}

function validateEpoch(ep: CombatFixture['epochs'][number], index: number): void {
  if (!ep || !Array.isArray(ep.dice) || ep.dice.length !== 60) {
    throw new FixtureValidationError(
      `epoch[${index}].dice 必须恰好 60 个整数（实际 ${
        Array.isArray(ep?.dice) ? ep.dice.length : '非数组'
      }）`,
    );
  }
  for (let d = 0; d < ep.dice.length; d++) {
    const value = ep.dice[d];
    if (!Number.isInteger(value) || value < 1 || value > 20) {
      throw new FixtureValidationError(
        `epoch[${index}].dice[${d}] 必须是 1..20 整数（实际 ${value}）`,
      );
    }
  }
  for (const ch of CHANNEL_ORDER) {
    const actual = ep.channelSplit[ch];
    if (actual !== DEFAULT_CHANNEL_SPLIT[ch]) {
      throw new FixtureValidationError(
        `epoch[${index}].channelSplit.${ch} 必须为 ${DEFAULT_CHANNEL_SPLIT[ch]}（M0 只支持默认预算，实际 ${actual}）`,
      );
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 骰带构建
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 把 fixture.epochs 的原始 60 颗骰序列逐个切分并构造 DiceTapeState。
 *
 * 第一个 epoch 用 createTape，后续用 beginEpoch（旧 epoch 归档进 exhausted）。
 * 验证骰带可建（A0-8 前置）——如果 splitSixty/createTape 抛错，说明 fixture
 * 的 dice 或 channelSplit 有问题。
 */
function buildTape(
  epochs: readonly CombatFixture['epochs'][number][],
): DiceTapeState {
  let tape: DiceTapeState | null = null;
  for (const ep of epochs) {
    const channels = splitSixty([...ep.dice]);
    const epoch: DiceEpoch = {
      outputId: ep.outputId,
      batchHash: '', // M0 不计算；M4 冻结 eventHash 时由 reducer 补 batchHash
      channels,
      cursors: zeroCursors(),
    };
    tape = tape === null ? createTape(epoch) : beginEpoch(tape, epoch);
  }
  // validateFixture 已保证 epochs.length >= 1
  return tape as DiceTapeState;
}

function zeroCursors(): Readonly<Record<DiceChannel, number>> {
  return {
    attackHit: 0,
    initiative: 0,
    intentCheck: 0,
    statusContest: 0,
    procCheck: 0,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 稳定 hash
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 基于 fixture 核心字段计算稳定 hash。
 *
 * 只取 id/bundle/epochs/commands/expected，**忽略** fixture 顶层的元数据字段
 *（_synthetic / _provenance 等），保证 hash 只反映战斗定义本身。
 *
 * 用 djb2（确定性字符串哈希）。M0 不需要密码学强度；M4 eventHash 会改基于
 * DomainEvent 序列的强哈希。
 */
function hashFixture(fixture: CombatFixture): string {
  const canonical = canonicalStringify({
    id: fixture.id,
    bundle: fixture.bundle,
    epochs: fixture.epochs.map(ep => ({
      outputId: ep.outputId,
      dice: [...ep.dice],
      channelSplit: ep.channelSplit,
    })),
    commands: fixture.commands,
    expected: {
      milestones: fixture.expected.milestones,
      eventHash: fixture.expected.eventHash,
    },
  });
  return 'm0_' + (djb2(canonical) >>> 0).toString(36);
}

/**
 * 规范化序列化：对象 key 字典序排序、数组保序。保证同结构对象产出相同字符串。
 */
function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number' || t === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .map(k => JSON.stringify(k) + ':' + canonicalStringify(obj[k]))
      .join(',') +
    '}'
  );
}

/**
 * djb2 字符串哈希。经典确定性算法，位运算 + charCodeAt，零外部依赖。
 */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h;
}
