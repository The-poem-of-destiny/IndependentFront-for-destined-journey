/**
 * fx-theme-signature.ts — 主题招牌微动效的纯数据与纯函数
 *
 * 守的是：slug 表与 DESIGN.md 的身份对照一致、禁做主题什么都不给；指针 / 齿轮角度不取模；
 * 只有小步前进才播过渡；侧条落点永远不越过侧条；`<html data-theme>` 监听只在真变化时回调。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  CONDENSATION_INTERVAL,
  ESCAPEMENT_TEETH,
  MAX_ANIMATED_TURN_STEP,
  ORRERY_POINTER_STEP_DEG,
  SIDE_STRIP_VW,
  THEME_SIGNATURES,
  escapementGearAngle,
  escapementGearPoints,
  escapementStepDeg,
  observeThemeSlug,
  orreryPointerAngle,
  orreryRingTicks,
  pickSideStripSpot,
  readThemeSlug,
  shouldAnimateTurnStep,
  signatureOf,
} from '../../../src/ui/lib/fx-theme-signature';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('主题招牌表', () => {
  it('六个招牌主题各有其物', () => {
    expect(signatureOf('obsidian')).toEqual({ ornament: 'orrery', ambient: null });
    expect(signatureOf('bronze')).toEqual({ ornament: 'escapement', ambient: null });
    expect(signatureOf('ocean')).toEqual({ ornament: null, ambient: 'caustics' });
    expect(signatureOf('misty-lilac')).toEqual({ ornament: null, ambient: 'aurora' });
    expect(signatureOf('forest')).toEqual({ ornament: null, ambient: 'condensation' });
    expect(signatureOf('ivory')).toEqual({ ornament: null, ambient: 'gold-thread' });
  });

  it('crimson / sakura / parchment / indigo 与未知、空 slug 一律什么都不给', () => {
    for (const slug of ['crimson', 'sakura', 'parchment', 'indigo', 'nope', '', null, undefined]) {
      expect(signatureOf(slug)).toEqual({ ornament: null, ambient: null });
    }
  });

  it('不会顺着原型链查到 toString 之类的键', () => {
    expect(signatureOf('toString')).toEqual({ ornament: null, ambient: null });
  });

  it('表里只有六个主题，且每个主题至多一样纹饰、一样氛围', () => {
    expect(Object.keys(THEME_SIGNATURES).sort()).toEqual(
      ['bronze', 'forest', 'ivory', 'misty-lilac', 'obsidian', 'ocean'].sort(),
    );
    expect(Object.isFrozen(THEME_SIGNATURES)).toBe(true);
  });
});

describe('回合纹饰角度', () => {
  it('星盘指针每回合 6°，且不取模（第 60 回合是 360° 而不是 0°）', () => {
    expect(ORRERY_POINTER_STEP_DEG).toBe(6);
    expect(orreryPointerAngle(0)).toBe(0);
    expect(orreryPointerAngle(5)).toBe(30);
    expect(orreryPointerAngle(60)).toBe(360);
    expect(orreryPointerAngle(61)).toBe(366);
  });

  it('非法回合数收敛为 0 或向下取整', () => {
    expect(orreryPointerAngle(-3)).toBe(0);
    expect(orreryPointerAngle(Number.NaN)).toBe(0);
    expect(orreryPointerAngle(Number.POSITIVE_INFINITY)).toBe(0);
    expect(orreryPointerAngle(2.9)).toBe(12);
  });

  it('擒纵轮每回合走一齿', () => {
    expect(escapementStepDeg()).toBe(360 / ESCAPEMENT_TEETH);
    expect(escapementGearAngle(1)).toBe(360 / ESCAPEMENT_TEETH);
    expect(escapementGearAngle(ESCAPEMENT_TEETH + 1)).toBe(360 + 360 / ESCAPEMENT_TEETH);
    expect(escapementGearAngle(3, 6)).toBe(180);
  });
});

describe('shouldAnimateTurnStep', () => {
  it('首帧（没有上一个值）不动画', () => {
    expect(shouldAnimateTurnStep(undefined, 7)).toBe(false);
  });

  it('前进 1..上限个回合才动画', () => {
    expect(shouldAnimateTurnStep(4, 5)).toBe(true);
    expect(shouldAnimateTurnStep(4, 4 + MAX_ANIMATED_TURN_STEP)).toBe(true);
    expect(shouldAnimateTurnStep(4, 5 + MAX_ANIMATED_TURN_STEP)).toBe(false);
  });

  it('原地与倒退（回档 / 重试）直接到位', () => {
    expect(shouldAnimateTurnStep(5, 5)).toBe(false);
    expect(shouldAnimateTurnStep(5, 4)).toBe(false);
  });
});

describe('纹饰几何', () => {
  it('擒纵轮齿形每齿两个顶点', () => {
    const pts = escapementGearPoints(12, 11, 8, 16, 16).split(' ');
    expect(pts).toHaveLength(24);
    for (const p of pts) expect(p).toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
  });

  it('刻度环按间隔标长刻度，外端都落在半径上', () => {
    const ticks = orreryRingTicks(36, 3, 13, 1, 3, 16, 16);
    expect(ticks).toHaveLength(36);
    expect(ticks.filter((t) => t.major)).toHaveLength(12);
    for (const t of ticks) {
      expect(Math.hypot(t.x2 - 16, t.y2 - 16)).toBeCloseTo(13, 1);
    }
  });
});

describe('pickSideStripSpot', () => {
  it('落点永远在侧条里、离正文栏留余量', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.9999, 1, -1, Number.NaN]) {
      const spot = pickSideStripSpot(() => r);
      expect(spot.edgeVw).toBeGreaterThanOrEqual(1);
      expect(spot.edgeVw).toBeLessThanOrEqual(SIDE_STRIP_VW - 1);
      expect(spot.topVh).toBeGreaterThanOrEqual(12);
      expect(spot.topVh).toBeLessThanOrEqual(52);
    }
  });

  it('第一次随机数决定左右', () => {
    expect(pickSideStripSpot(() => 0.2).side).toBe('left');
    expect(pickSideStripSpot(() => 0.8).side).toBe('right');
  });

  it('凝露间隔是 50–120 秒', () => {
    expect(CONDENSATION_INTERVAL).toEqual({ minMs: 50_000, maxMs: 120_000 });
  });
});

describe('读 / 监听当前主题', () => {
  it('readThemeSlug 读 html 的 data-theme', () => {
    expect(readThemeSlug()).toBeNull();
    document.documentElement.setAttribute('data-theme', 'ocean');
    expect(readThemeSlug()).toBe('ocean');
  });

  it('observeThemeSlug 只在值真变化时回调，取消后不再回调', async () => {
    document.documentElement.setAttribute('data-theme', 'obsidian');
    const cb = vi.fn();
    const stop = observeThemeSlug(cb);

    document.documentElement.setAttribute('data-theme', 'obsidian');
    await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();

    document.documentElement.setAttribute('data-theme', 'bronze');
    await Promise.resolve();
    expect(cb).toHaveBeenCalledWith('bronze');

    stop();
    stop();
    document.documentElement.setAttribute('data-theme', 'ivory');
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
