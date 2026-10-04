/**
 * 战斗沙盒（Phase 2 战斗重写）—— 协议驱动战斗的状态类型
 *
 * v3 内核（原 `src/core/combat/types.ts` 的 CombatState）已随 C5a/C5b 删除；本模块描述的是
 * 「单一 DM Agent 依协议自算、Code 只提供计算与终局写回」这条现行路径的权威状态。
 *
 * 🔴 逻辑键 = 名字（数据字段规范铁律 1）：units 以**单位名**为键，AI 永不产 id。
 */

import type {
  CharacterState,
  CombatType,
  DamageType,
  MoraleState,
  StatusEffect,
} from '../../types/types';

/** 阵营 */
export type CombatSide = 'ally' | 'enemy';

/** 战斗阶段：主持中 / 结算中 / 已终局 */
export type CombatPhase = 'active' | 'settling' | 'ended';

/** 战斗终局结果（与 RecentCombatInfo.outcome 同口径） */
export type CombatOutcome = 'ally_win' | 'enemy_win' | 'draw' | 'fled';

/** 战斗临时效果来源标记（蓄力/定位/临时）——终局写回时丢弃 */
export type TempEffectSource = '蓄力' | '定位' | '临时';

/** 朝向 */
export type CombatFacing = 'left' | 'right';

/** 五维 */
export interface CombatUnitAttributes {
  str: number;
  dex: number;
  con: number;
  int: number;
  spi: number;
}

/** 每回合行动槽 */
export interface CombatUnitSlots {
  attack: number;
  action: number;
}

/** 集群状态（≥3 同类低级单位聚合） */
export interface CombatCluster {
  alive: number;
  total: number;
}

/**
 * 战斗状态效果。
 *
 * 比落库的 `StatusEffect` 宽松：所有账务字段可选，AI 按协议写多少算多少；
 * 战斗专属的 `tempSource` 只活在沙盒里，终局写回时由 settlement 剥掉。
 */
export interface CombatStatusEffect {
  name: string;
  description?: string;
  category?: '增益' | '减益' | '特殊';
  stacks?: number;
  maxStacks?: number;
  stackable?: boolean;
  remainingTime?: number | null;
  timeUnit?: '回合' | '分钟' | '小时';
  source?: string;
  effects?: Record<string, number>;
  effectDescriptions?: Record<string, string>;
  /** 蓄力/定位/临时 —— 战斗临时效果，终局丢弃 */
  tempSource?: TempEffectSource;
}

/** 单位技能快照（AI 面板用，战斗内不改技能） */
export interface CombatUnitSkill {
  name: string;
  type?: string;
  cost?: string;
  description?: string;
  protocolText?: string;
  tags?: string[];
  skillPower?: number;
  relevantAttribute?: string;
  damageType?: DamageType;
}

/** 单位装备快照 */
export interface CombatUnitEquipment {
  name: string;
  slot?: string;
  rarity?: string;
  description?: string;
  protocolText?: string;
  tags?: string[];
}

/**
 * 战斗单位 —— 真实字段 + 战斗字段。
 *
 * `origin:'save'` = 有对应存档角色，终局可写回；
 * `origin:'temp'` = 战斗临时单位（召唤物/杂兵），终局丢弃战斗专用字段。
 */
export interface CombatUnit {
  // ---- 真实字段（终局白名单写回）----
  name: string;
  tier: number;
  level: number;
  race: string;
  attributes: CombatUnitAttributes;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  sp: number;
  maxSp: number;
  statusEffects: CombatStatusEffect[];

  // ---- 战斗字段（终局丢弃）----
  origin: 'save' | 'temp';
  side: CombatSide;
  pos: number;
  facing: CombatFacing;
  slots: CombatUnitSlots;
  alive: boolean;
  canAct: boolean;
  morale: MoraleState;
  cluster?: CombatCluster;

  /** 技能/装备面板快照（只读展示，战斗内不改） */
  skills?: CombatUnitSkill[];
  equipment?: CombatUnitEquipment[];
  /** 战斗局部派生数值（防御/DR/穿透/命中/闪避/武器攻击） */
  defense?: number;
  dr?: number;
  penetration?: number;
  hitBonus?: number;
  dodgeBonus?: number;
  weaponAtk?: number;
  /** 自由战斗局部标量（蓄力层数、标记等），终局丢弃 */
  extras?: Record<string, unknown>;
}

