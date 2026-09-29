/**
 * prompt-session-assembler.ts — LLM 组装层 Delta 会话深模块（T2）
 *
 * 用途：独占 `(saveId, agentId)` 的会话 transcript、baseline signature、revision、
 *       prepare / complete / invalidate 与重基线判断 —— 状态不散进 orchestrator
 *       （设计 §4「模块与 seam」）。
 *
 * 设计真源：
 *   docs/planning/2026-08-22-llm-assembly-delta-architecture-scratch.md §4/§5/§6/§8/§9
 *   + docs/planning/2026-08-22-llm-assembly-delta-implementation-plan.md §6（T2）
 *
 * 关键不变量：
 * - key 固定为 `(saveId, agentId)`（设计 §5.1）；每存档每 Agent 一条 session。
 * - 首轮 / 重基线 = 从当前 `AgentContext` 完整渲染 baseline（复用 `buildAgentMessages` +
 *   同一个 EJS pass 预渲染动态世界书），首轮 user 保留「继续」触发 + code 固定协议说明
 *   + 可选 tailPrompt（设计 §6.1）。
 * - 后续请求 = 复制上次 wire transcript + 成功 assistant 响应 + 新 user delta
 *   （`<context_delta>` + `<turn_context>` + 可选 tailPrompt，设计 §6.2）。
 * - baselineSignature 只比较静态配置：协议版本 / endpoint id / model / systemPrompt 或
 *   story preset 原文 / 模板原文 / Agent 可见世界书 / historyLayers / tailPrompt
 *   （设计 §5.1）；规范化字符串精确比较，不加哈希库。
 * - 内存状态只存：transcript / 上一成功轮投影 / revision / 签名 / 最近两次 prompt token /
 *   未完成位（设计 §5.2）；不写 Dexie，刷新后从当前状态冷建基线。
 * - complete 前不修改已提交 session；handle 携带 `sessionId`（代际）与 `revision`（轮次），
 *   防止过期完成回写（设计 §7.7）。
 * - 失败 / 取消 / 重入 / 显式 invalidate 删除对应 session；重入即重基线，不建锁（§5.3）。
 * - 动态世界书每轮用同一个 EJS pass 至多求值一次（`buildEjsPassContext` +
 *   `prerenderWorldBookEntries`，见 `renderDynamicLore`）。
 * - token 预算：保存最近两次 provider `prompt_tokens`，按 §8.3 公式决定下一轮是否重基线；
 *   未配置 contextWindowTokens 或 provider 不返回 prompt token 时不猜。
 * - 占位符用代码固定四类清单分类（设计 §7.4）：baseline-only / projection-backed /
 *   append-cursor / ephemeral；不新增用户可编辑模板。
 */

import type {
  AgentConfig,
  AgentContext,
  AgentPreset,
  ChatMessage,
  WorldBook,
} from '../types/types';
import type { NativeLlmContent } from '../types/types-api';
import {
  buildAgentMessages,
  buildEjsPassContext,
  defaultHistoryLayers,
  reportEjsFallback,
} from './agent-templates';
import {
  getEntriesForAgent,
  filterActiveEntries,
  prerenderWorldBookEntries,
} from '../content/worldbook-loader';
import { getPreset, assemblePresetContent } from './preset-loader';
import { getDefaultTemplate } from './placeholder-registry';
import { findNextPlaceholder, resolveTemplateWithGlobals } from './template-resolver';
import { USER_PLACEHOLDER_CONTENT } from '../agents/agent-client';
import {
  diffPromptState,
  projectPromptState,
  renderPromptDelta,
  type PromptDeltaOp,
  type PromptRebaseReason,
  type PromptStateProjection,
} from './prompt-state-projection';

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/** delta 协议版本 —— baseline signature 的一部分，升版即全局重基线（设计 §5.1）。 */
export const PROMPT_SESSION_PROTOCOL_VERSION = 'delta-v1';

/**
 * 增量重基线阈值（2026-09-26 修正，问题 1）。
 *
 * 判据：累积的 wire transcript 字符长度 相对「当轮从零全量渲染的纯 prompt 层」超过该比例
 * （>1.2，即多出 20%）时重基线。
 *
 * 为什么不沿用 token 绝对公式（`lastPromptTokens + growth + outputBudget >= contextWindowTokens`）：
 * 该公式把 `outputBudget`（默认 `maxTokens=65536`）也预留进阈值，于是 `contextWindowTokens=128000`
 * 时实际 prompt 上限只有约 62k —— 开局正文本身就超过 128k 的存档会**每回合都判预算不足**，
 * delta 永远累积不起来、形同虚设。改用**相对增长比**后，重基线只反映「累积的 delta 已经比
 * 重新全量渲染还长 20%」，与实际上下文窗口大小解耦，也不再依赖 provider 返回 prompt token
 * （story 流式拿不到 usage 的缺口一并消失）。
 *
 * `contextWindowTokens` 的 token 预算判据仍保留为**可选的绝对溢出保险**（清空即停用）。
 */
const REBASE_GROWTH_RATIO = 1.2;

/** 一次装配 pass 预渲染的产物（EJS pass + 动态世界书文本）；供预算判断与 delta/baseline 共用。 */
interface RenderPass {
  ejsPass: NonNullable<AgentContext['ejsPass']>;
  dynamicLore: string;
}

