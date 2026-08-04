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
  /** 五维（英文键 str/dex/con/int/spi），可选 */
  attributes?: Readonly<Record<string, number>>;
  /** 装备名列表（逻辑键） */
  equipment?: readonly string[];
  /** 技能名列表（逻辑键） */
  skills?: readonly string[];
  /** 登神强度 0-8（v2 §四 4.2） */
  divinity?: number;
  /** 集群数量（v2 §六 6.x，第 07 场用，M4 补正式字段） */
  clusterCount?: number;
  /** 增补的固定数值字段（命中等），harness 转 CombatParticipant 时并入。可选。 */
  hitBonus?: number;
  /** 闪避加值 */
  dodgeBonus?: number;
  /** 防御 */
  defense?: number;
  /** DR（0~1） */
  dr?: number;
  /** 武器攻击力 */
  weaponAtk?: number;
  /** 命中等级（intentionLevel 相关，供 attack ability 解析） */
  intentionLevel?: string;
  /** 一方角色（'player' | 'enemy'），缺省 enemy */
  side?: 'player' | 'enemy';
  /**
   * 单位自带的声明式效果（ParsedEffect-like，M4）。
   * harness 经 builtins compileParsedEffect 编译成 automaton 注入 activeEffects——
   * 如反伤被动 `{ key:'reflect', value:50, isPercentage:true }`（第 24 场虚数偏折）。
   */
  effects?: readonly {
    key: string;
    value: number;
    isPercentage: boolean;
  }[];
  /**
   * 单位自带的自由 automaton JSON（EffectAutomaton 形状，M4）。
   * harness 经 compileEffectProgram 编译进 activeEffects——用于 builtins 覆盖不了的
   * 机制（PreventDeath / OverrideIntent(freezeSlot) 等）。intents 用 EffectIntent 判别联合。
   */
  automata?: readonly EffectAutomatonDecl[];
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
 * replay harness 对外部输入（RequiredInput）的自动应答源（M4）。
 *
 * 只有「需求创造性或玩家决策」的 RequiredInput 需要 fixture 预置答案；
 * BeginOutput（续杯）与 PlayerCommand（行动）由 harness 自动从 epochs / commands 推导。
 */
export interface HarnessInputs {
  /** CharGenRequest 应答：自动 SupplyUnit 的召唤物定义（按键序取） */
  summons?: readonly SummonedUnitDefinition[];
  /** EffectChoice 应答：自动 Choose 的选项（按 choiceId 匹配） */
  choices?: readonly { choiceId: string; option: string }[];
  /** BoundedAdjudication 应答：自动 Adjudicate 的提案（按键序） */
  adjudications?: readonly ImportedAdjudication[];
  /** 最大续杯数（BeginOutput 应答上限，熔断防死循环），缺省 12 */
  maxEpochs?: number;
}

/** HarnessInputs 可接受的裁决提案子集（规避循环依赖，只在 harness 层用） */
export interface ImportedAdjudication {
  effectDescription: string;
  divinity: number;
  verifiableBounds: {
    targetLegal: boolean;
    numericalRange?: { min: number; max: number };
    invariantCompliant: readonly { name: string; ok: boolean; detail?: string }[];
  };
  requestedRuleOverride?: string;
  reason: string;
  targetId?: string;
}

/**
 * FixtureUnit.automata 的自由 automaton JSON（EffectAutomaton 的 JSON-safe 投影）。
 * 与运行时 CompiledAutomaton 的区别：trigger 是表达式字符串（由 harness 编译成 AST）。
 */
export interface EffectAutomatonDecl {
  id: string;
  name?: string;
  source?: string;
  owner?: string;
  subscribe: WindowKey;
  trigger: string;
  priority?: number;
  divinity?: number;
  charges?: { max: number; remaining: number };
  intents: readonly EffectIntent[];
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
  /** 自动外部输入应答（M4；只有需要创造性/决策的 RequiredInput 才预置） */
  harnessInputs?: HarnessInputs;
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
  /** 🆕 skillPower 链路修复 (2026-08-04): 主动技能战斗快照（来自 CombatParticipant.activeSkills，
   *  characterToCombatParticipant 从 char.skills 摘取，handleAttack 按 command.payload.skill 名查
   *  skillPower/relevantAttribute/damageType 填进当次 ability）。被动技能不在这里——它们的
   *  modifiers/automata 走现有 activeEffects 通道。 */
  activeSkills?: ReadonlyArray<{
    name: string;
    skillPower: number;
    relevantAttribute?: 'str' | 'dex' | 'con' | 'int' | 'spi';
    damageType?: DamageType;
    divinity?: number;
  }>;
}

