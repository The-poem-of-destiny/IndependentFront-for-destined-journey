/**
 * time-ledger.ts — 回合驱动的时间账本（纯函数，ADR-33 / 设计 §4）
 *
 * 装什么: 三个只吃数字、只吐数字的到期判定函数。
 *   · `periodsDue(anchorDay, periodDays, prevDay, nextDay)` → 本次时间前进跨过了几个周期边界
 *   · `periodsDueCapped(...)` → 同上，但套一层失控护栏 `MAX_CATCHUP_PERIODS`
 *   · `expiryDue(anchorDay, durationDays, nextDay)` → 某个带时限的事实是否已到期
 *
 * 不装什么: **任何状态、任何时钟、任何业务语义**。这里没有「地块」「状态」「建筑」
 *   「收益」这些词 —— 本模块是**引擎公共层**基础设施（所以刻意**不叫** `map-*`），
 *   地图 v1.2 是它的第一个消费者，别的系统随后可以照用。它也**不 import**
 *   `types.ts` / `types-map.ts`：纯数字进、纯数字出，没有任何一条依赖边。
 *
 * 🔴 **契约一：集中调度、分散结算**（设计 §4）。
 *   账本只回答「谁到期了、欠了几期」，**结算逻辑归各系统自己**。
 *   调用方拿到期数后自己按序补结算（收益入账 / 周期效果 / 升降档 …），
 *   账本永不回调、永不改写调用方的数据。
 *
 * 🔴 **契约二：永不自走时钟**（裁定 §8-2）。
 *   游戏时间只在**提交时**经 `delta_time` 前进（AI 权威、不 clamp），没有后台 tick。
 *   本模块因此**没有** `Date.now()` / `Math.random()` / I/O ——
 *   真实时钟会当场毁掉全仓的种子化确定性（同参数重放必须逐字一致）。
 *
 * 🔴 **契约三：零簿记调度**（设计 §4）。
 *   不存 ledger 状态：到期点全部从事实自带的锚（`appliedAtDay` / `anchorDay`）纯推导。
 *   没有 `lastSettled` 这类字段，也就没有可漂移的东西 —— 同一组参数重放天然一致。
 *   代价是调用方必须老老实实把**上一时刻**也传进来（半开区间 `(prevDay, nextDay]`）。
 */

/**
 * 一次时间前进最多补结算多少期（失控护栏）。
 *
 * 为什么要护栏: `delta_time` 是 AI 权威且**不 clamp** 的 —— 模型一时兴起写个
 * 「三年后」，90 天周期的事实就要补 12 期，而写成「一万年后」就是 40000 期。
 * 结算回调可能带副作用（跨档降级、建筑摧毁、编年史入档），逐期跑一遍会把一次提交
 * 拖成灾难。取 120：常见周期 30 天时约等于「一次最多补十年」，正常剧情远够不着。
 */
export const MAX_CATCHUP_PERIODS = 120;

/** 有限实数判定（`NaN` / `Infinity` 一律当非法输入，返回「什么都没到期」）。 */
function isFiniteNumber(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 半开区间 `(prevDay, nextDay]` 内跨过了几个周期边界。
 *
 * 公式（零簿记的全部秘密）:
 *   `floor((nextDay − anchorDay) / periodDays) − floor((prevDay − anchorDay) / periodDays)`
 *
 * 三条边界语义，逐条都有测试钉着:
 *   1. **prev 恰好压在边界上不重复计数** —— 上一次提交已经结算过它了（半开区间的左端开）。
 *   2. **next 恰好压在边界上要计数** —— 到期点当天就该结算（半开区间的右端闭）。
 *   3. **锚之前的边界永不计数** —— 第 12 天生效、周期 30 天的事实，**第一次**到期是第 42 天，
 *      不是第 30 天，更不是「生效当天先结算一次」。实现上把 prev/next 都先抬到锚以上。
 *
 * 护栏: `periodDays <= 0` → 0（无周期的事实永不到期）；`nextDay < prevDay` → 0
 * （时间倒流只可能来自回退/重发这类操作，绝不能倒扣出负期数或反向结算）。
 *
 * @param anchorDay   事实的锚（生效那天的游戏日），周期从这里起算
 * @param periodDays  周期长度（天）；`<= 0` 表示没有周期
 * @param prevDay     本次前进**之前**的游戏日（区间左端，开）
 * @param nextDay     本次前进**之后**的游戏日（区间右端，闭）
 * @returns 欠账期数，恒 `>= 0`
 */
export function periodsDue(
  anchorDay: number,
  periodDays: number,
  prevDay: number,
  nextDay: number,
): number {
  if (
    !isFiniteNumber(anchorDay) ||
    !isFiniteNumber(periodDays) ||
    !isFiniteNumber(prevDay) ||
    !isFiniteNumber(nextDay)
  ) {
    return 0;
  }
  if (periodDays <= 0) return 0;
  if (nextDay < prevDay) return 0;

  // 抬到锚以上: 锚之前根本没有「周期」这回事，负商 floor 出来的 -1 会伪造一次到期。
  const from = Math.max(prevDay, anchorDay);
  const to = Math.max(nextDay, anchorDay);

  const crossed =
    Math.floor((to - anchorDay) / periodDays) - Math.floor((from - anchorDay) / periodDays);
  return crossed > 0 ? crossed : 0;
}

/**
 * `periodsDue` 套上 {@link MAX_CATCHUP_PERIODS} 护栏 —— **带副作用的结算一律用这个**。
 *
 * 只在「一次前进跨了荒谬多期」时才与 `periodsDue` 有差别；超出部分**静默丢弃**
 * （不是延后、不是排队）：账本无状态，没有地方记「还欠着 39880 期」，
 * 而这种输入本身就是 AI 写飞了的产物，补齐它没有任何叙事价值。
 */
export function periodsDueCapped(
  anchorDay: number,
  periodDays: number,
  prevDay: number,
  nextDay: number,
): number {
  const due = periodsDue(anchorDay, periodDays, prevDay, nextDay);
  return due > MAX_CATCHUP_PERIODS ? MAX_CATCHUP_PERIODS : due;
}

/**
 * 带时限的事实是否已到期（到期日当天即为 true）。
 *
 * 语义: `durationDays >= 0` 且 `nextDay >= anchorDay + durationDays` → true。
 *   · `durationDays === -1` 是**永久**的约定编码 —— 永不到期。
 *   · 其余负数同样返回 false（非法输入按永久处理，宁可留着也不误删事实）。
 *   · `durationDays === 0` 表示「当天即到期」，锚当天就 true。
 *
 * @param anchorDay     事实生效那天的游戏日
 * @param durationDays  持续天数；`-1` = 永久
 * @param nextDay       本次前进**之后**的游戏日
 */
export function expiryDue(anchorDay: number, durationDays: number, nextDay: number): boolean {
  if (!isFiniteNumber(anchorDay) || !isFiniteNumber(durationDays) || !isFiniteNumber(nextDay)) {
    return false;
  }
  if (durationDays < 0) return false;
  return nextDay >= anchorDay + durationDays;
}
