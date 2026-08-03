import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractStoryOptions, GamePipeline } from './game-pipeline';
import type { AgentResult } from '@engine/types';

vi.mock('@engine/plot-engine', () => ({
  preCheckPlot: vi.fn(async () => ({
    triggeredEvents: [{ title: '触发的事件' }],
    background: 'bg',
  })),
  postCheckPlot: vi.fn(async () => ({
    eventsUpdated: [],
    newEvents: [],
    outlineUpdated: false,
    worldLineChanged: false,
    changeLevel: 'none',
  })),
  eventToMemory: vi.fn(() => ({
    content: 'mem',
    keywords: [],
    importance: 8,
    relatedCharacterIds: [],
    saveId: 's',
    createdAt: 0,
    realTimestamp: 0,
    timeRange: { start: '', end: '' },
    hiddenLine: '',
  })),
}));

vi.mock('@engine/database', () => ({
  getLatestPlotOutline: vi.fn(async () => undefined),
  getPlotEvents: vi.fn(async () => []),
  savePlotOutline: vi.fn(async () => {}),
  savePlotEvents: vi.fn(async () => {}),
  saveMemory: vi.fn(async () => {}),
  getPresets: vi.fn(async () => []),
}));

// 工坊 P2 (D5): EJS 差量落库走 createStateManager(...).commitChatState —— 拦下来验载荷
const { commitSpy, advanceTurnSpy, toastSpy } = vi.hoisted(() => ({
  commitSpy: vi.fn(async () => ({
    success: true,
    patchesApplied: 0,
    eventsGenerated: [],
    errors: [] as string[],
  })),
  advanceTurnSpy: vi.fn(async () => {}),
  toastSpy: vi.fn(),
}));

vi.mock('@engine/state-manager', () => ({
  createStateManager: vi.fn(() => ({
    commitChatState: commitSpy,
    advanceTurn: advanceTurnSpy,
  })),
}));

vi.mock('../stores/ui-store', () => ({
  useUIStore: () => ({ toast: toastSpy }),
}));

import { preCheckPlot, postCheckPlot } from '@engine/plot-engine';

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
    recordEjsVarsRejection: vi.fn(),
    ...overrides,
  } as any;
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
  } as any;
}

function makePipeline(gameOverrides: Record<string, any> = {}) {
  return new GamePipeline({
    gameStore: makeGameStore(gameOverrides),
    settingsStore: makeSettingsStore(),
    saveId: 'save-test',
  });
}

function makeResult(agentId: string, rawResponse: string): AgentResult {
  return { agentId, output: rawResponse, rawResponse, tokensUsed: 0, cacheHit: false, duration: 0 };
}

