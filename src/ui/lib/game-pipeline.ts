/**
 * GamePipeline — 前端 ↔ AgentOrchestrator 桥接层
 *
 * Phase 10h: 连接 GamePage UI 和引擎 Agent 管线。
 * 封装: AgentConfig 组装 / AgentContext 构建 / 编排器创建 / 回调处理。
 *
 * Phase 7e: story agent 使用 chatStream() 逐块接收原文，
 * 通过 onStoryChunk 将累计的玩家可见投影实时推送到前端 UI。
 */
import { AgentOrchestrator } from '@engine/agent-orchestrator';
// Q-05：从模型输出抢救 JSON 的唯一入口（裸 / 围栏 / <json> / 前后夹带解说四种形态）
import { extractJsonPayload } from '@engine/model-json';
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
  PlayAudioMarker,
  MemoryRecord,
  WorkshopProject,
  CharacterState,
} from '@engine/types';
import type {
  ImageGenFailure,
  ImagePromptOutput,
  ImagePromptRequest,
  SceneImageMarker,
} from '@engine/types-image';
import { splitSceneImageSegments } from '@engine/image-segments';
import { stripMarkers } from '@engine/marker-protocol';
import { AgentClient } from '@engine/agent-client';
import type { StreamCallbacks } from '@engine/agent-client';
import { createStateManager } from '@engine/state-manager';
import { projectStoryOutput, projectStreamingStory } from '@engine/story-output';
import { loadWorldBooksWithFallback } from '@engine/builtin-worldbooks';
import { filterBooksByEnabledEntries } from '@engine/worldbook-loader';
import { buildStatData } from '@engine/stat-projection';
import { buildPassSeed } from '@engine/ejs-rng';

/** EJS `ui.log` 环形缓冲上限（能力面 §6.2） */
import { diffVars, measureDiffSize, EJS_DIFF_SIZE_LIMIT } from '@engine/ejs-vars-diff';
import type { EjsVarsDiff } from '@engine/ejs-vars-diff';
import type { useGameStore } from '../stores/game-store';
import type { useSettingsStore } from '../stores/settings-store';
import { useAudioStore } from '../stores/audio-store';
import { useWorldBookStore } from '../stores/worldbook-store';
import { useUIStore } from '../stores/ui-store';
import type { CombatCommand } from '@engine/combat-v3';
import { rollDice } from '@engine/dice';
import { getAgentSettings } from '../stores/agent-settings';

export interface GamePipelineDeps {
  gameStore: ReturnType<typeof useGameStore>;
  settingsStore: ReturnType<typeof useSettingsStore>;
  saveId: string;
}

/** 流式回调 — chunk 是累计的可见正文快照；isComplete=true 表示清理临时预览。 */
export type StoryChunkCallback = (chunk: string, isComplete: boolean) => void;

/** 兼容旧调用名；正文、控制区块与 `<option(s)>` 统一由 story-output 投影。 */
export function extractStoryOptions(raw: string): { content: string; options: string[] } {
  return projectStoryOutput(raw);
}