// ──────────────────────────────────────────────────────────────────────────────
// FrozenSlot（A4-3 action.freezeSlot，第 13 场）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 一条槽位冻结记录（架构 §八 8.2 action.freezeSlot）。
 *
 * 由 `OverrideIntent { ruleKey:'action.freezeSlot' }` / 裁决生效时写入
 * CombatState.frozenSlots；`unit-turn.openUnitTurn` 据此对目标单位不发冻结槽。
 * merge policy：同目标同槽取 rounds 最大（max_rounds）。
 */
export interface FrozenSlot {
  /** 被冻结的目标单位（逻辑键名字，铁律 ①） */
  targetId: string;
  /** 冻结的槽位类型 */
  slotType: 'attack' | 'action' | 'both';
  /** 剩余冻结回合数（每轮 close 递减） */
  rounds: number;
}

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
  /**
   * 槽位冻结（A4-3 action.freezeSlot，第 13 场时间暂停）。
   * 时序型条目：目标单位被冻结的槽位不产、TurnClosed 跳过。可选字段——
   * 大多数战斗/既有 state 无冻结，缺省 undefined（不破坏既有构造）。
   */
  frozenSlots?: readonly FrozenSlot[];
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
  /** 槽位冻结补丁（A4-3 action.freezeSlot）：applyPending 合并进 state.frozenSlots（max_rounds） */
  freezeSlotPatches?: FrozenSlot[];
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
  | {
      kind: 'EffectChoice';
      /** 选择 id（对应 RequestChoiceIntent.choiceId） */
      choiceId: string;
      /** 触发者单位（受击方，格挡方） */
      unitId: string;
      /** 伤害预览（格挡询问展示用） */
      damagePreview: number;
      /** 选项列表 */
      options: readonly string[];
      /** 触发者选择消耗（格挡 = 消耗 SP + 动作槽） */
      cost?: { sp?: number; slot?: 'action' };
      /** 若选择格挡，重算时伤害乘的因子（plan §5.4 格挡 intent batch 的 damageTaken -0.8） */
      blockDamageFactor?: number;
      damageTakenOverrideId?: string;
    }
  | {
      kind: 'BoundedAdjudication';
      /** 由 evaluateAdjudication 校验的提案（架构 §十一 11.2） */
      proposal: ProposedAdjudication;
      /** 触发者 id（提交裁决的战斗 Agent / 单位） */
      unitId: string;
    }
  | { kind: 'BeginOutput'; channel: DiceChannel }
  | {
      kind: 'CharGenRequest';
      /** 幂等键：SupplyUnit 用它从 frame 恢复（架构 §十 10.2 / plan §6.2 ②） */
      requestId: string;
      prompt: {
        race?: string;
        tier?: number;
        role?: string;
        sourceItem: string;
        summonerIntent: string;
      };
      constraints: {
        divinityCap: number;
        attributeBudget: number;
        durationRounds?: number;
      };
    };

// ──────────────────────────────────────────────────────────────────────────────
// SummonedUnitDefinition（架构 §十 10.2，char_gen 战斗中调用产出）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 召唤物的定义（由 char_gen Agent 产出，战斗中不落库）。
 *
 * 与 CombatUnitState 的关系：此对象是「定义」，coordinator/reducer 把它转成运行时
 * CombatUnitState（补 id / statusEffects[] / ability / 槽位）插进 state.units。
 *
 * 参战时机 / 持续时长 / 行动预算 = 创造性（char_gen 判定，架构 §十 10.2 —— ADR-11）；
 * 插入先攻 / 扣血 / 到期移除 / 槽位记账 = 确定性（内核）。
 */
