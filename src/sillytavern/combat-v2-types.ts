/**
 * combat-v2-types — 战斗中 v2 残存契约的兼容容器（M5-PR2，真正退役 v2 战斗运行时）
 *
 * 背景：M5 删除 v2 战斗运行时（combat-runner / combat-pipeline / combat-actions-pipeline /
 * combat-modifier-inject / combat-resolver / combat-settlement-pipeline）后，仍有**存活代码**
 * 依赖少数 v2 战斗契约。为「删除后 typecheck + 测试全绿」，把这些共享契约统一迁到这里。
 *
 * 本文件承载两类东西：
 *  - 类型：`CombatClient` / `CombatClientResult` / `CombatEvent`（原出自 combat-runner）、
 *    `PipelineContext`（原出自 combat-pipeline）
 *  - 值：`COMBAT_EVENTS`（19 event 常量，原出自 combat-pipeline）
 *  - 纯函数：`characterToCombatParticipant`（原出自 combat-resolver，game-pipeline v3 分支仍引）
 *
 * 这些是 v2 战斗的「纯计算 / 契约」部分，v3 内核或保留文件仍在使用（铁律：不删 v2 纯计算函数）。
 * 对应删除的文件已不再存在；本模块是它们被删除后，存活消费者与 v2 契约之间的唯一桥梁。
 */

import type {
  CombatParticipant,
  CombatState,
  CombatSummaryResult,
  CharacterState,
  CombatType,
  ReadonlyHookSet,
} from './types';
import type { CombatUnitView, EffectAutomaton } from './combat-v3/types';
import type { EventBus } from './game-event';

// ========== CombatClient / CombatClientResult（原出自 combat-runner.ts） ==========

/** 抽象的 combat agent 调用客户端（生产用 AgentClient，测试用 mock） */
export interface CombatClient {
  chatWithTools?: (
    request: {
      /**
       * 完整对话历史（决策 1A 持久会话）：除 system/user/assistant 正文外还承载工具往返消息
       * （assistant.tool_calls + tool 结果）。形状对齐 agent-client ChatRequest.messages。
       */
      messages: Array<{
        role: string;
        content: string | null;
        tool_calls?: unknown[];
        tool_call_id?: string;
        name?: string;
      }>;
      tools?: unknown;
      tool_choice?: string;
    },
    toolExecutor: (name: string, args: Record<string, any>) => Promise<unknown>,
    options?: { maxRounds?: number; signal?: AbortSignal },
  ) => Promise<CombatClientResult>;
  chat: (messages: Array<{ role: string; content: string }>) => Promise<CombatClientResult>;
}

export interface CombatClientResult {
  output: string | null;
  rawResponse: string;
  tokensUsed: number;
  cacheHit: boolean;
  duration: number;
  error?: string;
  /**
   * 🆕 决策 1A 持久会话：chatWithTools 回合内的工具往返历史（name/arguments/result 按执行序）。
   * 生产来自 agent-client 的 AgentResult.toolCalls；coordinator 用它把工具往返回流进
   * 持久消息数组（查询结果随之保留进历史）。仅 chatWithTools 路径填充。
   */
  toolCalls?: Array<{ name: string; arguments: unknown; result?: unknown }>;
}

/**
 * 🆕 M5 战斗事件流 — runner 旁路给前端的过程数据（消息流 + 单位卡片 + 伤害面板的数据源）。
 * v2 发老变体；v3 由 projection A（projectToUi）产 v3 扩展变体。game-store.applyCombatEvent
 * 同时消费两类变体（v2 分支在 v3 下不可达但保留类型安全）。
 */
