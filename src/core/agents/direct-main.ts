import {
  buildDirectCharacterSections,
  buildDirectTreeSections,
  buildLegacyDirectCacheFrame,
  directTreeCurrentSections,
} from '../prompts/direct-context-frame';
import {
  buildDirectCacheProtocol,
  discardDirectContext,
  invalidateDirectContext,
  prepareDirectContext,
  serializeDirectContext,
  type DirectContextFrame,
  type DirectCacheTicket,
} from '../prompts/direct-context-session';
import type { DirectCachePolicy } from '../types/types-api';
import type {
  AgentConfig,
  AgentContext,
  AgentPreset,
  AgentProviderRound,
  AgentResult,
  ApiEndpoint,
  CharacterState,
  NewsItem,
  StateWriteStats,
  WorldBook,
} from '../types/types';
import { AgentClient, ensureUserMessage } from './agent-client';
import type { ChatRequest } from './agent-client';
import { buildAgentMessagesAsync } from '../prompts/agent-templates';
import { buildStoryContextV2Messages, type StoryContextV2Input } from '../prompts/story-context-v2';
import { selectStoryLore } from '../content/lore-selection';
import { buildDirectProtocol, DIRECT_OUTPUT_REMINDER } from '../prompts/direct-prompt';
import { resolveTemplateWithGlobals } from '../prompts/template-resolver';
import { buildLlmRequest } from '../api/llm-adapter';
import {
  describeEmptyDirectReply,
  isDirectOutputBudgetExhausted,
  isEmptyDirectReply,
  parseDirectOutput,
  type DirectPatchResult,
  type DirectTurnDraft,
} from './direct-output';
import { isDirectStructuredCombatEnabled, type DirectCombatRecord } from '../combat/direct-combat';
import { logEngine } from '../runtime/engine-logger';
import { getEngineSettings } from '../runtime/engine-settings';
import { buildStateTree, type StateTreeObject } from '../variables/state-tree-projection';
import { projectCharacterAge } from '../character/character-age';
import {
  countDirectDice,
  formatDirectDicePool,
  rollDirectDice,
  type DirectDicePool,
} from './direct-dice';

/**
 * 直出主请求已拿到模型回复、但随后失败（输出被拒或 provider 返回 error 结果）。
 * 携带本次 `AgentResult` 供调试记录使用；`original` 是原始错误，调用方记录后应重新抛出它。
 */
export class DirectTurnError extends Error {
  readonly result: AgentResult;
  readonly original: unknown;

  constructor(original: unknown, result: AgentResult) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'DirectTurnError';
    this.result = result;
    this.original = original;
  }
}

export interface DirectGenerationInput {
  config: AgentConfig;
  endpoint: ApiEndpoint;
  context: AgentContext;
  configs: AgentConfig[];
  worldBooks: WorldBook[];
  presets: AgentPreset[];
  combat: DirectCombatRecord | null;
  storyContext?: Pick<StoryContextV2Input, 'windowTurns' | 'segments' | 'archives' | 'onLore'> & {
    onAssembled?: (diagnostics: import('../types/types').StoryContextV2Diagnostics) => void;
  };
  dice?: DirectDicePool;
  /**
   * 状态树协议（tree）读侧的补充输入：AgentContext 里没有的存档字段。缺省时新闻投影为空
   * （legacy 的 direct_state 本来也不带新闻）。legacy 下忽略。
   */
  stateTree?: { news?: readonly NewsItem[] };
  cache?: {
    saveId: string;
    policy: DirectCachePolicy;
    /** 重建时机（用户设置）；不进会话签名 */
    rebuild?: { maxTurns?: number; growthLimit?: number };
  };
}