/**
 * 首轮 user 消息里 code 固定的增量会话协议说明（设计 §6.1 / §9：协议说明由 code 固定注入
 * baseline，不允许用户改 diff 操作 / 索引 / 排序 / 重基线规则，也不形成第二个模板系统）。
 */
const DELTA_PROTOCOL_NOTE = [
  '[增量会话协议 v1]',
  '本会话改用增量上下文：从下一轮起，每条新的 user 消息按固定顺序携带：',
  '1) <context_delta> —— 相对上一成功轮次的权威状态变化（角色/资源/物品/技能/状态/任务/好感/变量/时间/地图/剧情/记忆/历史等）。这是当前最新状态，以此为准，不必回溯旧消息。',
  '2) <turn_context> —— 本轮玩家输入、随机事件候选、最近战斗与上游 Agent 输出。',
  '3) 可选的末尾指令（如果有）。',
  '<context_delta> 为空表示状态未变化。旧消息一律不重写、不删除。',
].join('\n');

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/**
 * 会话重基线原因（机器可读 token，供 T3 记日志 / 判据用）。
 * projection 层三个（`PromptRebaseReason`）+ session 层四个。
 */
export type PromptSessionRebaseReason =
  | PromptRebaseReason
  | 'missing_session'
  | 'signature_changed'
  | 'budget_exhausted'
  | 'reentered'
  | 'transcript_growth';

/**
 * 会话句柄 —— 调用方回传给 complete / invalidate 的身份凭证。
 * `sessionId` 是代际令牌（每次 session 重建取新值，防过期回写）；
 * `revision` 是本次 prepare 对应的轮次号（1-based，baseline 为第 1 轮）。
 */
export interface PromptSessionHandle {
  saveId: string;
  agentId: string;
  sessionId: number;
  revision: number;
}

/** `preparePromptSession` 的输入（T3 接线方从 AgentConfig / ApiEndpoint / 管线组装）。 */
export interface PreparePromptSessionInput {
  saveId: string;
  agentId: string;
  /** 当前权威状态（重基线时从这里完整渲染 baseline）。 */
  ctx: AgentContext;
  /** 全部 Agent 配置（找本 Agent 的 config；同时喂 buildAgentMessages）。 */
  configs?: AgentConfig[];
  /** 已加载世界书（本 Agent 可见条目参与签名与动态区求值）。 */
  worldBooks?: WorldBook[];
  /** 预设（story 用，参与签名与首轮渲染）。 */
  presets?: AgentPreset[];
  /** 链参数（CRAFT_REQUEST / CHAR_DETECT / ITEM_REQUEST 等），进 turn_context。 */
  localParams?: Record<string, string>;
  /** 该 Agent 实际使用的 endpoint id（签名材料，静态）。 */
  endpointId?: string;
  /** 该 Agent 实际使用的 model（签名材料，静态）。 */
  model?: string;
  /** Protocol/URL/body override/revision signature. Never includes the API key. */
  endpointSignature?: string;
  /** Provider-native output ceiling after source overrides/omissions. */
  outputBudget?: number;
  /** 可选的主动重基线依据（设计 §9 / T4 接 ApiEndpoint.contextWindowTokens）。 */
  contextWindowTokens?: number;
  /** 该 Agent 的单一用户自定义末尾指令（设计 §9 / T4 接 AgentConfig.tailPrompt）。 */
  tailPrompt?: string;
}

/** `preparePromptSession` 的返回（设计 §4）。 */
export interface PreparedPromptSession {
  /** 可直接发送的 wire messages；调用方不得再改内容或顺序。 */
  messages: PromptWireMessage[];
  /** null = 不在 v1 范围（如无有效模板），调用方继续走现有无状态路径。 */
  handle: PromptSessionHandle | null;
  rebased: boolean;
  rebaseReason?: PromptSessionRebaseReason;
}

/** `completePromptSession` 只接受成功结果（设计 §4）。 */
export interface PromptSessionCompleteResult {
  rawResponse: string;
  promptTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  completionTokens?: number;
  /** 仅驻留会话内存，用于 Gemini/Claude 原生签名续传；不进入普通 AgentResult/debug 导出。 */
  nativeAssistant?: NativeLlmContent;
}

// ═══════════════════════════════════════════════════════════
// 会话内存状态（设计 §5.2 —— 不写 Dexie）
// ═══════════════════════════════════════════════════════════

interface PromptSession {
  saveId: string;
  agentId: string;
  /** 代际令牌：每次 session 重建（重基线/重入）取新值。 */
  sessionId: number;
  /** 已成功 complete 的轮次数（baseline 第 1 轮 complete 后 = 1）。 */
  revision: number;
  /** 是否存在未完成调用（重入判定：inFlight 时再次 prepare → 重基线）。 */
  inFlight: boolean;
  baselineSignature: string;
  /** 上一次实际 wire transcript（含 baseline + 各轮 assistant；不含本轮未提交 user）。 */
  transcript: PromptWireMessage[];
  /** 上一成功轮的投影（下一轮 diff 的起点）。 */
  projection: PromptStateProjection;
  /** 本轮 prepare 算好的投影（complete 时才 commit，失败则弃）。 */
  pendingProjection: PromptStateProjection | null;
  /** 本轮 prepare 拼好的 user delta（complete 时才写进 transcript）。 */
  pendingUserMessage: PromptWireMessage | null;
  /** 最近一次 provider prompt_tokens（§8.3 预算用）。 */
  lastPromptTokens?: number;
  /** 倒数第二次 provider prompt_tokens（§8.3 预算用）。 */
  secondLastPromptTokens?: number;
  /** 最近一次 cache hit / miss / completion（可观测性，设计 §11.2 日志字段）。 */
  lastCacheHitTokens?: number;
  lastCacheMissTokens?: number;
  lastCompletionTokens?: number;
}

