/**
 * random-event-context.ts — 注入块的**数据面**（纯函数，随机事件系统 v1 / 设计 §5.1-2）
 *
 * 装什么: `buildRandomEventOffer(...)` —— 把候选池过滤 + 排序成一份「现在可以给 AI 看的
 *         候选快照」。
 * 不装什么: **一个字的措辞**。`<random_events>` 外壳、那三句指令、`[!]` 首访标记、
 *           「至多触发一个」的话术，全在 `PLACEHOLDER_REGISTRY.RANDOM_EVENTS` 的 resolver 里
 *           （W2）—— 这是 `{{MAP_CONTEXT}}` 端到端那三条纪律里的第二条（数据面纯函数、
 *           措辞在 resolver），也是本文件零中文字面量的原因。
 *           池空 / 系统关闭 / **战斗会话活跃** 时返回空串同样是 resolver 的判断（裁定 §13-2）。
 *
 * 🔴 **只过滤不写库**（设计 §4.3 末句）。判据整份委托给 `isPendingStillValid` ——
 *    与保洁（`pruneRandomEvents`）共用同一份。各写一份的症状是「注入块里看得见、库里
 *    已经撤掉」或者反过来，而两者都不报错，只是 AI 触发了一个引擎不认的名字。
 *
 * 🔴 **`detail` 从定义里取，不从 pending 里取**：候选池只固化 `brief`（槽位采样的产物），
 *    `detail` 是纯静态的演绎指引 —— 存两份的那份会在换包后过期。
 *
 * 设计全文: `docs/planning/2026-08-15-random-event-system-design.md` §5.1。
 */

import { isPendingStillValid } from './random-event-scheduler';
import type {
  RandomEventConfig,
  RandomEventDef,
  RandomEventRollContext,
  RandomEventSaveFlags,
} from './types-random-events';

/**
 * 注入块的一行候选。
 *
 * `forced` 平铺成必填布尔（而不是照抄 `PendingRandomEvent` 的可选字段）：渲染侧要拿它
 * 决定加不加 `[!]` 标记，一个「可能缺席」的布尔在那里只会长出 `?? false`。
 */
export interface RandomEventOfferEntry {
  name: string;
  priority: number;
  brief: string;
  detail?: string;
  forced: boolean;
}

/**
 * 当前该展示给 AI 的候选列表。
 *
 * 排序：**forced 在前**（首访必须尽快触发），其后按 priority 降序；再往下**保持池内顺序**
 * （= 入池先后）。`Array.prototype.sort` 在 ES2019+ 是稳定排序，所以平手不会抖 ——
 * 每回合都重排一次的列表会让 AI 觉得世界在闪烁。
 *
 * `currentDay` 非有穷 → 返回空列表：判不了过期就别注入（宁可少一回合的候选，
 * 也不要把一条已经过期的事件讲给 AI）。
 */
export function buildRandomEventOffer(
  defs: readonly RandomEventDef[],
  config: RandomEventConfig,
  flags: RandomEventSaveFlags,
  ctx: RandomEventRollContext,
  currentDay: number,
): RandomEventOfferEntry[] {
  if (typeof currentDay !== 'number' || !Number.isFinite(currentDay)) return [];
  const day = Math.floor(currentDay);

  const pending = Array.isArray(flags?.pending) ? flags.pending : [];
  if (pending.length === 0) return [];

  const byName = new Map<string, RandomEventDef>();
  for (const def of defs) {
    if (!def || typeof def.name !== 'string' || def.name.length === 0) continue;
    if (!byName.has(def.name)) byName.set(def.name, def);
  }

  const offerTtlDays = typeof config?.offerTtlDays === 'number' ? config.offerTtlDays : 0;
  const rows: RandomEventOfferEntry[] = [];

  for (const entry of pending) {
    if (!entry || typeof entry.name !== 'string') continue;
    const def = byName.get(entry.name);
    if (!isPendingStillValid(entry, def, ctx, { currentDay: day, offerTtlDays })) continue;

    const row: RandomEventOfferEntry = {
      name: entry.name,
      priority:
        typeof entry.priority === 'number' && Number.isFinite(entry.priority) ? entry.priority : 0,
      brief: typeof entry.brief === 'string' ? entry.brief : '',
      forced: entry.forced === true,
    };
    // `def` 在这里必非空（`isPendingStillValid` 已经把定义缺失的条目挡掉了）
    const detail = def?.detail;
    if (typeof detail === 'string' && detail.length > 0) row.detail = detail;
    rows.push(row);
  }

  return rows.sort((a, b) => {
    if (a.forced !== b.forced) return a.forced ? -1 : 1;
    return b.priority - a.priority;
  });
}