describe('extractStoryOptions', () => {
  it('提取 <options> 块并剥离正文', () => {
    const raw = `夜色渐深，酒馆内人声鼎沸。

<options>
1. 走向吧台，向老板打听消息
2. 找个角落坐下，观察周围的人
3. 直接上二楼寻找线索
4. 离开酒馆，前往港口
</options>`;
    const { content, options } = extractStoryOptions(raw);
    expect(options).toEqual([
      '走向吧台，向老板打听消息',
      '找个角落坐下，观察周围的人',
      '直接上二楼寻找线索',
      '离开酒馆，前往港口',
    ]);
    expect(content).toBe('夜色渐深，酒馆内人声鼎沸。');
    expect(content).not.toContain('<options>');
  });

  it('无 options 块时原样返回', () => {
    const raw = '平静的一天过去了。';
    const { content, options } = extractStoryOptions(raw);
    expect(content).toBe(raw);
    expect(options).toEqual([]);
  });

  it('兼容中文顿号/括号序号分隔', () => {
    const raw = `正文。
<options>
1、选项甲
2) 选项乙
3．选项丙
</options>`;
    const { options } = extractStoryOptions(raw);
    expect(options).toEqual(['选项甲', '选项乙', '选项丙']);
  });

  it('忽略非序号行（空行/说明文字）', () => {
    const raw = `正文。
<options>

以下是可选行动：
1. 有效选项
</options>`;
    const { options } = extractStoryOptions(raw);
    expect(options).toEqual(['有效选项']);
  });

  it('options 块在正文中间时正确剥离且不留多余空行', () => {
    const raw = `第一段。

<options>
1. 选项
</options>

第二段。`;
    const { content } = extractStoryOptions(raw);
    expect(content).toBe('第一段。\n\n第二段。');
  });

  it('剥离 <maintext> 包裹标签（2026-08-02 修：正文标签泄漏）', () => {
    const raw = `<maintext>妲丽安轻轻推开门，月光洒进屋内。

她望向窗边。</maintext>

<options>
1. 上前搭话
2. 保持沉默
</options>`;
    const { content } = extractStoryOptions(raw);
    expect(content).not.toContain('<maintext>');
    expect(content).not.toContain('</maintext>');
    expect(content).toContain('妲丽安轻轻推开门');
    expect(content).toContain('她望向窗边');
  });

  it('无 maintext 包裹时原样保留正文', () => {
    const raw = '平静的一天过去了。';
    const { content } = extractStoryOptions(raw);
    expect(content).toBe(raw);
  });

  it('🔴 回归: 未闭合 <maintext>（AI 只写开标签）也要剥离', () => {
    // 真机 2026-08-02: 模型输出只有 `<maintext>` 开头、无 `</maintext>` 闭合，
    // 旧正则要求闭合标签才匹配 → 标签原样漏进 message。
    const raw = `<maintext>寒冷先于意识抵达。

你睁开眼睛。

奥利雅思("这个世界到底是什么地方？")

<dalian name="妲丽安" mood="思考"> 阿斯塔利亚。 </dalian></maintext>`;
    const { content } = extractStoryOptions(raw);
    expect(content).not.toContain('<maintext>');
    expect(content).not.toContain('</maintext>');
    expect(content).toContain('寒冷先于意识抵达');
    expect(content).toContain('你睁开眼睛');
  });

  it('未闭合 maintext + 带 <options> 时正文剥干净、选项独立提取', () => {
    const raw = `<maintext>正文第一句。

有人来了。

\`\`\`

<options>
1. 上前查看
2. 保持距离
</options>`;
    const { content, options } = extractStoryOptions(raw);
    expect(content).not.toContain('<maintext>');
    expect(content).not.toContain('<options>');
    expect(options).toEqual(['上前查看', '保持距离']);
    expect(content).toContain('正文第一句');
  });
});

describe('buildContext — plotSettings (步5)', () => {
  it('当前输入只进入 userInput，不混入既有历史', () => {
    const pipeline = makePipeline({
      messages: [
        { id: 'u1', role: 'user', content: '上一轮输入', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: '上一轮正文', timestamp: 2 },
      ],
    });

    const ctx = (pipeline as any).buildContext('当前输入');

    expect(ctx.userInput).toBe('当前输入');
    expect(ctx.history.map((message: { content: string }) => message.content)).toEqual([
      '上一轮输入',
      '上一轮正文',
    ]);
  });

  it('读取 activeSave.metadata.plotSettings', () => {
    const plotSettings = {
      mode: 'main',
      tabooContent: 'NTR',
      main: {
        durationYears: 3,
        allowNonWorldbookNpc: true,
        genrePreference: ['combat'],
        customPreference: '',
      },
    };
    const pipeline = makePipeline({
      activeSave: { id: 'save-test', metadata: { plotSettings } },
    });
    const ctx = (pipeline as any).buildContext('输入');
    expect(ctx.plotSettings).toEqual(plotSettings);
  });

  it('老存档无 plotSettings 字段 → off 兜底', () => {
    const pipeline = makePipeline({
      activeSave: { id: 'save-test', metadata: { characterName: '主角' } },
    });
    const ctx = (pipeline as any).buildContext('输入');
    expect(ctx.plotSettings).toEqual({ mode: 'off', tabooContent: '' });
  });

  it('无 activeSave → off 兜底', () => {
    const pipeline = makePipeline({ activeSave: null });
    const ctx = (pipeline as any).buildContext('输入');
    expect(ctx.plotSettings.mode).toBe('off');
  });
});

