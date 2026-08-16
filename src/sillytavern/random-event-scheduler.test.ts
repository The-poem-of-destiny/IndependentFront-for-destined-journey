/**
 * random-event-scheduler.test.ts — 调度核的守卫测试（随机事件系统 v1 / 设计 §4·§10）
 *
 * 钉的都是「改坏了不报错、只会静默把候选池算错」那一类：
 * - **确定性**：同 `(saveSeed, eventName, gameDay)` 永远同结果。这条一旦破，症状不是报错，
 *   而是快照回退 / 重发之后候选池换了一批（`ejs-rng.ts` 文件头那整段理由）
 * - **逐天迭代**：一次 `delta_time` 跨 10 天要掷 10 次。写成「布尔跨天」同样能跑、同样不报错，
 *   只是长途旅行永远只掷一次骰。本文件用**全局冷却**把这件事变成可逐值断言的
 *   （冷却挡掉前几天 → `armedDay` 必须落在第一个不受冷却的那天，而不是 currentDay）
 * - **硬门槛与情境权重的分工**：`available` 不满足要连骰子都不掷、在池即撤（**含 forced 且
 *   不记足迹**）；`weights ×0` 只管非 forced
 * - **足迹只在触发时记账**：入池时记的话，AI 一直不触发、玩家离开又回来就再也不会强制入池，
 *   「点名地点第一次到必定触发」当场失守
 * - **无变化必须返回 `null`**：返回一份内容相同的新对象不报错，只是每回合都写一次库
 *
 * 🔴 **fixture 全用中性英文词**（承 `map-weather.test.ts` 的口径）：事件名 / 地点名 / 简报
 *    全是**包数据**，引擎一个字都不认识。唯一的例外是专门验中文槽名替换的那几条 ——
 *    槽名是作者写的自由串，CJK 与正则元字符都得吃得下。
 */

import { describe, expect, it } from 'vitest';

import { splitLocationSegments } from './map-index';
import {
  armFirstVisitEvent,
  buildRandomEventSeed,
  computeEventWeight,
  evaluateEventCondition,
  isPendingStillValid,
  pruneRandomEvents,
  rollRandomEvents,
  settleRandomEventTrigger,
} from './random-event-scheduler';
import type {
  EventCondition,
  PendingRandomEvent,
  RandomEventConfig,
  RandomEventDef,
  RandomEventRollContext,
  RandomEventSaveFlags,
} from './types-random-events';

// ═══════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════

const SEED = 'save-a';
const CONFIG: RandomEventConfig = { globalCooldownDays: 3, offerTtlDays: 5, maxPending: 3 };

/** `mtthDays = 1` → `p = min(1, 1/1) = 1` → 必中（`chance(1)` 恒真，见 `ejs-rng`） */
const SURE = 1;
/** `p ≈ 1e-12` → 实质必不中（确定性的，不是概率性的「大概率」） */
const NEVER = 1e12;

function mtth(name: string, mtthDays: number, extra: Partial<RandomEventDef> = {}): RandomEventDef {
  return { name, brief: `${name} happens.`, trigger: { type: 'mtth', mtthDays }, ...extra };
}

function firstVisit(
  name: string,
  places: string[],
  extra: Partial<RandomEventDef> = {},
): RandomEventDef {
  return {
    name,
    brief: `${name} at {{place}}.`,
    trigger: { type: 'first_visit', scope: { anyOf: places } },
    ...extra,
  };
}

const CTX: RandomEventRollContext = { placeKey: 'Harbor', locationPath: 'Northland-Harbor' };

function roll(
  defs: RandomEventDef[],
  flags: RandomEventSaveFlags,
  currentDay: number,
  opts: {
    ctx?: RandomEventRollContext;
    config?: RandomEventConfig;
    frequency?: number;
    saveSeed?: string;
  } = {},
): RandomEventSaveFlags | null {
  return rollRandomEvents(defs, opts.config ?? CONFIG, flags, opts.ctx ?? CTX, {
    saveSeed: opts.saveSeed ?? SEED,
    currentDay,
    frequency: opts.frequency,
  });
}

function names(flags: RandomEventSaveFlags | null): string[] {
  return (flags?.pending ?? []).map((entry) => entry.name);
}

// ═══════════════════════════════════════════════════════════
// 种子
// ═══════════════════════════════════════════════════════════

describe('buildRandomEventSeed —— 长度前缀防撞种', () => {
  it('同三元组同串', () => {
    expect(buildRandomEventSeed('s', 'Merchant', 7)).toBe(buildRandomEventSeed('s', 'Merchant', 7));
  });

  it('分隔符落在数据里也不撞（直拼版本在这一对上会撞）', () => {
    expect(buildRandomEventSeed('a|b', 'c', 1)).not.toBe(buildRandomEventSeed('a', 'b|c', 1));
  });

  it('换事件 / 换日 / 换存档都换串', () => {
    const base = buildRandomEventSeed('s', 'A', 1);
    expect(buildRandomEventSeed('s', 'B', 1)).not.toBe(base);
    expect(buildRandomEventSeed('s', 'A', 2)).not.toBe(base);
    expect(buildRandomEventSeed('t', 'A', 1)).not.toBe(base);
  });

  it('小数日取下整、非有穷读作 0（同一天必须同答案）', () => {
    expect(buildRandomEventSeed('s', 'A', 7.9)).toBe(buildRandomEventSeed('s', 'A', 7));
    expect(buildRandomEventSeed('s', 'A', Number.NaN)).toBe(buildRandomEventSeed('s', 'A', 0));
  });
});

// ═══════════════════════════════════════════════════════════
// 条件 DSL
// ═══════════════════════════════════════════════════════════

