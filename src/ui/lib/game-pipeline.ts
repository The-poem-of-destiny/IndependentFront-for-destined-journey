/**
 * GamePipeline — 前端 ↔ AgentOrchestrator 桥接层
 *
 * Phase 10h: 连接 GamePage UI 和引擎 Agent 管线。
 * 封装: AgentConfig 组装 / AgentContext 构建 / 编排器创建 / 回调处理。
 */
import { AgentOrchestrator } from '@engine/agent-orchestrator'
import type {
  OrchestratorOptions,
  OrchestratorEvents,
} from '@engine/agent-orchestrator'
import {
  DEFAULT_AGENT_PIPELINE,
} from '@engine/types'
import type {
  AgentContext,
  AgentConfig,
  ApiEndpoint,
  AgentResult,
  CraftGenRequestMarker,
  CharGenRequestMarker,
  ItemGenRequestMarker,
} from '@engine/types'
import type { useGameStore } from '../stores/game-store'
import type { useSettingsStore } from '../stores/settings-store'

export interface GamePipelineDeps {
  gameStore: ReturnType<typeof useGameStore>
  settingsStore: ReturnType<typeof useSettingsStore>
  saveId: string
}

export class GamePipeline {
  private game: ReturnType<typeof useGameStore>
  private settings: ReturnType<typeof useSettingsStore>
  private saveId: string
  private orch: AgentOrchestrator | null = null

  constructor(deps: GamePipelineDeps) {
    this.game = deps.gameStore
    this.settings = deps.settingsStore
    this.saveId = deps.saveId
  }

  /** 发送开场 Prompt（首次加载存档时调用） */
  async sendOpeningPrompt(): Promise<void> {
    const prompt = this.game.openingPrompt
    if (!prompt) return
    await this.run(prompt)
    await this.game.markOpeningPromptConsumed()
  }

  /** 核心: 将用户输入送入 Agent 管线 */
  async run(userInput: string): Promise<void> {
    this.game.isGenerating = true

    try {
      // 1. 添加用户消息
      this.game.addMessage(userInput, 'user')

      // 2. 构建配置
      const agentConfigs = this.buildAgentConfigs()
      const endpoints = this.buildEndpoints()
      const context = this.buildContext(userInput)

      // 3. 创建编排器
      const options: OrchestratorOptions = {
        pipeline: DEFAULT_AGENT_PIPELINE,
        context,
        agentConfigs,
        endpoints,
        saveId: this.saveId,
      }
      const events = this.buildEventHandlers()
      this.orch = new AgentOrchestrator(options, events)

      // 4. 运行管线
      await this.orch.run()
    } catch (err) {
      console.error('[GamePipeline] 管线运行失败:', err)
      this.game.addMessage('[系统] AI 调用失败，请检查 API 配置后重试。', 'assistant')
    } finally {
      this.game.isGenerating = false
    }
  }

  // ===== 私有方法 =====

  private buildAgentConfigs(): AgentConfig[] {
    const s = this.settings.settings

    // 需要参与管线的所有 Agent
    const agentIds = [
      'memory_recall',
      'story',
      'request_dispatcher',
      'vars_update',
      'memory_summary',
    ]

    // 获取第一个 API endpoint（单 API 模式）
    const apiPool = (s.apiPool ?? []) as ApiEndpoint[]
    const defaultEndpointId = apiPool[0]?.id ?? ''

    return agentIds.map(agentId => ({
      agentId,
      enabled: true,
      apiEndpointId: defaultEndpointId,
      model: (s.agentModels as Record<string, string>)[agentId] ?? '',
      temperature: (s.agentTemperature as Record<string, number>)[agentId] ?? 0.7,
      maxTokens: (s.agentMaxTokens as Record<string, number>)[agentId] ?? 16384,
      topP: (s.agentTopP as Record<string, number>)[agentId] ?? 1.0,
      frequencyPenalty: (s.agentFreqPen as Record<string, number>)[agentId] ?? 0,
      presencePenalty: (s.agentPresPen as Record<string, number>)[agentId] ?? 0,
      retryOnFail: true,
      timeout: 120000,
      userId: `fp|${this.saveId}|${agentId}`,
      promptTemplate: {
        fixedSystem: (s.agentPrompts as Record<string, string>)[agentId] ?? '',
        fixedExamples: '',
      },
      worldBookIds: (s.agentWorldbookEnabled as Record<string, boolean>)[agentId]
        ? ((s.agentWorldbookIds as Record<string, string[]>)[agentId] ?? [])
        : [],
      systemPrompt: (s.agentPrompts as Record<string, string>)[agentId],
      template: (s.agentTemplates as Record<string, string>)[agentId],
      toolsEnabled: ['craft_gen', 'char_gen', 'item_gen'].includes(agentId),
    } as AgentConfig))
  }