export async function generateDirectTurn(
  input: DirectGenerationInput,
  client: AgentClient,
): Promise<{
  draft: DirectTurnDraft;
  result: AgentResult;
  cache?: { ticket: DirectCacheTicket };
}> {
  const { config, endpoint, configs, context, presets } = input;
  // 结构化战斗开关整轮只取一次：协议、状态、缓存分区与解析口径必须一致
  const structuredCombat = isDirectStructuredCombatEnabled();
  // 状态协议同样整轮只取一次：读侧投影、协议文字、缓存分区与写侧解析必须同一口径
  const stateProtocol = getEngineSettings().stateProtocol;
  const protocol = buildDirectProtocol(structuredCombat, stateProtocol);
  const combatRecord = structuredCombat ? input.combat : null;
  const dice = input.dice ?? rollDirectDice();
  const diceLines = formatDirectDicePool(dice);
  let messages: ChatRequest['messages'];
  let frame: DirectContextFrame | undefined;
  if (input.storyContext) {
    const assembled = await buildStoryContextV2Messages({
      ...input.storyContext,
      ctx: context,
      configs,
      worldBooks: input.worldBooks,
      presets,
      agentId: 'direct_main',
      loreSelectionMode: 'local',
      cacheLayout: !!input.cache,
    });
    input.storyContext.onAssembled?.(assembled.diagnostics);
    messages = assembled.messages;
    frame = assembled.cacheFrame;
  } else {
    const selection = await selectStoryLore(input.worldBooks, context, undefined, {
      agentId: 'direct_main',
      mode: 'local',
    });
    const selected = new Set(
      [...selection.zones[1], ...selection.zones[3], ...selection.zones[5]].map((r) => r.entry),
    );
    const books = input.worldBooks.map((book) => ({
      ...book,
      entries: book.entries.filter((entry) => selected.has(entry)),
    }));
    const history = resolveTemplateWithGlobals(
      `{{NARRATIVE:layers=${config.historyLayers ?? 6}}}`,
      'direct_main',
      context,
      config,
      books,
      configs,
      {},
    );
    if (input.cache) {
      frame = await buildLegacyDirectCacheFrame(
        input,
        books,
        history,
        new Set(selection.zones[1].map((r) => r.entry)),
      );
      messages = [...frame.prefix, ...frame.history];
    } else {
      const built = await buildAgentMessagesAsync('direct_main', context, configs, books, presets, {
        NARRATIVE: history,
      });
      if (!built) throw new Error('直出提示词未配置');
      messages = built as ChatRequest['messages'];
    }
  }
  const relevant = context.characters.filter(
    (c) =>
      c.type === 'player' ||
      c.present ||
      context.userInput.includes(c.name) ||
      combatRecord?.state.units[c.name],
  );
  const legacyState = {
    // 年龄按游戏时间现算，不发冻结的开局年龄与原始锚点
    characters: relevant.map((character) => {
      const {
        id: _id,
        saveId: _saveId,
        definition: _definition,
        introducedBy: _introducedBy,
        ...c
      } = projectCharacterAge(character, context.gameTime);
      return c;
    }),
    existingNames: context.characters.map((c) => c.name),
    variables: context.variables,
    gameTime: context.gameTime,
    quests: context.quests,
    mapFlags: context.mapFlags,
    mapFacts: context.mapFacts,
    weather: context.weather,
    fp: context.statData?.['命运点数'],
    affections: context.affections,
    openingPrompt: context.openingPrompt === context.userInput ? undefined : context.openingPrompt,
    ...(structuredCombat ? { combat: combatRecord?.state ?? null } : {}),
    plotSettings: context.plotSettings,
    plot: { outline: context.plotOutline, events: context.plotEvents },
  };
  // 状态树协议：stat_data 取代 characters / existingNames / variables / gameTime / quests /
  // weather / fp / affections；地图上下文、openingPrompt、combat、plotSettings、plot 仍是并列原有键
  const statData =
    stateProtocol === 'tree'
      ? buildDirectStateTree(context, relevant, input.stateTree?.news)
      : undefined;
  const { characters: _characters, ...legacyRest } = legacyState;
  const {
    existingNames: _existingNames,
    variables: _variables,
    gameTime: _gameTime,
    quests: _quests,
    weather: _weather,
    fp: _fp,
    affections: _affections,
    ...parallel
  } = legacyRest;
  const state = statData ? { stat_data: statData, ...parallel } : legacyState;
  messages = ensureUserMessage([
    { role: 'system', content: protocol },
    ...messages,
    {
      role: 'user',
      content: `<direct_state>\n${JSON.stringify(state)}\n</direct_state>\n<dice_pool>\n${diceLines.join('\n')}\n</dice_pool>${config.tailPrompt ? `\n${config.tailPrompt}` : ''}\n${DIRECT_OUTPUT_REMINDER}`,
    },
  ]);
  const request: ChatRequest = {
    messages,
    model: config.model || endpoint.defaultModel,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    topP: config.topP,
    frequencyPenalty: config.frequencyPenalty,
    presencePenalty: config.presencePenalty,
  };
  const budget =
    buildLlmRequest({
      protocol:
        endpoint.protocol === 'gemini' || endpoint.protocol === 'anthropic-messages'
          ? endpoint.protocol
          : 'openai-chat',
      ...request,
      model: request.model!,
      stream: false,
      userId: config.userId ?? 'direct',
      bodyOverrides: endpoint.bodyOverrides,
      bodyOmitPaths: endpoint.bodyOmitPaths,
    }).outputBudget ?? 0;
  let ticket: DirectCacheTicket | undefined;
  if (input.cache && frame) {
    // 结构化战斗关闭时 state 不含 combat 键，sections 也就不会出现 combat 分区
    frame.prefix = [
      { role: 'system', content: protocol + '\n' + buildDirectCacheProtocol(stateProtocol) },
      ...frame.prefix,
    ];
    frame.sections = statData
      ? // 状态树：分区键即树路径（全量人物的每个直接子键、摘要角色整块……），并列原有键照旧
        { ...frame.sections, ...parallel, ...buildDirectTreeSections(statData) }
      : {
          ...frame.sections,
          ...legacyRest,
          ...buildDirectCharacterSections(relevant, context.gameTime),
        };
    const endpointSignature = {
      id: endpoint.id,
      protocol: endpoint.protocol,
      baseUrl: endpoint.baseUrl,
      revision: endpoint.revision,
      bodyOverrides: endpoint.bodyOverrides,
      bodyOmitPaths: endpoint.bodyOmitPaths,
      defaultParameters: endpoint.defaultParameters,
      contextWindowTokens: endpoint.contextWindowTokens,
    };
    ticket = await prepareDirectContext({
      saveId: input.cache.saveId,
      signature: serializeDirectContext({
        endpoint: endpointSignature,
        model: request.model,
        preset: presets.find((p) => p.id === config.presetId),
        config: {
          systemPrompt: config.systemPrompt,
          template: config.template,
          tailPrompt: config.tailPrompt,
          historyLayers: config.historyLayers,
          historySlice: config.historySlice,
          temperature: config.temperature,
          topP: config.topP,
          maxTokens: config.maxTokens,
          frequencyPenalty: config.frequencyPenalty,
          presencePenalty: config.presencePenalty,
        },
        books: input.worldBooks,
        contextMode: input.storyContext ? 'v2' : 'legacy',
        windowTurns: input.storyContext?.windowTurns,
        policy: input.cache.policy,
      }),
      frame,
      history: context.history,
      playerInput: context.userInput,
      turnContext: {
        recall: context.agentOutputs.get('memory_recall') ?? '',
        dice_pool: diceLines,
        tailPrompt: config.tailPrompt ?? '',
      },
      tailReminder: DIRECT_OUTPUT_REMINDER,
      ...(statData ? { currentSections: directTreeCurrentSections(statData) } : {}),
      rebuild: input.cache.rebuild,
      outputBudget: budget,
      contextWindowTokens: endpoint.contextWindowTokens,
      signal: config.abortSignal,
    });
    messages = ticket.messages;
    request.messages = messages;
    request.cachePolicy = input.cache.policy;
    request.cacheKey = `direct-cache-v1:${input.cache.saveId}`;
    // ticket.messages 恒以 frame.prefix 原样开头（此时已含协议消息），静态断点落在它的末尾
    request.cacheStaticSystemCount = frame.prefix.length;
    // 留存末尾断点：不留存的本轮尾部每轮都换，不在它上面写缓存
    request.cacheRetainedMessageCount = ticket.retainedCount;
  }
  logEngine(
    'debug',
    'prompt.direct_frame',
    `直出帧组装：${messages.length} 条消息`,
    () => ({
      contextMode: input.storyContext ? 'v2' : 'legacy',
      cached: !!input.cache,
      cachePolicy: input.cache?.policy,
      outputBudget: budget,
      diceCount: countDirectDice(dice),
      state,
      ...(ticket
        ? {
            revision: ticket.revision,
            rebaseReason: ticket.rebaseReason ?? null,
            retainedCount: ticket.retainedCount,
          }
        : {}),
      ...(frame ? { frame } : {}),
      messages,
    }),
    { agentId: 'direct_main' },
  );
  let rejectedOutput = false;
  let result: AgentResult | undefined;
  try {
    const estimatedInput = Math.ceil(
      messages.reduce((sum, m) => sum + String(m.content ?? '').length, 0) / 1.5,
    );
    if (endpoint.contextWindowTokens && estimatedInput + budget > endpoint.contextWindowTokens)
      throw new Error(
        `直出上下文估算 ${estimatedInput} + 输出预留 ${budget} 超出模型窗口 ${endpoint.contextWindowTokens}，请缩短历史或调整输出预留`,
      );
    // 空正文（常见于只出了原生思考）原样重发同一请求：同一张缓存票据，不重新组装上下文
    const rounds: AgentProviderRound[] = [];
    for (let attempt = 0; ; attempt++) {
      result = await sendDirectRequest(client, request, config, !!input.cache);
      if (ticket) {
        result.promptSessionRevision = ticket.revision;
        result.promptRebased = !!ticket.rebaseReason;
        result.promptRebaseReason = ticket.rebaseReason;
        result.directCacheDiagnostics = ticket.diagnostics;
      }
      result.agentId = 'direct_main';
      result.requestMessages = messages;
      const empty = !result.error && isEmptyDirectReply(result.rawResponse);
      const emptyMessage = empty ? describeEmptyDirectReply(result, attempt > 0) : undefined;
      if (
        empty &&
        attempt < DIRECT_EMPTY_REPLY_RETRIES &&
        !isDirectOutputBudgetExhausted(result.finishReason)
      ) {
        if (config.abortSignal?.aborted)
          throw new DOMException('Direct turn cancelled', 'AbortError');
        rounds.push(directRound(result, attempt + 1, emptyMessage));
        // 日志 payload 惰性求值，下面会清掉 result，先取值
        const emptied = {
          attempt: attempt + 1,
          finishReason: result.finishReason ?? null,
          completionTokens: result.completionTokens ?? null,
          reasoningChars: result.reasoning?.length ?? 0,
        };
        logEngine('warn', 'direct.empty_reply', '直出回复没有正文，原样重发一次', () => emptied, {
          agentId: 'direct_main',
        });
        // 清掉上一次结果：重试的传输失败不得带着它被包成 DirectTurnError
        result = undefined;
        continue;
      }
      if (rounds.length)
        result.providerRounds = [
          ...rounds,
          directRound(result, rounds.length + 1, result.error ?? emptyMessage),
        ];
      if (result.error) throw new Error(result.error);
      if (emptyMessage) {
        rejectedOutput = true;
        throw new Error(emptyMessage);
      }
      break;
    }
    rejectedOutput = true;
    let draft: DirectTurnDraft;
    try {
      draft = parseDirectOutput(result.rawResponse, dice, {
        structuredCombat,
        plotEnabled: context.plotSettings?.mode !== 'off',
        stateProtocol,
      });
    } catch (error) {
      // 整楼拒收（§7.1）：本楼只记这一条统计；被接纳的楼由调用方在建补丁后补全并记日志
      const rejected: StateWriteStats = {
        protocol: stateProtocol,
        ops: 0,
        applied: 0,
        corrected: 0,
        dropped: 0,
        rejected: true,
      };
      result.stateWriteStats = rejected;
      logStateWriteStats(rejected, request.model ?? '');
      throw error;
    }
    // 解析期的初步统计；建补丁阶段的丢弃与纠正由调用方经 summarizeStateWrites 补全
    result.stateWriteStats = summarizeStateWrites(stateProtocol, draft);
    if (draft.combatIgnored)
      logEngine(
        'warn',
        'direct.combat_ignored',
        '结构化战斗未启用，已忽略模型输出的 combat 区块',
        undefined,
        { agentId: 'direct_main' },
      );
    if (draft.flattenedCharacters)
      logEngine(
        'warn',
        'direct.entity_flattened',
        `角色实体字段未放进 output.character，已自动归位：${draft.flattenedCharacters.join('、')}`,
        undefined,
        { agentId: 'direct_main' },
      );
    if (draft.normalized)
      logEngine(
        'warn',
        'direct.output_normalized',
        `直出结果形状有偏差，已自动纠正 ${draft.normalized.length} 处`,
        () => ({ notes: draft.normalized }),
        { agentId: 'direct_main' },
      );
    if (draft.dropped) {
      const dropped = draft.dropped;
      // 丢弃项随结果进调试记录（DebugAgentEntry.outputWarnings），UI 在接纳后汇总提示
      result.outputWarnings = [...dropped];
      logEngine(
        'warn',
        'direct.output_dropped',
        `直出结果有 ${dropped.length} 项格式有误，已忽略`,
        () => ({ notes: dropped }),
        { agentId: 'direct_main' },
      );
    }
    if (draft.updatesMissing) {
      const finishReason = result.finishReason ?? null;
      logEngine(
        'warn',
        'direct.updates_missing',
        '直出结果没有 direct_updates 区块，本楼只保存正文',
        () => ({ finishReason }),
        { agentId: 'direct_main' },
      );
    }
    return {
      draft,
      result,
      ...(ticket ? { cache: { ticket } } : {}),
    };
  } catch (error) {
    if (ticket) {
      // 模型已回复但输出被拒绝，或本次被取消：存档未变，上一份已接纳会话仍可复用，只丢弃本次尝试。
      // 供应商/传输失败可能源自会话本身（如原生签名失效），整体失效让下一次冷建自愈。
      if (rejectedOutput || config.abortSignal?.aborted) discardDirectContext(ticket);
      else invalidateDirectContext(ticket.saveId);
    }
    // 模型已回复（被拒或 provider 返回 error 结果）：带上本次结果，供调试记录保留原文与请求消息。
    // 取消时原样抛出，下游靠原始错误判定取消。
    if (result && !config.abortSignal?.aborted) throw new DirectTurnError(error, result);
    throw error;
  }
}