/** 会话表：key = `(saveId, agentId)` 规范化字符串。 */
const sessions = new Map<string, PromptSession>();
/** 代际计数器（每个新 session 对象 +1）。 */
let nextSessionId = 1;
/** wire 消息 id 计数器（wire 消息不是持久化消息，id 只要求唯一）。 */
let wireCounter = 0;

/** 会话内部 wire 消息；原生 provider 块随会话内存/持久化往返，不进入普通 ChatMessage。 */
interface PromptWireMessage extends ChatMessage {
  native?: NativeLlmContent;
}

/**
 * 可持久化的会话快照（2026-09-26，问题 2 设计修正）。
 *
 * 只含重建下一轮增量所需的最小状态：transcript（含原生续接块）+ 投影 diff 起点 +
 * 签名 + 最近两次 provider token。`inFlight` / `pending*` 刻意不落库 —— 刷新后不存在
 * 未完成调用，落进去只会让恢复时误判「重入」。
 */
export interface PersistedPromptSession {
  /** 主键 = `promptSessionKey(saveId, agentId)`。 */
  key: string;
  saveId: string;
  agentId: string;
  sessionId: number;
  revision: number;
  baselineSignature: string;
  transcript: PromptWireMessage[];
  projection: PromptStateProjection;
  lastPromptTokens?: number;
  secondLastPromptTokens?: number;
  lastCacheHitTokens?: number;
  lastCacheMissTokens?: number;
  lastCompletionTokens?: number;
  /** 落库时刻（仅诊断用；不参与任何判据）。 */
  savedAt: number;
}

/**
 * 会话持久化注入缝（2026-09-26）。
 *
 * 引擎默认**不**配置（`sessionStore === null`）→ 纯内存，所有既有引擎单测零改动。
 * 生产在 `game-pipeline` 安装 Dexie 实现，于是**刷新页面后**可续用上一轮的 wire
 * transcript，省掉一次冷基线（问题 2）。规则变化/回退/删除存档时签名校验或显式
 * `invalidatePromptSession` 会让它失效 —— 见各调用点注释。
 *
 * `delete` 的 `agentId` 省略 = 删该存档全部 Agent 的会话（回退/切档用）。
 */
export interface PromptSessionStore {
  load(saveId: string, agentId: string): Promise<PersistedPromptSession | null>;
  save(record: PersistedPromptSession): Promise<void>;
  delete(saveId: string, agentId?: string): Promise<void>;
}

/** 已安装的持久化实现；null = 纯内存（默认）。 */
let sessionStore: PromptSessionStore | null = null;

/** 安装/卸载会话持久化实现（生产由 game-pipeline 安装；测试传 null 回退纯内存）。 */
export function installPromptSessionStore(store: PromptSessionStore | null): void {
  sessionStore = store;
}

/** session key（saveId / agentId 分隔，杜绝拼接歧义）；同时是 Dexie `promptSessions` 主键。 */
export function promptSessionKey(saveId: string, agentId: string): string {
  return `${saveId}\u0000${agentId}`;
}
const sessionKey = promptSessionKey;

/** 构造 provider-independent wire message；原生 assistant 块仅由 complete 写入。 */
function toWireMessage(role: ChatMessage['role'], content: string): PromptWireMessage {
  return { id: `wire-${wireCounter++}`, role, content, timestamp: 0 };
}

/** 空白 tailPrompt 归一化为空串（T4 配置面要求：空白值视为未配置）。 */
function normalizeTail(tailPrompt: string | undefined): string {
  if (tailPrompt === undefined) return '';
  return tailPrompt.trim() === '' ? '' : tailPrompt;
}

// ═══════════════════════════════════════════════════════════
// 持久化：序列化 / 水合 / 恢复（问题 2，2026-09-26）
// ═══════════════════════════════════════════════════════════

/** 内存会话 → 可持久化快照。 */
function toPersistedSession(session: PromptSession): PersistedPromptSession {
  return {
    key: sessionKey(session.saveId, session.agentId),
    saveId: session.saveId,
    agentId: session.agentId,
    sessionId: session.sessionId,
    revision: session.revision,
    baselineSignature: session.baselineSignature,
    transcript: session.transcript,
    projection: session.projection,
    lastPromptTokens: session.lastPromptTokens,
    secondLastPromptTokens: session.secondLastPromptTokens,
    lastCacheHitTokens: session.lastCacheHitTokens,
    lastCacheMissTokens: session.lastCacheMissTokens,
    lastCompletionTokens: session.lastCompletionTokens,
    savedAt: Date.now(),
  };
}

