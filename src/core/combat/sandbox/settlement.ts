/**
 * 战斗沙盒终局结算（Phase 2 战斗重写）—— CombatState → StatePatch[]
 *
 * 只写回 `origin:'save'` 单位的**白名单字段**：hp/mp/sp 与状态效果差量。
 * `origin:'temp'` 单位（召唤物/杂兵）与全部战斗专用字段（pos/facing/slots/…）丢弃。
 *
 * EXP / FP / 战利品不在本函数结算（由调用方经 extras 传入数字）；patch 形状照
 * v3 coordinator 的先例（`buildUnitPersistPatches` / `buildExpRewardPatches`），
 * 最终仍交 StateManager 走唯一写入口（ADR-21）。
 *
 * 🔴 按名字寻址（铁律 1）：单位名即存档角色名，AI 永不产 id。
 */

import type { CharacterState, ExperienceMode, StatePatch } from '../../types/types';
import { getExperienceCoefficient } from '../../character/exp-table';
import type { CombatOutcome, CombatState } from './types';
import { toSaveStatus } from './state';

/** 协议枚举四值（`CombatOutcome`）；AI 写中文自由文本时不是其中之一 */
const COMBAT_OUTCOMES: readonly CombatOutcome[] = ['ally_win', 'enemy_win', 'draw', 'fled'];

/** 判断一个值是否为合法的 `CombatOutcome` 枚举 */
export function isCombatOutcome(value: unknown): value is CombatOutcome {
  return typeof value === 'string' && (COMBAT_OUTCOMES as readonly string[]).includes(value);
}

/**
 * 把 AI 写的**自由文本**归一化成枚举（认得出才返回，认不出返回 null）。
 *
 * 🔴 实测 AI 会写 `victory`（英文！）、「胜利（我方全歼敌军）」「战败」等 —— 只认枚举
 *    会把一场已经打赢的仗判成平局。这里按语义关键词兜一层；真正对不上的才交给
 *    `deriveCombatOutcome` 按场上存活推导。
 */
export function normalizeCombatOutcome(value: unknown): CombatOutcome | null {
  if (isCombatOutcome(value)) return value;
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (!s) return null;
  // 顺序：先退/败，再胜，最后平（避免子串互相抢）
  if (/逃|撤|flee|retreat/.test(s)) return 'fled';
  if (/败|失败|投降|defeat|\blose\b|\blost\b|\bloss\b/.test(s)) return 'enemy_win';
  if (/胜|victor|\bwin\b|\bwon\b|\bwinning\b/.test(s)) return 'ally_win';
  if (/平|draw|\btie\b/.test(s)) return 'draw';
  return null;
}

/**
 * 从权威状态推导终局结果（Code 侧，ADR-11 确定性逻辑归 Code）。
 *
 * 🔴 只作为 `normalizeCombatOutcome` 认不出时的兜底。注意它依赖 AI **真的把击杀写回状态**；
 *    实测弱模型会只在正文里说「敌人全灭」却不发 `combat_update_unit`，此时状态里敌人还活着
 *    → 会被推成平局（经验侧的兜底见 `computeCombatExpRewards`）。
 */
export function deriveCombatOutcome(state: CombatState): CombatOutcome {
  const units = Object.values(state.units);
  const alive = (side: 'ally' | 'enemy'): boolean =>
    units.some((u) => u.side === side && u.alive && u.hp > 0);
  const enemiesAlive = alive('enemy');
  const alliesAlive = alive('ally');
  if (!enemiesAlive && alliesAlive) return 'ally_win';
  if (!alliesAlive && enemiesAlive) return 'enemy_win';
  return 'draw';
}

/** 终局附加结算（调用方另行算好） */
export interface CombatSettlementExtras {
  /** 单位名 → 经验奖励（写 update_character totalExp delta） */
  expByUnit?: Record<string, number>;
  /** 存档级 FP 净变动（写 delta_variable profile.fp） */
  fpDelta?: number;
}

/** 战斗胜利经验奖励（按单位名索引，供 buildCombatSettlementPatches 的 extras） */
export interface CombatExpRewards {
  expByUnit: Record<string, number>;
  totalExp: number;
}

/**
 * 战斗胜利经验奖励（镜像 v3 coordinator.buildExpRewardPatches 的口径）。
 *
 * 仅 `ally_win` 结算：贡献经验的敌方单位 = **已阵亡的**（`level × getExperienceCoefficient`，
 * 集群再乘世界书衰减 `(1+(N-1)×0.2)`），求和后平分给**存活且有存档角色**的我方单位。
 *
 * 🔴 实测弱模型会在正文里宣布全歼却**一个 `combat_update_unit` 都不发**（状态里敌人还活着）
 *    —— 那样"已阵亡"集合为空、经验归零。兜底：判胜但没有任何阵亡记录时，改按**全部敌方**
 *    计入（判胜本身就意味着敌方已被解决）。这只是经验侧的兜底，不写回敌人生死。
 * 纯函数，不产 id（铁律 1）。
 */
