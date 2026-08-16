/**
 * random-event-pack.ts — 随机事件包的容错解析（纯函数，随机事件系统 v1 / 设计 §3.3）
 *
 * 装什么: `coerceRandomEventPack(unknown) → { config, defs }` —— 内容包第 13 分节
 *         `randomEvents` 的收窄口，外加判据 `isEmptyRandomEventPack`。
 * 不装什么: 任何 I/O、任何调度/求值逻辑（在 `random-event-scheduler.ts`）、
 *           任何注入块措辞（在 placeholder resolver，W2）。
 *
 * 🔴 **本模块永不抛**（铁则 4「算不出来保持原值，绝不凭空造」；先例 `coerceMapPack` /
 *    `parseImageDialects` / `workshop-manifest`）。事件定义来自内容包与二创 —— 第三方可编辑、
 *    可整份热替换的数据。一个手滑的字段让整个游戏页白屏是不可接受的。容错口径：
 *      · 坏**定义**整条跳过（坏在哪一格都一样：半条事件没有意义 —— 一条没有 brief 的事件
 *        入了池就是给 AI 一行空白，比不存在更坏）
 *      · 坏**子项**逐条丢（weights 里的一环 / slots 里的一格 / pick 里的一行），定义照留
 *      · 坏**旋钮**只有那一格回落（config 三格互不连坐）
 *      · 整份认不出（null / 数字 / 串 / **数组**）→ 空包
 *
 * 🔴 **空包是合同的一部分，不是异常**（先例 `isEmptyMapPack`）：引擎仓零内置事件
 *    （承内容-引擎分离 v1.3），空分节 → 全部钩子整段 no-op。
 *
 * 🔴 **本文件里不许出现任何中文字面量**（设计 §10 结构闸门，与 `map-*.ts` 同款）：
 *    事件名 / 简报 / 槽位词全是**包数据**，随内容而变。连诊断串也走英文 —— 它们描述的是
 *    数据结构的毛病（给包作者与开发者看），不是给玩家看的文案。
 *
 * 🔴 **重名后装覆盖 + 诊断**（对齐工坊 P2 的「同名后装覆盖、来源可溯」，§8.2）。静默丢掉
 *    先装的那条会让作者以为自己的改动没生效；静默保留先装的那条会让 pack 更新永远不生效。
 *    两种静默都很难查，所以这里**必须出声**。
 *
 * 设计全文: `docs/planning/2026-08-15-random-event-system-design.md`。
 */

import type {
  EventCondition,
  RandomEventConfig,
  RandomEventDef,
  RandomEventTrigger,
  SlotTable,
  WeightModifier,
} from './types-random-events';
import { DEFAULT_RANDOM_EVENT_CONFIG } from './types-random-events';

/** 诊断前缀 —— 与模块名一致，方便在控制台里一眼归堆 */
const LOG_TAG = '[random-event-pack]';

/** `coerceRandomEventPack` 的产物：配置与定义永远都在，只是可能是默认值 / 空数组 */
export interface RandomEventPack {
  config: RandomEventConfig;
  defs: RandomEventDef[];
}

// ═══════════════════════════════════════════════════════════
// 取值原语（照 map-pack.ts：拿不到就给缺省，绝不抛）
// ═══════════════════════════════════════════════════════════

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 数字收窄 —— 认不出返回 `null`。
 *
 * 🔴 堵住 `Number()` 的老三样（`Number('')`/`Number([])`/`Number(true)` 全是合法数字）：
 *    只收「有穷数字」与「非空数字串」。数字串是刻意收的 —— 手写 JSON 里 `"30"` 很常见。
 */
function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (value.trim().length === 0) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 去空白后非空的字符串；认不出返回 `null` */
function readNonEmptyText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ═══════════════════════════════════════════════════════════
// 分项解析
// ═══════════════════════════════════════════════════════════

/**
 * 触发器。两种形态各有一条**必须成立**的硬要求，不满足就让整条定义被跳过：
 *   · `mtth` 要 `mtthDays > 0` —— 0 或负数会让 `p = w / mtthDays` 变成 Infinity 或负数，
 *     前者是「每天必触发」，后者是「永不触发」，两个都不是作者想说的
 *   · `first_visit` 要 `scope.anyOf` 非空（裁定 §13-3 的机器保证）—— 空 scope 等于
 *     「所有地点」，而「引擎内置通用首访」正是被明确否决的那一案
 */
function coerceTrigger(raw: unknown, name: string): RandomEventTrigger | null {
  if (!isRecord(raw)) {
    warn(`${LOG_TAG} def "${name}": trigger is missing or not an object, skipped.`);
    return null;
  }

  if (raw.type === 'mtth') {
    const days = readNumber(raw.mtthDays);
    if (days === null || days <= 0) {
      warn(`${LOG_TAG} def "${name}": mtth trigger needs a finite mtthDays > 0, skipped.`);
      return null;
    }
    return { type: 'mtth', mtthDays: days };
  }

  if (raw.type === 'first_visit') {
    const scope = isRecord(raw.scope) ? raw.scope : null;
    const anyOf = collectNonEmptyTexts(scope?.anyOf);
    if (anyOf.length === 0) {
      warn(`${LOG_TAG} def "${name}": first_visit trigger needs a non-empty scope.anyOf, skipped.`);
      return null;
    }
    return { type: 'first_visit', scope: { anyOf } };
  }

  warn(`${LOG_TAG} def "${name}": unknown trigger.type, skipped.`);
  return null;
}

