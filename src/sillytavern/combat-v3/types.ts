/**
 * combat-v3/types.ts — 战斗 v3 内部类型（M0 部分）
 *
 * 仅落 M0 骰带核心需要的类型，其余（CombatState / CombatPhase / ResolutionFrame /
 * JournalEntry / EffectIntent / DomainEvent 等）由 M1 起补全。
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md
 *   - DiceChannel / DiceEpoch / DiceTapeState —— §四 4.2
 *   - DEFAULT_CHANNEL_SPLIT                  —— §四 4.3（D6 决策）
 *   - CombatProvenance                       —— §四 4.6
 *
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md
 *   - CombatFixture / Milestone —— §2.3
 *   - CombatCommandKind          —— §2.2 引用架构 §二 2.2
 */

// ──────────────────────────────────────────────────────────────────────────────
// DiceChannel
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 骰带通道枚举。
 *
 * 通道隔离的原因（架构 §四 4.1）：单一 cursor 会令概率召唤、反伤命中等"额外骰"
 * 把整场后续命中结果整体错位，导致 replay 无法对齐真实样本。
 *
 * 枚举顺序与通道预算表（架构 §四 4.3）一一对应。
 */
export type DiceChannel =
  'initiative' | 'attackHit' | 'statusContest' | 'procCheck' | 'intentCheck';

/**
 * 60 颗 d20 的默认分通道预算（架构 §四 4.3，决策 D6）。
 *
 * 实测来源：5 场真实样本聚合统计 attackHit 57% / initiative 18% /
 * intentCheck 11% / statusContest 10% / procCheck 4%。低频通道向上取整到 5 颗地板，
 * 超出额度从最高频通道 attackHit 扣，合计恰好 60。
 *
 * 顺序由高到低排列以便 splitSixty 按此顺序切片。
 */
export const DEFAULT_CHANNEL_SPLIT: Readonly<Record<DiceChannel, number>> = {
  attackHit: 32,
  initiative: 10,
  intentCheck: 7,
  statusContest: 6,
  procCheck: 5,
};

/**
 * splitSixty 的切分顺序：与 DEFAULT_CHANNEL_SPLIT 一致（attackHit 在前）。
 * 暴露为常量数组便于遍历时保证确定性。
 */
export const CHANNEL_ORDER: readonly DiceChannel[] = [
  'attackHit',
  'initiative',
  'intentCheck',
  'statusContest',
  'procCheck',
] as const;

// ──────────────────────────────────────────────────────────────────────────────
// DiceEpoch / DiceTapeState
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 单个 epoch：一次正文输出对应的 60 颗 d20，已按通道预算切分。
 *
 * channels 与 cursors 的字段顺序遵循 DEFAULT_CHANNEL_SPLIT（架构 §四 4.2）。
 * 各通道的 dice 数组**必须**与 DEFAULT_CHANNEL_SPLIT 对应值等长，
 * 否则 createTape 抛错（验收 A0-4）。
 *
 * cursors 是各通道已消费到第几颗（0-based）。draw 只推进**目标通道**的 cursor，
 * 其余通道完全不变（验收 A0-1）。
 */
export interface DiceEpoch {
  /** 对应一次正文输出的 id（供 provenance 追溯，架构 §四 4.4） */
  outputId: string;
  /** 60 颗骰的内容哈希（用于 replay 对齐，架构 §四 4.6） */
  batchHash: string;
  /** 按通道预算切分后的 60 颗骰 */
  channels: Readonly<Record<DiceChannel, readonly number[]>>;
  /** 各通道消费游标（0-based） */
  cursors: Readonly<Record<DiceChannel, number>>;
}

/**
 * 骰带状态：当前 epoch + 已归档的耗尽 epoch。
 *
 * beginEpoch 后旧 epoch 进 exhausted[]，各通道 cursor 归 0，
 * 旧余骰不可再取（架构 §四 4.4，验收 A0-3）。
 */
