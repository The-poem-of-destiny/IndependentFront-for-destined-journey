/**
 * GamePipeline — 前端 ↔ AgentOrchestrator 桥接层
 *
 * Phase 10h: 连接 GamePage UI 和引擎 Agent 管线。
 * 封装: AgentConfig 组装 / AgentContext 构建 / 编排器创建 / 回调处理。
 *
 * Phase 7e: 🆕 流式渲染支持 — story agent 使用 chatStream() 逐块回调，
 * 通过 onStoryChunk 将增量文本实时推送到前端 UI。
 */
import { AgentOrchestrator } from '@engine/agent-orchestrator';
import type { OrchestratorOptions, OrchestratorEvents } from '@engine/agent-orchestrator';
import { DEFAULT_AGENT_PIPELINE } from '@engine/types';
import type {
  AgentContext,
  AgentConfig,
  ApiEndpoint,
  AgentResult,
  AgentPreset,
  CombatTriggerMarker,
  CombatSummaryResult,
  WorldBook,
  CraftGenRequestMarker,
  CharGenRequestMarker,
  ItemGenRequestMarker,
  PlayAudioMarker,
  MemoryRecord,
} from '@engine/types';
import { AgentClient } from '@engine/agent-client';
import type { StreamCallbacks } from '@engine/agent-client';
import { createStateManager } from '@engine/state-manager';
import { stripPlayAudioMarkers } from '@engine/marker-protocol';
import { loadWorldBooksWithFallback } from '@engine/builtin-worldbooks';
import { filterBooksByEnabledEntries } from '@engine/worldbook-loader';
import { buildStatData } from '@engine/stat-projection';
import { diffVars, measureDiffSize, EJS_DIFF_SIZE_LIMIT } from '@engine/ejs-vars-diff';
import type { EjsVarsDiff } from '@engine/ejs-vars-diff';
import type { useGameStore } from '../stores/game-store';
import type { useSettingsStore } from '../stores/settings-store';
import { useAudioStore } from '../stores/audio-store';
import { useWorldBookStore } from '../stores/worldbook-store';
import { useUIStore } from '../stores/ui-store';
import type { CombatCommand } from '@engine/combat-v3';

export interface GamePipelineDeps {
  gameStore: ReturnType<typeof useGameStore>;
  settingsStore: ReturnType<typeof useSettingsStore>;
  saveId: string;
}

/** 流式回调 — 由 GamePage 提供实时渲染。isComplete=true 表示流式传输已结束 */
export type StoryChunkCallback = (chunk: string, isComplete: boolean) => void;

/**
 * 从 story 正文中提取 <options> 行动选项块。
 * 格式约定（story systemPrompt <option_format>）: <options> 内每行 "数字. 内容"。
 * 返回剥离选项块后的正文 + 选项列表。
 */
export function extractStoryOptions(raw: string): { content: string; options: string[] } {
  const match = raw.match(/<options>([\s\S]*?)<\/options>/i);
  if (!match) return { content: raw, options: [] };
  const options = match[1]
    .split('\n')
    .map((line) =>
      line
        .trim()
        .match(/^\d+\s*[.、)．]\s*(.+)$/)?.[1]
        ?.trim(),
    )
    .filter((s): s is string => !!s);
  const content = raw
    .replace(/<options>[\s\S]*?<\/options>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { content, options };
}

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
};

export class GamePipeline {
  private game: ReturnType<typeof useGameStore>;
  private settings: ReturnType<typeof useSettingsStore>;
  private saveId: string;
  private orch: AgentOrchestrator | null = null;
  private abortController: AbortController | null = null;
  /** 真机修(2026-07-17): run() 加载的配置/世界书/预设，供侧链 buildAgentMessages 使用（此前恒 undefined → systemPrompt 退化 stub + 世界书恒空） */
  private chainData: {
    agentConfigs: AgentConfig[];
    worldBooks: WorldBook[];
    presets: AgentPreset[];
  } | null = null;
  /** 步5: 本轮共享 context 引用 — pre_check 剧情导演区块注入 / post_check 年度大纲检测需要 */
  private currentContext: AgentContext | null = null;
  /** 步5: 剧情异步落库任务（preCheckPlot/postCheckPlot），run() 末尾统一 await 避免 refreshFromDb 读到中间态 */
  private pendingPlotTasks: Promise<void>[] = [];
  /**
   * 🎵 本轮待播的配乐标记。Stage 1 只暂存，等状态落库+回读之后才真正选曲 ——
   * 理由见 run() 末尾。一轮多个标记时后者覆盖前者（以 AI 最后的判断为准）。
   */
  private pendingAudioMarker: PlayAudioMarker | null = null;
  /**
   * 上次据以选曲的地点。用来判断"地点变没变" —— 没变就不重选，
   * 同一地点里来回走动不该反复触发。空串表示还没选过。
   */
  private lastAudioLocation = '';
  /**
   * 工坊 P2 (D5) 体积护栏: 已经因超限被拒过的来源 Agent。
   *
   * **每存档每来源只 toast 一次** —— 一个失控的世界书状态机会轮轮超限，
   * 每轮弹一次只会把玩家逼到关掉通知。内存级即可（本实例随存档创建），
   * 不新增任何持久化字段；累计诊断在 `game.ejsVarsRejections`。
   */
  private ejsRejectToasted = new Set<string>();

  constructor(deps: GamePipelineDeps) {
    this.game = deps.gameStore;
    this.settings = deps.settingsStore;
    this.saveId = deps.saveId;
  }

  /** 把 settings-store 的快照配置同步到数据库 AppSettings
   *  （createSnapshot/restoreSnapshot 读数据库 AppSettings 而非 settings-store → 此处搭桥，
   *   让用户的「快照上限 / 保留模式」选择真正生效；顺带修活原本装饰性的 memorySnapshotLimit）。
   *  每轮 run 开始时调用，未变更则跳过写入。 */
  private async syncSnapshotSettings(): Promise<void> {
    try {
      const { getSettings, saveSettings } = await import('@engine/database');
      const current = await getSettings();
      if (!current) return;
      const limit = this.settings.settings.memorySnapshotLimit ?? 30;
      const mode = (this.settings.settings.snapshotRetentionMode ?? 'tiered') as 'tiered' | 'dense';
      if (current.maxSnapshotsPerSave === limit && current.snapshotRetentionMode === mode) return;
      await saveSettings({ ...current, maxSnapshotsPerSave: limit, snapshotRetentionMode: mode });
    } catch (err) {
      console.warn('[GamePipeline] 同步快照设置失败（不阻塞）:', err);
    }
  }

  /** 发送开场 Prompt（首次加载存档时调用），作为首条用户消息注入管线 */
  async sendOpeningPrompt(onStoryChunk?: StoryChunkCallback): Promise<void> {
    const prompt = this.game.openingPrompt;
    if (!prompt) return;
    // 开场 prompt 作为真正的用户消息渲染 + 注入历史，让下游 Agent 能读到装备/技能/背景/命定核心等
    const ok = await this.run(prompt, onStoryChunk, /* isUserMessage */ true);
    if (ok) {
      await this.game.markOpeningPromptConsumed();
    }
  }