/** 可持久化快照 → 内存会话。恢复出来的会话一定不是「未完成调用」。 */
function fromPersistedSession(record: PersistedPromptSession): PromptSession {
  return {
    saveId: record.saveId,
    agentId: record.agentId,
    sessionId: record.sessionId,
    revision: record.revision,
    inFlight: false,
    baselineSignature: record.baselineSignature,
    transcript: record.transcript,
    projection: record.projection,
    pendingProjection: null,
    pendingUserMessage: null,
    lastPromptTokens: record.lastPromptTokens,
    secondLastPromptTokens: record.secondLastPromptTokens,
    lastCacheHitTokens: record.lastCacheHitTokens,
    lastCacheMissTokens: record.lastCacheMissTokens,
    lastCompletionTokens: record.lastCompletionTokens,
  };
}

/**
 * 内存未命中时尝试从持久化恢复（刷新后继续用上一轮的 wire transcript）。
 * 只接受签名一致、投影属本 Agent、transcript 非空的行；任何异常都退回冷基线。
 */
async function restorePersistedSession(
  input: PreparePromptSessionInput,
): Promise<PromptSession | null> {
  if (!sessionStore) return null;
  try {
    const record = await sessionStore.load(input.saveId, input.agentId);
    if (!record) return null;
    if (record.projection?.agentId !== input.agentId) return null; // 防御：跨 Agent 脏数据
    if (!Array.isArray(record.transcript) || record.transcript.length === 0) return null;
    // 代际令牌防撞：新基线取值必须高于已恢复会话的 sessionId。
    nextSessionId = Math.max(nextSessionId, record.sessionId + 1);
    // 签名是否一致交给 prepare 的既有判据处理 —— 这样重基线原因仍是准确的
    // `signature_changed`，而不是笼统的 `missing_session`。
    return fromPersistedSession(record);
  } catch (error) {
    console.warn('[prompt-session] 读取持久化会话失败，改用冷基线:', error);
    return null;
  }
}

/** 尽力持久化当前会话（fire-and-forget；失败只记日志，不影响本轮结果）。 */
function persistSession(session: PromptSession): void {
  if (!sessionStore) return;
  void sessionStore.save(toPersistedSession(session)).catch((error) => {
    console.warn('[prompt-session] 持久化会话失败（不影响本轮）:', error);
  });
}

/** 尽力删除持久化会话（fire-and-forget；`agentId` 省略 = 整个存档）。 */
function deletePersistedSessions(saveId: string, agentId?: string): void {
  if (!sessionStore) return;
  void sessionStore.delete(saveId, agentId).catch((error) => {
    console.warn('[prompt-session] 删除持久化会话失败:', error);
  });
}

// ═══════════════════════════════════════════════════════════
// 占位符四类分类（设计 §7.4 —— 代码固定，不新增用户可编辑模板）
// ═══════════════════════════════════════════════════════════

type PlaceholderCategory =
  'baseline-only' | 'projection-backed' | 'append-cursor' | 'ephemeral' | 'unknown';

/** baseline-only：只存在于完整 baseline，静态配置变化时重基线。 */
const BASELINE_ONLY_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'SYS_PROMPT',
  'LORE_BOOK',
  'LORE_BOOK_STATIC',
]);

/** projection-backed：从当前权威状态生成幂等 delta（prompt-state-projection 的 scope 面）。 */
const PROJECTION_BACKED_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'CHARACTER_STATE',
  'INVENTORY',
  'SKILL_STATE',
  'QUEST_STATE',
  'GAME_TIME',
  'MAP_CONTEXT',
  'ACTIVE_EFFECTS',
  'MEMORY_ENTRIES',
  'PLOT_EVENTS',
  'LORE_BOOK_DYNAMIC',
]);

/** append-cursor：baseline 按 historyLayers 播种，后续只追加尚未表示的持久消息。 */
const APPEND_CURSOR_PLACEHOLDERS: ReadonlySet<string> = new Set(['NARRATIVE']);

/**
 * ephemeral：每轮放入 turn_context（本轮玩家输入 / 随机事件 / 最近战斗 / 上游输出 / 链参数）。
 * `AGENT.*` 用正则前缀匹配；其余是精确名单。
 */
const EPHEMERAL_PLACEHOLDER_RE =
  /^(?:USER_INPUT|RANDOM_EVENTS|RECENT_COMBAT|AGENT\.[A-Z_]+|CHAR_GEN_RESULT|CRAFT_RESULT|CRAFT_REQUEST|CHAR_DETECT|ITEM_REQUEST|IMAGE_REQUEST|COMBAT_BRIEF|COMBAT_ROSTER|PLOT_THREAD_TURN|PLOT_THREAD_SURFACE|PLOT_CAST_PLAN)$/;

/** 占位符分类（未注册的 → 'unknown'，按现有规则原样保留在 baseline）。 */
function classifyPlaceholder(name: string): PlaceholderCategory {
  if (BASELINE_ONLY_PLACEHOLDERS.has(name)) return 'baseline-only';
  if (PROJECTION_BACKED_PLACEHOLDERS.has(name)) return 'projection-backed';
  if (APPEND_CURSOR_PLACEHOLDERS.has(name)) return 'append-cursor';
  if (EPHEMERAL_PLACEHOLDER_RE.test(name)) return 'ephemeral';
  return 'unknown';
}

// ═══════════════════════════════════════════════════════════
// baseline signature（设计 §5.1 —— 规范化字符串精确比较，无哈希库）
// ═══════════════════════════════════════════════════════════