describe('buildAgentConfigs — story 流式投影', () => {
  it('回调接收累计的玩家可见正文，不暴露结构标签', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pipeline = makePipeline();
    (pipeline as any).settings.settings.apiPool = [
      {
        id: 'ep',
        name: 'test',
        provider: 'openai',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test',
        defaultModel: 'model',
      },
    ];
    const chunks: Array<[string, boolean]> = [];
    const configs = (pipeline as any).buildAgentConfigs({}, (text: string, complete: boolean) =>
      chunks.push([text, complete]),
    );
    const stream = configs.find(
      (config: { agentId: string }) => config.agentId === 'story',
    ).streamCallbacks;

    stream.onChunk('<main', false);
    stream.onChunk('text>夜色渐深', false);
    stream.onChunk('</maintext><options>\n1. 前进', false);
    stream.onChunk('<maintext>夜色渐深</maintext><options>\n1. 前进', true);
    stream.onError('断流');

    expect(chunks).toEqual([
      ['', false],
      ['夜色渐深', false],
      ['夜色渐深', false],
      ['', true],
      ['', true],
    ]);
    warn.mockRestore();
  });
});

describe('handleAgentResult — story 正文投影', () => {
  it('持久化正文与选项，但不持久化控制区块和音频标记', async () => {
    const addMessage = vi.fn();
    const setPendingOptions = vi.fn();
    const pipeline = makePipeline({ addMessage, setPendingOptions });
    const raw = `<thinking>隐藏分析</thinking>
<maintext>夜色渐深。<play_audio mood="安静"/></maintext>
<options>
1. 前进
2. 等待
</options>`;

    await (pipeline as any).handleAgentResult(makeResult('story', raw));

    expect(setPendingOptions).toHaveBeenCalledWith(['前进', '等待']);
    expect(addMessage).toHaveBeenCalledWith('夜色渐深。', 'assistant');
  });

  it('rejects a nonblank envelope with no player-visible narrative', async () => {
    const addMessage = vi.fn();
    const pipeline = makePipeline({ addMessage });

    await expect(
      (pipeline as any).handleAgentResult(
        makeResult('story', '<maintext>   </maintext><options>1. 等待</options>'),
      ),
    ).rejects.toThrow('no player-visible narrative');
    expect(addMessage).not.toHaveBeenCalled();
  });
});

describe('buildContext — EJS 两轴注入 (工坊 P2 / ADR-30)', () => {
  const player = {
    id: 'c1',
    type: 'player',
    name: '主角',
    hp: 80,
    maxHp: 100,
    mp: 10,
    maxMp: 20,
    sp: 5,
    maxSp: 10,
    level: 3,
    tierName: '普通',
    totalExp: 120,
    expToNext: 300,
    freeAttrPoints: 2,
    attributes: { str: 10, dex: 9, con: 8, int: 7, spi: 6 },
  } as any;

  it('注入 statData（读 saveProfile 的 gameTime/fp）', () => {
    const pipeline = makePipeline({
      characters: [player],
      saveProfile: {
        fp: 7,
        gameTime: { year: 1, month: 5, day: 24, hour: 15, minute: 30 },
        variables: { sys: {} },
      },
    });
    const ctx = (pipeline as any).buildContext('输入');
    expect(ctx.statData.主角.生命值).toBe(80);
    expect(ctx.statData.主角.属性.力量).toBe(10);
    expect(ctx.statData.命运点数).toBe(7);
    expect(ctx.statData.世界.时间).toBeTruthy();
  });

  it('statData 是孤儿深拷贝 —— 改它不脏 store 里的角色', () => {
    const pipeline = makePipeline({ characters: [player], saveProfile: null });
    const ctx = (pipeline as any).buildContext('输入');
    ctx.statData.主角.生命值 = 1;
    expect(player.hp).toBe(80);
  });

  it('注入空的 ejsVarsDrafts 容器（供持权 Agent 的 pass 登记草稿）', () => {
    const pipeline = makePipeline({ characters: [], saveProfile: null });
    const ctx = (pipeline as any).buildContext('输入');
    expect(ctx.ejsVarsDrafts).toBeInstanceOf(Map);
    expect(ctx.ejsVarsDrafts.size).toBe(0);
  });
});

