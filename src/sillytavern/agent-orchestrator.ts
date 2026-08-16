/**
 * Agent 编排引擎 — DAG 依赖调度 + 并行/串行混合执行
 *
 * 核心职责:
 * 1. 按 Pipeline.stages 顺序执行阶段
 * 2. 同阶段内多个 Agent 并行执行
 * 3. 上游 Agent 输出注入 context.agentOutputs（单向流动，不可回写）
 * 4. 失败重试 & 手动重生成
 * 5. 输出验证
 */

import type {
  Pipeline,
  PipelineStage,
  AgentContext,
  AgentResult,
  OrchestratorRun,
  AgentConfig,
  ApiEndpoint,
  CraftRequestMarker,
  CombatTriggerMarker,
  CombatSummaryResult,
  PlayAudioMarker,
  CharGenRequestMarker,
  ItemGenRequestMarker,
  ItemUpdateRequestMarker,
  CraftGenRequestMarker,
  EventTriggerMarker,
  ToolExecutionContext,
} from './types';
import type { SceneImageMarker } from './types-image';
import { AgentClient } from './agent-client';
import type { ChatRequest } from './agent-client';
import { buildAgentMessagesAsync } from './agent-templates';
import { scanMarkers } from './marker-protocol';
import { recallMemories } from './memory-store';
import { buildZoneContext } from './context-visibility';
import { getToolsForAgent, executeToolCall } from './agent-tools';
import { rescueStoryOutput } from './story-rescue';
// Q-19：AI JSON → StatePatch 的纯映射（本文件此前把它和 stage 归类、抠块、落库、
// marker 回调编排一起塞在一个 560 行私有方法里）
import {
  buildDispatcherPatches,
  buildQuestPatches,
  buildVarsUpdatePatches,
} from './vars-update-translator';

// ========== Types ==========

import type { AgentPreset, WorldBook } from './types';

export interface OrchestratorOptions {
  pipeline: Pipeline;
  context: AgentContext;
  agentConfigs: AgentConfig[];
  endpoints: ApiEndpoint[];
  saveId: string;
  /** Phase 8: 预加载的世界书 */
  worldBooks?: WorldBook[];
  /** Phase 8: 预加载的预设列表 */
  presets?: AgentPreset[];
  /** 可选的外部 fetch，用于测试注入 */
  fetch?: typeof fetch;
  /** 手动指定要运行的 Agent（空 = 全部） */
  onlyAgents?: string[];
}

export interface OrchestratorEvents {
  onStageStart?: (stageIndex: number, agents: string[]) => void;
  onAgentStart?: (agentId: string, config: AgentConfig) => void;
  onAgentComplete?: (result: AgentResult) => void | Promise<void>;
  onAgentError?: (agentId: string, error: string) => void;
  onStageComplete?: (stageIndex: number) => void;
  /** StatePatch 提交后存在失败项时触发（source = 'request_dispatcher' | 'vars_update' 等） */
  onStateCommitError?: (source: string, errors: string[]) => void;

  /**
   * 🆕 工坊 P2 (ADR-30 D5): 一个 stage 的 Agent 全部跑完、**在本 stage 的标记处理
   * 与任何后续 stage 之前** 触发，把该 stage 内持权 Agent 的 EJS `vars` 草稿差量
   * 落库。
   *
   * 为什么钉在这里: vars_update / request_dispatcher 的 AI 变量补丁在
   * `processStageMarkers()` 里提交；EJS 差量必须**先于**它们落，路径冲突时才能
   * 由 AI 覆盖 EJS（契约级顺序，见设计 §0 / D5）。
   *
   * **被 await**（差量必须先落完）但**永不让 stage 失败** —— 内部抛错只 warn。
   * 参数是本 stage 的 agentId 列表；实际有没有草稿由调用方按表内存在性过滤。
   */
  onEjsVarsFlush?: (agentIds: string[]) => void | Promise<void>;

  // ===== Phase 6e: Marker Protocol 回调 (旧格式，向后兼容) =====

  /**
   * 🛑 Craft Request: Stage 1 正文中检测到 <craft_request> 后触发。
   * 调用方应阻塞执行制作 (Code计算 + AI创意)，返回结果叙事注入 story output。
   * 返回 null 跳过此标记。
   */
  onCraftRequest?: (marker: CraftRequestMarker, storyOutput: string) => Promise<string | null>;

  /**
   * 🚩 Combat Trigger: Stage 1 正文中检测到 <combat_trigger> 后触发。
   * 调用方应打开独立战斗页面，返回战斗摘要+经验+patches。
   * 返回 null 跳过此标记。
   */
  onCombatTrigger?: (
    marker: CombatTriggerMarker,
    storyOutput: string,
  ) => Promise<CombatSummaryResult | null>;

  /**
   * 🎵 Play Audio: Stage 1 正文中检测到 <play_audio> 后触发，切换 BGM。
   *
   * **不 await、不阻塞管线** —— 配乐是旁路氛围，换不换歌都不该影响这一轮叙事
   * 的产出；抛错也只吞掉。多个标记时**只取最后一个**（AI 一轮里改主意了，
   * 以它最后的判断为准；连着切两首歌只会听见后一首的开头）。
   */
  onPlayAudio?: (marker: PlayAudioMarker, storyOutput: string) => void | Promise<void>;

  /**
   * 🖼 Scene Image: Stage 1 正文中检测到 `<scene_image>` 后触发（图像生成 §8）。
   *
   * 🔴 **这是 D15 的物理落点**：本回调**只在编排器刚产出这条消息时触发一次**。
   * 历史消息重新渲染走的是 `scene-image-store` 的查询，根本不经过这里 —— 于是
   * 「自动档绝不追溯开火」是**默认成立**的，不靠任何额外判断。
   * **日后千万别为了「补全历史插画」加一条扫描全部消息的路径**：把开关从手动拨到
   * 自动的那一刻，几百回合的存档会一起开火，代价是真金白银。
   *
   * 🔴 D48: 本回调跑在 story agent **完成之后**（`processStageMarkers` 在 stage 结束时
   * 才调），所以看到的永远是完整正文 —— 流式途中那份半截文本没有 messageId、也不
   * 经过这里，自动档不可能在没写完的标记上开火。
   *
   * 三档分流（auto / manual / off）在调用方，不在这里：编排器只负责「扫到了」。
   * **不 await、不阻塞管线**，抛错也吞掉 —— 出图是旁路，画不出来不该影响这一轮叙事。
   */
  onSceneImage?: (markers: SceneImageMarker[], storyOutput: string) => void | Promise<void>;

