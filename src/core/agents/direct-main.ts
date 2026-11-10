import { buildLegacyDirectCacheFrame } from '../prompts/direct-context-frame';
import {
  DIRECT_CACHE_PROTOCOL,
  prepareDirectContext,
  serializeDirectContext,
  type DirectContextFrame,
  type DirectCacheTicket,
} from '../prompts/direct-context-session';
import type { DirectCachePolicy, NativeLlmContent } from '../types/types-api';
import type {
  AgentConfig,
  AgentContext,
  AgentPreset,
  AgentResult,
  ApiEndpoint,
  WorldBook,
} from '../types/types';
import { AgentClient, ensureUserMessage } from './agent-client';
import type { ChatRequest } from './agent-client';
import { buildAgentMessagesAsync } from '../prompts/agent-templates';
import { buildStoryContextV2Messages, type StoryContextV2Input } from '../prompts/story-context-v2';
import { selectStoryLore } from '../content/lore-selection';
import { DIRECT_PROTOCOL } from '../prompts/direct-prompt';
import { resolveTemplateWithGlobals } from '../prompts/template-resolver';
import { buildLlmRequest } from '../api/llm-adapter';
import { parseDirectOutput, type DirectTurnDraft } from './direct-output';
import type { DirectCombatRecord } from '../combat/direct-combat';

export interface DirectDie {
  index: number;
  sides: number;
  value: number;
}

export function rollDirectDice(): DirectDie[] {
  const dice: DirectDie[] = [];
  for (const sides of [4, 6, 8, 10, 12, 20, 100]) {
    const count = sides === 20 ? 60 : 20;
    for (let i = 0; i < count; i++) {
      const limit = Math.floor(0x100000000 / sides) * sides;
      let n: number;
      do {
        n = crypto.getRandomValues(new Uint32Array(1))[0];
      } while (n >= limit);
      dice.push({ index: dice.length, sides, value: (n % sides) + 1 });
    }
  }
  return dice;
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
  dice?: DirectDie[];
  cache?: { saveId: string; policy: DirectCachePolicy };
}

export async function generateDirectTurn(
  input: DirectGenerationInput,
  client: AgentClient,
): Promise<{
  draft: DirectTurnDraft;
  result: AgentResult;
  cache?: { ticket: DirectCacheTicket; rawResponse: string; nativeAssistant?: NativeLlmContent };
}> {
  const { config, endpoint, configs, context, presets } = input;
  const dice = input.dice ?? rollDirectDice();
  let messages: ChatRequest['messages'];
  let frame: DirectContextFrame | undefined;
  let loreKeys: string[] = [];
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
    loreKeys = Object.values(assembled.diagnostics.loreKeysByZone ?? {}).flat();
  } else {
    const selection = await selectStoryLore(input.worldBooks, context, undefined, {
      agentId: 'direct_main',
      mode: 'local',
    });
    loreKeys = [...selection.zones[1], ...selection.zones[3], ...selection.zones[5]].map(
      (r) => r.key,
    );
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
      frame = await buildLegacyDirectCacheFrame(input, books, history);
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
      input.combat?.state.units[c.name],
  );
  const state = {
    characters: relevant.map(
      ({ id: _id, saveId: _saveId, definition: _definition, introducedBy: _introducedBy, ...c }) =>
        c,
    ),
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
    combat: input.combat?.state ?? null,
    plotSettings: context.plotSettings,
    plot: { outline: context.plotOutline, events: context.plotEvents },
  };
  messages = ensureUserMessage([
    { role: 'system', content: DIRECT_PROTOCOL },
    ...messages,
    {
      role: 'user',
      content: `<direct_state>\n${JSON.stringify(state)}\n</direct_state>\n<dice_pool>\n${JSON.stringify(dice)}\n</dice_pool>${config.tailPrompt ? `\n${config.tailPrompt}` : ''}`,
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
    const { characters, combat, ...rest } = state;
    frame.prefix = [
      { role: 'system', content: DIRECT_PROTOCOL + '\n' + DIRECT_CACHE_PROTOCOL },
      ...frame.prefix,
    ];
    frame.sections = {
      ...frame.sections,
      ...rest,
      combat,
      characters,
      resources: characters.map(({ name, hp, mp, sp, maxHp, maxMp, maxSp }) => ({
        name,
        hp,
        mp,
        sp,
        maxHp,
        maxMp,
        maxSp,
      })),
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
        loreKeys,
        contextMode: input.storyContext ? 'v2' : 'legacy',
        windowTurns: input.storyContext?.windowTurns,
        policy: input.cache.policy,
      }),
      frame,
      history: context.history,
      turn: `<turn_context>\n${serializeDirectContext({ playerInput: context.userInput, recall: context.agentOutputs.get('memory_recall') ?? '', dice_pool: dice.map(({ sides, value }) => [sides, value]), tailPrompt: config.tailPrompt ?? '' })}\n</turn_context>`,
      outputBudget: budget,
      contextWindowTokens: endpoint.contextWindowTokens,
      signal: config.abortSignal,
    });
    messages = ticket.messages;
    request.messages = messages;
    request.cachePolicy = input.cache.policy;
    request.cacheKey = `direct-cache-v1:${input.cache.saveId}`;
  }
  const estimatedInput = Math.ceil(
    messages.reduce((sum, m) => sum + String(m.content ?? '').length, 0) / 1.5,
  );
  if (endpoint.contextWindowTokens && estimatedInput + budget > endpoint.contextWindowTokens)
    throw new Error(
      `直出上下文估算 ${estimatedInput} + 输出预留 ${budget} 超出模型窗口 ${endpoint.contextWindowTokens}，请缩短历史或调整输出预留`,
    );
  let result: AgentResult;
  let nativeAssistant: NativeLlmContent | undefined;
  if (config.streamCallbacks) {
    result = await new Promise<AgentResult>((resolve, reject) => {
      void client
        .chatStream(
          request,
          {
            onChunk: config.streamCallbacks!.onChunk,
            onComplete: (stream) => {
              nativeAssistant = stream.nativeAssistant;
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
                ...(input.cache
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
  } else result = await client.chat(request, config.abortSignal);
  nativeAssistant ??= (result as AgentResult & { _nativeAssistant?: NativeLlmContent })
    ._nativeAssistant;
  if (ticket) {
    result.promptSessionRevision = ticket.revision;
    result.promptRebased = !!ticket.rebaseReason;
    result.promptRebaseReason = ticket.rebaseReason;
  }
  result.agentId = 'direct_main';
  result.requestMessages = messages;
  if (result.error) throw new Error(result.error);
  const draft = parseDirectOutput(result.rawResponse, dice.length);
  return {
    draft,
    result,
    ...(ticket ? { cache: { ticket, rawResponse: result.rawResponse, nativeAssistant } } : {}),
  };
}
