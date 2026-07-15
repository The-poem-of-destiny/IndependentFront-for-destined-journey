/**
 * GamePipeline — 前端 ↔ AgentOrchestrator 桥接层
 *
 * Phase 10h: 连接 GamePage UI 和引擎 Agent 管线。
 * 封装: AgentConfig 组装 / AgentContext 构建 / 编排器创建 / 回调处理。
 *
 * Phase 7e: 🆕 流式渲染支持 — story agent 使用 chatStream() 逐块回调，
 * 通过 onStoryChunk 将增量文本实时推送到前端 UI。
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
  AgentPreset,
  WorldBook,
  CraftGenRequestMarker,
  CharGenRequestMarker,
  ItemGenRequestMarker,
} from '@engine/types'
import { AgentClient } from '@engine/agent-client'
import type { StreamCallbacks } from '@engine/agent-client'
import { createStateManager } from '@engine/state-manager'
import { loadBuiltInWorldBooks } from '@engine/builtin-worldbooks'
import { filterBooksByEnabledEntries } from '@engine/worldbook-loader'
import type { useGameStore } from '../stores/game-store'
import type { useSettingsStore } from '../stores/settings-store'

export interface GamePipelineDeps {
  gameStore: ReturnType<typeof useGameStore>
  settingsStore: ReturnType<typeof useSettingsStore>
  saveId: string
}

/** 流式回调 — 由 GamePage 提供实时渲染 */
export type StoryChunkCallback = (chunk: string) => void

/** 各 Agent 的中文标签（供调试日志 / DebugPanel 显示） */
const AGENT_LABELS: Record<string, string> = {
  memory_recall: '记忆召回',
  story: '叙事生成',
  request_dispatcher: '请求调度',
  vars_update: '状态更新',
  memory_summary: '记忆摘要',
  plot_pre_check: '剧情预检',
  plot_post_check: '剧情复检',
  craft_gen: '制作生成',
  char_gen: '角色生成',
  item_gen: '物品生成',
  plot_outline: '剧情大纲',
}

export class GamePipeline {
  private game: ReturnType<typeof useGameStore>
  private settings: ReturnType<typeof useSettingsStore>
  private saveId: string
  private orch: AgentOrchestrator | null = null
  private abortController: AbortController | null = null

  constructor(deps: GamePipelineDeps) {
    this.game = deps.gameStore
    this.settings = deps.settingsStore
    this.saveId = deps.saveId
  }

  /** 发送开场 Prompt（首次加载存档时调用），作为首条用户消息注入管线 */
  async sendOpeningPrompt(onStoryChunk?: StoryChunkCallback): Promise<void> {
    const prompt = this.game.openingPrompt
    if (!prompt) return
    // 开场 prompt 作为真正的用户消息渲染 + 注入历史，让下游 Agent 能读到装备/技能/背景/命定核心等
    const ok = await this.run(prompt, onStoryChunk, /* isUserMessage */ true)
    if (ok) {
      await this.game.markOpeningPromptConsumed()
    }
  }

  /** 核心: 将用户输入送入 Agent 管线。返回 true 表示管线成功完成。 */
  async run(userInput: string, onStoryChunk?: StoryChunkCallback, isUserMessage = true): Promise<boolean> {
    console.log('[GamePipeline] run() called — userInput length:', userInput.length, 'isUserMessage:', isUserMessage)
    console.log('[GamePipeline] userInput preview:', userInput.slice(0, 300))
    this.abortController = new AbortController()
    this.game.isGenerating = true

    try {
      // 1. 添加用户消息（非用户消息仅注入 context 不渲染）
      if (isUserMessage) {
        this.game.addMessage(userInput, 'user')
      }
      this.game.clearAgentLog()

      // 2. 构建 endpoints & context
      const endpoints = this.buildEndpoints()
      const context = this.buildContext(userInput)

      // 2.5 加载预设和世界书（自 fetch agent-config.json，不依赖 store 异步初始化）
      const { presets, agentDefaults } = await this.loadPresets()
      const worldBooks = await this.loadActiveWorldBooks()

      // 2.6 构建 Agent 配置（用已加载的 agentDefaults 替代 projectAgentDefaults）
      const agentConfigs = this.buildAgentConfigs(agentDefaults, onStoryChunk)

      // 3. 创建编排器
      const options: OrchestratorOptions = {
        pipeline: DEFAULT_AGENT_PIPELINE,
        context,
        agentConfigs,
        endpoints,
        saveId: this.saveId,
        presets,
        worldBooks,
      }
      const events = this.buildEventHandlers()
      this.orch = new AgentOrchestrator(options, events)

      // 4. 运行管线
      await this.orch.run()
      return true
    } catch (err) {
      // Abort 错误不视为真正的失败
      if ((err as Error)?.name === 'AbortError') {
        console.log('[GamePipeline] 管线已中止')
        return false
      }
      console.error('[GamePipeline] 管线运行失败:', err)
      this.game.addMessage('[系统] AI 调用失败，请检查 API 配置后重试。', 'assistant')
      return false
    } finally {
      this.game.isGenerating = false
      this.abortController = null
    }
  }