  /** 核心: 将用户输入送入 Agent 管线。返回 true 表示管线成功完成。 */
  async run(
    userInput: string,
    onStoryChunk?: StoryChunkCallback,
    isUserMessage = true,
  ): Promise<boolean> {
    console.log(
      '[GamePipeline] run() called — userInput length:',
      userInput.length,
      'isUserMessage:',
      isUserMessage,
    );
    console.log('[GamePipeline] userInput preview:', userInput.slice(0, 300));
    this.abortController = new AbortController();
    this.game.isGenerating = true;

    try {
      // 1. 添加用户消息（非用户消息仅注入 context 不渲染）
      if (isUserMessage) {
        this.game.addMessage(userInput, 'user');
      }
      this.game.setPendingOptions([]); // 新一轮开始，清掉上一轮的行动选项
      this.game.clearAgentLog();
      this.game.clearAllAgentStatus();

      // 同步快照设置（上限/保留模式）到数据库，供本轮 advanceTurn→createSnapshot 读取
      await this.syncSnapshotSettings();

      // 2. 构建 endpoints & context
      const endpoints = this.buildEndpoints();
      const context = this.buildContext(userInput);
      this.currentContext = context;
      this.pendingPlotTasks = [];
      this.pendingAudioMarker = null;
      await this.loadPlotData(context);

      // 2.5 加载预设和世界书（自 fetch agent-config.json，不依赖 store 异步初始化）
      const { presets, agentDefaults } = await this.loadPresets();
      const worldBooks = await this.loadActiveWorldBooks();

      // 2.6 构建 Agent 配置（用已加载的 agentDefaults 替代 projectAgentDefaults）
      const agentConfigs = this.buildAgentConfigs(agentDefaults, onStoryChunk);

      // 真机修(2026-07-17): 侧链 (char/item/craft) 调用 buildAgentMessages 时需要
      // configs/worldBooks/presets 才能拿到完整 systemPrompt + 世界书上下文，
      // 把这三个值挂实例传给事件回调（回调通过闭包捕获 run() 局部变量）。
      this.chainData = { agentConfigs, worldBooks, presets };

      // 3. 创建编排器
      const options: OrchestratorOptions = {
        pipeline: DEFAULT_AGENT_PIPELINE,
        context,
        agentConfigs,
        endpoints,
        saveId: this.saveId,
        presets,
        worldBooks,
      };
      const events = this.buildEventHandlers();
      this.orch = new AgentOrchestrator(options, events);

      // 4. 运行管线
      const orchResult = await this.orch.run();

      // 🔒 P0-03: 仅在管线成功完成时推进回合 + 打快照。
      // 此前无论 agent 是否失败/中止都 advanceTurn，会消耗玩家输入却不产生有效回复，
      // 还把半成品状态存进快照。status='failed'（管线校验失败、必需阶段失败、或 abort
      // 让 story fetch 抛 AbortError）时跳过 —— 玩家输入已入消息流但回合不推进，可安全重发。
      // refreshFromDb 仍会把已部分落库的 patch 回读，不丢已生成的正文。
      if (orchResult.status !== 'completed') {
        console.warn(
          '[GamePipeline] 管线未完成 (status=' + orchResult.status + ')，跳过回合推进/快照',
        );
        return false;
      }

      // 4.5 步5: 等待剧情落库任务（preCheckPlot/postCheckPlot/年度大纲）完成
      if (this.pendingPlotTasks.length > 0) {
        await Promise.all(this.pendingPlotTasks);
        this.pendingPlotTasks = [];
      }

      // 5. 回合推进（M5 每轮一拍）: totalTurns +1 + 打 reason='turn' 快照。
      //    放在 finally 的 refreshFromDb 之前，Pinia 能立即读到新 totalTurns/activeSnapshotId。
      try {
        await createStateManager(this.saveId).advanceTurn();
      } catch (err) {
        console.warn('[GamePipeline] advanceTurn 失败（不阻塞本轮）:', err);
      }

      return true;
    } catch (err) {
      // Abort 错误不视为真正的失败
      if ((err as Error)?.name === 'AbortError') {
        console.log('[GamePipeline] 管线已中止');
        return false;
      }
      console.error('[GamePipeline] 管线运行失败:', err);
      this.game.addMessage('[系统] AI 调用失败，请检查 API 配置后重试。', 'assistant');
      return false;
    } finally {
      // 🆕 管线中 StateManager / 侧链 (char_gen/item_gen/craft_gen) 直接写 Dexie，
      // 这里统一回读，让 Pinia 内存态（characters/metadata/saveProfile）与 DB 对齐，
      // DebugPanel 导出和右侧状态栏才能拿到最新数据。abort/报错时部分 patch 可能已提交，同样需要回读。
      await this.game.refreshFromDb();
      // 🎵 配乐放在**回读之后**才触发。
      //
      // story 在 Stage 1 就写下了标记，但那时 player.location / character.present
      // 还是上一轮的值 —— 它们要等 Stage 2 的 request_dispatcher / vars_update 落库、
      // 再经这里的 refreshFromDb 才更新。而**转场恰恰是唯一真正该换歌的时刻**：
      // 在 Stage 1 播，正文已经进了熔火裂谷，BGM 还在放上一座城的曲子。
      this.flushPendingAudio();
      this.game.isGenerating = false;
      this.abortController = null;
    }
  }

  /**
   * 🎵 本轮配乐的唯一出口。两条来源，**AI 标记优先**:
   *
   * 1. story 写了 `<play_audio>` —— 它知道这一刻的戏剧意图（要打起来了 / 气氛转冷），
   *    比"地点变了"这个纯事实更准；
   * 2. 否则看地点有没有变 —— 这是场景配乐的主路径，绝大多数换歌都由它触发。
   *
   * 地点**没变就不动音乐**：同一个地点里来回走动、翻面板不该反复重选曲子。
   * （即便重选出同一首，store 那层的"同曲不重播"也会挡住，这里只是不做无用功。）
   *
   * 不 await —— 配乐是旁路氛围，出问题不该影响这一轮。管线被 abort / 报错时同样
   * 会走到这里：正文可能已经产出，该换的歌照换。
   */
  private flushPendingAudio(): void {
    const marker = this.pendingAudioMarker;
    this.pendingAudioMarker = null;

    // 用户关掉了场景配乐 → 两条来源都不生效，音乐完全交回给用户
    if (this.settings.settings.audioSceneAutoPlay === false) {
      this.lastAudioLocation = this.game.player?.location ?? '';
      return;
    }

    if (marker) {
      this.lastAudioLocation = this.game.player?.location ?? '';
      void this.handlePlayAudio(marker).catch((err) => {
        console.warn('[GamePipeline] 场景配乐失败（不阻塞本轮）:', err);
      });
      return;
    }

    const location = this.game.player?.location ?? '';
    if (!location || location === this.lastAudioLocation) return;
    this.lastAudioLocation = location;
    void this.playForLocation(location).catch((err) => {
      console.warn('[GamePipeline] 场景配乐失败（不阻塞本轮）:', err);
    });
  }

  /**
   * 按当前地点选曲。在场角色一并带上 —— 有专属主题曲的角色在场时，
   * 打分器会在"地点已经泛到势力一级"时让人物主题接管（见说明书第八节的权重表）。
   */
  private async playForLocation(location: string): Promise<void> {
    const audio = useAudioStore();
    await audio.playByScene({
      location,
      characters: this.presentCharacterNames(),
    });
  }

  /** 在场 NPC 的名字（player 不算） */
  private presentCharacterNames(): string[] {
    return this.game.characters
      .filter((c) => c.type !== 'player' && c.present === true)
      .map((c) => c.name);
  }