export interface SummonedUnitDefinition {
  /** 展示名（逻辑键，铁律 ①；实例化时补唯一 id） */
  name: string;
  /** 种族 */
  race: string;
  /** 生命层级 1-7 */
  tier: number;
  /** 等级 */
  level: number;
  /** 五维 */
  attributes: { str: number; dex: number; con: number; int: number; spi: number };
  /** HP / MP / SP（当前=最大，入编满状态） */
  hp: number;
  mp: number;
  sp: number;
  /** 防御 / DR / 穿透 */
  defense: number;
  dr: number;
  penetration: number;
  /** 命中 / 闪避加值 */
  hitBonus: number;
  dodgeBonus: number;
  /** 武器攻击力 */
  weaponAtk: number;
  /** 登神强度 0-8（v2 §四 4.2） */
  divinity: number;
  /** 阵营（默认 player，由召唤者阵营推导，构建时选） */
  side?: 'player' | 'enemy';
  /** 技能名列表（供攻击 slot 解析能力） */
  skills?: readonly string[];
  /** 参战时机（架构 §十 10.2，缺省内核取 next_round_head 保不变量①纯洁） */
  joinTiming?: 'this_round_tail' | 'next_round_head';
  /** 定时消失（架构 §十 10.2 / §十 10.3 到期移除） */
  duration?: { rounds: number };
  /** 本轮行动预算（架构 §十 10.2：full=1攻1动 / partial=仅动作 / no_action=0） */
  actionEconomy?: 'full' | 'partial' | 'no_action';
  /** 召唤物自带的 DSL automaton（走 compileEffectProgram 编译，失败剔除不阻断） */
  automata?: readonly EffectAutomaton[];
  /** 静态管线修正（modifiers[] 编译的 push-handler 已进 automata，此处语义保留给 runCharGenForCombat 透传） */
  modifiers?: readonly unknown[];
  /** 召唤来源物品/技能（叙事溯源，进 UnitSummoned.sourceItem） */
  sourceItem?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// BoundedAdjudication / 有界裁决（架构 §十一 11.2）
// ──────────────────────────────────────────────────────────────────────────────

/** 一条不变量检查结果（ProposedAdjudication 自带，内核只验是否全 true） */
export interface InvariantCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * 战斗 Agent 提交的有界裁决提案（架构 §十一 11.2）。
 *
 * 「不验证创造性」——内核只验 verifiableBounds 边界，创造性的效果描述/reason 直进 journal。
 */
export interface ProposedAdjudication {
  /** 自然语言效果描述（"认知丧失 → 永久失能"），不验证，进 journal */
  effectDescription: string;
  /** 神性优先级，内核验证是否够压目标（divinity ≥ target.divinity） */
  divinity: number;
  /** 🔒 内核只验这部分 */
  verifiableBounds: {
    /** 目标是否合法（在场 / 类型可约束） */
    targetLegal: boolean;
    /** 数值范围（v2 §13.2 决策 j：超品质上限 clamp，不 reject） */
    numericalRange?: { min: number; max: number };
    /** 不变量检查列表（全 true 才算合规） */
    invariantCompliant: readonly InvariantCheck[];
  };
  /** 请求覆盖的 closed RuleKey（如 'terminal.forceTerminal' / 'action.freezeSlot'），可选。
   *  用 string 而非 rule-keys 的 RuleKey 联合避免循环依赖（rule-keys.ts import 本文件）；
   *  合法性在 evaluateAdjudication 内由 V3_RULE_KEYS 白名单校验。 */
  requestedRuleOverride?: string;
  /** 裁判理由，进 journal 供审计 / 回放（架构 §十一 11.2） */
  reason: string;
  /** 目标单位 id（divinity 对比用） */
  targetId?: string;
}

/**
 * 内核实锤的裁决结果（纯函数 evaluateAdjudication 产出）。
 */
export type AdjudicationResult =
  | {
      kind: 'accepted';
      /** 产出的终局/override 事件策略 */
      effect:
        | { eventKind: 'RuleOverridden'; ruleKey: string; payload?: unknown }
        | { eventKind: 'MiracleTriggered'; payload?: unknown };
      /** 进 journal 的理由（ProposedAdjudication.reason 原样透传） */
      reason: string;
    }
  | { kind: 'rejected'; reason: string };

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
      payload: { requestId: string; adjudication: ProposedAdjudication };
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
      payload: { requestId: string; definition: SummonedUnitDefinition };
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
 * - completed：**结算已提交**（phase === 'SettlementCommitted'）。活 getter，不是构造快照。
 *   刻意不含 Terminal —— Terminal 之后还要 dispatch 一次 RequestSettlement，
 *   把 Terminal 也算「完成」会让驱动循环少转一圈、漏掉结算（Q-22）。
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
  | {
      kind: 'EffectRejected';
      automatonId?: string;
      /** 持有者（在场过滤溯源，架构 §6.3） */
      owner?: string;
      /** 触发窗口（架构 §6.3） */
      window?: string;
      /** rejected code 枚举（EffectRejectCode） */
      code: string;
      detail: string;
      /** 被拒的 intent 列表（若有） */
      rejectedIntents?: readonly EffectIntent[];
    }
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
 * ActiveEffectIndex 内每窗口的一条 automaton（架构 §五 5.3）。
 * M1 只用元数据字段求值排序；M3 实装后 byWindow 直接放 CompiledAutomaton，
 * 故 QueuedAutomaton 即 CompiledAutomaton 的别名（保留原字段名兼容 M1 调用点）。
 */
export interface QueuedAutomaton {
  /** 稳定 id（求值排序末位兜底） */
  id: string;
  name: string;
  /** static 身份（物品/技能/套装名） */
  source: string;
  /** 动态持有者 unitId（在场过滤） */
  owner: string;
  /** 登神强度 0-8（高者先） */
  divinity: number;
  /** 链内声明顺序 */
  priority: number;
  /** 订阅窗口 */
  subscribe: WindowKey;
  /** 字节稳定的 stable id（求值排序末位兜底，架构 §五 5.3，replay 前提） */
  stableId: string;
  /** charges（"X 次/战斗"） */
  charges?: ChargeTracker;
  /** 编译后的 trigger AST */
  triggerAst: ExprAst;
  /** 编译后的 intent 模板 */
  intents: readonly EffectIntent[];
  /** 是否为可信 TS adapter（不走 DSL 解释器） */
  isAdapter: boolean;
}

/** 类型别名：QueuedAutomaton 即 CompiledAutomaton */
export type CompiledAutomaton = QueuedAutomaton;

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
  /**
   * 当前微步骤标识（架构 §三 3.3 step）。M3 新增用于 damage.preview 冻结：
   * 'damage.preview' 表示因 RequestChoice 暂停，恢复后需回到 damage.compute 重算。
   */
  step: ResolutionStep;
  /** 已通过验证但未提交的变更（不变量④），恢复后继续 */
  pendingChanges: PendingChangeSet;
  /** 本 frame 已消费的各通道骰数（恢复时不重复消费） */
  diceConsumedInFrame: Readonly<Record<DiceChannel, number>>;
  /** 等待的外部输入 */
  awaiting: RequiredInput;
  /** 本 frame 待重算的伤害上下文（damage.preview → DeclareBlock 恢复重算用） */
  recompute?: DamageRecomputeCtx;
}