  private buildEndpoints(): ApiEndpoint[] {
    const s = this.settings.settings
    return (s.apiPool ?? []) as ApiEndpoint[]
  }

  private buildContext(userInput: string): AgentContext {
    // 构建历史消息（只取 user/assistant，不含 system）
    const history = this.game.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ ...m }))

    return {
      userInput,
      history,
      lorebookMatches: [],
      worldBooks: [],
      characters: this.game.characters,
      variables: this.game.latestVariables ?? {},
      plotEvents: this.game.activePlotEvents,
      memories: this.game.recentMemories,
      quests: this.game.saveProfile?.quests,
      agentOutputs: new Map(),
      plotSettings: { mode: 'off' },  // 禁用所有剧情 Agent
    }
  }

  private buildEventHandlers(): OrchestratorEvents {
    return {
      // === Stage 回调 ===
      onAgentStart: (agentId) => {
        console.log(`[GamePipeline] Agent 开始: ${agentId}`)
      },
      onAgentComplete: (result) => {
        this.handleAgentResult(result)
      },
      onAgentError: (agentId, error) => {
        console.error(`[GamePipeline] Agent 错误: ${agentId}`, error)
      },

      // === Marker 回调 ===
      onCombatTrigger: async () => null,  // 跳过战斗
      onCraftGenRequest: async (markers, _varsOutput, ctx) => {
        await this.handleCraftGen(markers, ctx)
      },
      onCharGenRequest: async (markers, _varsOutput, ctx) => {
        await this.handleCharGen(markers, ctx)
      },
      onItemGenRequest: async (markers, _varsOutput, _ctx) => {
        // item_gen 独立请求 — 目前先记录日志
        console.log('[GamePipeline] item_gen_request:', markers.length, '个')
      },
    }
  }

  /** 处理单个 Agent 完成 */
  private handleAgentResult(result: AgentResult) {
    switch (result.agentId) {
      case 'story': {
        if (result.output?.content && typeof result.output.content === 'string') {
          this.game.addMessage(result.output.content, 'assistant')
        } else if (result.rawResponse) {
          // 兜底: rawResponse 作为正文（可能包含系统标签，前端会美化过滤）
          this.game.addMessage(result.rawResponse, 'assistant')
        }
        break
      }
      case 'vars_update': {
        // 提取选项（从 output.options 或 <options> XML 标签）
        if (result.output?.options && Array.isArray(result.output.options)) {
          this.game.setPendingOptions(result.output.options)
        }
        break
      }
    }
  }

  /** 处理制作生成链 */
  private async handleCraftGen(
    markers: CraftGenRequestMarker[],
    ctx: AgentContext,
  ) {
    try {
      const { runCraftGenChain } = await import('@engine/craft-gen-chain')
      for (const marker of markers) {
        const result = await runCraftGenChain(
          { marker, agentContext: ctx } as any,
          {
            clientFactory: null as any,
            stateManager: null as any,
          },
        )
        if (result.narrative) {
          this.game.addMessage(result.narrative, 'assistant')
        }
      }
    } catch (err) {
      console.error('[GamePipeline] craft_gen 链失败:', err)
    }
  }

  /** 处理角色生成链 */
  private async handleCharGen(
    markers: CharGenRequestMarker[],
    ctx: AgentContext,
  ) {
    try {
      const { runCharGenChain } = await import('@engine/char-gen-agent')
      const { createStateManager } = await import('@engine/state-manager')
      const sm = createStateManager(this.saveId)
      // Wrap StateManager to match CharGenAgentDeps interface (Promise<StateCommitResult> → Promise<void>)
      const wrappedStateManager = sm ? {
        commitChatState: async (patches: any[]) => { await sm.commitChatState(patches) },
      } : undefined

      for (const marker of markers) {
        const charGenRequest = {
          marker,
          agentContext: ctx,
          userInput: ctx.userInput,
        } as any
        const result = await runCharGenChain(charGenRequest, {
          clientFactory: null as any,
          stateManager: wrappedStateManager,
        })
        if (result.character) {
          // 添加新角色到 store
          this.game.characters.push(result.character)
          // 添加系统消息
          this.game.addMessage(result.narrativeSummary, 'assistant')
        }
      }
    } catch (err) {
      console.error('[GamePipeline] char_gen 链失败:', err)
    }
  }
}
