/**
 * model-json.ts — 从模型输出里抢救 JSON 的**唯一**入口（Q-05，T2 AI 边界）
 *
 * ## 为什么要有这个文件
 *
 * 同一句 `raw.match(/\{[\s\S]*\}/)` 曾出现在 6 处，另有 3 套各不相认的剥壳
 * （```json 围栏 / `<json>` 标签 / 按注释下标切片）。后果有两层：
 *
 * 1. 模型今天多包一层围栏，得逐个文件去修，修好一处不惠及其余；
 * 2. `plot-engine.parsePostCheckOutput` 主分支逐字段兜底、catch 分支裸
 *    `JSON.parse` —— 缺键输出走兜底路径直接 TypeError，再被上层 catch 吞成
 *    console.warn，整条剧情后检查静默空转。
 *
 * 所以这里把「剥壳」和「兜底」拆开：剥壳只有一份实现，兜底由调用方用一个
 * `normalize` 回调表达 —— 从形态上就长不出「两个分支两套兜底」。
 */

/**
 * 从模型原始输出里抠出最可能是 JSON 的那一段；抠不到返回 null。
 *
 * 依次尝试（顺序即优先级）：
 *   1. 整段本身就是 JSON（trim 后以 `{`/`[` 开头）
 *   2. ` ```json … ``` ` / ` ``` … ``` ` 围栏（取第一个内容像 JSON 的）
 *   3. `<json> … </json>` 标签
 *   4. 首个 `{` 到末个 `}`（或首个 `[` 到末个 `]`）的贪婪切片 —— 吃掉前后夹带的解说文字
 */
export function extractJsonPayload(raw: string): string | null {
  if (!raw) return null;
  const text = raw.trim();

  // ① 裸 JSON
  if (text.startsWith('{') || text.startsWith('[')) return text;

  // ② markdown 围栏（可能有多个，取第一个内容像 JSON 的）
  const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const inner = m[1].trim();
    if (inner.startsWith('{') || inner.startsWith('[')) return inner;
  }

  // ③ <json> 标签（memory_summary 等 Agent 的包壳习惯）
  const tagged = text.match(/<json>([\s\S]*?)<\/json>/i);
  if (tagged) {
    const inner = tagged[1].trim();
    if (inner) return inner;
  }

  // ④ 贪婪切片：首个 { 到末个 }（对象优先，其次数组）
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) return text.slice(objStart, objEnd + 1);

  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) return text.slice(arrStart, arrEnd + 1);

  return null;
}

/**
 * 剥壳 + `JSON.parse` + **一次**归一化。解析失败或 normalize 抛错都返回 null。
 *
 * `normalize` 是调用方唯一的兜底口径：形状检查、缺键补默认值都写在这里，
 * 成功与失败两条路都经过它 —— 这正是「两个分支两套兜底」不可能再发生的原因。
 *
 * @param raw 模型原始输出
 * @param normalize 把 `unknown` 收成目标类型；返回 null 视为「这份输出不可用」
 */
export function parseModelJson<T>(raw: string, normalize: (parsed: unknown) => T | null): T | null {
  const payload = extractJsonPayload(raw);
  if (!payload) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  try {
    return normalize(parsed);
  } catch {
    return null;
  }
}

/** 数组字段兜底：不是数组就给空数组（最常见的一条 normalize 规则） */
export function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** 字符串字段兜底 */
export function asString(v: unknown, dflt = ''): string {
  return typeof v === 'string' ? v : dflt;
}

/** 数字字段兜底（NaN 也算缺失） */
export function asNumber(v: unknown, dflt = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/** 布尔字段兜底 */
export function asBoolean(v: unknown, dflt = false): boolean {
  return typeof v === 'boolean' ? v : dflt;
}
