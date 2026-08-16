/**
 * random-event-pack.test.ts — 事件包容错解析的守卫测试（随机事件系统 v1 / 设计 §3.3·§10）
 *
 * 钉的都是「改坏了不报错、只会静默少掉一条事件（或多出一条坏事件）」那一类：
 * - **永不抛**：整份垃圾输入 / 半条定义 / 类型全错的旋钮，一律要拿到合法结果
 * - **坏定义整条跳过、坏子项逐条丢**：两者的边界一旦漂，症状是「作者写错一个权重，
 *   整个事件消失了」或者反过来「一条没有 brief 的事件进了池，AI 看到一行空白」
 * - **重名后装覆盖**：静默丢掉先装的会让作者以为改动没生效；静默保留先装的会让 pack
 *   更新永远不生效。两种静默都难查，所以这里连**诊断出声**都要断言
 * - **`pick` 与 `weights` 成对过滤**：只筛前者会让两个数组错位 —— 不报错，只是分布不对
 *
 * 🔴 **fixture 全用中性英文词**（承 `map-weather.test.ts` / `map-pack.test.ts` 的口径）：
 *    事件名与简报是**包数据**，引擎一个字都不认识。用英文夹具本身就是在证明这件事。
 *    唯一的例外是那条专门验中文槽名的用例（槽名是自由串，正则元字符与 CJK 都得吃得下）。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { coerceRandomEventPack, isEmptyRandomEventPack } from './random-event-pack';
import { DEFAULT_RANDOM_EVENT_CONFIG } from './types-random-events';

// 诊断是本模块的一等产物（坏数据必须出声），但它会把测试输出刷满 —— 全程静音并留住调用记录
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

/** 一条最小可用定义（三个必填格） */
function goodDef(name = 'Merchant') {
  return { name, brief: 'A stranger blocks the road.', trigger: { type: 'mtth', mtthDays: 30 } };
}

// ═══════════════════════════════════════════════════════════
// 永不抛 + 外层形状
// ═══════════════════════════════════════════════════════════

