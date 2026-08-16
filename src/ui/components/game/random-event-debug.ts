/**
 * random-event-debug.ts — 调试面板「随机事件」区块的**展示层判定**（纯函数，不 mount 可测）
 *
 * 装什么: 「现在有哪些事件是调度器会考虑的，各自多大概率」这一个问题的投影 ——
 *         `buildRandomEventDebugRows` 把内容包定义 + 存档 flags + 只读上下文压成一张表，
 *         外加两个数字格式化器。
 * 不装什么: **任何判据的第二实现**。硬门槛走 `evaluateEventCondition`、权重走
 *           `computeEventWeight`、上下文走 `buildRandomEventRollContext`（组件里调）——
 *           全是生产函数。调试面板照抄一份判据是最坏的一种重复：它会在真机上**说谎**，
 *           而说谎的正是那块用来查真相的面板。
 *
 * 🔴 日概率必须与 `rollRandomEvents` **同一个算式同一个顺序**：
 *    `p = min(1, computeEventWeight(def, ctx, frequency) / mtthDays)`。
 *    频率系数在 `min` **里面**（先乘进权重再夹上界），写成 `min(1, w/mtth) × freq` 在
 *    高权重事件上会给出不同的数 —— 那种误差不报错，只是让人拿着面板上的数字去怀疑调度器。
 *
 * 🔴 这一层**不做过期/权重 0 的撤池判定**（`isPendingStillValid` 那一套）：本区块回答的是
 *    「调度器会不会考虑它」，不是「池里那条还活着吗」。`inPool` 只是原样报告池里有没有这个
 *    名字，不替它判活。
 */

import { computeEventWeight, evaluateEventCondition } from '@engine/random-event-scheduler';
import type {
  RandomEventDef,
  RandomEventRollContext,
  RandomEventSaveFlags,
} from '@engine/types-random-events';

/** 表里的一行。中文措辞全在组件模板里，本层只出结构与数字 */
export interface RandomEventDebugRow {
  name: string;
  priority: number;
  kind: 'mtth' | 'first_visit';
  /** 仅 mtth */
  mtthDays?: number;
  /** 仅 first_visit：作者点名的地点键 */
  places?: string[];
  /** 权重链乘积，**不含频率系数**（×0 原样报出：那正是「此时此地不可触发」） */
  weight: number;
  /** 每日触发概率；`first_visit` 与 mtthDays 不可用时为 `null`（不适用，不是 0） */
  dailyProbability: number | null;
  /** 名字现在在候选池里（原样报告，不判活） */
  inPool: boolean;
}

/**
 * 「调度器现在会考虑的事件」= 通过 `available` 硬门槛、且没被 `once` 消耗掉的全部定义。
 *
 * 顺序 = 包里的书写顺序（稳定；每次打开面板都重排的表读起来像在闪烁）。
 *
 * 🔴 `available` 与 `once` 这两条**是调度器真正的早退条件**（`rollRandomEvents` 里那两个
 *    `continue` / `selectFirstVisitDef` 里那两条），所以两者都要过 —— 只过 `available`
 *    会让一条早就烧掉的独特事件永远挂在「可触发」里。
 * 🔴 个体冷却（`cooldownDays`）**刻意不作为过滤条件**：它是按天算的、随下一次时间推进就
 *    会解开，把它做成「不显示」会让人以为事件消失了。它属于「现在掷不中」，与 ×0 同类。
 */
export function buildRandomEventDebugRows(
  defs: readonly RandomEventDef[],
  flags: RandomEventSaveFlags,
  ctx: RandomEventRollContext,
  frequency: number,
): RandomEventDebugRow[] {
  const pending = new Set((flags?.pending ?? []).map((entry) => entry?.name));
  const fired = flags?.fired ?? {};
  const rows: RandomEventDebugRow[] = [];

  for (const def of defs) {
    if (!def || typeof def.name !== 'string' || def.name.length === 0) continue;
    if (!def.trigger) continue;
    if (def.once === true && fired[def.name] !== undefined) continue;
    if (def.available !== undefined && !evaluateEventCondition(def.available, ctx)) continue;

    const row: RandomEventDebugRow = {
      name: def.name,
      priority:
        typeof def.priority === 'number' && Number.isFinite(def.priority) ? def.priority : 0,
      kind: def.trigger.type,
      weight: computeEventWeight(def, ctx, 1),
      dailyProbability: null,
      inPool: pending.has(def.name),
    };

    if (def.trigger.type === 'mtth') {
      const mtthDays = def.trigger.mtthDays;
      row.mtthDays = mtthDays;
      if (typeof mtthDays === 'number' && Number.isFinite(mtthDays) && mtthDays > 0) {
        // 与 rollRandomEvents 逐字同式：频率先乘进权重，再夹上界
        row.dailyProbability = Math.min(1, computeEventWeight(def, ctx, frequency) / mtthDays);
      }
    } else {
      row.places = Array.isArray(def.trigger.scope?.anyOf) ? def.trigger.scope.anyOf : [];
    }

    rows.push(row);
  }

  return rows;
}

/** 权重：整数直出，小数留两位（一串 `0.7200000000000001` 会把表挤歪） */
export function formatEventWeight(weight: number): string {
  if (!Number.isFinite(weight)) return '—';
  return Number.isInteger(weight) ? String(weight) : weight.toFixed(2);
}

/**
 * 日概率百分比。
 *
 * 🔴 极小值报 `<0.1%` 而不是四舍五入成 `0.0%`：后者与「权重 ×0 = 根本不掷」长得一模一样，
 *    而这两件事在排查时要分得开。
 */
export function formatDailyProbability(probability: number | null): string {
  if (probability === null || !Number.isFinite(probability)) return '—';
  if (probability <= 0) return '0%';
  if (probability < 0.001) return '<0.1%';
  return `${(probability * 100).toFixed(1)}%`;
}
