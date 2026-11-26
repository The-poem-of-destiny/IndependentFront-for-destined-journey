/**
 * direct-request.ts — 直出主请求的组装（上下文、输入状态区块、缓存票据、请求参数）。
 *
 * 从 direct-main.ts 拆出（2026-11-25 整合审查 R2）。只组装不发送：发送与空正文重发在
 * direct-send.ts，写入统计在 direct-write-stats.ts。开关（结构化战斗 / 状态协议）由调用方
 * 整轮取一次后传进来，这里不读任何设置。
 */
import {
  buildDirectCharacterSections,
  buildDirectTreeSections,
  buildLegacyDirectCacheFrame,
  directTreeCurrentSections,
} from '../prompts/direct-context-frame';
import {
  buildDirectCacheProtocol,
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
  ApiEndpoint,
  CharacterState,
  NewsItem,
  StoryContextV2Diagnostics,
  WorldBook,
} from '../types/types';
import { ensureUserMessage, type ChatRequest } from './agent-client';
import { buildAgentMessagesAsync } from '../prompts/agent-templates';
import { buildStoryContextV2Messages, type StoryContextV2Input } from '../prompts/story-context-v2';
import { selectStoryLore } from '../content/lore-selection';
import { buildDirectProtocol, DIRECT_OUTPUT_REMINDER } from '../prompts/direct-prompt';
import { resolveTemplateWithGlobals } from '../prompts/template-resolver';
import { buildLlmRequest } from '../api/llm-adapter';
import type { DirectCombatRecord } from '../combat/direct-combat';
import { logEngine } from '../runtime/engine-logger';
import { buildStateTree, type StateTreeObject } from '../variables/state-tree-projection';
import { projectCharacterAge } from '../character/character-age';
import { estimateTokens } from '../utils/token-estimate';
import { countDirectDice, formatDirectDicePool, type DirectDicePool } from './direct-dice';

export interface DirectGenerationInput {
  config: AgentConfig;
  endpoint: ApiEndpoint;
  context: AgentContext;
  configs: AgentConfig[];
  worldBooks: WorldBook[];
  presets: AgentPreset[];
  combat: DirectCombatRecord | null;
  storyContext?: Pick<StoryContextV2Input, 'windowTurns' | 'segments' | 'archives' | 'onLore'> & {
    onAssembled?: (diagnostics: StoryContextV2Diagnostics) => void;
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

/** 一轮直出的解析口径：调用方整轮只取一次，协议、状态、缓存分区与解析都按它走 */
export interface DirectTurnSettings {
  structuredCombat: boolean;
  stateProtocol: 'legacy' | 'tree';
  dice: DirectDicePool;
}

export interface DirectRequestPlan {
  request: ChatRequest;
  /** 实际输出预留（请求体里的输出上限；未配置为 0） */
  budget: number;
  /** 缓存直出的会话票据（无缓存直出缺席） */
  ticket?: DirectCacheTicket;
}

/** 输入状态：legacy 整份、并列原有键（tree 下与 stat_data 并列）、tree 的状态树 */
interface DirectStateParts {
  state: Record<string, unknown>;
  legacyRest: Record<string, unknown>;
  parallel: Record<string, unknown>;
  statData?: StateTreeObject;
}

/**
 * 组装一次直出主请求。无缓存直出把协议、上下文与 `direct_state` 拼成消息并按估算检查窗口；
 * 缓存直出只组装帧与分区、交给会话层出票（窗口检查在会话层），不拼无缓存消息与 state JSON。
 */
export async function buildDirectRequest(
  input: DirectGenerationInput,
  settings: DirectTurnSettings,
): Promise<DirectRequestPlan> {
  const { config, endpoint, context } = input;
  const { structuredCombat, stateProtocol, dice } = settings;
  const protocol = buildDirectProtocol(structuredCombat, stateProtocol);
  const combatRecord = structuredCombat ? input.combat : null;
  const diceLines = formatDirectDicePool(dice);
  const { messages: contextMessages, frame } = await assembleContextMessages(input);
  const relevant = context.characters.filter(
    (c) =>
      c.type === 'player' ||
      c.present ||
      context.userInput.includes(c.name) ||
      combatRecord?.state.units[c.name],
  );
  const parts = buildDirectState(input, relevant, structuredCombat, combatRecord, stateProtocol);
  const params = {
    model: config.model || endpoint.defaultModel,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    topP: config.topP,
    frequencyPenalty: config.frequencyPenalty,
    presencePenalty: config.presencePenalty,
  };
  const budget = directOutputBudget(params, config, endpoint);
  let request: ChatRequest;
  let ticket: DirectCacheTicket | undefined;
  if (input.cache && frame) {
    ticket = await prepareCachedTicket(input, frame, parts, relevant, {
      protocol,
      stateProtocol,
      diceLines,
      budget,
      model: params.model,
    });
    request = {
      messages: ticket.messages,
      ...params,
      cachePolicy: input.cache.policy,
      cacheKey: `direct-cache-v1:${input.cache.saveId}`,
      // ticket.messages 恒以 frame.prefix 原样开头（此时已含协议消息），静态断点落在它的末尾
      cacheStaticSystemCount: frame.prefix.length,
      // 留存末尾断点：不留存的本轮尾部每轮都换，不在它上面写缓存
      cacheRetainedMessageCount: ticket.retainedCount,
    };
  } else {
    request = {
      messages: ensureUserMessage([
        { role: 'system', content: protocol },
        ...contextMessages,
        {
          role: 'user',
          content: `<direct_state>\n${JSON.stringify(parts.state)}\n</direct_state>\n<dice_pool>\n${diceLines.join('\n')}\n</dice_pool>${config.tailPrompt ? `\n${config.tailPrompt}` : ''}\n${DIRECT_OUTPUT_REMINDER}`,
        },
      ]),
      ...params,
    };
  }
  const messages = request.messages;
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
      state: parts.state,
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
  // 缓存直出的窗口检查在会话层（按含原生块的整份请求计），这里只管无缓存直出
  if (!ticket) {
    const estimatedInput = estimateTokens(messages.map((m) => String(m.content ?? '')).join(''));
    if (endpoint.contextWindowTokens && estimatedInput + budget > endpoint.contextWindowTokens)
      throw new Error(
        `直出上下文估算 ${estimatedInput} + 输出预留 ${budget} 超出模型窗口 ${endpoint.contextWindowTokens}，请缩短历史或调整输出预留`,
      );
  }
  return { request, budget, ...(ticket ? { ticket } : {}) };
}

/** 上下文消息：Story v2 五区，或旧布局（缓存直出出帧，无缓存直出走模板） */
async function assembleContextMessages(
  input: DirectGenerationInput,
): Promise<{ messages: ChatRequest['messages']; frame?: DirectContextFrame }> {
  const { config, configs, context, presets } = input;
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
    return { messages: assembled.messages, frame: assembled.cacheFrame };
  }
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
    const frame = await buildLegacyDirectCacheFrame(
      input,
      books,
      history,
      new Set(selection.zones[1].map((r) => r.entry)),
    );
    return { messages: [...frame.prefix, ...frame.history], frame };
  }
  const built = await buildAgentMessagesAsync('direct_main', context, configs, books, presets, {
    NARRATIVE: history,
  });
  if (!built) throw new Error('直出提示词未配置');
  return { messages: built as ChatRequest['messages'] };
}

