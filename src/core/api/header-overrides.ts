/**
 * 源级自定义请求头（`ApiSourceBase.headerOverrides`）的**唯一**校验与编码面。
 *
 * ── 为什么要这一层 ───────────────────────────────────────────────────
 * 请求体侧早就有了 `bodyOverrides`（`body-parameters.ts`），请求头侧此前**完全没有** ——
 * 于是「非标准 OpenAI 兼容网关要求附带会话头」（真机：opencode 的
 * `x-opencode-session`）无路可走。本模块补上头这一半，并把它钉在**受保护头名**之内。
 *
 * ── 三处共用的口径 ──────────────────────────────────────────────────
 *   · `source-config.ts`：保存 / 加载时校验（用户能当场看到拒绝原因）。
 *   · `transport.ts`：组装 `X-Custom-Headers` 载荷（percent-encoded JSON）。
 *   · BFF `server/routes/proxy.ts`：**再验一次**（安全边界不接受前端自证）。
 *
 * 🔴 受保护头名不是「洁癖」，是边界：`Authorization` / `x-api-key` 等由协议层按
 *    `endpoint.apiKey` 生成，允许覆盖等于把「持有 key 的无状态透传代理」变成任意鉴权头注入器；
 *    `X-Target-Base-URL` / `X-Model-ID` / `X-LLM-Stream` 是 BFF 自身的控制头，覆盖会改写路由目标。
 * 🔴 值里绝不允许 CR/LF（`\r`/`\n`）—— 那是经典的 header injection（响应拆分/请求走私）。
 */

export class HeaderOverridesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeaderOverridesError';
  }
}

/** RFC 7230 token：header 名的合法字符集 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** 控制字符（含 CR/LF/TAB）—— 名与值都不许出现 */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/** 单次请求携带的自定义头数量 / 名长 / 值长上限（防御性，正常用例远低于此） */
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_NAME_LENGTH = 128;
const MAX_HEADER_VALUE_LENGTH = 4096;

/**
 * 禁止用户自定义的头名（小写比较）。
 *
 * 与协议层 `buildLlmTransportHeaders` / BFF `forward()` 生成的头一一对应；新增协议头
 * 时**两处都要加**。BFF 侧有一份独立的同名单（安全边界不 import 前端代码）。
 */
export const PROTECTED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'api-key',
  'x-api-key',
  'x-goog-api-key',
  'anthropic-version',
  'anthropic-beta',
  'content-type',
  'content-length',
  'host',
  'accept',
  'accept-encoding',
  'connection',
  'transfer-encoding',
  'x-target-base-url',
  'x-model-id',
  'x-llm-stream',
  'x-custom-headers',
]);

/** 校验并归一化一个自定义头名；非法或受保护时抛 `HeaderOverridesError`。 */
function normalizeHeaderName(raw: string): string {
  const name = raw.trim();
  if (name === '') throw new HeaderOverridesError('请求头名不能为空');
  if (name.length > MAX_HEADER_NAME_LENGTH) throw new HeaderOverridesError(`请求头名过长: ${name}`);
  if (CONTROL_CHAR_PATTERN.test(name) || !HEADER_NAME_PATTERN.test(name)) {
    throw new HeaderOverridesError(`请求头名含非法字符: ${name}`);
  }
  if (PROTECTED_REQUEST_HEADERS.has(name.toLowerCase())) {
    throw new HeaderOverridesError(`请求头 "${name}" 受保护，不能自定义（由协议 / 代理层生成）`);
  }
  return name;
}

/** 校验一个自定义头的值。 */
function normalizeHeaderValue(name: string, raw: string): string {
  const value = raw.trim();
  if (value.length > MAX_HEADER_VALUE_LENGTH) {
    throw new HeaderOverridesError(`请求头 "${name}" 的值过长`);
  }
  if (CONTROL_CHAR_PATTERN.test(value)) {
    throw new HeaderOverridesError(`请求头 "${name}" 的值含控制字符（含换行）`);
  }
  return value;
}

/**
 * 把任意输入解析成 `HeaderOverrides`（永不返回非法形状；非法内容抛错）。
 * 空对象 / `undefined` / `null` 一律归成 `{}`（合法态，表示没有自定义头）。
 */
export function normalizeHeaderOverrides(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HeaderOverridesError('headerOverrides 必须是 JSON 对象');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_HEADER_COUNT) {
    throw new HeaderOverridesError(`自定义请求头过多（上限 ${MAX_HEADER_COUNT}）`);
  }
  const output: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = normalizeHeaderName(rawName);
    if (typeof rawValue !== 'string') {
      throw new HeaderOverridesError(`请求头 "${name}" 的值必须是字符串`);
    }
    output[name] = normalizeHeaderValue(name, rawValue);
  }
  return output;
}

/**
 * 组装发给 BFF 的 `X-Custom-Headers` 载荷（percent-encoded JSON，保证 ASCII 头值）。
 * 空 / 全被拒时返回 `undefined`（不产生该头）。
 */
export function buildCustomHeadersValue(
  headers: Record<string, string> | undefined,
): string | undefined {
  const normalized = normalizeHeaderOverrides(headers ?? {});
  if (Object.keys(normalized).length === 0) return undefined;
  return encodeURIComponent(JSON.stringify(normalized));
}
