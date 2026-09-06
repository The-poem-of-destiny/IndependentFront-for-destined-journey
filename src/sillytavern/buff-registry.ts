/**
 * BuffRegistry — buff 去重引擎 + 生命周期 + 结算时机 (M2 战斗 v2 · 组 B)
 *
 * 职责: 给定角色现有 statusEffects（纯数组），决定 buff 的应用/移除/递减结果。
 *  - **纯函数集**，不持有状态、不落 DB。真实数据存 character.statusEffects。
 *  - 调用方（status-api / combat-turn / 脚本宿主）拿到结果后自行生成 StatePatch 落库。
 *
 * 对齐:
 *  - docs/reference/combat-system-architecture.md §5.2（去重 id）/ §5.3（4 生命周期）/ §5.4（结算时机）
 *  - docs/planning/2026-07-28-combat-v2-m2-rfc.md §3 D5-D11 + §4.3
 *
 * 核心规则:
 *  - buff id = sourceKey ? `${sourceKey}.${name}` : name（铁律：AI 永不产 id，名字是逻辑键）
 *  - 同 (owner, buffId) = 同实例 → 刷新 remainingTime（取 max）+ stacks += newEffect.stacks（受 maxStacks 上限）
 *  - 不同 buffId = 独立实例共存（异源叠加）
 *  - 结算时机：增益在 round.start tick、减益/特殊在 round.end tick
 *  - 生命周期：战斗型随回合递减；持续型不递减；触发/条件型由脚本/外部控制（tick 不动）
 */

import type { StatusEffect } from './types';

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/** 生命周期 4 种（对齐 [状态规则] §5.3） */
export type BuffLifecycle = '战斗' | '持续' | '触发' | '条件';

/** 结算阶段（对齐 §5.4：增益在 round.start，减益/特殊在 round.end） */
export type TickPhase = 'round.start' | 'round.end';

/** BuffRegistry.apply 的返回 —— 告诉调用方该 buff 是新增/刷新/叠加 */
export interface BuffApplyResult {
  /** 动作：added=异源新增 / refreshed=同源刷新时间（不增层）/ stacked=同源叠加层数 */
  action: 'added' | 'refreshed' | 'stacked';
  /** 合并后的 effect（added=新 effect；refreshed/stacked=合并后的现有 effect） */
  merged: StatusEffect;
  /** 在 existing 中的位置（-1=新增，调用方需 push；≥0=就地更新该索引） */
  index: number;
}

/** BuffRegistry.remove 的返回 */
export interface BuffRemoveResult {
  /** 移除后的剩余列表（新数组，不改原数组） */
  remaining: StatusEffect[];
  /** 被移除的 effect 列表 */
  removed: StatusEffect[];
}

/** BuffRegistry.tick 的返回 */
export interface BuffTickResult {
  /** tick 后剩余的列表（新数组，不改原数组） */
  remaining: StatusEffect[];
  /** 本回合到期 / 被结算移除的 effect 列表 */
  expired: StatusEffect[];
}

// ═══════════════════════════════════════════════════════════
// 纯函数实现
// ═══════════════════════════════════════════════════════════

/**
 * 构造 buff id（架构 §5.2）。
 *
 * 有 sourceKey（物品/技能名）→ `${sourceKey}.${name}`；无 sourceKey（裸名，仅代码预置环境效果）→ name。
 * 注意：与 source 展示串正交（source 承载"[分类]-[施加者];[解除方式]"，buff id 前缀用独立的 sourceKey）。
 */
export function buffIdOf(effect: StatusEffect): string {
  return effect.sourceKey ? `${effect.sourceKey}.${effect.name}` : effect.name;
}

/**
 * 推导生命周期（RFC §3 D7 缺省推导）。
 *
 * - lifecycle 显式给定 → 直接用
 * - 否则 timeUnit==='回合' → '战斗'（随回合递减）
 * - 否则 remainingTime===null → '持续'（永久/直至解除，不递减）
 * - 否则（timeUnit='分钟'/'小时' 且 remainingTime 非 null）→ '战斗'（脱战场景按战斗型处理）
 */
export function lifecycleOf(effect: StatusEffect): BuffLifecycle {
  if (effect.lifecycle) return effect.lifecycle;
  if (effect.timeUnit === '回合') return '战斗';
  if (effect.remainingTime === null) return '持续';
  return '战斗';
}

/**
 * 应用一个新 buff（架构 §5.2 去重规则）。
 *
 * 给定现有 effects + 新 effect，返回 { action, merged, index }：
 *  - buffId 匹配现有 → 同源：刷新 remainingTime（取 max）+ stacks += newEffect.stacks
 *    （受 maxStacks 上限；stackable===false 则不增层只刷新）
 *    - newEffect.stacks > 0 且 stackable !== false 且实际叠加了层数 → 'stacked'
 *    - 否则 → 'refreshed'
 *  - 未匹配 → 'added'，index=-1，merged=newEffect
 *
 * 调用方按 index 决定 push 还是 in-place 更新（merged 是合并后的新对象，原数组不变）。
 */
