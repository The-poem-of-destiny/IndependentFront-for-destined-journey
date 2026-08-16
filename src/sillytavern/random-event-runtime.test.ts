/**
 * random-event-runtime.test.ts — 注入缝的运行时闸（随机事件系统 v1 / 设计 §3.3）
 *
 * 钉的是「装进来的东西不是包」那几种形态。它们都有同一个败法：**不报错**——
 * 调度钩子全程 try/catch，读 `pack.config.offerTtlDays` 抛出去只会变成一条 warn，
 * 表现是随机事件整段静默不工作，而候选池永远是空的看起来也很正常。
 *
 * 🔴 夹具零真实事件名（承 D25①）：事件定义是**内容包数据**，引擎一个字都不认识。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  getRandomEventPack,
  installRandomEventPack,
  resetRandomEventRuntime,
} from './random-event-runtime';
import { isEmptyRandomEventPack, type RandomEventPack } from './random-event-pack';
import { pruneRandomEvents } from './random-event-scheduler';
import { DEFAULT_RANDOM_EVENT_CONFIG } from './types-random-events';
import type { RandomEventDef } from './types-random-events';

const DEF: RandomEventDef = {
  name: 'Encounter',
  brief: 'brief-of-Encounter',
  trigger: { type: 'mtth', mtthDays: 1 },
};

afterEach(() => {
  resetRandomEventRuntime();
});

describe('installRandomEventPack —— 三个运行时闸', () => {
  it('没装过 → 空包（兜底合同：钩子整段 no-op）', () => {
    expect(isEmptyRandomEventPack(getRandomEventPack())).toBe(true);
    expect(getRandomEventPack().config).toEqual(DEFAULT_RANDOM_EVENT_CONFIG);
  });

  it('null / 不是对象 / defs 不是数组 → 落成空包', () => {
    installRandomEventPack({ config: { ...DEFAULT_RANDOM_EVENT_CONFIG }, defs: [DEF] });
    installRandomEventPack(null);
    expect(isEmptyRandomEventPack(getRandomEventPack())).toBe(true);

    installRandomEventPack(7 as unknown as RandomEventPack);
    expect(isEmptyRandomEventPack(getRandomEventPack())).toBe(true);

    installRandomEventPack({ config: {}, defs: 'nope' } as unknown as RandomEventPack);
    expect(isEmptyRandomEventPack(getRandomEventPack())).toBe(true);
  });

  it('空包工厂每次给新对象（下游改一格 config 不该污染兜底路径）', () => {
    installRandomEventPack(null);
    const first = getRandomEventPack();
    first.config.maxPending = 999;
    resetRandomEventRuntime();
    expect(getRandomEventPack().config).toEqual(DEFAULT_RANDOM_EVENT_CONFIG);
  });
});

/**
 * 🔴 `config` 缺席不该悄悄废掉整个子系统（2026-08-16 审查修复）。
 *
 * 三种「没给」（`undefined` / `null` / 不是对象）一视同仁：补默认旋钮、**定义原样保留**。
 * 反证用真正读 config 的调用（`pruneRandomEvents` 读 `config.offerTtlDays`）——
 * 补默认之前那一行会抛 TypeError，而调度钩子会把它吞成一条 warn。
 */
describe('installRandomEventPack —— config 缺席补默认（不动 defs）', () => {
  const cases: { label: string; pack: unknown }[] = [
    { label: 'undefined（手搓的 { defs }）', pack: { defs: [DEF] } },
    { label: 'null', pack: { config: null, defs: [DEF] } },
    { label: '不是对象（数字）', pack: { config: 3, defs: [DEF] } },
    { label: '不是对象（数组）', pack: { config: [], defs: [DEF] } },
  ];

  for (const { label, pack } of cases) {
    it(`config = ${label} → 默认旋钮 + 定义照留，读 config 的路径不抛`, () => {
      installRandomEventPack(pack as RandomEventPack);
      const installed = getRandomEventPack();

      expect(installed.config).toEqual(DEFAULT_RANDOM_EVENT_CONFIG);
      expect(isEmptyRandomEventPack(installed)).toBe(false);
      expect(installed.defs).toEqual([DEF]);

      expect(() =>
        pruneRandomEvents(
          installed.defs,
          installed.config,
          { pending: [{ name: 'Encounter', armedDay: 0, priority: 0, brief: 'b' }] },
          {},
          0,
        ),
      ).not.toThrow();
    });
  }

  it('补默认不就地改入参（调用方那份包可能还被别处引用）', () => {
    const source = { defs: [DEF] } as unknown as RandomEventPack;
    installRandomEventPack(source);

    expect(source.config).toBeUndefined();
    expect(getRandomEventPack().config).toEqual(DEFAULT_RANDOM_EVENT_CONFIG);
  });

  it('config 完整时原样装上（不多复制一层，也不改旋钮）', () => {
    const pack: RandomEventPack = {
      config: { globalCooldownDays: 9, offerTtlDays: 2, maxPending: 1 },
      defs: [DEF],
    };
    installRandomEventPack(pack);

    expect(getRandomEventPack()).toBe(pack);
  });
});
