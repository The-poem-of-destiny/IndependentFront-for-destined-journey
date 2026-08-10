import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  collectSelectedSystemCoreWorkshopBookIds,
  extractStoryOptions,
  GamePipeline,
  withImagePromptSystem,
} from './game-pipeline';
import type { AgentConfig } from '@engine/types';
import { patchAgentSettings } from '../stores/agent-settings';
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
const { commitSpy, advanceTurnSpy, toastSpy, createSnapshotSpy, runCombatV3Mock } = vi.hoisted(
  () => ({
    commitSpy: vi.fn(async () => ({
      success: true,
      patchesApplied: 0,
      eventsGenerated: [],
      errors: [] as string[],
    })),
    advanceTurnSpy: vi.fn(async () => {}),
    createSnapshotSpy: vi.fn(
      async () => ({ id: 'snap-pre-combat', reason: 'pre-combat', turn: 0 }) as any,
    ),
    toastSpy: vi.fn(),
    runCombatV3Mock: vi.fn(),
  }),
);

vi.mock('@engine/state-manager', () => ({
  createStateManager: vi.fn(() => ({
    commitChatState: commitSpy,
    advanceTurn: advanceTurnSpy,
    createSnapshot: createSnapshotSpy,
  })),
}));

// T16：handleCombatTriggerV3 的动态 import('@engine/combat-v3') 被替换为可编排的 fake ——
// 断言 setCombatCoordinator 在 runCombatV3 **之前**挂好（玩家首决策挂起的根因修复）。
vi.mock('@engine/combat-v3', () => ({
  runCombatV3: runCombatV3Mock,
}));

vi.mock('../stores/ui-store', () => ({
  useUIStore: () => ({ toast: toastSpy }),
}));

// 🖼 情景插画：三档分流只关心「有没有把标记喂给 store.generate」，store 本身另有测试
const { sceneImageStore } = vi.hoisted(() => ({
  sceneImageStore: {
    activeSaveId: 'save-test' as string | null,
    generate: vi.fn(async (_input: unknown) => ({ ok: true, id: 'simg_1' }) as any),
  },
}));