/**
 * 输入状态区块的内容。状态树协议：stat_data 取代 characters / existingNames / variables / gameTime /
 * quests / weather / fp / affections；地图上下文、openingPrompt、combat、plotSettings、plot 仍是并列原有键。
 */
function buildDirectState(
  input: DirectGenerationInput,
  relevant: readonly CharacterState[],
  structuredCombat: boolean,
  combatRecord: DirectCombatRecord | null,
  stateProtocol: 'legacy' | 'tree',
): DirectStateParts {
  const { context } = input;
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
  return {
    state: statData ? { stat_data: statData, ...parallel } : legacyState,
    legacyRest,
    parallel,
    ...(statData ? { statData } : {}),
  };
}

/** 请求体里的实际输出上限（只取决于参数与端点覆盖，与消息无关） */
function directOutputBudget(
  params: Omit<ChatRequest, 'messages'>,
  config: AgentConfig,
  endpoint: ApiEndpoint,
): number {
  return (
    buildLlmRequest({
      protocol:
        endpoint.protocol === 'gemini' || endpoint.protocol === 'anthropic-messages'
          ? endpoint.protocol
          : 'openai-chat',
      ...params,
      messages: [{ role: 'user', content: '' }],
      model: params.model!,
      stream: false,
      userId: config.userId ?? 'direct',
      bodyOverrides: endpoint.bodyOverrides,
      bodyOmitPaths: endpoint.bodyOmitPaths,
    }).outputBudget ?? 0
  );
}

/** 缓存直出：协议消息并进静态前缀、状态切成分区，向会话层取本轮票据 */
async function prepareCachedTicket(
  input: DirectGenerationInput,
  frame: DirectContextFrame,
  parts: DirectStateParts,
  relevant: readonly CharacterState[],
  turn: {
    protocol: string;
    stateProtocol: 'legacy' | 'tree';
    diceLines: string[];
    budget: number;
    model: string | undefined;
  },
): Promise<DirectCacheTicket> {
  const { config, endpoint, context, presets } = input;
  const cache = input.cache!;
  // 结构化战斗关闭时 state 不含 combat 键，sections 也就不会出现 combat 分区
  frame.prefix = [
    {
      role: 'system',
      content: turn.protocol + '\n' + buildDirectCacheProtocol(turn.stateProtocol),
    },
    ...frame.prefix,
  ];
  frame.sections = parts.statData
    ? // 状态树：分区键即树路径（全量人物的每个直接子键、摘要角色整块……），并列原有键照旧
      { ...frame.sections, ...parts.parallel, ...buildDirectTreeSections(parts.statData) }
    : {
        ...frame.sections,
        ...parts.legacyRest,
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
  return prepareDirectContext({
    saveId: cache.saveId,
    signature: serializeDirectContext({
      endpoint: endpointSignature,
      model: turn.model,
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
      policy: cache.policy,
    }),
    frame,
    history: context.history,
    playerInput: context.userInput,
    turnContext: {
      recall: context.agentOutputs.get('memory_recall') ?? '',
      dice_pool: turn.diceLines,
      tailPrompt: config.tailPrompt ?? '',
    },
    tailReminder: DIRECT_OUTPUT_REMINDER,
    ...(parts.statData ? { currentSections: directTreeCurrentSections(parts.statData) } : {}),
    rebuild: cache.rebuild,
    outputBudget: turn.budget,
    contextWindowTokens: endpoint.contextWindowTokens,
    signal: config.abortSignal,
  });
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