  /**
   * 🎲 Event Trigger: Stage 1 正文中检测到 `<event_trigger name>` 后触发（随机事件 v1 §5.2）。
   *
   * 结算（清池 / 起冷却 / 记档案 / 记足迹 / emit）全在
   * `StateManager.confirmRandomEventTrigger`；本回调只是把名字送过去。
   *
   * 🔴 **不 await、不阻塞管线**，抛错也吞掉 —— 事件系统只记「触发过」这一事实（铁则 5），
   *    记不上不该让这一回合的正文失败。
   * 🔴 **一回合至多一条**：AI 写了多个标记时只取**第一个**（提示词教的是「至多触发一个」，
   *    多写就是它没守住；取第一个而不是最后一个 —— 正文里先写的那条才是它真正演绎的那条）。
   * 🔴 名字在不在池里、系统关没关，都由结算侧判（warn-noop）。这里判一遍就是第二处口径。
   */
  onEventTrigger?: (name: string) => void | Promise<void>;

  // ===== Phase 10: request_dispatcher 调度器回调 =====

  /** Stage 2: request_dispatcher 输出中的 <char_gen_request> → char_gen→item_gen 链 */
  onCharGenRequest?: (
    markers: CharGenRequestMarker[],
    varsOutput: string,
    context: AgentContext,
  ) => Promise<void>;

  /** Stage 2: request_dispatcher 输出中的 <item_gen_request> → item_gen 独立调用 */
  onItemGenRequest?: (
    markers: ItemGenRequestMarker[],
    varsOutput: string,
    context: AgentContext,
  ) => Promise<void>;

  /** Stage 2: request_dispatcher 输出中的 <item_update_request> → 已合并到 Stage 3 vars_update，此回调仅作兼容 */
  onItemUpdateRequest?: (
    markers: ItemUpdateRequestMarker[],
    varsOutput: string,
    context: AgentContext,
  ) => Promise<void>;

  /** Stage 2: request_dispatcher 输出中的 <craft_gen_request> → craft_gen→item_gen 链 */
  onCraftGenRequest?: (
    markers: CraftGenRequestMarker[],
    varsOutput: string,
    context: AgentContext,
  ) => Promise<void>;

  /** Phase 8.5: Agentic Agent 发出工具调用时触发 */
  onToolCall?: (agentId: string, toolName: string, args: any, result: any) => void;
}

// ========== AgentOrchestrator ==========

export class AgentOrchestrator {
  private pipeline: Pipeline;
  private context: AgentContext;
  private agentConfigs: Map<string, AgentConfig>;
  private endpoints: Map<string, ApiEndpoint>;
  private saveId: string;
  private events: OrchestratorEvents;
  private onlyAgents?: Set<string>;

  private results: Map<string, AgentResult> = new Map();
  private completedStages: string[] = [];
  private currentStage: string | null = null;
  private status: 'idle' | 'running' | 'completed' | 'failed' = 'idle';
  private runId: string;

  /** Phase 8: 预加载的世界书和预设 */
  private worldBooks: WorldBook[];
  private presets: AgentPreset[];

  /** @deprecated Phase 10: 旧格式 pendingCraftMarkers，新流程从 vars_update 输出直接扫描 */
  private pendingCraftMarkers: CraftRequestMarker[] = [];

  constructor(options: OrchestratorOptions, events: OrchestratorEvents = {}) {
    this.pipeline = options.pipeline;
    this.context = options.context;
    this.saveId = options.saveId;
    this.events = events;
    this.worldBooks = options.worldBooks ?? [];
    this.presets = options.presets ?? [];
    this.runId = crypto.randomUUID();

    // Build lookup maps
    this.agentConfigs = new Map();
    for (const c of options.agentConfigs) {
      this.agentConfigs.set(c.agentId, c);
    }

    // Phase 10: plotSettings.mode === 'off' → 禁用三个剧情 Agent
    const plotMode = options.context.plotSettings?.mode;
    if (plotMode === 'off') {
      for (const plotAgentId of ['plot_pre_check', 'plot_post_check', 'plot_outline']) {
        const cfg = this.agentConfigs.get(plotAgentId);
        if (cfg) {
          cfg.enabled = false;
        }
      }
    }

    this.endpoints = new Map();
    for (const ep of options.endpoints) {
      this.endpoints.set(ep.id, ep);
    }

    if (options.onlyAgents?.length) {
      this.onlyAgents = new Set(options.onlyAgents);
    }

    // Initialize context.agentOutputs if not set
    if (!this.context.agentOutputs) {
      this.context.agentOutputs = new Map();
    }
  }

  // ========== Run ==========