/** 本 Agent 可见世界书的静态面（id / enabled / order / 条目原文）—— 签名材料。 */
function serializeVisibleWorldBooks(
  agentId: string,
  configs: AgentConfig[],
  worldBooks: WorldBook[],
): string {
  const entries = getEntriesForAgent(agentId, configs, worldBooks);
  return entries
    .map((e) =>
      JSON.stringify({
        uid: e.uid,
        enabled: e.enabled,
        order: e.order,
        content: e.content,
      }),
    )
    .join('\u0001');
}

/** 计算 baseline signature（只含静态配置；不包含本轮状态 / EJS 结果 / 玩家输入 / 上游输出）。 */
function computeBaselineSignature(input: PreparePromptSessionInput): string {
  const {
    agentId,
    configs,
    worldBooks,
    presets,
    endpointId,
    model,
    tailPrompt,
    endpointSignature,
  } = input;
  const config = configs?.find((c) => c.agentId === agentId);

  // systemPrompt 原文：story 走预设原文（assemblePresetContent 结果），其余用 config.systemPrompt。
  let systemSource = config?.systemPrompt ?? '';
  if (agentId === 'story' && presets && config?.presetId) {
    const preset = getPreset(config.presetId, presets);
    if (preset) systemSource = assemblePresetContent(preset, '');
  }

  const template = config?.template || getDefaultTemplate(agentId);
  const historyLayers = config?.historyLayers ?? defaultHistoryLayers(agentId);

  return [
    PROMPT_SESSION_PROTOCOL_VERSION,
    endpointId ?? '',
    model ?? '',
    endpointSignature ?? '',
    systemSource,
    template,
    serializeVisibleWorldBooks(agentId, configs ?? [], worldBooks ?? []),
    String(historyLayers),
    normalizeTail(tailPrompt),
  ].join('\u0000');
}

// ═══════════════════════════════════════════════════════════
// 动态世界书求值（每轮同一 EJS pass 至多一次）
// ═══════════════════════════════════════════════════════════

/**
 * 每轮求值动态世界书一次（设计 §6 工作 5 / §7.5）。
 * 返回 pass（供 buildAgentMessages 复用 memo，避免二次求值）与 dynamicText（投影的
 * loreDynamic）。首轮与后续轮共用这一条路径，行为等价 buildAgentMessagesAsync。
 */
async function renderDynamicLore(
  agentId: string,
  ctx: AgentContext,
  config: AgentConfig | undefined,
  configs: AgentConfig[] | undefined,
  worldBooks: WorldBook[] | undefined,
): Promise<{ ejsPass: NonNullable<AgentContext['ejsPass']>; dynamicLore: string }> {
  const ejsPass = buildEjsPassContext(agentId, ctx, config, configs, worldBooks);
  let dynamicLore = '';
  if (configs && worldBooks) {
    const activeEntries = filterActiveEntries(getEntriesForAgent(agentId, configs, worldBooks));
    const rendered = await prerenderWorldBookEntries(activeEntries, ejsPass);
    ejsPass.loreRender = {
      agentId,
      staticText: rendered.staticText,
      dynamicText: rendered.dynamicText,
      fallbackEntries: rendered.fallbackEntries,
    };
    dynamicLore = rendered.dynamicText;
    if (rendered.fallbackEntries.length > 0) {
      reportEjsFallback(agentId, ctx, rendered.fallbackEntries, worldBooks);
    }
  }
  return { ejsPass, dynamicLore };
}

// ═══════════════════════════════════════════════════════════
// turn_context 渲染（设计 §6.2 / §7.4 —— 只渲染 ephemeral 占位符）
// ═══════════════════════════════════════════════════════════

/** 从模板原文按出现顺序提取占位符名（复刻 template-resolver 的扫描正则）。 */
function extractPlaceholderNames(template: string): string[] {
  const names: string[] = [];
  let pos = 0;
  for (;;) {
    const found = findNextPlaceholder(template, pos);
    if (!found) break;
    const [fullMatch, name, , index] = found;
    names.push(name);
    pos = index + fullMatch.length;
  }
  return names;
}

/**
 * 有效模板（首轮 buildAgentMessages 用的那一份；后续轮用它提取 ephemeral 占位符）。
 * story 预设内部可能自写占位符（模板可能被简化成 {{SYS_PROMPT}}），把预设原文也并入
 * 提取源，保证本轮的 USER_INPUT / AGENT.* 等仍能进入 turn_context。
 */
function effectiveTemplate(
  agentId: string,
  config: AgentConfig | undefined,
  presets: AgentPreset[] | undefined,
): string {
  const base = config?.template || getDefaultTemplate(agentId);
  if (agentId === 'story' && presets && config?.presetId) {
    const preset = getPreset(config.presetId, presets);
    if (preset) return `${base}\n${assemblePresetContent(preset, '')}`;
  }
  return base;
}

