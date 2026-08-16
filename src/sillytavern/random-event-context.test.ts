/**
 * random-event-context.test.ts — 注入块数据面的守卫测试（随机事件系统 v1 / 设计 §5.1·§10）
 *
 * 钉的两件事：
 * - **与保洁共用同一份存续判据**：注入块里看得见、库里已经撤掉（或者反过来）都不报错 ——
 *   症状是 AI 触发了一个引擎不认的名字，然后被 `settleRandomEventTrigger` 当幻觉忽略
 * - **排序稳定**：forced 在前、priority 降序、平手保持池内顺序。每回合都重排一次的列表
 *   会让 AI 觉得世界在闪烁（而这不会有任何报错）
 *
 * 措辞（`<random_events>` 外壳 / `[!]` 标记 / 那三句指令）不在本模块，故本文件不断言任何文案。
 */

import { describe, expect, it } from 'vitest';

import { buildRandomEventOffer } from './random-event-context';
import type {
  PendingRandomEvent,
  RandomEventConfig,
  RandomEventDef,
  RandomEventRollContext,
  RandomEventSaveFlags,
} from './types-random-events';

const CONFIG: RandomEventConfig = { globalCooldownDays: 3, offerTtlDays: 5, maxPending: 3 };
const CTX: RandomEventRollContext = { placeKey: 'Harbor', locationPath: 'Northland-Harbor' };

function mtth(name: string, extra: Partial<RandomEventDef> = {}): RandomEventDef {
  return { name, brief: `${name} brief`, trigger: { type: 'mtth', mtthDays: 30 }, ...extra };
}

function entry(name: string, extra: Partial<PendingRandomEvent> = {}): PendingRandomEvent {
  return { name, armedDay: 1, expiresDay: 20, priority: 0, brief: `${name} armed`, ...extra };
}

function offer(
  defs: RandomEventDef[],
  pending: PendingRandomEvent[],
  currentDay = 5,
  ctx: RandomEventRollContext = CTX,
) {
  const flags: RandomEventSaveFlags = { pending };
  return buildRandomEventOffer(defs, CONFIG, flags, ctx, currentDay);
}

describe('buildRandomEventOffer —— 内容', () => {
  it('简报取自**池中固化的那份**（槽位已采样），detail 取自定义', () => {
    const rows = offer([mtth('Rumor', { detail: 'long guidance' })], [entry('Rumor')]);
    expect(rows).toEqual([
      {
        name: 'Rumor',
        priority: 0,
        brief: 'Rumor armed',
        detail: 'long guidance',
        forced: false,
      },
    ]);
  });

  it('定义没有 detail 时不留空格（渲染侧据此决定折不折叠）', () => {
    expect(offer([mtth('Rumor')], [entry('Rumor')])[0].detail).toBeUndefined();
  });

  it('forced 平铺成必填布尔', () => {
    const rows = offer(
      [mtth('Arrival')],
      [entry('Arrival', { forced: true, placeKey: 'Harbor', expiresDay: undefined })],
    );
    expect(rows[0].forced).toBe(true);
  });
});

describe('buildRandomEventOffer —— 过滤（与 pruneRandomEvents 同一份判据）', () => {
  it('过期的非 forced 条目不出现；forced 永不过期', () => {
    const rows = offer(
      [mtth('Old'), mtth('Arrival')],
      [
        entry('Old', { expiresDay: 4 }),
        entry('Arrival', { forced: true, placeKey: 'Harbor', expiresDay: undefined }),
      ],
      5,
    );
    expect(rows.map((r) => r.name)).toEqual(['Arrival']);
  });

  it('定义已不存在的条目不出现（换包后名字对不上）', () => {
    expect(offer([], [entry('Ghost')])).toEqual([]);
  });

  it('available 当前不满足 → 不出现，**含 forced**', () => {
    const gated = {
      available: { var: { path: 'sys.ok', exists: true } },
    } as Partial<RandomEventDef>;
    const rows = offer(
      [mtth('Rumor', gated), mtth('Arrival', gated)],
      [entry('Rumor'), entry('Arrival', { forced: true, placeKey: 'Harbor' })],
    );
    expect(rows).toEqual([]);
  });

  it('权重当前为 0 → 不出现（仅非 forced）', () => {
    const zeroed = {
      weights: [{ when: { location: { anyOf: ['Harbor'] } }, multiply: 0 }],
    } as Partial<RandomEventDef>;
    const rows = offer(
      [mtth('Rumor', zeroed), mtth('Arrival', zeroed)],
      [entry('Rumor'), entry('Arrival', { forced: true, placeKey: 'Harbor' })],
    );
    expect(rows.map((r) => r.name)).toEqual(['Arrival']);
  });

  it('池空 / 日子非有穷 → 空列表（判不了过期就别注入）', () => {
    expect(offer([mtth('Rumor')], [])).toEqual([]);
    expect(offer([mtth('Rumor')], [entry('Rumor')], Number.NaN)).toEqual([]);
  });
});

describe('buildRandomEventOffer —— 排序（forced 优先 → priority 降序 → 池内顺序）', () => {
  it('forced 一律排在前面，哪怕 priority 更低', () => {
    const rows = offer(
      [mtth('Big'), mtth('Arrival')],
      [
        entry('Big', { priority: 9 }),
        entry('Arrival', { priority: 0, forced: true, placeKey: 'Harbor' }),
      ],
    );
    expect(rows.map((r) => r.name)).toEqual(['Arrival', 'Big']);
  });

  it('其后按 priority 降序', () => {
    const rows = offer(
      [mtth('A'), mtth('B'), mtth('C')],
      [entry('A', { priority: 1 }), entry('B', { priority: 7 }), entry('C', { priority: 4 })],
    );
    expect(rows.map((r) => r.name)).toEqual(['B', 'C', 'A']);
  });

  it('平手保持池内顺序（稳定排序 —— 列表不该每回合抖一次）', () => {
    const rows = offer([mtth('A'), mtth('B'), mtth('C')], [entry('A'), entry('B'), entry('C')]);
    expect(rows.map((r) => r.name)).toEqual(['A', 'B', 'C']);
  });
});

describe('buildRandomEventOffer —— 只读', () => {
  it('不改入参 flags（渲染侧只过滤不写库）', () => {
    const flags: RandomEventSaveFlags = {
      pending: [entry('Old', { expiresDay: 1 }), entry('Live')],
    };
    const snapshot = JSON.stringify(flags);
    buildRandomEventOffer([mtth('Live')], CONFIG, flags, CTX, 50);
    expect(JSON.stringify(flags)).toBe(snapshot);
  });
});