/** 字符串数组收窄：非数组 → 空；逐条去空白，丢空串，去重保序 */
function collectNonEmptyTexts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const text = readNonEmptyText(item);
    if (text === null || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * 权重修正链。**坏的一环单独丢，其余照留** —— 一条修正写错不该让整个事件消失。
 *
 * 丢环的三种情形：
 *   · 不是对象 / `when` 不是对象 —— 没有条件的修正等于无条件生效，那多半是漏写而不是本意
 *   · `multiply` 认不出 —— 缺省成 1 会让作者以为规则生效了（而它什么也没做）
 *   · `multiply < 0` —— 负权重会让「乘出来的 w」符号翻转，两条负修正相乘还会变正，
 *     整条链的语义直接坏掉。0 是**合法且重要**的（「不在某地 ×0」是设计里的头号用法）
 */
function coerceWeights(raw: unknown, name: string): WeightModifier[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warn(`${LOG_TAG} def "${name}": weights is not an array, ignored.`);
    return [];
  }

  const out: WeightModifier[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isRecord(item) || !isRecord(item.when)) {
      warn(`${LOG_TAG} def "${name}": weights[${i}] has no condition object, dropped.`);
      continue;
    }
    const multiply = readNumber(item.multiply);
    if (multiply === null || multiply < 0) {
      warn(`${LOG_TAG} def "${name}": weights[${i}] needs a finite multiply >= 0, dropped.`);
      continue;
    }
    out.push({ when: item.when as EventCondition, multiply });
  }
  return out;
}

/**
 * 槽位表。`pick` 与 `weights` **成对过滤** —— 只筛 `pick` 会让两个数组错位，
 * 于是「殷勤过头」的权重悄悄落到了「神经兮兮」头上（不报错，只是分布不对）。
 *
 * 一格 `pick` 全废 → 丢掉这个槽（而不是留个空表）：空表在采样时只能产出空串，
 * 而空串替进 brief 就是给 AI 一句缺词的话。丢掉它至少让 `{{槽名}}` 原样留在 brief 里，
 * 是**看得见**的失败。
 */
function coerceSlots(raw: unknown, name: string): Record<string, SlotTable> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    warn(`${LOG_TAG} def "${name}": slots is not an object, ignored.`);
    return {};
  }

  const out: Record<string, SlotTable> = {};
  for (const [slotKey, value] of Object.entries(raw)) {
    if (slotKey.length === 0) continue;
    if (!isRecord(value) || !Array.isArray(value.pick)) {
      warn(`${LOG_TAG} def "${name}": slot "${slotKey}" has no pick array, dropped.`);
      continue;
    }

    const rawWeights = Array.isArray(value.weights) ? value.weights : null;
    const pick: string[] = [];
    const weights: number[] = [];
    for (let i = 0; i < value.pick.length; i++) {
      const label = readNonEmptyText(value.pick[i]);
      if (label === null) continue;
      pick.push(label);
      const weight = rawWeights === null ? null : readNumber(rawWeights[i]);
      // 缺席 / 认不出 / 非正 → 等权 1（丢掉整张表太重：作者只是漏了一格）
      weights.push(weight !== null && weight > 0 ? weight : 1);
    }

    if (pick.length === 0) {
      warn(`${LOG_TAG} def "${name}": slot "${slotKey}" has no usable pick entries, dropped.`);
      continue;
    }

    const table: SlotTable = { pick };
    // 原本就没写 weights 就别补一份等权数组：`undefined` 与「全 1」在采样上等价，
    // 但前者在 diff / 快照里更诚实（作者没写过这个字段）
    if (rawWeights !== null) table.weights = weights;
    out[slotKey] = table;
  }
  return out;
}

/**
 * 单条定义。返回 `null` = 整条跳过（诊断已出声）。
 *
 * 🔴 **`available` 不做深校验**：条件 DSL 的求值器本身就是「认不出的字段忽略、缺数据为假」
 *    的（`evaluateEventCondition`），在这里再实现一遍等于两处各写一套判据 —— 而两套判据
 *    漂移的症状是「pack 里能装进去的条件，运行时求值不认」。这里只确认它是个对象。
 */
