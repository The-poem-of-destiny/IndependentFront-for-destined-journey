/**
 * 回合失败原因的归类与措辞（审查 GAME-05，2026-11-14）。纯函数，零依赖（除类型）。
 *
 * 此前 Agent 模式的失败只给一句「世界的回应在此中断」，真正的错误只进控制台 ——
 * 密钥错了、余额没了、被限流，玩家都只能「再试几次」然后继续失败。
 *
 * 输入的形状（2026-11-14 实测各抛点）：
 * - `AgentClient.postCompletions`：`HTTP <status>: <上游响应体前 200 字>`；
 *   上游响应体**可能回显部分密钥**（如 OpenAI 的「Incorrect API key provided: sk-ab…」），
 *   所以给玩家看的原文一律先过 {@link redactSecrets}。
 * - `EndpointBindingError`（game-pipeline）：显式绑定的 API 池已失效 → 配置类。
 * - missing-pool：主 DAG 空池时编排器报 `Endpoint "" not found` → 配置类。
 * - 网络层：`Failed to fetch` / `NetworkError` / 超时字样 / `TypeError`。
 * - 中止：`AbortError` —— 那不是失败，调用方本就按「已停下」处理，这里兜底归网络类之外的 unknown。
 */
import type { TurnFailureCategory, TurnFailureInfo } from '@engine/types/types';
import { redactSecrets } from '@engine/utils/redact-secrets';

/** 脱敏本体已搬进引擎（插件 `messages` 投影共用），这里留转发，旧调用点不用改 */
export { redactSecrets };

/** 技术详情的最大长度（字符） */
export const TURN_FAILURE_DETAIL_MAX = 300;

export interface TurnFailureCopy {
  /** 一句话说清发生了什么 */
  summary: string;
  /** 建议的下一步 */
  hint: string;
  /** 是否该给「去设置」（钥匙 / 配置问题，重试本身解决不了） */
  needsSettings: boolean;
}

const COPY: Record<TurnFailureCategory, TurnFailureCopy> = {
  auth: {
    summary: 'API 密钥无效或没有权限，模型服务拒绝了请求。',
    hint: '去设置里检查这个 API 源的密钥与权限，改好后再试。',
    needsSettings: true,
  },
  quota: {
    summary: 'API 账户的额度或余额不足。',
    hint: '到服务商那里充值或换一个 API 源后再试。',
    needsSettings: true,
  },
  rate_limit: {
    summary: '请求太频繁，被模型服务限流了。',
    hint: '稍等片刻再试；经常发生的话可以在设置里调低请求频率。',
    needsSettings: false,
  },
  network: {
    summary: '网络连接失败或请求超时。',
    hint: '检查网络与 API 地址是否可达，然后再试。',
    needsSettings: false,
  },
  server: {
    summary: '模型服务那边出错了（服务端错误）。',
    hint: '通常是暂时的，稍后再试；持续出现可以换一个模型或 API 源。',
    needsSettings: false,
  },
  rejected: {
    summary: '模型拒绝了这次请求（参数不被接受，或内容被安全策略拦下）。',
    hint: '换一种说法再试；反复出现请检查模型名与请求参数设置。',
    needsSettings: false,
  },
  config: {
    summary: 'API 配置缺失，或某个 Agent 绑定的 API 源已失效。',
    hint: '去设置里为各个 Agent 重新选择可用的 API 源。',
    needsSettings: true,
  },
  unknown: {
    summary: '出现了一个没能归类的错误。',
    hint: '可以再试一次；反复出现请展开技术详情反馈给作者。',
    needsSettings: false,
  },
};

export function turnFailureCopy(category: TurnFailureCategory): TurnFailureCopy {
  return COPY[category] ?? COPY.unknown;
}

/** 从错误对象 / 字符串里取出可读文本（不抛） */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message || (error.name === 'Error' ? '' : error.name);
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  try {
    return error === undefined ? '' : String(error);
  } catch {
    return '';
  }
}

/** 脱敏 + 截断，给「技术详情」用 */
export function sanitizeFailureDetail(error: unknown): string | undefined {
  const text = redactSecrets(errorText(error)).trim();
  if (!text) return undefined;
  return text.length > TURN_FAILURE_DETAIL_MAX
    ? `${text.slice(0, TURN_FAILURE_DETAIL_MAX)}…`
    : text;
}

/** 把一个错误归到一类。只看状态码与措辞，不看错误类型以外的结构。 */
export function classifyTurnFailure(error: unknown): TurnFailureCategory {
  if ((error as { name?: string } | null)?.name === 'EndpointBindingError') return 'config';
  const text = errorText(error);
  if (!text) return 'unknown';
  const lower = text.toLowerCase();

  // 配置：绑定失效 / 空池 / 端点不是 LLM 源
  if (
    /api 池已失效|绑定的 api|endpoint ".*" not found|not an llm source|未配置.*api|no api/i.test(
      text,
    )
  )
    return 'config';

  const status = Number(/\bHTTP\s+(\d{3})\b/i.exec(text)?.[1] ?? NaN);
  // 余额的明确措辞优先于状态码（不少服务商把余额不足报成 429 或 403）
  if (
    status === 402 ||
    /insufficient[_ ]quota|insufficient[_ ]balance|billing|credit|余额|欠费|额度不足/i.test(text)
  )
    return 'quota';
  if (status === 401 || status === 403) return 'auth';
  if (/invalid[_ ]api[_ ]key|incorrect api key|unauthorized|permission denied/i.test(text))
    return 'auth';
  // 单写一个 quota 多半是「每分钟配额」（如 Gemini 的 429 Quota exceeded）= 限流
  if (status === 429 || /rate[_ ]?limit|too many requests/i.test(text)) return 'rate_limit';
  if (/quota|额度/i.test(text)) return 'quota';
  if (status === 408 || status === 504) return 'network';
  if (status >= 500 && status < 600) return 'server';
  if (status === 400 || status === 404 || status === 413 || status === 422) return 'rejected';
  if (/content[_ ]filter|safety|blocked|moderation|内容.*(拦截|审核)/i.test(text))
    return 'rejected';
  if (
    /failed to fetch|networkerror|network error|timed? ?out|timeout|超时|econn|enotfound|socket|load failed/i.test(
      lower,
    )
  )
    return 'network';
  return 'unknown';
}

/** 一步失败 / 一次抛错 → 玩家看的失败信息 */
export function buildTurnFailure(error: unknown, stepLabel?: string): TurnFailureInfo {
  const detail = sanitizeFailureDetail(error);
  return {
    category: classifyTurnFailure(error),
    ...(stepLabel ? { stepLabel } : {}),
    ...(detail ? { detail } : {}),
  };
}
