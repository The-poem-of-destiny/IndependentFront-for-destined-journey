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

// ──────────────────────────────────────────────────────────────────────────────
// M1 模块头部引入
// ──────────────────────────────────────────────────────────────────────────────

import type {
  CombatParticipant,
  CombatType,
  DamageType,
  IntentionLevel,
  MoraleState,
  StatusEffect,
} from '../types';

export type {
  CombatParticipant,
  CombatType,
  DamageType,
  IntentionLevel,
  MoraleState,
  StatusEffect,
};

// ──────────────────────────────────────────────────────────────────────────────
// 状态机（架构 §二 2.4 + plan §3.3 推进表）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 状态机 phase 枚举（原版状态机，架构 §二 2.4）。
 *
 * 推进表见 plan §3.3：每行「当前 phase → 触发 → 下一 phase」落成数据 reducer.ts 内。
 */
export type CombatPhase =
  | 'CombatOpen'
  | 'RoundOpen'
  | 'Initiative'
  | 'UnitTurnOpen'
  | 'SlotConsume'
  | 'MoraleCheck'
  | 'UnitTurnClose'
  | 'RoundClose'
  | 'Terminal'
  | 'SettlementCommitted';

// ──────────────────────────────────────────────────────────────────────────────
// CombatUnitState（架构 §三 3.1 units 值）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 战斗内单位的完整状态。与根类型 CombatParticipant 的区别：CombatUnitState 随
 * 战斗自身的 buff tick / 槽位消费 / HP 改动进行变化，是 CombatState.units 的值。
 *
 * 字段与根 CombatParticipant 对齐（五维/资源/防御/修正），另加：
 *   - 行动槽独立引用（attacksRemaining / actionsRemaining），不散落在 TurnOrder
 *   - statusEffects 为战斗内 buff 的唯一真源（架构 §三 3.1，取代 v2 的多状态源）
 *   - ability 字段：攻击计算所需的关联属性 / 伤害类型 / 意图系数等信息，
 *     M1 用最小集（关联属性值 + 技能威力 + 武器攻击力 + 伤害类型 + 意图层级）
 */
