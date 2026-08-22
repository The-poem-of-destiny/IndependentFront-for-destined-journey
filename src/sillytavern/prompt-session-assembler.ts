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
  AgentResult,
  ChatMessage,
  WorldBook,
} from './types';
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
} from './worldbook-loader';
import { getPreset, assemblePresetContent } from './preset-loader';
import { getDefaultTemplate } from './placeholder-registry';
import { findNextPlaceholder, resolveTemplateWithGlobals } from './template-resolver';
import { USER_PLACEHOLDER_CONTENT } from './agent-client';
import {
  diffPromptState,
  projectPromptState,
  renderPromptDelta,
  type PromptRebaseReason,
  type PromptStateProjection,
} from './prompt-state-projection';

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/** delta 协议版本 —— baseline signature 的一部分，升版即全局重基线（设计 §5.1）。 */
export const PROMPT_SESSION_PROTOCOL_VERSION = 'delta-v1';

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
  PromptRebaseReason | 'missing_session' | 'signature_changed' | 'budget_exhausted' | 'reentered';

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
  /** 可选的主动重基线依据（设计 §9 / T4 接 ApiEndpoint.contextWindowTokens）。 */
  contextWindowTokens?: number;
  /** 该 Agent 的单一用户自定义末尾指令（设计 §9 / T4 接 AgentConfig.tailPrompt）。 */
  tailPrompt?: string;
}

/** `preparePromptSession` 的返回（设计 §4）。 */
export interface PreparedPromptSession {
  /** 可直接发送的 wire messages；调用方不得再改内容或顺序。 */
  messages: ChatMessage[];
  /** null = 不在 v1 范围（如无有效模板），调用方继续走现有无状态路径。 */
  handle: PromptSessionHandle | null;
  rebased: boolean;
  rebaseReason?: PromptSessionRebaseReason;
}

/** `completePromptSession` 只接受成功结果（设计 §4）；形状 = Pick<AgentResult, ...>。 */
export type PromptSessionCompleteResult = Pick<
  AgentResult,
  'rawResponse' | 'promptTokens' | 'cacheHitTokens' | 'cacheMissTokens' | 'completionTokens'
>;

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
  transcript: ChatMessage[];
  /** 上一成功轮的投影（下一轮 diff 的起点）。 */
  projection: PromptStateProjection;
  /** 本轮 prepare 算好的投影（complete 时才 commit，失败则弃）。 */
  pendingProjection: PromptStateProjection | null;
  /** 本轮 prepare 拼好的 user delta（complete 时才写进 transcript）。 */
  pendingUserMessage: ChatMessage | null;
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

/** session key（saveId / agentId 分隔，杜绝拼接歧义）。 */
function sessionKey(saveId: string, agentId: string): string {
  return `${saveId}\u0000${agentId}`;
}

/** 把 wire 消息包装成 ChatMessage（id / timestamp 无业务语义，只要求稳定）。 */
function toWireMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: `wire-${wireCounter++}`, role, content, timestamp: 0 };
}

/** 空白 tailPrompt 归一化为空串（T4 配置面要求：空白值视为未配置）。 */
function normalizeTail(tailPrompt: string | undefined): string {
  if (tailPrompt === undefined) return '';
  return tailPrompt.trim() === '' ? '' : tailPrompt;
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
  /^(?:USER_INPUT|RANDOM_EVENTS|RECENT_COMBAT|AGENT\.[A-Z_]+|CHAR_GEN_RESULT|CRAFT_RESULT|CRAFT_REQUEST|CHAR_DETECT|ITEM_REQUEST|IMAGE_REQUEST|COMBAT_BRIEF|COMBAT_ROSTER)$/;

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
  const { agentId, configs, worldBooks, presets, endpointId, model, tailPrompt } = input;
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
  const growth = lastPromptTokens - secondLastPromptTokens;
  const agentMaxTokens = resolveAgentMaxTokens(input);
  if (typeof agentMaxTokens !== 'number' || agentMaxTokens <= 0) return false;
  return lastPromptTokens + Math.max(0, growth) + agentMaxTokens >= contextWindowTokens;
}

// ═══════════════════════════════════════════════════════════
// prepare（首轮 / 重基线 / 追加 delta）
// ═══════════════════════════════════════════════════════════

/** 从当前 AgentContext 完整渲染 baseline（首轮 / 重基线）。 */
async function buildBaseline(
  input: PreparePromptSessionInput,
  signature: string,
  reason: PromptSessionRebaseReason,
): Promise<PreparedPromptSession> {
  const { saveId, agentId, ctx, configs, worldBooks, presets, localParams, tailPrompt } = input;
  const config = configs?.find((c) => c.agentId === agentId);

  // 同一个 EJS pass：预渲染动态世界书 + 挂 memo，再同步渲染 system（等价 buildAgentMessagesAsync）。
  const { ejsPass, dynamicLore } = await renderDynamicLore(
    agentId,
    ctx,
    config,
    configs,
    worldBooks,
  );

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
  const transcript: ChatMessage[] = [
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

/** 追加 delta（已有 session 且签名/预算/重入均无需重基线）。 */
async function buildDelta(
  session: PromptSession,
  input: PreparePromptSessionInput,
): Promise<PreparedPromptSession> {
  const { saveId, agentId, ctx, configs, worldBooks, presets, localParams, tailPrompt } = input;
  const config = configs?.find((c) => c.agentId === agentId);

  const { dynamicLore } = await renderDynamicLore(agentId, ctx, config, configs, worldBooks);
  const currentProjection = projectPromptState(agentId, ctx, dynamicLore);

  const ops = diffPromptState(session.projection, currentProjection);
  const rebaseOp = ops.find((op) => op.op === 'rebase');
  if (rebaseOp) {
    // projection 层检测到历史被编辑/删除/重排 → 从当前状态重基线（禁止回滚，§8.2）。
    return buildBaseline(input, computeBaselineSignature(input), rebaseOp.reason);
  }

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
  const existing = sessions.get(key);
  const signature = computeBaselineSignature(input);

  if (!existing) {
    return buildBaseline(input, signature, 'missing_session');
  }

  if (existing.inFlight) {
    return buildBaseline(input, signature, 'reentered'); // 设计 §5.3：同 agent 不并发，重入即重基线，不建锁
  }
  if (existing.baselineSignature !== signature) {
    return buildBaseline(input, signature, 'signature_changed');
  }
  if (shouldRebaseForBudget(existing, input)) {
    return buildBaseline(input, signature, 'budget_exhausted');
  }

  return buildDelta(existing, input);
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
  session.transcript.push(toWireMessage('assistant', result.rawResponse));

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
}

/**
 * 使会话失效（设计 §4 / §8.1）。
 * - 传 string（saveId）→ 清理该存档下全部 session（存档切换/销毁，T4 生命周期清理）。
 * - 传 handle → 删除该 session；过期 handle（sessionId 不匹配）不误删新 session。
 */
export function invalidatePromptSession(handleOrSaveId: PromptSessionHandle | string): void {
  if (typeof handleOrSaveId === 'string') {
    for (const key of sessions.keys()) {
      const session = sessions.get(key);
      if (session && session.saveId === handleOrSaveId) sessions.delete(key);
    }
    return;
  }
  const handle = handleOrSaveId;
  const session = sessions.get(sessionKey(handle.saveId, handle.agentId));
  if (!session) return;
  if (handle.sessionId !== session.sessionId) return; // 过期 handle 不误删新 session
  sessions.delete(sessionKey(handle.saveId, handle.agentId));
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
