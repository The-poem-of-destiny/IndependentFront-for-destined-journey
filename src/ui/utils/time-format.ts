/**
 * 相对时间格式化工具，纯函数。
 * 支持通过注入 `now` 参数便于测试，按差值分级降级显示。
 */

/** 1 分钟（毫秒） */
const MIN = 60_000
/** 1 小时（毫秒） */
const HOUR = 3_600_000

/** 取本地日历日的 0 点时间戳（基于给定时刻） */
function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 取 HH:MM（24h 补零） */
function hhmm(ts: number): string {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/**
 * 将时间戳 ts 格式化为相对人们可读字符串，参考时刻为 now（默认 Date.now()）。
 *
 * - diff < 60s           → '刚刚'
 * - diff < 60min          → 'N分钟前'
 * - 同一本地日历日        → '今天 HH:MM'
 * - 日历昨天              → '昨天 HH:MM'
 * - 更早                  → 'M-D'（不补零）
 * - 未来时间(ts>now)       → 退化用 '今天 HH:MM' 或 'M-D'，不写"后"
 *
 * 守护: ts 为 0 / NaN / undefined / null / Infinity → 返回 ''。
 */
export function formatRel(
  ts: number | undefined | null,
  now: number = Date.now(),
): string {
  if (!ts || !Number.isFinite(ts)) return ''

  const targetTs = new Date(ts).getTime()
  if (!Number.isFinite(targetTs)) return ''

  const diff = targetTs - now
  const absDiff = Math.abs(diff)

  // 60 秒内（含未来 60 秒内）→ 刚刚
  if (absDiff < MIN) return '刚刚'

  // 60 分钟内 → N分钟前 / N分钟后 我们不写"后"，统一用分钟前描述
  // 但要求里未来时间退化处理；为避免出现"未来+分钟前"误导，仅过去用分钟前
  if (diff < 0 && absDiff < HOUR) {
    return `${Math.floor(absDiff / MIN)}分钟前`
  }

  // 同一本地日历日（基于 now）
  const dayOfNow = startOfDay(now)
  const dayOfTarget = startOfDay(targetTs)

  if (dayOfTarget === dayOfNow) {
    return `今天 ${hhmm(targetTs)}`
  }

  // 日历昨天
  if (dayOfTarget === dayOfNow - 86_400_000) {
    return `昨天 ${hhmm(targetTs)}`
  }

  // 更早或更远未来 → M-D（不补零），未来时间也用此降级显示
  const d = new Date(targetTs)
  return `${d.getMonth() + 1}-${d.getDate()}`
}