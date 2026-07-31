/**
 * StatusApi — $status 意图执行器 (M2 战斗 v2 · 组 B)
 *
 * 职责: 把脚本沙盒收集的 statusApplies / statusRemoves 意图，
 *       用 BuffRegistry 转换成对角色现有 statusEffects 的更新 + StatePatch。
 *
 * 设计理由（ADR-21 唯一写入入口）:
 *  - 脚本沙盒（script-executor）只收集意图，不直接改 character.statusEffects
 *  - 调用方拿到 patches 后，统一交给 state-manager.commitChatState(patches) 落库
 *  - patch 形态对齐 effect-runtime.ts 的 executeStatusEffect
 *    （`{ op: 'add_status_effect'|'remove_status_effect', target: \`characters.${id}\`, value }`）
 *
 * 对齐:
 *  - docs/reference/combat-system-architecture.md §5（Buff 系统）
 *  - docs/planning/2026-07-28-combat-v2-m2-rfc.md §3 D10 + §4.4
 *  - src/sillytavern/effect-runtime.ts executeStatusEffect（patch 形态参考，不改它）
 */

import type { StatusEffect, StatePatch } from './types';
import { applyBuff, removeBuff, buffIdOf } from './buff-registry';

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/**
 * 沙盒 $status.apply 收集的意图。
 * target = 目标角色 id；buffDef = AI 声明的 buff 描述（必有 name + category，其余可选）。
 */
export interface StatusApplyIntent {
  target: string;
  buffDef: Partial<StatusEffect> & { name: string; category: StatusEffect['category'] };
}

/** 沙盒 $status.remove 收集的意图。target = 目标角色 id；buffIdOrName = 完整 buffId 或裸 name。 */
export interface StatusRemoveIntent {
  target: string;
  buffIdOrName: string;
}

/** applyStatusIntents 的返回 */
export interface ApplyStatusIntentsResult {
  /** 应用全部意图后，角色应有的 statusEffects 列表（新数组） */
  updated: StatusEffect[];
  /** 对每个 intent 生成的 StatePatch（add_status_effect，覆盖式语义） */
  patches: StatePatch[];
  /** 每个 intent 的去重结果（调试 + 上层展示用） */
  results: Array<{ action: 'added' | 'refreshed' | 'stacked'; buffId: string }>;
}

/** removeStatusIntents 的返回 */
export interface RemoveStatusIntentsResult {
  /** 移除后角色应有的 statusEffects 列表（新数组） */
  updated: StatusEffect[];
  /** 每个 intent 生成的 StatePatch（remove_status_effect） */
  patches: StatePatch[];
}

// ═══════════════════════════════════════════════════════════
// 实现
// ═══════════════════════════════════════════════════════════

/**
 * 执行一组 $status.apply 意图（去重 → StatePatch）。
 *
 * 流程（按 intents 顺序串行 fold existing）:
 *  1. 对每个 intent，用 BuffRegistry.applyBuff(currentExisting, buffDef) 决定 added/refreshed/stacked
 *  2. added → push 到 currentExisting；refreshed/stacked → 就地替换 currentExisting[index] = merged
 *     patch 一律携带增量 buffDef（消费方 state-manager/combat-runner 均为累加语义，见函数内注释）
 *  3. patch.target = `characters.${target}`
 *
 * 注意：buffDef 是 Partial<StatusEffect>，调用方（state-manager）应能容忍缺省字段。
 *       若需补全字段（如默认 stacks=1、timeUnit='回合'），在沙盒侧或 AI 输出层补，本函数不擅自补全。
 *
 * @param existing  角色当前的 statusEffects 列表
 * @param intents   $status.apply 收集的意图列表
 */
export function applyStatusIntents(
  existing: StatusEffect[],
  intents: StatusApplyIntent[],
): ApplyStatusIntentsResult {
  // 复制一份作为可变工作副本（不污染入参）
  let current: StatusEffect[] = [...existing];
  const patches: StatePatch[] = [];
  const results: ApplyStatusIntentsResult['results'] = [];

  for (const intent of intents) {
    // buffDef 视为 StatusEffect（Partial → 完整：调用方承诺 name/category，其余字段可缺省）
    const newEffect = intent.buffDef as StatusEffect;
    const r = applyBuff(current, newEffect);
    const buffId = buffIdOf(newEffect);

    if (r.action === 'added') {
      // 异源新增：push 到 current，patch value=新 effect
      current = [...current, newEffect];
    } else {
      // 同源刷新/叠加：就地替换为 merged
      current = current.map((e, i) => (i === r.index ? r.merged : e));
    }

    // 🐛修复(对抗验证): patch 统一携带**增量**(本次施加的 buffDef)，不带合并后总量。
    // 旧实现 refreshed/stacked 时 value=merged(总层数)，而唯一的落库消费方
    // state-manager.applyAddStatusEffect 是**按名累加**语义（stacks += value.stacks），
    // 合并总量 + 累加 = 层数双计（战前 2 层 + 施加 1 层 → patch 带 3 → 落库变 5）。
    // 增量 patch 对累加消费方（state-manager / combat-runner 战中同步）恰好正确。
    patches.push({
      op: 'add_status_effect',
      target: `characters.${intent.target}`,
      value: newEffect,
    });

    results.push({ action: r.action, buffId });
  }

  return { updated: current, patches, results };
}

/**
 * 执行一组 $status.remove 意图（按 buffId 或裸 name 移除 → StatePatch）。
 *
 * 流程（按 intents 顺序串行 fold existing）:
 *  1. 对每个 intent，用 BuffRegistry.removeBuff(currentExisting, buffIdOrName) 移除匹配项
 *  2. 更新 current = remaining
 *  3. 按实际移除的 effect 逐名生成 remove_status_effect patch（value={name}，对齐 state-manager 契约）
 *
 * 注意：state-manager 的 remove_status_effect handler 应支持按完整 buffId 或裸 name 移除
 *       （裸 name 移除所有同名）。本函数只生成意图，真正落库由 state-manager 完成。
 *
 * @param existing  角色当前的 statusEffects 列表
 * @param intents   $status.remove 收集的意图列表
 */
export function removeStatusIntents(
  existing: StatusEffect[],
  intents: StatusRemoveIntent[],
): RemoveStatusIntentsResult {
  let current: StatusEffect[] = [...existing];
  const patches: StatePatch[] = [];

  for (const intent of intents) {
    const r = removeBuff(current, intent.buffIdOrName);
    current = r.remaining;

    // 🐛修复(对抗验证): state-manager.applyRemoveStatusEffect 要求 value={name}（string 直接抛错，
    // 旧实现每次 status_remove 落库必炸）且按裸 name 过滤。按本次实际移除的 effect 逐名生成
    // patch（去重），完整 buffId 入参也能正确落库。无命中则不产 patch。
    const removedNames = [...new Set(r.removed.map((e) => e.name))];
    for (const name of removedNames) {
      patches.push({
        op: 'remove_status_effect',
        target: `characters.${intent.target}`,
        value: { name },
      });
    }
  }

  return { updated: current, patches };
}