/** 渲染 turn_context：当前模板中的 ephemeral 占位符，按出现顺序（去重），空值跳过。 */
function renderTurnContext(
  agentId: string,
  ctx: AgentContext,
  config: AgentConfig | undefined,
  configs: AgentConfig[] | undefined,
  worldBooks: WorldBook[] | undefined,
  presets: AgentPreset[] | undefined,
  localParams: Record<string, string> | undefined,
): string {
  const template = effectiveTemplate(agentId, config, presets);
  const ephemeralNames = [
    ...new Set(
      extractPlaceholderNames(template).filter((n) => classifyPlaceholder(n) === 'ephemeral'),
    ),
  ];
  if (ephemeralNames.length === 0) return '';
  const miniTemplate = ephemeralNames.map((n) => `{{${n}}}`).join('\n');
  return resolveTemplateWithGlobals(
    miniTemplate,
    agentId,
    ctx,
    config ?? ({ agentId } as AgentConfig),
    worldBooks ?? [],
    configs ?? [],
    localParams ?? {},
  );
}

// ═══════════════════════════════════════════════════════════
// user 消息组装（设计 §6）
// ═══════════════════════════════════════════════════════════

/** 首轮 user：'继续'触发 + code 固定协议说明 + 可选 tail（tail 空则省略，非空位于最后）。 */
function composeFirstUserMessage(tailPrompt: string | undefined): string {
  return [USER_PLACEHOLDER_CONTENT, DELTA_PROTOCOL_NOTE, normalizeTail(tailPrompt)]
    .filter((s) => s !== '')
    .join('\n\n');
}

/**
 * 后续 user：context_delta + turn_context + 可选 tail（固定顺序，设计 §6.2）。
 * context_delta / turn_context 空则跳过对应区块（不产空标签）；全空时兜底回「继续」。
 */
function composeDeltaUserMessage(
  deltaText: string,
  turnContext: string,
  tailPrompt: string | undefined,
): string {
  const tail = normalizeTail(tailPrompt);
  const content = [deltaText, turnContext, tail].filter((s) => s !== '').join('\n\n');
  return content === '' ? USER_PLACEHOLDER_CONTENT : content;
}

// ═══════════════════════════════════════════════════════════
// token 预算（设计 §8.3 —— 不猜模型上限）
// ═══════════════════════════════════════════════════════════

/** 该 Agent 的 maxTokens（预算公式用；configs 未提供/找不到时返回 undefined → 不猜）。 */
function resolveAgentMaxTokens(input: PreparePromptSessionInput): number | undefined {
  if (typeof input.outputBudget === 'number') return input.outputBudget;
  const config = input.configs?.find((c) => c.agentId === input.agentId);
  return config?.maxTokens;
}

/**
 * §8.3 预算公式：
 *   lastPromptTokens + max(0, lastGrowthTokens) + agent.maxTokens >= contextWindowTokens
 * 未配置 contextWindowTokens / provider 未返回 prompt token / 拿不到 agent.maxTokens 时不猜。
 */
function shouldRebaseForBudget(session: PromptSession, input: PreparePromptSessionInput): boolean {
  const { contextWindowTokens } = input;
  if (typeof contextWindowTokens !== 'number') return false;
  const { lastPromptTokens, secondLastPromptTokens } = session;
  if (typeof lastPromptTokens !== 'number' || typeof secondLastPromptTokens !== 'number') {
    return false;
  }
  // 🔴 2026-09-26（问题 1）：配置窗口已小于当前 prompt 时，这条绝对保险**无意义** ——
  //    重基线只会得到同样大小的全量 prompt（「开局正文就超过配置窗口」的存档正是如此），
  //    继续触发就是每回合重置。此时忽略它，交给增长比判据；窗口配错/模型窗口确实更小的
  //    情形应由用户改配置，而不是靠一次次无效果的重基线掩盖。
  if (lastPromptTokens >= contextWindowTokens) return false;
  const growth = lastPromptTokens - secondLastPromptTokens;
  const agentMaxTokens = resolveAgentMaxTokens(input);
  if (typeof agentMaxTokens !== 'number' || agentMaxTokens <= 0) return false;
  return lastPromptTokens + Math.max(0, growth) + agentMaxTokens >= contextWindowTokens;
}

/** 累加 wire transcript 里各消息正文的字符数。 */
function measureTranscript(transcript: PromptWireMessage[]): number {
  let total = 0;
  for (const m of transcript) total += m.content?.length ?? 0;
  return total;
}

/**
 * 当轮「纯 prompt 层」的字符数 —— 即若此刻从零全量渲染 baseline，会发出的 system + 首轮 user。
 *
 * 复用同一个 `ejsPass` 调 `buildAgentMessages`（与 `buildBaseline` 同一条路径），因此**不会**
 * 二次求值世界书 EJS。返回 0 表示本 Agent 无有效模板（此时不做增长判断）。
 */
function measureFreshPrompt(
  input: PreparePromptSessionInput,
  ejsPass: NonNullable<AgentContext['ejsPass']>,
): number {
  const raw = buildAgentMessages(
    input.agentId,
    { ...input.ctx, ejsPass },
    input.configs,
    input.worldBooks,
    input.presets,
    input.localParams,
  );
  if (!raw || raw.length === 0) return 0;
  let total = composeFirstUserMessage(input.tailPrompt).length;
  for (const m of raw) total += m.content?.length ?? 0;
  return total;
}

/**
 * 增长重基线判据（问题 1 修正）：累积 transcript 已比「当轮纯 prompt 层」长出
 * `REBASE_GROWTH_RATIO` 以上时重基线，把它收回成紧凑的全量渲染。
 *
 * 不做 provider token 依赖，故 story 流式路径同样生效（旧 token 预算对它是恒 false）。
 */