vi.mock('../stores/scene-image-store', () => ({
  useSceneImageStore: () => sceneImageStore,
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
    // 真 store 的 addMessage 会把落库的那条消息交回来（情景插画要它的 id/turn，D2）
    addMessage: vi.fn((content: string, role: string) => ({
      id: 'msg_stub',
      role,
      content,
      timestamp: 0,
      turn: 1,
    })),
    addSystemMessage: vi.fn(),
    setPendingOptions: vi.fn(),
    clearAgentLog: vi.fn(),
    clearAllAgentStatus: vi.fn(),
    updateAgentStatus: vi.fn(),
    clearAgentStatus: vi.fn(),
    addAgentLogEntry: vi.fn(),
    refreshFromDb: vi.fn(async () => {}),
    markOpeningPromptConsumed: vi.fn(async () => true),
    releaseOpeningPromptClaim: vi.fn(async () => true),
    recordEjsVarsRejection: vi.fn(),
    ...overrides,
  } as any;
}

function makeSettingsStore(settingsOverrides: Record<string, any> = {}) {
  return {
    settings: {
      apiPool: [],
      // 图像生成三档开关。默认 `'manual'` 与 `getDefaults()` 一致 —— 桩里写 `'auto'`
      // 会让每条测试用例都悄悄走上花钱那条路
      imageGenMode: 'manual',
      imageMaxRating: 'general',
      // Q-18: per-Agent 设置合并成一张 `agents` 表（此前是 10 张并行 map，
      // 而且这份桩少列了 agentDirty / agentHistoryLayers / agentHistorySlice ——
      // 那正是「加一张 map 要改七处」的代价）
      agents: {},
      ...settingsOverrides,
    },
  } as any;
}

function makePipeline(
  gameOverrides: Record<string, any> = {},
  settingsOverrides: Record<string, any> = {},
) {
  return new GamePipeline({
    gameStore: makeGameStore(gameOverrides),
    settingsStore: makeSettingsStore(settingsOverrides),
    saveId: 'save-test',
  });
}

function makeResult(agentId: string, rawResponse: string): AgentResult {
  return { agentId, output: rawResponse, rawResponse, tokensUsed: 0, cacheHit: false, duration: 0 };
}

describe('sendOpeningPrompt', () => {
  it('two pipeline instances sharing one save generate the opening only once', async () => {
    let consumed = false;
    const gameStore = makeGameStore({
      openingPrompt: 'OPENING',
      markOpeningPromptConsumed: vi.fn(async () => {
        if (consumed) return false;
        consumed = true;
        return true;
      }),
    });
    const options = {
      gameStore,
      settingsStore: makeSettingsStore(),
      saveId: 'save-test',
    };
    const first = new GamePipeline(options);
    const second = new GamePipeline(options);
    const firstRun = vi.spyOn(first, 'run').mockResolvedValue(true);
    const secondRun = vi.spyOn(second, 'run').mockResolvedValue(true);

    await Promise.all([first.sendOpeningPrompt(), second.sendOpeningPrompt()]);

    expect(firstRun.mock.calls.length + secondRun.mock.calls.length).toBe(1);
    expect(gameStore.markOpeningPromptConsumed).toHaveBeenCalledTimes(2);
  });

  it('releases the claim when the run produced no narrative at all', async () => {
    // API 一次抽风不该把开场永久烧掉 —— 玩家会拿到一个只有自己那句话、没法重来的存档。
    const gameStore = makeGameStore({ openingPrompt: 'OPENING' });
    const pipeline = new GamePipeline({
      gameStore,
      settingsStore: makeSettingsStore(),
      saveId: 'save-test',
    });
    vi.spyOn(pipeline, 'run').mockImplementation(async () => {
      gameStore.messages.push({ id: 'u1', role: 'user', content: 'OPENING' });
      return false;
    });

    await pipeline.sendOpeningPrompt();

    expect(gameStore.releaseOpeningPromptClaim).toHaveBeenCalledTimes(1);
  });

  it('keeps the claim when narrative already landed, and never re-renders the same user line', async () => {
    // 已经有叙事时重跑会把那段再写一遍；用户消息也已落库，重试不能重复插入。
    const gameStore = makeGameStore({
      openingPrompt: 'OPENING',
      messages: [
        { id: 'u1', role: 'user', content: 'OPENING' },
        { id: 'a1', role: 'assistant', content: '晨光落在石阶上。' },
      ],
    });
    const pipeline = new GamePipeline({
      gameStore,
      settingsStore: makeSettingsStore(),
      saveId: 'save-test',
    });
    const run = vi.spyOn(pipeline, 'run').mockResolvedValue(false);

    await pipeline.sendOpeningPrompt();

    expect(run).toHaveBeenCalledWith('OPENING', undefined, false);
    expect(gameStore.releaseOpeningPromptClaim).not.toHaveBeenCalled();
  });
});

describe('buildAgentConfigs — selected system core visibility', () => {
  it.each([408, 413, 999])(
    'adds system_core to char_gen for any selected system-core entry (uid %s)',
    (uid) => {
      const pipeline = makePipeline({
        activeSave: {
          metadata: { enabledWorldBookEntries: [`system_core:${uid}`] },
        },
      });
      const settings = (pipeline as any).settings.settings;
      patchAgentSettings(settings, 'char_gen', {
        worldBookEnabled: true,
        worldBookIds: ['world_setting', 'race', 'character'],
      });
      patchAgentSettings(settings, 'story', {
        worldBookEnabled: true,
        worldBookIds: ['world_setting'],
      });

      const configs = (pipeline as any).buildAgentConfigs({ char_gen: {} });
      const charGen = configs.find((config: any) => config.agentId === 'char_gen');
      const story = configs.find((config: any) => config.agentId === 'story');

      expect(charGen.worldBookIds).toContain('system_core');
      expect(story.worldBookIds).toContain('system_core');
    },
  );

  it('grants selected system/core workshop books to story and char_gen only', () => {
    const pipeline = makePipeline();
    const settings = (pipeline as any).settings.settings;
    for (const agentId of ['story', 'char_gen', 'request_dispatcher']) {
      patchAgentSettings(settings, agentId, {
        worldBookEnabled: true,
        worldBookIds: ['world_setting'],
      });
    }

    const configs = (pipeline as any).buildAgentConfigs({}, undefined, ['workshop:core-project']);
    const byId = (agentId: string) =>
      configs.find((config: any) => config.agentId === agentId).worldBookIds;

    expect(byId('story')).toContain('workshop:core-project');
    expect(byId('char_gen')).toContain('workshop:core-project');
    expect(byId('request_dispatcher')).not.toContain('workshop:core-project');
  });
});

describe('collectSelectedSystemCoreWorkshopBookIds', () => {
  it('returns only selected, enabled workshop books whose project has the system/core tag', () => {
    const entry = (projectId: string, uid: number, enabled = true) => ({
      uid,
      name: projectId,
      content: projectId,
      enabled,
      key: [],
      keysecondary: [],
      selectiveLogic: 0,
      order: 0,
      position: 0,
      extra: { workshop: { projectId } },
    });
    const books = [
      {
        id: 'workshop:core-project',
        partition: 'creative_workshop',
        entries: [entry('core-project', 100)],
      },
      {
        id: 'workshop:regular-project',
        partition: 'creative_workshop',
        entries: [entry('regular-project', 101)],
      },
      {
        id: 'workshop:disabled-core',
        partition: 'creative_workshop',
        entries: [entry('disabled-core', 102, false)],
      },
    ] as any;
    const projects = [
      { id: 'core-project', tags: ['System/Core'] },
      { id: 'regular-project', tags: ['character'] },
      { id: 'disabled-core', tags: ['system/core'] },
    ] as any;

    expect(collectSelectedSystemCoreWorkshopBookIds(books, projects)).toEqual([
      'workshop:core-project',
    ]);
  });
});

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
    const addMessage = vi.fn((content: string) => ({ id: 'm1', turn: 1, content }));
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
    const addMessage = vi.fn((content: string) => ({ id: 'm1', turn: 1, content }));
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

// ═══════════════════════════════════════════════════════════
// 🖼 方言 systemPrompt 注入（图像 v2 / C3·C5）
// ═══════════════════════════════════════════════════════════

describe('withImagePromptSystem', () => {
  function cfg(over: Partial<AgentConfig> = {}): AgentConfig {
    return {
      agentId: 'image_prompt',
      enabled: true,
      apiEndpointId: 'ep_1',
      model: 'gpt-x',
      temperature: 0.3,
      maxTokens: 4096,
      topP: 0.9,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      retryOnFail: true,
      timeout: 120000,
      userId: 'fp|save|image_prompt',
      promptTemplate: { fixedSystem: '', fixedExamples: '' },
      worldBookIds: ['book_a'],
      systemPrompt: '老的那份',
      ...over,
    };
  }

  it('🔴 只换 systemPrompt，模型与采样旋钮**一格不动**', () => {
    const configs = [cfg({ agentId: 'story', systemPrompt: 'story 的' }), cfg()];
    const out = withImagePromptSystem(configs, '方言写的');

    const image = out.find((c) => c.agentId === 'image_prompt');
    expect(image?.systemPrompt).toBe('方言写的');
    // 新造一条顶掉原来的，用户在设置页调的模型与采样参数就全部静默回落成缺省
    expect(image?.model).toBe('gpt-x');
    expect(image?.temperature).toBe(0.3);
    expect(image?.maxTokens).toBe(4096);
    expect(image?.topP).toBe(0.9);
    expect(image?.frequencyPenalty).toBe(0.1);
    expect(image?.presencePenalty).toBe(0.2);
    expect(image?.worldBookIds).toEqual(['book_a']);
    // 别人的 config 一个字节不动
    expect(out.find((c) => c.agentId === 'story')?.systemPrompt).toBe('story 的');
    // 原数组不被就地改写（调用方还拿着 chainData 那一份）
    expect(configs[1].systemPrompt).toBe('老的那份');
  });

  it('不传覆盖 = 原样返回（走 agent-config / 模板兜底，即图像 v1 行为）', () => {
    const configs = [cfg()];
    expect(withImagePromptSystem(configs, undefined)[0].systemPrompt).toBe('老的那份');
    expect(withImagePromptSystem(configs, '')[0].systemPrompt).toBe('老的那份');
  });

  it('🔴 只剩空白的覆盖照样当没有 —— 否则整段提示词变成一个空格，且不报错', () => {
    // 设置页今天不再写下这种值（判空前先 trim），但老档里可能躺着一份
    const configs = [cfg()];
    expect(withImagePromptSystem(configs, ' ')[0].systemPrompt).toBe('老的那份');
    expect(withImagePromptSystem(configs, '\n\t ')[0].systemPrompt).toBe('老的那份');
  });

  it('configs 里没有 image_prompt 时补一条（宁可多一条，也不让方言静默失效）', () => {
    const out = withImagePromptSystem([cfg({ agentId: 'story' })], '方言写的');
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ agentId: 'image_prompt', systemPrompt: '方言写的' });
  });
});