describe('evaluateEventCondition —— 每种叶条件', () => {
  const ctx: RandomEventRollContext = {
    placeKey: 'Harbor',
    locationPath: 'Northland-Coast-Harbor',
    journeyActive: true,
    playerLevel: 7,
    season: 'spring',
    timeOfDay: 'night',
    variables: { sys: { prologue: true, gold: 120 }, user: { note: 'x' } },
    quests: { Escort: 'active' },
    affections: { Ally: 40 },
  };

  it('location.anyOf 同时比地点键与位置路径的每一段', () => {
    expect(evaluateEventCondition({ location: { anyOf: ['Harbor'] } }, ctx)).toBe(true);
    expect(evaluateEventCondition({ location: { anyOf: ['Coast'] } }, ctx)).toBe(true);
    expect(evaluateEventCondition({ location: { anyOf: ['Northland'] } }, ctx)).toBe(true);
    expect(evaluateEventCondition({ location: { anyOf: ['Desert'] } }, ctx)).toBe(false);
  });

  /**
   * 🔴 分隔符集必须与 `map-index.splitLocationSegments` **逐字符相同**（正典 `[-－—–/／>＞]`）。
   *    `resolveRandomEventPlaceKey` 用的就是那一份，两处口径不同的症状是「地点键按宽集算、
   *    条件面按窄集算」—— `getLocationPath()` 产出的 `/` 形路径整条读不出段，
   *    作者写下的 `location.anyOf` 永远不中，且两边都不报错。
   */
  it('🔴 位置路径按正典分隔符集分段（`/`、`—`、`>` 与 `-` 同权）', () => {
    const wide = (locationPath: string): RandomEventRollContext => ({ locationPath });

    expect(
      evaluateEventCondition(
        { location: { anyOf: ['Northland'] } },
        wide('Realm/Northland/Harbor'),
      ),
    ).toBe(true);
    expect(
      evaluateEventCondition(
        { location: { anyOf: ['Northland'] } },
        wide('Realm—Northland—Harbor'),
      ),
    ).toBe(true);
    expect(
      evaluateEventCondition(
        { location: { anyOf: ['Northland'] } },
        wide('Realm>Northland>Harbor'),
      ),
    ).toBe(true);
    expect(
      evaluateEventCondition(
        { location: { anyOf: ['Northland'] } },
        wide('Realm／Northland＞Harbor'),
      ),
    ).toBe(true);
    // 反证不是「什么都能中」
    expect(
      evaluateEventCondition({ location: { anyOf: ['Desert'] } }, wide('Realm/Northland/Harbor')),
    ).toBe(false);
    // noneOf 同一张面：宽分隔符下也要能命中并取反
    expect(
      evaluateEventCondition({ location: { noneOf: ['Harbor'] } }, wide('Realm/Northland/Harbor')),
    ).toBe(false);
  });

  it('🔴 分段面与 `map-index.splitLocationSegments` 同源（改一处必红）', () => {
    for (const path of [
      'Realm/Northland/Harbor',
      'Realm—Northland－Harbor',
      'Realm＞Northland>Harbor',
    ]) {
      for (const segment of splitLocationSegments(path)) {
        expect(
          evaluateEventCondition({ location: { anyOf: [segment] } }, { locationPath: path }),
        ).toBe(true);
      }
    }
  });

  it('location.noneOf 取反；两者并存时 AND', () => {
    expect(evaluateEventCondition({ location: { noneOf: ['Desert'] } }, ctx)).toBe(true);
    expect(evaluateEventCondition({ location: { noneOf: ['Coast'] } }, ctx)).toBe(false);
    expect(
      evaluateEventCondition({ location: { anyOf: ['Harbor'], noneOf: ['Coast'] } }, ctx),
    ).toBe(false);
  });

  it('journey 比的是布尔值本身（false 也要命中）', () => {
    expect(evaluateEventCondition({ journey: true }, ctx)).toBe(true);
    expect(evaluateEventCondition({ journey: false }, ctx)).toBe(false);
    expect(evaluateEventCondition({ journey: false }, { journeyActive: false })).toBe(true);
  });

  it('playerLevel 区间（闭区间，两端都可单独给）', () => {
    expect(evaluateEventCondition({ playerLevel: { gte: 5 } }, ctx)).toBe(true);
    expect(evaluateEventCondition({ playerLevel: { gte: 8 } }, ctx)).toBe(false);
    expect(evaluateEventCondition({ playerLevel: { lte: 7 } }, ctx)).toBe(true);
    expect(evaluateEventCondition({ playerLevel: { gte: 5, lte: 6 } }, ctx)).toBe(false);
  });

  it('time 的两格各自 anyOf', () => {
    expect(evaluateEventCondition({ time: { seasonAnyOf: ['spring', 'summer'] } }, ctx)).toBe(true);
    expect(evaluateEventCondition({ time: { seasonAnyOf: ['winter'] } }, ctx)).toBe(false);
    expect(evaluateEventCondition({ time: { timeOfDayAnyOf: ['night'] } }, ctx)).toBe(true);
    expect(
      evaluateEventCondition({ time: { seasonAnyOf: ['spring'], timeOfDayAnyOf: ['dawn'] } }, ctx),
    ).toBe(false);
  });

  it('var：点分路径 + eq/gte/lte/exists', () => {
    expect(evaluateEventCondition({ var: { path: 'sys.prologue', eq: true } }, ctx)).toBe(true);
    expect(evaluateEventCondition({ var: { path: 'sys.prologue', eq: 'true' } }, ctx)).toBe(false);
    expect(evaluateEventCondition({ var: { path: 'sys.gold', gte: 100 } }, ctx)).toBe(true);
    expect(evaluateEventCondition({ var: { path: 'sys.gold', lte: 100 } }, ctx)).toBe(false);
    expect(evaluateEventCondition({ var: { path: 'sys.prologue', exists: true } }, ctx)).toBe(true);
    expect(evaluateEventCondition({ var: { path: 'sys.missing', exists: true } }, ctx)).toBe(false);
  });

  it('var：只写 path = 存在性检查', () => {
    expect(evaluateEventCondition({ var: { path: 'user.note' } }, ctx)).toBe(true);
    expect(evaluateEventCondition({ var: { path: 'user.nope' } }, ctx)).toBe(false);
  });

  it('var：数值算子对非数字值判假（不做隐式转换）', () => {
    expect(evaluateEventCondition({ var: { path: 'user.note', gte: 0 } }, ctx)).toBe(false);
  });

  it('var：只走自有属性（`constructor` 这类原型链路径解析不出东西）', () => {
    expect(evaluateEventCondition({ var: { path: 'constructor' } }, ctx)).toBe(false);
    expect(evaluateEventCondition({ var: { path: 'sys.constructor.name' } }, ctx)).toBe(false);
  });

  it('quest：名字 + statusAnyOf', () => {
    expect(
      evaluateEventCondition({ quest: { name: 'Escort', statusAnyOf: ['active', 'done'] } }, ctx),
    ).toBe(true);
    expect(evaluateEventCondition({ quest: { name: 'Escort', statusAnyOf: ['done'] } }, ctx)).toBe(
      false,
    );
    expect(evaluateEventCondition({ quest: { name: 'Ghost', statusAnyOf: ['active'] } }, ctx)).toBe(
      false,
    );
  });

  it('char：按名字取好感度比区间', () => {
    expect(evaluateEventCondition({ char: { name: 'Ally', affectionGte: 30 } }, ctx)).toBe(true);
    expect(evaluateEventCondition({ char: { name: 'Ally', affectionLte: 30 } }, ctx)).toBe(false);
    expect(evaluateEventCondition({ char: { name: 'Nobody', affectionGte: 0 } }, ctx)).toBe(false);
  });
});