/** 微步骤标识（架构 §三 3.3）——M3 用 'damage.preview'，M3.5 加 'spawn'（CharGenRequest 冻结） */
export type ResolutionStep = 'damage.preview' | 'spawn';

/**
 * damage.preview 冻结时暂存的伤害上下文，恢复后用于回到 damage.compute **重算**。
 *
 * 架构 §五 5.2 约束 4：格挡减伤必须在管线对应步骤重算，不是在 final 上打折。
 * 因此 frame 需保留重算所需的全部伤害公式入参（攻击者/守方/意图/命中评级/管线步骤）。
 */
export interface DamageRecomputeCtx {
  attackerId: string;
  targetId: string;
  /** 攻击者 ability（关联属性/技能威力/伤害类型/意图） */
  relevantAttribute: number;
  skillPower: number;
  weaponAtk: number;
  multiHitCount: number;
  /**
   * 本次攻击**声明**的伤害类型（Q-21）。
   *
   * 🔴 必填，且必须在 damage.preview 冻结时从当次 `ability.damageType` 取。
   *    此前 frame 不带这个字段，`resumeBlockedAttack` 只好回头读
   *    `attacker.ability?.damageType ?? '物理'` —— 而常规路径用的是
   *    `command.payload.ability ?? attacker.ability ?? {…}`。于是格挡一个
   *    伤害类型异于攻击者基础档的技能（火系法术、真实伤害），重算走的是
   *    另一条类型减免（管线 Step 5 按 `damageType` 查守方抗性），
   *    格挡后的伤害与不格挡时**不同源**。这是 live bug 不是坏味。
   */
  damageType: DamageType;
  intentionCoefficient: number;
  ratingCoefficient: number;
  /** 恢复时注入的减伤因子（如格挡 0.2，即伤害 × 0.2 重算到 damage.compute） */
  damageTakenFactor: number;
  /** 额外固定伤害修正（recompute 时并入 Step 6a） */
  fixedDamageAdjust: number;
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

// ──────────────────────────────────────────────────────────────────────────────
// M3 — 效果系统（架构 §五/§六/§七，plan §5）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * **窗口上下文类型映射**（架构 §七 7.3 / plan §5.2）。
 *
 * 每个 WindowKey 只暴露该窗口有意义的字段。plan §5.11 允许 M3 先只精细实装
 * 5 个高频窗口（check.hit / collect_*_mods / damage.preview / damage.after /
 * unit.beforeDown），其余窗口用**最小公共集**（UnitCtx + RoundCtx），M4 补全。
 *
 * 编译期用 `WindowCtxMap[subscribe]` 的键集校验 automaton 里出现的 `ctx.*` 路径根段
 * （编译校验 #7，plan §5.5）。
 */
export interface UnitCtx {
  id: string;
  hp: number;
  maxHp: number;
  hpPercent: number;
  mp: number;
  sp: number;
  tier: number;
  divinity: number;
  statuses: readonly string[];
}
export interface DamageCtx {
  attackerId: string;
  targetId: string;
  /** Step 1 初始伤害（反射基准 R4 取此，架构 §九） */
  preReduction: number;
  /** 评级+意图后伤害 */
  postStep6: number;
  /** Step 8 最终伤害、未提交 */
  final: number;
  type: string;
  rating: string | number;
}
export interface RoundCtx {
  index: number;
  phase: string;
}
export interface ChargeCtx {
  remaining: number;
}

/** 5 个高频窗口的精细分型（架构 §五 5.1 / plan §5.11） */
export interface CheckCtx {
  self: UnitCtx;
  target: UnitCtx;
  round: RoundCtx;
  charges: ChargeCtx;
}
export interface CollectModsCtx {
  self: UnitCtx;
  /** collect_defender_mods 时 target = 攻击者；collect_attacker_mods 时 target = 受击者 */
  target: UnitCtx;
  round: RoundCtx;
  charges: ChargeCtx;
}
export interface PreviewCtx {
  self: UnitCtx;
  target: UnitCtx;
  damage: DamageCtx;
  round: RoundCtx;
  charges: ChargeCtx;
}
export interface AfterCtx {
  self: UnitCtx;
  target: UnitCtx;
  damage: DamageCtx;
  round: RoundCtx;
  depth: number;
  charges: ChargeCtx;
}
export interface BeforeDownCtx {
  self: UnitCtx;
  damage: DamageCtx;
  round: RoundCtx;
  charges: ChargeCtx;
}
export interface InitiativeCtx {
  self: UnitCtx;
  round: RoundCtx;
  charges: ChargeCtx;
}

/**
 * 每窗口 ctx 分型映射（plan §5.2）。
 * 未精细实装的窗口用最小公共结构（UnitCtx + RoundCtx + charges）。
 */
export interface WindowCtxMap {
  'round.open': { self: UnitCtx; round: RoundCtx; charges: ChargeCtx };
  'round.close': { self: UnitCtx; round: RoundCtx; charges: ChargeCtx };
  'initiative.before': InitiativeCtx;
  'initiative.after': InitiativeCtx;
  'turn.open': { self: UnitCtx; round: RoundCtx; charges: ChargeCtx };
  'turn.close': { self: UnitCtx; round: RoundCtx; charges: ChargeCtx };
  'action.declared': { self: UnitCtx; round: RoundCtx; charges: ChargeCtx };
  'check.intent': CheckCtx;
  'check.hit': CheckCtx;
  collect_attacker_mods: CollectModsCtx;
  collect_defender_mods: CollectModsCtx;
  'damage.preview': PreviewCtx;
  'damage.compute': PreviewCtx;
  'damage.after': AfterCtx;
  'unit.beforeDown': BeforeDownCtx;
  'morale.before': { self: UnitCtx; round: RoundCtx; charges: ChargeCtx };
  'morale.after': { self: UnitCtx; round: RoundCtx; charges: ChargeCtx };
  'settlement.before': { self: UnitCtx; round: RoundCtx; charges: ChargeCtx };
}
export type WindowCtx<K extends WindowKey> = WindowCtxMap[K];

// ──────────────────────────────────────────────────────────────────────────────
// 表达式微文法（架构 §七 7.3 / plan §5.2）
// ──────────────────────────────────────────────────────────────────────────────

/** 白名单内建函数（架构 §七 7.3 表） */
export type BuiltinFn = 'min' | 'max' | 'floor' | 'ceil' | 'abs' | 'percent' | 'has';

/** 二元运算符（文法只含比较 + 算术 + 逻辑） */
export type BinOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '&&' | '||';

/**
 * 表达式 AST 节点（plan §5.2）。
 * `path` 的 segments 是 `ctx` 后去掉的点分路径，如 `ctx.self.hpPercent` → ['self','hpPercent']。
 */
export type ExprAst =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'path'; segments: string[] }
  | { t: 'call'; fn: BuiltinFn; args: ExprAst[] }
  | { t: 'unary'; op: '-' | '!'; operand: ExprAst }
  | { t: 'bin'; op: BinOp; l: ExprAst; r: ExprAst };

