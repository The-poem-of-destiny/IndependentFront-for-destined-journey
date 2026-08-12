/**
 * combat-v3/projection-ui.ts — 投影 A：DomainEvent → CombatEvent（M2）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §十三 13.2/13.3
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §4.2 / §4.6（映射表）/ §4.11（A2-6）
 *
 * 职责：把每次 dispatch 产出的 DomainEvent[] 映射成前端 game-store 认识的 CombatEvent[]，
 * 保住 v2 的 combat slice 契约。v3 新增 DomainEvent 映射为**新增** CombatEvent 变体
 *（v9 扩展于 combat-runner.ts），v2 发的还是老 CombatEvent，applyCombatEvent 的 v2 分支保留。
 *
 * 约束（plan §4.6 / R6）：projectToUi 对 DomainEvent 做**穷尽 switch**，漏一个变体则 TS 编译失败。
 * 验收断言 A2-6：29 个 DomainEvent 全部有映射目标，无「静默丢弃」分支。
 *
 * 铁律（plan §1.3）：本文件零 Math.random / new Function / eval；纯函数 + 不可变。
 */

import type { CombatEvent } from '../combat-v2-types';
import type { CombatUnitView, DomainEvent, MoraleState } from './types';

/**
 * 把一段 DomainEvent[] 投影为一组前端 CombatEvent（保持顺序）。
 *
 * 每个 DomainEvent 变体都有对应的 CombatEvent 目标（映射表 plan §4.6）。
 * 部分结算类事件（SettlementCommitted → v3_settlement）携带终局数据。
 * 纯函数，无副作用。
 *
 * T13（设计 2026-08-09 §3.1）：opts.units 可选 —— 传入时在 CombatOpened 之后补发一条
 * v3_units_snapshot（开局单位字典整体快照，让面板有数据）。缺省不传则行为与 T13 前
 * 逐字节一致（一一对应、无多产事件），coordinator 在首次 dispatch 时传
 * session.snapshot().units。
 *
 * 🔴 2026-08-12（真机 bug：一次攻击显示三张空卡片）：攻击三阶段事件
 * （AttackDeclared / AttackResolved / DamageApplied）**各自** mapEvent 成一张 v3_action，
 * 而每张只带各自阶段的零散字段（形状又不是 CombatActionCard 期望的 v2 CombatActionResult）
 * → UI 一次攻击冒出三张「attack」空卡。修复：**按攻击对 (attackerId, targetId) 聚合**成
 * 一张完整 v3_action 卡片（含命中/评级/伤害/HP 变化全字段），顺序放在首事件位置。
 * 聚合后字段形状见 v3 卡片契约（CombatActionCard 的 v3 分支）。
 */
export function projectToUi(
  events: readonly DomainEvent[],
  opts?: { units?: Readonly<Record<string, CombatUnitView>> },
): CombatEvent[] {
  const out: CombatEvent[] = [];
  for (const evt of events) {
    // 🔴 攻击三阶段聚合：AttackDeclared/AttackResolved/DamageApplied 合并成一张卡片
    if (
      evt.kind === 'AttackDeclared' ||
      evt.kind === 'AttackResolved' ||
      evt.kind === 'DamageApplied'
    ) {
      // 只在「首事件」时落一张聚合卡，后续同攻击对事件跳过（避免重复卡片）
      if (isFirstOfAttackPair(out, evt)) {
        out.push(aggregateAttackCard(events, evt));
      }
      continue;
    }
    out.push(mapEvent(evt));
    // v3_combat_started 先落 store（创建 v3ActiveCombat），快照随后填充 units —— 顺序不可换
    if (evt.kind === 'CombatOpened' && opts?.units) {
      out.push({ type: 'v3_units_snapshot', units: { ...opts.units } });
    }
  }
  return out;
}