/**
 * 状态树协议的读侧投影（设计 §3.1、§3.4）。全量人物集合沿用 legacy 的判据（主角、在场、本轮输入点名、
 * 结构化战斗参战者 —— 即调用方算好的 `relevant`），其余给摘要。
 */
function buildDirectStateTree(
  context: AgentContext,
  relevant: readonly CharacterState[],
  news: readonly NewsItem[] | undefined,
): StateTreeObject {
  const world = context.statData?.['世界'] as Record<string, unknown> | undefined;
  const turn = world?.['回合'];
  const fp = context.statData?.['命运点数'];
  return buildStateTree(
    {
      characters: context.characters,
      profile: {
        // 缺席时投影不出 命运点数 键（与 legacy direct_state 的 fp 缺省同口径）
        fp: (typeof fp === 'number' ? fp : undefined) as number,
        quests: context.quests ?? {},
        news: [...(news ?? [])],
        variables: context.variables,
        gameTime: context.gameTime!,
        affections: context.affections ?? {},
      },
      ...(context.weather ? { weather: context.weather } : {}),
      ...(typeof turn === 'number' ? { turn } : {}),
    },
    { visibility: { mode: 'focus', fullNames: relevant.map((c) => c.name) } },
  );
}

/**
 * 一楼的状态写入统计（§7.1，只作参考，不设门槛）。`built` 缺席 = 只算解析期（建补丁之前的初步值）。
 *
 * 口径：
 * - `dropped` = 解析期 + 建补丁期的丢弃说明条数，与调试面板「已忽略 N 项」、接纳后提示的数同一个数
 *   （含 character_updates、信封里 plot / diceUsed / tile_ops 等非 op 单元的丢弃）。
 * - tree：`ops` = 解析救回的 patch op 数 + `dropped`；建补丁后 `applied` / `corrected` 取翻译记录里
 *   「已应用」/「已纠正」的条数（逐条 op 计），建补丁前按「解析期带纠正说明的 op」算 `corrected`。
 * - legacy（含 tree 下回落旧形状的楼）没有逐条记录，按写入单元近似：`ops` = 解析后留下的
 *   entities + effects + state 各操作行 + tile_ops + character_updates 条目 + 时间推进（>0 计 1）
 *   + `dropped`；`corrected` = 无损纠正说明的处数（一个单元可能有多处，封顶到未丢弃的单元数），
 *   `applied` = 其余。
 * - 缺 direct_updates 区块的楼 `updatesMissing: true`，op 只来自 character_updates。
 */
