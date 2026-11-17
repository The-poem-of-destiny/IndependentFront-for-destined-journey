/**
 * useFxGameState — 游戏状态 → `<html>` 氛围属性的接线
 *
 * 判定本身（时段 / 天气 / 回合数）由 `tests/ui/lib/fx-game-state.test.ts` 钉住；这里只钉写入面：
 * store 变化时写 / 清 `data-fx-daypart`、`data-fx-weather`、`data-fx-combat`，
 * 闸门关闭即全部移除，作用域销毁（组件卸载）即全部移除。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive, type EffectScope } from 'vue';
import { syncFxGate } from '../../../src/ui/lib/fx-gate';

interface MockGame {
  gameTime: { hour: number } | null;
  saveProfile: { variables?: Record<string, unknown> } | null;
  isInCombat: boolean;
  isGenerating: boolean;
  messages: Array<{ role: string }>;
}

const game = reactive<MockGame>({
  gameTime: null,
  saveProfile: null,
  isInCombat: false,
  isGenerating: false,
  messages: [],
});

vi.mock('../../../src/ui/stores/game-store', () => ({ useGameStore: () => game }));
// 天气解析的真实规则（sys 变量 / 地图兜底）不在本测范围，替身直接读一个字段
vi.mock('../../../src/ui/lib/scene-image-seams', () => ({
  resolveSceneWeather: (profile: { variables?: Record<string, unknown> } | null) =>
    profile?.variables?.['weather'] as string | undefined,
}));

const { useFxGameState } = await import('../../../src/ui/composables/useFxGameState');

const ATTRS = ['data-fx-daypart', 'data-fx-weather', 'data-fx-combat'] as const;
const root = document.documentElement;
const attr = (name: string) => root.getAttribute(name);

let scope: EffectScope | null = null;

function start() {
  scope = effectScope();
  return scope.run(() => useFxGameState())!;
}

beforeEach(() => {
  game.gameTime = null;
  game.saveProfile = null;
  game.isInCombat = false;
  game.isGenerating = false;
  game.messages = [];
});

afterEach(() => {
  scope?.stop();
  scope = null;
  syncFxGate(false);
  for (const name of ATTRS) root.removeAttribute(name);
});

describe('useFxGameState — 闸门打开时', () => {
  beforeEach(() => {
    syncFxGate(true);
  });

  it('白天、无天气、非战斗：三个属性都不写', () => {
    game.gameTime = { hour: 12 };
    start();
    for (const name of ATTRS) expect(attr(name), name).toBeNull();
  });

  it('立即按当前状态写入三个属性', () => {
    game.gameTime = { hour: 18 };
    game.saveProfile = { variables: { weather: '小雨' } };
    game.isInCombat = true;
    start();
    expect(attr('data-fx-daypart')).toBe('dusk');
    expect(attr('data-fx-weather')).toBe('rain');
    expect(attr('data-fx-combat')).toBe('on');
  });

  it('store 变化时跟着改写，回到白天 / 晴天 / 战斗结束即清掉', async () => {
    game.gameTime = { hour: 6 };
    start();
    expect(attr('data-fx-daypart')).toBe('dawn');

    game.gameTime = { hour: 23 };
    game.saveProfile = { variables: { weather: '浓雾' } };
    game.isInCombat = true;
    await nextTick();
    expect(attr('data-fx-daypart')).toBe('night');
    expect(attr('data-fx-weather')).toBe('fog');
    expect(attr('data-fx-combat')).toBe('on');

    game.gameTime = { hour: 10 };
    game.saveProfile = { variables: { weather: '晴' } };
    game.isInCombat = false;
    await nextTick();
    for (const name of ATTRS) expect(attr(name), name).toBeNull();
  });

  it('暴露的计算值与 store 同步', async () => {
    game.messages = [{ role: 'user' }, { role: 'assistant' }, { role: 'assistant' }];
    game.isGenerating = true;
    const state = start();
    expect(state.settledTurn.value).toBe(2);
    expect(state.generating.value).toBe(true);
    game.isInCombat = true;
    await nextTick();
    expect(state.inCombat.value).toBe(true);
  });
});

describe('useFxGameState — 闸门与卸载', () => {
  it('闸门关着时一个属性都不写', () => {
    syncFxGate(false);
    game.gameTime = { hour: 22 };
    game.isInCombat = true;
    start();
    for (const name of ATTRS) expect(attr(name), name).toBeNull();
  });

  it('闸门关闭即全部移除，重新打开再按当前状态写回', async () => {
    syncFxGate(true);
    game.gameTime = { hour: 22 };
    game.saveProfile = { variables: { weather: '雷雨' } };
    game.isInCombat = true;
    start();
    expect(attr('data-fx-daypart')).toBe('night');

    syncFxGate(false);
    await nextTick();
    for (const name of ATTRS) expect(attr(name), name).toBeNull();

    syncFxGate(true);
    await nextTick();
    expect(attr('data-fx-daypart')).toBe('night');
    expect(attr('data-fx-weather')).toBe('rain');
    expect(attr('data-fx-combat')).toBe('on');
  });

  it('作用域销毁（组件卸载）即全部移除，之后 store 再变也不写', async () => {
    syncFxGate(true);
    game.gameTime = { hour: 19 };
    game.saveProfile = { variables: { weather: '薄雾' } };
    game.isInCombat = true;
    start();
    expect(attr('data-fx-combat')).toBe('on');

    scope?.stop();
    scope = null;
    for (const name of ATTRS) expect(attr(name), name).toBeNull();

    game.gameTime = { hour: 2 };
    await nextTick();
    expect(attr('data-fx-daypart')).toBeNull();
  });
});