export type CombatEvent =
  | { type: 'combat_started'; state: CombatState }
  | { type: 'turn_started'; unit: string; unitId: string; round: number }
  | { type: 'action_resolved'; result: Record<string, any>; toolName: string }
  | { type: 'round_narrative'; text: string; round: number }
  | { type: 'round_started'; round: number }
  | { type: 'awaiting_player_input'; unit: string; unitId: string; round: number }
  | { type: 'combat_ended'; summary: CombatSummaryResult }
  // ─────────────────────────────────────────────────────────────
  // 🆕 v3 扩展变体（M2，投影 A projectToUi 输出）——v2 仍发老变体，这些只在 v3 路径出现。
  //    前端组件按需消费，不强制全改；game-store.applyCombatEvent 对老变体的 v2 分支保留。
  // ─────────────────────────────────────────────────────────────
  | {
      type: 'v3_combat_started';
      combatId: string;
      round: number;
      unitNames: string[];
      /** 可选：开战单位字典（T13；主通道是独立的 v3_units_snapshot，这里留兼容载荷） */
      units?: Record<string, CombatUnitView>;
    }
  /** 🆕 T13（设计 2026-08-09 §3.1）：开局单位字典整体快照 —— CombatOpened 投影时补发，让面板有数据 */
  | { type: 'v3_units_snapshot'; units: Record<string, CombatUnitView> }
  | { type: 'v3_turn_started'; unit: string; unitId: string; round: number }
  | { type: 'v3_turn_ended'; unit: string; unitId: string; round: number }
  | { type: 'v3_round_started'; round: number }
  | { type: 'v3_round_ended'; round: number }
  | { type: 'v3_initiative'; round: number; order: string[] }
  | { type: 'v3_action'; toolName: string; result: Record<string, any>; text?: string }
  | {
      type: 'v3_unit_state_changed';
      unitId: string;
      unitName: string;
      hp: number;
      maxHp: number;
      side: 'player' | 'enemy';
    }
  | { type: 'v3_status_changed'; unitId: string; statusId: string; op: 'applied' | 'removed' }
  | { type: 'v3_morale_changed'; unitId: string; state: string }
  | { type: 'v3_roster_changed'; op: 'summoned' | 'despawned'; unitId: string; unitName: string }
  | { type: 'v3_special_damage'; targetId: string; final: number; kind: string }
  | { type: 'v3_rule_override'; effectDescription: string; reason?: string }
  | { type: 'v3_effect_rejected'; code: string; detail: string }
  | { type: 'v3_dice_epoch'; outputId: string }
  | { type: 'v3_settlement'; fpDelta: number; reason: string; winner?: string }
  | { type: 'v3_narrative'; text: string; round: number }
  | { type: 'v3_awaiting_player_input'; unit: string; unitId: string; round: number }
  | { type: 'v3_combat_ended'; reason: string; winner?: string };

// ========== PipelineContext + COMBAT_EVENTS（原出自 combat-pipeline.ts） ==========
// Q-04: combat-morale-pipeline.ts 已删，此段供 v2 遗留类型/前端复用。保留类型形状，
// 供 M4 Agent / M5 前端（CombatMessageFlow）消费。

export interface PipelineContext {
  bus: EventBus;
  /** 参战者 charId 列表（在场过滤） */
  combatants: string[];
  /** 只读查询钩子（M1，供 handler / $status 查角色状态） */
  readHooks?: ReadonlyHookSet;
  /** 当前回合号（round.start/end 用） */
  currentRound?: number;
  /** 战斗类型（战意阈值查表用） */
  combatType?: CombatType;
}

/** 19 event 常量（M4 Agent / M5 前端复用；combat-morale-pipeline 仍引） */
export const COMBAT_EVENTS = {
  START: 'combat.start',
  END: 'combat.end',
  ROUND_START: 'combat.round.start',
  ROUND_END: 'combat.round.end',
  TURN_START: 'combat.turn.start',
  TURN_END: 'combat.turn.end',
  ATTACK_REQUEST: 'combat.attack.request',
  DICE_ROLL: 'combat.dice.roll',
  ATTACK_COLLECT_ATK: 'combat.attack.collect_attacker_mods',
  ATTACK_HIT: 'combat.attack.hit',
  ATTACK_MISS: 'combat.attack.miss',
  ATTACK_COLLECT_DEF: 'combat.attack.collect_defender_mods',
  ATTACK_DAMAGE: 'combat.attack.damage',
  ATTACK_RESULT: 'combat.attack.result',
  ACTION_USE: 'combat.action.use',
  FLEE_REQUEST: 'combat.flee.request',
  MORALE_CHECK: 'combat.morale.check',
  MORALE_RESULT: 'combat.morale.result',
  SETTLE_LOOT: 'combat.settle.loot',
  SETTLE_COMPLETE: 'combat.settle.complete',
} as const;