describe('handleAgentResult — plot_pre_check (步5)', () => {
  beforeEach(() => {
    vi.mocked(preCheckPlot).mockClear();
  });

  it('解析 <json> 输出 → 剧情导演区块注入 context.agentOutputs + preCheckPlot 落库', async () => {
    const pipeline = makePipeline();
    const ctx = (pipeline as any).buildContext('输入');
    (pipeline as any).currentContext = ctx;
    (pipeline as any).pendingPlotTasks = [];

    const raw = `思考过程...\n<json>{"triggeredEvents": [{"title": "血色婚礼", "reason": "抵达城堡"}], "relevantBackground": "公爵早已布下天罗地网", "directive": "节奏收紧，铺垫背叛"}</json>`;
    await (pipeline as any).handleAgentResult(makeResult('plot_pre_check', raw));
    await Promise.all((pipeline as any).pendingPlotTasks);

    const director = ctx.agentOutputs.get('plot_pre_check');
    expect(director).toContain('剧情导演');
    expect(director).toContain('公爵早已布下天罗地网');
    expect(director).toContain('节奏收紧，铺垫背叛');

    expect(preCheckPlot).toHaveBeenCalledTimes(1);
    const [saveId, jsonStr] = vi.mocked(preCheckPlot).mock.calls[0];
    expect(saveId).toBe('save-test');
    expect(jsonStr).toContain('血色婚礼');
  });

  it('解析失败 → console.warn 不中断管线', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pipeline = makePipeline();
    (pipeline as any).currentContext = (pipeline as any).buildContext('输入');
    (pipeline as any).pendingPlotTasks = [];

    await expect(
      (pipeline as any).handleAgentResult(makeResult('plot_pre_check', '不是 JSON 的输出')),
    ).resolves.not.toThrow();
    await Promise.all((pipeline as any).pendingPlotTasks);
    warn.mockRestore();
  });
});

