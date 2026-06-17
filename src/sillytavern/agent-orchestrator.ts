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
} from './types';
import { AgentClient } from './agent-client';
import type { ChatRequest } from './agent-client';
import { buildAgentMessages, getAgentTemplate } from './agent-templates';
import { scanMarkers } from './marker-protocol';

// ========== Types ==========

export interface OrchestratorOptions {
  pipeline: Pipeline;
  context: AgentContext;
  agentConfigs: AgentConfig[];
  endpoints: ApiEndpoint[];
  saveId: string;
  /** 可选的外部 fetch，用于测试注入 */
  fetch?: typeof fetch;
  /** 手动指定要运行的 Agent（空 = 全部） */
  onlyAgents?: string[];
}

export interface OrchestratorEvents {
  onStageStart?: (stageIndex: number, agents: string[]) => void;
  onAgentStart?: (agentId: string) => void;
  onAgentComplete?: (result: AgentResult) => void;
  onAgentError?: (agentId: string, error: string) => void;
  onStageComplete?: (stageIndex: number) => void;

  // ===== Phase 6e: Marker Protocol 回调 =====

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
   */
  onCharDetect?: (markers: CharDetectMarker[], storyOutput: string, context: AgentContext) => Promise<void>;
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

  /** Phase 6e: Stage 1 检测到的 combat markers — 延迟到 Stage 2 char_gen 后执行 */
  private pendingCombatMarkers: CombatTriggerMarker[] = [];

  constructor(options: OrchestratorOptions, events: OrchestratorEvents = {}) {
    this.pipeline = options.pipeline;
    this.context = options.context;
    this.saveId = options.saveId;
    this.events = events;
    this.runId = crypto.randomUUID();

    // Build lookup maps
    this.agentConfigs = new Map();
    for (const c of options.agentConfigs) {
      this.agentConfigs.set(c.agentId, c);
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

    this.events.onAgentStart?.(agentId);
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

    this.events.onAgentStart?.(agentId);
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

    // 构建 messages
    const messages = buildAgentMessages(config.agentId, this.context);
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
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    };

    return client.chat(request);
  }

  // ========== Internal: Validation ==========

  /** 验证管线 DAG 合法性 */
  private validatePipeline(): string[] {
    const errors: string[] = [];
    const knownAgents = new Set(this.agentConfigs.keys());

    // 注册内置 Agent（即使未配置，含 Phase 6e 新增）
    for (const id of ['memory_recall', 'plot_pre_check', 'story', 'vars_update', 'char_update', 'memory_summary', 'plot_post_check', 'plot_outline', 'plot_check', 'plot_correct', 'craft_gen', 'char_gen', 'item_gen', 'combat_summary']) {
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
   * - Stage 1 (story) 后: 处理 craft_request → 注入结果；暂存 combat_trigger
   * - Stage 2 (vars_update) 后: 先处理 char_detect → 再执行暂存的 combat_trigger
   *
   * 战斗延迟理由: <char_detect> 生成的新敌人/monster 必须在战斗开始前就绪。
   */
  private async processStageMarkers(stageIndex: number): Promise<void> {
    // Stage 1 (story): craft markers (立即阻塞执行) + combat markers (暂存)
    if (this.isStoryStage(stageIndex)) {
      const storyOutput = this.getAgentOutputText('story');
      if (!storyOutput) return;

      const scanResult = scanMarkers(storyOutput);

      // 🛑 Craft markers: 立即注入制作结果
      const craftMarkers = scanResult.markers.filter(
        (m): m is CraftRequestMarker => m.type === 'craft_request',
      );
      if (craftMarkers.length > 0 && this.events.onCraftRequest) {
        let modifiedOutput = storyOutput;
        for (const marker of craftMarkers) {
          const craftResult = await this.events.onCraftRequest(marker, storyOutput);
          if (craftResult) {
            modifiedOutput =
              modifiedOutput.slice(0, marker.position) +
              craftResult +
              modifiedOutput.slice(marker.position + marker.rawContent.length);
            const lengthDiff = craftResult.length - marker.rawContent.length;
            if (lengthDiff !== 0) {
              for (const m of craftMarkers) {
                if (m.position > marker.position) {
                  m.position += lengthDiff;
                }
              }
            }
          }
        }
        this.context.agentOutputs!.set('story', modifiedOutput);
      }

      // 🚩 Combat markers: 暂存，等 Stage 2 char_gen 完成后再执行
      const combatMarkers = scanResult.markers.filter(
        (m): m is CombatTriggerMarker => m.type === 'combat_trigger',
      );
      if (combatMarkers.length > 0) {
        this.pendingCombatMarkers.push(...combatMarkers);
      }
    }

    // Stage 2 (vars_update): 先 char_detect → 再执行 combat
    if (this.isVarsUpdateStage(stageIndex)) {
      const storyOutput = this.getAgentOutputText('story');
      if (!storyOutput) return;

      const scanResult = scanMarkers(storyOutput);

      // 👤 Char detect: 先生成新角色（新敌人/monster 需要在战斗前就绪）
      const charMarkers = scanResult.markers.filter(
        (m): m is CharDetectMarker => m.type === 'char_detect',
      );
      if (charMarkers.length > 0 && this.events.onCharDetect) {
        await this.events.onCharDetect(charMarkers, storyOutput, this.context);
      }

      // 🚩 执行暂存的 combat markers（新角色已生成完毕）
      if (this.pendingCombatMarkers.length > 0 && this.events.onCombatTrigger) {
        for (const marker of this.pendingCombatMarkers) {
          await this.events.onCombatTrigger(marker, storyOutput);
        }
        this.pendingCombatMarkers = [];
      }
    }
  }

  /** 判断当前 stage 是否包含 story agent */
  private isStoryStage(stageIndex: number): boolean {
    const stage = this.pipeline.stages[stageIndex];
    return stage?.agents.includes('story') ?? false;
  }

  /** 判断当前 stage 是否包含 vars_update agent */
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
