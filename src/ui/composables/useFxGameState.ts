/**
 * useFxGameState — 把游戏状态投影成 `<html>` 上的氛围属性，供特效 CSS 挂钩
 *
 * 写入的属性（只在特效闸门打开时存在）：
 * - `data-fx-daypart` = dawn | dusk | night（白天不写 —— 白天即今天的界面）
 * - `data-fx-weather` = rain | fog（认不出的天气不写）
 * - `data-fx-combat`  = on（战斗中）
 *
 * 闸门关闭 / 组件卸载时全部移除。只由 `FxGameLayer` 调用一次（属性是全局的，
 * 多处调用会互相抢写）；别处需要回合数直接用 `settledTurnOf()`。
 */
import { computed, onScopeDispose, watch, type ComputedRef } from 'vue';
import { useGameStore } from '../stores/game-store';
import { resolveSceneWeather } from '../lib/scene-image-seams';
import { useFxEnabled } from '../lib/fx-gate';
import {
  daypartOf,
  settledTurnOf,
  weatherKindOf,
  type FxDaypart,
  type FxWeatherKind,
} from '../lib/fx-game-state';

const DAYPART_ATTR = 'data-fx-daypart';
const WEATHER_ATTR = 'data-fx-weather';
const COMBAT_ATTR = 'data-fx-combat';

export interface FxGameState {
  daypart: ComputedRef<FxDaypart>;
  weather: ComputedRef<FxWeatherKind | null>;
  inCombat: ComputedRef<boolean>;
  generating: ComputedRef<boolean>;
  settledTurn: ComputedRef<number>;
}

function setAttr(name: string, value: string | null): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (value === null) root.removeAttribute(name);
  else if (root.getAttribute(name) !== value) root.setAttribute(name, value);
}

function clearAttrs(): void {
  setAttr(DAYPART_ATTR, null);
  setAttr(WEATHER_ATTR, null);
  setAttr(COMBAT_ATTR, null);
}

export function useFxGameState(): FxGameState {
  const game = useGameStore();
  const enabled = useFxEnabled();

  const daypart = computed(() => daypartOf(game.gameTime));
  const weather = computed(() => weatherKindOf(resolveSceneWeather(game.saveProfile)));
  const inCombat = computed(() => Boolean(game.isInCombat));
  const generating = computed(() => Boolean(game.isGenerating));
  const settledTurn = computed(() => settledTurnOf(game.messages ?? []));

  watch(
    [enabled, daypart, weather, inCombat],
    ([on, dp, wx, combat]) => {
      if (!on) {
        clearAttrs();
        return;
      }
      setAttr(DAYPART_ATTR, dp === 'day' ? null : dp);
      setAttr(WEATHER_ATTR, wx);
      setAttr(COMBAT_ATTR, combat ? 'on' : null);
    },
    { immediate: true },
  );

  onScopeDispose(clearAttrs);

  return { daypart, weather, inCombat, generating, settledTurn };
}
