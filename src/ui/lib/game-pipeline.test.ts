import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  collectSelectedSystemCoreWorkshopBookIds,
  extractStoryOptions,
  GamePipeline,
  withImagePromptSystem,
} from './game-pipeline';
import type { AgentConfig, ApiEndpoint } from '@engine/types';
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
const {
  commitSpy,
  advanceTurnSpy,
  toastSpy,
  createSnapshotSpy,
  runCombatV3Mock,
  callImagePromptAgentMock,
  summarizeAndSaveMock,
} = vi.hoisted(() => ({
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
  callImagePromptAgentMock: vi.fn(),
  summarizeAndSaveMock: vi.fn(),
}));

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

vi.mock('@engine/image-prompt-agent', () => ({
  callImagePromptAgent: callImagePromptAgentMock,
}));

vi.mock('@engine/memory-summarizer', () => ({
  summarizeAndSave: summarizeAndSaveMock,
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

// 🆕 T4：invalidatePromptSessions 的唯一职责 = 把本 pipeline 的 saveId 交给引擎清理。
// mock 掉引擎模块，直接 spy 收到的入参（断言「只清对应 saveId」）。
const { invalidatePromptSessionSpy } = vi.hoisted(() => ({
  invalidatePromptSessionSpy: vi.fn(),
}));

vi.mock('@engine/prompt-session-assembler', () => ({
  invalidatePromptSession: invalidatePromptSessionSpy,
}));

import { preCheckPlot, postCheckPlot } from '@engine/plot-engine';

function makeGameStore(overrides: Record<string, any> = {}) {
  return {
    // 🔴 必须与 makePipeline 的 saveId 一致：COR-02 之后管线拿它判「本轮结果还属不属于
    // 当前打开的存档」，对不上就丢弃正文 —— 桩里漏了这一格，7 条既有用例会一起变红。
    activeSaveId: 'save-test',
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
    startAgentLogTurn: vi.fn(),
    finishAgentLogTurn: vi.fn(),
    flushAgentLogWrites: vi.fn(async () => {}),
    agentLogHistory: [],
    clearAllAgentStatus: vi.fn(),
    startAgentActivityRun: vi.fn(() => 'activity-test'),
    finishAgentActivityRun: vi.fn(),
    markAgentActivityStopping: vi.fn(),
    recordAgentToolActivity: vi.fn(),
    updateAgentStatus: vi.fn(),
    clearAgentStatus: vi.fn(),
    addAgentLogEntry: vi.fn(),
    refreshFromDb: vi.fn(async () => {}),
    // 🆕 结算确认（2026-08-13 需求 D）：默认立即以原文确认（模拟玩家直接点「注入正文」）
    awaitCombatSummaryReview: vi.fn(async (p: { summaryText: string }) => p.summaryText),
    confirmCombatSummary: vi.fn(),
    discardCombatSummary: vi.fn(),
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

describe('侧链 Agent 调试调用身份', () => {
  it('同回合新建两个同名 client 时仍生成不同 invocationId', async () => {
    const addAgentLogEntry = vi.fn();
    const pipeline = makePipeline({ addAgentLogEntry });
    const factory = (pipeline as any).getClientFactory('run-debug');
    const endpoint: ApiEndpoint = {
      id: 'ep',
      name: 'DeepSeek',
      provider: 'deepseek',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'key',
      defaultModel: 'model',
      models: ['model'],
      timeout: 1000,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { total_tokens: 1 },
      }),
      text: async () => '',
    } as Response);

    try {
      await factory('char_gen', endpoint, 'save-test').chat({
        messages: [{ role: 'user', content: 'first' }],
      });
      await factory('char_gen', endpoint, 'save-test').chat({
        messages: [{ role: 'user', content: 'second' }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(addAgentLogEntry).toHaveBeenCalledTimes(2);
    const ids = addAgentLogEntry.mock.calls.map(([entry]) => entry.invocationId);
    expect(ids).toEqual(['run-debug:char_gen:1', 'run-debug:char_gen:2']);
  });
});

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

describe('buildAgentConfigs — combat_v3 侧链装配', () => {
  it('agentConfigs 包含 combat_v3，systemPrompt 来自设置覆写', () => {
    const pipeline = makePipeline();
    const settings = (pipeline as any).settings.settings;
    patchAgentSettings(settings, 'combat_v3', {
      systemPrompt: '你是战斗决策 Agent（设置页覆写）',
    });

    const configs = (pipeline as any).buildAgentConfigs({});
    const combat = configs.find((config: any) => config.agentId === 'combat_v3');

    expect(combat).toBeDefined();
    expect(combat.systemPrompt).toBe('你是战斗决策 Agent（设置页覆写）');
  });

  it('未覆写时 systemPrompt 回落默认层（agent-config.json 的 combat_v3）', () => {
    const pipeline = makePipeline();
    const defaultPrompt = '你是《命定之诗》战斗决策 Agent。';

    const configs = (pipeline as any).buildAgentConfigs({
      combat_v3: { systemPrompt: defaultPrompt },
    });
    const combat = configs.find((config: any) => config.agentId === 'combat_v3');

    expect(combat).toBeDefined();
    expect(combat.systemPrompt).toBe(defaultPrompt);
  });
});

describe('buildAgentConfigs / buildEndpoints —— Delta 会话两个配置面（T4）', () => {
  it('buildAgentConfigs 把覆写层 tailPrompt 灌进 AgentConfig', () => {
    const pipeline = makePipeline();
    const settings = (pipeline as any).settings.settings;
    patchAgentSettings(settings, 'story', { tailPrompt: '请用简体中文作答' });

    const configs = (pipeline as any).buildAgentConfigs({});
    const story = configs.find((config: any) => config.agentId === 'story');

    expect(story.tailPrompt).toBe('请用简体中文作答');
  });

  it('buildAgentConfigs 未配置 tailPrompt → undefined（不发该字段）', () => {
    const pipeline = makePipeline();
    const configs = (pipeline as any).buildAgentConfigs({});
    const story = configs.find((config: any) => config.agentId === 'story');

    expect(story.tailPrompt).toBeUndefined();
  });

  it('buildEndpoints 把 ApiEntry.contextWindowTokens 灌进 ApiEndpoint', () => {
    const pipeline = makePipeline(
      {},
      {
        apiPool: [{ id: 'ep1', name: 'ep', model: 'm', contextWindowTokens: 128000 }],
      },
    );

    const endpoints = (pipeline as any).buildEndpoints();
    expect(endpoints[0].contextWindowTokens).toBe(128000);
  });

  it('buildEndpoints 对非正整数 contextWindowTokens 归一化为 undefined', () => {
    const pipeline = makePipeline(
      {},
      {
        apiPool: [
          { id: 'ep1', name: 'ep', model: 'm', contextWindowTokens: 0 },
          { id: 'ep2', name: 'ep', model: 'm', contextWindowTokens: -5 },
          { id: 'ep3', name: 'ep', model: 'm', contextWindowTokens: 1.5 },
          { id: 'ep4', name: 'ep', model: 'm', contextWindowTokens: 'big' as any },
        ],
      },
    );

    const endpoints = (pipeline as any).buildEndpoints();
    expect(endpoints.map((e: any) => e.contextWindowTokens)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('🆕 invalidatePromptSessions 只清本 pipeline 的 saveId', () => {
    invalidatePromptSessionSpy.mockClear();
    const pipeline = new GamePipeline({
      gameStore: makeGameStore(),
      settingsStore: makeSettingsStore(),
      saveId: 'save-T4',
    });

    pipeline.invalidatePromptSessions();

    expect(invalidatePromptSessionSpy).toHaveBeenCalledTimes(1);
    expect(invalidatePromptSessionSpy).toHaveBeenCalledWith('save-T4');
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

  it('重试时从历史排除触发消息，只通过 userInput 注入一次', () => {
    const pipeline = makePipeline({
      messages: [
        { id: 'u1', role: 'user', content: '上一轮输入', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: '上一轮正文', timestamp: 2 },
        { id: 'u2', role: 'user', content: '需要重试的输入', timestamp: 3 },
      ],
    });

    const ctx = (pipeline as any).buildContext('需要重试的输入', 'u2');

    expect(ctx.userInput).toBe('需要重试的输入');
    expect(ctx.history.map((message: { id: string }) => message.id)).toEqual(['u1', 'a1']);
    expect(
      ctx.history.filter((message: { content: string }) => message.content === '需要重试的输入'),
    ).toHaveLength(0);
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

// ══════════════════════════════════════════════════════════════════════════
// COR-02（2026-08-09 审查）：孤儿回合不许写进后来打开的那个存档
// ══════════════════════════════════════════════════════════════════════════
describe('COR-02：存档归属闸', () => {
  // 失败场景：存档 A 生成中（story 在飞，约 20 秒）→ 玩家点「← 首页」→ 打开存档 B。
  // GamePage 无 KeepAlive，卸载即销毁；但在飞的 run() 仍会走到 handleAgentResult →
  // game.addMessage(...)，而 game-store 是从 **store** 取存档号的
  // （`saveId: activeSaveId.value`）—— 为 A 生成的正文于是落进 B 并永久留在 B 的历史里。

  it('🔴 store 已切到别的存档 → 本轮正文被丢弃，不写进那个存档', async () => {
    const addMessage = vi.fn((content: string) => ({ id: 'm1', turn: 1, content }));
    const pipeline = makePipeline({ addMessage, activeSaveId: 'another-save' });

    await (pipeline as any).handleAgentResult(
      makeResult('story', '<maintext>为存档 A 生成的正文</maintext>'),
    );

    expect(addMessage).not.toHaveBeenCalled();
  });

  it('🔴 被丢弃时不留下 lastStoryMessage —— 插画锚点不能指向一条不存在的消息', async () => {
    const pipeline = makePipeline({
      addMessage: vi.fn((content: string) => ({ id: 'm1', turn: 1, content })),
      activeSaveId: 'another-save',
    });

    await (pipeline as any).handleAgentResult(makeResult('story', '<maintext>正文</maintext>'));

    expect((pipeline as any).lastStoryMessage).toBeNull();
  });

  it('存档没变时照常写入（闸门不误伤正常回合）', async () => {
    const addMessage = vi.fn((content: string) => ({ id: 'm1', turn: 1, content }));
    const pipeline = makePipeline({ addMessage }); // activeSaveId 默认 = 'save-test'

    await (pipeline as any).handleAgentResult(makeResult('story', '<maintext>正文</maintext>'));

    expect(addMessage).toHaveBeenCalledWith('正文', 'assistant');
    expect((pipeline as any).lastStoryMessage).toMatchObject({ id: 'm1' });
  });

  it('存档已切走时不替新存档跑 refreshFromDb', async () => {
    const refreshFromDb = vi.fn(async () => {});
    const pipeline = makePipeline({ refreshFromDb, activeSaveId: 'another-save' });

    // run() 的 finally 一定会执行；这里让管线在早期就失败，只验回读没被触发
    await pipeline.run('输入');

    expect(refreshFromDb).not.toHaveBeenCalled();
  });

  // 🔴 以下四条是 2026-08-10 审查轮补的 —— 初版闸门只收编了 `addMessage`，
  // 而「本轮结果的投影」不止正文一条。

  it('🔴 系统消息（char_gen 卡片）同样过闸 —— 它与正文落到同一个 persistMessage', () => {
    const addSystemMessage = vi.fn();
    const pipeline = makePipeline({ addSystemMessage, activeSaveId: 'another-save' });

    (pipeline as any).emitSystemMessage({
      type: 'char_gen',
      characterName: '琴师',
      narrative: '一位琴师加入了队伍',
    });

    expect(addSystemMessage).not.toHaveBeenCalled();
  });

  it('存档没变时系统消息照常写入', () => {
    const addSystemMessage = vi.fn();
    const pipeline = makePipeline({ addSystemMessage });

    (pipeline as any).emitSystemMessage({
      type: 'char_gen',
      characterName: '琴师',
      narrative: '一位琴师加入了队伍',
    });

    expect(addSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('🔴 正文被丢弃时行动选项也不铺进新存档的输入区', async () => {
    const setPendingOptions = vi.fn();
    const pipeline = makePipeline({ setPendingOptions, activeSaveId: 'another-save' });

    await (pipeline as any).handleAgentResult(
      makeResult('story', '<maintext>正文</maintext><options>1. 前进</options>'),
    );

    expect(setPendingOptions).not.toHaveBeenCalled();
  });

  it('🔴 存档已切走时不归还开场认领 —— 那会把别的存档的开场重放一遍', async () => {
    const releaseOpeningPromptClaim = vi.fn(async () => true);
    const pipeline = makePipeline({
      openingPrompt: 'OPENING',
      markOpeningPromptConsumed: vi.fn(async () => true),
      releaseOpeningPromptClaim,
      activeSaveId: 'another-save',
    });

    await pipeline.sendOpeningPrompt();

    expect(releaseOpeningPromptClaim).not.toHaveBeenCalled();
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

  // ── 天气供值漂移（地图 v1 §5 接线表第一处）──────────────────────────
  //
  // `stat-projection` 从 T3 起就会写 `stats.世界.天气`，但**这个调用点从来没传过 weather**
  // —— 世界书里每一处 `stats.世界.天气` 都读不到那个键，而条目自己的 `|| '未知'`
  // 把它掩盖得干干净净（与 `blurByDefault` 同形状：逻辑对、没人供值）。
  // 这三条钉的是「有人供值」+「与 ctx.weather 同一条链」。

  it('🔴 statData.世界.天气 ← variables.sys.天气（此前这个键根本不存在）', () => {
    const pipeline = makePipeline({
      characters: [player],
      saveProfile: { variables: { sys: { 天气: '小雪' } } },
    });
    const ctx = (pipeline as any).buildContext('输入');
    expect(ctx.statData.世界.天气).toBe('小雪');
    // 同一条链的两个消费方不许漂：面板上写着「小雪」、提示词里却是别的天气
    expect(ctx.weather).toBe('小雪');
  });

  it('旧存档兜底：worldFlags.天气 / worldFlags.weather 也认（读法与出图同口径）', () => {
    const zh = (pipeline: any) => pipeline.buildContext('输入').statData.世界.天气;
    expect(
      zh(makePipeline({ characters: [player], saveProfile: { worldFlags: { 天气: '大雨' } } })),
    ).toBe('大雨');
    expect(
      zh(makePipeline({ characters: [player], saveProfile: { worldFlags: { weather: '沙暴' } } })),
    ).toBe('沙暴');
  });

  it('没有天气 → 整个键不出现（缺席不是空串，条目的守卫分支据此降级）', () => {
    const pipeline = makePipeline({
      characters: [player],
      saveProfile: { variables: { sys: {} } },
    });
    const ctx = (pipeline as any).buildContext('输入');
    expect(ctx.statData.世界?.天气).toBeUndefined();
    expect(ctx.weather).toBeUndefined();
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

describe('runImagePromptAgent — activity ledger', () => {
  beforeEach(() => {
    callImagePromptAgentMock.mockReset();
  });

  it('registers and settles a standalone image_prompt step around the Agent call', async () => {
    const gameStore = makeGameStore();
    const pipeline = new GamePipeline({
      gameStore,
      settingsStore: makeSettingsStore({
        apiPool: [{ id: 'ep-image', name: 'image', model: 'image-model' }],
      }),
      saveId: 'save-test',
    });
    (pipeline as any).ensureChainData = vi.fn(async () => ({
      agentConfigs: [],
      worldBooks: [],
      presets: [],
    }));
    callImagePromptAgentMock.mockResolvedValue({
      ok: true,
      value: {
        scenePrompt: 'moonlit tavern',
        sceneNegative: '',
        desc: '月下旅店',
      },
    });

    await pipeline.runImagePromptAgent({
      intent: '月下的旅店',
      characters: [],
      narrative: '旅店安静地立在月色里。',
      rating: 'general',
    });

    expect(gameStore.startAgentActivityRun).toHaveBeenCalledWith(undefined, true);
    expect(gameStore.updateAgentStatus).toHaveBeenCalledWith('image_prompt', 'activity-test');
    expect(callImagePromptAgentMock).toHaveBeenCalledOnce();
    expect(gameStore.clearAgentStatus).toHaveBeenCalledWith(
      'image_prompt',
      undefined,
      'activity-test',
    );
  });

  it("keeps an older turn's callbacks bound to their original activity run", () => {
    const gameStore = makeGameStore();
    const pipeline = new GamePipeline({
      gameStore,
      settingsStore: makeSettingsStore(),
      saveId: 'save-test',
    });
    const events = (pipeline as any).buildEventHandlers('activity-old');

    // abort() unlocks input immediately, so a newer turn can own the instance before
    // the older callbacks finish. Those late callbacks must not land in the new ledger.
    (pipeline as any).activeRunId = 'activity-new';
    events.onAgentStart('story', { apiEndpointId: 'ep-story', model: 'story-model' });
    events.onToolCall('story', 'lookup_lore', { name: '旧城' }, { found: true });
    events.onAgentError('story', '已取消');

    expect(gameStore.updateAgentStatus).toHaveBeenCalledWith('story', 'activity-old');
    expect(gameStore.recordAgentToolActivity).toHaveBeenCalledWith(
      'story',
      'lookup_lore',
      { name: '旧城' },
      { found: true },
      'activity-old',
    );
    expect(gameStore.clearAgentStatus).toHaveBeenCalledWith('story', '已取消', 'activity-old');
  });

  it('preserves the completed provider payload when completion handling later fails', () => {
    const gameStore = makeGameStore();
    const pipeline = new GamePipeline({
      gameStore,
      settingsStore: makeSettingsStore(),
      saveId: 'save-test',
    });
    const events = (pipeline as any).buildEventHandlers('activity-failed');
    const result = {
      ...makeResult('story', 'billable response'),
      requestMessages: [{ role: 'user', content: 'billable request' }],
      tokensUsed: 73,
      duration: 42,
      error: 'completion handler failed',
    };

    events.onAgentStart('story', { apiEndpointId: 'ep-story', model: 'story-model' });
    events.onAgentError('story', result.error, result);

    expect(gameStore.addAgentLogEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: result.requestMessages,
        rawResponse: 'billable response',
        tokensUsed: 73,
        duration: 42,
        error: 'completion handler failed',
      }),
    );
  });

  it('records memory-summary embedding usage as its own billable invocation', async () => {
    const gameStore = makeGameStore();
    const settingsStore = makeSettingsStore({
      embeddingEndpointId: 'ep-embedding',
      embeddingModel: 'embed-model',
      apiPool: [
        {
          id: 'ep-embedding',
          name: 'Embedding API',
          baseUrl: 'https://api.example.test/v1',
          apiKey: 'secret',
          defaultModel: 'fallback-model',
        },
      ],
    });
    summarizeAndSaveMock.mockImplementationOnce(async (options: any) => {
      options.onEmbeddingRequest({
        input: 'summary embedding input',
        model: 'embed-model',
        baseUrl: 'https://api.example.test/v1',
        startedAt: 100,
        completedAt: 125,
        promptTokens: 11,
        totalTokens: 11,
        dimensions: 1536,
      });
      return null;
    });
    const pipeline = new GamePipeline({ gameStore, settingsStore, saveId: 'save-test' });

    await (pipeline as any).persistMemorySummary(
      makeResult('memory_summary', '{"content":"summary"}'),
      'activity-embedding',
    );

    expect(gameStore.addAgentLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'activity-embedding',
        agentId: 'memory_embedding',
        model: 'embed-model',
        messages: [{ role: 'user', content: 'summary embedding input' }],
        tokensUsed: 11,
        promptTokens: 11,
      }),
    );
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

  it('F2：检出 → 只弹就绪面板（不 runCombatV3）→ 点开始 → startCombatV3 真开打（句柄先挂、pre-combat 快照已打）', async () => {
    // 句柄形状照 game-store 的 combatCoordinator（submit/abandon/waitForCommand/preSnapshotId/restart/start）
    // 🔴 用 holder 对象而不是裸 let：直接 `coordinatorHandle = h` 会让 TS 的 CFA 把变量收窄
    //    成回调参数的类型（甚至 never），属性访问跟着报错。
    const holder: {
      handle: {
        submit?: (c: never) => Promise<void>;
        waitForCommand?: () => Promise<never>;
        preSnapshotId?: string | null;
        start?: () => Promise<void>;
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

    // ① combat_trigger 检出 → 只弹就绪面板：v3_combat_ready 投进 store、**不 runCombatV3**
    const readyResult = await (pipeline as any).handleCombatTrigger(
      { combatType: '标准', allies: '理查德', enemies: '骷髅' } as never,
      '',
    );
    expect(readyResult).toBeNull();
    expect(runCombatV3Mock).not.toHaveBeenCalled();
    expect(gameStore.applyCombatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'v3_combat_ready',
        combatType: '标准',
        allies: ['理查德'],
        enemies: ['骷髅'],
      }),
    );
    // 就绪期占位句柄：只有 start（store.startCombat 调它），submit/waitForCommand 还没挂
    expect(typeof holder.handle?.start).toBe('function');
    expect(holder.handle?.submit).toBeUndefined();

    // ② 玩家点「开始战斗」→ store.startCombat → 占位句柄 start → startCombatV3 真开打
    await holder.handle!.start!();

    // 时序修复：完整句柄（submit/waitForCommand/...）在 runCombatV3 之前已挂（fake 内部断言成立）
    expect(gameStore.setCombatCoordinator).toHaveBeenCalledTimes(2); // 占位 + 完整
    // pre-combat 快照：createSnapshot('pre-combat', 当前回合数)
    expect(createSnapshotSpy).toHaveBeenCalledWith('pre-combat', 3);
    expect(holder.handle?.preSnapshotId).toBe('snap-pre-combat');
    // 终局后的清理仍在 runCombatV3 完成之后执行（顺序未被提前破坏）
    expect(gameStore.exitCombat).toHaveBeenCalled();
  });

  it('🔴 2026-08-13 真机 debug：战斗终局落库后回读 store（refreshFromDb）—— 满血假象修复', async () => {
    // 战斗链路（store.startCombat → startCombatV3）不经过 run() 的 finally，
    // 终局 commitChatState 只写 Dexie；不回读的话 HUD 一直显示开战前的血量/经验。
    const holder: { handle: { start?: () => Promise<void> } | null } = { handle: null };
    const gameStore = makeGameStore({
      characters: [playerCharStub()],
      enterCombat: vi.fn(),
      exitCombat: vi.fn(),
      applyCombatEvent: vi.fn(),
      updateAgentStatus: vi.fn(),
      clearAgentStatus: vi.fn(),
      setCombatCoordinator: vi.fn((h: unknown) => (holder.handle = h as never)),
      awaitCombatSummaryReview: vi.fn(async (p: { summaryText: string }) => p.summaryText),
      activeSave: { id: 's', metadata: { totalTurns: 1 } },
    });
    runCombatV3Mock.mockResolvedValue({
      narrativeSummary: 'ok',
      patches: [],
      totalExp: 2,
      totalFp: 0,
      loot: [],
      rounds: 1,
      outcome: 'ally_win',
    });
    const pipeline = new GamePipeline({
      gameStore,
      settingsStore: makeSettingsStore({ apiPool: [{ id: 'ep1', name: 'ep', model: 'm' }] }),
      saveId: 'save-test',
    });

    await (pipeline as any).handleCombatTrigger(
      { combatType: '标准', allies: '理查德', enemies: '骷髅' } as never,
      '',
    );
    (gameStore.refreshFromDb as ReturnType<typeof vi.fn>).mockClear();
    await holder.handle!.start!();

    // 终局落库后回读了 store（HUD 血量/经验可见）
    expect(gameStore.refreshFromDb).toHaveBeenCalledTimes(1);

    // COR-02：存档已切走时不回读（给别人的存档跑刷新没有意义）
    (gameStore.refreshFromDb as ReturnType<typeof vi.fn>).mockClear();
    await (pipeline as any).handleCombatTrigger(
      { combatType: '标准', allies: '理查德', enemies: '骷髅' } as never,
      '',
    );
    gameStore.activeSaveId = 'another-save';
    await holder.handle!.start!();
    expect(gameStore.refreshFromDb).not.toHaveBeenCalled();
  });

  it('🔴 需求 D（2026-08-13）：终局先弹结算确认 → 玩家编辑后的文本注入正文；aborted 不弹确认', async () => {
    const holder: { handle: { start?: () => Promise<void> } | null } = { handle: null };
    const gameStore = makeGameStore({
      characters: [playerCharStub()],
      enterCombat: vi.fn(),
      exitCombat: vi.fn(),
      applyCombatEvent: vi.fn(),
      updateAgentStatus: vi.fn(),
      clearAgentStatus: vi.fn(),
      setCombatCoordinator: vi.fn((h: unknown) => (holder.handle = h as never)),
      addMessage: vi.fn((content: string, role: string) => ({
        id: 'msg_stub',
        role,
        content,
        timestamp: 0,
        turn: 1,
      })),
      awaitCombatSummaryReview: vi.fn(async () => '玩家改过的战斗总结'),
      activeSave: { id: 's', metadata: { totalTurns: 7 } },
    });
    const pipeline = new GamePipeline({
      gameStore,
      settingsStore: makeSettingsStore({ apiPool: [{ id: 'ep1', name: 'ep', model: 'm' }] }),
      saveId: 'save-test',
    });

    // ① 正常终局：确认框收到结算数据，注入的是**编辑后**的文本
    runCombatV3Mock.mockResolvedValue({
      narrativeSummary: 'AI 原始摘要',
      patches: [],
      totalExp: 2,
      totalFp: 5,
      loot: [],
      rounds: 2,
      outcome: 'ally_win',
    });
    await (pipeline as any).handleCombatTrigger(
      { combatType: '标准', allies: '理查德', enemies: '骷髅' } as never,
      '',
    );
    await holder.handle!.start!();
    expect(gameStore.awaitCombatSummaryReview).toHaveBeenCalledWith(
      expect.objectContaining({ totalExp: 2, outcome: 'ally_win', summaryText: 'AI 原始摘要' }),
    );
    expect(gameStore.addMessage).toHaveBeenCalledWith(
      '【战斗摘要】玩家改过的战斗总结',
      'assistant',
    );
    // B：最近已结算战斗被记录（{{RECENT_COMBAT}} 数据源），含名单与回合数
    expect((pipeline as any).buildContext('输入').recentCombat).toEqual({
      allies: ['理查德'],
      enemies: ['骷髅'],
      outcome: 'ally_win',
      endedAtTurn: 7,
    });
    // 确认之后才收面板
    expect(gameStore.exitCombat).toHaveBeenCalled();

    // ② 放弃的战斗（aborted）：不弹确认、不注入、不记录已结算
    (gameStore.awaitCombatSummaryReview as ReturnType<typeof vi.fn>).mockClear();
    (gameStore.addMessage as ReturnType<typeof vi.fn>).mockClear();
    (gameStore.exitCombat as ReturnType<typeof vi.fn>).mockClear();
    runCombatV3Mock.mockResolvedValue({
      narrativeSummary: '战斗被放弃（M2 coordinator abandon）',
      patches: [],
      totalExp: 0,
      totalFp: 0,
      loot: [],
      rounds: 1,
      outcome: 'draw',
      aborted: true,
    });
    await (pipeline as any).handleCombatTrigger(
      { combatType: '标准', allies: '理查德', enemies: '骷髅' } as never,
      '',
    );
    await holder.handle!.start!();
    expect(gameStore.awaitCombatSummaryReview).not.toHaveBeenCalled();
    expect(gameStore.addMessage).not.toHaveBeenCalled();
    // aborted 未覆盖上一次的记录（仍然只有第一场的记录）
    expect((pipeline as any)._recentCombat.outcome).toBe('ally_win');
  });

  it('无活跃存档回合数时 pre-combat 快照 turn 兜底 0（不阻塞开战）', async () => {
    const holder: { handle: { start?: () => Promise<void> } | null } = { handle: null };
    const gameStore = makeGameStore({
      characters: [playerCharStub()],
      enterCombat: vi.fn(),
      exitCombat: vi.fn(),
      applyCombatEvent: vi.fn(),
      updateAgentStatus: vi.fn(),
      clearAgentStatus: vi.fn(),
      setCombatCoordinator: vi.fn((h: unknown) => (holder.handle = h as never)),
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

    await (pipeline as any).handleCombatTrigger(
      { combatType: '标准', allies: '理查德', enemies: '骷髅' } as never,
      '',
    );
    await holder.handle!.start!();

    expect(createSnapshotSpy).toHaveBeenCalledWith('pre-combat', 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// T2（2026-08-10）：handleCombatTriggerV3 向 runCombatV3 传模板系统上下文 ——
// combatBrief（marker 组装）/ 过滤后的世界书（world_setting + race + system_core）/
// userInput / storyOutput / history。全部可选，缺省不崩。
// ══════════════════════════════════════════════════════════════════════════════
describe('T2 combat_v3 模板系统上下文传参', () => {
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

  function combatGameStore(holder?: { handle: { start?: () => Promise<void> } | null }) {
    return makeGameStore({
      characters: [playerCharStub()],
      enterCombat: vi.fn(),
      exitCombat: vi.fn(),
      applyCombatEvent: vi.fn(),
      updateAgentStatus: vi.fn(),
      clearAgentStatus: vi.fn(),
      setCombatCoordinator: holder ? vi.fn((h: unknown) => (holder.handle = h as never)) : vi.fn(),
      addMessage: vi.fn(),
    });
  }

  beforeEach(() => {
    runCombatV3Mock.mockReset();
    createSnapshotSpy.mockClear();
  });

  it('组装 combatBrief + 过滤世界书（只留 world_setting/race/system_core）+ 透传 userInput/storyOutput/history', async () => {
    const holder: { handle: { start?: () => Promise<void> } | null } = { handle: null };
    const gameStore = combatGameStore(holder);
    const pipeline = makePipeline(gameStore, {
      apiPool: [{ id: 'ep1', name: 'ep', model: 'm' }],
    });
    // chainData：pipeline 侧取世界书的来源（含一个工坊书、一个 extra_setting 书，应被过滤掉）
    (pipeline as any).chainData = {
      agentConfigs: [],
      presets: [],
      worldBooks: [
        { id: 'wb_setting', name: '世界观', partition: 'world_setting', entries: [] },
        { id: 'wb_race', name: '种族', partition: 'race', entries: [] },
        { id: 'wb_core', name: '核心', partition: 'system_core', entries: [] },
        { id: 'wb_extra', name: '额外设定', partition: 'extra_setting', entries: [] },
        { id: 'wb_ws', name: '工坊', partition: 'creative_workshop', entries: [] },
      ],
    };
    // currentContext：本轮玩家输入 + 最近对话（startCombatV3 优先用它）
    (pipeline as any).currentContext = {
      userInput: '我走进竞技场，向冠军发起挑战',
      history: [
        { role: 'user', content: '我走进竞技场，向冠军发起挑战' },
        { role: 'assistant', content: '大门缓缓打开' },
      ],
      worldBooks: [],
      characters: [],
      variables: {},
      plotEvents: [],
      memories: [],
      agentOutputs: new Map(),
    };

    let captured: Record<string, any> | null = null;
    runCombatV3Mock.mockImplementation(async (opts: Record<string, any>) => {
      captured = opts;
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

    // F2：检出只弹就绪 → 点开始（holder.handle.start）才真开打（storyOutput 经就绪闭包传入）
    await (pipeline as any).handleCombatTrigger(
      {
        combatType: '死斗',
        environment: '竞技场',
        bodyText: '决一死战',
        allies: '理查德',
        enemies: '冠军',
      } as never,
      '理查德推开了竞技场的大门，冠军早已等候。',
    );
    expect(runCombatV3Mock).not.toHaveBeenCalled();
    await holder.handle!.start!();

    expect(captured).not.toBeNull();
    // combatBrief：从 marker 组装（战斗类型｜环境｜正文）
    expect(captured!.deps.combatBrief).toBe('战斗类型: 死斗｜环境: 竞技场｜决一死战');
    // combatRoster：从 marker 的 allies/enemies 组装（我方｜敌方）
    expect(captured!.deps.combatRoster).toBe('我方: 理查德；敌方: 冠军');
    // worldBooks：只保留 world_setting / race / system_core 三区
    expect(captured!.deps.worldBooks.map((b: { id: string }) => b.id)).toEqual([
      'wb_setting',
      'wb_race',
      'wb_core',
    ]);
    // userInput / storyOutput / history 透传
    expect(captured!.deps.userInput).toBe('我走进竞技场，向冠军发起挑战');
    expect(captured!.deps.storyOutput).toBe('理查德推开了竞技场的大门，冠军早已等候。');
    expect(captured!.deps.history).toHaveLength(2);
  });

  it('marker 缺 environment/bodyText → combatBrief 走缺省（战斗类型: 标准），chainData 缺省 → worldBooks 空数组不崩', async () => {
    const holder: { handle: { start?: () => Promise<void> } | null } = { handle: null };
    const gameStore = combatGameStore(holder);
    const pipeline = makePipeline(gameStore, {
      apiPool: [{ id: 'ep1', name: 'ep', model: 'm' }],
    });
    // 不设 chainData / currentContext —— 缺省兜底路径

    let captured: Record<string, any> | null = null;
    runCombatV3Mock.mockImplementation(async (opts: Record<string, any>) => {
      captured = opts;
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

    await (pipeline as any).handleCombatTrigger(
      { combatType: '标准', allies: '理查德', enemies: '骷髅' } as never,
      '',
    );
    await holder.handle!.start!();

    expect(captured).not.toBeNull();
    // 缺省字段照任务格式拼装（环境/正文为空段仍占位）
    expect(captured!.deps.combatBrief).toBe('战斗类型: 标准｜环境: ｜');
    // 有名单声明 → combatRoster 照拼
    expect(captured!.deps.combatRoster).toBe('我方: 理查德；敌方: 骷髅');
    // chainData 缺省 → 空数组（不 undefined、不崩）
    expect(Array.isArray(captured!.deps.worldBooks)).toBe(true);
    expect(captured!.deps.worldBooks).toHaveLength(0);
  });

  it('无 allies/enemies 名单声明 → combatRoster 空串（coordinator 落「（无参战方名单）」占位，不臆造名单）', async () => {
    const holder: { handle: { start?: () => Promise<void> } | null } = { handle: null };
    const gameStore = combatGameStore(holder);
    const pipeline = makePipeline(gameStore, {
      apiPool: [{ id: 'ep1', name: 'ep', model: 'm' }],
    });

    let captured: Record<string, any> | null = null;
    runCombatV3Mock.mockImplementation(async (opts: Record<string, any>) => {
      captured = opts;
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

    await (pipeline as any).handleCombatTrigger({ combatType: '标准' } as never, '');
    await holder.handle!.start!();

    expect(captured).not.toBeNull();
    expect(captured!.deps.combatRoster).toBe('');
  });

  // 🔴 2026-08-10 真机 debug：combat_trigger 声明 allies/enemies 名单后，
  // 名单外的角色（我方旁观 NPC 客栈掌柜奥斯瓦尔德·狼牙）曾被当敌方拉进战斗面板。
  it('F3：名单声明时只拉名单内角色 + player 本体：名单外旁观 NPC 不进 participants', async () => {
    const holder: { handle: { start?: () => Promise<void> } | null } = { handle: null };
    const gameStore = combatGameStore(holder);
    gameStore.characters = [
      playerCharStub(), // 玩家 理查德
      {
        ...playerCharStub(),
        id: 'npc_dalian',
        name: '妲丽安',
        type: 'npc',
        hp: 30,
        maxHp: 30,
      },
      {
        ...playerCharStub(),
        id: 'monster_sludge',
        name: '沼泥潜兽',
        type: 'monster',
        hp: 20,
        maxHp: 20,
      },
      {
        ...playerCharStub(),
        id: 'npc_oswald',
        name: '奥斯瓦尔德·狼牙',
        type: 'npc',
        hp: 5,
        maxHp: 5,
      },
    ];
    const pipeline = makePipeline(gameStore, {
      apiPool: [{ id: 'ep1', name: 'ep', model: 'm' }],
    });

    let captured: Record<string, any> | null = null;
    runCombatV3Mock.mockImplementation(async (opts: Record<string, any>) => {
      captured = opts;
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

    // F2：检出 → 就绪面板（v3_combat_ready 带名单数组）→ 点开始 → 真开打
    await (pipeline as any).handleCombatTrigger(
      { combatType: '标准', allies: '妲丽安', enemies: '沼泥潜兽' } as never,
      '',
    );
    expect(gameStore.applyCombatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'v3_combat_ready',
        allies: ['妲丽安'],
        enemies: ['沼泥潜兽'],
      }),
    );
    await holder.handle!.start!();

    const names = captured!.bundle.participants.map((p: { name: string }) => p.name).sort();
    // 只有名单内双方 + player；奥斯瓦尔德（名单外旁观者）绝不参战
    expect(names).toEqual(['妲丽安', '沼泥潜兽', '理查德']);
    expect(names).toHaveLength(3);
  });

  it('F3：名单缺省时保持旧行为：所有存活角色全拉（player=ally，其余=enemy）', async () => {
    const holder: { handle: { start?: () => Promise<void> } | null } = { handle: null };
    const gameStore = combatGameStore(holder);
    gameStore.characters = [
      playerCharStub(),
      { ...playerCharStub(), id: 'npc_a', name: '路人甲', type: 'npc', hp: 10, maxHp: 10 },
      { ...playerCharStub(), id: 'npc_b', name: '路人乙', type: 'npc', hp: 10, maxHp: 10 },
      { ...playerCharStub(), id: 'npc_dead', name: '已倒下者', type: 'npc', hp: 0, maxHp: 10 },
    ];
    const pipeline = makePipeline(gameStore, {
      apiPool: [{ id: 'ep1', name: 'ep', model: 'm' }],
    });

    let captured: Record<string, any> | null = null;
    runCombatV3Mock.mockImplementation(async (opts: Record<string, any>) => {
      captured = opts;
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

    await (pipeline as any).handleCombatTrigger({ combatType: '标准' } as never, '');
    // 无名单 → v3_combat_ready 不带 allies/enemies（缺省缺席）
    expect(gameStore.applyCombatEvent).toHaveBeenCalledWith(
      expect.not.objectContaining({ allies: expect.anything() }) as never,
    );
    await holder.handle!.start!();

    // 无名单 → 旧行为全拉（hp>0 的角色都在），倒下者（hp=0）仍不拉
    const names = captured!.bundle.participants.map((p: { name: string }) => p.name).sort();
    // 期望数组按 .sort() 的 UTF-16 码点序（乙 U+4E59 在 甲 U+7532 前），与 received 同口径
    expect(names).toEqual(['理查德', '路人乙', '路人甲']);
  });
});
