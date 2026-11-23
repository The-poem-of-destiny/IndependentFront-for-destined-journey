/**
 * status-view.ts — 状态效果剩余时长的**展示层纯逻辑**（唯一真源）
 *
 * 背景（2026-11-22，状态树协议 §5.7）：解析不了的时长原文落在 `StatusEffect.durationText`，
 * 此时 `remainingTime` 为 null。各面板原先只看 `remainingTime`，会把「直到离开城镇」
 * 这类条件型状态显示成「永久」。规则：`durationText` 有值时优先显示它，否则走原来的数值格式化。
 *
 * 🔴 纯函数：无 I/O、无 store、无副作用。
 */

import type { StatusEffect } from '@engine/types/types';

/**
 * 读时长所需的最小形状。`remainingTime` 放宽成可缺席 ——
 * 存量数据里有整键缺席的行（state-manager 注释点名「遗留数据 remainingTime === undefined」）。
 */
export interface StatusDurationLike {
  remainingTime?: StatusEffect['remainingTime'];
  timeUnit?: StatusEffect['timeUnit'] | string;
  durationText?: string;
}

/** 999 及以上是「实际上不会走完」的约定值 */
const LONG_TERM_THRESHOLD = 999;

/** 有效的时长原文（空白串视为没有） */
export function durationTextOf(fx: StatusDurationLike): string | null {
  const text = fx.durationText?.trim();
  return text ? text : null;
}

/**
 * 完整剩余时长文案（详情 / 弹层用）：
 * `durationText` 优先 → 缺数值为「永久」→ 给了 `longTermLabel` 且 ≥999 时用它 → 「数字 + 单位」。
 *
 * 🔴 判 `== null` 而不是 `=== null`：`undefined` 也要收成「永久」，否则界面会印出「undefined小时」。
 */
export function statusDurationLabel(fx: StatusDurationLike, longTermLabel?: string): string {
  const text = durationTextOf(fx);
  if (text) return text;
  if (fx.remainingTime == null) return '永久';
  if (longTermLabel !== undefined && fx.remainingTime >= LONG_TERM_THRESHOLD) return longTermLabel;
  return `${fx.remainingTime}${fx.timeUnit ?? ''}`;
}

/**
 * 状态小标签旁的时长：与 `statusDurationLabel` 相同，但 ≥999 的约定值返回 null（不显示），
 * 照数字显示只会让人以为是 bug。
 */
export function statusChipDuration(fx: StatusDurationLike): string | null {
  if (!durationTextOf(fx) && fx.remainingTime != null && fx.remainingTime >= LONG_TERM_THRESHOLD) {
    return null;
  }
  return statusDurationLabel(fx);
}