// ========== characterToCombatParticipant（原出自 combat-resolver.ts） ==========
// game-pipeline v3 分支组装 bundle participants 时仍引（把 CharacterState → CombatParticipant）。

/**
 * 从 CharacterState 创建 CombatParticipant。
 * 填充战斗所需的衍生字段（M2：装备 = inventory 中 equippedSlot 非空的物品，规范 §3）。
 * 纯类型转换；不依赖任何 v2 战斗运行时。
 */
export function characterToCombatParticipant(
  char: CharacterState,
  side: 'ally' | 'enemy',
  overrides?: Partial<CombatParticipant>,
): CombatParticipant {
  // M2: 装备 = inventory 中 equippedSlot 非空的物品（规范 §3，槽位为中文枚举 EQUIP_SLOTS）
  const weapon = char.inventory.find((i) => i.equippedSlot === '武器');
  const armor = char.inventory.find((i) => i.equippedSlot === '身体');

  // 🆕 战斗 v3 修复：收集全部已装备物品的 modifiers（词条效果）→ CombatParticipant.modifiers，
  //    由 createCombatState 编译进 activeEffects。v2 时代由 combat-resolver 消费，M5 后此链路曾断。
  const equippedModifiers = char.inventory
    .filter((i) => i.equippedSlot)
    .flatMap((i) => i.modifiers ?? []);

  // 🆕 战斗 v3 (S3 2026-08-01): 收集已装备物品 + 技能的 automata（AI 产的自由效果 DSL）
  //    → CombatParticipant.automata，由 createCombatState 编译进 activeEffects。
  //    装备 automata 直接收；技能只收被动（主动技能在战斗中由 $combat action 触发，不在被动效果里）。
  const equippedAutomata: EffectAutomaton[] = [
    ...char.inventory.filter((i) => i.equippedSlot).flatMap((i) => i.automata ?? []),
    ...(char.skills ?? []).filter((s) => s.type === 'passive').flatMap((s) => s.automata ?? []),
  ];

  // 🆕 skillPower 链路修复 (2026-08-04): 摘主动技能的最小战斗集（skillPower/relevantAttribute/
  //    damageType/divinity），供 v3 内核 declare_attack 时按 skillName 查主体威力填进 ability。
  //    被动技能不在这里（它们的 modifiers/automata 走 equippedAutomata/equippedModifiers 通道）。
  //    旧存档 Skill 无 skillPower 字段 → typeof 过滤掉，行为与现状一致（兜底 0，不退化）。
  const activeSkills = (char.skills ?? [])
    .filter((s) => s.type === 'active' && typeof s.skillPower === 'number')
    .map((s) => ({
      name: s.name,
      skillPower: s.skillPower as number,
      relevantAttribute: s.relevantAttribute,
      damageType: s.damageType,
      divinity: s.divinity,
    }));

  return {
    characterId: char.id,
    name: char.name,
    tier: char.tier,
    level: char.level,
    attributes: { ...char.attributes },
    hp: char.hp,
    maxHp: char.maxHp,
    mp: char.mp,
    maxMp: char.maxMp,
    sp: char.sp,
    maxSp: char.maxSp,
    defense: armor?.stats?.defense ?? 10,
    dr: armor?.stats?.dr ?? 0,
    penetration: weapon?.stats?.penetration ?? 0,
    hitBonus: weapon?.stats?.hit ?? 0,
    dodgeBonus: armor?.stats?.dodge ?? 0,
    speedModifiers: [],
    fixedInitiativeBonus: 0,
    attacksRemaining: 1,
    actionsRemaining: 1,
    statusEffects: char.statusEffects,
    weaponAtk: weapon?.stats?.atk ?? 0,
    modifiers: equippedModifiers.length > 0 ? equippedModifiers : undefined,
    automata: equippedAutomata.length > 0 ? equippedAutomata : undefined,
    activeSkills: activeSkills.length > 0 ? activeSkills : undefined,
    side,
    canAct: char.hp > 0,
    ...overrides,
  };
}