export interface DiceTapeState {
  /** 第几次续杯（0 = 首次，即 current 是第一个 epoch） */
  epochSeq: number;
  /** 当前 epoch */
  current: DiceEpoch;
  /** 已作废的历史 epoch（仅供 replay / 审计，不可再取骰） */
  exhausted: readonly DiceEpoch[];
}

// ──────────────────────────────────────────────────────────────────────────────
// CombatProvenance（架构 §四 4.6）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 一条 epoch 的最终游标快照，落入 provenance 供 replay 校验。
 */
export interface ProvenanceDiceEpoch {
  outputId: string;
  batchHash: string;
  finalCursors: Readonly<Record<DiceChannel, number>>;
}

/**
 * 战斗 provenance：用于 replay 对齐与审计。
 *
 * replay 语义（D5）：同 bundleHash + 同 DiceTape（各 epoch batchHash 序列一致） +
 * 同 Command 序列 ⇒ DomainEvent 序列 hash 一致。
 */
export interface CombatProvenance {
  /** 引擎版本，如 'v3' */
  engineVersion: string;
  /** EffectIntent / DomainEvent schema 版本 */
  schemaVersion: string;
  /** 数值规则版本（层级系数表等） */
  rulesetRevision: string;
  /** CombatDefinitionBundle 内容哈希 */
  bundleHash: string;
  /** 已产出 DomainEvent 数 */
  eventSequence: number;
  /** 各 epoch 的最终游标快照 */
  diceEpochs: readonly ProvenanceDiceEpoch[];
}

// ──────────────────────────────────────────────────────────────────────────────
// CombatCommandKind（架构 §二 2.2 全集）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Command 的全部 kind（架构 §二 2.2 表）。
 *
 * M0 不需要全部用到，但类型必须先冻结（plan §0.4 R3）。
 */
export type CombatCommandKind =
  | 'DeclareAttack'
  | 'DeclareAction'
  | 'DeclareBlock'
  | 'Flee'
  | 'PassAttack'
  | 'PassAction'
  | 'Choose'
  | 'Adjudicate'
  | 'SupplyDice'
  | 'SupplyUnit'
  | 'AcceptSurrender'
  | 'Capture'
  | 'RequestSettlement';

/**
 * CombatCommand 的行动槽成本（架构 §二 2.2）。
 */
export type CommandCost = 'attack' | 'action' | 'both' | 'none';

// ──────────────────────────────────────────────────────────────────────────────
// CombatFixture（plan §2.3 冻结格式）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * fixture 内参战单位的最小快照。
 * M0 不需要完整 CharacterState，只保留 milestone 断言需要的字段。
 */
export interface FixtureUnit {
  /** 角色名（逻辑键，铁律 ①） */
  name: string;
  /** 层级 1-7 */
  tier: number;
  /** 当前 HP */
  hp: number;
  /** 最大 HP */
  maxHp: number;
  /** 当前 MP */
  mp?: number;
  /** 最大 MP */
  maxMp?: number;
  /** 当前 SP */
  sp?: number;
  /** 最大 SP */
  maxSp?: number;
  /** 五维（力量/敏捷/体质/智力/感知），可选 */
  attributes?: Readonly<Record<string, number>>;
  /** 装备名列表（逻辑键） */
  equipment?: readonly string[];
  /** 技能名列表（逻辑键） */
  skills?: readonly string[];
  /** 登神强度 0-8（v2 §四 4.2） */
  divinity?: number;
  /** 集群数量（v2 §六 6.x，第 07 场用，M4 补正式字段） */
  clusterCount?: number;
}

/**
 * CombatDefinitionBundle 的 fixture 子集。
 * M0 不需要 programs（EffectProgram M3 起填）。
 */
export interface FixtureBundle {
  /** 战斗 id（fixture 内唯一） */
  combatId: string;
  /** 战斗类型：标准 / 遭遇 / 伏击 / 围攻（v2 §九 9.5 战意阈值） */
  combatType: string;
  /** 参战单位快照 */
  units: readonly FixtureUnit[];
  /** 编译后的 EffectAutomaton[]；M0 留空数组，M3 起填 */
  programs: readonly unknown[];
  /** 战斗开始时的 FP 快照（架构 §十二 12.2） */
  resourceSnapshots: { FP: number };
  /** 数值规则版本 */
  rulesetRevision: string;
}