// ═══════════════════════════════════════════════════════════
// 🖼 情景插画：三档分流（图像生成 §8 / D15 / D21 / D32 / D48）
// ═══════════════════════════════════════════════════════════

describe('handleSceneImages — 三档分流', () => {
  /** 让管线以为「story 刚产出了这条消息」，即 D15 那个唯一的开火时机 */
  async function primeStory(pipeline: any, narrative: string, mode = 'auto'): Promise<void> {
    pipeline.settings.settings.imageGenMode = mode;
    await pipeline.handleAgentResult(makeResult('story', `<maintext>${narrative}</maintext>`));
  }

  const oneMarker =
    '夜色渐深。<scene_image title="炉火" characters="苏婉">她望着壁炉</scene_image>';

  beforeEach(() => {
    sceneImageStore.activeSaveId = 'save-test';
    sceneImageStore.generate.mockClear();
    sceneImageStore.generate.mockImplementation(async () => ({ ok: true, id: 'simg_1' }));
  });

  it('auto：逐个标记进 store.generate，带上 messageId/turn/occurrence 与剥净的正文', async () => {
    const pipeline: any = makePipeline();
    await primeStory(pipeline, oneMarker);

    await pipeline.handleSceneImages([{ type: 'scene_image' }]);

    expect(sceneImageStore.generate).toHaveBeenCalledTimes(1);
    const input = sceneImageStore.generate.mock.calls[0][0] as any;
    expect(input).toMatchObject({
      saveId: 'save-test',
      messageId: 'msg_stub',
      turn: 1,
      anchorKind: 'marker',
      occurrence: 0,
      source: 'auto',
      title: '炉火',
      characters: ['苏婉'],
      intent: '她望着壁炉',
    });
    // 侧链拿到的是**剥掉全部标记**的正文
    expect(input.narrative).toBe('夜色渐深。');
  });

  it('auto：occurrence 与渲染分段同源 —— 空正文的标记照剥但不占号', async () => {
    const pipeline: any = makePipeline();
    await primeStory(
      pipeline,
      `A<scene_image title="空"></scene_image>B<scene_image title="甲">画面甲</scene_image>` +
        `C<scene_image title="乙">画面乙</scene_image>`,
    );

    await pipeline.handleSceneImages([{ type: 'scene_image' }]);

    const calls = sceneImageStore.generate.mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c) => c.occurrence)).toEqual([0, 1]);
    expect(calls.map((c) => c.title)).toEqual(['甲', '乙']);
  });

  it('manual / off：一次都不建记录（点了才花钱 / 这个子系统不存在）', async () => {
    for (const mode of ['manual', 'off']) {
      sceneImageStore.generate.mockClear();
      const pipeline: any = makePipeline();
      await primeStory(pipeline, oneMarker, mode);
      await pipeline.handleSceneImages([{ type: 'scene_image' }]);
      expect(sceneImageStore.generate).not.toHaveBeenCalled();
    }
  });

  it('🔴 D15：没有「刚产出的那条消息」就绝不开火（历史消息不会走到这里）', async () => {
    const pipeline: any = makePipeline();
    pipeline.settings.settings.imageGenMode = 'auto';

    await pipeline.handleSceneImages([{ type: 'scene_image' }]);

    expect(sceneImageStore.generate).not.toHaveBeenCalled();
  });

  it('🔴 D15：每轮 run() 开头清空上一轮的消息，标记不会挂到隔壁回合去', async () => {
    const pipeline: any = makePipeline();
    await primeStory(pipeline, oneMarker);
    expect(pipeline.lastStoryMessage).not.toBeNull();

    // run() 的重置在 try 内很靠前；这里直接验字段本身的语义
    pipeline.lastStoryMessage = null;
    await pipeline.handleSceneImages([{ type: 'scene_image' }]);
    expect(sceneImageStore.generate).not.toHaveBeenCalled();
  });

  it('🔴 D21：限额拒绝时什么都不做，同一条消息里剩下的标记照样各自判定', async () => {
    sceneImageStore.generate.mockImplementation(async () => ({
      ok: false,
      reason: 'rolling-window',
      message: '已达本小时上限',
    }));
    const pipeline: any = makePipeline();
    await primeStory(
      pipeline,
      `<scene_image title="甲">画面甲</scene_image><scene_image title="乙">画面乙</scene_image>`,
    );

    await expect(pipeline.handleSceneImages([{ type: 'scene_image' }])).resolves.toBeUndefined();
    // 被拒不等于放弃后面那个：每个标记各自过闸门（拒了只是落到「无记录」那一格）
    expect(sceneImageStore.generate).toHaveBeenCalledTimes(2);
  });

  it('一个标记入队抛错不牵连同一条消息里的其它标记', async () => {
    sceneImageStore.generate
      .mockImplementationOnce(async () => {
        throw new Error('boom');
      })
      .mockImplementationOnce(async () => ({ ok: true, id: 'simg_2' }));
    const pipeline: any = makePipeline();
    await primeStory(
      pipeline,
      `<scene_image title="甲">画面甲</scene_image><scene_image title="乙">画面乙</scene_image>`,
    );

    await pipeline.handleSceneImages([{ type: 'scene_image' }]);
    expect(sceneImageStore.generate).toHaveBeenCalledTimes(2);
  });

  it('插画库还没载入本存档时不开火（切存档途中不该在别处花钱）', async () => {
    sceneImageStore.activeSaveId = 'another-save';
    const pipeline: any = makePipeline();
    await primeStory(pipeline, oneMarker);

    await pipeline.handleSceneImages([{ type: 'scene_image' }]);
    expect(sceneImageStore.generate).not.toHaveBeenCalled();
  });

  it('标记没写 rating 时取设置里的上限档（D38 的另一半）', async () => {
    const pipeline: any = makePipeline({}, { imageMaxRating: 'sensitive' });
    await primeStory(pipeline, oneMarker);

    await pipeline.handleSceneImages([{ type: 'scene_image' }]);
    expect((sceneImageStore.generate.mock.calls[0][0] as any).rating).toBe('sensitive');
  });
});

