/**
 * `<action_info>` 行动面板 — 样式组件共用的小助手（纯函数，不依赖 Vue）
 *
 * 五种收起样式（`components/game/action-panel/ActionStyle*.vue`）都要把同一份 `ActionView`
 * 翻成文字与类名：变化量带符号、资源色类名、结论色、动作名兜底、名册小字、状态句 ……
 * 这些此前在五个组件里各抄一份，这里只留一份。各样式自己的写法（跳字、牌面子句、战报行）
 * 仍留在组件里。
 *
 * 类名（`up` / `down` / `cost` / `r-hp` / `t-ok` / `t-bad`）是 `action-panel-base.css` 的契约，别改名。
 */

import type { ResourceDelta } from './action-digest';
import type { ActionView, ActionViewTarget } from './action-panel-view';
import type { ActionPanelCell } from './action-panel';

/** 结论色类名：成功 `t-ok`、失败 `t-bad`、其余不着色 */
export type VerdictTone = '' | 't-ok' | 't-bad';

/** 起止都知道的资源变化 */
export type RangedDelta = ResourceDelta & { from: number; to: number };

/** 变化量带符号：`+15` / `−34`（U+2212 减号）/ `0`；读不出数为 `±?` */
export function sgn(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '±?';
  return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
}

/** 变化量只写量：`34`；读不出数为 `?` */
export function abs(n: number | null): string {
  return n === null || !Number.isFinite(n) ? '?' : String(Math.abs(n));
}

/** 资源色类名：`HP` → `r-hp` */
export function rc(resource: string): string {
  return `r-${resource.toLowerCase()}`;
}

export function hasRange(d: ResourceDelta): d is RangedDelta {
  return d.from !== undefined && d.to !== undefined;
}

/** 目标身上的变化：回升提亮（`up`）、下降标红（`down`） */
export function deltaClass(d: ResourceDelta): string {
  return (d.delta ?? 0) > 0 ? 'up' : 'down';
}

/** 出手方自己的变化：消耗用资源色（`cost`），回升（自我治疗）用增益色（`up`） */
export function ownClass(d: ResourceDelta): string {
  return (d.delta ?? 0) > 0 ? 'up' : 'cost';
}

/** 目标的主变化：HP 优先，没有 HP 时取第一条别的资源（法力灼烧之类） */
export function primaryOf(t: ActionViewTarget): ResourceDelta | undefined {
  return t.hp ?? t.deltas[0];
}

export function verdictTone(view: ActionView): VerdictTone {
  const tone = view.verdict?.tone;
  return tone === 'success' ? 't-ok' : tone === 'error' ? 't-bad' : '';
}

/** 招式 / 动作名：动作 → 标题 → 「行动」 */
export function actionLabel(view: ActionView): string {
  return view.action || view.title || '行动';
}

/** 通用面板收起时只露前三个关键格 */
export function genericFacts(view: ActionView): ActionPanelCell[] {
  return view.facts.slice(0, 3);
}

/**
 * 状态句：目标的状态带上归属人名（`灰狼 流血(2回合)`），认不出归属的原样列出。
 * `joiner` 是名字与状态之间的字，打出的牌写成「灰狼 获得 流血(2回合)」。
 */
export function statusLines(view: ActionView, joiner = ' '): string[] {
  return [
    ...view.targets.flatMap((t) => t.statuses.map((s) => `${t.name}${joiner}${s}`)),
    ...view.looseStatuses,
  ];
}

/**
 * 名册标题旁的小字（环境之类）：摘要的关键格优先；摘要没给时取算式区里不属于任何单位的短行，至多两条。
 */
export function rosterNote(view: ActionView): string {
  const fromFacts = view.facts.map((c) => c.value).filter(Boolean);
  if (fromFacts.length > 0) return fromFacts.join(' · ');
  const names = view.roster.map((u) => u.name);
  return view.calc
    .flatMap((s) => s.rows)
    .filter((r) => r.label && !r.wide && !names.some((n) => r.label.startsWith(n)))
    .slice(0, 2)
    .map((r) => r.tokens.map((t) => t.text).join(''))
    .join(' · ');
}

/** 结算面板里某一个人的一笔资源变化 */
export interface SettledDelta {
  who: string;
  delta: ResourceDelta;
}

/**
 * 结算面板里**行动者以外**各人的资源变化（逐人逐资源，按名单顺序）。
 *
 * 回合结束的状态结算常常同时写好几个人（`|莱恩|HP 80→75|`、`|灰狼|HP 45→40|`）：
 * 这时没有单一的出手方，视图把这些人放进 `targets`；只有一个人时他被认成行动者、
 * 变化落在 `ownDeltas`。收起视图把两者都画出来，多人的变化才不会在收起态消失。
 */
export function settledDeltas(view: ActionView): SettledDelta[] {
  return view.targets.flatMap((t) => t.deltas.map((delta) => ({ who: t.name, delta })));
}