/**
 * fixture 内单个 epoch 的定义（plan §2.3）。
 *
 * dice 是 60 个 1..20 的整数原始序列，由 splitSixty 按 channelSplit 切分。
 */
export interface FixtureEpoch {
  /** 输出 id */
  outputId: string;
  /** 恰好 60 个 1..20 的整数 */
  dice: readonly number[];
  /** 分通道预算，默认 DEFAULT_CHANNEL_SPLIT */
  channelSplit: Readonly<Record<DiceChannel, number>>;
}

/**
 * fixture 内的单条 Command（plan §2.3）。
 *
 * payload 按 kind 定型，M0 不做精确收窄（用 unknown + M1 起补联合）。
 */
export interface FixtureCommand {
  /** 幂等键 */
  commandId: string;
  /** 乐观并发：对应 dispatch 前的 revision */
  expectedRevision: number;
  /** Command 类型（架构 §二 2.2） */
  kind: CombatCommandKind;
  /** 执行单位（用名字寻址，铁律 ①） */
  actorId: string;
  /** 行动槽成本 */
  cost: CommandCost;
  /** 按 kind 定型的载荷 */
  payload: unknown;
}

/**
 * Milestone 的 kind 枚举（plan §2.3）。
 *
 * M0 定，后续只加不改。
 */
export type MilestoneKind =
  | 'damage'
  | 'reflected'
  | 'prevented'
  | 'statusApplied'
  | 'moraleChanged'
  | 'summoned'
  | 'terminal'
  | 'fpDelta'
  | 'roundCount';

/**
 * 单个 milestone 断言（plan §2.3 expected.milestones[]）。
 *
 * 字段是各 kind 的并集，运行时按 kind 取对应字段。
 * 使用 unknown 保留扩展性，M1 起可改为判别联合。
 */
export interface Milestone {
  /** milestone 类型 */
  kind: MilestoneKind;
  /** 该 milestone 对应的 commandId（at 在 plan §2.3 示例中出现） */
  at?: string;
  /** 目标单位名（damage/statusApplied 用） */
  targetId?: string;
  /** 数值（伤害量 / FP 变动 / 回合数等） */
  value?: number;
  /** 容差（数值断言的 ±，默认 0） */
  tolerance?: number;
  /** 反射链根 commandId（reflected 用） */
  rootChainId?: string;
  /** 反射深度（reflected 用） */
  depth?: number;
  /** 终局原因（terminal 用，如 'hp_zero' / 'force_terminal'） */
  reason?: string;
  /** 胜方（terminal 用） */
  winner?: string;
  /** 状态 id（statusApplied 用） */
  statusId?: string;
}

/**
 * fixture 的 expected 段（plan §2.3）。
 */
export interface FixtureExpected {
  /** milestone 断言列表 */
  milestones: readonly Milestone[];
  /**
   * DomainEvent 序列哈希。
   * M0-M3 为 null（只断言 milestone）；M4 各场稳定后冻结为字符串。
   */
  eventHash: string | null;
}

/**
 * CombatFixture：M0 冻结的 replay 输入格式（plan §2.3）。
 *
 * 一条 fixture = bundle + epochs + commands + expected milestones。
 * replayCombat(fixture) 是纯函数（验收 A0-5），不产生任何 DB/store 副作用。
 */
export interface CombatFixture {
  /** fixture 唯一 id，如 'case-24-reflection' */
  id: string;
  /** 来源案例文档路径 */
  sourceCase: string;
  /** 战斗定义 bundle */
  bundle: FixtureBundle;
  /** 按消费顺序排列的 epoch 列表（跨 epoch 续杯的场次有多个） */
  epochs: readonly FixtureEpoch[];
  /** 按提交顺序排列的 Command 列表 */
  commands: readonly FixtureCommand[];
  /** 期望的 milestone 断言 */
  expected: FixtureExpected;
}
