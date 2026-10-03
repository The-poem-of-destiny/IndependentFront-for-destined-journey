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
import type { CombatState } from './types';
import { toSaveStatus } from './state';

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
 * 仅 `ally_win` 结算：被击杀敌方单位贡献 `level × getExperienceCoefficient(mode, tier)`，
 * 求和后平分给**存活且有存档角色**的我方单位（整除向下取整）。
 * 纯函数，不产 id（铁律 1）。
 */
export function computeCombatExpRewards(
  state: CombatState,
  mode: ExperienceMode | undefined,
): CombatExpRewards {
  if (state.meta.outcome !== 'ally_win') return { expByUnit: {}, totalExp: 0 };

  const units = Object.values(state.units);
  let rawExp = 0;
  for (const unit of units) {
    if (unit.side !== 'enemy' || (unit.alive && unit.hp > 0)) continue;
    rawExp += unit.level * getExperienceCoefficient(mode, unit.tier);
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