  /**
   * 🎵 进场配乐。装好存档、进入游戏页时调一次 —— 「进入某个地点就该响起它的曲子」
   * 对读档回来的第一眼同样成立，不该非要等玩家先说一句话。
   *
   * 同时把 lastAudioLocation 定下来，于是紧接着的第一轮不会为同一个地点再选一次。
   * 曲库装载（init）由调用方负责，这里只管选曲。
   */
  async primeSceneAudio(): Promise<void> {
    if (this.settings.settings.audioSceneAutoPlay === false) return;
    const location = this.game.player?.location ?? '';
    if (!location || location === this.lastAudioLocation) return;
    this.lastAudioLocation = location;
    try {
      await this.playForLocation(location);
    } catch (err) {
      console.warn('[GamePipeline] 进场配乐失败（不阻塞）:', err);
    }
  }

  /** 中止当前管线运行 */
  abort(): void {
    this.abortController?.abort();
    this.game.isGenerating = false;
  }

  // ===== 私有方法 =====

  private buildAgentConfigs(
    agentDefaults: Record<
      string,
      { presetId?: string; systemPrompt?: string; template?: string; ejsVarsCommit?: boolean }
    >,
    onStoryChunk?: StoryChunkCallback,
  ): AgentConfig[] {
    const s = this.settings.settings;

    // 需要参与管线的所有 Agent（不包括 plot_pre_check/plot_post_check — 剧情模式 off 时会自动禁用）
    const agentIds = [
      'memory_recall',
      'story',
      'request_dispatcher',
      'vars_update',
      'memory_summary',
      'plot_pre_check',
      'plot_post_check', // Phase 10g: quest 委托管线需要
      'craft_gen', // 侧链: 制作生成，需完整 systemPrompt (真机 fix 2026-07-18)
      'char_gen', // 侧链: 角色生成，需完整 systemPrompt
      'item_gen', // 侧链: 物品生成，需完整 systemPrompt + {{ITEM_REQUEST}} 占位符
    ];

    // 复用 buildEndpoints() 的映射结果（ApiEntry.model → ApiEndpoint.defaultModel）
    const apiPool = this.buildEndpoints();

    // agentModels 存 API 池 id → 匹配对应端点
    const getEndpoint = (agentId: string): ApiEndpoint | undefined => {
      const poolId = (s.agentModels as Record<string, string>)[agentId] || '';
      return apiPool.find((ep) => ep.id === poolId) || apiPool[0];
    };

    return agentIds.map((agentId) => {
      const isStory = agentId === 'story';
      const signal = this.abortController?.signal;
      const endpoint = getEndpoint(agentId);
      const model = endpoint?.defaultModel || '';
      if (!model) {
        console.error(
          `[GamePipeline] agent "${agentId}" — 未配置模型！请在设置页为该 Agent 选择 API 池并确保池中有默认模型`,
        );
      }
      console.log('[GamePipeline] agent:', agentId, 'endpoint:', endpoint?.id, 'model:', model);

      // 🆕 为 story agent 构建流式回调（如果提供了 onStoryChunk）
      let streamCallbacks: StreamCallbacks | undefined;
      if (isStory && onStoryChunk) {
        streamCallbacks = {
          onChunk: (text: string, isComplete: boolean) => {
            onStoryChunk(text, isComplete);
          },
          onComplete: () => {
            // 流式完成 — 最终结果由 handleAgentResult 处理
          },
          onError: (error: string) => {
            console.warn('[GamePipeline] story 流式错误:', error);
          },
        };
      }

      // 从已加载的 agentDefaults 取 presetId/systemPrompt/template
      // （loadPresets 已自 fetch agent-config.json，不依赖 store.projectAgentDefaults 异步初始化）
      const defaults = agentDefaults[agentId] ?? {};
      // 真机修(2026-07-17): story 预设尊重设置页选中项（s.activePresetId）——
      // 此前硬绑 agent-config.json 出厂 presetId，用户导入/另存的预设（新 id）在设置页编辑得再对，
      // 运行时也永远用旧的那份（"我保存了第二人称但 agent 没拿到"根因）。
      const presetId: string | undefined =
        agentId === 'story' && (s.activePresetId as string)
          ? (s.activePresetId as string)
          : defaults.presetId || undefined;
      const systemPrompt: string | undefined = defaults.systemPrompt || undefined;
      const template: string | undefined = defaults.template || undefined;

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
        // 工坊 P2 (ADR-30 D5): 只有持权 Agent 的装配 pass 产出 EJS vars 提交候选。
        // 代码级兜底：agent-config.json 没加载上（fetch 失败/离线）或该 agent 未声明本字段时，
        // story 默认持权 —— 与设计「默认仅 story 持权」一致。否则一次网络抖动就让整条
        // EJS→vars 提交链静默哑火（EJS 照跑、写照丢，无任何征兆）。显式 false 仍然生效。
        ejsVarsCommit: defaults.ejsVarsCommit ?? isStory,
        toolsEnabled: ['craft_gen', 'char_gen', 'item_gen'].includes(agentId),
        maxToolCallRounds: 10,
        // 🆕 流式 + abort 信号
        streamCallbacks,
        abortSignal: signal,
      } as AgentConfig;
    });
  }

  private buildEndpoints(): ApiEndpoint[] {
    const s = this.settings.settings;
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
      defaultModel: entry.defaultModel || entry.model || '', // ← 关键：ApiEntry.model → ApiEndpoint.defaultModel
      models: entry.models || [],
      timeout: entry.timeout ?? 60000,
      enableThinking: entry.enableThinking ?? false, // API 池思考链开关
    })) as ApiEndpoint[];
  }

  private buildContext(userInput: string): AgentContext {
    // 构建历史消息（只取 user/assistant，不含 system）
    const history = this.game.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ ...m }));

    // 步5: 读存档级剧情配置（捏人页 startJourney 落 metadata.plotSettings）；老存档无字段 → off 兜底
    const meta = this.game.activeSave?.metadata as Record<string, any> | undefined;
    const plotSettings = meta?.plotSettings ?? { mode: 'off', tabooContent: '' };

    return {
      userInput,
      history,
      lorebookMatches: [],
      worldBooks: [],
      characters: this.game.characters,
      variables: this.game.saveProfile?.variables ?? {}, // M5 §12: 变量唯一真源 SaveProfile.variables（M6 收官接线）
      plotEvents: this.game.activePlotEvents,
      memories: this.game.recentMemories,
      quests: this.game.saveProfile?.quests,
      agentOutputs: new Map(),
      plotSettings,
      gameTime: this.game.gameTime ?? undefined,
      // 工坊 P2 (ADR-30 D4/D9): stats 只读投影每回合构建一次，同回合多 Agent 装配复用
      //（各 pass 在 buildAgentMessages 内再克隆一份，杜绝跨 pass 写泄漏）
      statData: buildStatData({
        characters: this.game.characters,
        gameTime: this.game.saveProfile?.gameTime,
        fp: this.game.saveProfile?.fp,
      }),
      // 工坊 P2 (ADR-30 D5): 持权 Agent 的 vars 草稿运输容器；提交由回合结算消费（T6）
      ejsVarsDrafts: new Map(),
    };
  }

  /** 步5: mode≠off 时从 DB 加载大纲 + 全量剧情事件（Pinia 的 activePlotEvents 可能滞后）挂到 context */
  private async loadPlotData(context: AgentContext): Promise<void> {
    if (context.plotSettings?.mode === 'off') return;
    try {
      const { getLatestPlotOutline, getPlotEvents } = await import('@engine/database');
      const [outline, events] = await Promise.all([
        getLatestPlotOutline(this.saveId),
        getPlotEvents(this.saveId),
      ]);
      if (outline) (context as any).plotOutline = outline;
      if (events?.length) context.plotEvents = events;
    } catch (err) {
      console.warn('[GamePipeline] 剧情数据加载失败（不阻塞本轮）:', err);
    }
  }

  /** 加载 story 预设：DB 优先（用户可修改）→ agent-config.json 内嵌 preset fallback 补齐缺失。
   *  同时返回各 agent 的默认配置（presetId/systemPrompt/template），
   *  自给自足 fetch agent-config.json，不依赖 store 的 projectAgentDefaults 异步加载时序。 */
  private async loadPresets(): Promise<{
    presets: AgentPreset[];
    agentDefaults: Record<
      string,
      { presetId?: string; systemPrompt?: string; template?: string; ejsVarsCommit?: boolean }
    >;
  }> {
    let presets: AgentPreset[] = [];
    const agentDefaults: Record<
      string,
      { presetId?: string; systemPrompt?: string; template?: string; ejsVarsCommit?: boolean }
    > = {};

    // 1. DB 优先：用户可能通过设置页修改过预设
    try {
      const { getPresets } = await import('@engine/database');
      const dbPresets = await getPresets();
      if (dbPresets && dbPresets.length > 0) {
        presets = dbPresets as unknown as AgentPreset[];
      }
    } catch {
      // IndexedDB 不可用时静默跳过
    }

    // 2. 直接 fetch agent-config.json（不依赖 store.projectAgentDefaults 异步初始化时序）
    try {
      const res = await fetch('/data/defaults/agent-config.json');
      if (res.ok) {
        const config = await res.json();
        const agents = config.agents || {};
        for (const [agentId, entry] of Object.entries(agents)) {
          const e = entry as any;
          // 提取内嵌预设（story 等依赖 ST 预设的 Agent）
          if (e.preset && !presets.some((p) => p.id === (e.preset as any).id)) {
            presets.push(e.preset as unknown as AgentPreset);
          } else if (e.preset) {
            // 真机诊断(2026-07-17): DB 版预设（设置页编辑过的）优先于 agent-config.json 内嵌版 — 设计行为。
            // 直接改 agent-config.json 不会生效于已存在的 DB 记录；要么在设置页编辑，要么删除 DB 预设回落出厂版。
            console.warn(
              `[GamePipeline] 预设 "${(e.preset as any).name ?? (e.preset as any).id}" 使用 DB 版本（设置页编辑优先），agent-config.json 内嵌版被忽略`,
            );
          }
          // 提取各 agent 默认配置（供 buildAgentConfigs 使用）
          agentDefaults[agentId] = {
            presetId: e.presetId || undefined,
            systemPrompt: e.systemPrompt || undefined,
            template: e.template || undefined,
            // 工坊 P2 (ADR-30 D5): EJS vars 提交权（出厂仅 story 置 true）。
            // 字段缺席时保留 undefined（不塌成 false）——由 buildAgentConfigs 走代码级兜底。
            ejsVarsCommit: typeof e.ejsVarsCommit === 'boolean' ? e.ejsVarsCommit : undefined,
          };
        }
      } else {
        console.warn(
          `[GamePipeline] agent-config.json 请求失败 (HTTP ${res.status})，Agent 默认配置回落（EJS vars 提交权走代码兜底）`,
        );
      }
    } catch (err) {
      // 不再静默：这份配置是 systemPrompt / template / ejsVarsCommit 的唯一来源，
      // 加载失败会让各 Agent 回落到 localStorage 版本、并让 EJS vars 提交权走代码级兜底
      // （见 buildAgentConfigs 的 `defaults.ejsVarsCommit ?? isStory`）。必须留痕。
      console.warn(
        '[GamePipeline] agent-config.json 加载失败，Agent 默认配置回落（EJS vars 提交权走代码兜底）:',
        err,
      );
    }

    return { presets, agentDefaults };
  }

  /** 加载启用世界书：统一数据源（store 优先 + 文件兜底），与 plot_outline 共用 */
  private async loadActiveWorldBooks(): Promise<WorldBook[]> {
    try {
      // 统一数据源：worldbook-store 优先（Dexie，含用户在 WorldBookEditor 的 enabled 修改
      // + 自建书 + 工坊书）+ 文件兜底。init() 幂等，保证「消费必在迁移之后」。
      // catch 兼顾单测里没有 activePinia 的场景 —— 与迁移前的空数组行为一致。
      const wb = useWorldBookStore();
      await wb.init();
      const all = await loadWorldBooksWithFallback(wb.books as WorldBook[]);
      const enabledEntries = this.game.activeSave?.metadata?.enabledWorldBookEntries ?? [];
      return filterBooksByEnabledEntries(all, enabledEntries);
    } catch {
      return [];
    }
  }

  /** 获取当前默认 API endpoint */
  private getDefaultEndpoint(): ApiEndpoint {
    return this.buildEndpoints()[0];
  }

  /** 按 agentId 解析 endpoint —— 尊重设置页 s.agentModels 映射；
   *  未配置或映射失效时回退到默认 endpoint（与 createAgentClients 一致）。
   *  修复(2026-07-30): 此前 char_gen/item_gen/craft_gen/combat 等侧链一律走
   *  getDefaultEndpoint()（API 池第一项），无视用户在设置页为各 Agent 选的 API 池，
   *  导致"全部设了 glm5.2，侧链却用 d4f"。 */
  private getEndpointForAgent(agentId: string): ApiEndpoint {
    const s = this.settings.settings;
    const apiPool = this.buildEndpoints();
    const poolId = (s.agentModels as Record<string, string>)[agentId] || '';
    return apiPool.find((ep) => ep.id === poolId) || apiPool[0];
  }

  /** 创建 AgentClient 工厂 —— 供 craft_gen / char_gen / item_gen 链使用。
   *  🆕 包裹一层 LogClient：拦截 chat / chatWithTools，自动写 agentLog，
   *  让侧链 Agent 在 DebugPanel 可见（否则绕过 orchestrator 时无日志）。 */
  private getClientFactory() {
    const saveId = this.saveId;
    const game = this.game;
    return (agentId: string, endpoint: ApiEndpoint, _saveId: string) => {
      const real = new AgentClient({ endpoint, agentId, saveId });
      const label = AGENT_LABELS[agentId] ?? agentId;
      let callSeq = 0;

      const record = (
        messages: Array<{ role: string; content: string | null }>,
        result:
          | {
              rawResponse?: string;
              output?: string | null;
              reasoning?: string;
              tokensUsed?: number;
              cacheHit?: boolean;
              cacheHitTokens?: number;
              cacheMissTokens?: number;
              completionTokens?: number;
              error?: string;
              duration?: number;
            }
          | undefined,
        duration: number,
      ) => {
        callSeq += 1;
        // 同一 Agent 一轮内被多次调用时（如 2 个新角色 → char_gen 跑 2 次），
        // addAgentLogEntry 按 agentId 覆盖同名条目，故给 agentId/label 加序号后缀避免互相覆盖。
        const seqId = callSeq > 1 ? `${agentId}#${callSeq}` : agentId;
        game.addAgentLogEntry({
          agentId: seqId,
          label: callSeq > 1 ? `${label} #${callSeq}` : label,
          endpointId: endpoint.id,
          endpointName: endpoint.name || '',
          baseUrl: endpoint.baseUrl || '',
          model: endpoint.defaultModel || '',
          messages: (messages ?? []).map((m) => ({ role: m.role, content: m.content })),
          rawResponse: result?.rawResponse ?? result?.output ?? '',
          reasoning: result?.reasoning,
          error: result?.error,
          tokensUsed: result?.tokensUsed ?? 0,
          cacheHit: result?.cacheHit ?? false,
          cacheHitTokens: result?.cacheHitTokens,
          cacheMissTokens: result?.cacheMissTokens,
          completionTokens: result?.completionTokens,
          duration: result?.duration ?? duration,
        });
      };

      const startTs = () => Date.now();

      // 从 chat 方法入参提取 messages：chat(messages, signal) 入参是数组本身，
      // chatWithTools(request, ...) 入参是 { messages, ... } 对象 —— 两者形状不同，需兼容。
      const extractMessages = (arg: any): Array<{ role: string; content: string | null }> =>
        Array.isArray(arg) ? arg : (arg?.messages ?? []);

      // 包裹对象：与 AgentClient 同形状，拦截关键方法
      return {
        get agentId() {
          return agentId;
        },
        get endpoint() {
          return endpoint;
        },
        chat: async (request: any, signal?: any) => {
          const t0 = startTs();
          let result: any;
          try {
            result = await real.chat(request, signal);
          } catch (err: any) {
            record(
              extractMessages(request),
              { error: String(err?.message ?? err) },
              Date.now() - t0,
            );
            throw err;
          }
          record(extractMessages(request), result, Date.now() - t0);
          return result;
        },
        chatWithTools: async (request: any, toolExecutor: any, options?: any) => {
          const t0 = startTs();
          let result: any;
          try {
            result = await real.chatWithTools(request, toolExecutor, options);
          } catch (err: any) {
            record(
              extractMessages(request),
              { error: String(err?.message ?? err) },
              Date.now() - t0,
            );
            throw err;
          }
          record(extractMessages(request), result, Date.now() - t0);
          return result;
        },
        // chatStream 不常用（侧链不走流式），直接透传
        chatStream: (request: any, callbacks: any, signal?: any) =>
          real.chatStream(request, callbacks, signal),
      } as any;
    };
  }

  // ===== 工坊 P2 (ADR-30 D5): EJS `vars` 差量提交 =====

  /**
   * 把一个 stage 内持权 Agent 的 EJS `vars` 草稿差量落库。
   *
   * **由 Orchestrator 在「本 stage 的 Agent 全跑完、标记处理之前」await 调用**——
   * vars_update / request_dispatcher 的 AI 变量补丁正是在标记处理里提交的，
   * 所以这个位置就是契约里那句「EJS 差量先落、AI 补丁后落」的物理落点：
   * 同路径冲突时 AI 覆盖 EJS（设计 §0 / D5）。
   *
   * 顺序口径: **管线阶段序**（本方法每 stage 调一次，天然按阶段推进）
   * + **同阶段 agentId 字典序**（下面的 `.sort()`）。与 D5 白纸黑字一致。
   *
   * 整条路径不抛错 —— EJS 是簿记旁路，出问题不该吞掉本轮正文。
   */
  private async flushEjsVarsDiffs(agentIds: string[]): Promise<void> {
    const drafts = this.currentContext?.ejsVarsDrafts;
    if (!drafts || drafts.size === 0) return;

    // 同阶段字典序 —— 多个持权 Agent 时后者同路径覆盖前者，顺序必须确定
    const ordered = [...agentIds].filter((id) => drafts.has(id)).sort();
    if (ordered.length === 0) return;

    const diffs: EjsVarsDiff[] = [];
    for (const agentId of ordered) {
      const entry = drafts.get(agentId);
      // 消费即摘表: 同一份草稿不会在后续 stage 被重复提交
      drafts.delete(agentId);
      if (!entry) continue;

      let diff: EjsVarsDiff;
      try {
        diff = diffVars(entry.base ?? {}, entry.draft ?? {});
      } catch (err) {
        console.warn(`[GamePipeline] EJS 变量差量计算失败（来源 ${agentId}），跳过:`, err);
        continue;
      }
      // 空 diff 不传 —— 绝大多数回合世界书只读不写，不该白跑一次写事务
      if (diff.replace.length === 0 && diff.remove.length === 0) continue;

      const size = measureDiffSize(diff);
      if (size > EJS_DIFF_SIZE_LIMIT) {
        // 整份拒绝: 不截断、不部分提交（截断状态机的半棵写入比冻结它更糟）
        this.rejectEjsVarsDiff(agentId, size);
        continue;
      }
      diffs.push(diff);
    }

    if (diffs.length === 0) return;

    try {
      const result = await createStateManager(this.saveId).commitChatState([], {
        ejsVarsDiffs: diffs,
      });
      if (result.errors.length > 0) {
        console.warn('[GamePipeline] EJS 变量差量落库报错:', result.errors);
      }
    } catch (err) {
      console.warn('[GamePipeline] EJS 变量差量落库失败（不阻塞本轮）:', err);
    }
  }

  /** 体积护栏拒绝: console.warn + 累计诊断行 + 每存档每来源一次 toast */
  private rejectEjsVarsDiff(agentId: string, size: number): void {
    const label = AGENT_LABELS[agentId] ?? agentId;
    console.warn(
      `[GamePipeline] EJS 变量差量超限，整份拒绝 —— 来源 ${agentId} · ${size} 字节 > 上限 ${EJS_DIFF_SIZE_LIMIT}`,
    );

    // 诊断行（DebugPanel 可查、随导出 JSON 带走）—— 拒绝不能只活在一次 toast 里
    try {
      this.game.recordEjsVarsRejection?.(agentId, label, size);
    } catch (err) {
      console.warn('[GamePipeline] 记录 EJS 拒绝诊断失败:', err);
    }

    if (this.ejsRejectToasted.has(agentId)) return;
    this.ejsRejectToasted.add(agentId);
    try {
      useUIStore().toast(
        `「${label}」的世界书变量写入超出 ${Math.round(EJS_DIFF_SIZE_LIMIT / 1024)} KB 上限，本轮整份丢弃（详情见调试面板）`,
        'warning',
        6000,
      );
    } catch (err) {
      console.warn('[GamePipeline] EJS 拒绝提示失败:', err);
    }
  }

  /** 获取（或懒创建）StateManager 实例 */
  private getStateManager() {
    const sm = createStateManager(this.saveId);
    return sm
      ? {
          commitChatState: async (patches: any[]) => {
            const result = await sm.commitChatState(patches);
            if (result.errors.length > 0) {
              console.error(
                `[GamePipeline] 状态提交失败 ${result.errors.length}/${patches.length} 条:`,
                result.errors,
              );
              this.game.addMessage(
                `[系统] 部分状态未能写入 (${result.errors.length} 条): ${result.errors.join('；')}`,
                'assistant',
              );
            } else if (result.patchesApplied < patches.length) {
              console.warn(
                `[GamePipeline] 部分 patch 验证失败未生效: ${result.patchesApplied}/${patches.length}`,
              );
            }
          },
        }
      : undefined;
  }

  /**
   * 🎵 <play_audio> → 场景选曲。
   *
   * **地点与在场角色不从标记读，从游戏状态读** —— 它们已经是状态里的事实
   * （`player.location` / `character.present`），让 AI 再写一遍只会多一处漂移源。
   * 标记只提供 AI 独有的判断：此刻是什么情绪、什么情境。
   *
   * 整条路径不抛错：配乐是旁路氛围，音频出问题不该影响这一轮叙事。
   */
  private async handlePlayAudio(marker: PlayAudioMarker): Promise<void> {
    const audio = useAudioStore();

    if ((marker.action ?? '').trim().toLowerCase() === 'stop') {
      audio.stop();
      return;
    }

    // 逗号 / 顿号 / 空白分隔的自由词
    const words = (raw?: string): string[] =>
      (raw ?? '')
        .split(/[,，、;；\s]+/)
        .map((w) => w.trim())
        .filter(Boolean);

    // 正文里的自由词不知道属于哪一维，情绪与情境都试一遍（与"无类型标签"同理）
    const body = words(marker.bodyText);
    const situations = [...words(marker.situation), ...body];
    const moods = [...words(marker.mood), ...body];

    const characters = marker.character ? words(marker.character) : this.presentCharacterNames();

    const variant = marker.variant?.trim().toUpperCase();

    await audio.playByScene({
      location: this.game.player?.location || undefined,
      characters,
      moods,
      situations,
      variant: variant === 'A' || variant === 'B' ? variant : undefined,
    });
  }

  private buildEventHandlers(): OrchestratorEvents {
    return {
      // 🎵 配乐：只暂存，**不在 Stage 1 就播** —— 见 run() 末尾的说明
      onPlayAudio: (marker) => {
        this.pendingAudioMarker = marker;
      },

      // 工坊 P2 (D5): stage 跑完 → EJS 差量落库 → 才轮到本 stage 的 AI 补丁
      onEjsVarsFlush: (agentIds) => this.flushEjsVarsDiffs(agentIds),

      // === Stage 回调 ===
      onAgentStart: (agentId, config) => {
        console.log(`[GamePipeline] Agent 开始: ${agentId}`);
        this.game.updateAgentStatus(agentId);
        // 初始化日志空条目 (等 complete 时补全 messages + result)
        this.game.addAgentLogEntry({
          agentId,
          label: AGENT_LABELS[agentId] ?? agentId,
          endpointId: config.apiEndpointId,
          endpointName: '', // 暂不解析 endpoint name，后续从 buildEndpoints 传入时再补
          baseUrl: '',
          model: config.model,
          messages: [],
          rawResponse: '',
          tokensUsed: 0,
          cacheHit: false,
          duration: 0,
        });
      },
      onAgentComplete: (result) => {
        this.game.clearAgentStatus(result.agentId, result.error);
        // 补全本轮已启动日志的剩余字段（保留 onAgentStart 写入的占位条目）
        const prev = this.game.agentLog.find((e) => e.agentId === result.agentId);
        this.game.addAgentLogEntry({
          agentId: result.agentId,
          label: prev?.label ?? AGENT_LABELS[result.agentId] ?? result.agentId,
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
          cacheHitTokens: result.cacheHitTokens,
          cacheMissTokens: result.cacheMissTokens,
          completionTokens: result.completionTokens,
          duration: result.duration,
        });
        this.handleAgentResult(result);
      },
      onAgentError: (agentId, error) => {
        console.error(`[GamePipeline] Agent 错误: ${agentId}`, error);
        this.game.clearAgentStatus(agentId, error);
        // 补充错误日志
        const prev = this.game.agentLog.find((e) => e.agentId === agentId);
        this.game.addAgentLogEntry({
          agentId,
          label: prev?.label ?? AGENT_LABELS[agentId] ?? agentId,
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
        });
      },

      onStateCommitError: (source, errors) => {
        console.error(`[GamePipeline] ${source} 状态提交失败:`, errors);
        this.game.addMessage(
          `[系统] ${source} 部分状态未能写入: ${errors.join('；')}`,
          'assistant',
        );
      },

      // === Marker 回调 ===
      onCombatTrigger: async (marker, storyOutput) => {
        return await this.handleCombatTrigger(marker, storyOutput);
      },
      onCraftGenRequest: async (markers, _varsOutput, ctx) => {
        await this.handleCraftGen(markers, ctx);
      },
      onCharGenRequest: async (markers, _varsOutput, ctx) => {
        await this.handleCharGen(markers, ctx);
      },
      onItemGenRequest: async (markers, _varsOutput, ctx) => {
        await this.handleItemGen(markers, ctx);
      },
    };
  }

  /** 处理单个 Agent 完成 */
  private async handleAgentResult(result: AgentResult) {
    switch (result.agentId) {
      case 'story': {
        // rawResponse 直接就是 AI 返回的字符串正文（流式模式下也是完整文本）
        if (result.rawResponse) {
          const { content, options } = extractStoryOptions(result.rawResponse);
          this.game.setPendingOptions(options);
          // 配乐标记没有渲染意义，漏出去就是玩家眼前的一行尖括号
          this.game.addMessage(stripPlayAudioMarkers(content).trim(), 'assistant');
        }
        break;
      }
      case 'memory_summary': {
        await this.persistMemorySummary(result);
        break;
      }
      case 'plot_pre_check': {
        this.handlePlotPreCheck(result);
        break;
      }
      case 'plot_post_check': {
        const task = this.persistPlotPostCheck(result);
        this.pendingPlotTasks.push(task);
        await task;
        break;
      }
    }
  }

  /** 步5: 从 rawResponse 提取 <json> 块内容（兼容裸 JSON） */
  private static extractJsonBlock(raw: string): string {
    const match = raw.match(/<json>([\s\S]*?)<\/json>/);
    return match ? match[1].trim() : raw;
  }

  /**
   * 步5: pre_check 完成 →
   * 1. 同步解析 directive/relevantBackground 并注入剧情导演区块到 context.agentOutputs
   *    （story 在 Stage 1 经 {{AGENT.PLOT_PRE_CHECK}} 占位符读取，必须在 story 启动前同步写入）
   * 2. 异步 preCheckPlot() 落库事件激活（pending→active + visibility→revealed）
   */
  private handlePlotPreCheck(result: AgentResult) {
    const raw = result.rawResponse || '';
    if (!raw) return;
    const jsonStr = GamePipeline.extractJsonBlock(raw);

    try {
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : jsonStr);
      const background: string = parsed.relevantBackground || '';
      const directive: string = parsed.directive || parsed.outlineRelevance || '';
      const blocks: string[] = [];
      if (background) blocks.push(`**剧情背景（须自然编织进正文）:**\n${background}`);
      if (directive) blocks.push(`**本轮推进建议:**\n${directive}`);
      if (blocks.length > 0) {
        this.currentContext?.agentOutputs.set(
          'plot_pre_check',
          `<剧情导演>\n${blocks.join('\n\n')}\n</剧情导演>`,
        );
      }
    } catch (err) {
      console.warn('[GamePipeline] plot_pre_check 解析失败（不阻塞本轮）:', err);
    }

    const task = (async () => {
      try {
        const { preCheckPlot } = await import('@engine/plot-engine');
        const { triggeredEvents } = await preCheckPlot(
          this.saveId,
          jsonStr,
          this.currentContext?.variables ?? {},
        );
        if (triggeredEvents.length > 0) {
          console.log(
            `[GamePipeline] plot_pre_check 激活事件: ${triggeredEvents.map((e) => e.title).join('、')}`,
          );
        }
      } catch (err) {
        console.warn('[GamePipeline] preCheckPlot 落库失败（不阻塞本轮）:', err);
      }
    })();
    this.pendingPlotTasks.push(task);
  }

  /** 步5: post_check 完成 → postCheckPlot() 落库（事件状态/新子事件/大纲版本）→ 完成/失败事件转记忆 → 年度大纲检测 */
  private async persistPlotPostCheck(result: AgentResult): Promise<void> {
    const raw = result.rawResponse || '';
    if (!raw) return;
    try {
      const { postCheckPlot, eventToMemory } = await import('@engine/plot-engine');
      const jsonStr = GamePipeline.extractJsonBlock(raw);
      const outcome = await postCheckPlot(this.saveId, jsonStr);

      // 完成/失败事件 → 高重要度记忆
      const terminal = outcome.eventsUpdated.filter(
        (e) => e.status === 'completed' || e.status === 'failed',
      );
      if (terminal.length > 0) {
        const { saveMemory } = await import('@engine/database');
        const gt = this.currentContext?.gameTime;
        const timeStr = gt ? `${gt.era}${gt.year}年${gt.month}月${gt.day}日` : '未知';
        for (const event of terminal) {
          const mem = eventToMemory(event, this.saveId, { start: timeStr, end: timeStr });
          await saveMemory({
            ...mem,
            id: `MEM${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 100)}`,
          } as MemoryRecord);
        }
        console.log(
          `[GamePipeline] plot_post_check 事件转记忆: ${terminal.map((e) => e.title).join('、')}`,
        );
      }
      if (outcome.worldLineChanged) {
        console.log(
          `[GamePipeline] 世界线变动: level=${outcome.changeLevel} outlineUpdated=${outcome.outlineUpdated}`,
        );
      }
    } catch (err) {
      console.warn('[GamePipeline] plot_post_check 落库失败（不阻塞本轮）:', err);
    }
  }

  /** 解析 memory_summary 输出并持久化到 IndexedDB */
  private async persistMemorySummary(result: AgentResult) {
    try {
      const raw = result.rawResponse || '';
      // 兼容 <json>...</json> 和裸 JSON 两种格式
      const jsonMatch = raw.match(/<json>([\s\S]*?)<\/json>/);
      const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw;
      const parsed = JSON.parse(jsonStr);

      if (!parsed.content || parsed.content.length < 50) {
        console.warn(
          '[GamePipeline] memory_summary content 过短，跳过落库:',
          parsed.content?.length,
        );
        return;
      }

      const { saveMemory } = await import('@engine/database');
      const now = Date.now();
      const id = `MEM${now.toString(36).toUpperCase()}`;

      const memory: MemoryRecord = {
        id,
        saveId: this.saveId,
        createdAt: now,
        realTimestamp: now,
        content: parsed.content || '',
        hiddenLine: parsed.hiddenLine || '',
        keywords: parsed.keywords || [],
        relatedCharacterIds: parsed.relatedCharacterIds || [],
        importance: typeof parsed.importance === 'number' ? parsed.importance : 5,
        timeRange: {
          start: parsed.timeRangeStart || '',
          end: parsed.timeRangeEnd || '',
        },
      };

      await saveMemory(memory);
      // 更新本地 recentMemories 供下一轮召回
      this.game.recentMemories = [...(this.game.recentMemories || []), memory];
      console.log(
        `[GamePipeline] memory_summary 落库成功: ${id} importance=${memory.importance} keywords=${memory.keywords.join(',')}`,
      );
    } catch (e) {
      console.error('[GamePipeline] memory_summary 解析/存储失败:', e);
    }
  }

  /** 处理战斗触发 — 唤起 combat agent 独立循环 (M4 任务 5.7) */
  private async handleCombatTrigger(
    marker: CombatTriggerMarker,
    storyOutput: string,
  ): Promise<CombatSummaryResult | null> {
    // 🆕 M2 feature flag（架构 §十四 14.5）：分支点唯一，v2 走现有 runCombat，v3 走 coordinator
    const engineVersion = this.settings?.settings?.combatEngineVersion ?? 'v2';
    if (engineVersion === 'v3') {
      return this.handleCombatTriggerV3(marker, storyOutput);
    }
    const endpoint = this.getEndpointForAgent('combat');
    if (!endpoint) {
      console.warn('[GamePipeline] combat 跳过: 未配置 API endpoint');
      return null;
    }
    try {
      const { runCombat } = await import('@engine/combat-runner');
      const { getEventBus } = await import('@engine/game-event');
      const context = this.currentContext ?? this.buildContext('');
      this.game.updateAgentStatus('combat');
      // M5: 激活战斗面板（isInCombat=true → 覆盖层挂起）+ 清空面板状态
      this.game.enterCombat();
      const result = await runCombat(
        {
          saveId: this.saveId,
          marker,
          storyOutput,
          context,
          endpoint,
          configs: this.chainData?.agentConfigs,
          worldBooks: this.chainData?.worldBooks,
          presets: this.chainData?.presets,
        },
        {
          clientFactory: this.getClientFactory(),
          stateManager: this.getStateManager(),
          eventBus: getEventBus(this.saveId),
          characters: this.game.characters,
          variables: context.variables,
          // M5: runner 注册玩家文本提交器 → store，前端 CombatActionBar 发送时调
          registerSubmitter: (submit) => this.game.setCombatSubmitter(submit),
          // readHooks 暂不传（物品/buff modifier 订阅留后续）
        },
        // M5: 事件流 → store（消息流 + 单位卡片 + 伤害面板数据源）
        (evt) => this.game.applyCombatEvent(evt),
      );
      this.game.clearAgentStatus('combat');
      // M5: 关闭战斗面板（isInCombat=false → 覆盖层滑出）
      this.game.exitCombat();
      // 摘要回注正文（架构 §12：战斗摘要注入对话流，Story 下一轮据此自然接续战斗后剧情）
      // 前缀【战斗摘要】帮 Story Agent 识别这是已结束战斗的总结
      if (result.narrativeSummary) {
        this.game.addMessage(`【战斗摘要】${result.narrativeSummary}`, 'assistant');
      }
      return result;
    } catch (err) {
      this.game.clearAgentStatus('combat', String(err));
      // M5: 出错也要关面板，否则覆盖层卡住
      this.game.exitCombat();
      console.error('[GamePipeline] combat 失败:', err);
      return null;
    }
  }

  /** 🆕 M2 v3 分支：走 v3 Coordinator（openCombat + runCombatV3）。 */
  private async handleCombatTriggerV3(
    marker: CombatTriggerMarker,
    _storyOutput: string,
  ): Promise<CombatSummaryResult | null> {
    const endpoint = this.getEndpointForAgent('combat_v3') ?? this.getEndpointForAgent('combat');
    if (!endpoint) {
      console.warn('[GamePipeline] combat_v3 跳过: 未配置 API endpoint');
      return null;
    }
    try {
      const context = this.currentContext ?? this.buildContext('');
      this.game.enterCombat();
      this.game.updateAgentStatus('combat_v3');

      const { runCombatV3 } = await import('@engine/combat-v3');
      const { characterToCombatParticipant } = await import('@engine/combat-resolver');

      // 组装 bundle：全部人物 → CombatParticipant（player → ally，其余 → enemy）
      const playerC = this.game.characters.find((c) => c.type === 'player');
      const participants = this.game.characters
        .filter((c) => c.hp > 0)
        .map((c) => characterToCombatParticipant(c, c.type === 'player' ? 'ally' : 'enemy'));
      const fpSnapshot = this.game.fp ?? 0;
      const bundle = {
        combatId: `v3-${Date.now()}-${this.saveId}`,
        combatType: (marker.combatType ?? '标准') as '标准',
        participants,
        rulesetRevision: 'v3-2026-07-31',
        resourceSnapshots: { FP: fpSnapshot },
      };
      if (participants.length === 0 || !playerC) {
        this.game.exitCombat();
        this.game.clearAgentStatus('combat_v3');
        return null;
      }

      // 前端 Command 桥：pending resolver，store.submitCombatCommand → coordinator.submit → resolve
      let pendingResolve: ((c: CombatCommand) => void) | null = null;
      const waitForCommand = () =>
        new Promise<CombatCommand>((resolve) => (pendingResolve = resolve));

      const result = await runCombatV3({
        saveId: this.saveId,
        bundle,
        deps: {
          clientFactory: this.getClientFactory(),
          endpoint,
          stateManager: this.getStateManager(),
          characters: this.game.characters,
          variables: context.variables,
          context,
          submitCommand: async () => {}, // 等待态由 v3_awaiting_player_input 事件驱动 store
          waitForCommand,
          abandon: () => {},
          // M2 缺省确定性骰源；后续可注入真实骰源
        },
        onCombatEvent: (evt) => this.game.applyCombatEvent(evt),
      });

      // 暴露 coordinator 句柄给 store（前端提交/放弃）
      this.game.setCombatCoordinator({
        submit: async (cmd: CombatCommand) => {
          if (pendingResolve) {
            const r = pendingResolve;
            pendingResolve = null;
            r(cmd);
          }
        },
        abandon: () => {
          if (pendingResolve) {
            const r = pendingResolve;
            pendingResolve = null;
            r({
              commandId: 'abandon',
              expectedRevision: 0,
              kind: 'PassAttack',
              actorId: '',
              cost: 'attack',
              payload: {},
            } as CombatCommand);
          }
        },
        waitForCommand,
      });

      this.game.clearAgentStatus('combat_v3');
      this.game.exitCombat(); // 战斗结束关面板（终局已由 onCombatEvent 置 v3ActiveCombat）
      if (result.narrativeSummary) {
        this.game.addMessage(`【战斗摘要】${result.narrativeSummary}`, 'assistant');
      }
      const summary: CombatSummaryResult = {
        narrativeSummary: result.narrativeSummary,
        patches: result.patches,
        totalExp: result.totalExp,
        totalFp: result.totalFp,
        loot: (result.loot as CombatSummaryResult['loot']) ?? [],
        rounds: result.rounds,
        outcome: result.outcome,
      };
      return summary;
    } catch (err) {
      this.game.clearAgentStatus('combat_v3', String(err));
      this.game.exitCombat();
      console.error('[GamePipeline] combat_v3 失败:', err);
      return null;
    }
  }

  /** 处理制作生成链 */
  private async handleCraftGen(markers: CraftGenRequestMarker[], ctx: AgentContext) {
    const endpoint = this.getEndpointForAgent('craft_gen');
    if (!endpoint) {
      console.warn('[GamePipeline] craft_gen 跳过: 未配置 API endpoint');
      return;
    }

    const { runCraftGenChain } = await import('@engine/craft-gen-chain');
    const clientFactory = this.getClientFactory();
    const stateManager = this.getStateManager();

    // 真机修(2026-07-17): try/catch 进循环 — 单制作链失败不阻断后续
    for (const marker of markers) {
      try {
        this.game.updateAgentStatus('craft_gen');
        const request = {
          saveId: this.saveId,
          marker,
          storyOutput: ctx.agentOutputs?.get('story') ?? '',
          context: ctx,
          endpoint,
          configs: this.chainData?.agentConfigs,
          worldBooks: this.chainData?.worldBooks,
          presets: this.chainData?.presets,
        } as any;
        const result = await runCraftGenChain(request, {
          clientFactory,
          stateManager,
        });
        this.game.clearAgentStatus('craft_gen');
        if (result.narrative) {
          this.game.addMessage(result.narrative, 'assistant');
        }
      } catch (err) {
        this.game.clearAgentStatus('craft_gen', String(err));
        console.error('[GamePipeline] craft_gen 链失败，继续处理剩余请求:', err);
      }
    }
  }

  /** 处理角色生成链 */
  private async handleCharGen(markers: CharGenRequestMarker[], ctx: AgentContext) {
    const endpoint = this.getEndpointForAgent('char_gen');
    if (!endpoint) {
      console.warn('[GamePipeline] char_gen 跳过: 未配置 API endpoint');
      return;
    }

    const { runCharGenChain } = await import('@engine/char-gen-agent');
    const clientFactory = this.getClientFactory();
    const stateManager = this.getStateManager();

    // 真机修(2026-07-17): try/catch 进循环 — 单 NPC 链失败(如输出截断)不再连锁抛弃后续请求
    for (const marker of markers) {
      try {
        this.game.updateAgentStatus('char_gen');
        const charGenRequest = {
          saveId: this.saveId,
          marker,
          context: ctx,
          endpoint,
          // 真机修: 完整 systemPrompt/世界书/预设注入（此前 undefined → stub 裸奔）
          configs: this.chainData?.agentConfigs,
          worldBooks: this.chainData?.worldBooks,
          presets: this.chainData?.presets,
        } as any;
        const result = await runCharGenChain(charGenRequest, {
          clientFactory,
          stateManager,
        });
        this.game.clearAgentStatus('char_gen');
        if (result.character) {
          // 添加新角色到 store
          this.game.characters.push(result.character);
          // 添加系统通知（非 assistant 叙事气泡）
          this.game.addSystemMessage({
            type: 'char_gen',
            characterName: result.character.name,
            race: result.character.race,
            tier: result.character.tier,
            narrative: result.narrativeSummary,
            details: result.character as any,
          });
        }
      } catch (err) {
        this.game.clearAgentStatus('char_gen', String(err));
        console.error(
          `[GamePipeline] char_gen 链失败 (${marker.attributes?.characterName ?? '未知角色'})，继续处理剩余请求:`,
          err,
        );
      }
    }
  }

  /** 处理独立物品生成链 (request_dispatcher 的 <item_gen_request>) */
  private async handleItemGen(
    markers: import('@engine/types').ItemGenRequestMarker[],
    ctx: AgentContext,
  ) {
    const endpoint = this.getEndpointForAgent('item_gen');
    if (!endpoint) {
      console.warn('[GamePipeline] item_gen 跳过: 未配置 API endpoint');
      return;
    }

    const { runItemGenChain } = await import('@engine/item-gen-chain');
    const clientFactory = this.getClientFactory();
    const stateManager = this.getStateManager();
    const storyOutput = ctx.agentOutputs?.get('story') ?? '';

    // 真机修(2026-07-17): try/catch 进循环 — 单物品链失败不阻断后续
    for (const marker of markers) {
      try {
        this.game.updateAgentStatus('item_gen');
        const request = {
          saveId: this.saveId,
          marker,
          storyOutput,
          context: ctx,
          endpoint,
          // 真机修: 完整 systemPrompt/世界书注入
          configs: this.chainData?.agentConfigs,
          worldBooks: this.chainData?.worldBooks,
          presets: this.chainData?.presets,
        };
        await runItemGenChain(request, {
          clientFactory,
          stateManager,
        });
        this.game.clearAgentStatus('item_gen');
        // 物品数据已由 stateManager 落库；run() finally 的 refreshFromDb() 会把
        // 最新 characters（含新物品/装备）回读进 Pinia，前端面板随之刷新。
      } catch (err) {
        this.game.clearAgentStatus('item_gen', String(err));
        console.error('[GamePipeline] item_gen 链失败，继续处理剩余请求:', err);
      }
    }
  }
}
