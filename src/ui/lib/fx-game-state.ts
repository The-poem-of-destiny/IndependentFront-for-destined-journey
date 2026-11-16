/**
 * fx-game-state.ts — 游戏状态 → 特效氛围的纯函数投影
 *
 * 只读、无副作用、不碰 store：时段（daypart）、天气类别、已落定回合数。
 * 写 `<html data-fx-*>` 的是 `composables/useFxGameState.ts`，本模块只回答「是什么」。
 */
import type { GameTime } from '@engine/time/time-system';
import type { ChatMessage } from '@engine/types/types';

export type FxDaypart = 'dawn' | 'day' | 'dusk' | 'night';
export type FxWeatherKind = 'rain' | 'fog';

/**
 * 游戏时刻 → 时段。拿不到时间时按白天（白天 = 不加任何氛围属性，等于今天的界面）。
 * 区间：5–7 点黎明，8–16 点白天，17–19 点黄昏，其余夜晚。
 */
export function daypartOf(gameTime: Pick<GameTime, 'hour'> | null | undefined): FxDaypart {
  const hour = gameTime?.hour;
  if (typeof hour !== 'number' || !Number.isFinite(hour)) return 'day';
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 5 && h < 8) return 'dawn';
  if (h >= 8 && h < 17) return 'day';
  if (h >= 17 && h < 20) return 'dusk';
  return 'night';
}

/**
 * 天气标签子串表（按序匹配，先命中先得）。天气是自由文本（AI 写 / 地图兜底），
 * 只认能可靠归类的两类；认不出的一律 null（= 不加天气氛围）。
 */
const WEATHER_TABLE: ReadonlyArray<readonly [string, FxWeatherKind]> = [
  ['暴雨', 'rain'],
  ['雷', 'rain'],
  ['阵雨', 'rain'],
  ['雨', 'rain'],
  ['薄雾', 'fog'],
  ['雾', 'fog'],
  ['霾', 'fog'],
];

/** 天气标签 → 天气类别；未知 / 空 → null */
export function weatherKindOf(label: string | null | undefined): FxWeatherKind | null {
  if (typeof label !== 'string') return null;
  const text = label.trim();
  if (text === '') return null;
  for (const [needle, kind] of WEATHER_TABLE) {
    if (text.includes(needle)) return kind;
  }
  return null;
}

/**
 * 已落定的回合数：完成且未被废弃的 assistant 正文条数。
 * - `storyTurnStatus` 为 pending（生成中）/ failed（已废弃的尝试）的不算
 * - 缺席 status 的历史消息算（兼容旧档）
 * - 诊断 / 侧链文本（`diagnostic`）不算
 */
export function settledTurnOf(
  messages: ReadonlyArray<Pick<ChatMessage, 'role' | 'storyTurnStatus' | 'diagnostic'>>,
): number {
  let count = 0;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    if (m.diagnostic) continue;
    if (m.storyTurnStatus === 'pending' || m.storyTurnStatus === 'failed') continue;
    count += 1;
  }
  return count;
}