export function summarizeStateWrites(
  protocol: 'legacy' | 'tree',
  draft: DirectTurnDraft,
  built?: Pick<DirectPatchResult, 'dropped' | 'stateUpdates'>,
): StateWriteStats {
  const dropped = (draft.dropped?.length ?? 0) + (built?.dropped.length ?? 0);
  let applied: number;
  let corrected: number;
  if (draft.treePatch) {
    const records = built?.stateUpdates?.ops;
    if (records) {
      applied = records.filter((r) => r.status === '已应用' || r.status === '已手动修订').length;
      corrected = records.filter((r) => r.status === '已纠正').length;
    } else {
      const recovered = draft.treePatch.ops.length;
      corrected = Math.min(recovered, new Set(draft.treePatch.normalized.map((n) => n.index)).size);
      applied = recovered - corrected;
    }
  } else {
    const kept = Math.max(0, countLegacyWriteUnits(draft) - (built?.dropped.length ?? 0));
    corrected = Math.min(kept, draft.normalized?.length ?? 0);
    applied = kept - corrected;
  }
  return {
    protocol,
    ops: applied + corrected + dropped,
    applied,
    corrected,
    dropped,
    rejected: false,
    ...(draft.updatesMissing ? { updatesMissing: true as const } : {}),
  };
}

