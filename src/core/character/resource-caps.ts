/**
 * 资源上限拆分：基础 + 额外（状态树协议 §5.6，2026-11-22 裁定）
 *
 * 不变式（读写两侧共用，本文件是唯一出处）：
 * - 基础 = `calcResources(tier, attributes)` 的三个上限，**不落库**，恒现算。
 * - 额外 = `maxHpBonus` 等；字段缺席时读作「现上限 − 基础」，所以旧档总上限一分不变。
 * - 有效上限 = max(1, 基础 + 额外)，写回 `maxHp` 等（现有读者读的都是它）。
 * - 上限下降：当前值钳到新上限；上限上升：当前值不变，不白送恢复（§9 #10）。
 *
 * 纯函数，不碰 StateManager / Dexie；触发点接线在 `state/state-manager.ts`（T3）。
 */

import type { CharacterState } from '../types/types';
import { calcResources } from './tier-constants';

/** 三项资源的键。 */
export type ResourceKey = 'hp' | 'mp' | 'sp';

export const RESOURCE_KEYS: readonly ResourceKey[] = ['hp', 'mp', 'sp'];

/** 资源键 → 上限字段 / 额外字段。 */
export const RESOURCE_FIELDS = {
  hp: { max: 'maxHp', bonus: 'maxHpBonus' },
  mp: { max: 'maxMp', bonus: 'maxMpBonus' },
  sp: { max: 'maxSp', bonus: 'maxSpBonus' },
} as const satisfies Record<
  ResourceKey,
  { max: keyof CharacterState; bonus: keyof CharacterState }
>;

/** 一项资源的上限拆分。 */
interface ResourceCap {
  /** 公式基础值。 */
  base: number;
  /** 额外（可为负）。 */
  bonus: number;
  /** 有效上限 = max(1, base + bonus)。 */
  effective: number;
}

export type ResourceCaps = Record<ResourceKey, ResourceCap>;

/** `readResourceCaps` 需要的角色字段。 */
export type ResourceCapSource = Pick<
  CharacterState,
  'tier' | 'attributes' | 'maxHp' | 'maxMp' | 'maxSp' | 'maxHpBonus' | 'maxMpBonus' | 'maxSpBonus'
>;

/** 有效上限 = max(1, 基础 + 额外)。 */
export function effectiveCap(base: number, bonus: number): number {
  return Math.max(1, base + bonus);
}

/** 三项资源的公式基础值。 */
export function baseResourceCaps(
  tier: number,
  attributes: CharacterState['attributes'],
): Record<ResourceKey, number> {
  const r = calcResources(tier, attributes);
  return { hp: r.maxHp, mp: r.maxMp, sp: r.maxSp };
}

/** 读出一项的额外：字段在就用字段，缺席读作「现上限 − 基础」。 */
function readBonus(char: ResourceCapSource, key: ResourceKey, base: number): number {
  const stored = char[RESOURCE_FIELDS[key].bonus];
  if (typeof stored === 'number' && Number.isFinite(stored)) return stored;
  return char[RESOURCE_FIELDS[key].max] - base;
}

/**
 * 读出三项资源的 {基础, 额外, 有效上限}。
 * 旧档（无 `*Bonus` 字段）读出的有效上限恒等于原 `maxHp` 等（原值 ≥ 1 时）。
 */
export function readResourceCaps(char: ResourceCapSource): ResourceCaps {
  const bases = baseResourceCaps(char.tier, char.attributes);
  const out = {} as ResourceCaps;
  for (const key of RESOURCE_KEYS) {
    const base = bases[key];
    const bonus = readBonus(char, key, base);
    out[key] = { base, bonus, effective: effectiveCap(base, bonus) };
  }
  return out;
}

/**
 * 固化额外：在属性或层级变化**之前**调用（§5.6 触发点第 1 步），把缺席的额外按旧基础算出来。
 * 字段已在的项原样返回。
 */
export function solidifyResourceBonuses(char: ResourceCapSource): Record<ResourceKey, number> {
  const caps = readResourceCaps(char);
  return { hp: caps.hp.bonus, mp: caps.mp.bonus, sp: caps.sp.bonus };
}

/** `recomputeResourceCaps` 的输入。 */
export interface RecomputeResourceCapsInput {
  /** 变化后的层级。 */
  tier: number;
  /** 变化后的五维。 */
  attributes: CharacterState['attributes'];
  /** 已固化的额外（来自 `solidifyResourceBonuses`，或补丁写入的新额外）。 */
  bonuses: Record<ResourceKey, number>;
  /** 重算前的有效上限（判断上限升降用）。 */
  previousMax: Record<ResourceKey, number>;
  /** 当前值。 */
  current: Record<ResourceKey, number>;
}

/** 重算结果：可直接并进 `CharacterState` 的字段。 */
export interface RecomputedResourceCaps {
  maxHp: number;
  maxMp: number;
  maxSp: number;
  maxHpBonus: number;
  maxMpBonus: number;
  maxSpBonus: number;
  hp: number;
  mp: number;
  sp: number;
}

/**
 * 按新层级、新属性重算三个有效上限（§5.6 触发点第 2 步），并给出固化后的额外与钳过的当前值。
 * 当前值只在上限下降时钳到新上限；上限上升时不变。
 */
export function recomputeResourceCaps(input: RecomputeResourceCapsInput): RecomputedResourceCaps {
  const bases = baseResourceCaps(input.tier, input.attributes);
  const result = {} as RecomputedResourceCaps;
  for (const key of RESOURCE_KEYS) {
    const bonus = input.bonuses[key];
    const max = effectiveCap(bases[key], bonus);
    const prev = input.previousMax[key];
    const cur = input.current[key];
    result[RESOURCE_FIELDS[key].max] = max;
    result[RESOURCE_FIELDS[key].bonus] = bonus;
    result[key] = max < prev ? Math.min(cur, max) : cur;
  }
  return result;
}

/**
 * 旧写法兼容：「把总上限设为 n」换算成额外 = n − 基础（`update_character {maxHp: n}`，§5.6）。
 */
export function bonusForTotalCap(
  char: Pick<CharacterState, 'tier' | 'attributes'>,
  key: ResourceKey,
  total: number,
): number {
  return total - baseResourceCaps(char.tier, char.attributes)[key];
}
