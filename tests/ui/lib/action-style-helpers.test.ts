/**
 * action-style-helpers — 行动面板五种样式共用的小助手
 *
 * 守的是：变化量的符号与读不出数时的写法、资源色 / 增减色类名、结论色、动作名兜底、
 * 状态句的归属人名与连接字、名册小字的两级来源、多人结算的逐人资源变化。
 */
import { describe, expect, it } from 'vitest';
import {
  abs,
  actionLabel,
  deltaClass,
  genericFacts,
  hasRange,
  ownClass,
  primaryOf,
  rc,
  rosterNote,
  settledDeltas,
  sgn,
  statusLines,
  verdictTone,
} from '../../../src/ui/lib/action-style-helpers';
import type { ResourceDelta } from '../../../src/ui/lib/action-digest';
import {
  EXCHANGE,
  GENERIC,
  OUTCOME,
  ROSTER,
  SETTLE,
  sheet,
  viewOf,
} from '../components/game/action-panel/fixtures';

function delta(n: number | null, extra: Partial<ResourceDelta> = {}): ResourceDelta {
  return { who: '灰狼', resource: 'HP', delta: n, ...extra } as ResourceDelta;
}

describe('数值与类名', () => {
  it('sgn：正数带 +、负数用 U+2212 减号、0 不带号，读不出数写 ±?', () => {
    expect(sgn(15)).toBe('+15');
    expect(sgn(-34)).toBe('−34');
    expect(sgn(0)).toBe('0');
    expect(sgn(null)).toBe('±?');
    expect(sgn(Number.NaN)).toBe('±?');
  });

  it('abs：只写量，读不出数写 ?', () => {
    expect(abs(-34)).toBe('34');
    expect(abs(12)).toBe('12');
    expect(abs(null)).toBe('?');
    expect(abs(Number.POSITIVE_INFINITY)).toBe('?');
  });

  it('rc：资源名转小写的色类名', () => {
    expect(rc('HP')).toBe('r-hp');
    expect(rc('SP')).toBe('r-sp');
  });

  it('hasRange：起止都在才算', () => {
    expect(hasRange(delta(-5, { from: 80, to: 75 }))).toBe(true);
    expect(hasRange(delta(-5, { from: 80 }))).toBe(false);
    expect(hasRange(delta(-5))).toBe(false);
  });

  it('deltaClass / ownClass：回升都是 up，下降一个标 down、一个标 cost', () => {
    expect(deltaClass(delta(5))).toBe('up');
    expect(deltaClass(delta(-5))).toBe('down');
    expect(deltaClass(delta(null))).toBe('down');
    expect(ownClass(delta(5))).toBe('up');
    expect(ownClass(delta(-5))).toBe('cost');
  });
});

describe('视图读法', () => {
  it('verdictTone：成功 t-ok、失败 t-bad、没有结论为空串', () => {
    expect(verdictTone(viewOf(EXCHANGE))).toBe('t-ok');
    expect(verdictTone(viewOf(sheet('出手', [['判定', '失败']])))).toBe('t-bad');
    expect(verdictTone(viewOf(GENERIC))).toBe('');
  });

  it('actionLabel：动作 → 标题 → 「行动」', () => {
    expect(actionLabel(viewOf(EXCHANGE))).toBe('裂风斩');
    expect(actionLabel(viewOf(GENERIC))).toBe('潜行 · 穿过哨卡');
    expect(actionLabel(viewOf('| 气味 | 潮湿的苔藓 |'))).toBe('行动');
  });

  it('genericFacts：至多三个关键格', () => {
    const view = viewOf(GENERIC);
    expect(genericFacts(view)).toEqual(view.facts.slice(0, 3));
    expect(genericFacts(view).length).toBeLessThanOrEqual(3);
  });

  it('primaryOf：HP 优先，没有 HP 取第一条别的资源', () => {
    const [wolf] = viewOf(EXCHANGE).targets;
    expect(primaryOf(wolf)?.resource).toBe('HP');
    const [lich] = viewOf(
      sheet('出手 · 法力灼烧', [
        ['行动者', '莉娅'],
        ['目标', '巫妖'],
        ['变更', '巫妖 MP 80→50'],
      ]),
    ).targets;
    expect(primaryOf(lich)?.resource).toBe('MP');
  });

  it('statusLines：目标的状态带归属人名，连接字可换', () => {
    const view = viewOf(EXCHANGE);
    expect(statusLines(view)).toEqual(['灰狼 流血(2回合)']);
    expect(statusLines(view, ' 获得 ')).toEqual(['灰狼 获得 流血(2回合)']);
  });

  it('rosterNote：关键格优先；没有时取算式区里不属于单位的短行', () => {
    expect(rosterNote(viewOf(ROSTER))).toContain('夜雨 · 林道');
    expect(rosterNote(viewOf(GENERIC))).not.toBe('');
  });

  it('settledDeltas（A4）：多人结算逐人逐资源，按名单顺序', () => {
    const items = settledDeltas(viewOf(SETTLE));
    expect(items.map((x) => [x.who, x.delta.resource, x.delta.delta])).toEqual([
      ['莱恩', 'HP', -5],
      ['灰狼', 'HP', -5],
    ]);
  });

  it('settledDeltas：单人结算的变化落在出手方自己身上，这里为空', () => {
    expect(settledDeltas(viewOf(OUTCOME))).toEqual([]);
    expect(settledDeltas(viewOf(sheet('回合结束 · 状态结算', [['莱恩', 'HP 80→75']])))).toEqual([]);
  });
});
