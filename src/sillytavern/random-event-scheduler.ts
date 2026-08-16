/**
 * random-event-scheduler.ts — 随机事件的确定性调度核（纯函数，随机事件系统 v1 / 设计 §4）
 *
 * 装什么: 「现在池子里该有哪些候选」这一个问题的全部答案 —— MTTH 逐天掷骰
 *         （`rollRandomEvents`）、首访强制入池（`armFirstVisitEvent`）、池子保洁
 *         （`pruneRandomEvents`）、触发结算的纯逻辑（`settleRandomEventTrigger`），
 *         外加两个被上面四个共用的判据（`evaluateEventCondition` 条件 DSL /
 *         `computeEventWeight` 权重链）与种子编码（`buildRandomEventSeed`）。
 * 不装什么: 任何 I/O、任何存储、任何写入、任何**措辞**。上下文快照的组装在 StateManager
 *           侧（要碰中文变量路径与 profile，理由同 `projectLocationFlags`），注入块的中文
 *           外壳在 placeholder resolver，落库在 `save-profile` 四件套 —— 全是 W2 的事。
 *
 * 🔴 **零存储、零时钟、零 `Math.random`**（铁则 3）：掷骰种子 = `(saveSeed, eventName, gameDay)`，
 *    同三元组永远同结果 —— 快照回退 / 重发天然一致（整段理由见 `ejs-rng.ts` 文件头）。随机数
 *    因此**复用** `createEjsRng`，不另造一条序列。`random-event-scheduler.test.ts` 里有结构
 *    闸门扫本文件源码，把随机与时钟钉死。
 *
 * 🔴 **零中文字面量**（设计 §10，与 `map-*.ts` 同款闸门）：事件名 / 简报 / 槽位词 / 地点名
 *    全是**包数据**。这里写下任何一个中文串，都是把内容焊回引擎 —— 换一份内容包它不跟着变。
 *    唯一的例外是 `{{place}}` 这个 ASCII 占位符，它是**协议**不是内容。
 *
 * 🔴 **纯：绝不改入参，改了就返回一份全新的 flags**。四个入口一律「无变化返回 `null`」——
 *    调用方据此决定「要不要落库」（形状照三条地图钩子：空包 no-op / 有变化才落库）。
 *    返回 `null` 与返回一份内容相同的新对象在语义上完全不同：后者会让每一回合都写一次库。
 *
 * 🔴 **缺数据 = 条件为假**（`evaluateEventCondition` 那条契约）。一个还没接线的上下文字段
 *    应该让事件**不触发**，而不是让全部事件无差别放行 —— 后者的症状是「刚开局就被十件事
 *    同时砸中」，而且没人会想到去查那个字段有没有供值。
 *
 * 设计全文: `docs/planning/2026-08-15-random-event-system-design.md`（§4 调度器 / §7 回退
 * 一致性 / §10 测试）。
 */

import { createEjsRng, type EjsRng } from './ejs-rng';
import { splitLocationSegments } from './map-index';
import type {
  EventCondition,
  PendingRandomEvent,
  RandomEventConfig,
  RandomEventDef,
  RandomEventRollContext,
  RandomEventSaveFlags,
  SlotTable,
} from './types-random-events';

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/** 简报里的地点占位符 —— **协议不是内容**（ASCII，随内容包换不掉） */
const PLACE_TOKEN = 'place';

/** 槽位占位符的另一种写法（设计 §3.1 正文用 `{{slot.槽名}}`、示例用 `{{槽名}}`，两种都认） */
const SLOT_TOKEN_PREFIX = 'slot.';

/**
 * 逐天走的天数上限。
 *
 * 🔴 这不是玩法参数，是**防挂死的护栏**：`lastRollDay` 住在存档里，一次坏写入
 *    （或一次手改存档）就能让它落后当前日 10 亿天，而循环体里有 N 条定义要求值。
 *    超出上限时从「当前日往回数 MAX_ROLL_WALK_DAYS 天」开始走 —— 漏掉的那些天本来
 *    也已经无意义（设计 §4.1 明说首次 ensure **不补历史**，这是同一条取舍的延伸）。
 */
const MAX_ROLL_WALK_DAYS = 3650;

// ═══════════════════════════════════════════════════════════
// 种子
// ═══════════════════════════════════════════════════════════

/**
 * 种子串 = `(saveSeed, eventName, gameDay)` 三元组的**无歧义**编码（照抄 `buildWeatherSeed`）。
 *
 * 🔴 每段带长度前缀，不是简单拼接：`a|b#1` 这种直拼会让「事件 `a|b` 第 1 天」与「事件 `a`
 *    第 `b#1` 天」撞成同一个种子。分隔符是内容数据里可能出现的字符，长度前缀不是。
 *    撞种子的症状是两个事件共享同一条掷骰序列 —— 看着完全正常，只是它们总是同时触发。
 *
 * 🔴 天粒度取下整、非有穷读作 0：同一天的两次掷骰（比如同一回合里两次 `delta_time`）
 *    必须拿到同一个答案。
 */
export function buildRandomEventSeed(saveSeed: string, eventName: string, gameDay: number): string {
  const seed = typeof saveSeed === 'string' ? saveSeed : '';
  const name = typeof eventName === 'string' ? eventName : '';
  const day = Number.isFinite(gameDay) ? Math.floor(gameDay) : 0;
  return `${seed.length}:${seed}|${name.length}:${name}|${day}`;
}