  /** 中止当前管线运行 */
  abort(): void {
    this.abortController?.abort()
    this.game.isGenerating = false
  }

  // ===== 私有方法 =====

  private buildAgentConfigs(
    agentDefaults: Record<string, { presetId?: string; systemPrompt?: string; template?: string }>,
    onStoryChunk?: StoryChunkCallback,
  ): AgentConfig[] {
    const s = this.settings.settings

    // 需要参与管线的所有 Agent（不包括 plot_pre_check/plot_post_check — 剧情模式 off 时会自动禁用）
    const agentIds = [
      'memory_recall',
      'story',
      'request_dispatcher',
      'vars_update',
      'memory_summary',
      'plot_pre_check',
      'plot_post_check',  // Phase 10g: quest 委托管线需要
    ]

    // 复用 buildEndpoints() 的映射结果（ApiEntry.model → ApiEndpoint.defaultModel）
    const apiPool = this.buildEndpoints()

    // agentModels 存 API 池 id → 匹配对应端点
    const getEndpoint = (agentId: string): ApiEndpoint | undefined => {
      const poolId = (s.agentModels as Record<string, string>)[agentId] || ''
      return apiPool.find(ep => ep.id === poolId) || apiPool[0]
    }

    return agentIds.map(agentId => {
      const isStory = agentId === 'story'
      const signal = this.abortController?.signal
      const endpoint = getEndpoint(agentId)
      const model = endpoint?.defaultModel || ''
      if (!model) {
        console.error(`[GamePipeline] agent "${agentId}" — 未配置模型！请在设置页为该 Agent 选择 API 池并确保池中有默认模型`)
      }
      console.log('[GamePipeline] agent:', agentId, 'endpoint:', endpoint?.id, 'model:', model)

      // 🆕 为 story agent 构建流式回调（如果提供了 onStoryChunk）
      let streamCallbacks: StreamCallbacks | undefined
      if (isStory && onStoryChunk) {
        streamCallbacks = {
          onChunk: (text: string, _isComplete: boolean) => {
            onStoryChunk(text)
          },
          onComplete: () => {
            // 流式完成 — 最终结果由 handleAgentResult 处理
          },
          onError: (error: string) => {
            console.warn('[GamePipeline] story 流式错误:', error)
          },
        }
      }

      // 从已加载的 agentDefaults 取 presetId/systemPrompt/template
      // （loadPresets 已自 fetch agent-config.json，不依赖 store.projectAgentDefaults 异步初始化）
      const defaults = agentDefaults[agentId] ?? {}
      const presetId: string | undefined = defaults.presetId || undefined
      const systemPrompt: string | undefined = defaults.systemPrompt || undefined
      const template: string | undefined = defaults.template || undefined

      return {
        agentId,
        enabled: true,
        apiEndpointId: endpoint?.id ?? '',
        model,
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
        presetId,
        worldBookIds: (s.agentWorldbookEnabled as Record<string, boolean>)[agentId]
          ? ((s.agentWorldbookIds as Record<string, string[]>)[agentId] ?? [])
          : [],
        // 🔑 优先使用 agentDefaults（loadPresets 自 fetch agent-config.json），
        // localStorage 可能有用户编辑过的版本，作为 fallback。
        systemPrompt: systemPrompt || (s.agentPrompts as Record<string, string>)[agentId],
        template: template || (s.agentTemplates as Record<string, string>)[agentId],
        toolsEnabled: ['craft_gen', 'char_gen', 'item_gen'].includes(agentId),
        maxToolCallRounds: 10,
        // 🆕 流式 + abort 信号
        streamCallbacks,
        abortSignal: signal,
      } as AgentConfig
    })
  }