/** 战斗元信息 */
export interface CombatMeta {
  round: number;
  combatType: CombatType;
  environment: string;
  coordinateRange: number;
  /** 行动轴（单位名顺序） */
  actionOrder: string[];
  phase: CombatPhase;
  regions: string[];
  /** 当前轮到、等待玩家输入的单位名（由 Code 的 `assignPlayerTurn` 指派；非 AI 工具写入） */
  pendingPlayerUnit?: string;
  /**
   * 当前正在结算的单位名（AI 用 `combat_set_meta` 推进：结算完写下一个该行动的单位；
   * 缺省/无效 → Code 按 `actionOrder` 顺延回退）。Code 据此决定下一条 exchange 只结算谁。
   */
  activeUnit?: string;
  /** 给玩家的行动选项（叙事选项，非强制；旧字段，当前无写入方） */
  pendingOptions?: string[];
  /** 终局结果 */
  outcome?: CombatOutcome;
  /** 命运点奖励（仅当协议/上下文给出 FP 规则时由 AI 用 combat_set_meta 写入；缺席/0 = 不给 FP） */
  fpReward?: number;
  /** 主持备注（自由文本，仅存沙盒） */
  notes?: string;
  /** 终局战报（DM 用 `combat_write_summary` 写的一段自然语言，回注给主叙事 AI） */
  summary?: string;
}

/** 权威战斗状态（单一真源） */
export interface CombatState {
  meta: CombatMeta;
  /** 按名字索引（铁律 1） */
  units: Record<string, CombatUnit>;
}

// ═══════════════════════════════════════════════════════════
// 工具操作类型
// ═══════════════════════════════════════════════════════════

/** 单位字段操作：set / inc / dec / remove */
export type CombatUnitOp =
  | { op: 'set'; field: string; value: unknown }
  | { op: 'inc'; field: string; value: number }
  | { op: 'dec'; field: string; value: number }
  | { op: 'remove'; field: string };

/** 建单位入参：有 character 则 origin:'save'，否则 origin:'temp' */
export interface CombatantInput {
  character?: CharacterState;
  name?: string;
  side: CombatSide;
  pos?: number;
  facing?: CombatFacing;
  slots?: Partial<CombatUnitSlots>;
  morale?: MoraleState;
  cluster?: CombatCluster;
  canAct?: boolean;
  alive?: boolean;
  tier?: number;
  level?: number;
  race?: string;
  attributes?: Partial<CombatUnitAttributes>;
  hp?: number;
  maxHp?: number;
  mp?: number;
  maxMp?: number;
  sp?: number;
  maxSp?: number;
  statusEffects?: CombatStatusEffect[];
  skills?: CombatUnitSkill[];
  equipment?: CombatUnitEquipment[];
}

/** 建战斗入参 */
export interface CombatBundle {
  meta?: Partial<CombatMeta>;
  combatants: CombatantInput[];
  /** 缺失/为 0 时是否按 tier-constants 补齐资源上限（缺省 true） */
  fillResources?: boolean;
}

// ═══════════════════════════════════════════════════════════
// 沙盒会话消息 / 持久化行
// ═══════════════════════════════════════════════════════════

/**
 * 沙盒会话消息（承 AgentClient `LlmMessage` 形状的子集）。
 * 单一 host 会话 —— 没有 combat_enemy，也没有双会话。
 */
export interface CombatSandboxMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

/**
 * Dexie `combatSandboxes` 行（v27）。
 *
 * 每存档至多一场在办战斗 —— 主键 `saveId`。存权威 CombatState + 会话 transcript，
 * 供刷新后续战。**rebuildable 的在办战斗缓存**：不进 FullBackup / 单存档导出，
 * 删存档级联删。
 */
export interface CombatSandboxRecord {
  saveId: string;
  updatedAt: number;
  state: CombatState;
  transcript: CombatSandboxMessage[];
  /** 开战前快照 id（重开战斗 restoreTimeline 用；刷新后仍可重开靠它） */
  preSnapshotId?: string | null;
}

/** 落库用的 StatusEffect 形状（settlement 从 CombatStatusEffect 归一化） */
export type SaveStatusEffect = StatusEffect;