export interface CombatUnitState {
  /** 单位 id（角色名，逻辑键，铁律 ①） */
  id: string;
  /** 展示名 */
  name: string;
  /** 阵营：'player' / 'enemy'（映射自根 CombatParticipant.side） */
  side: 'player' | 'enemy';
  /** 生命层级 1-7 */
  tier: number;
  /** 等级 1-25 */
  level: number;
  /** 五维（战斗中的"最终"值） */
  attributes: { str: number; dex: number; con: number; int: number; spi: number };
  /** 资源 */
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  sp: number;
  maxSp: number;
  /** 防御 */
  defense: number;
  /** DR（百分比 0~1） */
  dr: number;
  /** 穿透（百分比 0~1） */
  penetration: number;
  /** 命中加值 */
  hitBonus: number;
  /** 闪避加值 */
  dodgeBonus: number;
  /** 速度修正（百分比列表，多来源取最高） */
  speedModifiers: number[];
  /** 固定先攻修正 */
  fixedInitiativeBonus: number;
  /** 武器攻击力 */
  weaponAtk: number;
  /** 是否可行动（战意/禁制状态决定） */
  canAct: boolean;
  /** 战意状态 */
  morale: MoraleState;
  /** 当前回合可用的攻击槽（内核强制：canAct && hp>0 才发满，M-3） */
  attacksRemaining: number;
  /** 当前回合可用的动作槽（同上） */
  actionsRemaining: number;
  /** 战斗内 buff 列表（唯一真源） */
  statusEffects: StatusEffect[];
  /** 攻击需要的计算字段（M1 最小集）。关联属性 / 技能威力等由 bundle 注入 */
  ability?: {
    /** 关联属性值（伤害公式里的"属性×10×系数"） */
    relevantAttribute: number;
    /** 技能威力 */
    skillPower: number;
    /** 伤害类型（中文联合） */
    damageType: DamageType;
    /** 使用的意图层级（Agent 判定） */
    intentionLevel: IntentionLevel;
    /** 多段攻击次数 */
    multiHitCount: number;
    /** 登神强度 0-8（v2 §四 4.2） */
    divinity: number;
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// CombatState（架构 §三 3.1）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 战斗唯一权威状态（架构 §一 1.2 P1）。
 *
 * 所有战斗变化（HP/MP/SP/状态/槽位/先攻）只存在于这一个对象内；终局一次落库。
 * revision 单调递增（架构 §三 3.2）；applyPending 是唯一写入函数（state.ts）。
 */
export interface CombatState {
  /** 战斗 id */
  combatId: string;
  /** 已提交版本号，乐观并发键 */
  revision: number;
  /** 当前状态机 phase */
  phase: CombatPhase;
  /** 当前回合数（1-based） */
  round: number;
  /** 本回合先攻序列（按先后顺序指向各单位 id） */
  initiativeOrder: readonly string[];
  /** 当前先攻序列游标（正在行动的单位索引） */
  currentTurnIndex: number;
  /** 在场单位（id → 状态），唯一权威 */
  units: Readonly<Record<string, CombatUnitState>>;
  /** 战斗内效果索引（M1 恒空，windows 空转） */
  activeEffects: ActiveEffectIndex;
  /** 骰带 */
  dice: DiceTapeState;
  /** 存档级资源快照（FP 唯一权威，架构 §十二） */
  resourceSnapshots: { FP: number };
  /** 中断续跑帧（ResolveChoice / BeginOutput 用） */
  resolution?: ResolutionFrame;
  /** 只追加变更日志（架构 §三 3.4） */
  journal: readonly JournalEntry[];
  /** 战斗 provenance */
  provenance: CombatProvenance;
  /** 终局原因（进 Terminal 相位时设定） */
  terminal?: { reason: TerminalReason; winner?: string };
  /** settlement 幂等键（架构 §三 3.5 不变量⑤） */
  settlementId?: string;
  /** 已冻结的 settlement 结果（C3：同 id 二次调用返回既有结果） */
  settlement?: SettlementResult;
}

/**
 * CombatState 的只读脱敏投影（架构 §三 3.1）。
 *
 * UI 与 Agent prompt 只看 View，永远拿不到可变引用（state.ts toView 深脱敏）。
 * 结构尽量扁平，不含 pendingChanges / journal 内部细节。
 */
export interface CombatView {
  combatId: string;
  revision: number;
  phase: CombatPhase;
  round: number;
  initiativeOrder: readonly string[];
  currentTurnIndex: number;
  units: Readonly<Record<string, CombatUnitView>>;
  resourceSnapshots: { FP: number };
  terminal?: { reason: TerminalReason; winner?: string };
}

/** CombatView 内的单位投影（不含 journal / 内部能力细节） */
export interface CombatUnitView {
  id: string;
  name: string;
  side: 'player' | 'enemy';
  tier: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  sp: number;
  maxSp: number;
  attacksRemaining: number;
  actionsRemaining: number;
  canAct: boolean;
  morale: MoraleState;
  statusEffects: readonly StatusEffect[];
}

// ──────────────────────────────────────────────────────────────────────────────
// PendingChangeSet（不变量④，架构 §三 3.5 ④）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 一次 Command 的待提交变更集。
 *
 * 微步骤只往 pendingChanges 追加（不写 state），Command 末尾 applyPending 一次原子提交。
 * 类型用判别式 resourceChanges 收敛的联合，便于 state.ts 一次性校验并应用。
 */
export type PendingChangeSet = {
  /** HP 变化（正=治疗 / 负=伤害；applyPending 会对 hp 做 [0, maxHp] clamp） */
  hpChanges: Record<string, number>;
  /** MP 变化 */
  mpChanges: Record<string, number>;
  /** SP 变化 */
  spChanges: Record<string, number>;
  /** FP 变化（存档级，settlement 才落库） */
  fpDelta: number;
  /** buff 施加/移除（phases 构建时用可变数组 push，只读消费在 applyPending） */
  statusPatches: StatusPatch[];
  /** 行动槽消费（消费后 attacksRemaining / actionsRemaining 递减） */
  slotConsumptions: { actorId: string; slot: 'attack' | 'action' }[];
  /** 回合开始时给单位发槽（M-3：只给 canAct && hp>0 的单位发满，其余发 0） */
  turnOpenSlots?: { actorId: string; attacks: number; actions: number }[];
  /** 终局触发（checkTerminal 在 phases/terminal.ts 内应用） */
  terminal?: { reason: TerminalReason; winner?: string };
};

/** buff 施加/移除补丁（状态字段规范） */
export type StatusPatch =
  | { op: 'apply'; unitId: string; status: StatusEffect }
  | { op: 'remove'; unitId: string; statusId: string };

/** 空变更集（纯工具常量） */
export const EMPTY_CHANGES: PendingChangeSet = {
  hpChanges: {},
  mpChanges: {},
  spChanges: {},
  fpDelta: 0,
  statusPatches: [],
  slotConsumptions: [],
};

/** 初始化一个空 PendingChangeSet（供 phases 起步） */
export function emptyChanges(): PendingChangeSet {
  return {
    hpChanges: {},
    mpChanges: {},
    spChanges: {},
    fpDelta: 0,
    statusPatches: [],
    slotConsumptions: [],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// JournalEntry（架构 §三 3.4）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 战斗内只追加变更日志条目。
 *
 * 用途：离线 replay / 幂等防重 / 审计 / 恢复（架构 §三 3.4）。
 */
export type JournalEntryKind = 'command' | 'settlement' | 'provenance';

export interface JournalEntry {
  /** 单调递增序号（追加序） */
  seq: number;
  /** 触发源 commandId */
  commandId: string;
  /** 条目类型 */
  kind: JournalEntryKind;
  /** 变更描述（审计用） */
  payload: string;
  /** FP diff 等跨边界操作的幂等键（settlement 用） */
  idempotencyKey?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// RequiredInput（架构 §二 2.3 五型 + plan §3 验收）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 下一步需要的外部输入。dispatch 同步自动推进到出现 RequiredInput 才返回。
 *
 * M1 需要 PlayerCommand 与（骰带耗尽时）BeginOutput。其余 M2+ 才触发，类型先冻结。
 */
export type RequiredInput =
  | { kind: 'PlayerCommand'; unitId: string; unitName: string; round: number }
  | { kind: 'EffectChoice' }
  | { kind: 'BoundedAdjudication' }
  | { kind: 'BeginOutput'; channel: DiceChannel }
  | { kind: 'CharGenRequest' };

// ──────────────────────────────────────────────────────────────────────────────
// CombatCommand / CommandRejection / CombatTransition
// ──────────────────────────────────────────────────────────────────────────────

/**
 * CombatCommand 的载荷（按 kind 定型）。
 *
 * 判别联合：kind 作 discriminant。payload 由 kernel/reducer 按 kind 消费。
 */
export type CombatCommand =
  | {
      commandId: string;
      expectedRevision: number;
      kind: 'DeclareAttack';
      actorId: string;
      cost: 'attack';
      payload: {
        targetId: string;
        skill?: string;
        intentionLevel: IntentionLevel;
        nonLethal?: boolean;
        damageType?: DamageType;
        ability?: CombatUnitState['ability'];
        /** 本次攻击的资源消耗（M-9：攻方 MP/SP 与守方 HP 同批提交） */
        costs?: { mp?: number; sp?: number };
      };
    }
  | {
      commandId: string;
      expectedRevision: number;
      kind: 'DeclareAction';
      actorId: string;
      cost: 'action';
      payload: { actionType: 'item' | 'move' | 'focus' | 'defend'; description?: string };
    }
  | {
      commandId: string;
      expectedRevision: number;
      kind: 'DeclareBlock';
      actorId: string;
      cost: 'action';
      payload: { choiceId?: string };
    }
  | {
      commandId: string;
      expectedRevision: number;
      kind: 'Flee';
      actorId: string;
      cost: 'both';
      payload: Record<string, never>;
    }
  | {
      commandId: string;
      expectedRevision: number;
      kind: 'PassAttack';
      actorId: string;
      cost: 'attack';
      payload: Record<string, never>;
    }
  | {
      commandId: string;
      expectedRevision: number;
      kind: 'PassAction';
      actorId: string;
      cost: 'action';
      payload: Record<string, never>;
    }
  | {
      commandId: string;
      expectedRevision: number;
      kind: 'Choose';
      actorId: string;
      cost: 'none';
      payload: { choiceId: string; option?: string };
    }
  | {
      commandId: string;
      expectedRevision: number;
      kind: 'Adjudicate';
      actorId: string;
      cost: 'none';
      payload: unknown;
    }
  | {
      commandId: string;
      expectedRevision: number;
      kind: 'SupplyDice';
      actorId: string;
      cost: 'none';
      payload: {
        outputId: string;
        dice: readonly number[];
        channelSplit?: Partial<Record<DiceChannel, number>>;
      };
    }
  | {
      commandId: string;
      expectedRevision: number;
      kind: 'SupplyUnit';
      actorId: string;
      cost: 'none';
      payload: unknown;
    }
  | {
      commandId: string;
      expectedRevision: number;
      kind: 'AcceptSurrender';
      actorId: string;
      cost: 'action';
      payload: Record<string, never>;
    }
  | {
      commandId: string;
      expectedRevision: number;
      kind: 'Capture';
      actorId: string;
      cost: 'action';
      payload: Record<string, never>;
    }
  | {
      commandId: string;
      expectedRevision: number;
      kind: 'RequestSettlement';
      actorId: string;
      cost: 'none';
      payload: { settlementId: string };
    };

/**
 * 命令被拒：零状态变化、零骰子消费、零 DomainEvent（架构 §二 2.2 拒绝语义）。
 */
export interface CommandRejection {
  /** 拒绝码 */
  code:
    'INVALID_PHASE' | 'STALE_REVISION' | 'TARGET_NOT_PRESENT' | 'SLOT_EXHAUSTED' | 'UNKNOWN_KIND';
  /** 人类可读原因 */
  message: string;
}

/**
 * 一次 dispatch 的返回（架构 §二 2.1）。
 */
export interface CombatTransition {
  /** 提交后的状态版本号（单调递增） */
  revision: number;
  /** 只读投影（UI / Agent prompt 用） */
  snapshot: Readonly<CombatView>;
  /** 本次提交产生的既成事实事件 */
  events: readonly DomainEvent[];
  /** 下一步需要的外部输入（无则继续 dispatch） */
  requiredInput?: RequiredInput;
  /** 命令被拒（此时 events 空、骰子零消费） */
  rejection?: CommandRejection;
  /** 命令是否被幂等重放（同 commandId 二次 dispatch） */
  replayed?: boolean;
  /** 终局原因（进 Terminal / settlement 后非空） */
  terminal?: { reason: TerminalReason; winner?: string };
  /**
   * 内部字段：reducer 提交后的完整不可变 CombatState（authoritative）。
   * 仅 kernel 消费（驱动后续 dispatch）；对外调用方只看 snapshot 投影。
   */
  next?: CombatState;
}

// ──────────────────────────────────────────────────────────────────────────────
// CombatSession（架构 §二 2.1）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * CombatSession：内核外壳（kernel.ts createSession）。
 *
 * - dispatch(command)：唯一入口，同步自动推进（P2 单一入口）
 * - snapshot()：当前只读投影
 * - history：已提交的 transition 序列（可追溯）
 * - completed：是否已进入终局（Terminal / SettlementCommitted）
 */
export interface CombatSession {
  dispatch(command: CombatCommand): CombatTransition;
  snapshot(): Readonly<CombatView>;
  readonly history: readonly CombatTransition[];
  readonly completed: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// CombatDefinitionBundle（createCombatState 入参）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 战斗定义包：openCombat 时从参战单位快照 + 编译结果构造。
 *
 * units 是根类型 CombatParticipant[]（跨模块共享实体类型，不重复定义）；
 * 由 state.ts createCombatState 转成 CombatUnitState[] 进 CombatState.units。
 */
export interface CombatDefinitionBundle {
  /** 战斗 id */
  combatId: string;
  /** 战斗类型（中文联合，校验进 checkMorale） */
  combatType: CombatType;
  /** 参战单位（根 CombatParticipant[]） */
  participants: readonly CombatParticipant[];
  /** 战斗内技能/职业能力定义（供 attack 取 ability 字段；M1 最小集可空） */
  skills?: Readonly<Record<string, { ability: CombatUnitState['ability'] }>>;
  /** 数值规则版本 */
  rulesetRevision: string;
  /** 战斗开始时的 FP 快照（架构 §十二 12.2） */
  resourceSnapshots: { FP: number };
}

// ──────────────────────────────────────────────────────────────────────────────
// TerminalReason（plan §3 M1 四出口 + 架构 §二）
// ──────────────────────────────────────────────────────────────────────────────

/** 终局四出口（M1）：HP 全灭 / 士气溃逃 / 逃跑成功 / 强制终局 */
export type TerminalReason = 'hp_zero' | 'morale_routed' | 'flee_success' | 'force_terminal';

// ──────────────────────────────────────────────────────────────────────────────
// SettlementResult（C3 幂等）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * settlement 结果（C3：同 settlementId 幂等，不产生第二套 EXP/FP）。
 *
 * M1 只计算 FP 净变动（EXP/战利品由 M2+ settlement.before 窗口/coordinator 补）。
 */
export interface SettlementResult {
  /** 幂等键 */
  settlementId: string;
  /** FP 净变动（snapshot.FP − 初始 FP，架构 §十二 12.2） */
  fpDelta: number;
  /** 终局原因 */
  reason: TerminalReason;
  /** 胜方（可选） */
  winner?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// DomainEvent（架构 §十三 13.3，M1 子集 12 个）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * DomainEvent：描述已提交的事实，不可修改、不能推进流程（架构 §十三 13.3）。
 *
 * M1 只需要 12 个；其余（UnitSummoned / DamageReflected / AdjudicationAccepted 等）
 * M3+/M3.5 补。判别联合，kind 作 discriminant。
 */
export type DomainEvent =
  | {
      kind: 'CombatOpened';
      combatId: string;
      combatType: CombatType;
      unitIds: readonly string[];
      bundleHash: string;
    }
  | { kind: 'RoundOpened'; round: number }
  | {
      kind: 'InitiativeRolled';
      round: number;
      order: readonly { unitId: string; value: number; roll: number }[];
    }
  | {
      kind: 'TurnOpened';
      unitId: string;
      attacksRemaining: number;
      actionsRemaining: number;
    }
  | {
      kind: 'TurnClosed';
      unitId: string;
      attacksConsumed: number;
      actionsConsumed: number;
    }
  | { kind: 'RoundClosed'; round: number }
  | { kind: 'CombatEnded'; reason: TerminalReason; winner?: string }
  | {
      kind: 'AttackDeclared';
      attackerId: string;
      targetId: string;
      skill?: string;
      intentionLevel: IntentionLevel;
    }
  | {
      kind: 'AttackResolved';
      attackerId: string;
      targetId: string;
      checkValue: number;
      rating: string;
      hit: boolean;
      dice: readonly number[];
    }
  | {
      kind: 'DamageApplied';
      attackerId: string;
      targetId: string;
      preReduction: number;
      postStep6: number;
      final: number;
      damageType: DamageType;
      targetHpBefore: number;
      targetHpAfter: number;
    }
  | { kind: 'HpFloored'; unitId: string; hp: number }
  | { kind: 'UnitDowned'; unitId: string; hp: number }
  | { kind: 'UnitDefeated'; unitId: string; winnerSide?: 'player' | 'enemy' }
  | {
      kind: 'StatusApplied';
      unitId: string;
      statusId: string;
      stacks: number;
      duration: number | null;
    }
  | { kind: 'StatusRemoved'; unitId: string; statusId: string }
  | { kind: 'StatusExpired'; unitId: string; statusId: string }
  | {
      kind: 'ResourceSpent';
      unitId: string;
      /** 资源类型（HP/MP/SP/FP），注意与判别字段 kind 不同名 */
      resource: 'hp' | 'mp' | 'sp' | 'fp';
      amount: number;
    }
  | {
      kind: 'MoraleChanged';
      unitId: string;
      threshold: number;
      roll: number;
      state: MoraleState;
    }
  | { kind: 'NarrativeCue'; text: string; severity?: number }
  | { kind: 'FleeAttempt'; unitId: string; success: boolean; roll: number }
  // ─────────────────────────────────────────────────────────────
  // M2 扩展：投影 A（projection-ui）需要给 29 个 DomainEvent 全量建映射目标（A2-6），
  // 故先把 M1 之外的 v3 新增 + settlement 事件补全为结构占位。
  // 运行时只有 M1 已实现 + 部分会在 v3 路径出现；其余待 M3/M3.5 实装时填充字段。
  // ─────────────────────────────────────────────────────────────
  | {
      kind: 'SettlementCommitted';
      settlementId: string;
      fpDelta: number;
      reason: TerminalReason;
      winner?: string;
      exp?: number;
    }
  | {
      kind: 'UnitSummoned';
      unitId: string;
      joinTiming?: string;
      duration?: number | null;
      sourceItem?: string;
    }
  | { kind: 'UnitDespawned'; unitId: string; reason?: 'expired' | 'active' | 'summoner_down' }
  | { kind: 'DamagePrevented'; unitId: string; amount: number; keptHp: number }
  | {
      kind: 'DamageReflected';
      rootChainId: string;
      depth: number;
      base: number;
      amount: number;
    }
  | { kind: 'MiracleTriggered'; effectDescription?: string; divinity: number; payload?: unknown }
  | {
      kind: 'AdjudicationAccepted';
      ruleKey?: string;
      divinity: number;
      reason?: string;
      effectDescription?: string;
    }
  | { kind: 'RuleOverridden'; ruleKey: string; payload?: unknown; divinity: number }
  | { kind: 'EffectRejected'; automatonId?: string; window?: string; code: string; detail: string }
  | { kind: 'DiceEpochBegan'; outputId: string; batchHash?: string; channelSplit?: unknown };

// ──────────────────────────────────────────────────────────────────────────────
// ReactionWindow（架构 §五 5.1，M1 枚举冻结；M1 空转，M3 实装）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * ReactionWindow 清单（架构 §五 5.1，18 个 typed window）。
 * M1 全部空转（evaluateWindow 返回空数组），但窗口枚举与调用点必须冻结。
 */
export type WindowKey =
  | 'round.open'
  | 'round.close'
  | 'initiative.before'
  | 'initiative.after'
  | 'turn.open'
  | 'turn.close'
  | 'action.declared'
  | 'check.intent'
  | 'check.hit'
  | 'collect_attacker_mods'
  | 'collect_defender_mods'
  | 'damage.preview'
  | 'damage.compute'
  | 'damage.after'
  | 'unit.beforeDown'
  | 'morale.before'
  | 'morale.after'
  | 'settlement.before';

// ──────────────────────────────────────────────────────────────────────────────
// ActiveEffectIndex（架构 §五 5.3 + §七 7.5）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 每窗口排序后的 automaton 队列（M1 恒空数组）。
 * 用于 evaluateWindow 的求值排序与在场过滤。
 */
export interface QueuedAutomaton {
  id: string;
  owner: string;
  divinity: number;
  priority: number;
  source: string;
}

/**
 * 战斗内效果索引（架构 §七 7.5）。M1 恒空，M3 由 buildIndex 派生填充。
 */
export interface ActiveEffectIndex {
  /** 每窗口已排序 automaton 列表 */
  byWindow: Readonly<Record<WindowKey, readonly QueuedAutomaton[]>>;
  /** 每持有者持有的 automaton id 列表（在场过滤 / 离场清理） */
  byOwner: Readonly<Record<string, readonly string[]>>;
}

/** 空效果索引（M1 用） */
export const EMPTY_EFFECT_INDEX: ActiveEffectIndex = {
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
};

// ──────────────────────────────────────────────────────────────────────────────
// ResolutionFrame（架构 §三 3.3）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 中断续跑帧。M1 在 ResponseChoice（当前不做）与骰带耗尽（BeginOutput）时冻结。
 * M1 至少需要：commandId / pendingChanges / diceConsumedInFrame / awaiting。
 */
export interface ResolutionFrame {
  /** 触发中断的 Command id */
  commandId: string;
  /** 已通过验证但未提交的变更（不变量④），恢复后继续 */
  pendingChanges: PendingChangeSet;
  /** 本 frame 已消费的各通道骰数（恢复时不重复消费） */
  diceConsumedInFrame: Readonly<Record<DiceChannel, number>>;
  /** 等待的外部输入 */
  awaiting: RequiredInput;
}

// ──────────────────────────────────────────────────────────────────────────────
// activeEffects 来源（供 rule-keys / windows 引用）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 反注入的 handler 抛错类型（kernel 熔断用，plan §3.9）。
 */
export class KernelStuckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KernelStuckError';
  }
}