// ═══════════════════════════════════════════════════════════
// 条件 DSL
// ═══════════════════════════════════════════════════════════

/**
 * 声明式条件求值。**同一对象内多字段 = AND**。
 *
 * 两条贯穿全局的契约：
 *   · **缺数据 = 假**（保守）—— 唯一例外是 `var.exists === false`，它匹配的正是「不存在」。
 *     理由见文件头：放行比不触发坏得多，而且放行的失败是无声的。
 *   · **认不出的字段忽略、绝不抛** —— 条件来自第三方内容包；一条写错的条件不该让整轮调度崩。
 *
 * 🔴 条件对象本身不是对象（`null` / 串 / 数组）时返回 `true`（= 没有门槛），
 *    **不是** `false`：这一层是「有没有条件」的问题，不是「条件成不成立」的问题。
 *    把畸形条件读成「永不满足」会让一条打错字的 `available` 静默废掉整个事件，
 *    而 `coerceRandomEventPack` 已经在装载时对它出过声了。
 */
export function evaluateEventCondition(cond: EventCondition, ctx: RandomEventRollContext): boolean {
  if (!isObjectLike(cond)) return true;

  if (cond.location !== undefined && !matchLocation(cond.location, ctx)) return false;
  if (cond.journey !== undefined && ctx.journeyActive !== cond.journey) return false;
  if (cond.playerLevel !== undefined && !matchRange(cond.playerLevel, ctx.playerLevel))
    return false;
  if (cond.time !== undefined && !matchTime(cond.time, ctx)) return false;
  if (cond.var !== undefined && !matchVar(cond.var, ctx)) return false;
  if (cond.quest !== undefined && !matchQuest(cond.quest, ctx)) return false;
  if (cond.char !== undefined && !matchChar(cond.char, ctx)) return false;

  if (Array.isArray(cond.all) && !cond.all.every((sub) => evaluateEventCondition(sub, ctx))) {
    return false;
  }
  // `any: []` = 一个备选都没满足 = false（`all: []` 反过来是 true —— 空 AND 恒真、空 OR 恒假）
  if (Array.isArray(cond.any) && !cond.any.some((sub) => evaluateEventCondition(sub, ctx))) {
    return false;
  }
  if (cond.not !== undefined && evaluateEventCondition(cond.not, ctx)) return false;

  return true;
}

/**
 * 地点匹配面 = 地点键 ∪ 位置路径的**每一段**。
 *
 * 🔴 两者都要比（设计 §3.1）：地点键是落位产物（地块名），位置路径是真源自由文本。
 *    只比前者，落位失败的存档里全部地点条件静默失效；只比后者，作者写地块名就永远不中。
 * 🔴 面为空（两个字段都没供值）时 `anyOf` / `noneOf` **都判假** —— 缺数据为假那条契约。
 *    `noneOf` 看着「应该宽容」，但它同样是在回答「我现在在哪」，而我们不知道。
 */
function matchLocation(
  filter: NonNullable<EventCondition['location']>,
  ctx: RandomEventRollContext,
): boolean {
  if (!isObjectLike(filter)) return true;
  const hasAnyOf = Array.isArray(filter.anyOf) && filter.anyOf.length > 0;
  const hasNoneOf = Array.isArray(filter.noneOf) && filter.noneOf.length > 0;
  if (!hasAnyOf && !hasNoneOf) return true;

  const surface = collectLocationSurface(ctx);
  if (surface.size === 0) return false;

  const anyOf = filter.anyOf ?? [];
  const noneOf = filter.noneOf ?? [];
  if (hasAnyOf && !anyOf.some((key) => surface.has(key))) return false;
  if (hasNoneOf && noneOf.some((key) => surface.has(key))) return false;
  return true;
}

/**
 * 地点键 + 位置路径全段（去空白、丢空段）。
 *
 * 🔴 分段**必须走 `splitLocationSegments`**（`map-index.ts` 那份是全仓正典，分隔符集
 *    `[-－—–/／>＞]`），不能自己写一个 `split('-')`：`resolveRandomEventPlaceKey`
 *    （`random-event-snapshot.ts`）用的正是那一份，于是同一轮调度里
 *    「地点键按宽分隔符算、条件面按窄分隔符算」——
 *    `大陆/帝国/城市` 这类由 `getLocationPath()` 产出的路径整条读不出段，
 *    作者写 `location.anyOf: ['帝国']` 就永远不中。两处都不报错。
 */
function collectLocationSurface(ctx: RandomEventRollContext): Set<string> {
  const out = new Set<string>();
  const placeKey = typeof ctx.placeKey === 'string' ? ctx.placeKey.trim() : '';
  if (placeKey.length > 0) out.add(placeKey);

  const path = typeof ctx.locationPath === 'string' ? ctx.locationPath : '';
  for (const segment of splitLocationSegments(path)) out.add(segment);
  return out;
}

/** `{ gte?, lte? }` 区间；值缺席 / 非有穷 → 假 */
function matchRange(range: { gte?: number; lte?: number }, value: number | undefined): boolean {
  if (!isObjectLike(range)) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (typeof range.gte === 'number' && value < range.gte) return false;
  if (typeof range.lte === 'number' && value > range.lte) return false;
  return true;
}