/** ctx 解释值（interpreter 对 path 解析的类型化结果） */
export type ExprValue = number | string | boolean | null | readonly string[];

// ──────────────────────────────────────────────────────────────────────────────
// EffectIntent 八大类 + Outcome 子类（架构 §六 6.1 / 6.2）
// ──────────────────────────────────────────────────────────────────────────────

/** AddModifier 的管线槽（架构 §六 6.2） */
export type ModifierSlot =
  | 'fixedDamage'
  | 'damageMult'
  | 'damageTaken'
  | 'hitBonus'
  | 'dodge'
  | 'initiative'
  | 'dr'
  | 'penetration'
  | 'critThreshold'
  | 'critDmg'
  | 'attribute';

/** AddModifier 的作用域（架构 §六 6.2：连击每发 / 整体 / 每目标） */
export type ModifierScope = 'whole_action' | 'per_hit' | 'per_target';

/** divink 差压制入参（架构 §八 8.3，statusContest） */
export interface ContestInfo {
  attackerDivinity: number;
  defenderDivinity: number;
}

/** DealDamage 命中策略（架构 §六 6.2 / §九 R8） */
export interface HitPolicy {
  consumeDice: boolean;
  advantage?: 'adv' | 'dis' | 'none';
}

/**
 * EffectIntent：八大类代数（架构 §六 6.1）。
 * volume 与数值字段可用字面量或表达式字符串（trigger 同文法，plan §5.2）。
 */
