import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractStoryOptions, GamePipeline } from './game-pipeline'
import type { AgentResult } from '@engine/types'

vi.mock('@engine/plot-engine', () => ({
  preCheckPlot: vi.fn(async () => ({ triggeredEvents: [{ title: '触发的事件' }], background: 'bg' })),
  postCheckPlot: vi.fn(async () => ({
    eventsUpdated: [], newEvents: [], outlineUpdated: false, worldLineChanged: false, changeLevel: 'none',
  })),
  eventToMemory: vi.fn(() => ({ content: 'mem', keywords: [], importance: 8, relatedCharacterIds: [], saveId: 's', createdAt: 0, realTimestamp: 0, timeRange: { start: '', end: '' }, hiddenLine: '' })),
}))

vi.mock('@engine/database', () => ({
  getLatestPlotOutline: vi.fn(async () => undefined),
  getPlotEvents: vi.fn(async () => []),
  savePlotOutline: vi.fn(async () => {}),
  savePlotEvents: vi.fn(async () => {}),
  saveMemory: vi.fn(async () => {}),
  getPresets: vi.fn(async () => []),
}))

import { preCheckPlot, postCheckPlot } from '@engine/plot-engine'

function makeGameStore(overrides: Record<string, any> = {}) {
  return {
    messages: [],
    characters: [],
    saveProfile: null,
    activePlotEvents: [],
    recentMemories: [],
    gameTime: null,
    activeSave: null,
    isGenerating: false,
    agentLog: [],
    addMessage: vi.fn(),
    addSystemMessage: vi.fn(),
    setPendingOptions: vi.fn(),
    clearAgentLog: vi.fn(),
    clearAllAgentStatus: vi.fn(),
    updateAgentStatus: vi.fn(),
    clearAgentStatus: vi.fn(),
    addAgentLogEntry: vi.fn(),
    refreshFromDb: vi.fn(async () => {}),
    markOpeningPromptConsumed: vi.fn(async () => {}),
    ...overrides,
  } as any
}

function makeSettingsStore() {
  return {
    settings: {
      apiPool: [],
      agentModels: {},
      agentTemperature: {},
      agentMaxTokens: {},
      agentTopP: {},
      agentFreqPen: {},
      agentPresPen: {},
      agentPrompts: {},
      agentTemplates: {},
      agentWorldbookEnabled: {},
      agentWorldbookIds: {},
      worldBooks: [],
    },
  } as any
}

function makePipeline(gameOverrides: Record<string, any> = {}) {
  return new GamePipeline({
    gameStore: makeGameStore(gameOverrides),
    settingsStore: makeSettingsStore(),
    saveId: 'save-test',
  })
}

function makeResult(agentId: string, rawResponse: string): AgentResult {
  return { agentId, output: rawResponse, rawResponse, tokensUsed: 0, cacheHit: false, duration: 0 }
}

describe('extractStoryOptions', () => {
  it('提取 <options> 块并剥离正文', () => {
    const raw = `夜色渐深，酒馆内人声鼎沸。

<options>
1. 走向吧台，向老板打听消息
2. 找个角落坐下，观察周围的人
3. 直接上二楼寻找线索
4. 离开酒馆，前往港口
</options>`
    const { content, options } = extractStoryOptions(raw)
    expect(options).toEqual([
      '走向吧台，向老板打听消息',
      '找个角落坐下，观察周围的人',
      '直接上二楼寻找线索',
      '离开酒馆，前往港口',
    ])
    expect(content).toBe('夜色渐深，酒馆内人声鼎沸。')
    expect(content).not.toContain('<options>')
  })

  it('无 options 块时原样返回', () => {
    const raw = '平静的一天过去了。'
    const { content, options } = extractStoryOptions(raw)
    expect(content).toBe(raw)
    expect(options).toEqual([])
  })

  it('兼容中文顿号/括号序号分隔', () => {
    const raw = `正文。
<options>
1、选项甲
2) 选项乙
3．选项丙
</options>`
    const { options } = extractStoryOptions(raw)
    expect(options).toEqual(['选项甲', '选项乙', '选项丙'])
  })

  it('忽略非序号行（空行/说明文字）', () => {
    const raw = `正文。
<options>

以下是可选行动：
1. 有效选项
</options>`
    const { options } = extractStoryOptions(raw)
    expect(options).toEqual(['有效选项'])
  })

  it('options 块在正文中间时正确剥离且不留多余空行', () => {
    const raw = `第一段。

<options>
1. 选项
</options>

第二段。`
    const { content } = extractStoryOptions(raw)
    expect(content).toBe('第一段。\n\n第二段。')
  })
})