describe('coerceRandomEventPack —— 永不抛（数据来自第三方内容包）', () => {
  it('整份认不出（null/数字/串/数组/布尔）→ 空包 + 默认配置', () => {
    for (const input of [null, undefined, 42, 'nope', [goodDef()], true, Number.NaN]) {
      const pack = coerceRandomEventPack(input);
      expect(pack.defs).toEqual([]);
      expect(pack.config).toEqual(DEFAULT_RANDOM_EVENT_CONFIG);
      expect(isEmptyRandomEventPack(pack)).toBe(true);
    }
  });

  it('数组刻意不收（外层形状由 PackRandomEventsSection 声明，解析器只对内容宽容）', () => {
    expect(coerceRandomEventPack([goodDef()]).defs).toEqual([]);
  });

  it('defs 不是数组 → 空定义 + 出声，config 照样解析', () => {
    const pack = coerceRandomEventPack({ defs: 'lots', config: { maxPending: 9 } });
    expect(pack.defs).toEqual([]);
    expect(pack.config.maxPending).toBe(9);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('defs 缺席 → 空定义且不出声（缺席是合法的三态之一，不是错误）', () => {
    const pack = coerceRandomEventPack({ config: {} });
    expect(pack.defs).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('返回的默认配置不是同一个对象（下游改一格不许污染全局兜底）', () => {
    const a = coerceRandomEventPack({});
    a.config.maxPending = 99;
    expect(coerceRandomEventPack({}).config.maxPending).toBe(
      DEFAULT_RANDOM_EVENT_CONFIG.maxPending,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 坏定义整条跳过
// ═══════════════════════════════════════════════════════════

describe('coerceRandomEventPack —— 坏定义整条跳过（半条事件没有意义）', () => {
  it('跳过：非对象 / 无名字 / 空名字 / 无 brief / 空 brief', () => {
    const pack = coerceRandomEventPack({
      defs: [
        null,
        'text',
        { brief: 'x', trigger: { type: 'mtth', mtthDays: 1 } },
        { name: '   ', brief: 'x', trigger: { type: 'mtth', mtthDays: 1 } },
        { name: 'NoBrief', trigger: { type: 'mtth', mtthDays: 1 } },
        { name: 'EmptyBrief', brief: '  ', trigger: { type: 'mtth', mtthDays: 1 } },
        goodDef('Survivor'),
      ],
    });
    expect(pack.defs.map((d) => d.name)).toEqual(['Survivor']);
  });

  it('跳过：trigger 缺席 / 类型不认识 / mtthDays <= 0 或非有穷', () => {
    const pack = coerceRandomEventPack({
      defs: [
        { name: 'NoTrigger', brief: 'x' },
        { name: 'Weird', brief: 'x', trigger: { type: 'moon_phase' } },
        { name: 'Zero', brief: 'x', trigger: { type: 'mtth', mtthDays: 0 } },
        { name: 'Negative', brief: 'x', trigger: { type: 'mtth', mtthDays: -5 } },
        { name: 'NaNDays', brief: 'x', trigger: { type: 'mtth', mtthDays: Number.NaN } },
        goodDef('Survivor'),
      ],
    });
    expect(pack.defs.map((d) => d.name)).toEqual(['Survivor']);
  });

  it('first_visit 的 scope.anyOf 必填非空（裁定 §13-3 的机器保证）', () => {
    const pack = coerceRandomEventPack({
      defs: [
        { name: 'NoScope', brief: 'x', trigger: { type: 'first_visit' } },
        { name: 'EmptyScope', brief: 'x', trigger: { type: 'first_visit', scope: { anyOf: [] } } },
        {
          name: 'JunkScope',
          brief: 'x',
          trigger: { type: 'first_visit', scope: { anyOf: ['', 3, null] } },
        },
        {
          name: 'Named',
          brief: 'x',
          trigger: { type: 'first_visit', scope: { anyOf: ['Harbor', 'Harbor', ' Keep '] } },
        },
      ],
    });
    expect(pack.defs.map((d) => d.name)).toEqual(['Named']);
    const trigger = pack.defs[0].trigger;
    // 去空白 + 去重保序
    expect(trigger.type === 'first_visit' && trigger.scope.anyOf).toEqual(['Harbor', 'Keep']);
  });

  it('数字串照收（手写 JSON 里 "30" 很常见）', () => {
    const pack = coerceRandomEventPack({
      defs: [{ name: 'Str', brief: 'x', trigger: { type: 'mtth', mtthDays: '30' } }],
    });
    expect(pack.defs[0].trigger).toEqual({ type: 'mtth', mtthDays: 30 });
  });

  it('名字与 brief 去空白（尾随空格永远匹配不上 AI 的逐字回执）', () => {
    const pack = coerceRandomEventPack({
      defs: [{ name: '  Merchant  ', brief: '  hello  ', trigger: { type: 'mtth', mtthDays: 1 } }],
    });
    expect(pack.defs[0].name).toBe('Merchant');
    expect(pack.defs[0].brief).toBe('hello');
  });
});

// ═══════════════════════════════════════════════════════════
// 坏子项逐条丢
// ═══════════════════════════════════════════════════════════

describe('coerceRandomEventPack —— 坏子项逐条丢，定义照留', () => {
  it('weights：坏的一环单独丢（multiply 认不出 / 负数 / 无 when），0 是合法的', () => {
    const pack = coerceRandomEventPack({
      defs: [
        {
          ...goodDef(),
          weights: [
            { when: { journey: true }, multiply: 2 },
            { when: { journey: false }, multiply: 0 },
            { when: { journey: true } },
            { when: { journey: true }, multiply: -1 },
            { multiply: 3 },
            'junk',
          ],
        },
      ],
    });
    expect(pack.defs[0].weights).toEqual([
      { when: { journey: true }, multiply: 2 },
      { when: { journey: false }, multiply: 0 },
    ]);
  });

  it('weights 整节不是数组 → 忽略整节 + 出声，定义照留', () => {
    const pack = coerceRandomEventPack({ defs: [{ ...goodDef(), weights: { a: 1 } }] });
    expect(pack.defs).toHaveLength(1);
    expect(pack.defs[0].weights).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('slots：pick 与 weights 成对过滤（只筛 pick 会让权重错位）', () => {
    const pack = coerceRandomEventPack({
      defs: [
        {
          ...goodDef(),
          slots: { mood: { pick: ['eager', '', 'grim', 42], weights: [5, 99, 1] } },
        },
      ],
    });
    // 第 2 格（空串）连同它的权重 99 一起被丢；第 4 格没有权重 → 回落 1
    expect(pack.defs[0].slots?.mood).toEqual({ pick: ['eager', 'grim'], weights: [5, 1] });
  });

  it('slots：一格全废 → 丢掉那个槽，其余槽照留', () => {
    const pack = coerceRandomEventPack({
      defs: [
        {
          ...goodDef(),
          slots: { dead: { pick: ['', '  '] }, alive: { pick: ['ok'] }, noPick: { weights: [1] } },
        },
      ],
    });
    expect(Object.keys(pack.defs[0].slots ?? {})).toEqual(['alive']);
  });

  it('slots：原本没写 weights 就不补一份等权数组', () => {
    const pack = coerceRandomEventPack({
      defs: [{ ...goodDef(), slots: { mood: { pick: ['a', 'b'] } } }],
    });
    expect(pack.defs[0].slots?.mood).toEqual({ pick: ['a', 'b'] });
  });

  it('available 不是对象 → 忽略那一格 + 出声（不做深校验，判据只有一份在求值器里）', () => {
    const bad = coerceRandomEventPack({ defs: [{ ...goodDef(), available: 'later' }] });
    expect(bad.defs[0].available).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

    const good = coerceRandomEventPack({
      defs: [{ ...goodDef(), available: { var: { path: 'sys.x', exists: true } } }],
    });
    expect(good.defs[0].available).toEqual({ var: { path: 'sys.x', exists: true } });
  });

  it('可选旋钮认不出时整格缺席（不塞一个「看着像那么回事」的默认值）', () => {
    const pack = coerceRandomEventPack({
      defs: [
        {
          ...goodDef(),
          priority: 'high',
          detail: '   ',
          once: 'true',
          cooldownDays: -3,
        },
      ],
    });
    const def = pack.defs[0];
    expect(def.priority).toBeUndefined();
    expect(def.detail).toBeUndefined();
    expect(def.once).toBeUndefined();
    expect(def.cooldownDays).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 重名
// ═══════════════════════════════════════════════════════════

describe('coerceRandomEventPack —— 重名后装覆盖 + 出声', () => {
  it('后一条替掉前一条，并且保持先见到的位置（顺序不因改包而换人）', () => {
    const pack = coerceRandomEventPack({
      defs: [
        { name: 'Dup', brief: 'first', trigger: { type: 'mtth', mtthDays: 10 } },
        { name: 'Other', brief: 'other', trigger: { type: 'mtth', mtthDays: 10 } },
        { name: 'Dup', brief: 'second', trigger: { type: 'mtth', mtthDays: 10 } },
      ],
    });
    expect(pack.defs.map((d) => d.name)).toEqual(['Dup', 'Other']);
    expect(pack.defs[0].brief).toBe('second');
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════

describe('coerceRandomEventPack —— 配置逐格回落（裁定 §13-6 的三个默认值）', () => {
  it('整节缺席 → 三格全默认（3 / 5 / 3）', () => {
    expect(coerceRandomEventPack({ defs: [] }).config).toEqual({
      globalCooldownDays: 3,
      offerTtlDays: 5,
      maxPending: 3,
    });
  });

  it('部分覆盖：只写一格，另外两格仍是默认值', () => {
    expect(coerceRandomEventPack({ config: { offerTtlDays: 12 }, defs: [] }).config).toEqual({
      globalCooldownDays: 3,
      offerTtlDays: 12,
      maxPending: 3,
    });
  });

  it('坏格只回落那一格（负数 / 非数字 / 非有穷）+ 出声', () => {
    const pack = coerceRandomEventPack({
      config: { globalCooldownDays: -1, offerTtlDays: 'five', maxPending: 2 },
      defs: [],
    });
    expect(pack.config).toEqual({ globalCooldownDays: 3, offerTtlDays: 5, maxPending: 2 });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('小数向下取整（天数是整数量纲，小数会让边界比较随机翻面）', () => {
    expect(
      coerceRandomEventPack({ config: { globalCooldownDays: 3.9 }, defs: [] }).config
        .globalCooldownDays,
    ).toBe(3);
  });

  it('0 是合法的（maxPending: 0 等于关掉候选池）', () => {
    expect(coerceRandomEventPack({ config: { maxPending: 0 }, defs: [] }).config.maxPending).toBe(
      0,
    );
  });

  it('config 不是对象 → 全默认 + 出声', () => {
    expect(coerceRandomEventPack({ config: 'default', defs: [] }).config).toEqual(
      DEFAULT_RANDOM_EVENT_CONFIG,
    );
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// 真实形状 + 中文槽名
// ═══════════════════════════════════════════════════════════

describe('coerceRandomEventPack —— 设计 §3.1 的组装事件样例整份过', () => {
  it('中文名字/槽名/简报原样保留（引擎不认识它们，只搬运）', () => {
    const pack = coerceRandomEventPack({
      config: { globalCooldownDays: 2 },
      defs: [
        {
          name: '神秘商人',
          priority: 2,
          trigger: { type: 'mtth', mtthDays: 30 },
          available: { var: { path: 'sys.序章完成', exists: true } },
          slots: {
            货色: { pick: ['来历不明的古代遗物', '违禁的炼金药剂'] },
            态度: { pick: ['殷勤过头', '爱答不理', '神经兮兮'], weights: [2, 1, 1] },
          },
          brief: '一名{{态度}}的神秘商人拦住去路，兜售{{货色}}。',
          weights: [
            { when: { location: { anyOf: ['永夜盟约'] } }, multiply: 0 },
            { when: { playerLevel: { gte: 5 } }, multiply: 1.3 },
          ],
        },
      ],
    });
    expect(pack.defs).toHaveLength(1);
    const def = pack.defs[0];
    expect(def.name).toBe('神秘商人');
    expect(def.priority).toBe(2);
    expect(def.slots?.态度.weights).toEqual([2, 1, 1]);
    expect(def.weights).toHaveLength(2);
    expect(pack.config.globalCooldownDays).toBe(2);
    expect(isEmptyRandomEventPack(pack)).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