/** 旧形状一楼的写入单元数（解析期丢弃的单元已不在草稿里） */
function countLegacyWriteUnits(draft: DirectTurnDraft): number {
  const rows = (value: unknown): number => {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === 'object')
      return Object.values(value).reduce<number>((sum, v) => sum + rows(v), 0);
    return value === undefined || value === null ? 0 : 1;
  };
  const { updates } = draft;
  const tileOps = (updates.world as { tile_ops?: unknown } | undefined)?.tile_ops;
  return (
    (updates.entities?.length ?? 0) +
    (updates.effects?.length ?? 0) +
    rows(updates.state) +
    (Array.isArray(tileOps) ? tileOps.length : 0) +
    draft.characterUpdates.length +
    ((updates.time?.delta_time ?? 0) > 0 ? 1 : 0)
  );
}

/** 记一楼的 `state.write_stats` 日志事件（每楼一条；payload 带模型名供离线脚本按模型分组） */
export function logStateWriteStats(stats: StateWriteStats, model: string): void {
  logEngine(
    'info',
    'state.write_stats',
    stats.rejected
      ? `状态写入统计（${stats.protocol}）：整楼拒收`
      : `状态写入统计（${stats.protocol}）：${stats.ops} 条，应用 ${stats.applied}，纠正 ${stats.corrected}，丢弃 ${stats.dropped}`,
    () => ({ ...stats, model }),
    { agentId: 'direct_main' },
  );
}

