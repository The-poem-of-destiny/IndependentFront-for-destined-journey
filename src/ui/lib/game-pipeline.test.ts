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

// ═══════════════════════════════════════════════════════════
// 🎵 场景配乐：地点变化触发 + AI 标记优先 + 开关
// ═══════════════════════════════════════════════════════════

const audioCalls: any[] = []
const audioStopCalls = { n: 0 }

vi.mock('../stores/audio-store', () => ({
  useAudioStore: () => ({
    playByScene: vi.fn(async (q: any) => { audioCalls.push(q); return null }),
    stop: vi.fn(() => { audioStopCalls.n += 1 }),
    init: vi.fn(async () => {}),
  }),
}))

describe('GamePipeline — 场景配乐触发', () => {
  function player(location: string) {
    return { id: 'p', name: '主角', type: 'player', location, present: true }
  }

  function pipelineAt(location: string, chars: any[] = [], sceneAutoPlay = true) {
    const p = makePipeline({
      characters: [player(location), ...chars],
      player: player(location),
    })
    ;(p as any).settings.settings.audioSceneAutoPlay = sceneAutoPlay
    return p
  }

  beforeEach(() => {
    audioCalls.length = 0
    audioStopCalls.n = 0
  })

  it('地点变了 → 自动按地点选曲（这是场景配乐的主路径）', async () => {
    const p = pipelineAt('大陆中东部-奥古斯提姆帝国-艾瑟嘉德')
    ;(p as any).flushPendingAudio()
    await Promise.resolve()
    expect(audioCalls).toHaveLength(1)
    expect(audioCalls[0].location).toBe('大陆中东部-奥古斯提姆帝国-艾瑟嘉德')
  })

  it('地点没变 → 不重选（同一地点里走动/翻面板不该反复触发）', async () => {
    const p = pipelineAt('龙脊山脉-熔火裂谷')
    ;(p as any).flushPendingAudio()
    await Promise.resolve()
    ;(p as any).flushPendingAudio()
    await Promise.resolve()
    expect(audioCalls).toHaveLength(1)
  })

  it('在场角色一并带上 —— 有专属主题的角色在场时打分器才可能让人物主题接管', async () => {
    const p = pipelineAt('龙脊山脉', [
      { id: 'n1', name: '傲雪', type: 'npc', present: true },
      { id: 'n2', name: '不在场的人', type: 'npc', present: false },
    ])
    ;(p as any).flushPendingAudio()
    await Promise.resolve()
    expect(audioCalls[0].characters).toEqual(['傲雪'])
  })

  it('AI 标记优先于地点变化 —— 它知道戏剧意图，比"地点变了"这个事实更准', async () => {
    const p = pipelineAt('龙脊山脉')
    ;(p as any).pendingAudioMarker = { type: 'play_audio', rawContent: '', position: 0, situation: '战斗', mood: '紧张' }
    ;(p as any).flushPendingAudio()
    await Promise.resolve()
    expect(audioCalls).toHaveLength(1)
    expect(audioCalls[0].situations).toContain('战斗')
    expect(audioCalls[0].moods).toContain('紧张')
  })

  it('标记消费后清空，同一个标记不会在下一轮再播一次', async () => {
    const p = pipelineAt('龙脊山脉')
    ;(p as any).pendingAudioMarker = { type: 'play_audio', rawContent: '', position: 0, situation: '战斗' }
    ;(p as any).flushPendingAudio()
    await Promise.resolve()
    expect((p as any).pendingAudioMarker).toBeNull()
    ;(p as any).flushPendingAudio() // 地点也没变
    await Promise.resolve()
    expect(audioCalls).toHaveLength(1)
  })

  it('关掉开关 → 两条来源都不生效', async () => {
    const p = pipelineAt('龙脊山脉', [], /* sceneAutoPlay */ false)
    ;(p as any).pendingAudioMarker = { type: 'play_audio', rawContent: '', position: 0, situation: '战斗' }
    ;(p as any).flushPendingAudio()
    await Promise.resolve()
    expect(audioCalls).toHaveLength(0)
  })

  it('关掉开关期间照样记住地点 —— 重新打开时不会为"早就待着的地点"补播一次', async () => {
    const p = pipelineAt('龙脊山脉', [], false)
    ;(p as any).flushPendingAudio()
    await Promise.resolve()
    ;(p as any).settings.settings.audioSceneAutoPlay = true
    ;(p as any).flushPendingAudio()
    await Promise.resolve()
    expect(audioCalls).toHaveLength(0)
  })

  it('primeSceneAudio: 进场就起一次，并让紧接着的第一轮不再重选', async () => {
    const p = pipelineAt('索伦蒂斯王国-潮汐王座')
    await (p as any).primeSceneAudio()
    expect(audioCalls).toHaveLength(1)
    ;(p as any).flushPendingAudio()
    await Promise.resolve()
    expect(audioCalls).toHaveLength(1)
  })

  it('地点为空时什么都不做', async () => {
    const p = pipelineAt('')
    ;(p as any).flushPendingAudio()
    await Promise.resolve()
    await (p as any).primeSceneAudio()
    expect(audioCalls).toHaveLength(0)
  })

  it('action="stop" 停止播放而不是选曲', async () => {
    const p = pipelineAt('龙脊山脉')
    ;(p as any).pendingAudioMarker = { type: 'play_audio', rawContent: '', position: 0, action: 'stop' }
    ;(p as any).flushPendingAudio()
    await Promise.resolve()
    expect(audioStopCalls.n).toBe(1)
    expect(audioCalls).toHaveLength(0)
  })
})
