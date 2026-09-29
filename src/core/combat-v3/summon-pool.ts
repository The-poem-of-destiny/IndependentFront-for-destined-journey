/**
 * combat-v3/summon-pool.ts — 预生成召唤物池（M3.5，可选增强 §6.4）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §十 10.4（性能建议）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §6.4（可选标注）
 *
 * 场景：char_gen 是异步 AI 调用（3–10s），战斗中每次召唤现造会严重伤害节奏。
 * 方案：预生成常见召唤物模板（亡灵/元素/野兽等提前 char_gen 好），作为 templateRef 直接命中，
 * 只有稀有/特殊召唤才实时触发 CharGenRequest。
 *
 * ⚠️ M3.5 **最小实现**：预生成池内容走「离线脚本调 char_gen 批量生成后手工审核入库」，不在本
 * plan 范围。故这里只提供**空的池 + 幂等查找函数 + key 归一化**，coordinator 未命中时走实时
 * char_gen（plan 语气「M3.5 不做池内容也能验收」）。内容后续由离线脚本填充。
 *
 * key 规则：「种族-层级-定位」（如 `亡灵-1-近战`），对应 CharGenRequest.prompt.race/tier/role。
 *
 * 铁律（plan §1.3）：本文件零 Math.random / new Function / eval；纯函数 + 不可变。
 */

import type { SummonedUnitDefinition } from './types';

/** 预生成召唤物池（key → 定义；M3.5 暂空，离线脚本填充） */
export const SUMMON_POOL: Readonly<Record<string, SummonedUnitDefinition>> = {};

/**
 * 把 CharGenRequest.prompt 归一化为池 key（「种族-层级-定位」）。
 * tier 缺省按 'x'，race/role 缺省按 '*'（宽容出 key，避免 undefined 拼接破坏 Dict 键）。
 */
export function summonPoolKey(input: { race?: string; tier?: number; role?: string }): string {
  const race = input.race?.trim() || '*';
  const tier = input.tier !== undefined ? String(input.tier) : 'x';
  const role = input.role?.trim() || '*';
  return `${race}-${tier}-${role}`;
}

/**
 * 查预生成召唤物池（幂等）。命中返回定义，未命中返回 undefined（coordinator 走实时 char_gen）。
 */
export function lookupSummon(input: {
  race?: string;
  tier?: number;
  role?: string;
}): SummonedUnitDefinition | undefined {
  return SUMMON_POOL[summonPoolKey(input)];
}