/** Resolve selected workshop books that explicitly declare system-core semantics. */
export function collectSelectedSystemCoreWorkshopBookIds(
  worldBooks: WorldBook[],
  projects: WorkshopProject[],
): string[] {
  const coreProjectIds = new Set(
    projects
      .filter((project) => project.tags?.some((tag) => tag.trim().toLowerCase() === 'system/core'))
      .map((project) => project.id),
  );
  if (coreProjectIds.size === 0) return [];

  return worldBooks
    .filter(
      (book) =>
        book.partition === 'creative_workshop' &&
        book.entries.some(
          (entry) =>
            entry.enabled &&
            Boolean(entry.extra?.workshop?.projectId) &&
            coreProjectIds.has(entry.extra!.workshop!.projectId),
        ),
    )
    .map((book) => book.id);
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

/**
 * 把方言的 systemPrompt **合并**进 `image_prompt` 那条 config（图像 v2 / C3·C5）。
 *
 * 为什么是「合并」而不是「另造一条」: `buildAgentMessagesAsync` 只从 `configs` 里认
 * systemPrompt，而**同一条 config 还带着这个 agent 的全部 LLM 旋钮**（模型 / 温度 /
 * maxTokens / 世界书 —— `image-prompt-agent` 会把它们再查一遍）。新造一条顶掉原来的，
 * 用户在设置页调的模型与采样参数就全部静默回落成缺省 —— 不报错，只是这条侧链换了个
 * 模型在跑。所以这里克隆整条、只换那一格。
 *
 * @param override 空 / 只剩空白 / undefined → 原样返回（走 agent-config 或模板兜底，
 *   即图像 v1 行为）。🔴 **空白也要挡**：设置页今天不再写下只含空白的覆盖，但老档里
 *   可能躺着一份 —— 它会把这条侧链的整段 systemPrompt 换成一个空格，产出一串垃圾而
 *   没有任何一处报错。
 */
export function withImagePromptSystem(
  configs: readonly AgentConfig[],
  override: string | undefined,
): AgentConfig[] {
  if (!override || override.trim() === '') return [...configs];
  const index = configs.findIndex((c) => c.agentId === 'image_prompt');
  if (index >= 0) {
    return configs.map((c, i) => (i === index ? { ...c, systemPrompt: override } : c));
  }
  // 生产里到不了这里（`buildAgentConfigs` 的名单固定含 image_prompt）。真到了的话，
  // 宁可补一条只带提示词的：没有它，方言的整段吃法会静默失效，而那是没有任何症状的。
  console.warn('[GamePipeline] configs 里没有 image_prompt，合成一条只带 systemPrompt 的');
  return [...configs, { agentId: 'image_prompt', systemPrompt: override } as AgentConfig];
}

export class GamePipeline {
  private game: ReturnType<typeof useGameStore>;
  private settings: ReturnType<typeof useSettingsStore>;
  private saveId: string;
  private orch: AgentOrchestrator | null = null;
  private abortController: AbortController | null = null;
  /** 当前 run 的所有权标识；abort 后直到 finally 收尾前都保持，防止旧 run 清掉新 run。 */
  private activeRunId: string | null = null;
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
   * 🖼 本轮 story 刚产出的那条消息（id / turn / 正文）。
   *
   * 情景插画按 `(saveId, messageId, occurrence)` 反查挂回正文（D2），所以自动档开火
   * 时必须知道图挂在哪条消息上。**每轮 run() 开头清空** —— 上一轮的消息不该被这一轮
   * 的标记挂上去。
   */
  private lastStoryMessage: { id: string; turn: number; content: string } | null = null;
  /**
   * 工坊 P2 (D5) 体积护栏: 已经因超限被拒过的来源 Agent。
   *
   * **每存档每来源只 toast 一次** —— 一个失控的世界书状态机会轮轮超限，
   * 每轮弹一次只会把玩家逼到关掉通知。内存级即可（本实例随存档创建），
   * 不新增任何持久化字段；累计诊断在 `game.ejsVarsRejections`。
   */
  private ejsRejectToasted = new Set<string>();
  /** Q-01: v3 战斗真实骰源（drawDice）的 outputId 计数器，区分每次续杯 */
  private _diceDrawSeq = 0;
  /**
   * T16（设计 2026-08-09 §3.5）：最近一次 combat_trigger marker 的存档副本。
   *
   * coordinator 句柄的 `restart` 回调（重开战斗）拿它重新走 handleCombatTriggerV3
   * —— store 层接触不到 pipeline，重触发必须由本实例完成（它持有 marker 与全部
   * 引擎依赖）。整场战斗生命周期内有效；下次 combat_trigger 覆盖。
   */
  private _lastCombatMarker: CombatTriggerMarker | null = null;

  /**
   * 取 EJS `ui.log` 调试日志快照（能力面 §3.11）。
   *
   * 环形缓冲**住在 game-store**（`ejsUiLog`）而不是本实例：之前它是这里的私有字段，
   * `getEjsDebugLog()` 全仓零调用点 —— 收集了、没人读。挪去 store 之后 DebugPanel
   * 直接读，也随导出 JSON 一起被带走。
   *
   * 刻意**不落真 console**：真机语料 5 个条目在用 `console.log` 调试，
   * 每回合每 Agent 都刷一遍，会把真正的报错淹掉。
   */
  getEjsDebugLog(): string[] {
    return [...(this.game.ejsUiLog ?? [])];
  }

  constructor(deps: GamePipelineDeps) {
    this.game = deps.gameStore;
    this.settings = deps.settingsStore;
    this.saveId = deps.saveId;
  }

  // 🪦 Q-06：`syncSnapshotSettings` 已删。它把 settings-store 的两个字段每轮抄进
  //    Dexie `settings` 表，因为 createSnapshot 读的是那张表。桥只搬两个字段、
  //    且 `catch { console.warn }` 静默失败 —— 断了用户完全无感。
  //    现在引擎经 `engine-settings` 注入缝直接读 settings-store（真源只剩一处），
  //    provider 在 main.ts 启动时注册。

  /** 发送开场 Prompt（首次加载存档时调用），作为首条用户消息注入管线 */
  async sendOpeningPrompt(onStoryChunk?: StoryChunkCallback): Promise<void> {
    const prompt = this.game.openingPrompt;
    if (!prompt) return;
    // Claim before starting the long pipeline. A page remount can create a second
    // GamePipeline while the first one is still running.
    const claimed = await this.game.markOpeningPromptConsumed();
    if (!claimed) return;

    // run() 会先落库用户消息，所以重试前得知道这条已经在了 —— 否则归还认领等于放行重复。
    const promptAlreadyRendered = this.game.messages.some(
      (msg) => msg.role === 'user' && msg.content === prompt,
    );
    // 开场 prompt 作为真正的用户消息渲染 + 注入历史，让下游 Agent 能读到装备/技能/背景/命定核心等
    const ok = await this.run(prompt, onStoryChunk, /* isUserMessage */ !promptAlreadyRendered);
    if (ok) return;

    // 只有「一句叙事都没产出」才归还认领：API 抽风不该把开场永久烧掉。
    // 已经有 assistant 正文时保持已消费，重跑会把那段叙事再写一遍。
    const producedNarrative = this.game.messages.some((msg) => msg.role === 'assistant');
    if (!producedNarrative) await this.game.releaseOpeningPromptClaim();
  }

  /** 核心: 将用户输入送入 Agent 管线。返回 true 表示管线成功完成。 */
  async run(
    userInput: string,
    onStoryChunk?: StoryChunkCallback,
    isUserMessage = true,
    sourceMessageId?: string,
  ): Promise<boolean> {
    console.log(
      '[GamePipeline] run() called — userInput length:',
      userInput.length,
      'isUserMessage:',
      isUserMessage,
    );
    console.log('[GamePipeline] userInput preview:', userInput.slice(0, 300));
    const controller = new AbortController();
    this.abortController = controller;
    this.game.isGenerating = true;
    let activityRunId: string | null = null;
    let activityOutcome: 'completed' | 'failed' | 'cancelled' = 'failed';
    let activityMessage: string | undefined;

    try {
      // 1. 先快照既有历史；当前输入只走 userInput，避免同时出现在 NARRATIVE 与 USER_INPUT。
      const existingSourceMessageId = isUserMessage
        ? undefined
        : (sourceMessageId ??
          [...this.game.messages].reverse().find((message) => message.role === 'user')?.id);
      const context = this.buildContext(userInput, existingSourceMessageId);

      // 添加用户消息（非用户消息仅注入 context 不渲染）
      const boundSourceMessageId = isUserMessage
        ? this.game.addMessage(userInput, 'user').id
        : existingSourceMessageId;
      activityRunId = this.game.startAgentActivityRun(boundSourceMessageId);
      this.activeRunId = activityRunId;
      this.game.setPendingOptions([]); // 新一轮开始，清掉上一轮的行动选项
      this.game.clearAgentLog();

      // 2. 构建 endpoints & context
      const endpoints = this.buildEndpoints();
      this.currentContext = context;
      this.pendingPlotTasks = [];
      this.pendingAudioMarker = null;
      this.lastStoryMessage = null;
      await this.loadPlotData(context);

      // 2.5 加载预设和世界书（自 fetch agent-config.json，不依赖 store 异步初始化）
      const { presets, agentDefaults } = await this.loadPresets();
      const worldBooks = await this.loadActiveWorldBooks();
      const systemCoreWorkshopBookIds = await this.loadSystemCoreWorkshopBookIds(worldBooks);

      // 2.6 构建 Agent 配置（用已加载的 agentDefaults 替代 projectAgentDefaults）
      const agentConfigs = this.buildAgentConfigs(
        agentDefaults,
        onStoryChunk,
        systemCoreWorkshopBookIds,
      );

      // 真机修(2026-07-17): 侧链 (char/item/craft) 调用 buildAgentMessages 时需要
      // configs/worldBooks/presets 才能拿到完整 systemPrompt + 世界书上下文，
      // 把这三个值挂实例传给事件回调（回调通过闭包捕获 run() 局部变量）。
      this.chainData = { agentConfigs, worldBooks, presets };

      // Q-07：战斗外效果系统接线 —— 对当前存档已装备物品执行 init + 注册
      // （幂等；存档切换时由 unwireEffectSystem 拆除后重建）
      try {
        const { wireEffectSystem } = await import('@engine/effect-wiring');
        wireEffectSystem(this.saveId, this.game.characters);
      } catch (err) {
        console.warn('[GamePipeline] 效果系统接线失败（不阻塞本轮）:', err);
      }

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
        if (controller.signal.aborted) {
          activityOutcome = 'cancelled';
          activityMessage = '本回合已停下，可以再次尝试。';
        } else {
          activityOutcome = 'failed';
          activityMessage = '世界的回应在此中断，可以再次尝试。';
        }
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

      activityOutcome = 'completed';
      return true;
    } catch (err) {
      // Abort 错误不视为真正的失败
      if ((err as Error)?.name === 'AbortError') {
        console.log('[GamePipeline] 管线已中止');
        activityOutcome = 'cancelled';
        activityMessage = '本回合已停下，可以再次尝试。';
        return false;
      }
      console.error('[GamePipeline] 管线运行失败:', err);
      activityOutcome = 'failed';
      activityMessage = '世界的回应在此中断，可以检查设置后再次尝试。';
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
      if (activityRunId) {
        this.game.finishAgentActivityRun(activityRunId, activityOutcome, activityMessage);
      }
      if (this.activeRunId === activityRunId) {
        this.game.isGenerating = false;
        this.activeRunId = null;
        if (this.abortController === controller) this.abortController = null;
      }
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
    if (this.activeRunId) this.game.markAgentActivityStopping(this.activeRunId);
    this.abortController?.abort();
  }

  // ===== 私有方法 =====

  private buildAgentConfigs(
    agentDefaults: Record<string, Record<string, unknown>>,
    onStoryChunk?: StoryChunkCallback,
    systemCoreWorkshopBookIds: string[] = [],
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
      // 侧链: 情景插画的中文 → danbooru 转换（图像生成 D28）。不进主 DAG、也不进设置页
      // Agent 子导航（D53）—— 但它的 systemPrompt/世界书/采样参数照旧从这里装配。
      'image_prompt',
      // 侧链: 战斗决策（combat-v3 Coordinator 在战斗会话中按 RequiredInput.PlayerCommand
      // 唤起，不走主 DAG）。systemPrompt/模型/温度/世界书照旧从这里装配 —— coordinator
      // 按 agentId === 'combat_v3' 从 ctx.configs 读（见 combat-v3/coordinator.ts 的
      // combatSystemPrompt），设置页 Agent 子导航可编辑。
      'combat_v3',
    ];

    // 复用 buildEndpoints() 的映射结果（ApiEntry.model → ApiEndpoint.defaultModel）
    const apiPool = this.buildEndpoints();

    // 每个 Agent 的 `model` 存的是 **API 池 id** → 匹配对应端点
    // 🔴 D44 修正 1：传默认层（agentDefaults）——model 也是 12 键之一，删 boot 播种后
    //    用户没覆写时唯一来源就是默认层。agentDefaults 在本方法参数里、闭包可直接用。
    const getEndpoint = (agentId: string): ApiEndpoint | undefined => {
      const poolId = getAgentSettings(s, agentId, agentDefaults).model;
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
        let streamedRaw = '';
        streamCallbacks = {
          onChunk: (text: string, isComplete: boolean) => {
            if (isComplete) {
              onStoryChunk('', true);
              return;
            }
            streamedRaw += text;
            onStoryChunk(projectStreamingStory(streamedRaw), false);
          },
          onComplete: () => {
            // 流式完成 — 最终结果由 handleAgentResult 处理
          },
          onError: (error: string) => {
            console.warn('[GamePipeline] story 流式错误:', error);
            onStoryChunk('', true);
          },
        };
      }

      // defaults 层 = loadPresets 自 fetch agent-config.json 解析出的完整默认层
      // （D44 修正 1：覆盖 AgentSettingsEntry 12 键 + presetId/ejsVarsCommit）。
      const defaults = agentDefaults[agentId] ?? {};
      // 🔴 D44 修正 1/3：经 getAgentSettings 统一 resolve（覆写 ?? 默认），不再分别
      //    `defaults.X || agentCfg.X`（那是默认优先、覆写被无视）与 `agentCfg.X`（裸取覆写）。
      //    agentCfg 现在已合默认层，下面 systemPrompt/template/worldBookIds/数值全部读它。
      const agentCfg = getAgentSettings(s, agentId, agentDefaults);
      // 真机修(2026-07-17): story 预设尊重设置页选中项（s.activePresetId）——
      // 此前硬绑 agent-config.json 出厂 presetId，用户导入/另存的预设（新 id）在设置页编辑得再对，
      // 运行时也永远用旧的那份（"我保存了第二人称但 agent 没拿到"根因）。
      const presetId: string | undefined =
        agentId === 'story' && s.activePresetId
          ? s.activePresetId
          : (defaults.presetId as string | undefined) || undefined;
      const worldBookEnabled = agentCfg.worldBookEnabled;
      const configuredWorldBookIds = worldBookEnabled ? agentCfg.worldBookIds : [];
      const selectedSystemCore =
        this.game.activeSave?.metadata?.enabledWorldBookEntries?.some((entry: string) =>
          entry.startsWith('system_core:'),
        ) ?? false;
      // Selected core lore is authoritative save data. Story and char_gen both
      // need the source entry; the other agents keep their configured partitions.
      const isCoreLoreAgent = agentId === 'story' || agentId === 'char_gen';
      const coreBookIds = isCoreLoreAgent
        ? [...(selectedSystemCore ? ['system_core'] : []), ...systemCoreWorkshopBookIds]
        : [];
      const worldBookIds =
        worldBookEnabled && coreBookIds.length > 0
          ? [...new Set([...configuredWorldBookIds, ...coreBookIds])]
          : configuredWorldBookIds;

      // systemPrompt/template 统一读 agentCfg（已合覆写 ?? 默认）。空串 → undefined
      // （AgentConfig 里 undefined = 不发该字段，与原 `defaults.X || undefined` 行为一致）。
      const resolvedSystemPrompt: string | undefined = agentCfg.systemPrompt || undefined;
      const resolvedTemplate: string | undefined = agentCfg.template || undefined;

      return {
        agentId,
        enabled: true,
        apiEndpointId: endpoint?.id ?? '',
        model,
        // D44 修正 3：数值从 agentCfg 读（已合覆写 ?? 默认 ?? AGENT_SETTINGS_DEFAULTS）。
        temperature: agentCfg.temperature,
        maxTokens: agentCfg.maxTokens,
        topP: agentCfg.topP,
        frequencyPenalty: agentCfg.freqPen,
        presencePenalty: agentCfg.presPen,
        retryOnFail: true,
        timeout: 120000,
        userId: `fp|${this.saveId}|${agentId}`,
        promptTemplate: {
          fixedSystem: agentCfg.systemPrompt,
          fixedExamples: '',
        },
        presetId,
        worldBookIds,
        // 🔴 D44 修正 3：precedence 统一为 覆写 ?? 默认（经 getAgentSettings）。
        //    此前这里是 `defaults.systemPrompt || agentCfg.systemPrompt`（默认优先、
        //    覆写被无视）—— 用户在设置页改的提示词进不了运行时。现在 agentCfg 已合
        //    两层，直接读它即可。
        systemPrompt: resolvedSystemPrompt,
        template: resolvedTemplate,
        // 工坊 P2 (ADR-30 D5): 只有持权 Agent 的装配 pass 产出 EJS vars 提交候选。
        // 代码级兜底：agent-config.json 没加载上（fetch 失败/离线）或该 agent 未声明本字段时，
        // story 默认持权 —— 与设计「默认仅 story 持权」一致。否则一次网络抖动就让整条
        // EJS→vars 提交链静默哑火（EJS 照跑、写照丢，无任何征兆）。显式 false 仍然生效。
        ejsVarsCommit: (defaults.ejsVarsCommit as boolean | undefined) ?? isStory,
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

  private buildContext(userInput: string, excludeMessageId?: string): AgentContext {
    // 构建历史消息（只取 user/assistant，不含 system）
    const history = this.game.messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.id !== excludeMessageId)
      .map((m) => ({ ...m }));

    // 步5: 读存档级剧情配置（捏人页 startJourney 落 metadata.plotSettings）；老存档无字段 → off 兜底
    const meta = this.game.activeSave?.metadata as Record<string, any> | undefined;
    const plotSettings = meta?.plotSettings ?? { mode: 'off', tabooContent: '' };

    return {
      userInput,
      history,
      worldBooks: [],
      characters: this.game.characters,
      variables: this.game.saveProfile?.variables ?? {}, // M5 §12: 变量唯一真源 SaveProfile.variables（M6 收官接线）
      plotEvents: this.game.activePlotEvents,
      memories: this.game.recentMemories,
      quests: this.game.saveProfile?.quests,
      agentOutputs: new Map(),
      plotSettings,
      gameTime: this.game.gameTime ?? undefined,
      // 🔴 2026-08-02 修: 初始技能走 item_gen 链路 —— request_dispatcher 的 {{SKILL_STATE}}
      //    需要读到捏人页选的初始技能声明（存在 openingPrompt 里），否则主角 skills 落库为空的
      //    开局永远发不出 `<item_gen_request itemType="skill">`，技能没有 modifiers/automata。
      openingPrompt: this.game.openingPrompt ?? undefined,
      // 工坊 P2 (ADR-30 D4/D9): stats 只读投影每回合构建一次，同回合多 Agent 装配复用
      //（各 pass 在 buildAgentMessages 内再克隆一份，杜绝跨 pass 写泄漏）
      statData: buildStatData({
        characters: this.game.characters,
        gameTime: this.game.saveProfile?.gameTime,
        fp: this.game.saveProfile?.fp,
        turn: history.length,
      }),
      // 能力面 T2 (§7): EJS 随机种子 = (存档, 回合号)。快照回退重放同一回合 → 同一份世界书正文。
      // 回合号取历史长度：它随回合单调增长，且快照回退时会连同历史一起回到旧值 —— 正是我们要的。
      ejsSeed: buildPassSeed(this.game.activeSaveId ?? undefined, history.length),
      // 能力面 T5 (§3.4/§3.6/§3.11): char.affection / quest.focus / ui.* 的数据与出口
      affections: this.game.saveProfile?.affections,
      focusQuest: this.game.saveProfile?.focusQuest,
      ejsNotify: (message, level) => {
        // 🔴 **强制来源前缀**：项目名可能伪装成「系统提示」（§12 待拷问 6）。
        //    玩家必须一眼看出这句话是世界书内容说的，不是引擎说的。
        try {
          useUIStore().toast(
            `内容说：${message}`,
            level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info',
            5000,
          );
        } catch (err) {
          console.warn('[GamePipeline] EJS ui.notify 失败:', err);
        }
      },
      ejsLog: (args) => {
        // 进 store 的环形缓冲，**不落真 console**（世界书刷屏会淹掉真正的报错）
        try {
          this.game.recordEjsUiLog?.(
            args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
          );
        } catch {
          // 诊断出口不能反过来打断提示装配
        }
      },
      // 条目 EJS 失败已回退原文注入 —— 静默失效，必须能在 DebugPanel 与导出 JSON 里看到
      ejsFallback: ({ agentId, entries }) => {
        try {
          this.game.recordEjsFallback?.(agentId, entries);
        } catch (err) {
          console.warn('[GamePipeline] 记录 EJS 回退诊断失败:', err);
        }
      },
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
   *  同时返回各 agent 的**完整默认层**（D44 修正 1：12 键 + presetId/ejsVarsCommit/preset），
   *  自给自足 fetch agent-config.json，不依赖 store 的 projectAgentDefaults 异步加载时序。
   *
   *  🔴 D44 修正 1：返回的 agentDefaults 同时充当 `getAgentSettings` 的 defaultsLayer 参数
   *     ——删 boot 播种后，世界书/model/数值的唯一默认来源就是这里。*/
  private async loadPresets(): Promise<{
    presets: AgentPreset[];
    agentDefaults: Record<string, Record<string, unknown>>;
  }> {
    let presets: AgentPreset[] = [];
    const agentDefaults: Record<string, Record<string, unknown>> = {};

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

    // 2. 经 ContentProvider 收口加载 agent-config.json（波 1 T2 / D16）。
    //    provider 内部 await contentReadyPromise（T7 pack 叠加层的灌注点）+ 上报 contentStatus。
    //    provider 失败时返回空骨架（agents={}）并 console.warn（保留原「必须留痕」语义）。
    try {
      const { useContentStore } = await import('../stores/content-store');
      const config = (await useContentStore().loadProjectDefaults()) as {
        agents?: Record<string, any>;
      };
      const agents = config.agents || {};
      if (Object.keys(agents).length === 0) {
        // provider 返回空骨架 = 占位 fetch 失败或文件缺失。原行为是 console.warn。
        console.warn(
          '[GamePipeline] agent-config.json 加载为空，Agent 默认配置回落（EJS vars 提交权走代码兜底）',
        );
      }
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
        // 提取各 agent 完整默认层（D44 修正 1）—— 收齐 AgentSettingsEntry 12 键 +
        // presetId/ejsVarsCommit（preset 已在上面单独提进 presets[]）。
        // getAgentSettings 经此合「覆写 ?? 默认」，删 boot 播种后世界书/model/数值
        // 的唯一默认来源就是这里。原样保留 agent-config.json 给的字段（包括 undefined
        // 语义相关的 historyLayers/historySlice —— 不塌成默认）。
        agentDefaults[agentId] = {
          model: e.model,
          worldBookEnabled:
            typeof e.worldBookEnabled === 'boolean' ? e.worldBookEnabled : undefined,
          worldBookIds: Array.isArray(e.worldBookIds)
            ? [...(e.worldBookIds as string[])]
            : undefined,
          systemPrompt: typeof e.systemPrompt === 'string' ? e.systemPrompt : undefined,
          template: typeof e.template === 'string' ? e.template : undefined,
          temperature: typeof e.temperature === 'number' ? e.temperature : undefined,
          topP: typeof e.topP === 'number' ? e.topP : undefined,
          freqPen: typeof e.freqPen === 'number' ? e.freqPen : undefined,
          presPen: typeof e.presPen === 'number' ? e.presPen : undefined,
          maxTokens: typeof e.maxTokens === 'number' ? e.maxTokens : undefined,
          historyLayers: typeof e.historyLayers === 'number' ? e.historyLayers : undefined,
          historySlice: typeof e.historySlice === 'number' ? e.historySlice : undefined,
          presetId: e.presetId || undefined,
          // 工坊 P2 (ADR-30 D5): EJS vars 提交权（出厂仅 story 置 true）。
          // 字段缺席时保留 undefined（不塌成 false）——由 buildAgentConfigs 走代码级兜底。
          ejsVarsCommit: typeof e.ejsVarsCommit === 'boolean' ? e.ejsVarsCommit : undefined,
        };
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

  /** Match selected workshop entries to project-level `system/core` tags. */
  private async loadSystemCoreWorkshopBookIds(worldBooks: WorldBook[]): Promise<string[]> {
    if (!worldBooks.some((book) => book.partition === 'creative_workshop' && book.entries.length)) {
      return [];
    }
    try {
      const { getDatabase } = await import('@engine/database');
      const projects = await getDatabase().workshopProjects.toArray();
      return collectSelectedSystemCoreWorkshopBookIds(worldBooks, projects);
    } catch (err) {
      console.warn('[GamePipeline] 工坊 system/core 标签读取失败（不阻塞本轮）:', err);
      return [];
    }
  }

  /** 获取当前默认 API endpoint */
  private getDefaultEndpoint(): ApiEndpoint {
    return this.buildEndpoints()[0];
  }

  /** 按 agentId 解析 endpoint —— 尊重设置页为各 Agent 选的 API 池；
   *  未配置或映射失效时回退到默认 endpoint（与 createAgentClients 一致）。
   *  修复(2026-07-30): 此前 char_gen/item_gen/craft_gen/combat 等侧链一律走
   *  getDefaultEndpoint()（API 池第一项），无视用户在设置页为各 Agent 选的 API 池，
   *  导致"全部设了 glm5.2，侧链却用 d4f"。 */
  private getEndpointForAgent(agentId: string): ApiEndpoint {
    const s = this.settings.settings;
    const apiPool = this.buildEndpoints();
    const poolId = getAgentSettings(s, agentId).model;
    return apiPool.find((ep) => ep.id === poolId) || apiPool[0];
  }

  /** 创建 AgentClient 工厂 —— 供 craft_gen / char_gen / item_gen 链使用。
   *  🆕 包裹一层 LogClient：拦截 chat / chatWithTools，自动写 agentLog，
   *  让侧链 Agent 在 DebugPanel 可见（否则绕过 orchestrator 时无日志）。 */
  private getClientFactory() {
    const saveId = this.saveId;
    const game = this.game;
    return (agentId: string, endpoint: ApiEndpoint, _saveId: string) => {
      // 🔴 2026-08-02: item_gen 批量生成后单次调用耗时暴涨（9 个请求一次生成 ≈ 240s+），
      // API 池默认 timeout 60s 会掐断。item_gen 独立链（不走 orchestrator 的 config.timeout）
      // 在 client 构造时单独放大超时，避免"思考完没来得及输出"就超时。
      const real = new AgentClient({
        endpoint,
        agentId,
        saveId,
        timeout: agentId === 'item_gen' ? 300000 : undefined, // 300s；其余 agent 沿用 endpoint.timeout
      });
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
              toolCalls?: AgentResult['toolCalls'];
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
          toolCalls: result?.toolCalls,
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
            result = await real.chatWithTools(
              request,
              async (name: string, args: Record<string, any>) => {
                try {
                  const toolResult = await toolExecutor(name, args);
                  game.recordAgentToolActivity(
                    agentId,
                    name,
                    args,
                    toolResult,
                    this.activeRunId ?? undefined,
                  );
                  return toolResult;
                } catch (error) {
                  game.recordAgentToolActivity(
                    agentId,
                    name,
                    args,
                    { error: error instanceof Error ? error.message : String(error) },
                    this.activeRunId ?? undefined,
                  );
                  throw error;
                }
              },
              options,
            );
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

  /**
   * 🖼 `<scene_image>` → 三档分流（设计 §8）。
   *
   * ```
   * 【auto】   逐个标记过 checkQuota → ok 就 generate；拒了什么都不做
   * 【manual】 什么都不做。渲染层在「无记录」那一格画按钮，点了才花钱（D14）
   * 【off】    什么都不做。标记照扫（否则会漏成一行尖括号），但不建记录、不发请求
   * ```
   *
   * 🔴 **D15：自动档绝不追溯开火。** 本方法只被 `onSceneImage` 唤起，而那个回调只在
   * 编排器**刚产出这条消息**时触发一次；历史消息重新渲染走的是 `scene-image-store`
   * 的查询，根本不经过这里。**日后千万别为了「补全历史插画」加一条扫描全部消息的
   * 路径** —— 那会把这条安全性一次性拆掉，表现为「把开关从手动拨到自动，追溯烧掉
   * 几十张图的钱」。补画的入口在正文里，一张一张点。
   *
   * 🔴 **D21：限额拒绝绝不丢弃标记。** 拿到 `ok:false` 就什么都不做 —— 那一格落到
   * 「无记录」，按 §10.2 的真值表渲染成手动按钮。玩家看到的是一个按钮和一句「已达
   * 本小时上限」，而不是一张凭空消失的图。
   *
   * 🔴 **D32：限额在侧链之前。** 排序由 `scene-image-store.generate()` 保证（缝的调用
   * 顺序写在那儿），本方法只负责把每个标记喂给它。
   *
   * 🔴 **D25：永不自动重试。** 失败的记录留在那儿等玩家点重试，这里不看结果。
   */
  private async handleSceneImages(markers: SceneImageMarker[]): Promise<void> {
    // 【manual】/【off】都是「什么都不做」，差别只在渲染层画不画那个按钮
    if (this.settings.settings.imageGenMode !== 'auto') return;

    const message = this.lastStoryMessage;
    if (!message || markers.length === 0) return;

    const { useSceneImageStore } = await import('../stores/scene-image-store');
    const store = useSceneImageStore();
    // 缝没接上 / 这个存档的记录还没载入 → 不开火。宁可少画一张，也不在一个不在
    // 屏幕上的存档上花钱（切存档途中尤其容易撞上）。
    if (store.activeSaveId !== this.saveId) {
      console.warn('[GamePipeline] 情景插画：插画库尚未载入本存档，本轮不自动生成');
      return;
    }

    // 🔴 分段编号必须与渲染层同源: `splitSceneImageSegments` 只给**正文有内容**的标记
    // 发号（空 body 的标记照剥但不占号）。自己数一遍 markers 会在有空标记时错位，
    // 图就挂到隔壁那一格去了。
    const segments = splitSceneImageSegments(message.content);
    // 侧链要的是**剥掉全部标记**的正文（判断氛围/光线/时间）
    const narrative = stripMarkers(message.content).trim();
    const location = this.game.player?.location || undefined;
    const maxRating = this.settings.settings.imageMaxRating;

    for (const segment of segments) {
      if (segment.kind !== 'image') continue;
      const marker = segment.marker;
      try {
        const result = await store.generate({
          saveId: this.saveId,
          messageId: message.id,
          turn: message.turn,
          anchorKind: 'marker',
          occurrence: segment.occurrence,
          source: 'auto',
          intent: marker.bodyText,
          title: marker.title,
          characters: marker.characters,
          // 标记没写 rating 时取设置里那一档；写了也会在 composePrompt 里被钳到上限（D38）
          rating: marker.rating ?? maxRating,
          narrative,
          ...(location ? { location } : {}),
        });
        if (!result.ok) {
          // D21: 什么都不做 —— 这一格会渲染成手动按钮，玩家想要就自己点
          console.log(
            `[GamePipeline] 情景插画被限额拦下（${result.reason}），降级成手动按钮: ${result.message}`,
          );
        }
      } catch (err) {
        // 一个标记出问题不该让同一条消息里剩下的标记跟着没了
        console.warn('[GamePipeline] 情景插画入队失败（跳过这一个）:', err);
      }
    }
  }

  private buildEventHandlers(): OrchestratorEvents {
    return {
      // 🎵 配乐：只暂存，**不在 Stage 1 就播** —— 见 run() 末尾的说明
      onPlayAudio: (marker) => {
        this.pendingAudioMarker = marker;
      },

      // 🖼 情景插画：三档分流。不 await —— 出图 5–60 秒，不该进管线时序
      onSceneImage: (markers) => {
        void this.handleSceneImages(markers).catch((err) => {
          console.warn('[GamePipeline] 情景插画分流失败（不阻塞本轮）:', err);
        });
      },

      // 工坊 P2 (D5): stage 跑完 → EJS 差量落库 → 才轮到本 stage 的 AI 补丁
      onEjsVarsFlush: (agentIds) => this.flushEjsVarsDiffs(agentIds),

      // === Stage 回调 ===
      onAgentStart: (agentId, config) => {
        console.log(`[GamePipeline] Agent 开始: ${agentId}`);
        this.game.updateAgentStatus(agentId, this.activeRunId ?? undefined);
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
      onAgentComplete: async (result) => {
        this.game.clearAgentStatus(result.agentId, result.error, this.activeRunId ?? undefined);
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
          toolCalls: result.toolCalls,
          error: result.error,
          tokensUsed: result.tokensUsed,
          cacheHit: result.cacheHit,
          cacheHitTokens: result.cacheHitTokens,
          cacheMissTokens: result.cacheMissTokens,
          completionTokens: result.completionTokens,
          duration: result.duration,
        });
        await this.handleAgentResult(result);
      },
      onAgentError: (agentId, error) => {
        console.error(`[GamePipeline] Agent 错误: ${agentId}`, error);
        this.game.clearAgentStatus(agentId, error, this.activeRunId ?? undefined);
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

      onToolCall: (agentId, toolName, args, result) => {
        this.game.recordAgentToolActivity(
          agentId,
          toolName,
          args,
          result,
          this.activeRunId ?? undefined,
        );
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
        const { content, options } = extractStoryOptions(result.rawResponse || '');
        if (!content) throw new Error('story produced no player-visible narrative');
        this.game.setPendingOptions(options);
        // 🖼 记下这条消息 —— 情景插画按 (saveId, messageId, occurrence) 反查挂回正文（D2）。
        // 从 messages 末尾去捞是个会被别的写入者破坏的假设，所以让 addMessage 交回来。
        const message = this.game.addMessage(content, 'assistant');
        this.lastStoryMessage = {
          id: message.id,
          turn: message.turn ?? 0,
          content: message.content,
        };
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

  /**
   * 步5: 从 rawResponse 抠 JSON。
   *
   * Q-05：改走 `extractJsonPayload` —— 除了原来认的 `<json>` 标签，还认裸 JSON、
   * markdown 围栏、以及前后夹带解说文字的贪婪切片。抠不到时退回原文（旧行为）。
   */
  private static extractJsonBlock(raw: string): string {
    return extractJsonPayload(raw) ?? raw;
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
      const parsed = JSON.parse(jsonStr);
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
        const { generateMemoryId } = await import('@engine/memory-summarizer');
        const gt = this.currentContext?.gameTime;
        const timeStr = gt ? `${gt.era}${gt.year}年${gt.month}月${gt.day}日` : '未知';
        for (const event of terminal) {
          const mem = eventToMemory(event, this.saveId, { start: timeStr, end: timeStr });
          // Q-03：与 memory_summary 共用同一 id 发号器（MEM6位流水号），不再用 base36 时间戳
          await saveMemory({
            ...mem,
            id: await generateMemoryId(this.saveId),
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

  /** 解析 memory_summary 输出并持久化到 IndexedDB
   *  Q-03：收回引擎 —— 解析/校验/id 生成/embedding 全走 memory-summarizer.summarizeAndSave，
   *  本方法只负责喂入 Agent 输出与 embedding 端点。门槛统一 MEMORY_MIN_CHARS（100 字）。 */
  private async persistMemorySummary(result: AgentResult) {
    try {
      const { summarizeAndSave } = await import('@engine/memory-summarizer');
      const raw = result.rawResponse || '';

      // 从设置构建 embedding 端点（embeddingEndpointId 指向 API 池，model 覆盖默认）
      const embeddingEndpoint = this.buildEmbeddingEndpoint();

      const memory = await summarizeAndSave({
        saveId: this.saveId,
        agentRawOutput: raw,
        gameTimeRange: this.currentContext?.gameTime ? { start: '未知', end: '未知' } : undefined,
        embeddingEndpoint,
      });

      // 更新本地 recentMemories 供下一轮召回
      if (memory) {
        this.game.recentMemories = [...(this.game.recentMemories || []), memory];
        console.log(
          `[GamePipeline] memory_summary 落库成功: ${memory.id} importance=${memory.importance} keywords=${memory.keywords.join(',')}`,
        );
      }
    } catch (e) {
      console.error('[GamePipeline] memory_summary 解析/存储失败:', e);
    }
  }

  /** 从设置构建 embedding 端点（Q-03 embedding 接线）。
   *  embeddingEndpointId → API 池对应 endpoint；embeddingModel 覆盖 defaultModel。
   *  未配置 embedding endpoint → 返回 undefined（summarizeAndSave 不计算向量，退化为重要度排序）。 */
  private buildEmbeddingEndpoint():
    { baseUrl: string; apiKey: string; defaultModel: string } | undefined {
    const s = this.settings.settings;
    const endpointId = s.embeddingEndpointId as string | null;
    if (!endpointId) return undefined;
    const ep = this.buildEndpoints().find((e) => e.id === endpointId);
    if (!ep) return undefined;
    return {
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey,
      defaultModel: s.embeddingModel || ep.defaultModel,
    };
  }

  /** 处理战斗触发 — 唤起 combo v3 Coordinator（v2 分支 M5 已退役 → 优雅提示） */
  private async handleCombatTrigger(
    marker: CombatTriggerMarker,
    storyOutput: string,
  ): Promise<CombatSummaryResult | null> {
    // feature flag（架构 §十四 14.5）：分支点唯一。v3 走 coordinator；打回 'v2' 走优雅退役提示。
    const engineVersion = this.settings?.settings?.combatEngineVersion ?? 'v3';
    if (engineVersion === 'v3') {
      return this.handleCombatTriggerV3(marker, storyOutput);
    }
    // ⚠️ v2 战斗运行时已于 M5 真正退役删除（combat-runner/pipeline/resolver/settlement）。
    //    打回 'v2' 不再真实开局战斗——改为优雅退役提示，避免悬空 import 与编译错误。
    const message =
      '【系统】v2 战斗引擎已退役删除。若非显式切换，战斗请走 v3（当前 AppSettings.combatEngineVersion）' +
      `。当前设置被显式打回 'v2'，本场战斗不执行。`;
    console.warn('[GamePipeline] combat v2 分支已退役，返回优雅提示而非真实开局');
    this.game.addMessage(message, 'assistant');
    return {
      narrativeSummary: message,
      patches: [],
      totalExp: 0,
      totalFp: 0,
      loot: [],
      rounds: 1,
      outcome: 'draw',
    };
  }

  /**
   * T2（2026-08-10）：战斗 Agent 模板系统上下文 —— 战斗 Agent 的模板只挂这三类分区书
   * （世界观设定/种族特性/核心数值），与请求调度器的可见面同口径。过滤在 pipeline 侧
   * 完成（coordinator 不碰原始列表，缺省时首轮模板的 {{LORE_BOOK_STATIC}} 渲染为空）。
   */
  private static readonly COMBAT_WORLD_BOOK_PARTITIONS: ReadonlySet<string> = new Set([
    'world_setting',
    'race',
    'system_core',
  ]);

  /** 🆕 M2 v3 分支：combat_trigger 检出 → **只弹就绪面板**（F2，2026-08-10）。
   *  就绪内容 = marker 快照（参战方/战斗类型/环境/起因），由 v3_combat_ready 事件
   *  投进 store（combatReady 置位 → isInCombat=true → CombatPanel 显示就绪分支）。
   *  玩家点「开始战斗」→ store.startCombat → 占位句柄的 start → startCombatV3 真开打。
   *  返回 null（orchestrator 不消费返回值；就绪期不 enterCombat / 不 runCombatV3）。 */
  private async handleCombatTriggerV3(
    marker: CombatTriggerMarker,
    storyOutput: string,
  ): Promise<CombatSummaryResult | null> {
    const endpoint = this.getEndpointForAgent('combat_v3');
    if (!endpoint) {
      console.warn('[GamePipeline] combat_v3 跳过: 未配置 API endpoint');
      return null;
    }
    // 存档 marker（startCombatV3 / 重开战斗 restart 回调复用）
    this._lastCombatMarker = marker;

    // marker 快照 → v3_combat_ready（名字名单拆成数组；空名单字段缺席）
    const splitNames = (s: string | undefined): string[] | undefined => {
      if (!s) return undefined;
      const names = s
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
      return names.length > 0 ? names : undefined;
    };
    this.game.applyCombatEvent({
      type: 'v3_combat_ready',
      combatType: marker.combatType,
      environment: marker.environment,
      allies: splitNames(marker.allies),
      enemies: splitNames(marker.enemies),
      bodyText: marker.bodyText,
      brief:
        [marker.combatType ?? '', marker.environment ?? '', marker.bodyText ?? '']
          .filter(Boolean)
          .join('｜') || undefined,
    });
    // 就绪期占位句柄：只有 start（store.startCombat 点「开始」才触发真开打）。
    // startCombatV3 里会 setCombatCoordinator 替换成完整句柄（submit/abandon/restart）。
    this.game.setCombatCoordinator({
      start: async () => {
        await this.startCombatV3(storyOutput);
      },
    });
    return null;
  }

  /** 🆕 M2 v3 分支（F2）：就绪面板点「开始」后的真开打 —— 原 handleCombatTriggerV3
   *  主体（enterCombat → participants → pre-combat 快照 → setCombatCoordinator →
   *  runCombatV3 → 摘要回注）。marker 取自已存档的 _lastCombatMarker。 */
  private async startCombatV3(storyOutput: string): Promise<CombatSummaryResult | null> {
    const marker = this._lastCombatMarker;
    if (!marker) {
      console.warn('[GamePipeline] startCombatV3 跳过: 无已存档 combat marker');
      this.game.exitCombat();
      return null;
    }
    const endpoint = this.getEndpointForAgent('combat_v3');
    if (!endpoint) {
      console.warn('[GamePipeline] combat_v3 跳过: 未配置 API endpoint');
      this.game.exitCombat();
      return null;
    }
    try {
      const context = this.currentContext ?? this.buildContext('');
      this.game.enterCombat();
      this.game.updateAgentStatus('combat_v3');

      const { runCombatV3 } = await import('@engine/combat-v3');
      const { characterToCombatParticipant } = await import('@engine/combat-v2-types');

      // 组装 bundle：参战角色 → CombatParticipant。
      // 🔴 2026-08-08 阵营修复：调度器在 combat_trigger 上声明 allies/enemies 名单，
      //    按名分阵营——否则所有非 player 角色都被当 enemy（契约的妲丽安会被敌方
      //    Agent 控制）。名单缺省时回退到旧行为（player=ally，其余=enemy）。
      // 🔴 2026-08-10 名单收敛（真机 debug）：声明了名单时，**只把名单内的角色拉进
      //    战斗**（外加 player 本体）。此前所有 hp>0 角色全拉 + sideOf 把名单外非
      //    player 一律判 enemy——我方旁观 NPC（客栈掌柜奥斯瓦尔德，不在
      //    allies/enemies 名单）会被当敌方拉进 participants，战斗面板出现多余单位
      //    并让敌方 Agent 替它决策。名单缺省（无名单声明）时保持旧行为全拉。
      const playerC = this.game.characters.find((c) => c.type === 'player');
      const allyNames = new Set(
        (marker.allies ?? '')
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const enemyNames = new Set(
        (marker.enemies ?? '')
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const sideOf = (c: CharacterState): 'ally' | 'enemy' => {
        if (allyNames.size > 0 || enemyNames.size > 0) {
          // 调度器给了名单 → 名单内命中按阵营，未命中的：玩家归 ally，其余归 enemy
          // （未命中的非玩家已被下方 filter 排除，此分支实际只兜 player）
          if (allyNames.has(c.name)) return 'ally';
          if (enemyNames.has(c.name)) return 'enemy';
          return c.type === 'player' ? 'ally' : 'enemy';
        }
        // 无名单 → 旧行为
        return c.type === 'player' ? 'ally' : 'enemy';
      };
      const hasListedSides = allyNames.size > 0 || enemyNames.size > 0;
      // F3：名单声明时只拉名单内角色 + player 本体；名单外的旁观者（无论 npc 还是
      // monster）不进战斗、不占行动序列。名单缺省 → 旧行为：所有存活角色全拉。
      const inRoster = (c: CharacterState): boolean =>
        c.type === 'player' || allyNames.has(c.name) || enemyNames.has(c.name);
      const participants = this.game.characters
        .filter((c) => {
          if (c.hp <= 0) return false;
          if (!hasListedSides) return true;
          return inRoster(c);
        })
        .map((c) => characterToCombatParticipant(c, sideOf(c)));
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

      // T16 §3.5：_lastCombatMarker 已由就绪版 handleCombatTriggerV3 存档
      //（重开战斗 restart 回调与二次开始都复用它），这里不再重复赋值。

      // T2（2026-08-10）：模板系统上下文 —— 从 marker 组装战斗指令（战斗类型｜环境｜
      // 正文），过滤出战斗 Agent 可见的世界书（world_setting + race + system_core）。
      // 全部只进 coordinator 的 deps（可选字段），缺省时首轮模板渲染退化为空占位/现状。
      const combatBrief =
        [
          `战斗类型: ${marker.combatType ?? '标准'}`,
          `环境: ${marker.environment ?? ''}`,
          marker.bodyText ?? '',
        ].join('｜') || '（无战斗指令）';
      // T4（2026-08-10）：参战方名单 —— 从 marker 的 allies/enemies 组装，注入模板 <参战方> 区。
      // 只有声明了名单才给（调度器明确说了谁在场上，AI 才能确认敌我）；未声明时留空，
      // coordinator 给「（无参战方名单）」占位说明（与 combatBrief 同口径）。
      const combatRoster = hasListedSides
        ? `我方: ${marker.allies ?? ''}；敌方: ${marker.enemies ?? ''}`
        : '';
      const combatWorldBooks = (this.chainData?.worldBooks ?? []).filter((book) =>
        GamePipeline.COMBAT_WORLD_BOOK_PARTITIONS.has(book.partition),
      );

      // 前端 Command 桥：pending resolver，store.submitCombatCommand → coordinator.submit → resolve
      let pendingResolve: ((c: CombatCommand) => void) | null = null;
      const waitForCommand = () =>
        new Promise<CombatCommand>((resolve) => (pendingResolve = resolve));

      // ── 🔴 T16 时序修复（玩家首决策永久挂起的根因）────────────────────────────
      // 此前 setCombatCoordinator 在 `await runCombatV3(...)` **之后**才执行，而
      // coordinator 的 waitForCommand（玩家单位轮次）依赖 store 经
      // combatCoordinator.submit 喂入 pendingResolve —— 战斗一开局玩家就永远等不到
      // 自己的回合（pendingResolve 有值但没人能 resolve）。必须把句柄挂到 store 的
      // **开战之前**：战斗进行中 submit/abandon 才可用。clearAgentStatus/exitCombat/
      // 摘要回注仍保留在 runCombatV3 完成之后（闭包引用关系不变）。
      // F2：就绪期占位句柄（只有 start）在这里被替换成完整句柄 —— submit/abandon/
      // waitForCommand/restart 从此刻起可用；start 不再需要（就绪面板已关）。
      // ────────────────────────────────────────────────────────────────────────────

      // ② pre-combat 快照（设计 §3.5）：openCombat 之前留档开战前状态（角色/对话/变量），
      //    供「重开战斗」restoreSnapshot 回到开战前。totalTurns 取当前回合数（照
      //    advanceTurn 先例：save.metadata.totalTurns = 已完成回合数 = 当前回合）。
      let preSnapshotId: string | null = null;
      try {
        const turn = this.game.activeSave?.metadata?.totalTurns ?? 0;
        // 照 advanceTurn 的先例直接 createStateManager(...) 调（getStateManager 是窄化包装）
        const snap = await createStateManager(this.saveId).createSnapshot('pre-combat', turn);
        preSnapshotId = snap.id;
      } catch (err) {
        console.warn('[GamePipeline] pre-combat 快照失败（重开战斗不可用，不阻塞开战）:', err);
      }

      // 暴露 coordinator 句柄给 store（前端提交/放弃/重开）。🔴 必须在 runCombatV3 之前。
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
        // §3.5 重开战斗：store.restartCombat 恢复 pre-combat 快照后调它重新走本函数。
        //    F2：重开走**就绪流程**（先弹就绪面板，玩家点「开始」才再开打），不再直接开打。
        preSnapshotId,
        restart: async () => {
          if (this._lastCombatMarker) {
            await this.handleCombatTriggerV3(this._lastCombatMarker, '');
          }
        },
      });

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
          // 2026-08-09 §2.7: 战斗 Agent 的 systemPrompt 从 agent-config 读（此前恒 undefined，
          // routeEnemyCommand 回退硬编码 125 字）。照 char_gen/craft_gen 从 chainData 取 configs 的先例。
          configs: this.chainData?.agentConfigs,
          // T2（2026-08-10）：Phase 10 模板系统上下文（全部可选，coordinator 缺省兜底）——
          // combatBrief（marker 组装）/ combatRoster（marker 名单组装）/ 过滤后的世界书 /
          // 本轮玩家输入 / 触发战斗的正文 / 最近对话历史。首轮 user 消息（情境快照）的数据源。
          worldBooks: combatWorldBooks,
          combatBrief,
          combatRoster,
          userInput: context.userInput,
          storyOutput,
          history: context.history,
          submitCommand: async () => {}, // 等待态由 v3_awaiting_player_input 事件驱动 store
          waitForCommand,
          abandon: () => {},
          // 真实随机源（Q-01）：唯一注入点，委托 dice.ts 的 rollDice（内核禁 Math.random）。
          // 每次续杯调用会换一批新骰（BeginOutput 后再取，outputId 用计数器区分）。
          drawDice: () => ({
            outputId: `draw-${++this._diceDrawSeq}`,
            dice: rollDice(60, 20),
          }),
        },
        onCombatEvent: (evt) => this.game.applyCombatEvent(evt),
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

  /**
   * 🔴 2026-08-02 批量 item_gen 的单批上限。
   *
   * 一次打包过多请求会让 item_gen 单次调用耗时暴涨（9 个请求 ≈ 240s+，见
   * fated-poem-debug-2743e219），且 AI 思考过重（7817 字 reasoning）容易撞超时。
   * 超上限时按此值分批，每批仍是一次调用（相对逐条 N 次已大幅缩减）。
   * 5 个/批 ≈ 2 批，总耗时 ≈ 2 × 单批时间，比 9 个挤一批更稳。
   */
  private static readonly ITEM_GEN_BATCH_SIZE = 5;

  /** 处理独立物品生成链 (request_dispatcher 的 <item_gen_request>) */
  private async handleItemGen(
    markers: import('@engine/types').ItemGenRequestMarker[],
    ctx: AgentContext,
  ) {
    if (markers.length === 0) return;
    const endpoint = this.getEndpointForAgent('item_gen');
    if (!endpoint) {
      console.warn('[GamePipeline] item_gen 跳过: 未配置 API endpoint');
      return;
    }

    const { runItemGenChain } = await import('@engine/item-gen-chain');
    const clientFactory = this.getClientFactory();
    const stateManager = this.getStateManager();
    const storyOutput = ctx.agentOutputs?.get('story') ?? '';

    // 🔴 2026-08-02 批量生成: 此前对每个 marker 串行调 item_gen（N 请求 = N 次调用，
    // 每个 40-60s，开局 5 技能 4 装备 1 消耗品 = 6-10 分钟）。现在把 markers 打包成
    // 一次调用（模板契约「N 个 <request> = N 个输出条目」），调用次数 N → ceil(N/5)。
    //
    // 容错策略: 每批失败不阻断主流程（try/catch 包住）；失败批不落库，下一回合
    // request_dispatcher 会重新识别未落库的请求。
    const size = GamePipeline.ITEM_GEN_BATCH_SIZE;
    for (let start = 0; start < markers.length; start += size) {
      const batch = markers.slice(start, start + size);
      this.game.updateAgentStatus('item_gen');
      try {
        const request = {
          saveId: this.saveId,
          markers: batch,
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
        console.error('[GamePipeline] item_gen 批量链失败（本批不落库，下回合重试）:', err);
      }
    }
  }

  /**
   * `image_prompt` 侧链（图像生成 G 阶段 / D28）—— 中文那句话 → danbooru 串。
   *
   * 这就是 `scene-image-store` 的 `runPromptAgent` 缝要的那个实现，形状与它逐字对齐
   * （`ImagePromptOutput | ImageGenFailure`），于是接线只剩一行 `runPromptAgent: (r, s) =>
   * pipeline.runImagePromptAgent(r, s)`。
   *
   * 🔴 **限额 `checkQuota` 必须在本方法之前**（D32）。两处花钱（LLM token + Anlas），
   * 闸门要在最前面 —— 否则自动档会为被限流器拦下的插画白烧一次侧链调用。这条排序
   * 由 store 的 `generate()` 保证，本方法只管调用本身。
   *
   * 🔴 **不抛错**：一切失败降级成 `errorKind: 'prompt-agent'`，上游一次都不会发。
   *
   * 🔴 `systemPromptOverride` 是**当前方言**那段话（图像 v2 / C3·C5）。方言拥有整个装配
   *    契约，「教模型怎么说话」是其中一格 —— 而方言解析只在 `scene-image-seams` 一处
   *    发生（本方法不认识方言，也不该认识）。传进来就**合并**进 image_prompt 那条 config，
   *    不传就照旧走 agent-config / 模板兜底。
   */
  async runImagePromptAgent(
    request: ImagePromptRequest,
    signal?: AbortSignal,
    systemPromptOverride?: string,
  ): Promise<ImagePromptOutput | ImageGenFailure> {
    const fail = (detail: string): ImageGenFailure => ({
      ok: false,
      kind: 'prompt-agent',
      message: '提示词生成失败了，点重试；或自己写一份',
      detail,
      retryable: true,
    });

    const endpoint = this.getEndpointForAgent('image_prompt');
    if (!endpoint) return fail('未配置 API endpoint');

    try {
      // 手动档可能在任何时候点（甚至本会话还没跑过一轮），chainData 不能假定已就绪
      const chain = await this.ensureChainData();
      const { callImagePromptAgent } = await import('@engine/image-prompt-agent');
      const result = await callImagePromptAgent(
        {
          saveId: this.saveId,
          request,
          context: this.currentContext ?? this.buildContext(''),
          endpoint,
          configs: withImagePromptSystem(chain.agentConfigs, systemPromptOverride),
          worldBooks: chain.worldBooks,
          presets: chain.presets,
          ...(signal ? { signal } : {}),
        },
        { clientFactory: this.getClientFactory() },
      );
      return result.ok ? result.value : result;
    } catch (err) {
      console.error('[GamePipeline] image_prompt 侧链失败:', err);
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * 侧链要用的 configs/worldBooks/presets —— run() 里那三行的**惰性版本**。
   *
   * 存在的理由只有一个：手动点「生成插画」不经过 run()，而 `chainData` 是 run()
   * 才填的。缺它时 systemPrompt 会退化成一行 stub（char_gen 2026-07-17 的真机教训）。
   */
  private async ensureChainData(): Promise<{
    agentConfigs: AgentConfig[];
    worldBooks: WorldBook[];
    presets: AgentPreset[];
  }> {
    if (this.chainData) return this.chainData;
    const { presets, agentDefaults } = await this.loadPresets();
    const worldBooks = await this.loadActiveWorldBooks();
    const systemCoreWorkshopBookIds = await this.loadSystemCoreWorkshopBookIds(worldBooks);
    const agentConfigs = this.buildAgentConfigs(
      agentDefaults,
      undefined,
      systemCoreWorkshopBookIds,
    );
    this.chainData = { agentConfigs, worldBooks, presets };
    return this.chainData;
  }
}