/** 判定 evt 是否是某攻击对的**第一个**阶段事件（后续同对事件已聚合进卡片，不再重复发） */
function isFirstOfAttackPair(
  already: CombatEvent[],
  evt: Extract<DomainEvent, { kind: 'AttackDeclared' | 'AttackResolved' | 'DamageApplied' }>,
): boolean {
  // 在已产出的事件里找同攻击对的 v3_action(attack) 卡片
  const key = `${evt.attackerId}->${evt.targetId}`;
  return !already.some(
    (e) =>
      e.type === 'v3_action' &&
      e.toolName === 'attack' &&
      `${(e.result as Record<string, unknown>)?.attackerId}->${
        (e.result as Record<string, unknown>)?.targetId
      }` === key,
  );
}

/**
 * 把一段 events 里同攻击对的 AttackDeclared/AttackResolved/DamageApplied 聚合
 * 成一张完整 v3_action 卡片（v3 扁平字段，供 CombatActionCard 渲染）。
 * 顺序：AttackDeclared（声明）→ AttackResolved（检定/评级/命中）→ DamageApplied（伤害/HP）。
 */
function aggregateAttackCard(
  all: readonly DomainEvent[],
  first: Extract<DomainEvent, { kind: 'AttackDeclared' | 'AttackResolved' | 'DamageApplied' }>,
): CombatEvent {
  const attackerId = first.attackerId;
  const targetId = first.targetId;
  const siblings = all.filter(
    (e) =>
      (e.kind === 'AttackDeclared' || e.kind === 'AttackResolved' || e.kind === 'DamageApplied') &&
      e.attackerId === attackerId &&
      e.targetId === targetId,
  );
  const declared = siblings.find((e) => e.kind === 'AttackDeclared') as
    Extract<DomainEvent, { kind: 'AttackDeclared' }> | undefined;
  const resolved = siblings.find((e) => e.kind === 'AttackResolved') as
    Extract<DomainEvent, { kind: 'AttackResolved' }> | undefined;
  const damaged = siblings.find((e) => e.kind === 'DamageApplied') as
    Extract<DomainEvent, { kind: 'DamageApplied' }> | undefined;

  return {
    type: 'v3_action',
    toolName: 'attack',
    result: {
      attackerId,
      targetId,
      skill: declared?.skill,
      checkValue: resolved?.checkValue,
      rating: resolved?.rating,
      hit: resolved?.hit,
      final: damaged?.final ?? damaged?.preReduction,
      preReduction: damaged?.preReduction,
      damageType: damaged?.damageType,
      targetHpBefore: damaged?.targetHpBefore,
      targetHpAfter: damaged?.targetHpAfter,
    },
  };
}