export type EffectIntent =
  | {
      kind: 'AddModifier';
      slot: ModifierSlot;
      value: number | string;
      scope: ModifierScope;
      targetId: string;
      divinity: number;
    }
  | {
      kind: 'DealDamage';
      targetId: string;
      amount: number | string;
      damageType: 'physical' | 'energy' | 'mental' | 'true';
      bypass?: ModifierSlot[];
      isReaction?: boolean;
      doesNotConsumeSlot?: boolean;
      rootChainId?: string;
      /** 反射深度：字面量或表达式串（架构 §九 R1，反伤 depth = 'ctx.depth + 1'） */
      depth?: number | string;
      hitPolicy?: HitPolicy;
    }
  | {
      kind: 'Heal';
      targetId: string;
      amount: number | string;
    }
  | {
      kind: 'ApplyStatus';
      targetId: string;
      statusId: string;
      duration: number | null;
      layers?: number;
      contest?: ContestInfo;
    }
  | { kind: 'RemoveStatus'; targetId: string; statusId: string }
  | {
      kind: 'SpendResource';
      targetId: string;
      resource: 'hp' | 'mp' | 'sp' | 'fp';
      amount: number;
    }
  | {
      kind: 'PreventDeath';
      targetId: string;
      hp: number;
      slot?: 'death.threshold';
    }
  | { kind: 'ConsumeCharge'; amount?: number }
  | { kind: 'EmitNarrativeCue'; text: string; severity?: number }
  | {
      kind: 'OverrideIntent';
      ruleKey: string;
      payload: unknown;
      divinity: number;
    }
  | {
      kind: 'ScheduleIntent';
      delay: number;
      intent: EffectIntent;
    }
  | {
      kind: 'SpawnOrDespawnIntent';
      op: 'spawn' | 'despawn';
      unitId: string;
      count?: number;
      duration?: { rounds: number };
      joinTiming?: 'this_round_tail' | 'next_round_head';
      /** 模板引用：命中预生成召唤物池（§6.4）直接实例化，缺省触发 CharGenRequest（A35-1） */
      templateRef?: string;
    }
  | {
      kind: 'RequestChoiceIntent';
      choiceId: string;
      prompt: string;
      options: readonly string[];
      cost?: { sp?: number; slot?: 'action' };
      blockDamageFactor?: number;
      damageTakenOverrideId?: string;
    };