  /** 执行完整管线 */
  async run(): Promise<OrchestratorRun> {
    this.status = 'running';
    const startTime = Date.now();

    // 验证管线
    const errors = this.validatePipeline();
    if (errors.length > 0) {
      this.status = 'failed';
      return this.buildRun(startTime, errors);
    }

    // Phase 8: 组装 Zone — 一次组装，所有 Agent 调用共享
    if (!this.context.zones) {
      this.context.zones = buildZoneContext(this.context);
    }

    // 逐阶段执行
    for (let i = 0; i < this.pipeline.stages.length; i++) {
      const stage = this.pipeline.stages[i];
      this.currentStage = `stage_${i}`;

      // 检查依赖是否满足
      if (!this.stageDependenciesMet(stage)) {
        // 跳过此阶段（上游 Agent 全部失败）
        continue;
      }

      this.events.onStageStart?.(i, stage.agents);

      try {
        await this.executeStage(stage, i);
        this.completedStages.push(`stage_${i}`);

        // 工坊 P2 (D5): EJS vars 差量在本 stage 的标记处理（= AI 补丁提交）之前落库。
        // 永不让 stage 失败 —— 簿记旁路出问题不该吞掉本轮正文。
        try {
          await this.events.onEjsVarsFlush?.([...stage.agents]);
        } catch (err) {
          console.warn('[Orchestrator] EJS vars 差量提交失败（不阻塞管线）:', err);
        }

        this.events.onStageComplete?.(i);

        // Phase 6e: 处理标记 (craft_request / combat_trigger / char_detect)
        await this.processStageMarkers(i);
      } catch {
        // Stage failure — if retry is off, stop pipeline
        if (!this.pipeline.retryOnFail) {
          this.status = 'failed';
          return this.buildRun(startTime);
        }
        // With retry on, continue to next stage (failed agents already recorded)
      }
    }

    // 🎲 每回合胶水（随机事件 v1 §4.3）：本轮全部落库动作已经跑完，这时候的上下文
    // 才是下一回合注入块要依据的那份。自带 try/catch，永远不影响 run 的状态判定。
    await this.syncRandomEventsForTurn();

    this.status =
      this.completedStages.length > 0 && this.requiredAgentsSucceeded() ? 'completed' : 'failed';
    return this.buildRun(startTime);
  }

  /** 手动重生成指定 Agent（不影响下游 Agent，保持流程单向性） */
  async regenerateAgent(agentId: string): Promise<AgentResult> {
    const config = this.agentConfigs.get(agentId);
    if (!config) {
      return {
        agentId,
        output: null,
        rawResponse: '',
        tokensUsed: 0,
        cacheHit: false,
        duration: 0,
        error: `Agent "${agentId}" not configured`,
      };
    }

    this.events.onAgentStart?.(agentId, config);
    const result = await this.callAgent(config);
    this.results.set(agentId, result);

    if (result.error) {
      this.events.onAgentError?.(agentId, result.error);
    } else {
      await this.publishAgentCompletion(result);
    }

    return result;
  }

  // ========== Internal: Stage Execution ==========

  private async executeStage(stage: PipelineStage, _stageIndex: number): Promise<void> {
    const agentsToRun = this.onlyAgents
      ? stage.agents.filter((a) => this.onlyAgents!.has(a))
      : stage.agents;

    if (agentsToRun.length === 0) return;

    // 并行执行同阶段所有 Agent
    const promises = agentsToRun.map((agentId) => this.executeAgent(agentId));
    const results = await Promise.allSettled(promises);

    // 收集结果
    let hasSuccess = false;
    for (let i = 0; i < agentsToRun.length; i++) {
      const agentId = agentsToRun[i];
      const settled = results[i];

      if (settled.status === 'fulfilled') {
        const result = settled.value;
        this.results.set(agentId, result);
        if (!result.error) {
          hasSuccess = (await this.publishAgentCompletion(result)) || hasSuccess;
        } else {
          this.events.onAgentError?.(agentId, result.error);
        }
      } else {
        const result: AgentResult = {
          agentId,
          output: null,
          rawResponse: '',
          tokensUsed: 0,
          cacheHit: false,
          duration: 0,
          error: settled.reason?.message ?? String(settled.reason),
        };
        this.results.set(agentId, result);
        this.events.onAgentError?.(agentId, result.error!);
      }
    }

    // If all agents in stage failed, throw to signal stage failure
    if (!hasSuccess && agentsToRun.length > 0) {
      throw new Error(`Stage failed: all ${agentsToRun.length} agent(s) failed`);
    }
  }

  private async executeAgent(agentId: string): Promise<AgentResult> {
    const config = this.agentConfigs.get(agentId);
    if (!config) {
      return {
        agentId,
        output: null,
        rawResponse: '',
        tokensUsed: 0,
        cacheHit: false,
        duration: 0,
        error: `Agent "${agentId}" not found in agentConfigs`,
      };
    }

    if (!config.enabled) {
      // Disabled agents are skipped silently
      return {
        agentId,
        output: null,
        rawResponse: '',
        tokensUsed: 0,
        cacheHit: false,
        duration: 0,
      };
    }

    this.events.onAgentStart?.(agentId, config);
    return this.callAgent(config);
  }

  private async callAgent(config: AgentConfig): Promise<AgentResult> {
    const endpoint = this.endpoints.get(config.apiEndpointId);
    if (!endpoint) {
      return {
        agentId: config.agentId,
        output: null,
        rawResponse: '',
        tokensUsed: 0,
        cacheHit: false,
        duration: 0,
        error: `Endpoint "${config.apiEndpointId}" not found`,
      };
    }

    // 🆕 自动检测：memory_recall 模型名含 "embedding" 或 apiType 为 embedding → 走向量召回路径
    if (
      config.agentId === 'memory_recall' &&
      (/embedding/i.test(config.model) || (endpoint as any).apiType === 'embedding')
    ) {
      return this.callMemoryRecallEmbedding(endpoint, config);
    }

    // 🆕 Phase 8.5 Agentic 路径
    if (config.toolsEnabled) {
      return this.callAgenticAgent(config, endpoint);
    }

    // 构建 messages (Phase 8: 四部分拼接)
    const configsArr = Array.from(this.agentConfigs.values());
    const messages = await buildAgentMessagesAsync(
      config.agentId,
      this.context,
      configsArr,
      this.worldBooks,
      this.presets,
      undefined, // localParams: main pipeline agents don't need chain params
    );
    if (!messages) {
      return {
        agentId: config.agentId,
        output: null,
        rawResponse: '',
        tokensUsed: 0,
        cacheHit: false,
        duration: 0,
        error: `No template found for agent "${config.agentId}"`,
      };
    }

    const client = new AgentClient({
      endpoint,
      agentId: config.agentId,
      saveId: this.saveId,
      timeout: config.timeout || endpoint.timeout,
      maxRetries: config.retryOnFail ? 1 : 0,
    });

    const request: ChatRequest = {
      messages,
      model: config.model || endpoint.defaultModel,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      topP: config.topP,
      frequencyPenalty: config.frequencyPenalty,
      presencePenalty: config.presencePenalty,
    };

    let result: AgentResult;

    // 🆕 流式路径: 如果配置了 streamCallbacks，使用 chatStream() 逐块输出
    if (config.streamCallbacks) {
      result = await this.callAgentStreaming(client, request, config);
    } else {
      result = await client.chat(request, config.abortSignal);
    }

    // 🆕 注入请求消息供 debug 面板使用
    result.requestMessages = messages;

    // 🆕 Story 正文救援：修正"正文吞进思维链"(raw 空) 与"思维链泄漏进正文"(raw 含前导思维链) 两类 AI 缺陷
    if (config.agentId === 'story') {
      rescueStoryOutput(result);
    }

    return result;
  }