export function applyBuff(existing: StatusEffect[], newEffect: StatusEffect): BuffApplyResult {
  const newId = buffIdOf(newEffect);
  const foundIndex = existing.findIndex((e) => buffIdOf(e) === newId);

  if (foundIndex === -1) {
    return { action: 'added', merged: newEffect, index: -1 };
  }

  const current = existing[foundIndex];

  // 刷新 remainingTime（取 max，对齐"同源叠加刷新时间"）
  // 永久 buff（remainingTime=null）保持永久：刷新不应把它降格为有限 buff
  let refreshedTime = current.remainingTime;
  if (current.remainingTime !== null && newEffect.remainingTime !== null) {
    refreshedTime = Math.max(current.remainingTime, newEffect.remainingTime);
  }

  // 增层（受 stackable / maxStacks 约束）
  const stackable = current.stackable !== false; // stackable===false 时不增层
  let newStacks = current.stacks;
  let didStack = false;
  if (newEffect.stacks > 0 && stackable) {
    const candidate = current.stacks + newEffect.stacks;
    const capped =
      typeof current.maxStacks === 'number' && current.maxStacks > 0
        ? Math.min(candidate, current.maxStacks)
        : candidate;
    // 仅当实际增加层数才算 stacked（避免 maxStacks 已满时误判）
    if (capped > current.stacks) {
      newStacks = capped;
      didStack = true;
    }
  }

  // 合并：保持现有字段，覆盖 stacks / remainingTime（其余字段以现有为准 —— 避免异源重新声明 description 等）
  // F07：时长被拉长（刷新到更大的窗口）时 carryMinutes 归零 —— 余量属于旧窗口，新起点不应继承；
  // 保留现有时长则保留其已累积余量。extended 里把 refreshedTime 一并收窄为 number。
  const extended =
    refreshedTime != null &&
    current.remainingTime !== null &&
    refreshedTime > current.remainingTime;
  const merged: StatusEffect = {
    ...current,
    stacks: newStacks,
    remainingTime: refreshedTime,
    carryMinutes: extended ? undefined : current.carryMinutes,
  };

  return {
    action: didStack ? 'stacked' : 'refreshed',
    merged,
    index: foundIndex,
  };
}

/**
 * 按 buffId 或裸 name 移除 buff（架构 §5.2 实例标识 + §5.6 状态交互）。
 *
 * - 入参精确等于某 buffId → 移除该实例
 * - 入参是裸 name（无 `.` 前缀）→ 移除所有同名 buff（覆盖所有 sourceKey 前缀的实例）
 *
 * 返回 { remaining, removed }（新数组，不改原数组）。
 */
export function removeBuff(existing: StatusEffect[], buffIdOrName: string): BuffRemoveResult {
  const containsDot = buffIdOrName.includes('.');
  const removed: StatusEffect[] = [];
  const remaining: StatusEffect[] = [];

  for (const e of existing) {
    const id = buffIdOf(e);
    const hit = containsDot ? id === buffIdOrName : e.name === buffIdOrName;
    if (hit) removed.push(e);
    else remaining.push(e);
  }

  return { remaining, removed };
}

/**
 * 按结算阶段递减战斗型 buff 的时间（架构 §5.3 / §5.4）。
 *
 * - phase='round.start' 只处理增益（category='增益'）
 * - phase='round.end' 只处理减益/特殊（category='减益' 或 '特殊'）
 * - 对处理的 buff：lifecycle='战斗' 的 remainingTime-- （≤0 进 expired；remainingTime=null 不动）
 * - lifecycle='持续'|'触发'|'条件' 的不递减（直接保留在 remaining）
 *
 * 返回 { remaining, expired }（新数组，不改原数组）。
 */
export function tickBuffs(existing: StatusEffect[], phase: TickPhase): BuffTickResult {
  const remaining: StatusEffect[] = [];
  const expired: StatusEffect[] = [];

  for (const e of existing) {
    const category = e.category;
    const shouldProcess =
      (phase === 'round.start' && category === '增益') ||
      (phase === 'round.end' && (category === '减益' || category === '特殊'));

    // 不归本阶段处理的，原样保留
    if (!shouldProcess) {
      remaining.push(e);
      continue;
    }

    // 非战斗型不递减（持续/触发/条件）
    if (lifecycleOf(e) !== '战斗') {
      remaining.push(e);
      continue;
    }

    // 战斗型但 remainingTime=null（理论上不该出现，但兜底：原样保留）
    if (e.remainingTime === null) {
      remaining.push(e);
      continue;
    }

    const next = e.remainingTime - 1;
    if (next <= 0) {
      expired.push(e);
    } else {
      remaining.push({ ...e, remainingTime: next });
    }
  }

  return { remaining, expired };
}

// ═══════════════════════════════════════════════════════════
// OOP 包装（可选 API，对齐 RFC §4.3 草案形式）
// ═══════════════════════════════════════════════════════════

/**
 * OOP 风格包装 —— 把纯函数集包成实例方法（无状态，所有方法都接收 existing 数组）。
 *
 * 设计理由：RFC §4.3 API 草案用了 OOP 形式，部分调用方更习惯 instance.apply(...) 写法。
 * 内部全部委托给上面的纯函数，零运行时开销。
 */
export class BuffRegistry {
  /** buff id = sourceKey ? `${sourceKey}.${name}` : name */
  static buffIdOf(effect: StatusEffect): string {
    return buffIdOf(effect);
  }

  /** 推导生命周期 */
  static lifecycleOf(effect: StatusEffect): BuffLifecycle {
    return lifecycleOf(effect);
  }

  /** 应用 buff：给定现有列表 + 新 effect，决定 action + 合并后的 effect + 位置 */
  apply(existing: StatusEffect[], newEffect: StatusEffect): BuffApplyResult {
    return applyBuff(existing, newEffect);
  }

  /** 移除 buff：按 buffId 或裸 name 匹配（裸 name 匹配所有同名） */
  remove(existing: StatusEffect[], buffIdOrName: string): BuffRemoveResult {
    return removeBuff(existing, buffIdOrName);
  }

  /** tick：按 phase 结算战斗型 buff 时间递减 */
  tick(existing: StatusEffect[], phase: TickPhase): BuffTickResult {
    return tickBuffs(existing, phase);
  }
}
