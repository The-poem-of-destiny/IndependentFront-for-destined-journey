/**
 * random-event-debug.test.ts — 调试面板随机事件表的展示层判定
 *
 * 为什么值得单独测：这块表的**全部价值**是「面板上的数字与调度器真的会做的事一致」。
 * 它算错了不报错、也不会让任何功能失灵 —— 只会让人拿着一份错数字去怀疑调度器，
 * 或者反过来放过一条本来就不该出现的事件。所以三件事逐条钉住：
 *   · 日概率与 `rollRandomEvents` **同式同顺序**（频率在 `min` 里面）
 *   · `available` 与 `once` 是调度器真正的早退条件 → 表里也必须过滤掉
 *   · 权重 ×0 原样报出（不是「过滤掉」）—— 「事件存在但此时此地不可触发」是要看得见的
 *
 * 夹具全用中性英文词（同 `random-event-scheduler.test.ts` 的口径）：事件名与地点名都是
 * 内容包数据，写真名会让人误以为引擎认识它们。
 */

import { describe, expect, it } from 'vitest';

import {
  buildRandomEventDebugRows,
  formatDailyProbability,
  formatEventWeight,
} from './random-event-debug';
import type {
  RandomEventDef,
  RandomEventRollContext,
  RandomEventSaveFlags,
} from '@engine/types-random-events';

const CTX: RandomEventRollContext = { placeKey: 'Harbor', playerLevel: 5, journeyActive: false };

function mtth(name: string, mtthDays: number, extra: Partial<RandomEventDef> = {}): RandomEventDef {
  return { name, brief: `${name}.`, trigger: { type: 'mtth', mtthDays }, ...extra };
}

function firstVisit(name: string, places: string[]): RandomEventDef {
  return { name, brief: `${name}.`, trigger: { type: 'first_visit', scope: { anyOf: places } } };
}

function rows(
  defs: RandomEventDef[],
  flags: RandomEventSaveFlags = {},
  frequency = 1,
  ctx: RandomEventRollContext = CTX,
) {
  return buildRandomEventDebugRows(defs, flags, ctx, frequency);
}

describe('buildRandomEventDebugRows —— 谁进表', () => {
  it('available 不满足的定义不进表（调度器根本不会考虑它）', () => {
    const defs = [mtth('Open', 10), mtth('Gated', 10, { available: { playerLevel: { gte: 99 } } })];
    expect(rows(defs).map((r) => r.name)).toEqual(['Open']);
  });

  it('once 已烧掉的不进表（一条早就用过的独特事件不该挂在「可触发」里）', () => {
    const defs = [mtth('Once', 10, { once: true }), mtth('Again', 10)];
    const flags: RandomEventSaveFlags = { fired: { Once: { count: 1, lastDay: 3 } } };
    expect(rows(defs, flags).map((r) => r.name)).toEqual(['Again']);
  });

  it('🔴 权重 ×0 的**要**进表并原样报 0 —— 「存在但此时此地不可触发」得看得见', () => {
    const def = mtth('Zeroed', 10, { weights: [{ when: { journey: true }, multiply: 0 }] });
    // journeyActive: false → 这条修正不命中 → 权重仍是 1
    expect(rows([def])[0].weight).toBe(1);

    const inJourney = rows([def], {}, 1, { ...CTX, journeyActive: true })[0];
    expect(inJourney.weight).toBe(0);
    expect(inJourney.dailyProbability).toBe(0);
  });

  it('个体冷却不作为过滤条件（它按天解开，藏起来会让人以为事件消失了）', () => {
    const defs = [mtth('Cooling', 10, { cooldownDays: 30 })];
    const flags: RandomEventSaveFlags = { fired: { Cooling: { count: 1, lastDay: 1 } } };
    expect(rows(defs, flags).map((r) => r.name)).toEqual(['Cooling']);
  });

  it('坏定义整条跳过，不抛（定义来自第三方内容包）', () => {
    const defs = [
      { name: '', brief: 'x', trigger: { type: 'mtth', mtthDays: 5 } } as RandomEventDef,
      { name: 'NoTrigger', brief: 'x' } as unknown as RandomEventDef,
      mtth('Fine', 5),
    ];
    expect(rows(defs).map((r) => r.name)).toEqual(['Fine']);
  });

  it('顺序 = 包里的书写顺序（每次打开都重排的表读起来像在闪烁）', () => {
    expect(rows([mtth('C', 1), mtth('A', 9), mtth('B', 3)]).map((r) => r.name)).toEqual([
      'C',
      'A',
      'B',
    ]);
  });
});