function shouldRebaseForGrowth(
  session: PromptSession,
  input: PreparePromptSessionInput,
  ejsPass: NonNullable<AgentContext['ejsPass']>,
): boolean {
  const fresh = measureFreshPrompt(input, ejsPass);
  if (fresh <= 0) return false;
  return measureTranscript(session.transcript) > fresh * REBASE_GROWTH_RATIO;
}

// ═══════════════════════════════════════════════════════════
// prepare（首轮 / 重基线 / 追加 delta）
// ═══════════════════════════════════════════════════════════

/** 从当前 AgentContext 完整渲染 baseline（首轮 / 重基线）。 */
async function buildBaseline(
  input: PreparePromptSessionInput,
  signature: string,
  reason: PromptSessionRebaseReason,
  pass?: RenderPass,
): Promise<PreparedPromptSession> {
  const { saveId, agentId, ctx, configs, worldBooks, presets, localParams, tailPrompt } = input;
  const config = configs?.find((c) => c.agentId === agentId);

  // 同一个 EJS pass：预渲染动态世界书 + 挂 memo，再同步渲染 system（等价 buildAgentMessagesAsync）。
  // 调用方若已算过（预算判断用到纯 prompt 层）就复用，保证每轮 EJS 至多求值一次。
  const { ejsPass, dynamicLore } =
    pass ?? (await renderDynamicLore(agentId, ctx, config, configs, worldBooks));

  const raw = buildAgentMessages(
    agentId,
    { ...ctx, ejsPass },
    configs,
    worldBooks,
    presets,
    localParams,
  );
  if (!raw || raw.length === 0) {
    // 不在 v1 范围（无有效模板）—— 调用方走现有无状态路径。
    return { messages: [], handle: null, rebased: false };
  }

  const firstUserContent = composeFirstUserMessage(tailPrompt);
  const transcript: PromptWireMessage[] = [
    ...raw.map((m) => toWireMessage(m.role as ChatMessage['role'], m.content)),
    toWireMessage('user', firstUserContent),
  ];
  const projection = projectPromptState(agentId, ctx, dynamicLore);

  const sessionId = nextSessionId++;
  const session: PromptSession = {
    saveId,
    agentId,
    sessionId,
    revision: 0,
    inFlight: true,
    baselineSignature: signature,
    transcript,
    // 首轮 diff 起点 = 当前投影（baseline 已含完整状态；下一轮 delta 反映 baseline → 本轮变化）。
    projection,
    pendingProjection: projection,
    pendingUserMessage: null,
  };
  sessions.set(sessionKey(saveId, agentId), session);

  const handle: PromptSessionHandle = { saveId, agentId, sessionId, revision: 1 };
  // 🔴 返回 transcript 的**快照**（不是 session.transcript 的引用）：调用方拿到的
  //    messages 不得被随后的 complete（向 session.transcript push）污染 —— 它可能是
  //    已发送的 wire 记录 / 调试面板引用的同一份数组。
  return { messages: [...transcript], handle, rebased: true, rebaseReason: reason };
}

/** `buildDelta` 的输入：已算好的当前投影与 diff（调用方每轮只算一次）。 */
interface DeltaInput {
  currentProjection: PromptStateProjection;
  ops: PromptDeltaOp[];
}

/** 追加 delta（已有 session 且签名/预算/重入/增长均无需重基线）。 */
function buildDelta(
  session: PromptSession,
  input: PreparePromptSessionInput,
  delta: DeltaInput,
): PreparedPromptSession {
  const { saveId, agentId, ctx, configs, worldBooks, presets, localParams, tailPrompt } = input;
  const config = configs?.find((c) => c.agentId === agentId);
  const { currentProjection, ops } = delta;

  const nextRevision = session.revision + 1;
  const deltaText = renderPromptDelta(nextRevision, ops);
  const turnContext = renderTurnContext(
    agentId,
    ctx,
    config,
    configs,
    worldBooks,
    presets,
    localParams,
  );
  const userContent = composeDeltaUserMessage(deltaText, turnContext, tailPrompt);
  const userMessage = toWireMessage('user', userContent);

  // complete 前不修改已提交 transcript —— 只暂存 pending，失败则弃。
  session.pendingProjection = currentProjection;
  session.pendingUserMessage = userMessage;
  session.inFlight = true;

  const handle: PromptSessionHandle = {
    saveId,
    agentId,
    sessionId: session.sessionId,
    revision: nextRevision,
  };
  return { messages: [...session.transcript, userMessage], handle, rebased: false };
}

/**
 * 准备一轮可发送的 wire messages（设计 §4）。
 *
 * - 无 session / 签名变化 / 重入 / 预算不足 → 从当前状态重基线（`rebased: true` + reason）。
 * - 否则复制上次 wire transcript，追加成功 assistant 响应与本轮 user delta。
 */