describe('evaluateEventCondition —— 组合与缺数据', () => {
  const ctx: RandomEventRollContext = { placeKey: 'Harbor', playerLevel: 7 };

  it('同一对象内多字段 = AND', () => {
    expect(
      evaluateEventCondition({ location: { anyOf: ['Harbor'] }, playerLevel: { gte: 5 } }, ctx),
    ).toBe(true);
    expect(
      evaluateEventCondition({ location: { anyOf: ['Harbor'] }, playerLevel: { gte: 9 } }, ctx),
    ).toBe(false);
  });

  it('all / any / not', () => {
    const hit: EventCondition = { location: { anyOf: ['Harbor'] } };
    const miss: EventCondition = { location: { anyOf: ['Desert'] } };
    expect(evaluateEventCondition({ all: [hit, hit] }, ctx)).toBe(true);
    expect(evaluateEventCondition({ all: [hit, miss] }, ctx)).toBe(false);
    expect(evaluateEventCondition({ any: [miss, hit] }, ctx)).toBe(true);
    expect(evaluateEventCondition({ any: [miss, miss] }, ctx)).toBe(false);
    expect(evaluateEventCondition({ not: miss }, ctx)).toBe(true);
    expect(evaluateEventCondition({ not: hit }, ctx)).toBe(false);
  });

  it('空 AND 恒真、空 OR 恒假', () => {
    expect(evaluateEventCondition({ all: [] }, ctx)).toBe(true);
    expect(evaluateEventCondition({ any: [] }, ctx)).toBe(false);
  });

  it('空条件对象 = 没有门槛（真）', () => {
    expect(evaluateEventCondition({}, ctx)).toBe(true);
  });

  it('缺数据 = 假（一个还没接线的字段该让事件不触发，而不是无差别放行）', () => {
    const bare: RandomEventRollContext = {};
    expect(evaluateEventCondition({ location: { anyOf: ['Harbor'] } }, bare)).toBe(false);
    expect(evaluateEventCondition({ location: { noneOf: ['Desert'] } }, bare)).toBe(false);
    expect(evaluateEventCondition({ journey: false }, bare)).toBe(false);
    expect(evaluateEventCondition({ playerLevel: { gte: 0 } }, bare)).toBe(false);
    expect(evaluateEventCondition({ time: { seasonAnyOf: ['spring'] } }, bare)).toBe(false);
    expect(evaluateEventCondition({ var: { path: 'a', eq: 1 } }, bare)).toBe(false);
    expect(evaluateEventCondition({ quest: { name: 'q', statusAnyOf: ['x'] } }, bare)).toBe(false);
    expect(evaluateEventCondition({ char: { name: 'c', affectionGte: 1 } }, bare)).toBe(false);
  });

  it('`var.exists: false` 是缺数据规则唯一的例外（它匹配的就是「不存在」）', () => {
    expect(evaluateEventCondition({ var: { path: 'a.b', exists: false } }, {})).toBe(true);
    expect(
      evaluateEventCondition({ var: { path: 'a', exists: false } }, { variables: { a: 1 } }),
    ).toBe(false);
  });

  it('认不出的多余字段忽略、畸形条件对象读作「没有门槛」（不抛）', () => {
    const weird = { madeUpKey: 'x', location: { anyOf: ['Harbor'] } } as EventCondition;
    expect(evaluateEventCondition(weird, ctx)).toBe(true);
    expect(evaluateEventCondition(null as unknown as EventCondition, ctx)).toBe(true);
    expect(evaluateEventCondition('later' as unknown as EventCondition, ctx)).toBe(true);
    expect(evaluateEventCondition([] as unknown as EventCondition, ctx)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 权重
// ═══════════════════════════════════════════════════════════

describe('computeEventWeight', () => {
  it('没有权重链 = 1 × 频率', () => {
    expect(computeEventWeight(mtth('A', 30), CTX, 1)).toBe(1);
    expect(computeEventWeight(mtth('A', 30), CTX, 2)).toBe(2);
  });

  it('命中的修正连乘，未命中的不参与', () => {
    const def = mtth('A', 30, {
      weights: [
        { when: { location: { anyOf: ['Harbor'] } }, multiply: 2 },
        { when: { location: { anyOf: ['Desert'] } }, multiply: 5 },
        { when: {}, multiply: 1.5 },
      ],
    });
    expect(computeEventWeight(def, CTX, 1)).toBe(3);
  });

  it('任一 ×0 即 0（设计里的头号用法：不在某地 ×0）', () => {
    const def = mtth('A', 30, {
      weights: [
        { when: {}, multiply: 4 },
        { when: { location: { anyOf: ['Harbor'] } }, multiply: 0 },
      ],
    });
    expect(computeEventWeight(def, CTX, 5)).toBe(0);
  });

  it('频率 0 → 0；频率非有穷 → 读作 1；负频率夹到 0', () => {
    expect(computeEventWeight(mtth('A', 30), CTX, 0)).toBe(0);
    expect(computeEventWeight(mtth('A', 30), CTX, Number.NaN)).toBe(1);
    expect(computeEventWeight(mtth('A', 30), CTX, -3)).toBe(0);
  });

  it('认不出的修正条目跳过（不让一条坏数据把整条链拖成 0 或 NaN）', () => {
    const def = mtth('A', 30, {
      weights: [
        { when: {}, multiply: Number.NaN },
        { when: {}, multiply: 3 },
      ] as never,
    });
    expect(computeEventWeight(def, CTX, 1)).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════
// MTTH 掷骰
// ═══════════════════════════════════════════════════════════

describe('rollRandomEvents —— 确定性（快照回退/重发的前提）', () => {
  // 简报必须真的含 `{{mood}}` —— 否则「换种子换序列」那条比的是一串常量，恒绿
  const defs = [
    mtth('Sure', SURE, {
      brief: 'Sure: {{mood}}',
      slots: { mood: { pick: ['a', 'b', 'c', 'd'] } },
    }),
  ];

  it('同输入反复调用逐次同结果（含槽位固化后的简报）', () => {
    const first = roll(defs, { lastRollDay: 3 }, 4);
    expect(first).not.toBeNull();
    for (let i = 0; i < 5; i++) {
      expect(roll(defs, { lastRollDay: 3 }, 4)).toEqual(first);
    }
  });

  it('换存档种子 → 换序列（两个存档不该同日同事件同槽位）', () => {
    const a: string[] = [];
    const b: string[] = [];
    for (let day = 1; day <= 40; day++) {
      a.push(roll(defs, { lastRollDay: day - 1 }, day)?.pending?.[0].brief ?? '-');
      b.push(
        roll(defs, { lastRollDay: day - 1 }, day, { saveSeed: 'save-b' })?.pending?.[0].brief ??
          '-',
      );
    }
    expect(b).not.toEqual(a);
  });

  it('不改入参（纯函数）', () => {
    const flags: RandomEventSaveFlags = { lastRollDay: 3, pending: [] };
    const snapshot = JSON.stringify(flags);
    roll(defs, flags, 9);
    expect(JSON.stringify(flags)).toBe(snapshot);
  });
});

describe('rollRandomEvents —— 逐天走 + 全局冷却', () => {
  const defs = [mtth('Sure', SURE)];

  it('首次 ensure：lastRollDay 缺席 → 置当天且不补历史（不掷一次骰）', () => {
    const next = roll(defs, {}, 300);
    expect(next).toEqual({ lastRollDay: 300 });
  });

  it('全局冷却压制 MTTH，冷却一过的**那一天**入池（证明是逐天迭代而不是布尔跨天）', () => {
    // lastTriggerDay=0、冷却 3 天 → 第 1/2 天被压制，第 3 天放行；currentDay=5 时
    // 「布尔跨天」实现会把 armedDay 记成 5，逐天迭代记成 3
    const next = roll(defs, { lastRollDay: 0, lastTriggerDay: 0 }, 5);
    expect(next?.pending).toHaveLength(1);
    expect(next?.pending?.[0].armedDay).toBe(3);
    expect(next?.pending?.[0].expiresDay).toBe(3 + CONFIG.offerTtlDays);
    expect(next?.lastRollDay).toBe(5);
  });

  it('整段都在冷却里 → 只推进 lastRollDay，不入池', () => {
    const next = roll(defs, { lastRollDay: 0, lastTriggerDay: 0 }, 2);
    expect(next).toEqual({ lastRollDay: 2, lastTriggerDay: 0 });
  });

  it('冷却只管 MTTH：冷却期内首访照样能强制入池（§4.2 与 §4.1 互不干涉）', () => {
    const flags: RandomEventSaveFlags = { lastRollDay: 0, lastTriggerDay: 0 };
    expect(roll(defs, flags, 2)?.pending ?? []).toHaveLength(0);
    const forced = armFirstVisitEvent([firstVisit('Arrival', ['Harbor'])], flags, CTX, {
      placeKey: 'Harbor',
      currentDay: 2,
      saveSeed: SEED,
    });
    expect(names(forced)).toEqual(['Arrival']);
  });

  it('无事发生 → null（返回一份相同的新对象会让每回合都写一次库）', () => {
    expect(roll([mtth('Never', NEVER)], { lastRollDay: 5 }, 5)).toBeNull();
    expect(roll([], { lastRollDay: 5 }, 5)).toBeNull();
  });

  it('currentDay 非有穷 → null（不拿一个假日子往下算）', () => {
    expect(roll(defs, { lastRollDay: 1 }, Number.NaN)).toBeNull();
  });
});

describe('rollRandomEvents —— 掷骰前的四道门', () => {
  it('available 不满足 → 连骰子都不掷', () => {
    const defs = [mtth('Gated', SURE, { available: { var: { path: 'sys.ok', exists: true } } })];
    expect(roll(defs, { lastRollDay: 0 }, 1)?.pending ?? []).toHaveLength(0);

    const ctx: RandomEventRollContext = { ...CTX, variables: { sys: { ok: 1 } } };
    expect(names(roll(defs, { lastRollDay: 0 }, 1, { ctx }))).toEqual(['Gated']);
  });

  it('权重 ×0 → 不入池；换个地方就入池', () => {
    const defs = [
      mtth('Local', SURE, {
        weights: [{ when: { location: { anyOf: ['Harbor'] } }, multiply: 0 }],
      }),
    ];
    expect(roll(defs, { lastRollDay: 0 }, 1)?.pending ?? []).toHaveLength(0);
    expect(names(roll(defs, { lastRollDay: 0 }, 1, { ctx: { placeKey: 'Keep' } }))).toEqual([
      'Local',
    ]);
  });

  it('频率系数 0 → 全部不入池（总开关之外的「口味旋钮」）', () => {
    expect(
      roll([mtth('Sure', SURE)], { lastRollDay: 0 }, 1, { frequency: 0 })?.pending ?? [],
    ).toHaveLength(0);
  });

  it('once 已触发过 → 永不再入池', () => {
    const defs = [mtth('Unique', SURE, { once: true })];
    const fired = { Unique: { count: 1, lastDay: 2 } };
    expect(roll(defs, { lastRollDay: 0, fired }, 50)?.pending ?? []).toHaveLength(0);
    // 没有 once 标记时，同样的档案不挡它
    expect(names(roll([mtth('Unique', SURE)], { lastRollDay: 0, fired }, 50))).toEqual(['Unique']);
  });

  it('个体冷却：未过不入池，过了就入池（与全局冷却各算各的）', () => {
    const defs = [mtth('Repeat', SURE, { cooldownDays: 10 })];
    const fired = { Repeat: { count: 1, lastDay: 0 } };
    expect(roll(defs, { lastRollDay: 4, fired }, 5)?.pending ?? []).toHaveLength(0);
    const late = roll(defs, { lastRollDay: 9, fired }, 10);
    expect(names(late)).toEqual(['Repeat']);
    expect(late?.pending?.[0].armedDay).toBe(10);
  });

  it('已在池中 → 不重复入池', () => {
    const flags: RandomEventSaveFlags = {
      lastRollDay: 0,
      pending: [{ name: 'Sure', armedDay: 0, expiresDay: 99, priority: 0, brief: 'old' }],
    };
    const next = roll([mtth('Sure', SURE)], flags, 5);
    expect(next?.pending).toHaveLength(1);
    expect(next?.pending?.[0].brief).toBe('old');
  });
});

describe('rollRandomEvents —— 池满淘汰（forced 免疫）', () => {
  const highPriority = [mtth('Big', SURE, { priority: 5 })];

  it('撤掉 priority 最低的非 forced 条目', () => {
    const flags: RandomEventSaveFlags = {
      lastRollDay: 0,
      pending: [
        { name: 'Low', armedDay: 0, expiresDay: 99, priority: 1, brief: 'low' },
        { name: 'Mid', armedDay: 0, expiresDay: 99, priority: 3, brief: 'mid' },
      ],
    };
    const next = roll(highPriority, flags, 1, {
      config: { ...CONFIG, maxPending: 2 },
    });
    expect(names(next)).toEqual(['Mid', 'Big']);
  });

  it('forced 永不被淘汰：池子全是 forced 且已满 → 新的那条自己被撤（等价于不入池）', () => {
    const flags: RandomEventSaveFlags = {
      lastRollDay: 0,
      pending: [
        { name: 'Arrival', armedDay: 0, forced: true, placeKey: 'Harbor', priority: 0, brief: 'f' },
      ],
    };
    const next = roll(highPriority, flags, 1, { config: { ...CONFIG, maxPending: 1 } });
    // 只有 lastRollDay 变了，池子原样
    expect(names(next)).toEqual(['Arrival']);
  });

  it('同 priority 平手时撤刚入池的那条（老候选已经在注入块里给 AI 看过了）', () => {
    const flags: RandomEventSaveFlags = {
      lastRollDay: 0,
      pending: [{ name: 'Old', armedDay: 0, expiresDay: 99, priority: 5, brief: 'old' }],
    };
    const next = roll(highPriority, flags, 1, { config: { ...CONFIG, maxPending: 1 } });
    expect(names(next)).toEqual(['Old']);
  });
});

describe('rollRandomEvents —— 回退护栏（§7）', () => {
  it('lastRollDay > currentDay 视为快照回退：重置并清掉非 forced 池', () => {
    const flags: RandomEventSaveFlags = {
      lastRollDay: 100,
      pending: [
        { name: 'Future', armedDay: 90, expiresDay: 95, priority: 0, brief: 'future' },
        {
          name: 'Arrival',
          armedDay: 90,
          forced: true,
          placeKey: 'Harbor',
          priority: 0,
          brief: 'f',
        },
      ],
    };
    const next = roll([], flags, 50);
    expect(next?.lastRollDay).toBe(50);
    expect(names(next)).toEqual(['Arrival']);
  });

  it('回退后不补掷（`(lastRollDay, currentDay]` 是空区间）', () => {
    const next = roll([mtth('Sure', SURE)], { lastRollDay: 100 }, 50);
    expect(next?.pending ?? []).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 槽位与简报
// ═══════════════════════════════════════════════════════════

describe('rollRandomEvents —— 槽位采样与简报固化', () => {
  it('中文槽名 + {{place}} 一次性替换（槽名是自由串，不走正则）', () => {
    const def = mtth('神秘商人', SURE, {
      brief: '一名{{态度}}的商人在{{place}}兜售{{货色}}。',
      slots: { 态度: { pick: ['殷勤过头'] }, 货色: { pick: ['违禁的炼金药剂'] } },
    });
    const next = roll([def], { lastRollDay: 0 }, 1);
    expect(next?.pending?.[0].brief).toBe('一名殷勤过头的商人在Harbor兜售违禁的炼金药剂。');
  });

  it('`{{slot.槽名}}` 写法同样认（设计正文与示例给的是两种形态）', () => {
    const def = mtth('A', SURE, {
      brief: 'sells {{slot.goods}} twice: {{goods}}',
      slots: { goods: { pick: ['relics'] } },
    });
    expect(roll([def], { lastRollDay: 0 }, 1)?.pending?.[0].brief).toBe(
      'sells relics twice: relics',
    );
  });

  it('地点键缺席 → {{place}} 换成空串（不留下一个尖括号给玩家看见）', () => {
    const def = mtth('A', SURE, { brief: 'at [{{place}}]' });
    const next = roll([def], { lastRollDay: 0 }, 1, { ctx: {} });
    expect(next?.pending?.[0].brief).toBe('at []');
  });

  it('槽位表没有一行可用 → 占位符原样留着（看得见的失败胜过静默的空串）', () => {
    const def = mtth('A', SURE, {
      brief: 'sells {{goods}}',
      slots: { goods: { pick: [] } },
    });
    expect(roll([def], { lastRollDay: 0 }, 1)?.pending?.[0].brief).toBe('sells {{goods}}');
  });

  it('加权表真的被尊重（9:1 在 300 次入池里落在 90% ± 5pp）', () => {
    const def = mtth('A', SURE, {
      brief: '{{mood}}',
      slots: { mood: { pick: ['common', 'rare'], weights: [9, 1] } },
    });
    const picks: string[] = [];
    for (let day = 1; day <= 300; day++) {
      picks.push(roll([def], { lastRollDay: day - 1 }, day)?.pending?.[0].brief ?? '-');
    }
    const share = picks.filter((p) => p === 'common').length / picks.length;
    expect(share, `common share = ${share}`).toBeGreaterThan(0.85);
    expect(share, `common share = ${share}`).toBeLessThan(0.95);
    // 两个标签都出现过 —— 恒取一行同样能通过上面的区间之外的某些实现
    expect(new Set(picks).size).toBe(2);
  });

  it('多槽事件逐槽独立采样（顺序 = 书写顺序，重放稳定）', () => {
    const def = mtth('A', SURE, {
      brief: '{{one}}/{{two}}',
      slots: { one: { pick: ['a', 'b'] }, two: { pick: ['x', 'y'] } },
    });
    const briefs = new Set<string>();
    for (let day = 1; day <= 60; day++) {
      briefs.add(roll([def], { lastRollDay: day - 1 }, day)?.pending?.[0].brief ?? '-');
    }
    expect(briefs.size).toBeGreaterThan(2);
  });
});

// ═══════════════════════════════════════════════════════════
// 首访强制
// ═══════════════════════════════════════════════════════════

function arm(
  defs: RandomEventDef[],
  flags: RandomEventSaveFlags,
  placeKey: string,
  currentDay = 10,
  ctx: RandomEventRollContext = { placeKey, locationPath: placeKey },
): RandomEventSaveFlags | null {
  return armFirstVisitEvent(defs, flags, ctx, { placeKey, currentDay, saveSeed: SEED });
}

describe('armFirstVisitEvent —— 点名地点首访必入池（§4.2）', () => {
  const defs = [firstVisit('Arrival', ['Harbor', 'Keep'])];

  it('入池条目是 forced、带 placeKey、**不设过期**、简报里的 {{place}} 已替换', () => {
    const next = arm(defs, {}, 'Harbor');
    expect(next?.pending).toHaveLength(1);
    const entry = next?.pending?.[0] as PendingRandomEvent;
    expect(entry.forced).toBe(true);
    expect(entry.placeKey).toBe('Harbor');
    expect(entry.expiresDay).toBeUndefined();
    expect(entry.armedDay).toBe(10);
    expect(entry.brief).toBe('Arrival at Harbor.');
  });

  it('scope 没点名这个地点 → 什么也不做（普通新地点不起事件是有意语义，裁定 §13-3）', () => {
    expect(arm(defs, {}, 'Desert')).toBeNull();
  });

  it('足迹里已有 → 不再入池', () => {
    expect(arm(defs, { visited: ['Harbor'] }, 'Harbor')).toBeNull();
  });

  it('池中已有本地点的 forced 条目 → 不重复入池', () => {
    const flags: RandomEventSaveFlags = {
      pending: [
        { name: 'Arrival', armedDay: 1, forced: true, placeKey: 'Harbor', priority: 0, brief: 'x' },
      ],
    };
    expect(arm(defs, flags, 'Harbor')).toBeNull();
  });

  it('离开即撤：到别处时撤掉上一处的 forced 条目（人都走了，首访遭遇不再成立）', () => {
    const flags: RandomEventSaveFlags = {
      pending: [
        { name: 'Arrival', armedDay: 1, forced: true, placeKey: 'Harbor', priority: 0, brief: 'x' },
        { name: 'Rumor', armedDay: 1, expiresDay: 9, priority: 0, brief: 'y' },
      ],
    };
    const next = arm(defs, flags, 'Desert');
    expect(names(next)).toEqual(['Rumor']);
  });

  it('到一个去过的地方同样会撤掉上一处的 forced（撤池先于足迹判断）', () => {
    const flags: RandomEventSaveFlags = {
      visited: ['Keep'],
      pending: [
        { name: 'Arrival', armedDay: 1, forced: true, placeKey: 'Harbor', priority: 0, brief: 'x' },
      ],
    };
    expect(names(arm(defs, flags, 'Keep'))).toEqual([]);
  });

  it('同键多条命中取 priority 最高，平手取 defs 顺序第一条', () => {
    const many = [
      firstVisit('Low', ['Harbor'], { priority: 1 }),
      firstVisit('High', ['Harbor'], { priority: 9 }),
      firstVisit('AlsoHigh', ['Harbor'], { priority: 9 }),
    ];
    expect(names(arm(many, {}, 'Harbor'))).toEqual(['High']);

    const tie = [firstVisit('First', ['Harbor']), firstVisit('Second', ['Harbor'])];
    expect(names(arm(tie, {}, 'Harbor'))).toEqual(['First']);
  });

  it('available 不满足的定义不进选择（首访事件唯一的门）', () => {
    const gated = [
      firstVisit('Gated', ['Harbor'], { available: { var: { path: 'sys.ok', exists: true } } }),
      firstVisit('Open', ['Harbor'], { priority: -1 }),
    ];
    expect(names(arm(gated, {}, 'Harbor'))).toEqual(['Open']);

    const ctx: RandomEventRollContext = { placeKey: 'Harbor', variables: { sys: { ok: true } } };
    expect(names(arm(gated, {}, 'Harbor', 10, ctx))).toEqual(['Gated']);
  });

  it('once 已触发过的定义不再强制入池', () => {
    const flags: RandomEventSaveFlags = { fired: { Arrival: { count: 1, lastDay: 3 } } };
    expect(arm([firstVisit('Arrival', ['Harbor'], { once: true })], flags, 'Harbor')).toBeNull();
  });

  it('地点键为空 / 日子非有穷 → null（落位失败时接线层给的就是空串）', () => {
    expect(arm(defs, {}, '')).toBeNull();
    expect(arm(defs, {}, 'Harbor', Number.NaN)).toBeNull();
  });

  it('确定性：同 (存档, 事件, 日子) 重放同一份简报', () => {
    const def = firstVisit('Arrival', ['Harbor'], {
      brief: '{{mood}} at {{place}}',
      slots: { mood: { pick: ['a', 'b', 'c', 'd', 'e'] } },
    });
    const first = arm([def], {}, 'Harbor');
    expect(arm([def], {}, 'Harbor')).toEqual(first);
  });
});

// ═══════════════════════════════════════════════════════════
// 池子保洁
// ═══════════════════════════════════════════════════════════

function prune(
  defs: RandomEventDef[],
  flags: RandomEventSaveFlags,
  currentDay: number,
  ctx: RandomEventRollContext = CTX,
): RandomEventSaveFlags | null {
  return pruneRandomEvents(defs, CONFIG, flags, ctx, currentDay);
}

describe('pruneRandomEvents —— 池子保洁（§4.3）', () => {
  const defs = [mtth('Rumor', 30), firstVisit('Arrival', ['Harbor'])];
  const rumor: PendingRandomEvent = {
    name: 'Rumor',
    armedDay: 1,
    expiresDay: 6,
    priority: 0,
    brief: 'r',
  };
  const arrival: PendingRandomEvent = {
    name: 'Arrival',
    armedDay: 1,
    forced: true,
    placeKey: 'Harbor',
    priority: 0,
    brief: 'a',
  };

  it('过期的非 forced 条目撤下；同一天不算过期', () => {
    expect(prune(defs, { pending: [rumor] }, 6)).toBeNull();
    expect(names(prune(defs, { pending: [rumor] }, 7))).toEqual([]);
  });

  it('forced 条目不过期（它的撤池条件是「离开」，不是时间）', () => {
    expect(prune(defs, { pending: [arrival] }, 9999)).toBeNull();
  });

  it('缺 expiresDay 的非 forced 条目按 armedDay + offerTtlDays 补算', () => {
    const noExpiry: PendingRandomEvent = { name: 'Rumor', armedDay: 1, priority: 0, brief: 'r' };
    expect(prune(defs, { pending: [noExpiry] }, 6)).toBeNull();
    expect(names(prune(defs, { pending: [noExpiry] }, 7))).toEqual([]);
  });

  it('定义已不存在 → 撤下（换包后名字对不上，铁则 4）', () => {
    expect(names(prune([], { pending: [rumor, arrival] }, 2))).toEqual([]);
  });

  it('available 当前不满足 → 撤下，**含 forced**，且不记足迹', () => {
    const gated = [
      mtth('Rumor', 30, { available: { var: { path: 'sys.ok', exists: true } } }),
      firstVisit('Arrival', ['Harbor'], {
        available: { var: { path: 'sys.ok', exists: true } },
      }),
    ];
    const next = prune(gated, { pending: [rumor, arrival] }, 2);
    expect(names(next)).toEqual([]);
    expect(next?.visited).toBeUndefined();
  });

  it('权重当前为 0 → 撤下（仅非 forced；forced 不受权重管）', () => {
    const zeroed = [
      mtth('Rumor', 30, { weights: [{ when: { location: { anyOf: ['Harbor'] } }, multiply: 0 }] }),
      firstVisit('Arrival', ['Harbor'], {
        weights: [{ when: { location: { anyOf: ['Harbor'] } }, multiply: 0 }],
      }),
    ];
    expect(names(prune(zeroed, { pending: [rumor, arrival] }, 2))).toEqual(['Arrival']);
  });

  it('无变化 → null；日子非有穷 → null', () => {
    expect(prune(defs, { pending: [rumor, arrival] }, 2)).toBeNull();
    expect(prune(defs, { pending: [rumor] }, Number.NaN)).toBeNull();
  });

  it('保洁不动其它字段', () => {
    const flags: RandomEventSaveFlags = {
      pending: [rumor],
      lastRollDay: 5,
      lastTriggerDay: 1,
      visited: ['Keep'],
      fired: { Rumor: { count: 1, lastDay: 1 } },
    };
    const next = prune(defs, flags, 99);
    expect(next?.pending).toBeUndefined();
    expect(next?.lastRollDay).toBe(5);
    expect(next?.lastTriggerDay).toBe(1);
    expect(next?.visited).toEqual(['Keep']);
    expect(next?.fired).toEqual({ Rumor: { count: 1, lastDay: 1 } });
  });
});

// ═══════════════════════════════════════════════════════════
// 存续判据（保洁与渲染共用）
// ═══════════════════════════════════════════════════════════

describe('isPendingStillValid —— 保洁与渲染共用的同一份判据', () => {
  const entry: PendingRandomEvent = {
    name: 'Rumor',
    armedDay: 1,
    expiresDay: 6,
    priority: 0,
    brief: 'r',
  };

  it('定义缺失 → 假', () => {
    expect(isPendingStillValid(entry, undefined, CTX, { currentDay: 2, offerTtlDays: 5 })).toBe(
      false,
    );
  });

  it('过期边界：currentDay > expiresDay 才算过期', () => {
    const def = mtth('Rumor', 30);
    expect(isPendingStillValid(entry, def, CTX, { currentDay: 6, offerTtlDays: 5 })).toBe(true);
    expect(isPendingStillValid(entry, def, CTX, { currentDay: 7, offerTtlDays: 5 })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 触发结算
// ═══════════════════════════════════════════════════════════

describe('settleRandomEventTrigger —— §5.2 步 1-4', () => {
  const pending: PendingRandomEvent[] = [
    { name: 'Rumor', armedDay: 1, expiresDay: 6, priority: 0, brief: 'r' },
    { name: 'Other', armedDay: 1, expiresDay: 6, priority: 3, brief: 'o' },
    { name: 'Arrival', armedDay: 1, forced: true, placeKey: 'Harbor', priority: 9, brief: 'a' },
  ];

  it('名字不在池中 → null（AI 幻觉触发不奖励）', () => {
    expect(settleRandomEventTrigger({ pending }, 'Ghost', 5)).toBeNull();
    expect(settleRandomEventTrigger({}, 'Rumor', 5)).toBeNull();
    expect(settleRandomEventTrigger({ pending }, '   ', 5)).toBeNull();
  });

  it('记档案 + 起全局冷却 + 清掉全部非 forced（一次触发一波，裁定 §13-5）', () => {
    const result = settleRandomEventTrigger({ pending, lastRollDay: 5 }, 'Rumor', 5);
    expect(result).not.toBeNull();
    expect(result?.triggered.name).toBe('Rumor');
    expect(result?.flags.fired).toEqual({ Rumor: { count: 1, lastDay: 5 } });
    expect(result?.flags.lastTriggerDay).toBe(5);
    expect(result?.flags.lastRollDay).toBe(5);
    // forced 条目留着（首访还没兑现），非 forced 全清
    expect((result?.flags.pending ?? []).map((e) => e.name)).toEqual(['Arrival']);
  });

  it('触发档案累加（个体冷却与 once 的依据）', () => {
    const flags: RandomEventSaveFlags = { pending, fired: { Rumor: { count: 2, lastDay: 1 } } };
    const result = settleRandomEventTrigger(flags, 'Rumor', 8);
    expect(result?.flags.fired?.Rumor).toEqual({ count: 3, lastDay: 8 });
  });

  it('触发的正是 forced 条目 → 它自己也出池，并把 placeKey 记进足迹', () => {
    const result = settleRandomEventTrigger({ pending }, 'Arrival', 5);
    expect(result?.flags.pending).toBeUndefined();
    expect(result?.flags.visited).toEqual(['Harbor']);
  });

  it('足迹不重复记（同一地点触发两次也只有一条）', () => {
    const result = settleRandomEventTrigger({ pending, visited: ['Harbor'] }, 'Arrival', 5);
    expect(result?.flags.visited).toEqual(['Harbor']);
  });

  it('结算后同一地点不再强制入池（足迹闭环）', () => {
    const settled = settleRandomEventTrigger({ pending }, 'Arrival', 5);
    expect(arm([firstVisit('Arrival', ['Harbor'])], settled?.flags ?? {}, 'Harbor', 6)).toBeNull();
  });

  it('不改入参', () => {
    const flags: RandomEventSaveFlags = { pending: [...pending] };
    const snapshot = JSON.stringify(flags);
    settleRandomEventTrigger(flags, 'Rumor', 5);
    expect(JSON.stringify(flags)).toBe(snapshot);
  });
});