describe('buildRandomEventDebugRows —— 各列的数', () => {
  it('🔴 日概率与 rollRandomEvents 同式：频率先乘进权重，再夹上界', () => {
    // w=1, mtth=10, freq=2 → min(1, 2/10) = 0.2（若写成 min(1, 1/10)×2 也是 0.2，故再取一组）
    expect(rows([mtth('A', 10)], {}, 2)[0].dailyProbability).toBeCloseTo(0.2, 10);
    // w=1, mtth=2, freq=4 → min(1, 4/2) = 1；错式 min(1, 1/2)×4 = 2（还越了界）
    expect(rows([mtth('B', 2)], {}, 4)[0].dailyProbability).toBe(1);
  });

  it('权重列**不含**频率系数（那是全局旋钮，不是这条事件的情境权重）', () => {
    const def = mtth('A', 10, { weights: [{ when: {}, multiply: 3 }] });
    const row = rows([def], {}, 2)[0];
    expect(row.weight).toBe(3);
    expect(row.dailyProbability).toBeCloseTo(0.6, 10);
  });

  it('first_visit：报地点、日概率不适用（null，不是 0）', () => {
    const row = rows([firstVisit('Arrival', ['Harbor', 'Keep'])])[0];
    expect(row.kind).toBe('first_visit');
    expect(row.places).toEqual(['Harbor', 'Keep']);
    expect(row.dailyProbability).toBeNull();
  });

  it('mtthDays 认不出（0 / 负数）→ 概率 null：调度器对它整条 continue', () => {
    expect(rows([mtth('A', 0)])[0].dailyProbability).toBeNull();
    expect(rows([mtth('B', -1)])[0].dailyProbability).toBeNull();
  });

  it('inPool 原样报告池里有没有这个名字（不替它判活）', () => {
    const flags: RandomEventSaveFlags = {
      pending: [{ name: 'A', armedDay: 0, expiresDay: 1, priority: 0, brief: 'x' }],
    };
    const out = rows([mtth('A', 10), mtth('B', 10)], flags);
    expect(out.map((r) => [r.name, r.inPool])).toEqual([
      ['A', true],
      ['B', false],
    ]);
  });

  it('priority 缺席读作 0（§3.1 默认值）', () => {
    expect(rows([mtth('A', 10), mtth('B', 10, { priority: 7 })]).map((r) => r.priority)).toEqual([
      0, 7,
    ]);
  });
});

describe('格式化', () => {
  it('权重：整数直出、小数留两位（浮点尾巴会把表挤歪）', () => {
    expect(formatEventWeight(1)).toBe('1');
    expect(formatEventWeight(0)).toBe('0');
    expect(formatEventWeight(0.7200000000000001)).toBe('0.72');
  });

  it('🔴 极小概率报 `<0.1%` 而不是 0.0% —— 与「权重 ×0 根本不掷」必须分得开', () => {
    expect(formatDailyProbability(0)).toBe('0%');
    expect(formatDailyProbability(1e-9)).toBe('<0.1%');
    expect(formatDailyProbability(0.25)).toBe('25.0%');
    expect(formatDailyProbability(1)).toBe('100.0%');
  });

  it('不适用 / 非有穷 → 破折号', () => {
    expect(formatDailyProbability(null)).toBe('—');
    expect(formatEventWeight(Number.NaN)).toBe('—');
  });
});
