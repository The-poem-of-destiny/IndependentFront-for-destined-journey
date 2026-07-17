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
  Pipeline, PipelineStage, AgentContext, AgentResult,
  OrchestratorRun, AgentConfig, ApiEndpoint, AgentDefinition,
  CraftRequestMarker, CombatTriggerMarker, CharDetectMarker, CombatSummaryResult,
  CharGenRequestMarker, ItemGenRequestMarker, ItemUpdateRequestMarker, CraftGenRequestMarker,
  ToolExecutionContext,
} from './types';
import { AgentClient } from './agent-client';
import type { ChatRequest, StreamCallbacks } from './agent-client';
import { buildAgentMessages, getAgentTemplate } from './agent-templates';
import { scanMarkers } from './marker-protocol';
import { recallMemories } from './memory-store';
import { buildZoneContext } from './context-visibility';
import { getToolsForAgent, executeToolCall } from './agent-tools';

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
  onAgentComplete?: (result: AgentResult) => void;
  onAgentError?: (agentId: string, error: string) => void;
  onStageComplete?: (stageIndex: number) => void;
  /** StatePatch 提交后存在失败项时触发（source = 'request_dispatcher' | 'vars_update' 等） */
  onStateCommitError?: (source: string, errors: string[]) => void;

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
  onCombatTrigger?: (marker: CombatTriggerMarker, storyOutput: string) => Promise<CombatSummaryResult | null>;

  /**
   * 👤 Char Detect: Stage 2 vars_update 后检测到 <char_detect> 后触发。
   * 调用方应运行 char_gen → item_gen 链生成新角色数据。
   * @deprecated 新流程使用 onCharGenRequest 处理 <char_gen_request>
   */
  onCharDetect?: (markers: CharDetectMarker[], storyOutput: string, context: AgentContext) => Promise<void>;

  // ===== Phase 10: request_dispatcher 调度器回调 =====

  /** Stage 2: request_dispatcher 输出中的 <char_gen_request> → char_gen→item_gen 链 */
  onCharGenRequest?: (markers: CharGenRequestMarker[], varsOutput: string, context: AgentContext) => Promise<void>;

  /** Stage 2: request_dispatcher 输出中的 <item_gen_request> → item_gen 独立调用 */
  onItemGenRequest?: (markers: ItemGenRequestMarker[], varsOutput: string, context: AgentContext) => Promise<void>;

  /** Stage 2: request_dispatcher 输出中的 <item_update_request> → 已合并到 Stage 3 vars_update，此回调仅作兼容 */
  onItemUpdateRequest?: (markers: ItemUpdateRequestMarker[], varsOutput: string, context: AgentContext) => Promise<void>;

  /** Stage 2: request_dispatcher 输出中的 <craft_gen_request> → craft_gen→item_gen 链 */
  onCraftGenRequest?: (markers: CraftGenRequestMarker[], varsOutput: string, context: AgentContext) => Promise<void>;

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

  /** @deprecated Phase 10: 旧格式 pendingCombatMarkers，新流程从 vars_update 输出直接扫描 */
  private pendingCombatMarkers: CombatTriggerMarker[] = [];

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
    const plotMode = options.context.plotSettings?.mode
    if (plotMode === 'off') {
      for (const plotAgentId of ['plot_pre_check', 'plot_post_check', 'plot_outline']) {
        const cfg = this.agentConfigs.get(plotAgentId)
        if (cfg) {
          cfg.enabled = false
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

    this.status = this.completedStages.length > 0 ? 'completed' : 'failed';
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
      // Update context with new result (but do NOT propagate to downstream)
      this.context.agentOutputs!.set(agentId, result.output);
      this.events.onAgentComplete?.(result);
    }

    return result;
  }

  // ========== Internal: Stage Execution ==========

  private async executeStage(stage: PipelineStage, _stageIndex: number): Promise<void> {
    const agentsToRun = this.onlyAgents
      ? stage.agents.filter(a => this.onlyAgents!.has(a))
      : stage.agents;

    if (agentsToRun.length === 0) return;

    // 并行执行同阶段所有 Agent
    const promises = agentsToRun.map(agentId => this.executeAgent(agentId));
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
          hasSuccess = true;
          // 注入上下文供下游 Agent 使用（单向流动）
          this.context.agentOutputs!.set(agentId, result.output);
          this.events.onAgentComplete?.(result);
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
    if (config.agentId === 'memory_recall' && (
      /embedding/i.test(config.model) ||
      (endpoint as any).apiType === 'embedding'
    )) {
      return this.callMemoryRecallEmbedding(endpoint, config);
    }

    // 🆕 Phase 8.5 Agentic 路径
    if (config.toolsEnabled) {
      return this.callAgenticAgent(config, endpoint);
    }

    // 构建 messages (Phase 8: 四部分拼接)
    const configsArr = Array.from(this.agentConfigs.values());
    const messages = buildAgentMessages(
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

    let result: AgentResult

    // 🆕 流式路径: 如果配置了 streamCallbacks，使用 chatStream() 逐块输出
    if (config.streamCallbacks) {
      result = await this.callAgentStreaming(client, request, config);
    } else {
      result = await client.chat(request, config.abortSignal);
    }

    // 🆕 注入请求消息供 debug 面板使用
    result.requestMessages = messages

    return result
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
      client.chatStream(request, {
        onChunk: (text, isComplete) => {
          callbacks.onChunk(text, isComplete);
        },
        onComplete: (streamResult) => {
          resolve({
            agentId: config.agentId,
            output: streamResult.fullText,
            rawResponse: streamResult.fullText,
            reasoning: streamResult.reasoning,
            tokensUsed: streamResult.tokensUsed,
            cacheHit: streamResult.cacheHit,
            duration: streamResult.duration,
          });
        },
        onError: (error) => {
          resolve({
            agentId: config.agentId,
            output: null,
            rawResponse: '',
            tokensUsed: 0,
            cacheHit: false,
            duration: Date.now() - startTime,
            error,
          });
        },
      }, config.abortSignal);
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
    const messages = buildAgentMessages(
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
    const startTime = Date.now()
    const topK = 20 // 使用合理默认值，与 settings-store 的 memoryRecallCount 默认对齐
    const query = this.context.userInput || ''

    try {
      const recalled = await recallMemories(
        this.saveId,
        query,
        topK,
        {
          baseUrl: endpoint.baseUrl,
          apiKey: endpoint.apiKey,
          defaultModel: config.model || endpoint.defaultModel,
        },
      )

      // 格式化为与 LLM 路径兼容的输出结构
      const memories = recalled.map(r => ({
        id: r.memory.id,
        relevance: Math.round(r.score * 100) / 100,
        reason: r.score > 0
          ? `Embedding 余弦相似度: ${r.score.toFixed(3)}`
          : '无向量，按重要度排序',
      }))

      const output = { memories }
      const duration = Date.now() - startTime

      return {
        agentId: config.agentId,
        output,
        rawResponse: JSON.stringify(output),
        tokensUsed: 0,       // Embedding API 按 token 计费但在 /chat/completions 口径下为 0
        cacheHit: false,
        duration,
      }
    } catch (err) {
      return {
        agentId: config.agentId,
        output: null,
        rawResponse: '',
        tokensUsed: 0,
        cacheHit: false,
        duration: Date.now() - startTime,
        error: `Embedding 召回失败: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // ========== Internal: Validation ==========

  /** 验证管线 DAG 合法性 */
  private validatePipeline(): string[] {
    const errors: string[] = [];
    const knownAgents = new Set(this.agentConfigs.keys());

    // 注册内置 Agent（即使未配置，含 Phase 6e 新增 + Phase 10 重命名）
    for (const id of ['memory_recall', 'plot_pre_check', 'story', 'request_dispatcher', 'vars_update', 'memory_summary', 'plot_post_check', 'plot_outline', 'plot_check', 'plot_correct', 'craft_gen', 'char_gen', 'item_gen', 'combat_summary']) {
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

      // 旧格式 combat_trigger（仍从 story 扫描，向后兼容）
      const combatMarkers = scanResult.markers.filter(
        (m): m is CombatTriggerMarker => m.type === 'combat_trigger',
      );
      if (combatMarkers.length > 0) {
        this.pendingCombatMarkers.push(...combatMarkers);
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

          for (const r of (parsed.replace ?? [])) {
            patches.push({
              op: 'set_variable',
              target: `variables.${r.path}`,
              value: r.value,
              metadata: { source: 'request_dispatcher', operation: 'replace' },
            });
          }
          for (const d of (parsed.delta ?? [])) {
            patches.push({
              op: 'delta_variable',
              target: `variables.${d.path}`,
              amount: d.amount,
              metadata: { source: 'vars_update', operation: 'delta' },
            });
          }
          for (const ins of (parsed.insert ?? [])) {
            patches.push({
              op: 'insert_variable',
              target: `variables.${ins.path}`,
              value: ins.value,
              metadata: { source: 'vars_update', operation: 'insert', index: ins.index },
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

      // Step C: 旧格式 char_detect（向后兼容）— 从 story 扫描
      const storyOutput = this.getAgentOutputText('story');
      if (storyOutput) {
        const storyScan = scanMarkers(storyOutput);
        const oldCharMarkers = storyScan.markers.filter(
          (m): m is CharDetectMarker => m.type === 'char_detect',
        );
        if (oldCharMarkers.length > 0 && this.events.onCharDetect) {
          await this.events.onCharDetect(oldCharMarkers, storyOutput, this.context);
        }
      }

      // Step D: 新格式 request 标签 → 并行回调
      const charGenMarkers = markers.filter((m): m is CharGenRequestMarker => m.type === 'char_gen_request');
      const itemGenMarkers = markers.filter((m): m is ItemGenRequestMarker => m.type === 'item_gen_request');
      const itemUpdateMarkers = markers.filter((m): m is ItemUpdateRequestMarker => m.type === 'item_update_request');
      const craftGenMarkers = markers.filter((m): m is CraftGenRequestMarker => m.type === 'craft_gen_request');

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

      // Step E: 旧格式 craft/combat（向后兼容）
      if (this.pendingCraftMarkers.length > 0 && this.events.onCraftRequest) {
        let modifiedOutput = storyOutput ?? '';
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

      if (this.pendingCombatMarkers.length > 0 && this.events.onCombatTrigger) {
        for (const marker of this.pendingCombatMarkers) {
          await this.events.onCombatTrigger(marker, storyOutput ?? '');
        }
        this.pendingCombatMarkers = [];
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
          for (const r of (parsed.characters?.replace ?? [])) {
            const { id, path, value } = r;
            switch (path) {
              case 'hp': patches.push({ op: 'set_hp', target: `characters.${id}`, value, metadata: { source: 'vars_update' } }); break;
              case 'mp': patches.push({ op: 'set_mp', target: `characters.${id}`, value, metadata: { source: 'vars_update' } }); break;
              case 'sp': patches.push({ op: 'set_sp', target: `characters.${id}`, value, metadata: { source: 'vars_update' } }); break;
              case 'location':
                patches.push({ op: 'set_location', target: `characters.${id}`, value: value, metadata: { source: 'vars_update' } }); break;
              case 'currentAction':
                patches.push({ op: 'set_location', target: `characters.${id}`, value: value, metadata: { source: 'vars_update' } }); break;
              default:
                patches.push({ op: 'update_character', target: `characters.${id}`, value: { [path]: value }, metadata: { source: 'vars_update', path } });
            }
          }

          // --- characters.delta → delta_hp/delta_mp/delta_sp ---
          for (const d of (parsed.characters?.delta ?? [])) {
            const { id, path, amount } = d;
            switch (path) {
              case 'hp': patches.push({ op: 'delta_hp', target: `characters.${id}`, amount, metadata: { source: 'vars_update' } }); break;
              case 'mp': patches.push({ op: 'delta_mp', target: `characters.${id}`, amount, metadata: { source: 'vars_update' } }); break;
              case 'sp': patches.push({ op: 'delta_sp', target: `characters.${id}`, amount, metadata: { source: 'vars_update' } }); break;
              default:
                patches.push({ op: 'update_character', target: `characters.${id}`, value: { [path]: amount }, metadata: { source: 'vars_update', path, delta: true } });
            }
          }

          // --- characters.add → add_status_effect/add_skill/add_item/equip_item ---
          for (const a of (parsed.characters?.add ?? [])) {
            const { id, path, value } = a;
            switch (path) {
              case 'statusEffects': patches.push({ op: 'add_status_effect', target: `characters.${id}`, value, metadata: { source: 'vars_update' } }); break;
              case 'skills': patches.push({ op: 'add_skill', target: `characters.${id}`, value, metadata: { source: 'vars_update' } }); break;
              case 'inventory': {
                // applyAddItem 要求 value.id (按 id 去重叠加)，AI 输出不含 id → 补生成 (对齐 item-gen-chain 约定)
                const itemId = `varsupd_inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                patches.push({
                  op: 'add_item',
                  target: `characters.${id}`,
                  value: {
                    id: itemId,
                    name: value?.name ?? '未知物品',
                    description: value?.description,
                    quantity: value?.quantity ?? 1,
                    type: value?.type,
                    rarity: value?.rarity,
                  },
                  metadata: { source: 'vars_update', path, add: true },
                });
                break;
              }
              case 'equipment': {
                if (value?.itemId) {
                  // AI 给了 itemId（装备背包内已有物品）→ 直接 equip
                  patches.push({ op: 'equip_item', target: `characters.${id}`, value, metadata: { source: 'vars_update' } });
                } else {
                  // AI 只给 {name, type, slot} → 两步: add_item 写背包 + equip_item 同 id 搬进装备栏
                  // (对齐 item-gen-chain.ts buildItemGenPatches 的装备两步落库约定)
                  const itemId = `varsupd_eq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                  patches.push({
                    op: 'add_item',
                    target: `characters.${id}`,
                    value: { id: itemId, name: value?.name ?? '未知装备', description: value?.description, quantity: 1, type: 'equipment', rarity: value?.rarity },
                    metadata: { source: 'vars_update', path, add: true },
                  });
                  patches.push({
                    op: 'equip_item',
                    target: `characters.${id}`,
                    value: { itemId, slot: value?.slot ?? value?.type ?? '未知', name: value?.name ?? '未知装备', stats: value?.stats },
                    metadata: { source: 'vars_update', path, add: true },
                  });
                }
                break;
              }
              default: patches.push({ op: 'update_character', target: `characters.${id}`, value: { [path]: value }, metadata: { source: 'vars_update', path, add: true } });
            }
          }

          // --- characters.remove → remove_status_effect/unequip_item ---
          for (const rm of (parsed.characters?.remove ?? [])) {
            const { id, path, target: rmTarget } = rm;
            switch (path) {
              case 'statusEffects': patches.push({ op: 'remove_status_effect', target: `characters.${id}`, value: rmTarget, metadata: { source: 'vars_update' } }); break;
              case 'equipment': patches.push({ op: 'unequip_item', target: `characters.${id}`, value: rmTarget, metadata: { source: 'vars_update' } }); break;
              case 'skills': patches.push({ op: 'update_character', target: `characters.${id}`, value: { removeSkill: rmTarget }, metadata: { source: 'vars_update', path, remove: true } }); break;
            }
          }

          // --- items.consume → remove_item ---
          for (const c of (parsed.items?.consume ?? [])) {
            patches.push({ op: 'remove_item', target: `characters.${c.owner}`, value: { name: c.target, quantity: c.quantity ?? 1 }, metadata: { source: 'vars_update', operation: 'consume' } });
          }

          // --- items.equip → equip_item ---
          for (const e of (parsed.items?.equip ?? [])) {
            patches.push({ op: 'equip_item', target: `characters.${e.owner}`, value: { itemId: e.target, slot: e.slot }, metadata: { source: 'vars_update', operation: 'equip' } });
          }

          // --- items.unequip → unequip_item ---
          for (const u of (parsed.items?.unequip ?? [])) {
            patches.push({ op: 'unequip_item', target: `characters.${u.owner}`, value: u.target, metadata: { source: 'vars_update', operation: 'unequip' } });
          }

          // --- items.transfer → remove_item + add_item ---
          for (const t of (parsed.items?.transfer ?? [])) {
            patches.push({ op: 'remove_item', target: `characters.${t.from}`, value: { name: t.target, quantity: t.quantity ?? 1 }, metadata: { source: 'vars_update', operation: 'transfer_out' } });
            patches.push({ op: 'add_item', target: `characters.${t.to}`, value: { name: t.target, quantity: t.quantity ?? 1 }, metadata: { source: 'vars_update', operation: 'transfer_in' } });
          }

          // --- items.modify → update_character ---
          for (const m of (parsed.items?.modify ?? [])) {
            patches.push({ op: 'update_character', target: `characters.${m.owner}`, value: { itemUpdate: { target: m.target, changes: m.changes } }, metadata: { source: 'vars_update', operation: 'modify' } });
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
            const patches: import('./types').StatePatch[] = effects.map(e => ({
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

            for (const q of (parsed.quests.upsert ?? [])) {
              const { name, ...questFields } = q;
              if (!name) continue;
              patches.push({
                op: 'update_quest',
                target: `quests.${name}`,
                value: { name, ...questFields },
                metadata: { source: 'vars_update', operation: 'upsert' },
              });
            }

            for (const q of (parsed.quests.remove ?? [])) {
              patches.push({
                op: 'remove_quest',
                target: `quests.${q.name}`,
                value: { name: q.name },  // #40: 形态统一为 {name} 对象
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
      console.error(`[Orchestrator] ${source} 状态提交失败 ${result.errors.length}/${patchCount} 条:`, result.errors);
      this.events.onStateCommitError?.(source, result.errors);
    } else if (result.patchesApplied < patchCount) {
      // applyPatch 验证失败走 return 不 throw、不进 errors[]，用数量差兜底
      console.warn(`[Orchestrator] ${source} 部分 patch 验证失败未生效: ${result.patchesApplied}/${patchCount}`);
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

// ========== 管线预设 ==========

/** 默认的 7 Agent 管线（从 types 中重新导出） */
export { DEFAULT_AGENT_PIPELINE } from './types';
