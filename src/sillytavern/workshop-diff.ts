/**
 * workshop-diff.ts — 更新前的「这一版会改什么」（Phase 4 / B3，对齐上游 services/diff.ts）
 *
 * 为什么存在: `WorkshopConflictModal` 回答的是「你改过的内容会被覆盖吗」，那只是
 * 更新风险的一半。另一半是**上游改了什么** —— 加了几条、删了几条、哪几条正文变了。
 * 上游的 ST 扩展给了这半边（`getCreativeWorkshopProjectDiff`），我们此前没有，于是
 * 用户按「更新」时是在闭着眼睛点。
 *
 * ★ 与上游实现的根本不同，也是这个模块最值得说的一点:
 *
 * 上游重新拉一次详情，再把远端条目与本地条目**各自重新归一化**一遍去比
 * （`normalizeWorldbookEntry` / `normalizeRemoteEntry` 两个函数，两套字段读法）。
 * 那等于把「上游条目怎么变成本地条目」这套规则实现了**第二遍** —— 一旦
 * 转换规则改了而这里没跟着改，diff 就会开始撒谎：报出根本不会发生的改动，
 * 或者漏报真会发生的。
 *
 * 我们不这么做。`planInstall()` 已经**算出了即将写入的那批条目**（含 uid、正文、
 * 开关），所以 diff 只需要拿「计划要写的」对「库里现有的」比一次。计划怎么算的，
 * diff 就怎么报 —— 两者在结构上不可能不一致，因为只有一套转换规则。
 *
 * 于是本模块也天然是**纯同步**的: 不发请求、不读库，输入全部由调用方备好。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无浏览器全局。
 */

import type { WorldBookEntry } from './types';
import type { BeautifierRuleDraft, InstallPlan } from './workshop-types';

// ═══════════════════════════════════════════════════════════
// 结果形状
// ═══════════════════════════════════════════════════════════

/** 一条世界书条目的改动 */
export interface WorkshopEntryChange {
  /** 条目名（= 上游 comment，逻辑键，铁律 1） */
  name: string;
  /** 改动前的正文。`added` 时为空串 */
  before: string;
  /** 改动后的正文。`removed` 时为空串 */
  after: string;
}

/** 一条正则（美化规则）的改动 */
export interface WorkshopRuleChange {
  name: string;
  /** 改动前的匹配式。`added` 时为空串 */
  before: string;
  /** 改动后的匹配式。`removed` 时为空串 */
  after: string;
}

export interface WorkshopDiffGroup<T> {
  added: T[];
  modified: T[];
  removed: T[];
}

export interface WorkshopUpdateDiff {
  entries: WorkshopDiffGroup<WorkshopEntryChange>;
  rules: WorkshopDiffGroup<WorkshopRuleChange>;
  /** 名字对上且内容一字未变的条目数 —— 说「大部分没动」比只报改动更让人安心 */
  unchangedEntryCount: number;
  /** 任何一组非空。为 false 时 UI 该说「这一版没有内容变化」而不是摆一个空面板 */
  hasChanges: boolean;
}

// ═══════════════════════════════════════════════════════════
// 比对
// ═══════════════════════════════════════════════════════════

/**
 * 计划 vs 现状。
 *
 * @param plan       `planInstall()` 的产物 —— **即将写入**的那批条目与规则
 * @param existingEntries 库里本项目当前的条目
 * @param existingRules   库里本项目当前的美化规则
 *
 * 配对键:
 * - 条目按 **name**（与 `planInstall` 的按名匹配同一把键，D15/铁律 1）
 * - 规则按 **id**（`workshopRuleId(projectId, …)` 生成，跨版本稳定）
 *
 * ⚠️ 「改了」的判定只看**正文**（规则只看匹配式），不看 order/enabled 之类的
 * 元字段。理由是这个面板要回答的是「内容会不会变得我不认识」——
 * 报一条「order 从 3 变成 4」只会淹没真正重要的那几条。
 */
export function diffInstallPlan(
  plan: InstallPlan,
  existingEntries: readonly WorldBookEntry[],
  existingRules: readonly BeautifierRuleDraft[],
): WorkshopUpdateDiff {
  const entries = diffEntries(plan.entries, existingEntries);
  const rules = diffRules(plan.rules, existingRules);

  const unchangedEntryCount = countUnchanged(plan.entries, existingEntries);

  return {
    entries: entries.groups,
    rules,
    unchangedEntryCount,
    hasChanges:
      entries.groups.added.length > 0 ||
      entries.groups.modified.length > 0 ||
      entries.groups.removed.length > 0 ||
      rules.added.length > 0 ||
      rules.modified.length > 0 ||
      rules.removed.length > 0,
  };
}

function diffEntries(
  planned: readonly WorldBookEntry[],
  existing: readonly WorldBookEntry[],
): { groups: WorkshopDiffGroup<WorkshopEntryChange> } {
  // 本地重名取先到的那条 —— 与 planInstall 的 existingByName 同一条规则
  const existingByName = new Map<string, WorldBookEntry>();
  for (const entry of existing) {
    if (!existingByName.has(entry.name)) existingByName.set(entry.name, entry);
  }

  const added: WorkshopEntryChange[] = [];
  const modified: WorkshopEntryChange[] = [];
  const plannedNames = new Set<string>();

  for (const entry of planned) {
    plannedNames.add(entry.name);
    const prev = existingByName.get(entry.name);
    if (!prev) {
      added.push({ name: entry.name, before: '', after: entry.content });
      continue;
    }
    if (prev.content !== entry.content) {
      modified.push({ name: entry.name, before: prev.content, after: entry.content });
    }
  }

  const removed: WorkshopEntryChange[] = [];
  for (const entry of existing) {
    if (!plannedNames.has(entry.name)) {
      removed.push({ name: entry.name, before: entry.content, after: '' });
    }
  }

  return { groups: { added, modified, removed } };
}

function diffRules(
  planned: readonly BeautifierRuleDraft[],
  existing: readonly BeautifierRuleDraft[],
): WorkshopDiffGroup<WorkshopRuleChange> {
  const existingById = new Map<string, BeautifierRuleDraft>();
  for (const rule of existing) {
    if (!existingById.has(rule.id)) existingById.set(rule.id, rule);
  }

  const added: WorkshopRuleChange[] = [];
  const modified: WorkshopRuleChange[] = [];
  const plannedIds = new Set<string>();

  for (const rule of planned) {
    plannedIds.add(rule.id);
    const prev = existingById.get(rule.id);
    if (!prev) {
      added.push({ name: rule.name, before: '', after: rule.pattern });
      continue;
    }
    // 匹配式或替换文本任一变了都算改 —— 后者变了同样会让输出长得不一样
    if (prev.pattern !== rule.pattern || prev.replacement !== rule.replacement) {
      modified.push({ name: rule.name, before: prev.pattern, after: rule.pattern });
    }
  }

  const removed: WorkshopRuleChange[] = [];
  for (const rule of existing) {
    if (!plannedIds.has(rule.id)) {
      removed.push({ name: rule.name, before: rule.pattern, after: '' });
    }
  }

  return { added, modified, removed };
}

function countUnchanged(
  planned: readonly WorldBookEntry[],
  existing: readonly WorldBookEntry[],
): number {
  const existingByName = new Map<string, WorldBookEntry>();
  for (const entry of existing) {
    if (!existingByName.has(entry.name)) existingByName.set(entry.name, entry);
  }
  let count = 0;
  for (const entry of planned) {
    const prev = existingByName.get(entry.name);
    if (prev && prev.content === entry.content) count += 1;
  }
  return count;
}