describe('handleAgentResult — plot_post_check (步5)', () => {
  beforeEach(() => {
    vi.mocked(postCheckPlot).mockClear();
  });

  it('解析 <json> 输出 → postCheckPlot 落库', async () => {
    const pipeline = makePipeline();
    const ctx = (pipeline as any).buildContext('输入');
    (pipeline as any).currentContext = ctx;
    (pipeline as any).pendingPlotTasks = [];

    const raw = `<json>{"worldLineChanged": false, "changeLevel": "none", "eventUpdates": [{"title": "血色婚礼", "action": "complete"}], "newChildEvents": [], "outlineChanges": {"action": "none", "changes": ""}}</json>`;
    await (pipeline as any).handleAgentResult(makeResult('plot_post_check', raw));

    expect(postCheckPlot).toHaveBeenCalledTimes(1);
    const [saveId, jsonStr] = vi.mocked(postCheckPlot).mock.calls[0];
    expect(saveId).toBe('save-test');
    expect(jsonStr).toContain('血色婚礼');
  });

  it('postCheckPlot 抛错 → console.warn 不中断管线', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(postCheckPlot).mockRejectedValueOnce(new Error('DB 写入失败'));
    const pipeline = makePipeline();
    (pipeline as any).currentContext = (pipeline as any).buildContext('输入');
    (pipeline as any).pendingPlotTasks = [];

    await expect(
      (pipeline as any).handleAgentResult(
        makeResult('plot_post_check', '<json>{"worldLineChanged": false}</json>'),
      ),
    ).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('mode=off 时 post_check 后不触发年度大纲生成', async () => {
    const { getLatestPlotOutline } = await import('@engine/database');
    vi.mocked(getLatestPlotOutline).mockClear();
    const pipeline = makePipeline();
    const ctx = (pipeline as any).buildContext('输入'); // 默认 off
    (pipeline as any).currentContext = ctx;
    (pipeline as any).pendingPlotTasks = [];

    await (pipeline as any).handleAgentResult(
      makeResult('plot_post_check', '<json>{"worldLineChanged": false}</json>'),
    );
    expect(getLatestPlotOutline).not.toHaveBeenCalled();
  });
});

describe('大纲纯捏人页生成（ensurePlotOutline 已退役）', () => {
  it('buildContext 不含游戏内大纲生成逻辑', () => {
    const pipeline = makePipeline({
      activeSave: {
        id: 'save-test',
        metadata: { plotSettings: { mode: 'side', tabooContent: '' } },
      },
    });
    const ctx = (pipeline as any).buildContext('输入');
    // 后续 buildAgentMessages 不再触发 plot_outline 游戏内调用
    expect(ctx).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 🎵 场景配乐：地点变化触发 + AI 标记优先 + 开关
// ═══════════════════════════════════════════════════════════

const audioCalls: any[] = [];
const audioStopCalls = { n: 0 };

vi.mock('../stores/audio-store', () => ({
  useAudioStore: () => ({
    playByScene: vi.fn(async (q: any) => {
      audioCalls.push(q);
      return null;
    }),
    stop: vi.fn(() => {
      audioStopCalls.n += 1;
    }),
    init: vi.fn(async () => {}),
  }),
}));

describe('GamePipeline — 场景配乐触发', () => {
  function player(location: string) {
    return { id: 'p', name: '主角', type: 'player', location, present: true };
  }

  function pipelineAt(location: string, chars: any[] = [], sceneAutoPlay = true) {
    const p = makePipeline({
      characters: [player(location), ...chars],
      player: player(location),
    });
    (p as any).settings.settings.audioSceneAutoPlay = sceneAutoPlay;
    return p;
  }

  beforeEach(() => {
    audioCalls.length = 0;
    audioStopCalls.n = 0;
  });

  it('地点变了 → 自动按地点选曲（这是场景配乐的主路径）', async () => {
    const p = pipelineAt('大陆中东部-奥古斯提姆帝国-艾瑟嘉德');
    (p as any).flushPendingAudio();
    await Promise.resolve();
    expect(audioCalls).toHaveLength(1);
    expect(audioCalls[0].location).toBe('大陆中东部-奥古斯提姆帝国-艾瑟嘉德');
  });

  it('地点没变 → 不重选（同一地点里走动/翻面板不该反复触发）', async () => {
    const p = pipelineAt('龙脊山脉-熔火裂谷');
    (p as any).flushPendingAudio();
    await Promise.resolve();
    (p as any).flushPendingAudio();
    await Promise.resolve();
    expect(audioCalls).toHaveLength(1);
  });

  it('在场角色一并带上 —— 有专属主题的角色在场时打分器才可能让人物主题接管', async () => {
    const p = pipelineAt('龙脊山脉', [
      { id: 'n1', name: '傲雪', type: 'npc', present: true },
      { id: 'n2', name: '不在场的人', type: 'npc', present: false },
    ]);
    (p as any).flushPendingAudio();
    await Promise.resolve();
    expect(audioCalls[0].characters).toEqual(['傲雪']);
  });

  it('AI 标记优先于地点变化 —— 它知道戏剧意图，比"地点变了"这个事实更准', async () => {
    const p = pipelineAt('龙脊山脉');
    (p as any).pendingAudioMarker = {
      type: 'play_audio',
      rawContent: '',
      position: 0,
      situation: '战斗',
      mood: '紧张',
    };
    (p as any).flushPendingAudio();
    await Promise.resolve();
    expect(audioCalls).toHaveLength(1);
    expect(audioCalls[0].situations).toContain('战斗');
    expect(audioCalls[0].moods).toContain('紧张');
  });

  it('标记消费后清空，同一个标记不会在下一轮再播一次', async () => {
    const p = pipelineAt('龙脊山脉');
    (p as any).pendingAudioMarker = {
      type: 'play_audio',
      rawContent: '',
      position: 0,
      situation: '战斗',
    };
    (p as any).flushPendingAudio();
    await Promise.resolve();
    expect((p as any).pendingAudioMarker).toBeNull();
    (p as any).flushPendingAudio(); // 地点也没变
    await Promise.resolve();
    expect(audioCalls).toHaveLength(1);
  });

  it('关掉开关 → 两条来源都不生效', async () => {
    const p = pipelineAt('龙脊山脉', [], /* sceneAutoPlay */ false);
    (p as any).pendingAudioMarker = {
      type: 'play_audio',
      rawContent: '',
      position: 0,
      situation: '战斗',
    };
    (p as any).flushPendingAudio();
    await Promise.resolve();
    expect(audioCalls).toHaveLength(0);
  });

  it('关掉开关期间照样记住地点 —— 重新打开时不会为"早就待着的地点"补播一次', async () => {
    const p = pipelineAt('龙脊山脉', [], false);
    (p as any).flushPendingAudio();
    await Promise.resolve();
    (p as any).settings.settings.audioSceneAutoPlay = true;
    (p as any).flushPendingAudio();
    await Promise.resolve();
    expect(audioCalls).toHaveLength(0);
  });

  it('primeSceneAudio: 进场就起一次，并让紧接着的第一轮不再重选', async () => {
    const p = pipelineAt('索伦蒂斯王国-潮汐王座');
    await (p as any).primeSceneAudio();
    expect(audioCalls).toHaveLength(1);
    (p as any).flushPendingAudio();
    await Promise.resolve();
    expect(audioCalls).toHaveLength(1);
  });

  it('地点为空时什么都不做', async () => {
    const p = pipelineAt('');
    (p as any).flushPendingAudio();
    await Promise.resolve();
    await (p as any).primeSceneAudio();
    expect(audioCalls).toHaveLength(0);
  });

  it('action="stop" 停止播放而不是选曲', async () => {
    const p = pipelineAt('龙脊山脉');
    (p as any).pendingAudioMarker = {
      type: 'play_audio',
      rawContent: '',
      position: 0,
      action: 'stop',
    };
    (p as any).flushPendingAudio();
    await Promise.resolve();
    expect(audioStopCalls.n).toBe(1);
    expect(audioCalls).toHaveLength(0);
  });
});

// ============================================================================
// 工坊 P2 (ADR-30 D5) — EJS vars 差量提交 + 体积护栏
// ============================================================================

describe('flushEjsVarsDiffs — EJS vars 差量提交 (工坊 P2 / D5)', () => {
  type Draft = { base: Record<string, any>; draft: Record<string, any> };

  /** 造一个已备好 currentContext + 草稿表的管线 */
  function primed(drafts: Record<string, Draft>, gameOverrides: Record<string, any> = {}) {
    const pipeline = makePipeline(gameOverrides);
    const ctx = (pipeline as any).buildContext('输入');
    for (const [agentId, entry] of Object.entries(drafts)) {
      ctx.ejsVarsDrafts.set(agentId, entry);
    }
    (pipeline as any).currentContext = ctx;
    return pipeline;
  }

  /** 最近一次 commitChatState 的 ejsVarsDiffs 载荷 */
  function lastDiffs() {
    const call = commitSpy.mock.calls[commitSpy.mock.calls.length - 1] as any[];
    return call[1].ejsVarsDiffs;
  }

  beforeEach(() => {
    commitSpy.mockClear();
    toastSpy.mockClear();
  });

  it('有写入 → 差量随 commitChatState 落库（patches 为空，只带 ejsVarsDiffs）', async () => {
    const pipeline = primed({
      story: { base: { 计数器: 1 }, draft: { 计数器: 2, 新键: '值' } },
    });
    await (pipeline as any).flushEjsVarsDiffs(['story']);

    expect(commitSpy).toHaveBeenCalledTimes(1);
    const [patches, options] = commitSpy.mock.calls[0] as any[];
    expect(patches).toEqual([]);
    expect(options.ejsVarsDiffs).toHaveLength(1);
    // 路径带 sys. 前缀（diffVars 契约）
    expect(options.ejsVarsDiffs[0].replace).toEqual(
      expect.arrayContaining([
        { path: 'sys.计数器', value: 2 },
        { path: 'sys.新键', value: '值' },
      ]),
    );
  });

  it('删除也进差量（base 有 draft 无 → remove）', async () => {
    const pipeline = primed({ story: { base: { 旧键: 1 }, draft: {} } });
    await (pipeline as any).flushEjsVarsDiffs(['story']);
    expect(lastDiffs()[0].remove).toEqual([{ path: 'sys.旧键' }]);
  });

  it('空 diff 不传 —— 没写过就根本不调 commitChatState', async () => {
    const pipeline = primed({ story: { base: { a: 1 }, draft: { a: 1 } } });
    await (pipeline as any).flushEjsVarsDiffs(['story']);
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it('没有草稿表 / 本 stage 无持权 Agent → 静默跳过', async () => {
    const bare = makePipeline();
    await (bare as any).flushEjsVarsDiffs(['story']);
    expect(commitSpy).not.toHaveBeenCalled();

    const pipeline = primed({ story: { base: {}, draft: { a: 1 } } });
    await (pipeline as any).flushEjsVarsDiffs(['vars_update']);
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it('同阶段多个持权 Agent 按 agentId 字典序 —— 后者同路径覆盖前者', async () => {
    const pipeline = primed({
      story: { base: {}, draft: { 标记: '来自 story' } },
      alpha: { base: {}, draft: { 标记: '来自 alpha' } },
    });
    // 传入顺序刻意反着写，验证排序不看调用方顺序
    await (pipeline as any).flushEjsVarsDiffs(['story', 'alpha']);

    const diffs = lastDiffs();
    expect(diffs).toHaveLength(2);
    expect(diffs[0].replace[0].value).toBe('来自 alpha'); // a < s
    expect(diffs[1].replace[0].value).toBe('来自 story');
  });

  it('消费即摘表 —— 同一份草稿不会被后续 stage 重复提交', async () => {
    const pipeline = primed({ story: { base: {}, draft: { a: 1 } } });
    await (pipeline as any).flushEjsVarsDiffs(['story']);
    await (pipeline as any).flushEjsVarsDiffs(['story']);
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect((pipeline as any).currentContext.ejsVarsDrafts.size).toBe(0);
  });

  it('落库抛错不外溢（簿记旁路不该吞掉本轮正文）', async () => {
    commitSpy.mockRejectedValueOnce(new Error('DB 炸了') as never);
    const pipeline = primed({ story: { base: {}, draft: { a: 1 } } });
    await expect((pipeline as any).flushEjsVarsDiffs(['story'])).resolves.toBeUndefined();
  });

  // ===== 体积护栏 =====

  it('超上限 → 整份拒绝：不落库 + toast + 诊断计数', async () => {
    const record = vi.fn();
    const huge = 'x'.repeat(300 * 1024); // > EJS_DIFF_SIZE_LIMIT (256 KB)
    const pipeline = primed(
      { story: { base: {}, draft: { 巨块: huge } } },
      { recordEjsVarsRejection: record },
    );
    await (pipeline as any).flushEjsVarsDiffs(['story']);

    expect(commitSpy).not.toHaveBeenCalled(); // 不截断、不部分提交
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toBe('story');
    expect(record.mock.calls[0][2]).toBeGreaterThan(256 * 1024);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(String(toastSpy.mock.calls[0][0])).toContain('叙事生成'); // 文案点名来源
  });

  it('同来源第二次超限：诊断计数照记，toast 不再弹（每存档每来源一次）', async () => {
    const record = vi.fn();
    const huge = 'x'.repeat(300 * 1024);
    const pipeline = primed(
      { story: { base: {}, draft: { 巨块: huge } } },
      { recordEjsVarsRejection: record },
    );
    await (pipeline as any).flushEjsVarsDiffs(['story']);
    // 第二轮：同一来源再超一次
    (pipeline as any).currentContext.ejsVarsDrafts.set('story', {
      base: {},
      draft: { 巨块: huge },
    });
    await (pipeline as any).flushEjsVarsDiffs(['story']);

    expect(record).toHaveBeenCalledTimes(2);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it('一份超限不牵连同批的另一份（逐份判定）', async () => {
    const huge = 'x'.repeat(300 * 1024);
    const pipeline = primed({
      alpha: { base: {}, draft: { 巨块: huge } },
      story: { base: {}, draft: { 小键: 1 } },
    });
    await (pipeline as any).flushEjsVarsDiffs(['alpha', 'story']);

    expect(commitSpy).toHaveBeenCalledTimes(1);
    const diffs = lastDiffs();
    expect(diffs).toHaveLength(1);
    expect(diffs[0].replace).toEqual([{ path: 'sys.小键', value: 1 }]);
  });
});