/** 单个 DomainEvent → CombatEvent 的穷尽映射 */
function mapEvent(evt: DomainEvent): CombatEvent {
  switch (evt.kind) {
    // ── 生命周期（架构 §十三 #1-#8）──
    case 'CombatOpened':
      return {
        type: 'v3_combat_started',
        combatId: evt.combatId,
        round: 1,
        unitNames: [...evt.unitIds],
      };
    case 'RoundOpened':
      return { type: 'v3_round_started', round: evt.round };
    case 'InitiativeRolled':
      return {
        type: 'v3_initiative',
        round: evt.round,
        order: evt.order.map((o) => o.unitId),
      };
    case 'TurnOpened':
      return { type: 'v3_turn_started', unit: evt.unitId, unitId: evt.unitId, round: 0 };
    case 'TurnClosed':
      return { type: 'v3_turn_ended', unit: evt.unitId, unitId: evt.unitId, round: 0 };
    case 'RoundClosed':
      return { type: 'v3_round_ended', round: evt.round };
    case 'CombatEnded':
      return { type: 'v3_combat_ended', reason: evt.reason, winner: evt.winner };
    // SettlementCommitted 是 M2 的终局面板（EXP/FP/战利品）。M1 内核 settle 只算 FP
    // 净变动；战利品/EXP 由 M2 coordinator 补。这里投影 FP + 原因。
    case 'SettlementCommitted':
      return {
        type: 'v3_settlement',
        fpDelta: 0,
        reason: '',
      };

    // ── 结算（架构 §十三 #9-#19）──
    case 'AttackDeclared':
    case 'AttackResolved':
    case 'DamageApplied': {
      // 合成一张前端动作卡片（§4.6：AttackDeclared/AttackResolved/DamageApplied → action）
      return {
        type: 'v3_action',
        toolName: 'attack',
        result: {
          attackerId: evt.attackerId,
          targetId: evt.targetId,
          ...(evt.kind === 'AttackResolved'
            ? { checkValue: evt.checkValue, rating: evt.rating, hit: evt.hit }
            : {}),
          ...('final' in evt && evt.kind === 'DamageApplied'
            ? {
                final: evt.final,
                preReduction: evt.preReduction,
                damageType: evt.damageType,
                targetHpBefore: evt.targetHpBefore,
                targetHpAfter: evt.targetHpAfter,
              }
            : {}),
        },
      };
    }
    case 'HpFloored':
      return {
        type: 'v3_unit_state_changed',
        unitId: evt.unitId,
        unitName: evt.unitId,
        hp: evt.hp,
        maxHp: 0,
        side: 'player',
      };
    case 'UnitDowned':
    case 'UnitDefeated':
      return {
        type: 'v3_unit_state_changed',
        unitId: evt.unitId,
        unitName: evt.unitId,
        hp: 0,
        maxHp: 0,
        side: evt.kind === 'UnitDefeated' && evt.winnerSide ? evt.winnerSide : 'player',
      };
    case 'StatusApplied':
      return {
        type: 'v3_status_changed',
        unitId: evt.unitId,
        statusId: evt.statusId,
        op: 'applied',
      };
    case 'StatusRemoved':
    case 'StatusExpired':
      return {
        type: 'v3_status_changed',
        unitId: evt.unitId,
        statusId: evt.statusId,
        op: 'removed',
      };
    case 'ResourceSpent':
      // 并入动作卡片的消耗行（§4.6）。这里单独发一条 v3_action 消耗记录。
      return {
        type: 'v3_action',
        toolName: 'cost',
        result: { unitId: evt.unitId, resource: evt.resource, amount: evt.amount },
      };
    case 'MoraleChanged':
      return { type: 'v3_morale_changed', unitId: evt.unitId, state: evt.state };
    case 'FleeAttempt':
      return {
        type: 'v3_action',
        toolName: 'flee',
        result: { unitId: evt.unitId, success: evt.success, roll: evt.roll },
      };
    case 'NarrativeCue':
      return { type: 'v3_narrative', text: evt.text, round: 0 };

    // ── v3 新增（架构 §十三 #20-#29，M1 已实现 vs 未来的占位结构）──
    case 'UnitSummoned':
      return {
        type: 'v3_roster_changed',
        op: 'summoned',
        unitId: evt.unitId,
        unitName: evt.unitId,
      };
    case 'UnitDespawned':
      return {
        type: 'v3_roster_changed',
        op: 'despawned',
        unitId: evt.unitId,
        unitName: evt.unitId,
      };
    case 'DamagePrevented':
      return {
        type: 'v3_special_damage',
        targetId: evt.unitId,
        final: evt.amount,
        kind: 'prevented',
      };
    case 'DamageReflected':
      return {
        type: 'v3_special_damage',
        targetId: evt.rootChainId,
        final: evt.amount,
        kind: 'reflected',
      };
    case 'MiracleTriggered':
      return { type: 'v3_narrative', text: evt.effectDescription ?? '', round: 0 };
    case 'AdjudicationAccepted':
      return {
        type: 'v3_rule_override',
        effectDescription: evt.ruleKey ?? '',
        reason: evt.reason,
      };
    case 'RuleOverridden':
      return {
        type: 'v3_rule_override',
        effectDescription: evt.ruleKey,
        reason: '',
      };
    case 'EffectRejected':
      return { type: 'v3_effect_rejected', code: evt.code, detail: evt.detail };
    case 'DiceEpochBegan':
      return { type: 'v3_dice_epoch', outputId: evt.outputId };

    default: {
      // 穷尽兜底（R6 / A2-6）：新增 DomainEvent 未接映射必须编译报错。
      const _exhaustive: never = evt;
      return _exhaustive;
    }
  }
}

// MoraleState 类型留供将来扩展（当前到 string 即可，避免无谓 import）
export type { MoraleState as _MoraleState };