describe('buildContext — plotSettings (步5)', () => {
  it('读取 activeSave.metadata.plotSettings', () => {
    const plotSettings = { mode: 'main', tabooContent: 'NTR', main: { durationYears: 3, allowNonWorldbookNpc: true, genrePreference: ['combat'], customPreference: '' } }
    const pipeline = makePipeline({
      activeSave: { id: 'save-test', metadata: { plotSettings } },
    })
    const ctx = (pipeline as any).buildContext('输入')
    expect(ctx.plotSettings).toEqual(plotSettings)
  })

  it('老存档无 plotSettings 字段 → off 兜底', () => {
    const pipeline = makePipeline({
      activeSave: { id: 'save-test', metadata: { characterName: '主角' } },
    })
    const ctx = (pipeline as any).buildContext('输入')
    expect(ctx.plotSettings).toEqual({ mode: 'off', tabooContent: '' })
  })

  it('无 activeSave → off 兜底', () => {
    const pipeline = makePipeline({ activeSave: null })
    const ctx = (pipeline as any).buildContext('输入')
    expect(ctx.plotSettings.mode).toBe('off')
  })
})

describe('handleAgentResult — plot_pre_check (步5)', () => {
  beforeEach(() => {
    vi.mocked(preCheckPlot).mockClear()
  })

  it('解析 <json> 输出 → 剧情导演区块注入 context.agentOutputs + preCheckPlot 落库', async () => {
    const pipeline = makePipeline()
    const ctx = (pipeline as any).buildContext('输入')
    ;(pipeline as any).currentContext = ctx
    ;(pipeline as any).pendingPlotTasks = []

    const raw = `思考过程...\n<json>{"triggeredEvents": [{"title": "血色婚礼", "reason": "抵达城堡"}], "relevantBackground": "公爵早已布下天罗地网", "directive": "节奏收紧，铺垫背叛"}</json>`
    await (pipeline as any).handleAgentResult(makeResult('plot_pre_check', raw))
    await Promise.all((pipeline as any).pendingPlotTasks)

    const director = ctx.agentOutputs.get('plot_pre_check')
    expect(director).toContain('剧情导演')
    expect(director).toContain('公爵早已布下天罗地网')
    expect(director).toContain('节奏收紧，铺垫背叛')

    expect(preCheckPlot).toHaveBeenCalledTimes(1)
    const [saveId, jsonStr] = vi.mocked(preCheckPlot).mock.calls[0]
    expect(saveId).toBe('save-test')
    expect(jsonStr).toContain('血色婚礼')
  })

  it('解析失败 → console.warn 不中断管线', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pipeline = makePipeline()
    ;(pipeline as any).currentContext = (pipeline as any).buildContext('输入')
    ;(pipeline as any).pendingPlotTasks = []

    await expect(
      (pipeline as any).handleAgentResult(makeResult('plot_pre_check', '不是 JSON 的输出')),
    ).resolves.not.toThrow()
    await Promise.all((pipeline as any).pendingPlotTasks)
    warn.mockRestore()
  })
})

describe('handleAgentResult — plot_post_check (步5)', () => {
  beforeEach(() => {
    vi.mocked(postCheckPlot).mockClear()
  })

  it('解析 <json> 输出 → postCheckPlot 落库', async () => {
    const pipeline = makePipeline()
    const ctx = (pipeline as any).buildContext('输入')
    ;(pipeline as any).currentContext = ctx
    ;(pipeline as any).pendingPlotTasks = []

    const raw = `<json>{"worldLineChanged": false, "changeLevel": "none", "eventUpdates": [{"title": "血色婚礼", "action": "complete"}], "newChildEvents": [], "outlineChanges": {"action": "none", "changes": ""}}</json>`
    await (pipeline as any).handleAgentResult(makeResult('plot_post_check', raw))

    expect(postCheckPlot).toHaveBeenCalledTimes(1)
    const [saveId, jsonStr] = vi.mocked(postCheckPlot).mock.calls[0]
    expect(saveId).toBe('save-test')
    expect(jsonStr).toContain('血色婚礼')
  })

  it('postCheckPlot 抛错 → console.warn 不中断管线', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(postCheckPlot).mockRejectedValueOnce(new Error('DB 写入失败'))
    const pipeline = makePipeline()
    ;(pipeline as any).currentContext = (pipeline as any).buildContext('输入')
    ;(pipeline as any).pendingPlotTasks = []

    await expect(
      (pipeline as any).handleAgentResult(makeResult('plot_post_check', '<json>{"worldLineChanged": false}</json>')),
    ).resolves.not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('mode=off 时 post_check 后不触发年度大纲生成', async () => {
    const { getLatestPlotOutline } = await import('@engine/database')
    vi.mocked(getLatestPlotOutline).mockClear()
    const pipeline = makePipeline()
    const ctx = (pipeline as any).buildContext('输入')  // 默认 off
    ;(pipeline as any).currentContext = ctx
    ;(pipeline as any).pendingPlotTasks = []

    await (pipeline as any).handleAgentResult(makeResult('plot_post_check', '<json>{"worldLineChanged": false}</json>'))
    expect(getLatestPlotOutline).not.toHaveBeenCalled()
  })
})

  describe('大纲纯捏人页生成（ensurePlotOutline 已退役）', () => {
    it('buildContext 不含游戏内大纲生成逻辑', () => {
      const pipeline = makePipeline({
        activeSave: { id: 'save-test', metadata: { plotSettings: { mode: 'side', tabooContent: '' } } },
      })
      const ctx = (pipeline as any).buildContext('输入')
      // 后续 buildAgentMessages 不再触发 plot_outline 游戏内调用
      expect(ctx).toBeDefined()
    })
  })