function matchTime(
  filter: NonNullable<EventCondition['time']>,
  ctx: RandomEventRollContext,
): boolean {
  if (!isObjectLike(filter)) return true;
  if (Array.isArray(filter.seasonAnyOf) && filter.seasonAnyOf.length > 0) {
    if (typeof ctx.season !== 'string' || !filter.seasonAnyOf.includes(ctx.season)) return false;
  }
  if (Array.isArray(filter.timeOfDayAnyOf) && filter.timeOfDayAnyOf.length > 0) {
    if (typeof ctx.timeOfDay !== 'string' || !filter.timeOfDayAnyOf.includes(ctx.timeOfDay)) {
      return false;
    }
  }
  return true;
}

/**
 * 变量条件。`path` 是点分路径，落在 `ctx.variables` 这棵树上。
 *
 * 🔴 `exists: false` 是**缺数据规则唯一的例外**：它问的就是「这个变量不存在吧？」，
 *    不存在时必须为真。别的算子（eq/gte/lte）拿不到值一律假。
 * 🔴 只写 `path` 不写算子 = 存在性检查（等价 `exists: true`）—— 作者的意图很清楚，
 *    而「什么算子都没有」若判真，会让一条写漏的条件变成无条件放行。
 */
function matchVar(
  filter: NonNullable<EventCondition['var']>,
  ctx: RandomEventRollContext,
): boolean {
  if (!isObjectLike(filter) || typeof filter.path !== 'string' || filter.path.length === 0) {
    return false;
  }
  const value = resolveVarPath(ctx.variables, filter.path);
  const present = value !== undefined;

  if (filter.exists !== undefined) {
    if (filter.exists !== present) return false;
    // `exists: false` 命中后不再往下比 —— 值本来就不存在，任何算子都无从谈起
    if (filter.exists === false) return true;
  }

  // 只写 path 不写算子 = 存在性检查
  const hasOperator =
    filter.eq !== undefined || filter.gte !== undefined || filter.lte !== undefined;
  if (!hasOperator || !present) return present;

  if (filter.eq !== undefined && value !== filter.eq) return false;
  if (filter.gte !== undefined || filter.lte !== undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (typeof filter.gte === 'number' && value < filter.gte) return false;
    if (typeof filter.lte === 'number' && value > filter.lte) return false;
  }
  return true;
}

/**
 * 点分路径解析。
 *
 * 🔴 只走**自有属性**（`Object.prototype.hasOwnProperty`）：变量树的键是 AI 与作者写的
 *    自由串，一条 `constructor.prototype` 路径不该解析出宿主对象来。
 */