// ===== T16：combat_v3 玩家输入桥时序 + pre-combat 快照 =====
// 设计 2026-08-09 §3.5：handleCombatTriggerV3 必须在 `await runCombatV3(...)` **之前**
// setCombatCoordinator —— 此前句柄在战斗结束后才挂，waitForCommand（玩家首决策）永远
// 没人 resolve（T15 确认的「面板不弹」疑似根因）。顺带验证 pre-combat 快照在开战前打上。
describe('T16 combat_v3 玩家输入桥时序 + pre-combat 快照', () => {
  /** 最小 player 角色桩（characterToCombatParticipant 消费的字段） */
  function playerCharStub() {
    return {
      id: 'hero',
      name: '理查德',
      type: 'player',
      tier: 1,
      level: 1,
      attributes: { str: 5, dex: 5, con: 5, int: 5, spi: 5 },
      hp: 100,
      maxHp: 100,
      mp: 50,
      maxMp: 50,
      sp: 50,
      maxSp: 50,
      inventory: [],
      skills: [],
      statusEffects: [],
    };
  }

  beforeEach(() => {
    runCombatV3Mock.mockReset();
    createSnapshotSpy.mockClear();
  });

  it('setCombatCoordinator 在 runCombatV3 之前挂好；战斗中句柄可完成 submit→waitForCommand 往返；pre-combat 快照已打', async () => {
    // 句柄形状照 game-store 的 combatCoordinator（submit/abandon/waitForCommand/preSnapshotId/restart）
    // 🔴 用 holder 对象而不是裸 let：直接 `coordinatorHandle = h` 会让 TS 的 CFA 把变量收窄
    //    成回调参数的类型（甚至 never），属性访问跟着报错。
    const holder: {
      handle: {
        submit?: (c: never) => Promise<void>;
        waitForCommand?: () => Promise<never>;
        preSnapshotId?: string | null;
      } | null;
    } = { handle: null };

    const gameStore = makeGameStore({
      characters: [playerCharStub()],
      enterCombat: vi.fn(),
      exitCombat: vi.fn(),
      applyCombatEvent: vi.fn(),
      updateAgentStatus: vi.fn(),
      clearAgentStatus: vi.fn(),
      setCombatCoordinator: vi.fn((h: unknown) => (holder.handle = h as never)),
      addMessage: vi.fn(),
      // totalTurns=3 → pre-combat 快照 turn 应为 3（照 advanceTurn 先例：已完成回合数 = 当前回合）
      activeSave: { id: 's', metadata: { totalTurns: 3 } },
    });
    const pipeline = makePipeline(gameStore, {
      apiPool: [{ id: 'ep1', name: 'ep', model: 'm' }],
    });

    // fake runCombatV3：断言时序（句柄已挂）+ 用句柄完成一次「等待 → 提交」往返
    runCombatV3Mock.mockImplementation(async () => {
      // 🔴 时序修复契约：战斗进行中 coordinator 句柄已在 store 上
      expect(holder.handle).not.toBeNull();
      // 模拟玩家回合：waitForCommand 挂起 → handle.submit 喂入 → resolve
      const p = holder.handle!.waitForCommand!();
      await holder.handle!.submit!({
        commandId: 'ui-1',
        expectedRevision: 0,
        kind: 'PassAttack',
        actorId: '甲',
        cost: 'attack',
        payload: {},
      } as never);
      await p;
      return {
        narrativeSummary: 'ok',
        patches: [],
        totalExp: 0,
        totalFp: 0,
        loot: [],
        rounds: 1,
        outcome: 'ally_win',
      };
    });

    const result = await (pipeline as any).handleCombatTrigger(
      { combatType: '标准', allies: '理查德', enemies: '骷髅' } as never,
      '',
    );

    expect(result?.outcome).toBe('ally_win');
    // 时序修复：句柄在 runCombatV3 之前已挂（fake 内部断言成立）
    expect(gameStore.setCombatCoordinator).toHaveBeenCalled();
    // pre-combat 快照：createSnapshot('pre-combat', 当前回合数)
    expect(createSnapshotSpy).toHaveBeenCalledWith('pre-combat', 3);
    expect(holder.handle?.preSnapshotId).toBe('snap-pre-combat');
    // 终局后的清理仍在 runCombatV3 完成之后执行（顺序未被提前破坏）
    expect(gameStore.exitCombat).toHaveBeenCalled();
  });

  it('无活跃存档回合数时 pre-combat 快照 turn 兜底 0（不阻塞开战）', async () => {
    const gameStore = makeGameStore({
      characters: [playerCharStub()],
      enterCombat: vi.fn(),
      exitCombat: vi.fn(),
      applyCombatEvent: vi.fn(),
      updateAgentStatus: vi.fn(),
      clearAgentStatus: vi.fn(),
      setCombatCoordinator: vi.fn(),
      addMessage: vi.fn(),
      activeSave: null, // activeSave 缺省 → 回合数兜底 0
    });
    const pipeline = makePipeline(gameStore, {
      apiPool: [{ id: 'ep1', name: 'ep', model: 'm' }],
    });
    runCombatV3Mock.mockResolvedValue({
      narrativeSummary: 'ok',
      patches: [],
      totalExp: 0,
      totalFp: 0,
      loot: [],
      rounds: 1,
      outcome: 'ally_win',
    });

    const result = await (pipeline as any).handleCombatTrigger(
      { combatType: '标准', allies: '理查德', enemies: '骷髅' } as never,
      '',
    );

    expect(result?.outcome).toBe('ally_win');
    expect(createSnapshotSpy).toHaveBeenCalledWith('pre-combat', 0);
  });
});
