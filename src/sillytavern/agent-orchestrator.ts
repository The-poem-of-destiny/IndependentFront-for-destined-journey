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
  AgentDefinition,
  CraftRequestMarker,
  CombatTriggerMarker,
  CombatSummaryResult,
  PlayAudioMarker,
  CharGenRequestMarker,
  ItemGenRequestMarker,
  ItemUpdateRequestMarker,
  CraftGenRequestMarker,
  ToolExecutionContext,
} from './types';
import { AgentClient } from './agent-client';
import type { ChatRequest, StreamCallbacks } from './agent-client';
import { buildAgentMessagesAsync, getAgentTemplate } from './agent-templates';
import { scanMarkers } from './marker-protocol';
import { recallMemories } from './memory-store';
import { buildZoneContext } from './context-visibility';
import { getToolsForAgent, executeToolCall } from './agent-tools';
import { normalizeSlot } from './field-enums';
import { rescueStoryOutput } from './story-rescue';

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
      client.chatStream(
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
      );
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
        const toolResult = await executeToolCall(name, args, toolContext);
        if (this.events.onToolCall) {
          this.events.onToolCall(config.agentId, name, args, toolResult);
        }
        return toolResult;
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
      if (jsonText) {
        try {
          const parsed = JSON.parse(jsonText.trim());
          const { createStateManager } = await import('./state-manager');
          const sm = createStateManager(this.saveId);
          const patches: import('./types').StatePatch[] = [];

          for (const r of parsed.replace ?? []) {
            // M5: 世界新闻 → add_news（#16 双轨退役）— 不再写 variables.世界新闻，改落 profile.news
            if (isWorldNewsPath(r.path)) {
              patches.push(...buildNewsPatches(r.value, 'replace'));
              continue;
            }
            patches.push({
              op: 'set_variable',
              target: `variables.${r.path}`,
              value: r.value,
              metadata: { source: 'request_dispatcher', operation: 'replace' },
            });
          }
          for (const ins of parsed.insert ?? []) {
            // M5: 世界新闻 → add_news（#16 双轨退役）— insert 路径同样拦截
            if (isWorldNewsPath(ins.path)) {
              patches.push(...buildNewsPatches(ins.value, 'insert'));
              continue;
            }
            patches.push({
              op: 'insert_variable',
              target: `variables.${ins.path}`,
              value: ins.value,
              metadata: { source: 'request_dispatcher', operation: 'insert', index: ins.index },
            });
          }

          if (patches.length > 0) {
            const r = await sm.commitChatState(patches);
            this.reportCommitResult(r, patches.length, 'request_dispatcher');
          }

          if (parsed.delta_time && typeof parsed.delta_time === 'number' && parsed.delta_time > 0) {
            await sm.applyTimeAdvance(parsed.delta_time);
          }
        } catch {
          console.warn('[Orchestrator] request_dispatcher <json> 解析失败，跳过全局变量更新');
        }
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
      const jsonMatch = varsOutput.match(/<json>([\s\S]*?)<\/json>/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1].trim());
          const { createStateManager } = await import('./state-manager');
          const sm = createStateManager(this.saveId);
          const patches: import('./types').StatePatch[] = [];

          // --- characters.replace → set_hp/set_mp/set_sp/set_location/update_character ---
          // M4: 名字寻址唯一化（铁律1）— key 只认 name，缺 name 跳过
          for (const r of parsed.characters?.replace ?? []) {
            const key = r.name;
            if (!key) {
              console.warn('[Orchestrator] characters.replace 条目缺 name，跳过');
              continue;
            }
            const { path, value } = r;
            switch (path) {
              case 'hp':
                patches.push({
                  op: 'set_hp',
                  target: `characters.${key}`,
                  value,
                  metadata: { source: 'vars_update' },
                });
                break;
              case 'mp':
                patches.push({
                  op: 'set_mp',
                  target: `characters.${key}`,
                  value,
                  metadata: { source: 'vars_update' },
                });
                break;
              case 'sp':
                patches.push({
                  op: 'set_sp',
                  target: `characters.${key}`,
                  value,
                  metadata: { source: 'vars_update' },
                });
                break;
              case 'location':
                patches.push({
                  op: 'set_location',
                  target: `characters.${key}`,
                  value: value,
                  metadata: { source: 'vars_update' },
                });
                break;
              case 'currentAction':
                // M3: currentAction 走 update_character，不再顶掉 location（#19 翻译侧收口）
                patches.push({
                  op: 'update_character',
                  target: `characters.${key}`,
                  value: { currentAction: value },
                  metadata: { source: 'vars_update', path },
                });
                break;
              default:
                patches.push({
                  op: 'update_character',
                  target: `characters.${key}`,
                  value: { [path]: value },
                  metadata: { source: 'vars_update', path },
                });
            }
          }

          // --- characters.delta → delta_hp/delta_mp/delta_sp/update_character(delta) ---
          // M4: 名字寻址唯一化（铁律1）— key 只认 name，缺 name 跳过
          for (const d of parsed.characters?.delta ?? []) {
            const key = d.name;
            if (!key) {
              console.warn('[Orchestrator] characters.delta 条目缺 name，跳过');
              continue;
            }
            const { path, amount } = d;
            switch (path) {
              case 'hp':
                patches.push({
                  op: 'delta_hp',
                  target: `characters.${key}`,
                  amount,
                  metadata: { source: 'vars_update' },
                });
                break;
              case 'mp':
                patches.push({
                  op: 'delta_mp',
                  target: `characters.${key}`,
                  amount,
                  metadata: { source: 'vars_update' },
                });
                break;
              case 'sp':
                patches.push({
                  op: 'delta_sp',
                  target: `characters.${key}`,
                  amount,
                  metadata: { source: 'vars_update' },
                });
                break;
              case 'money':
                // M3: money delta 走 update_character + metadata.delta=true（M2 Task 9 真加法承接 #20）
                patches.push({
                  op: 'update_character',
                  target: `characters.${key}`,
                  value: { money: amount },
                  metadata: { source: 'vars_update', path, delta: true },
                });
                break;
              default:
                patches.push({
                  op: 'update_character',
                  target: `characters.${key}`,
                  value: { [path]: amount },
                  metadata: { source: 'vars_update', path, delta: true },
                });
            }
          }

          // --- characters.add → add_status_effect/add_skill/add_item（M3: 零 id 生成，装备单 patch） ---
          // M4: 名字寻址唯一化（铁律1）— key 只认 name，缺 name 跳过
          for (const a of parsed.characters?.add ?? []) {
            const key = a.name;
            if (!key) {
              console.warn('[Orchestrator] characters.add 条目缺 name，跳过');
              continue;
            }
            const { path, value } = a;
            switch (path) {
              case 'statusEffects':
                patches.push({
                  op: 'add_status_effect',
                  target: `characters.${key}`,
                  value,
                  metadata: { source: 'vars_update' },
                });
                break;
              case 'skills':
                patches.push({
                  op: 'add_skill',
                  target: `characters.${key}`,
                  value,
                  metadata: { source: 'vars_update' },
                });
                break;
              case 'inventory': {
                // M3: 单 add_item，无 id 生成，equippedSlot 直传
                patches.push({
                  op: 'add_item',
                  target: `characters.${key}`,
                  value: {
                    name: value?.name ?? '未知物品',
                    description: value?.description,
                    quantity: value?.quantity ?? 1,
                    type: value?.type,
                    rarity: value?.rarity,
                    equippedSlot: value?.equippedSlot ?? null,
                  },
                  metadata: { source: 'vars_update', path, add: true },
                });
                break;
              }
              case 'equipment': {
                // M3: 装备=带 equippedSlot 的物品，单 add_item 落库（不再 add_item+equip_item 两步）
                // M4: itemId 过渡读拆除（原 itemId 语义已废，只认 name）
                const eqName = value?.name ?? '未知装备';
                const eqSlot = normalizeSlot(value?.slot ?? '');
                patches.push({
                  op: 'add_item',
                  target: `characters.${key}`,
                  value: {
                    name: eqName,
                    description: value?.description,
                    quantity: 1,
                    type: '装备',
                    rarity: value?.rarity,
                    equippedSlot: eqSlot, // null = 槽位不可识别，留背包
                  },
                  metadata: { source: 'vars_update', path, add: true },
                });
                break;
              }
              default:
                patches.push({
                  op: 'update_character',
                  target: `characters.${key}`,
                  value: { [path]: value },
                  metadata: { source: 'vars_update', path, add: true },
                });
            }
          }

          // --- characters.remove → remove_status_effect/unequip_item/remove_skill（M3: 统一 {name} 对象形态） ---
          // M4: 名字寻址唯一化（铁律1）— key 只认 name，缺 name 跳过
          for (const rm of parsed.characters?.remove ?? []) {
            const key = rm.name;
            if (!key) {
              console.warn('[Orchestrator] characters.remove 条目缺 name，跳过');
              continue;
            }
            const { path, target: rmTarget } = rm;
            switch (path) {
              case 'statusEffects':
                patches.push({
                  op: 'remove_status_effect',
                  target: `characters.${key}`,
                  value: { name: rmTarget },
                  metadata: { source: 'vars_update' },
                });
                break;
              case 'equipment':
                patches.push({
                  op: 'unequip_item',
                  target: `characters.${key}`,
                  value: { name: rmTarget },
                  metadata: { source: 'vars_update' },
                });
                break;
              case 'skills':
                patches.push({
                  op: 'remove_skill',
                  target: `characters.${key}`,
                  value: { name: rmTarget },
                  metadata: { source: 'vars_update', path, remove: true },
                });
                break;
            }
          }

          // --- items.consume → remove_item ---
          for (const c of parsed.items?.consume ?? []) {
            patches.push({
              op: 'remove_item',
              target: `characters.${c.owner}`,
              value: { name: c.target, quantity: c.quantity ?? 1 },
              metadata: { source: 'vars_update', operation: 'consume' },
            });
          }

          // --- items.equip → equip_item ---
          for (const e of parsed.items?.equip ?? []) {
            // M2: e.target 本来就是物品名 → {name, slot}（杀 #23）// M3 重写
            patches.push({
              op: 'equip_item',
              target: `characters.${e.owner}`,
              value: { name: e.target, slot: e.slot },
              metadata: { source: 'vars_update', operation: 'equip' },
            });
          }

          // --- items.unequip → unequip_item ---
          for (const u of parsed.items?.unequip ?? []) {
            // M2: u.target 是物品名 → {name} 对象形态（applyUnequipItem 按名脱）// M3 重写
            patches.push({
              op: 'unequip_item',
              target: `characters.${u.owner}`,
              value: { name: u.target },
              metadata: { source: 'vars_update', operation: 'unequip' },
            });
          }

          // --- items.transfer → transfer_item（M3: 单 patch 原子转移，杀 #5 transfer 断裂） ---
          for (const t of parsed.items?.transfer ?? []) {
            patches.push({
              op: 'transfer_item',
              target: `characters.${t.from}`,
              value: { name: t.target, to: t.to, quantity: t.quantity ?? 1 },
              metadata: { source: 'vars_update', operation: 'transfer' },
            });
          }

          // --- items.modify → update_item ---
          for (const m of parsed.items?.modify ?? []) {
            // M2: itemUpdate 假字段被 update_character 白名单拒 → 改专用 op update_item {name, changes} // M3 重写
            // changes 里的 name/quantity/id 是 update_item 禁改键 → 剥离（防 AI 夹带触发 throw）
            const {
              name: _n,
              quantity: _q,
              id: _i,
              ...changes
            } = (m.changes ?? {}) as Record<string, any>;
            patches.push({
              op: 'update_item',
              target: `characters.${m.owner}`,
              value: { name: m.target, changes },
              metadata: { source: 'vars_update', operation: 'modify' },
            });
          }

          // --- affections.set/delta → set_affection/delta_affection（M5: #15 #44 好感度接线，写 profile.affections） ---
          // M4 prompt 教的键格式: {"affections":{"set":[{name,value}],"delta":[{name,amount}]}}
          for (const s of parsed.affections?.set ?? []) {
            if (!s.name) {
              console.warn('[Orchestrator] affections.set 条目缺 name，跳过');
              continue;
            }
            patches.push({
              op: 'set_affection',
              target: `affections.${s.name}`,
              value: s.value,
              metadata: { source: 'vars_update' },
            });
          }
          for (const d of parsed.affections?.delta ?? []) {
            if (!d.name) {
              console.warn('[Orchestrator] affections.delta 条目缺 name，跳过');
              continue;
            }
            patches.push({
              op: 'delta_affection',
              target: `affections.${d.name}`,
              amount: d.amount,
              metadata: { source: 'vars_update' },
            });
          }

          if (patches.length > 0) {
            const r = await sm.commitChatState(patches);
            this.reportCommitResult(r, patches.length, 'vars_update');
          }
        } catch {
          console.warn('[Orchestrator] vars_update <json> 解析失败，跳过状态更新');
        }
      }

      // Step B: 提取 <status_effects> 块 → 解析效果定义 → apply
      const seMatch = varsOutput.match(/<status_effects>([\s\S]*?)<\/status_effects>/);
      if (seMatch) {
        try {
          const { parseStatusEffectsXML } = await import('./char-gen-agent');
          const effects = parseStatusEffectsXML(seMatch[1].trim());
          if (effects.length > 0) {
            const { createStateManager } = await import('./state-manager');
            const sm = createStateManager(this.saveId);
            const patches: import('./types').StatePatch[] = effects.map((e) => ({
              op: 'add_status_effect' as const,
              target: `characters.${e.owner}`,
              value: e,
              metadata: { source: 'vars_update' },
            }));
            const r = await sm.commitChatState(patches);
            this.reportCommitResult(r, patches.length, 'vars_update:status_effects');
          }
        } catch (e) {
          console.warn('[Orchestrator] vars_update <status_effects> 解析失败:', e);
        }
      }

      // Step C: 提取 <json> 中 quests 块 → StatePatch (Phase 10g)
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1].trim());
          if (parsed.quests) {
            const { createStateManager } = await import('./state-manager');
            const sm = createStateManager(this.saveId);
            const patches: import('./types').StatePatch[] = [];

            for (const q of parsed.quests.upsert ?? []) {
              const { name, ...questFields } = q;
              if (!name) continue;
              patches.push({
                op: 'update_quest',
                target: `quests.${name}`,
                value: { name, ...questFields },
                metadata: { source: 'vars_update', operation: 'upsert' },
              });
            }

            for (const q of parsed.quests.remove ?? []) {
              patches.push({
                op: 'remove_quest',
                target: `quests.${q.name}`,
                value: { name: q.name }, // #40: 形态统一为 {name} 对象
                metadata: { source: 'vars_update', operation: 'remove' },
              });
            }

            if (patches.length > 0) {
              const r = await sm.commitChatState(patches);
              this.reportCommitResult(r, patches.length, 'vars_update:quests');
            }
          }
        } catch {
          console.warn('[Orchestrator] vars_update <json> quests 解析失败，跳过 quest 更新');
        }
      }
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

  private buildRun(startTime: number, errors: string[] = []): OrchestratorRun {
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

/** dispatcher <json> 的变量路径是否为世界新闻（含子路径，如 世界新闻.0） */
function isWorldNewsPath(path: unknown): boolean {
  return typeof path === 'string' && (path === '世界新闻' || path.startsWith('世界新闻.'));
}

/**
 * 世界新闻值 → add_news StatePatch 列表（#16 双轨退役: 变量路径退役，唯一真源 profile.news）
 *
 * AI 只填叙事字段 {title(必), content(必), category?}（铁律3，id/publishedAt/read 由 Code 补）。
 * 兼容 dispatcher 的输出形态（AI 实际形状不可控，宽容解析）:
 * - 字符串 → 作 content，标题取首句截断，category 兜底 '世界'
 * - 对象 {title?, content?, category?} → 直用，缺失侧互补
 * - 对象 {date?, event?/text?/news?} → 真机实测形状（2026-07-17）: event 作 content，date 拼前缀
 * - 数组 → 逐条按上述规则展开
 * 空串/null/不可识别值 → 丢弃（不产 patch，也不落变量）。
 */
function buildNewsPatches(
  raw: unknown,
  operation: 'replace' | 'insert',
): import('./types').StatePatch[] {
  const items = Array.isArray(raw) ? raw : [raw];
  const patches: import('./types').StatePatch[] = [];

  for (const item of items) {
    let title = '';
    let content = '';
    let category: string | undefined;

    if (typeof item === 'string') {
      content = item.trim();
      category = '世界';
    } else if (item && typeof item === 'object') {
      const obj = item as Record<string, any>;
      if (typeof obj.title === 'string') title = obj.title.trim();
      // content 候选键宽容: content > event > text > news（真机实测 AI 产 {date, event} 形状）
      const contentRaw = [obj.content, obj.event, obj.text, obj.news].find(
        (v) => typeof v === 'string' && v.trim(),
      );
      if (contentRaw) content = String(contentRaw).trim();
      if (typeof obj.category === 'string' && obj.category) category = obj.category;
      // 游戏内日期是叙事信息 → 拼 content 前缀（publishedAt 是 Code 补的现实时间戳，两者语义不同）
      const dateStr = typeof obj.date === 'string' ? obj.date.trim() : '';
      if (dateStr && content && !content.startsWith('【')) content = `【${dateStr}】${content}`;
    }

    // title/content 互补（applyAddNews 两者必填）
    if (!content && title) content = title;
    if (!title && content) {
      // 短标题: 取首句，截断 20 字（剥掉日期前缀再取）
      const bare = content.replace(/^【[^】]*】/, '');
      const firstSentence = bare.split(/[。！？!?\n]/)[0] || bare;
      title = firstSentence.slice(0, 20);
    }
    if (!title || !content) {
      console.warn('[Orchestrator] 世界新闻条目缺 title/content，跳过:', item);
      continue;
    }

    patches.push({
      op: 'add_news',
      target: 'news', // M2 约定: applyAddNews 落 profile.news，target 仅作标识
      value: category ? { title, content, category } : { title, content },
      metadata: { source: 'request_dispatcher', operation },
    });
  }

  return patches;
}

// ========== 管线预设 ==========

/** 默认的 7 Agent 管线（从 types 中重新导出） */
export { DEFAULT_AGENT_PIPELINE } from './types';