export async function preparePromptSession(
  input: PreparePromptSessionInput,
): Promise<PreparedPromptSession> {
  const { saveId, agentId } = input;
  const key = sessionKey(saveId, agentId);
  let existing = sessions.get(key);
  const signature = computeBaselineSignature(input);

  // 问题 2（2026-09-26）：内存未命中时尝试从持久化恢复（页面刷新后继续上一轮 wire
  // transcript，省掉一次冷基线）。签名不符/无存储/读失败一律退回冷基线。
  if (!existing && sessionStore) {
    const restored = await restorePersistedSession(input);
    if (restored) {
      sessions.set(key, restored);
      existing = restored;
    }
  }

  if (!existing) {
    return buildBaseline(input, signature, 'missing_session');
  }

  if (existing.inFlight) {
    return buildBaseline(input, signature, 'reentered'); // 设计 §5.3：同 agent 不并发，重入即重基线，不建锁
  }
  if (existing.baselineSignature !== signature) {
    return buildBaseline(input, signature, 'signature_changed');
  }

  // 每轮只求值一次 EJS / 投影一次，供重基线判断与 delta 组装共用（设计 §6 工作 5）。
  const config = input.configs?.find((c) => c.agentId === agentId);
  const pass = await renderDynamicLore(agentId, input.ctx, config, input.configs, input.worldBooks);
  const currentProjection = projectPromptState(agentId, input.ctx, pass.dynamicLore);
  const ops = diffPromptState(existing.projection, currentProjection);

  const rebaseOp = ops.find((op) => op.op === 'rebase');
  if (rebaseOp) {
    // projection 层检测到历史被编辑/删除/重排 → 从当前状态重基线（禁止回滚，§8.2）。
    return buildBaseline(input, signature, rebaseOp.reason, pass);
  }
  if (shouldRebaseForBudget(existing, input)) {
    return buildBaseline(input, signature, 'budget_exhausted', pass);
  }
  if (shouldRebaseForGrowth(existing, input, pass.ejsPass)) {
    return buildBaseline(input, signature, 'transcript_growth', pass);
  }

  return buildDelta(existing, input, { currentProjection, ops });
}

// ═══════════════════════════════════════════════════════════
// complete / invalidate
// ═══════════════════════════════════════════════════════════

/**
 * 提交一轮成功结果（设计 §4 / §7.7）。
 * 只接受成功结果；失败与取消走 `invalidatePromptSession`。
 * 用 handle 的 sessionId（代际）+ revision（轮次）双重校验，过期 handle 不能覆盖新 session。
 */
export function completePromptSession(
  handle: PromptSessionHandle,
  result: PromptSessionCompleteResult,
): void {
  const session = sessions.get(sessionKey(handle.saveId, handle.agentId));
  if (!session) return; // 已失效（invalidate 后重建前）
  if (handle.sessionId !== session.sessionId) return; // 过期 handle：session 已重建（重入/重基线）
  if (handle.revision !== session.revision + 1) return; // 过期 handle：轮次不匹配（重复 complete）
  if (!session.inFlight) return;

  // 提交：把本轮 user delta + assistant 写进已提交 transcript。
  if (session.pendingUserMessage) session.transcript.push(session.pendingUserMessage);
  session.transcript.push({
    ...toWireMessage('assistant', result.rawResponse),
    native: result.nativeAssistant,
  });

  session.projection = session.pendingProjection ?? session.projection;
  session.pendingProjection = null;
  session.pendingUserMessage = null;
  session.inFlight = false;
  session.revision += 1;

  // 最近两次 prompt token（§8.3 预算用；provider 不返回时保持 undefined，不猜）。
  if (typeof result.promptTokens === 'number') {
    session.secondLastPromptTokens = session.lastPromptTokens;
    session.lastPromptTokens = result.promptTokens;
  }
  session.lastCacheHitTokens = result.cacheHitTokens ?? 0;
  session.lastCacheMissTokens = result.cacheMissTokens ?? 0;
  session.lastCompletionTokens = result.completionTokens ?? 0;

  persistSession(session);
}

/**
 * 使会话失效（设计 §4 / §8.1）。
 * - 传 string（saveId）→ 清理该存档下全部 session（存档切换/销毁、快照回退，
 *   T4 生命周期清理 + 问题 2：持久化行一并删除，防止回退后续用旧分支 transcript）。
 * - 传 handle → 删除该 session；过期 handle（sessionId 不匹配）不误删新 session。
 */
export function invalidatePromptSession(handleOrSaveId: PromptSessionHandle | string): void {
  if (typeof handleOrSaveId === 'string') {
    for (const key of sessions.keys()) {
      const session = sessions.get(key);
      if (session && session.saveId === handleOrSaveId) sessions.delete(key);
    }
    deletePersistedSessions(handleOrSaveId);
    return;
  }
  const handle = handleOrSaveId;
  const session = sessions.get(sessionKey(handle.saveId, handle.agentId));
  if (!session) return;
  if (handle.sessionId !== session.sessionId) return; // 过期 handle 不误删新 session
  sessions.delete(sessionKey(handle.saveId, handle.agentId));
  deletePersistedSessions(handle.saveId, handle.agentId);
}

// ═══════════════════════════════════════════════════════════
// 诊断辅助（测试可观测，不参与生产调用链）
// ═══════════════════════════════════════════════════════════

/** 当前内存中的 session 数（测试 / Debug 用；生产调用方不需要它）。 */
export function activePromptSessionCount(): number {
  return sessions.size;
}

/**
 * 重置全部内存 session（仅测试用；生产路径不调用 —— 刷新后自然冷建基线）。
 */
export function resetPromptSessionsForTest(): void {
  sessions.clear();
  nextSessionId = 1;
  wireCounter = 0;
}