  private buildEndpoints(): ApiEndpoint[] {
    const s = this.settings.settings
    // 前后端 model 结构不同:
    //   localStorage: ApiEntry    { model: string, models: string[], apiType: string }
    //   引擎:         ApiEndpoint { defaultModel: string, models: string[], provider: string }
    // 映射补齐，避免下游读错字段（defaultModel → 空串 → API 请求缺 model）
    return ((s.apiPool ?? []) as any[]).map((entry: any) => ({
      id: entry.id || '',
      name: entry.name || '',
      provider: entry.provider || entry.apiType || 'custom',
      baseUrl: entry.baseUrl || '',
      apiKey: entry.apiKey || '',
      defaultModel: entry.defaultModel || entry.model || '',  // ← 关键：ApiEntry.model → ApiEndpoint.defaultModel
      models: entry.models || [],
      timeout: entry.timeout ?? 60000,
      enableThinking: entry.enableThinking ?? false,           // API 池思考链开关
    })) as ApiEndpoint[]
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

  /** 加载 story 预设：DB 优先（用户可修改）→ agent-config.json 内嵌 preset fallback 补齐缺失。
   *  同时返回各 agent 的默认配置（presetId/systemPrompt/template），
   *  自给自足 fetch agent-config.json，不依赖 store 的 projectAgentDefaults 异步加载时序。 */
  private async loadPresets(): Promise<{
    presets: AgentPreset[]
    agentDefaults: Record<string, { presetId?: string; systemPrompt?: string; template?: string }>
  }> {
    let presets: AgentPreset[] = []
    const agentDefaults: Record<string, { presetId?: string; systemPrompt?: string; template?: string }> = {}

    // 1. DB 优先：用户可能通过设置页修改过预设
    try {
      const { getPresets } = await import('@engine/database')
      const dbPresets = await getPresets()
      if (dbPresets && dbPresets.length > 0) {
        presets = dbPresets as unknown as AgentPreset[]
      }
    } catch {
      // IndexedDB 不可用时静默跳过
    }

    // 2. 直接 fetch agent-config.json（不依赖 store.projectAgentDefaults 异步初始化时序）
    try {
      const res = await fetch('/data/defaults/agent-config.json')
      if (res.ok) {
        const config = await res.json()
        const agents = config.agents || {}
        for (const [agentId, entry] of Object.entries(agents)) {
          const e = entry as any
          // 提取内嵌预设（story 等依赖 ST 预设的 Agent）
          if (e.preset && !presets.some(p => p.id === (e.preset as any).id)) {
            presets.push(e.preset as unknown as AgentPreset)
          }
          // 提取各 agent 默认配置（供 buildAgentConfigs 使用）
          agentDefaults[agentId] = {
            presetId: e.presetId || undefined,
            systemPrompt: e.systemPrompt || undefined,
            template: e.template || undefined,
          }
        }
      }
    } catch {
      // 静默跳过
    }

    return { presets, agentDefaults }
  }

  /** 加载启用世界书：内置书 + 存档级条目过滤 */
  private async loadActiveWorldBooks(): Promise<WorldBook[]> {
    try {
      const all = await loadBuiltInWorldBooks()
      const enabledEntries = this.game.activeSave?.metadata?.enabledWorldBookEntries ?? []
      return filterBooksByEnabledEntries(all, enabledEntries)
    } catch {
      return []
    }
  }

  /** 获取当前默认 API endpoint */
  private getDefaultEndpoint(): ApiEndpoint {
    return this.buildEndpoints()[0]
  }

  /** 创建 AgentClient 工厂 —— 供 craft_gen / char_gen / item_gen 链使用。
   *  🆕 包裹一层 LogClient：拦截 chat / chatWithTools，自动写 agentLog，
   *  让侧链 Agent 在 DebugPanel 可见（否则绕过 orchestrator 时无日志）。 */
  private getClientFactory() {
    const saveId = this.saveId
    const game = this.game
    return (agentId: string, endpoint: ApiEndpoint, _saveId: string) => {
      const real = new AgentClient({ endpoint, agentId, saveId })
      const label = AGENT_LABELS[agentId] ?? agentId
      let callSeq = 0

      const record = (
        messages: Array<{ role: string; content: string | null }>,
        result: { rawResponse?: string; output?: string | null; reasoning?: string; tokensUsed?: number; cacheHit?: boolean; error?: string; duration?: number } | undefined,
        duration: number,
      ) => {
        callSeq += 1
        // 同一 Agent 一轮内被多次调用时（如 2 个新角色 → char_gen 跑 2 次），
        // addAgentLogEntry 按 agentId 覆盖同名条目，故给 agentId/label 加序号后缀避免互相覆盖。
        const seqId = callSeq > 1 ? `${agentId}#${callSeq}` : agentId
        game.addAgentLogEntry({
          agentId: seqId,
          label: callSeq > 1 ? `${label} #${callSeq}` : label,
          endpointId: endpoint.id,
          endpointName: endpoint.name || '',
          baseUrl: endpoint.baseUrl || '',
          model: endpoint.defaultModel || '',
          messages: (messages ?? []).map(m => ({ role: m.role, content: m.content })),
          rawResponse: result?.rawResponse ?? result?.output ?? '',
          reasoning: result?.reasoning,
          error: result?.error,
          tokensUsed: result?.tokensUsed ?? 0,
          cacheHit: result?.cacheHit ?? false,
          duration: result?.duration ?? duration,
        })
      }

      const startTs = () => Date.now()

      // 从 chat 方法入参提取 messages：chat(messages, signal) 入参是数组本身，
      // chatWithTools(request, ...) 入参是 { messages, ... } 对象 —— 两者形状不同，需兼容。
      const extractMessages = (arg: any): Array<{ role: string; content: string | null }> =>
        Array.isArray(arg) ? arg : (arg?.messages ?? [])

      // 包裹对象：与 AgentClient 同形状，拦截关键方法
      return {
        get agentId() { return agentId },
        get endpoint() { return endpoint },
        chat: async (request: any, signal?: any) => {
          const t0 = startTs()
          let result: any
          try {
            result = await real.chat(request, signal)
          } catch (err: any) {
            record(extractMessages(request), { error: String(err?.message ?? err) }, Date.now() - t0)
            throw err
          }
          record(extractMessages(request), result, Date.now() - t0)
          return result
        },
        chatWithTools: async (request: any, toolExecutor: any, options?: any) => {
          const t0 = startTs()
          let result: any
          try {
            result = await real.chatWithTools(request, toolExecutor, options)
          } catch (err: any) {
            record(extractMessages(request), { error: String(err?.message ?? err) }, Date.now() - t0)
            throw err
          }
          record(extractMessages(request), result, Date.now() - t0)
          return result
        },
        // chatStream 不常用（侧链不走流式），直接透传
        chatStream: (request: any, callbacks: any, signal?: any) => real.chatStream(request, callbacks, signal),
      } as any
    }
  }

  /** 获取（或懒创建）StateManager 实例 */
  private getStateManager() {
    const sm = createStateManager(this.saveId)
    return sm ? {
      commitChatState: async (patches: any[]) => { await sm.commitChatState(patches) },
    } : undefined
  }

  private buildEventHandlers(): OrchestratorEvents {
    return {
      // === Stage 回调 ===
      onAgentStart: (agentId, config) => {
        console.log(`[GamePipeline] Agent 开始: ${agentId}`)
        this.game.updateAgentStatus(agentId)
        // 初始化日志空条目 (等 complete 时补全 messages + result)
        this.game.addAgentLogEntry({
          agentId,
          label: AGENT_LABELS[agentId] ?? agentId,
          endpointId: config.apiEndpointId,
          endpointName: '',  // 暂不解析 endpoint name，后续从 buildEndpoints 传入时再补
          baseUrl: '',
          model: config.model,
          messages: [],
          rawResponse: '',
          tokensUsed: 0,
          cacheHit: false,
          duration: 0,
        })
      },
      onAgentComplete: (result) => {
        this.game.clearAgentStatus(result.agentId, result.error)
        // 补全本轮已启动日志的剩余字段（保留 onAgentStart 写入的占位条目）
        const prev = this.game.agentLog.find(e => e.agentId === result.agentId)
        this.game.addAgentLogEntry({
          agentId: result.agentId,
          label: prev?.label ?? (AGENT_LABELS[result.agentId] ?? result.agentId),
          endpointId: prev?.endpointId ?? '',
          endpointName: prev?.endpointName ?? '',
          baseUrl: prev?.baseUrl ?? '',
          model: prev?.model ?? '',
          messages: result.requestMessages ?? prev?.messages ?? [],
          rawResponse: result.rawResponse,
          reasoning: result.reasoning,
          error: result.error,
          tokensUsed: result.tokensUsed,
          cacheHit: result.cacheHit,
          duration: result.duration,
        })
        this.handleAgentResult(result)
      },
      onAgentError: (agentId, error) => {
        console.error(`[GamePipeline] Agent 错误: ${agentId}`, error)
        this.game.clearAgentStatus(agentId, error)
        // 补充错误日志
        const prev = this.game.agentLog.find(e => e.agentId === agentId)
        this.game.addAgentLogEntry({
          agentId,
          label: prev?.label ?? (AGENT_LABELS[agentId] ?? agentId),
          endpointId: prev?.endpointId ?? '',
          endpointName: prev?.endpointName ?? '',
          baseUrl: prev?.baseUrl ?? '',
          model: prev?.model ?? '',
          messages: prev?.messages ?? [],
          rawResponse: '',
          error,
          tokensUsed: 0,
          cacheHit: false,
          duration: 0,
        })
      },

      // === Marker 回调 ===
      onCombatTrigger: async () => null,  // 跳过战斗
      onCraftGenRequest: async (markers, _varsOutput, ctx) => {
        await this.handleCraftGen(markers, ctx)
      },
      onCharGenRequest: async (markers, _varsOutput, ctx) => {
        await this.handleCharGen(markers, ctx)
      },
      onItemGenRequest: async (markers, _varsOutput, ctx) => {
        await this.handleItemGen(markers, ctx)
      },
    }
  }

  /** 处理单个 Agent 完成 */
  private handleAgentResult(result: AgentResult) {
    switch (result.agentId) {
      case 'story': {
        // rawResponse 直接就是 AI 返回的字符串正文（流式模式下也是完整文本）
        if (result.rawResponse) {
          this.game.addMessage(result.rawResponse, 'assistant')
        }
        break
      }
      case 'vars_update': {
        // 从 request_dispatcher 输出或 story 输出中提取 <option> 标签
        // vars_update 本身输出的是 JSON Patch，不包含 options
        break
      }
    }
  }

  /** 处理制作生成链 */
  private async handleCraftGen(
    markers: CraftGenRequestMarker[],
    ctx: AgentContext,
  ) {
    const endpoint = this.getDefaultEndpoint()
    if (!endpoint) {
      console.warn('[GamePipeline] craft_gen 跳过: 未配置 API endpoint')
      return
    }

    try {
      const { runCraftGenChain } = await import('@engine/craft-gen-chain')
      const clientFactory = this.getClientFactory()
      const stateManager = this.getStateManager()

      for (const marker of markers) {
        const request = {
          saveId: this.saveId,
          marker,
          storyOutput: ctx.agentOutputs?.get('story') ?? '',
          context: ctx,
          endpoint,
        } as any
        const result = await runCraftGenChain(request, {
          clientFactory,
          stateManager,
        })
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
    const endpoint = this.getDefaultEndpoint()
    if (!endpoint) {
      console.warn('[GamePipeline] char_gen 跳过: 未配置 API endpoint')
      return
    }

    try {
      const { runCharGenChain } = await import('@engine/char-gen-agent')
      const clientFactory = this.getClientFactory()
      const stateManager = this.getStateManager()

      for (const marker of markers) {
        const charGenRequest = {
          saveId: this.saveId,
          marker,
          context: ctx,
          endpoint,
        } as any
        const result = await runCharGenChain(charGenRequest, {
          clientFactory,
          stateManager,
        })
        if (result.character) {
          // 添加新角色到 store
          this.game.characters.push(result.character)
          // 添加系统通知（非 assistant 叙事气泡）
          this.game.addSystemMessage({
            type: 'char_gen',
            characterName: result.character.name,
            race: result.character.race,
            tier: result.character.tier,
            narrative: result.narrativeSummary,
            details: result.character as any,
          })
        }
      }
    } catch (err) {
      console.error('[GamePipeline] char_gen 链失败:', err)
    }
  }

  /** 处理独立物品生成链 (request_dispatcher 的 <item_gen_request>) */
  private async handleItemGen(
    markers: import('@engine/types').ItemGenRequestMarker[],
    ctx: AgentContext,
  ) {
    const endpoint = this.getDefaultEndpoint()
    if (!endpoint) {
      console.warn('[GamePipeline] item_gen 跳过: 未配置 API endpoint')
      return
    }

    try {
      const { runItemGenChain } = await import('@engine/item-gen-chain')
      const clientFactory = this.getClientFactory()
      const stateManager = this.getStateManager()
      const storyOutput = ctx.agentOutputs?.get('story') ?? ''

      for (const marker of markers) {
        const request = {
          saveId: this.saveId,
          marker,
          storyOutput,
          context: ctx,
          endpoint,
        }
        const result = await runItemGenChain(request, {
          clientFactory,
          stateManager,
        })
        // 生成结果暂不回注正文（物品数据已落库，前端面板会刷新显示）
        void result
      }
    } catch (err) {
      console.error('[GamePipeline] item_gen 链失败:', err)
    }
  }
}