export function computeCombatExpRewards(
  state: CombatState,
  mode: ExperienceMode | undefined,
): CombatExpRewards {
  if (state.meta.outcome !== 'ally_win') return { expByUnit: {}, totalExp: 0 };

  const units = Object.values(state.units);
  const enemies = units.filter((u) => u.side === 'enemy');
  const defeated = enemies.filter((u) => !u.alive || u.hp <= 0);
  if (defeated.length === 0 && enemies.length === 0) return { expByUnit: {}, totalExp: 0 };
  // 没有阵亡记录（AI 没写回状态）时，判胜即视为全歼
  const counted = defeated.length > 0 ? defeated : enemies;

  let rawExp = 0;
  for (const unit of counted) {
    let exp = unit.level * getExperienceCoefficient(mode, unit.tier);
    // 集群衰减（世界书 [经验值获取]）：总EXP = 单体 × (1 + (同类数量-1) × 0.2)
    const count = unit.cluster?.total ?? 0;
    if (count > 1) exp *= 1 + (count - 1) * 0.2;
    rawExp += exp;
  }
  const totalExp = Math.round(rawExp);
  if (totalExp <= 0) return { expByUnit: {}, totalExp: 0 };

  const survivors = units.filter(
    (unit) => unit.origin === 'save' && unit.side === 'ally' && unit.alive && unit.hp > 0,
  );
  if (survivors.length === 0) return { expByUnit: {}, totalExp: 0 };

  const perSurvivor = Math.floor(totalExp / survivors.length);
  if (perSurvivor <= 0) return { expByUnit: {}, totalExp: 0 };

  const expByUnit: Record<string, number> = {};
  for (const unit of survivors) expByUnit[unit.name] = perSurvivor;
  return { expByUnit, totalExp: perSurvivor * survivors.length };
}

/** 存档角色的最小读面（只读 name + statusEffects） */
export type SettleableCharacter = Pick<CharacterState, 'name' | 'statusEffects'>;

/**
 * 构造终局写回补丁。
 *
 * - 资源：set_hp / set_mp / set_sp（StateManager handler 内 clamp 到 [0, max]）
 * - 状态：初始有而终局无 → remove_status_effect；终局有 → add_status_effect
 * - 找不到对应存档角色 → 跳过（不硬造角色）
 * - expByUnit / fpDelta 可选，缺席不发 patch
 */
export function buildCombatSettlementPatches(
  state: CombatState,
  saveCharacters: ReadonlyArray<SettleableCharacter>,
  extras?: CombatSettlementExtras,
): StatePatch[] {
  const patches: StatePatch[] = [];
  const savedByName = new Map(saveCharacters.map((c) => [c.name, c]));

  for (const unit of Object.values(state.units)) {
    if (unit.origin !== 'save') continue;
    // 🔴 集群是 N 个同类个体聚合的临时编队，其 hp/mp/sp 是**聚合值**：写回单只存档角色
    //    只会污染数值。故集群不落资源/状态补丁（它是编队不是那个角色）。
    if (unit.cluster) continue;
    const saved = savedByName.get(unit.name);
    if (!saved) continue;

    const target = `characters.${unit.name}`;
    patches.push({ op: 'set_hp', target, value: unit.hp });
    patches.push({ op: 'set_mp', target, value: unit.mp });
    patches.push({ op: 'set_sp', target, value: unit.sp });

    const initial = saved.statusEffects ?? [];
    const finalNames = new Set(unit.statusEffects.map((fx) => fx.name));
    for (const fx of initial) {
      if (!finalNames.has(fx.name)) {
        patches.push({ op: 'remove_status_effect', target, value: { name: fx.name } });
      }
    }
    for (const fx of unit.statusEffects) {
      patches.push({ op: 'add_status_effect', target, value: toSaveStatus(fx) });
    }
  }

  if (extras?.expByUnit) {
    for (const [name, exp] of Object.entries(extras.expByUnit)) {
      if (!savedByName.has(name)) continue;
      if (!Number.isFinite(exp) || exp <= 0) continue;
      patches.push({
        op: 'update_character',
        target: `characters.${name}`,
        value: { totalExp: Math.round(exp) },
        metadata: { source: 'combat', delta: true },
      });
    }
  }

  if (extras?.fpDelta !== undefined && Number.isFinite(extras.fpDelta) && extras.fpDelta !== 0) {
    patches.push({
      op: 'delta_variable',
      target: 'profile.fp',
      amount: Math.round(extras.fpDelta),
    });
  }

  return patches;
}