/** EffectIntent 的 kind 枚举（8 大类，供编译校验 #3） */
export type EffectIntentKind = EffectIntent['kind'];

/** SpawnOrDespawnIntent 收敛（召唤出口，M3.5） */
export type SpawnOrDespawnIntent = Extract<EffectIntent, { kind: 'SpawnOrDespawnIntent' }>;

/** 反射/递归深度上限（架构 §九 9.1 / §五 5.4） */
export const MAX_REFLECTION_DEPTH = 2;
export const MAX_WINDOW_RECURSION_DEPTH = 5;
export const MAX_AUTOMATON_PER_WINDOW = 64;

/**
 * EffectRejected 的 code 枚举（架构 §六 6.3）。
 */
export type EffectRejectCode =
  | 'TARGET_ILLEGAL'
  | 'DIVINITY_INSUFFICIENT'
  | 'RESOURCE_INSUFFICIENT'
  | 'CHARGE_EXHAUSTED'
  | 'VALUE_OUT_OF_RANGE'
  | 'INVARIANT_VIOLATION'
  | 'UNSUPPORTED_CAPABILITY'
  | 'EVAL_ERROR'
  | 'BUDGET_EXCEEDED';

// ──────────────────────────────────────────────────────────────────────────────
// EffectAutomaton / CompiledAutomaton（架构 §七 7.2 / 7.4）
// ──────────────────────────────────────────────────────────────────────────────

/** IntentTemplate：字面量 EffectIntent 或经表达式编译的 intent 模板（amount/value 可为表达式字符串） */
export type IntentTemplate = EffectIntent;

/** automaton 分次（"X 次/战斗"，架构 §七 7.2 charges） */
export interface ChargeTracker {
  max: number;
  remaining: number;
}

/**
 * EffectAutomaton —— AI 或 item_gen 产出的声明式效果（架构 §七 7.2）。
 * DSL automaton：trigger 是表达式字符串，intents[] 是 IntentTemplate[]。
 */
export interface EffectAutomaton {
  id: string;
  name: string;
  source: string;
  owner: string;
  subscribe: WindowKey;
  trigger: string;
  priority: number;
  divinity: number;
  charges?: ChargeTracker;
  intents: readonly EffectIntent[];
}

/** StaticModifier —— modifiers[] 编译为的静态管线修正（不参与窗口，直接并入结算） */
export interface StaticModifier {
  slot: ModifierSlot;
  value: number;
  scope: ModifierScope;
  source: string;
  divinity: number;
}

/** 编译期错误（plan §5.5 / A3-3） */
export interface CompileError {
  /** automaton id；intent 级错误也归到所属 automaton */
  automatonId: string;
  /** 错误类别（校验 #1..#9 之一，plan §5.5） */
  code: RejectSubCode | string;
  /** 人类可读错误信息（触发表达式错误带列号） */
  message: string;
}

/** 编译期剔除子码（plan §5.5 校验 #1..#8 的剔除项） */
export type RejectSubCode =
  | 'WINDOW_NOT_FOUND'
  /** Q-07：窗口在 18 枚举里、但 phases 里没有求值器 —— 订阅它等于什么都不做 */
  | 'WINDOW_NOT_WIRED'
  | 'TRIGGER_SYNTAX'
  | 'INTENT_KIND_ILLEGAL'
  | 'RULEKEY_ILLEGAL'
  | 'DIVINITY_EXCEEDED'
  | 'CTX_PATH_ILLEGAL'
  | 'FIVE_DIM_STRAIGHT'
  | 'UNSUPPORTED_CAPABILITY'
  | 'WARN_CLAMPED'
  | 'WARN_PREFIXED';