/** 空正文自动重发的次数（长度截断不重发）。 */
const DIRECT_EMPTY_REPLY_RETRIES = 1;

/** 一次主请求往返的计量快照（只在发生过空正文重发时记录）。 */
function directRound(result: AgentResult, round: number, error?: string): AgentProviderRound {
  return {
    round,
    tokensUsed: result.tokensUsed,
    cacheHit: result.cacheHit,
    cacheHitTokens: result.cacheHitTokens,
    cacheMissTokens: result.cacheMissTokens,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    duration: result.duration,
    finishReason: result.finishReason,
    ...(error ? { error } : {}),
  };
}

/** 发出一次主请求；不解析输出，也不碰缓存会话。空正文重发由调用方决定。 */
async function sendDirectRequest(
  client: AgentClient,
  request: ChatRequest,
  config: AgentConfig,
  cached: boolean,
): Promise<AgentResult> {
  if (config.streamCallbacks) {
    return new Promise<AgentResult>((resolve, reject) => {
      void client
        .chatStream(
          request,
          {
            onChunk: config.streamCallbacks!.onChunk,
            onComplete: (stream) => {
              resolve({
                agentId: 'direct_main',
                output: stream.fullText,
                rawResponse: stream.fullText,
                reasoning: stream.reasoning,
                tokensUsed: stream.tokensUsed,
                cacheHit: stream.cacheHit,
                cacheHitTokens: stream.cacheHitTokens,
                cacheMissTokens: stream.cacheMissTokens,
                completionTokens: stream.completionTokens,
                duration: stream.duration,
                finishReason: stream.finishReason,
                ...(cached
                  ? {
                      providerUsage: stream.usage,
                      promptTokens: stream.usage?.inputTokens,
                      tokensUsed: stream.usage?.totalTokens ?? stream.tokensUsed,
                      cacheHitTokens: stream.usage?.cacheReadTokens,
                      cacheMissTokens: stream.usage?.cacheMissTokens,
                    }
                  : {}),
              });
            },
            onError: (error) => {
              config.streamCallbacks!.onError(error);
              reject(new Error(error));
            },
          },
          config.abortSignal,
        )
        .catch(reject);
    });
  }
  return client.chat(request, config.abortSignal);
}