  /**
   * 🆕 流式 Agent 调用 — 使用 chatStream() 逐块回调，
   * 最终组装完整输出为 AgentResult 返回给管线。
   */
  private async callAgentStreaming(
    client: AgentClient,
    request: ChatRequest,
    config: AgentConfig,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const callbacks = config.streamCallbacks!;

    return new Promise((resolve) => {
      // 🔴 这个 promise 只由下面的 onComplete / onError 兑现。`chatStream` 自己把每一条
      // 抛出都收进 `settleError` → `callbacks.onError`，所以正常路径上它不会拒绝 ——
      // 但 `onError` 回调**自己**抛出时（或 finally 里出事），拒绝就会漏出来：
      // 那时既没人 resolve 外层 promise（整条管线永久挂起），又多一个未处理拒绝。
      // 这条 catch 是那种情况下唯一的出口。
      void client
        .chatStream(
          request,
          {
            onChunk: (text, isComplete) => {
              callbacks.onChunk(text, isComplete);
            },
            onToolCall: (toolCall) => {
              callbacks.onToolCall?.(toolCall);
            },
            onComplete: (streamResult) => {
              try {
                callbacks.onComplete(streamResult);
              } finally {
                resolve({
                  agentId: config.agentId,
                  output: streamResult.fullText,
                  rawResponse: streamResult.fullText,
                  reasoning: streamResult.reasoning,
                  tokensUsed: streamResult.tokensUsed,
                  cacheHit: streamResult.cacheHit,
                  cacheHitTokens: streamResult.cacheHitTokens,
                  cacheMissTokens: streamResult.cacheMissTokens,
                  completionTokens: streamResult.completionTokens,
                  duration: streamResult.duration,
                });
              }
            },
            onError: (error) => {
              try {
                callbacks.onError(error);
              } finally {
                resolve({
                  agentId: config.agentId,
                  output: null,
                  rawResponse: '',
                  tokensUsed: 0,
                  cacheHit: false,
                  duration: Date.now() - startTime,
                  error,
                });
              }
            },
          },
          config.abortSignal,
        )
        .catch((error: unknown) => {
          resolve({
            agentId: config.agentId,
            output: null,
            rawResponse: '',
            tokensUsed: 0,
            cacheHit: false,
            duration: Date.now() - startTime,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
  }

  /**
   * 🆕 Phase 8.5: Agentic Agent 执行路径。
   * 使用 chatWithTools() 支持多轮 function calling 循环。
   */
  private async callAgenticAgent(config: AgentConfig, endpoint: ApiEndpoint): Promise<AgentResult> {
    const startTime = Date.now();
    const tools = getToolsForAgent(config.agentId);
    if (tools.length === 0) {
      // 没有工具的 Agent 走普通路径
      return this.callAgent({ ...config, toolsEnabled: false });
    }

    // 构建 messages
    const configsArr = Array.from(this.agentConfigs.values());
    const messages = await buildAgentMessagesAsync(
      config.agentId,
      this.context,
      configsArr,
      this.worldBooks,
      this.presets,
      undefined, // localParams: main pipeline agents don't need chain params
    );
    if (!messages) {
      return {
        agentId: config.agentId,
        output: null,
        rawResponse: '',
        tokensUsed: 0,
        cacheHit: false,
        duration: 0,
        error: `No template found for agent "${config.agentId}"`,
      };
    }

    const client = new AgentClient({
      endpoint,
      agentId: config.agentId,
      saveId: this.saveId,
      timeout: config.timeout || endpoint.timeout,
      maxRetries: config.retryOnFail ? 1 : 0,
    });

    const toolContext: ToolExecutionContext = {
      characters: this.context.characters ?? [],
      variables: this.context.variables ?? {},
      saveId: this.saveId,
    };

    const request: ChatRequest = {
      messages,
      model: config.model || endpoint.defaultModel,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      topP: config.topP,
      frequencyPenalty: config.frequencyPenalty,
      presencePenalty: config.presencePenalty,
      tools,
      tool_choice: 'auto',
    };

    const result = await client.chatWithTools(
      request,
      async (name, args) => {
        try {
          const toolResult = await executeToolCall(name, args, toolContext);
          this.events.onToolCall?.(config.agentId, name, args, toolResult);
          return toolResult;
        } catch (error) {
          this.events.onToolCall?.(config.agentId, name, args, {
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      { maxRounds: config.maxToolCallRounds ?? 5, signal: config.abortSignal },
    );

    result.duration = Date.now() - startTime;
    return result;
  }

  // ========== Internal: Embedding 记忆召回路径 ==========

  /**
   * 使用 Embedding API 做向量相似度召回（不经 LLM）
   * 自动检测条件：config.model 包含 "embedding"（大小写不敏感）
   */
  private async callMemoryRecallEmbedding(
    endpoint: ApiEndpoint,
    config: AgentConfig,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const topK = 20; // 使用合理默认值，与 settings-store 的 memoryRecallCount 默认对齐
    const query = this.context.userInput || '';

    try {
      const recalled = await recallMemories(this.saveId, query, topK, {
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
        defaultModel: config.model || endpoint.defaultModel,
      });

      // 格式化为与 LLM 路径兼容的输出结构
      const memories = recalled.map((r) => ({
        id: r.memory.id,
        relevance: Math.round(r.score * 100) / 100,
        reason:
          r.score > 0 ? `Embedding 余弦相似度: ${r.score.toFixed(3)}` : '无向量，按重要度排序',
      }));

      const output = { memories };
      const duration = Date.now() - startTime;

      return {
        agentId: config.agentId,
        output,
        rawResponse: JSON.stringify(output),
        tokensUsed: 0, // Embedding API 按 token 计费但在 /chat/completions 口径下为 0
        cacheHit: false,
        duration,
      };
    } catch (err) {
      return {
        agentId: config.agentId,
        output: null,
        rawResponse: '',
        tokensUsed: 0,
        cacheHit: false,
        duration: Date.now() - startTime,
        error: `Embedding 召回失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ========== Internal: Validation ==========

  /** 验证管线 DAG 合法性 */
  private validatePipeline(): string[] {
    const errors: string[] = [];
    const knownAgents = new Set(this.agentConfigs.keys());

    // 注册内置 Agent（即使未配置，含 Phase 6e 新增 + Phase 10 重命名）
    for (const id of [
      'memory_recall',
      'plot_pre_check',
      'story',
      'request_dispatcher',
      'vars_update',
      'memory_summary',
      'plot_post_check',
      'plot_outline',
      'plot_check',
      'plot_correct',
      'craft_gen',
      'char_gen',
      'item_gen',
      'combat_summary',
    ]) {
      knownAgents.add(id);
    }

    const producedSoFar = new Set<string>();

    for (let i = 0; i < this.pipeline.stages.length; i++) {
      const stage = this.pipeline.stages[i];

      // 检查 Agent 是否已知
      for (const agentId of stage.agents) {
        if (!knownAgents.has(agentId)) {
          errors.push(`Stage ${i}: unknown agent "${agentId}"`);
        }
      }

      // 检查依赖是否可满足
      for (const dep of stage.waitFor) {
        if (!knownAgents.has(dep)) {
          errors.push(`Stage ${i}: depends on unknown agent "${dep}"`);
        } else if (!producedSoFar.has(dep)) {
          errors.push(`Stage ${i}: depends on "${dep}" which is not produced before stage ${i}`);
        }
      }

      // 将本阶段 Agent 加入已产出集合
      for (const agentId of stage.agents) {
        producedSoFar.add(agentId);
      }
    }

    return errors;
  }

  /** 检查阶段的依赖是否满足（上游 Agent 有成功输出） */
  private stageDependenciesMet(stage: PipelineStage): boolean {
    if (!stage.waitFor || stage.waitFor.length === 0) return true;

    for (const dep of stage.waitFor) {
      const result = this.results.get(dep);
      // Dependency met if result exists and has no error (or was skipped via disabled)
      if (!result || result.error) {
        return false;
      }
    }
    return true;
  }

  /** 必需 Agent 必须存在、无错误，且产出非 null/undefined/空白字符串。 */
  private requiredAgentsSucceeded(): boolean {
    for (const agentId of this.pipeline.requiredAgents ?? []) {
      const result = this.results.get(agentId);
      if (!result || result.error || result.output == null) return false;
      if (typeof result.output === 'string' && result.output.trim() === '') return false;
    }
    return true;
  }

  /** 完成处理属于阶段提交的一部分；失败时不得让下游消费未提交的结果。 */
  private async publishAgentCompletion(result: AgentResult): Promise<boolean> {
    this.context.agentOutputs!.set(result.agentId, result.output);
    try {
      await this.events.onAgentComplete?.(result);
      return true;
    } catch (error) {
      const message = `Agent completion handler failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      result.error = message;
      this.context.agentOutputs!.delete(result.agentId);
      this.events.onAgentError?.(result.agentId, message);
      return false;
    }
  }

  // ========== Internal: Marker Processing (Phase 6e) ==========

  /**
   * 在 Stage 完成后处理 XML 标记。
   * - Stage 1 (story) 后: 暂存 craft_request 和 combat_trigger
   * - Stage 2 (vars_update) 后: 先 char_detect → 再 craft → 最后 combat
   *
   * Phase 8.5: craft_request 由阻塞型改为延迟型（对齐 combat_trigger）。
   * 延迟理由: 制作可能依赖 char_gen 生成的 NPC（如铁匠），且统一在 Stage 2 执行可并行 batched。
   */
  private async processStageMarkers(stageIndex: number): Promise<void> {
    // Phase 10: Chain agents that need localParams (craft_gen, char_gen, item_gen)
    // receive them via the chain orchestrators (craft-gen-chain.ts, char-gen-agent.ts).
    // The orchestrator callbacks pass localParams directly to buildAgentMessages().
    // Stage 1 (story): 暂存旧格式 markers + 向后兼容
    if (this.isStoryStage(stageIndex)) {
      const storyOutput = this.getAgentOutputText('story');
      if (!storyOutput) return;

      const scanResult = scanMarkers(storyOutput);

      // 旧格式 craft_request（仍从 story 扫描，向后兼容）
      const craftMarkers = scanResult.markers.filter(
        (m): m is CraftRequestMarker => m.type === 'craft_request',
      );
      if (craftMarkers.length > 0) {
        this.pendingCraftMarkers.push(...craftMarkers);
      }

      // M5.1: combat_trigger 改由 request_dispatcher 输出（Stage 2 扫描），story 不再输出战斗标记

      // 🎵 play_audio: 就地触发，不暂存也不 await —— 配乐是旁路，不进管线时序
      const audioMarkers = scanResult.markers.filter(
        (m): m is PlayAudioMarker => m.type === 'play_audio',
      );
      const lastAudio = audioMarkers[audioMarkers.length - 1];
      if (lastAudio && this.events.onPlayAudio) {
        try {
          void Promise.resolve(this.events.onPlayAudio(lastAudio, storyOutput)).catch(() => {});
        } catch {
          // 换歌失败不该让这一轮叙事失败
        }
      }

      // 🖼 scene_image: 就地触发，不 await —— 出图是旁路，5–60 秒的等待不进管线时序。
      // 🔴 **只在这里触发一次**，历史消息永不重扫（D15，见 onSceneImage 的文档）。
      const sceneMarkers = scanResult.markers.filter(
        (m): m is SceneImageMarker => m.type === 'scene_image',
      );
      if (sceneMarkers.length > 0 && this.events.onSceneImage) {
        try {
          void Promise.resolve(this.events.onSceneImage(sceneMarkers, storyOutput)).catch(() => {});
        } catch {
          // 画不出插画不该让这一轮叙事失败
        }
      }

      // 🎲 event_trigger: 就地触发，不 await —— 随机事件结算是旁路簿记（铁则 5），
      // 不进管线时序。**只取第一条**（提示词教的是「至多触发一个」），且名字为空的不算数
      // —— 拿空串去结算只会在日志里留一条「不在候选池」的假警报。
      const eventMarkers = scanResult.markers.filter(
        (m): m is EventTriggerMarker => m.type === 'event_trigger',
      );
      const firstEvent = eventMarkers.find((m) => (m.name ?? '').length > 0);
      if (firstEvent && this.events.onEventTrigger) {
        try {
          void Promise.resolve(this.events.onEventTrigger(firstEvent.name as string)).catch(
            () => {},
          );
        } catch {
          // 事件记不上账不该让这一轮叙事失败
        }
      }
    }

    // Stage 2 (request_dispatcher): 扫描调度器输出 + 处理所有 request
    if (this.isDispatcherStage(stageIndex)) {
      const varsOutput = this.getAgentOutputText('request_dispatcher');
      if (!varsOutput) return;

      // Step A: 从 varsOutput 提取 <json> 块内容（正则直接提取，不依赖 scanMarkers）
      const jsonMatch = varsOutput.match(/<json>([\s\S]*?)<\/json>/);
      const jsonText = jsonMatch ? jsonMatch[1].trim() : '';

      // Step B: scanMarkers 提取所有 request 标签
      const scanResult = scanMarkers(varsOutput);
      const markers = scanResult.markers;

      // Step C: 解析 <json> 块中的全局变量 → StatePatch（先执行）
      const dispatcherJson = jsonText ? this.parseStageJson(jsonText, 'request_dispatcher') : null;
      if (dispatcherJson) {
        const parsed = dispatcherJson;
        let deltaTime: number | undefined;
        // Q-19: 纯翻译搬进 vars-update-translator；这里只剩「抠块 → 翻译 → 落库」。
        // delta_time 不产 patch（它走 applyTimeAdvance），由翻译层一并带出来。
        const translated = this.buildPatches('request_dispatcher', () => {
          const out = buildDispatcherPatches(parsed);
          deltaTime = out.deltaTime;
          return out.patches;
        });

        await this.commitPatches(translated, 'request_dispatcher');

        if (deltaTime !== undefined) {
          await this.advanceTime(deltaTime, 'request_dispatcher');
        }

        // 🗺 提交后胶水（地图 v1 §8.2 / 裁定 §12-8）：dispatcher 刚把 `sys.旅行目的地` 落库、
        // 时间也刚推进过，在途旗要基于**这两者之后**的状态算 —— 顺序不能提前。
        // 它自己就是 no-op 安全的（没装地图包 / 目的地为空 / 落位失败一律不写），所以不加条件。
        await this.syncMapJourney('request_dispatcher');
      }

      // Step C: 新格式 request 标签 → 并行回调
      const charGenMarkers = markers.filter(
        (m): m is CharGenRequestMarker => m.type === 'char_gen_request',
      );
      const itemGenMarkers = markers.filter(
        (m): m is ItemGenRequestMarker => m.type === 'item_gen_request',
      );
      const itemUpdateMarkers = markers.filter(
        (m): m is ItemUpdateRequestMarker => m.type === 'item_update_request',
      );
      const craftGenMarkers = markers.filter(
        (m): m is CraftGenRequestMarker => m.type === 'craft_gen_request',
      );

      const promises: Promise<void>[] = [];

      if (charGenMarkers.length > 0 && this.events.onCharGenRequest) {
        promises.push(this.events.onCharGenRequest(charGenMarkers, varsOutput, this.context));
      }
      if (itemGenMarkers.length > 0 && this.events.onItemGenRequest) {
        promises.push(this.events.onItemGenRequest(itemGenMarkers, varsOutput, this.context));
      }
      if (itemUpdateMarkers.length > 0 && this.events.onItemUpdateRequest) {
        promises.push(this.events.onItemUpdateRequest(itemUpdateMarkers, varsOutput, this.context));
      }
      if (craftGenMarkers.length > 0 && this.events.onCraftGenRequest) {
        promises.push(this.events.onCraftGenRequest(craftGenMarkers, varsOutput, this.context));
      }

      if (promises.length > 0) {
        await Promise.all(promises);
      }

      // Step D: 旧格式 craft/combat（向后兼容）
      const dispatcherStoryOutput = this.getAgentOutputText('story') ?? '';
      if (this.pendingCraftMarkers.length > 0 && this.events.onCraftRequest) {
        let modifiedOutput = dispatcherStoryOutput;
        for (const marker of this.pendingCraftMarkers) {
          const craftResult = await this.events.onCraftRequest(marker, modifiedOutput);
          if (craftResult) {
            modifiedOutput =
              modifiedOutput.slice(0, marker.position) +
              craftResult +
              modifiedOutput.slice(marker.position + marker.rawContent.length);
            const lengthDiff = craftResult.length - marker.rawContent.length;
            if (lengthDiff !== 0) {
              for (const m of this.pendingCraftMarkers) {
                if (m.position > marker.position) {
                  m.position += lengthDiff;
                }
              }
            }
          }
        }
        this.context.agentOutputs!.set('story', modifiedOutput);
        this.pendingCraftMarkers = [];
      }

      // M5.1: combat_trigger 现从 dispatcher 输出扫描（与其他 request 标签同源）
      const combatMarkers = markers.filter(
        (m): m is CombatTriggerMarker => m.type === 'combat_trigger',
      );
      if (combatMarkers.length > 0 && this.events.onCombatTrigger) {
        // char/item/craft 的 promises 已在上方 Promise.all 完成，保证参战方新角色先生成再开战
        for (const marker of combatMarkers) {
          await this.events.onCombatTrigger(marker, dispatcherStoryOutput);
        }
      }
    }

    // Stage 3 (vars_update): 解析执行器输出 → StatePatch
    if (this.isVarsUpdateStage(stageIndex)) {
      const varsOutput = this.getAgentOutputText('vars_update');
      if (!varsOutput) return;

      // Step A: 提取 <json> 块 → 解析 char ops + item ops → StatePatch
      // Q-14: 只 parse 一次，下面的 quests 分支复用同一个 parsed —— 旧实现把同一段
      // 文本 parse 两遍，两次的失败还分别落进两个不同的 catch，报出两条不同的话。
      const jsonMatch = varsOutput.match(/<json>([\s\S]*?)<\/json>/);
      const varsJson = jsonMatch ? this.parseStageJson(jsonMatch[1], 'vars_update') : null;
      if (varsJson) {
        const parsed = varsJson;
        const patches = this.buildPatches('vars_update', () => buildVarsUpdatePatches(parsed));

        await this.commitPatches(patches, 'vars_update');
      }

      // Step B: 提取 <status_effects> 块 → 解析效果定义 → apply
      const seMatch = varsOutput.match(/<status_effects>([\s\S]*?)<\/status_effects>/);
      if (seMatch) {
        const { parseStatusEffectsXML } = await import('./char-gen-agent');
        const patches = this.buildPatches('vars_update:status_effects', () =>
          parseStatusEffectsXML(seMatch[1].trim()).map((e) => ({
            op: 'add_status_effect' as const,
            target: `characters.${e.owner}`,
            value: e,
            metadata: { source: 'vars_update' },
          })),
        );
        await this.commitPatches(patches, 'vars_update:status_effects');
      }

      // Step C: 提取 <json> 中 quests 块 → StatePatch (Phase 10g)
      if (varsJson?.quests) {
        const quests = varsJson.quests;
        const patches = this.buildPatches('vars_update:quests', () => buildQuestPatches(quests));

        await this.commitPatches(patches, 'vars_update:quests');
      }
    }
  }

  // ========== 失败回执（Q-14） ==========
  //
  // 从 AI 文本走到状态落库要过三道，**每道各有各的回执，不许混成一条**：
  //   ① JSON 解析失败       → parseStageJson   ：AI 没输出合法 JSON
  //   ② patch 装配失败      → buildPatches     ：JSON 合法但结构不是约定的形状
  //   ③ 落库抛异常          → commitPatches    ：Dexie 写失败 / 校验器 throw
  //
  // 旧实现三处 try 都从 `JSON.parse` 一路包到 `await sm.commitChatState()`，catch 还是
  // 无参的，于是 ③ 会印成「<json> 解析失败」并把异常整个丢掉，专为把落库失败上浮给 UI
  // 才存在的 `onStateCommitError` 也不触发。真机 debug loop 看见这条会去改 prompt，
  // 而实际该查的是 StateManager —— 掉状态且界面无提示，是最贵的一类误导。

  /** ① 解析 stage 输出里的 `<json>` 块；失败返回 null 并带上异常对象 */
  private parseStageJson(jsonText: string, source: string): Record<string, any> | null {
    try {
      return JSON.parse(jsonText.trim());
    } catch (err) {
      console.warn(`[Orchestrator] ${source} <json> 解析失败，跳过该批状态更新:`, err);
      return null;
    }
  }

  /**
   * ② 跑 patch 装配，把「JSON 合法但结构不对」圈在这里（如 `replace` 给成字符串，
   * for..of 直接抛）。返回空数组即「这批没得可提交」，不影响同 stage 的其它批次。
   */
  private buildPatches(
    source: string,
    build: () => import('./types').StatePatch[],
  ): import('./types').StatePatch[] {
    try {
      return build();
    } catch (err) {
      console.warn(`[Orchestrator] ${source} <json> 结构不符，跳过该批状态更新:`, err);
      return [];
    }
  }

  /**
   * ③ 提交 patch。`commitChatState` 的契约是返回带 `errors[]` 的结果而非抛错，
   * 所以这里 catch 到的是更窄的一类（Dexie 写失败、校验器 throw）——正是旧实现吞掉的那类。
   *
   * 这不新增写入路径（仍是 ADR-21 的 `commitChatState` 唯一入口），只新增一条失败上报路径。
   */
  private async commitPatches(
    patches: import('./types').StatePatch[],
    source: string,
  ): Promise<void> {
    if (patches.length === 0) return;
    try {
      const { createStateManager } = await import('./state-manager');
      const sm = createStateManager(this.saveId);
      const r = await sm.commitChatState(patches);
      this.reportCommitResult(r, patches.length, source);
    } catch (err) {
      console.error(`[Orchestrator] ${source} 状态提交抛异常:`, err);
      this.events.onStateCommitError?.(source, [String(err)]);
    }
  }

  /**
   * 🗺 在途旗同步（地图 v1 §5 接线表的「提交后胶水」）。
   *
   * 判定与写入全在 `StateManager.syncMapJourney` 里（ADR-21：状态变更只从那里出去）；
   * 本方法只是**触发点** —— 这一条缝之所以在 dispatcher 分支而不在 vars_update 分支，
   * 是因为 `sys.旅行目的地` 是 dispatcher 写的。代价（已知、可接受）：同一回合里玩家的
   * `set_location` 由**后一个** stage（vars_update）落库，所以本次计划路线的起点是
   * 移动**前**的地块。这不影响正确性 —— 在途旗每回合重算，`plannedPath` 本就是 advisory，
   * 下一回合起点自然对上（裁定 §12-7 附加：叙事偏离时按新位置重估）。
   */
  private async syncMapJourney(source: string): Promise<void> {
    try {
      const { createStateManager } = await import('./state-manager');
      await createStateManager(this.saveId).syncMapJourney();
    } catch (err) {
      // 地图是派生投影：旗没设上不影响任何已落库的状态，也不该污染 onStateCommitError
      console.warn(`[Orchestrator] ${source} 在途旗同步失败:`, err);
    }
  }

  /**
   * 🎲 随机事件候选池的每回合保洁（随机事件 v1 §4.3）。
   *
   * 形状逐字照 `syncMapJourney`：判定与写入全在 `StateManager.syncRandomEventsForTurn` 里
   * （ADR-21），本方法只是**触发点**；自带 try/catch + warn，**绝不碰 `onStateCommitError`**
   * —— 池子是旁路簿记，保洁失败不影响任何已落库的状态，报成「状态未能写入」只会让玩家
   * 去查一件没发生的事。
   *
   * 为什么挂在整轮末尾而不是某个 stage 之后：要保洁的是**上下文变了**导致的失效
   * （AI 在本轮改了变量 / 任务状态 / 好感度，于是某条候选的 `available` 不再满足），
   * 而那些改动散在 dispatcher 与 vars_update 两个 stage 里。跑在最后一次落库之后，
   * 下一回合的注入块才不会展示一条已经失效的候选。它是幂等的（同一轮跑两次无副作用），
   * 系统关闭 / 没装事件包时整段 no-op。
   */
  private async syncRandomEventsForTurn(): Promise<void> {
    try {
      const { createStateManager } = await import('./state-manager');
      await createStateManager(this.saveId).syncRandomEventsForTurn();
    } catch (err) {
      console.warn('[Orchestrator] 随机事件候选池保洁失败（不影响本轮任何已落库状态）:', err);
    }
  }

  /** 时间推进 —— 独立成一条回执：旧实现与解析共用 catch，推进抛错会被印成「解析失败」 */
  private async advanceTime(deltaMinutes: number, source: string): Promise<void> {
    try {
      const { createStateManager } = await import('./state-manager');
      await createStateManager(this.saveId).applyTimeAdvance(deltaMinutes);
    } catch (err) {
      console.error(`[Orchestrator] ${source} 时间推进失败:`, err);
      this.events.onStateCommitError?.(`${source}:delta_time`, [String(err)]);
    }
  }

  /** 检查 commitChatState 结果，失败项 console.error + 上浮回调 */
  private reportCommitResult(
    result: import('./types').StateCommitResult,
    patchCount: number,
    source: string,
  ): void {
    if (result.errors.length > 0) {
      console.error(
        `[Orchestrator] ${source} 状态提交失败 ${result.errors.length}/${patchCount} 条:`,
        result.errors,
      );
      this.events.onStateCommitError?.(source, result.errors);
    } else if (result.patchesApplied < patchCount) {
      // applyPatch 验证失败走 return 不 throw、不进 errors[]，用数量差兜底
      console.warn(
        `[Orchestrator] ${source} 部分 patch 验证失败未生效: ${result.patchesApplied}/${patchCount}`,
      );
    }
  }

  /** 判断当前 stage 是否包含 story agent */
  private isStoryStage(stageIndex: number): boolean {
    const stage = this.pipeline.stages[stageIndex];
    return stage?.agents.includes('story') ?? false;
  }

  /** 判断当前 stage 是否包含 request_dispatcher agent */
  private isDispatcherStage(stageIndex: number): boolean {
    const stage = this.pipeline.stages[stageIndex];
    return stage?.agents.includes('request_dispatcher') ?? false;
  }

  /** 判断当前 stage 是否包含 vars_update agent（执行器） */
  private isVarsUpdateStage(stageIndex: number): boolean {
    const stage = this.pipeline.stages[stageIndex];
    return stage?.agents.includes('vars_update') ?? false;
  }

  /** 从 context.agentOutputs 获取指定 Agent 的文本输出 */
  private getAgentOutputText(agentId: string): string | null {
    const output = this.context.agentOutputs?.get(agentId);
    return typeof output === 'string' ? output : null;
  }

  // ========== Internal: Build Run ==========

  // 🔴 **收进来了却没进返回值** —— `_errors` 是 `run()` 那边 `validatePipeline()` 的真实结果
  //    （见上方 `return this.buildRun(startTime, errors)`），但 `OrchestratorRun` 类型里
  //    根本没有 `errors` 这一项，于是管线校验失败只剩一个 `status: 'failed'`，**失败原因整条丢掉**。
  //    与 `craft-dc.ts` 的 `_materialSave` 是同一种形状：值算出来了、调用方也传进来了，落地时蒸发。
  //    2026-08-05 收紧 lint 时由 `no-unused-vars` 逮到（此前它是 warning，CI 放行）。
  //    没有就地补进返回值，是因为那要改 `OrchestratorRun` 类型与所有下游消费方，
  //    属于功能改动而不是 lint 清理 —— 留给单独一次提交，别顺手塞进来。
  private buildRun(startTime: number, _errors: string[] = []): OrchestratorRun {
    return {
      id: this.runId,
      pipeline: this.pipeline,
      context: this.context,
      startedAt: startTime,
      completedStages: this.completedStages,
      currentStage: this.currentStage,
      agentResults: new Map(this.results),
      status: this.status,
    };
  }

  // ========== Getters ==========

  /** 获取当前所有 Agent 结果 */
  getResults(): ReadonlyMap<string, AgentResult> {
    return this.results;
  }

  /** 获取当前运行状态 */
  getStatus(): 'idle' | 'running' | 'completed' | 'failed' {
    return this.status;
  }
}

// ========== 世界新闻翻译 (M5 #16) ==========

// ========== 管线预设 ==========

/** 默认的 7 Agent 管线（从 types 中重新导出） */
export { DEFAULT_AGENT_PIPELINE } from './types';