function coerceDef(raw: unknown, index: number): RandomEventDef | null {
  if (!isRecord(raw)) {
    warn(`${LOG_TAG} defs[${index}] is not an object, skipped.`);
    return null;
  }

  const name = readNonEmptyText(raw.name);
  if (name === null) {
    warn(`${LOG_TAG} defs[${index}] has no usable name, skipped.`);
    return null;
  }

  const brief = readNonEmptyText(raw.brief);
  if (brief === null) {
    warn(`${LOG_TAG} def "${name}": brief is missing or empty, skipped.`);
    return null;
  }

  const trigger = coerceTrigger(raw.trigger, name);
  if (trigger === null) return null;

  const def: RandomEventDef = { name, brief, trigger };

  const priority = readNumber(raw.priority);
  if (priority !== null) def.priority = priority;

  const detail = readNonEmptyText(raw.detail);
  if (detail !== null) def.detail = detail;

  if (isRecord(raw.available)) def.available = raw.available as EventCondition;
  else if (raw.available !== undefined) {
    warn(`${LOG_TAG} def "${name}": available is not a condition object, ignored.`);
  }

  // `once` 只认真正的 `true`（`'true'` 这种串**不**当真 —— 那是包写错了，不是另一种写法）
  if (raw.once === true) def.once = true;

  const cooldown = readNumber(raw.cooldownDays);
  if (cooldown !== null && cooldown > 0) def.cooldownDays = cooldown;

  const weights = coerceWeights(raw.weights, name);
  if (weights.length > 0) def.weights = weights;

  const slots = coerceSlots(raw.slots, name);
  if (Object.keys(slots).length > 0) def.slots = slots;

  return def;
}

/**
 * 配置三格。每格独立回落（半份配置比整份丢掉有用得多）。
 *
 * 三格都要求**非负整数**：
 *   · 天数是整数量纲（`gameDay` 本身是 `floor` 出来的），小数天会让「冷却还剩多久」
 *     这类比较在边界上随机地翻面
 *   · `maxPending = 0` 是合法的（等于关掉候选池），负数不是
 */
function coerceConfig(raw: unknown, defaults: RandomEventConfig): RandomEventConfig {
  const out: RandomEventConfig = { ...defaults };
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    warn(`${LOG_TAG} config is not an object, defaults used.`);
    return out;
  }

  const keys: (keyof RandomEventConfig)[] = ['globalCooldownDays', 'offerTtlDays', 'maxPending'];
  for (const key of keys) {
    if (raw[key] === undefined) continue;
    const value = readNumber(raw[key]);
    if (value === null || value < 0) {
      warn(`${LOG_TAG} config.${key} needs a finite number >= 0, default ${out[key]} used.`);
      continue;
    }
    out[key] = Math.floor(value);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════

/**
 * 内容包 `randomEvents` 面 → `{ config, defs }`（容错，**永不抛**）。
 *
 * 外层只认对象。`null` / 数字 / 串 / **数组** → 空包（数组刻意不收：外层形状由
 * `PackRandomEventsSection` 声明并由注册表校验器守，解析器只对**内容**宽容 ——
 * 照 `coerceMapPack` 的同款收口）。
 *
 * 🔴 **重名后装覆盖**：后一条替掉前一条并出声。顺序即包里的书写顺序。
 */
export function coerceRandomEventPack(raw: unknown): RandomEventPack {
  const config = coerceConfig(isRecord(raw) ? raw.config : undefined, DEFAULT_RANDOM_EVENT_CONFIG);
  if (!isRecord(raw)) return { config, defs: [] };

  if (raw.defs === undefined) return { config, defs: [] };
  if (!Array.isArray(raw.defs)) {
    warn(`${LOG_TAG} defs is not an array, treated as empty.`);
    return { config, defs: [] };
  }

  const byName = new Map<string, RandomEventDef>();
  for (let i = 0; i < raw.defs.length; i++) {
    const def = coerceDef(raw.defs[i], i);
    if (def === null) continue;
    if (byName.has(def.name)) {
      warn(`${LOG_TAG} duplicate def name "${def.name}", the later one wins.`);
    }
    // Map 的 set 保留**首次插入**的位置：重名后装只换内容不换顺序，
    // 于是「同优先级取 defs 顺序第一条」那类判据不会因为一次改包而悄悄换人
    byName.set(def.name, def);
  }

  return { config, defs: [...byName.values()] };
}

/**
 * 这个包能不能起任何事件。
 *
 * 判据是**零定义**而不是「config 是默认值」：一个只写了 config 的包同样什么都起不了，
 * 而调用方拿它决定「要不要整段跳过随机事件钩子」，问的正是这件事（先例 `isEmptyMapPack`）。
 */
export function isEmptyRandomEventPack(pack: RandomEventPack): boolean {
  return pack.defs.length === 0;
}

// ═══════════════════════════════════════════════════════════
// 诊断
// ═══════════════════════════════════════════════════════════

/**
 * 诊断出口收在一处。
 *
 * 🔴 **诊断本身不许把解析弄崩**：某些宿主（被打过桩的测试环境 / 被裁剪的 worker 全局）
 *    里 `console` 可能缺席，而「永不抛」这条契约不该因为一句 warn 而破。
 */
function warn(message: string): void {
  try {
    console.warn(message);
  } catch {
    // 诊断出口不可用时静默 —— 解析结果比诊断重要（本模块的第一契约是永不抛）
  }
}