function resolveVarPath(root: Record<string, unknown> | undefined, path: string): unknown {
  if (!isRecord(root)) return undefined;
  let cursor: unknown = root;
  for (const segment of path.split('.')) {
    if (segment.length === 0) return undefined;
    if (!isRecord(cursor)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function matchQuest(
  filter: NonNullable<EventCondition['quest']>,
  ctx: RandomEventRollContext,
): boolean {
  if (!isObjectLike(filter) || typeof filter.name !== 'string' || filter.name.length === 0) {
    return false;
  }
  if (!Array.isArray(filter.statusAnyOf) || filter.statusAnyOf.length === 0) return false;
  const status = isObjectLike(ctx.quests) ? ctx.quests?.[filter.name] : undefined;
  return typeof status === 'string' && filter.statusAnyOf.includes(status);
}

function matchChar(
  filter: NonNullable<EventCondition['char']>,
  ctx: RandomEventRollContext,
): boolean {
  if (!isObjectLike(filter) || typeof filter.name !== 'string' || filter.name.length === 0) {
    return false;
  }
  const affection = isObjectLike(ctx.affections) ? ctx.affections?.[filter.name] : undefined;
  return matchRange({ gte: filter.affectionGte, lte: filter.affectionLte }, affection);
}

// ═══════════════════════════════════════════════════════════
// 权重
// ═══════════════════════════════════════════════════════════

/**
 * 权重 = ∏（命中的 `weights[].multiply`）× 频率系数，下界夹到 0。
 *
 * 🔴 没有权重链 = 1（不是 0）：绝大多数事件不写 weights，它们该按 MTTH 原速触发。
 * 🔴 频率系数是全局设置（`randomEventsFrequency`，§6），缺省 1；非有穷读作 1、负数夹到 0。
 * 🔴 `w <= 0` 的语义是**此时此地不可触发**（不是「概率极低」）—— 调用方据此整条跳过，
 *    连骰子都不掷。这与 `available`（硬门槛）的区别见 `RandomEventDef.available` 注释。
 */
export function computeEventWeight(
  def: RandomEventDef,
  ctx: RandomEventRollContext,
  frequency: number,
): number {
  const freq = Number.isFinite(frequency) ? Math.max(0, frequency) : 1;
  let weight = 1;

  if (Array.isArray(def.weights)) {
    for (const modifier of def.weights) {
      if (!isObjectLike(modifier)) continue;
      const multiply = modifier.multiply;
      if (typeof multiply !== 'number' || !Number.isFinite(multiply)) continue;
      if (!evaluateEventCondition(modifier.when, ctx)) continue;
      weight *= multiply;
    }
  }

  const total = weight * freq;
  return Number.isFinite(total) && total > 0 ? total : 0;
}

// ═══════════════════════════════════════════════════════════
// 候选池的存续判据（保洁与渲染共用同一份）
// ═══════════════════════════════════════════════════════════

/**
 * 这条候选现在还该留在池里吗。
 *
 * 🔴 **保洁（写库）与渲染（只读）必须共用这一份判据**（设计 §4.3 末句「渲染侧只过滤不写库」）。
 *    各写一份的症状是「注入块里看得见、库里已经撤掉」或者反过来 —— 而两者都不报错。
 *
 * 撤下的四种情形（各自的 forced 待遇不同，这是设计里逐条拍板过的）：
 *   · **定义已不存在** —— 换包后名字对不上（铁则 4：静默剔除，forced 也一样）
 *   · **`available` 当前不满足** —— 硬门槛**高于**首访强制，forced 一样撤（且**不记足迹**，
 *     条件重新满足后再次到达仍会强制入池，§3.1 末句）
 *   · **过期** —— 仅非 forced（forced 条目不设过期，它的撤池条件是「离开」）
 *   · **权重为 0** —— 仅非 forced（首访事件没有权重链，用权重去门它是越权）
 */
export function isPendingStillValid(
  entry: PendingRandomEvent,
  def: RandomEventDef | undefined,
  ctx: RandomEventRollContext,
  args: { currentDay: number; offerTtlDays: number },
): boolean {
  if (def === undefined) return false;
  if (def.available !== undefined && !evaluateEventCondition(def.available, ctx)) return false;
  if (entry.forced === true) return true;

  // `expiresDay` 缺席的非 forced 条目按 `armedDay + offerTtlDays` 补算 —— 一条手改过的
  // 存档不该让某个候选永久驻池（forced 才有「永不过期」这个特权）
  const ttl = Math.max(0, Math.floor(safeNumber(args.offerTtlDays, 0)));
  const expires = toDay(entry.expiresDay) ?? entry.armedDay + ttl;
  if (args.currentDay > expires) return false;

  return computeEventWeight(def, ctx, 1) > 0;
}

// ═══════════════════════════════════════════════════════════
// MTTH 逐天掷骰（§4.1）
// ═══════════════════════════════════════════════════════════

/**
 * 从 `lastRollDay` 走到 `currentDay`，把掷中的事件入池。无变化返回 `null`。
 *
 * 顺序是承重的（照设计 §4.1 与 §7 的伪码）：
 *   1. **回退护栏**：`lastRollDay > currentDay` 视为快照回退 —— 重置 `lastRollDay` 并清掉
 *      非 forced 池。否则回退后池子会带着「未来」的条目（§7；成本一个 if，无论快照覆盖面
 *      核实结果如何都写上）
 *   2. **首次 ensure**：`lastRollDay` 缺席 → 置当天、**不补历史**。一个玩到第 300 天才装上
 *      事件包的存档不该被 300 天的历史掷骰砸中
 *   3. **逐天走** `(lastRollDay, currentDay]` —— 一次 `delta_time` 可跨多天，所以是逐天迭代
 *      而不是布尔跨天
 *
 * 🔴 **权重用「到达时」的上下文一次求值**，不重建每一天的历史语境（设计 §4.1 简化裁定）：
 *    10 天旅程 = 用到达日语境掷 10 次。误差可接受，换来零历史回放成本；反向对冲手段是
 *    `journey` 条件（城内事件写 `{ journey: true } → ×0`）。
 */
export function rollRandomEvents(
  defs: readonly RandomEventDef[],
  config: RandomEventConfig,
  flags: RandomEventSaveFlags,
  ctx: RandomEventRollContext,
  args: { saveSeed: string; currentDay: number; frequency?: number },
): RandomEventSaveFlags | null {
  const currentDay = toDay(args.currentDay);
  if (currentDay === null) return null;

  const before = normalizeFlags(flags);
  const next = normalizeFlags(flags);
  const frequency = args.frequency === undefined ? 1 : args.frequency;
  const cooldown = Math.max(0, Math.floor(safeNumber(config.globalCooldownDays, 0)));
  const ttl = Math.max(0, Math.floor(safeNumber(config.offerTtlDays, 0)));

  // 1. 回退护栏
  if (next.lastRollDay !== undefined && next.lastRollDay > currentDay) {
    next.lastRollDay = currentDay;
    next.pending = next.pending.filter((entry) => entry.forced === true);
  }

  // 2. 首次 ensure（不补历史）
  if (next.lastRollDay === undefined) {
    next.lastRollDay = currentDay;
    return finalize(next, before);
  }

  // 3. 逐天走
  const start = Math.max(next.lastRollDay + 1, currentDay - MAX_ROLL_WALK_DAYS + 1);
  for (let day = start; day <= currentDay; day++) {
    if (next.lastTriggerDay !== undefined && day - next.lastTriggerDay < cooldown) continue;

    for (const def of defs) {
      if (!def || !def.trigger || def.trigger.type !== 'mtth') continue;
      const mtthDays = def.trigger.mtthDays;
      if (typeof mtthDays !== 'number' || !Number.isFinite(mtthDays) || mtthDays <= 0) continue;

      const record = next.fired[def.name];
      if (def.once === true && record !== undefined) continue;
      if (
        record !== undefined &&
        typeof def.cooldownDays === 'number' &&
        def.cooldownDays > 0 &&
        day - record.lastDay < def.cooldownDays
      ) {
        continue;
      }
      if (next.pending.some((entry) => entry.name === def.name)) continue;
      if (def.available !== undefined && !evaluateEventCondition(def.available, ctx)) continue;

      const weight = computeEventWeight(def, ctx, frequency);
      if (weight <= 0) continue;

      // 权重放大概率 ≡ 缩短有效 MTTH
      const probability = Math.min(1, weight / mtthDays);
      const rng = createEjsRng(buildRandomEventSeed(args.saveSeed, def.name, day));
      if (!rng.chance(probability)) continue;

      // 同一条 rng 继续采样 slots —— 两条序列意味着两处要各自保证可复现
      next.pending.push(
        armEntry(def, ctx, rng, { armedDay: day, expiresDay: day + ttl, placeKey: ctx.placeKey }),
      );
      enforcePoolCap(next.pending, config.maxPending);
    }
  }

  next.lastRollDay = currentDay;
  return finalize(next, before);
}

/**
 * 池满淘汰：撤掉 priority 最低的**非 forced** 条目，直到不超上限。
 *
 * 🔴 **forced 永不被淘汰**（设计 §4.1 末句）。于是「池子全是 forced 且已满」时谁也撤不掉 ——
 *    这时刚 push 进来的那条非 forced 会被自己撤掉（它是唯一的候选受害者），等价于「不入池」。
 * 🔴 同 priority 取**最后一个**（= 刚入池的那条先走）：平手时不该让池子换人，
 *    老条目已经在注入块里给 AI 看过了，把它换掉会让候选列表无缘无故地抖。
 */
function enforcePoolCap(pending: PendingRandomEvent[], maxPending: number): void {
  const cap = Number.isFinite(maxPending) ? Math.max(0, Math.floor(maxPending)) : pending.length;
  while (pending.length > cap) {
    let victim = -1;
    for (let i = 0; i < pending.length; i++) {
      if (pending[i].forced === true) continue;
      if (victim < 0 || pending[i].priority <= pending[victim].priority) victim = i;
    }
    if (victim < 0) return; // 全是 forced：宁可超上限也不撤首访
    pending.splice(victim, 1);
  }
}

// ═══════════════════════════════════════════════════════════
// 首访强制（§4.2）
// ═══════════════════════════════════════════════════════════

/**
 * 到达一个地点时的强制入池。无变化返回 `null`。
 *
 * 三步（顺序承重）：
 *   1. **离开即撤**：撤掉池中 `placeKey` 不等于本地点的 forced 条目（人都走了，首访遭遇
 *      不再成立）。这一步**先于**足迹判断 —— 到一个去过的地方同样意味着离开了上一个地方
 *   2. 本地点已在足迹里 / 池中已有本地点的 forced 条目 → 不再入池
 *   3. 选 `scope` 命中且 `available` 满足的 `first_visit` 定义（多条命中取 priority 最高，
 *      平手取 defs 顺序第一条）；**没有命中就什么也不做** —— 普通新地点不起事件是有意语义
 *      （裁定 §13-3）
 *
 * 🔴 **足迹在触发时记账，不在入池时**（§4.2）：AI 若一直没触发、玩家离开又回来，会再次
 *    强制入池 —— 这才守得住「点名地点第一次到必定触发」。
 * 🔴 **不绕过、也不检查全局冷却**：首访是强制入池，与 MTTH 那条冷却链完全无关（§10 有
 *    一条测试专门钉这件事）。
 */
export function armFirstVisitEvent(
  defs: readonly RandomEventDef[],
  flags: RandomEventSaveFlags,
  ctx: RandomEventRollContext,
  args: { placeKey: string; currentDay: number; saveSeed: string },
): RandomEventSaveFlags | null {
  const currentDay = toDay(args.currentDay);
  const placeKey = typeof args.placeKey === 'string' ? args.placeKey.trim() : '';
  if (currentDay === null || placeKey.length === 0) return null;

  const before = normalizeFlags(flags);
  const next = normalizeFlags(flags);

  // 1. 离开即撤
  next.pending = next.pending.filter(
    (entry) => entry.forced !== true || entry.placeKey === placeKey,
  );

  // 2. 已访问 / 已有本地 forced
  const settled =
    next.visited.includes(placeKey) ||
    next.pending.some((entry) => entry.forced === true && entry.placeKey === placeKey);

  if (!settled) {
    const picked = selectFirstVisitDef(defs, next, ctx, placeKey);
    if (picked !== null) {
      const rng = createEjsRng(buildRandomEventSeed(args.saveSeed, picked.name, currentDay));
      next.pending.push(
        armEntry(picked, ctx, rng, { armedDay: currentDay, forced: true, placeKey }),
      );
    }
  }

  return finalize(next, before);
}

/** 命中本地点的 first_visit 定义里 priority 最高的一条；平手取 defs 顺序第一条 */
function selectFirstVisitDef(
  defs: readonly RandomEventDef[],
  flags: WorkingFlags,
  ctx: RandomEventRollContext,
  placeKey: string,
): RandomEventDef | null {
  let best: RandomEventDef | null = null;
  let bestPriority = 0;

  for (const def of defs) {
    if (!def || !def.trigger || def.trigger.type !== 'first_visit') continue;
    const anyOf = def.trigger.scope?.anyOf;
    if (!Array.isArray(anyOf) || !anyOf.includes(placeKey)) continue;
    if (def.once === true && flags.fired[def.name] !== undefined) continue;
    if (flags.pending.some((entry) => entry.name === def.name)) continue;
    if (def.available !== undefined && !evaluateEventCondition(def.available, ctx)) continue;

    const priority = readPriority(def);
    // 严格大于 → 平手时保留先见到的那条（defs 顺序 = 包里的书写顺序，稳定）
    if (best === null || priority > bestPriority) {
      best = def;
      bestPriority = priority;
    }
  }
  return best;
}

// ═══════════════════════════════════════════════════════════
// 调试强制入池（开发者面板专用）
// ═══════════════════════════════════════════════════════════

/**
 * 把**任意一条**定义按 forced 入池。无变化返回 `null`。
 *
 * 唯一的调用方是 StateManager 的 `devForceArmRandomEvent`（开发者调试面板的「下回合触发」）。
 * 它**刻意绕过** MTTH 掷骰 / `available` / 权重链 / 冷却与 `once` —— 那是一个开发者按钮的
 * 全部意义：我现在就要看这条事件被演绎出来。
 *
 * 🔴 为什么是这里而不是在接线层现拼一个条目：槽位采样与简报固化（`armEntry` → `sampleSlots`
 *    → `renderBrief`）是**入池语义的一部分**。在别处手搓一个 `{ name, brief: def.brief }`
 *    会把 `{{槽名}}` / `{{place}}` 原样喂给 AI —— 看着像功能正常，只是调试出来的那一次
 *    与真实入池长得不一样，于是调试本身失去意义。
 *
 * 🔴 **不调 `enforcePoolCap`**（同 `armFirstVisitEvent`）：forced 条目本来就免疫淘汰，
 *    在这里挨个撤别人只会把玩家正在等的候选挤掉。宁可短暂超上限。
 *
 * 🔴 同名旧条目**先撤再入**：池里可能已经有一条非 forced 的它。留着就是两行同名候选 ——
 *    注入块里出现两次，而 `settleRandomEventTrigger` 只认第一条。
 */
export function armRandomEventForced(
  def: RandomEventDef,
  flags: RandomEventSaveFlags,
  ctx: RandomEventRollContext,
  args: { currentDay: number; saveSeed: string },
): RandomEventSaveFlags | null {
  const currentDay = toDay(args.currentDay);
  const name = typeof def?.name === 'string' ? def.name : '';
  if (currentDay === null || name.length === 0) return null;

  const before = normalizeFlags(flags);
  const next = normalizeFlags(flags);
  next.pending = next.pending.filter((entry) => entry.name !== name);

  const rng = createEjsRng(buildRandomEventSeed(args.saveSeed, name, currentDay));
  next.pending.push(
    armEntry(def, ctx, rng, { armedDay: currentDay, forced: true, placeKey: ctx.placeKey }),
  );

  return finalize(next, before);
}

// ═══════════════════════════════════════════════════════════
// 池子保洁（§4.3）
// ═══════════════════════════════════════════════════════════

/**
 * 每回合一次的轻量保洁。无变化返回 `null`。
 *
 * 判据整份委托给 `isPendingStillValid` —— 与渲染侧共用同一份（见那个函数的注释）。
 */
export function pruneRandomEvents(
  defs: readonly RandomEventDef[],
  config: RandomEventConfig,
  flags: RandomEventSaveFlags,
  ctx: RandomEventRollContext,
  currentDay: number,
): RandomEventSaveFlags | null {
  const day = toDay(currentDay);
  if (day === null) return null;

  const before = normalizeFlags(flags);
  const next = normalizeFlags(flags);
  const byName = indexDefs(defs);
  const offerTtlDays = safeNumber(config.offerTtlDays, 0);

  next.pending = next.pending.filter((entry) =>
    isPendingStillValid(entry, byName.get(entry.name), ctx, { currentDay: day, offerTtlDays }),
  );

  return finalize(next, before);
}

// ═══════════════════════════════════════════════════════════
// 触发结算（§5.2 步 1-4 的纯逻辑部分）
// ═══════════════════════════════════════════════════════════

/**
 * AI 回执 `<event_trigger name>` 后的纯结算。名字不在池中 → `null`（幻觉触发不奖励）。
 *
 * 四步（第 5 步 emit `GameEvent` 是接线层的事，不在纯函数里）：
 *   1. 按名字在池中解析（**逐字匹配**，铁则 1）
 *   2. `fired[name]` 计数 + `lastDay`
 *   3. `lastTriggerDay = currentDay`（全局冷却起算）
 *   4. 出池：**清掉全部非 forced 条目**（一次触发一波，避免连环轰炸，裁定 §13-5）；
 *      forced 条目保留，除非被触发的正是它 —— 那时把它的 `placeKey` 记入足迹
 *
 * 🔴 与另外三个入口不同，本函数**永远不返回「无变化」** —— 只要名字在池中，`fired` 就一定
 *    变了。返回 `null` 只有一个含义：这个名字不在池里。
 */
export function settleRandomEventTrigger(
  flags: RandomEventSaveFlags,
  name: string,
  currentDay: number,
): { flags: RandomEventSaveFlags; triggered: PendingRandomEvent } | null {
  const day = toDay(currentDay);
  const wanted = typeof name === 'string' ? name.trim() : '';
  if (day === null || wanted.length === 0) return null;

  const next = normalizeFlags(flags);
  const index = next.pending.findIndex((entry) => entry.name === wanted);
  if (index < 0) return null;

  const triggered = next.pending[index];
  const previous = next.fired[wanted];
  next.fired[wanted] = { count: (previous?.count ?? 0) + 1, lastDay: day };
  next.lastTriggerDay = day;
  next.pending = next.pending.filter((entry, i) => entry.forced === true && i !== index);

  if (triggered.forced === true) {
    const placeKey = triggered.placeKey;
    if (placeKey !== undefined && placeKey.length > 0 && !next.visited.includes(placeKey)) {
      next.visited.push(placeKey);
    }
  }

  return { flags: toOutput(next), triggered };
}

// ═══════════════════════════════════════════════════════════
// 入池：槽位采样与简报固化
// ═══════════════════════════════════════════════════════════

/**
 * 把一条定义实例化成候选（槽位采样 + 简报固化）。
 *
 * 🔴 简报**入池即定型**：每回合重新采样会让同一个候选在 AI 眼里每次换一副面孔，
 *    且快照回退后对不上（`PendingRandomEvent.brief` 那条注释）。
 */
function armEntry(
  def: RandomEventDef,
  ctx: RandomEventRollContext,
  rng: EjsRng,
  opts: { armedDay: number; expiresDay?: number; forced?: boolean; placeKey?: string },
): PendingRandomEvent {
  const samples = sampleSlots(def, rng);
  const placeKey = opts.placeKey ?? ctx.placeKey ?? '';

  const entry: PendingRandomEvent = {
    name: def.name,
    armedDay: opts.armedDay,
    priority: readPriority(def),
    brief: renderBrief(def.brief, samples, placeKey),
  };
  if (opts.expiresDay !== undefined) entry.expiresDay = opts.expiresDay;
  if (opts.forced === true) {
    entry.forced = true;
    if (opts.placeKey !== undefined && opts.placeKey.length > 0) entry.placeKey = opts.placeKey;
  }
  return entry;
}

/**
 * 逐槽加权抽一条。遍历顺序 = `Object.keys` 顺序 = 定义里的书写顺序（槽名是自由串，
 * 不会被 JS 的「整数键优先」规则重排）—— 这就是「同种子同结果」在多槽事件上的前提。
 */
function sampleSlots(def: RandomEventDef, rng: EjsRng): Record<string, string> {
  const out: Record<string, string> = {};
  const slots = def.slots;
  if (!slots || !isObjectLike(slots)) return out;

  for (const key of Object.keys(slots)) {
    const picked = weightedPick(slots[key], rng);
    if (picked !== null) out[key] = picked;
  }
  return out;
}

/**
 * 加权抽样（形状照 `map-weather.sampleLabel`）。
 *
 * 权重逐格回落 1（缺席 / 非有穷 / 非正）。整张表一行可用的都没有 → `null`，
 * 此时占位符**原样留在 brief 里** —— 那是看得见的失败，比替进一个空串强
 * （`coerceSlots` 那条注释是同一条理由）。
 */
function weightedPick(table: SlotTable | undefined, rng: EjsRng): string | null {
  if (!table || !isObjectLike(table) || !Array.isArray(table.pick) || table.pick.length === 0) {
    return null;
  }

  const labels: string[] = [];
  const weights: number[] = [];
  let total = 0;
  for (let i = 0; i < table.pick.length; i++) {
    const label = table.pick[i];
    if (typeof label !== 'string' || label.length === 0) continue;
    const raw = Array.isArray(table.weights) ? table.weights[i] : undefined;
    const weight = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1;
    labels.push(label);
    weights.push(weight);
    total += weight;
  }
  if (labels.length === 0 || total <= 0) return null;

  const target = rng.float() * total;
  let acc = 0;
  for (let i = 0; i < labels.length; i++) {
    acc += weights[i];
    if (target < acc) return labels[i];
  }
  // 浮点兜底（同 `sampleLabel` 末尾那条 return）：掉出循环时取最后一行
  return labels[labels.length - 1];
}

/**
 * 简报里的占位替换。**不用正则** —— 槽名是作者写的自由串（可能含 `.` `(` `*` 等正则元字符），
 * 逐串 split/join 才不会把一个手滑的槽名变成一条爆炸的正则。
 */
function renderBrief(brief: string, samples: Record<string, string>, placeKey: string): string {
  let out = typeof brief === 'string' ? brief : '';
  for (const [key, value] of Object.entries(samples)) {
    out = replaceToken(out, key, value);
    out = replaceToken(out, `${SLOT_TOKEN_PREFIX}${key}`, value);
  }
  return replaceToken(out, PLACE_TOKEN, placeKey);
}

function replaceToken(text: string, token: string, value: string): string {
  if (token.length === 0) return text;
  return text.split(`{{${token}}}`).join(value);
}

// ═══════════════════════════════════════════════════════════
// 内部：flags 的规范化 / 比较 / 输出
// ═══════════════════════════════════════════════════════════

/** 工作副本 —— 三个集合恒在（省掉满地的 `?? []`），输出时再折回「空则缺席」 */
interface WorkingFlags {
  pending: PendingRandomEvent[];
  visited: string[];
  fired: Record<string, { count: number; lastDay: number }>;
  lastTriggerDay?: number;
  lastRollDay?: number;
}

/**
 * 深拷贝 + 收窄成工作副本。
 *
 * 🔴 **拷贝到条目一级**：调用方拿到的返回值会被整份写进存档，若与入参共享条目对象，
 *    「纯函数不改入参」这条就只在数组层面成立（改一格 `brief` 仍会打穿回去）。
 * 🔴 认不出的条目**丢掉**（名字空 / 不是对象 / armedDay 非数字）：存档里的坏条目不该让
 *    调度崩，也不该被当成合法候选渲染给 AI。
 */
function normalizeFlags(flags: RandomEventSaveFlags | undefined): WorkingFlags {
  const source: Record<string, unknown> = isRecord(flags) ? flags : {};
  const pending: PendingRandomEvent[] = [];

  if (Array.isArray(source.pending)) {
    for (const raw of source.pending) {
      if (!isRecord(raw)) continue;
      const name = typeof raw.name === 'string' ? raw.name : '';
      const armedDay = toDay(raw.armedDay);
      if (name.length === 0 || armedDay === null) continue;

      const entry: PendingRandomEvent = {
        name,
        armedDay,
        priority: safeNumber(raw.priority, 0),
        brief: typeof raw.brief === 'string' ? raw.brief : '',
      };
      const expires = toDay(raw.expiresDay);
      if (expires !== null) entry.expiresDay = expires;
      if (raw.forced === true) entry.forced = true;
      if (typeof raw.placeKey === 'string' && raw.placeKey.length > 0)
        entry.placeKey = raw.placeKey;
      pending.push(entry);
    }
  }

  const visited: string[] = [];
  if (Array.isArray(source.visited)) {
    for (const item of source.visited) {
      if (typeof item === 'string' && item.length > 0 && !visited.includes(item))
        visited.push(item);
    }
  }

  const fired: Record<string, { count: number; lastDay: number }> = {};
  if (isRecord(source.fired)) {
    for (const [key, value] of Object.entries(source.fired)) {
      if (key.length === 0 || !isRecord(value)) continue;
      const count = safeNumber(value.count, 0);
      const lastDay = toDay(value.lastDay);
      if (lastDay === null) continue;
      fired[key] = { count: Math.max(0, Math.floor(count)), lastDay };
    }
  }

  const out: WorkingFlags = { pending, visited, fired };
  const lastTriggerDay = toDay(source.lastTriggerDay);
  if (lastTriggerDay !== null) out.lastTriggerDay = lastTriggerDay;
  const lastRollDay = toDay(source.lastRollDay);
  if (lastRollDay !== null) out.lastRollDay = lastRollDay;
  return out;
}

/**
 * 有变化才给新 flags，否则 `null`。
 *
 * 🔴 比较的是**两份规范化副本**，不是入参与产物：那样 `pending: []` 与「没有 pending 字段」
 *    会被判成一次变化，于是每一回合都写一次库（而库里一个字节没变）。
 */
function finalize(next: WorkingFlags, before: WorkingFlags): RandomEventSaveFlags | null {
  return sameFlags(next, before) ? null : toOutput(next);
}

function toOutput(working: WorkingFlags): RandomEventSaveFlags {
  const out: RandomEventSaveFlags = {};
  if (working.pending.length > 0) out.pending = working.pending;
  if (working.lastTriggerDay !== undefined) out.lastTriggerDay = working.lastTriggerDay;
  if (working.lastRollDay !== undefined) out.lastRollDay = working.lastRollDay;
  if (working.visited.length > 0) out.visited = working.visited;
  if (Object.keys(working.fired).length > 0) out.fired = working.fired;
  return out;
}

function sameFlags(a: WorkingFlags, b: WorkingFlags): boolean {
  if (a.lastRollDay !== b.lastRollDay) return false;
  if (a.lastTriggerDay !== b.lastTriggerDay) return false;
  if (a.visited.length !== b.visited.length) return false;
  for (let i = 0; i < a.visited.length; i++) if (a.visited[i] !== b.visited[i]) return false;

  const aKeys = Object.keys(a.fired);
  const bKeys = Object.keys(b.fired);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const left = a.fired[key];
    const right = b.fired[key];
    if (right === undefined) return false;
    if (left.count !== right.count || left.lastDay !== right.lastDay) return false;
  }

  if (a.pending.length !== b.pending.length) return false;
  for (let i = 0; i < a.pending.length; i++) {
    const left = a.pending[i];
    const right = b.pending[i];
    if (
      left.name !== right.name ||
      left.armedDay !== right.armedDay ||
      left.expiresDay !== right.expiresDay ||
      left.forced !== right.forced ||
      left.placeKey !== right.placeKey ||
      left.priority !== right.priority ||
      left.brief !== right.brief
    ) {
      return false;
    }
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
// 内部：小工具
// ═══════════════════════════════════════════════════════════

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 同一条判据的**非类型守卫**版本。
 *
 * 🔴 用在**已经有类型**的入参上（条件对象 / 定义 / 槽位表）。`isRecord` 是类型守卫，
 *    拿它去测一个 `EventCondition` 会把它窄成 `Record<string, unknown>` ——
 *    此后每一格字段都退化成 `unknown`，编译期一路红（或者更糟：被 `as` 压回去，
 *    于是这些字段再也没有类型检查）。守卫只该用在真的 `unknown` 上。
 */
function isObjectLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 游戏日收窄：非有穷 → `null`（调用方据此整段放弃，不拿一个假日子往下算）。
 * 入参是 `unknown` —— 它也吃从存档里读出来的、类型不可信的值。
 */
function toDay(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null;
}

function safeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** `priority` 缺席 / 认不出读作 0（§3.1 默认值） */
function readPriority(def: RandomEventDef): number {
  return typeof def.priority === 'number' && Number.isFinite(def.priority) ? def.priority : 0;
}

/** 名字 → 定义。重名以**先见到的**为准（`coerceRandomEventPack` 已经去过重了） */
function indexDefs(defs: readonly RandomEventDef[]): Map<string, RandomEventDef> {
  const out = new Map<string, RandomEventDef>();
  for (const def of defs) {
    if (!def || typeof def.name !== 'string' || def.name.length === 0) continue;
    if (!out.has(def.name)) out.set(def.name, def);
  }
  return out;
}
