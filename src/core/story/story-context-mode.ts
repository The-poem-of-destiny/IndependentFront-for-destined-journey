/**
 * Story 上下文与记忆新模式（v2）的模式边界 —— 测试档标记、存档准入与正文窗口 N 的校验。
 *
 * 计划依据：docs/planning/2026-09-30-story-context-memory-content-routing-plan.md
 * §2.4（模式开关）/ §3.2（N 的唯一口径）/ §11.3（测试存档标记与准入）。
 *
 * 🔴 纯函数、无 I/O：开关真源在前端设置，这里只回答「这个存档在这个模式下能不能用」。
 *    所有入口（载入、继续、重生成、开场 Prompt）共用 `decideStoryContextAdmission`，
 *    别在调用点各写一份判据 —— 漏一处就是测试档在旧管线里跑出一轮旧记忆。
 * 🔴 措辞不在这里：拒绝原因是封闭枚举，中文提示由 UI 层映射。
 */
import type { SaveSlot, StoryContextV2SaveMarker } from '../types/types';

/** 一个回合（及其后置任务）运行时固定使用的 Story 模式。 */
type StoryContextMode = 'legacy' | 'v2';

type StoryContextRejection =
  /** 测试档，但新模式开关关闭 */
  | 'v2-save-requires-v2-mode'
  /** 普通存档，但新模式开关开启（不自动升级为测试档） */
  | 'legacy-save-in-v2-mode';

export type StoryContextAdmission =
  { ok: true; mode: StoryContextMode } | { ok: false; reason: StoryContextRejection };

/** 生成一份新标记。只在建档时调用；已有标记的存档不要重打。 */
export function createStoryContextV2Marker(now: number): StoryContextV2SaveMarker {
  return { schema: 1, markedAt: now };
}

/**
 * 存档是否为 v2 测试档。
 *
 * 判据是「标记对象存在」而不是 `schema === 1`：未来 schema 升级后，旧引擎也必须继续
 * 把它认作测试档并拒绝在旧模式下使用 —— 认不出就放行，等于标记失效。
 */
export function isStoryContextV2Save(save: Pick<SaveSlot, 'metadata'> | null | undefined): boolean {
  const marker = (save?.metadata as Record<string, unknown> | undefined)?.storyContextV2;
  return typeof marker === 'object' && marker !== null;
}

/**
 * 存档准入：测试档只能在新模式下使用，普通档只能在旧模式下使用（D17/D18，T35/T43）。
 *
 * 没有「降级」分支：新模式失败不得回落旧管线（T40），普通档也不会被自动打标。
 */
export function decideStoryContextAdmission(
  save: Pick<SaveSlot, 'metadata'> | null | undefined,
  v2Enabled: boolean,
): StoryContextAdmission {
  const isV2Save = isStoryContextV2Save(save);
  if (isV2Save && !v2Enabled) return { ok: false, reason: 'v2-save-requires-v2-mode' };
  if (!isV2Save && v2Enabled) return { ok: false, reason: 'legacy-save-in-v2-mode' };
  return { ok: true, mode: isV2Save ? 'v2' : 'legacy' };
}

/**
 * 正文窗口 N 的校验（D05）：只接受正整数，N=0、负数、小数、非数字一律拒绝。
 *
 * 返回 `null` 表示非法 —— 调用方必须明确报错，不能静默换成某个默认值
 * （默认值与存储位置仍待 Q09 裁定，不在这里猜）。
 */
export function normalizeStoryWindowTurns(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

/**
 * 粗估 token 的字符比（中文为主的正文约 1.5 字 / token）。只用于提示「可能超限」，
 * 不是 provider 计数 —— 真实用量以响应里的 usage 为准。
 */
const CHARS_PER_ESTIMATED_TOKEN = 1.5;

/**
 * 新模式整轮上下文的预算检查（计划 §3.5）：超出端点上下文窗口时由调用方**明确报告**
 * 各区用量，不偷偷截断正文、不按数量裁剪摘要、不伪造归档。端点没配窗口 → 不判断。
 */
export function assessStoryContextBudget(
  diagnostics: { totalChars: number; outputReservedTokens?: number },
  contextWindowTokens: number | undefined,
): { estimatedTokens: number; contextWindowTokens?: number; overBudget: boolean } {
  const estimatedTokens = Math.ceil(diagnostics.totalChars / CHARS_PER_ESTIMATED_TOKEN);
  const window =
    typeof contextWindowTokens === 'number' && contextWindowTokens > 0
      ? contextWindowTokens
      : undefined;
  return {
    estimatedTokens,
    ...(window !== undefined ? { contextWindowTokens: window } : {}),
    overBudget:
      window !== undefined && estimatedTokens + (diagnostics.outputReservedTokens ?? 0) > window,
  };
}
