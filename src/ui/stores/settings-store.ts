/**
 * 设置持久化 Store — 一个 ref 装所有设置，deep watch 自动写 localStorage。
 *
 * 用法：
 *   const s = useSettingsStore()
 *   s.settings.apiPool = [...]        // 写入 → 自动存
 *
 * 🔴 **加新设置要改两处**（Q-18，2026-08-04 主人拍板）：
 *    先在 `settings-types.ts` 的 `UiSettings` 上声明，再在 `getDefaults()` 里给默认值。
 *
 *    这条注释原先写的是「`s.settings.任意新字段 = 值` —— 加新设置零改动」，
 *    而那正是被反转掉的设计意图。反转的理由：这袋子是全应用最热的状态
 *    （模型选择 / 温度 / systemPrompt / 世界书勾选 / 主题 / 音量），九个组件把
 *    `v-model` 直接绑在 `s.<任意键>` 上 —— 「零改动」意味着模板里一个笔误
 *    （`agentTopp`、`hoverDelayMS`）不是错误，而是一个被 deep watch **永久**写进
 *    localStorage 的幽灵键，症状只会在真机上表现成「设置页改了、引擎行为没变」。
 *    多写一行声明换整条链路的编译期保护，这笔账划得来。
 *
 *    已迁出的历史键与迁移标志位刻意**不**在 `UiSettings` 上（见该文件头）。
 */
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { deleteApiEndpoint, getApiEndpoints, saveApiEndpoint } from '@engine/database';
import {
  DEFAULT_IMAGE_BASE_NEGATIVE,
  DEFAULT_IMAGE_MAX_PER_HOUR,
  DEFAULT_IMAGE_MAX_PER_MESSAGE,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_QUALITY_SUFFIX,
} from '@engine/image-defaults';
import { detach } from './db-write';
import { fillMissingAgentSettings } from './agent-settings';
import { migrateLegacyAgentMaps } from './agent-settings-migration';
import type { UiSettings } from './settings-types';
import {
  apiEndpointToEntry,
  apiEntryToEndpoint,
  migrateApiKeysToDexie,
  type ApiKeyMigrationOutcome,
} from './api-key-migration';

// ===== 类型 =====

export interface ApiEntry {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  maskedKey: string;
  model: string;
  models: string[];
  /** `'image'` = 出图端点（NovelAI），由图像生成分区的端点选择器筛选 */
  apiType: 'chat' | 'embedding' | 'image';
  enableThinking?: boolean;
}

export interface PresetItem {
  id: string;
  name: string;
  description?: string;
  /** SillyTavern 预设原始 JSON：prompts / temp_openai / openai_max_tokens / top_p_openai / freq_pen_openai 等（ST 导入或前端构建） */
  settings: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

// ===== Phase 8: Agent 项目默认配置 =====

export interface AgentDefaultEntry {
  worldBookEnabled: boolean;
  worldBookIds: string[];
  model: string;
  systemPrompt: string;
  presetId: string;
  preset: PresetItem | null;
  temperature: number;
  topP: number;
  freqPen: number;
  presPen: number;
  maxTokens: number;
  /** Phase 8.6: 历史对话注入层数（几轮 user+ai 对，0=不注入；不填=按 agent 类别默认） */
  historyLayers?: number;
  /** Phase 8.6: 每条历史正文截断字数（不填=按 agent 类别默认） */
  historySlice?: number;
  /** Phase 10: Custom template string with {{PLACEHOLDER}} references */
  template?: string;
}

export interface AgentProjectDefaults {
  version: number;
  agents: Record<string, AgentDefaultEntry>;
}

// ===== 默认值 =====

const STORAGE_KEY = 'fated-poem-settings';

function containsApiPoolKey(settings: Record<string, unknown>): boolean {
  return (
    Array.isArray(settings.apiPool) &&
    settings.apiPool.some(
      (entry) =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>).apiKey === 'string' &&
        ((entry as Record<string, unknown>).apiKey as string).length > 0,
    )
  );
}

/** localStorage is configuration metadata only; API secrets live in Dexie `apiEndpoints`. */
export function serializeSettingsForLocalStorage(settings: Record<string, unknown>): string {
  const copy = detach(settings);
  if (Array.isArray(copy.apiPool)) {
    for (const entry of copy.apiPool) {
      if (entry && typeof entry === 'object' && 'apiKey' in entry) {
        (entry as Record<string, unknown>).apiKey = '';
      }
    }
  }
  return JSON.stringify(copy);
}

/**
 * 内容-引擎分离波 1 / D22：把残留的 `settings.presets` localStorage 镜像一次性迁进 Dexie。
 *
 * 迁移规则（幂等、跑一次）：
 *   · 镜像无 presets（新用户 / 已迁完）→ 不动（仍清掉残留空数组键）
 *   · 镜像有 presets 且 Dexie presets 表为空 → 镜像整份迁入 Dexie，然后从 settings 删除字段
 *   · 镜像有 presets 但 Dexie 已有数据 → 以 Dexie 为准，直接弃镜像（删字段）
 *
 * 🔴 无论命中哪条有数据的分支，**都要从 settings 删除 presets 字段并 persist**：
 *    `UiSettings` 已不声明该字段，留着会被 deep watch 永久写回 localStorage 成幽灵键。
 *    迁移成功后下次启动镜像无 presets，本函数空转。
 */
async function migratePresetsMirrorToDexie(
  settingsValue: Record<string, unknown>,
  persist: () => boolean,
): Promise<void> {
  const mirror = settingsValue.presets;
  if (!Array.isArray(mirror) || mirror.length === 0) {
    // 即便残留一个空数组也清掉键，避免 deep watch 写回。
    if ('presets' in settingsValue) {
      delete settingsValue.presets;
      persist();
    }
    return;
  }
  try {
    const { getPresets, savePreset } = await import('@engine/database');
    const existing = await getPresets();
    if (!existing || existing.length === 0) {
      // Dexie 空 → 迁入镜像里的每一条
      for (const p of mirror) {
        if (p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string') {
          await savePreset(p as any);
        }
      }
    }
    // 无论是否迁入（Dexie 已有则弃镜像），都删字段。
    delete settingsValue.presets;
    persist();
  } catch {
    // IndexedDB 不可用：保留镜像字段不动，下次启动再试。
  }
}

function getDefaults(): UiSettings {
  return {
    // API 池
    apiPool: [],

    // Agent 配置
    activeAgent: null,
    /**
     * per-Agent 设置 —— 一个 agent 一条（Q-18）。
     *
     * 此前是 12 张用同一个 agentId 作键的兄弟 map（agentModels / agentPrompts /
     * agentTemperature / …）。加一个旋钮要改七处，漏改一张会产出「UI 上看着正常」
     * 的半恢复 Agent。老用户那 12 张由 `migrateLegacyAgentMaps` 在 store 构造期
     * （`ref()` 之前）折进来，所以活状态里只会有这一种形状。
     *
     * 唯一读写口是 `agent-settings.ts`；数值默认在 `AGENT_SETTINGS_DEFAULTS`。
     */
    agents: {},
    /**
     * 「这个 Agent 有未保存的改动」。
     *
     * 🔴 **不并进 `agents`**：它是 UI 状态不是设置，而 `AgentSettingsEntry` 与磁盘上的
     *    `AgentDefaultEntry` 刻意同形 —— 混进去会让它跟着 `saveAsDefault` 一路写进
     *    `data/defaults/agent-config.json`。
     * 🔴 **今天全仓零读取**（15 处写、0 处读，Q-18 核查）：本该驱动子导航上的
     *    「●未保存」角标，那个角标没有被实现。留着是因为删掉 15 个写入点会把这次
     *    类型化的 diff 冲淡，且真要补那个角标时管线是现成的。`agentPromptEdited` 同此。
     */
    agentDirty: {},
    agentPromptEdited: false,

    // 预设系统 (ChatPreset)
    // 🔴 `presets` 镜像已删除（内容-引擎分离波 1 / D22）：预设真源是 Dexie `presets` 表，
    //    唯一响应式视图是 usePresets composable。留个空数组会让消费端以为这里仍是真相来源，
    //    而 deep watch 又会把它写回 localStorage —— 与 worldBooks/beautifierRules 同口径。
    //    下面这项是「当前选中哪条预设」的 UI 状态，继续留在设置里。
    activePresetId: '',

    // Phase 8: 世界书管理
    // 🔴 `worldBooks` 已迁出（Phase 0 / 设计 D2）：书本体在 Dexie `worldBooks` 表，
    //    唯一入口是 worldbook-store。此处刻意**不留默认值** —— 留个空数组会让消费端
    //    以为这里仍是真相来源，而 deep watch 又会把它写回 localStorage。
    //    下面几项是 UI 选择/开关，不是书内容，继续留在设置里。
    activeWorldBookId: null,
    worldBookDirty: false,
    allowEditBuiltInBooks: false, // 允许编辑内置世界书（默认只读保护）

    // 剧情系统（新档默认值 — 捏人页初始化时读入，字段形状对齐 create-store / types.ts PlotSettings）
    plotMode: 'off',
    plotDurationYears: 5,
    plotDifficultyTier: 'adaptive',
    plotAllowNonWorldbookNpc: true,
    plotGenrePreference: ['combat', 'social'],
    plotCustomPreference: '',
    plotFocusRegion: '',
    plotTabooContent: '',
    plotChapterCount: 0,
    plotEventsPerChapter: 0,

    // 记忆 & 缓存
    memoryRecallCount: 20,
    memoryCompressionThreshold: 100,
    memorySnapshotLimit: 30,
    snapshotRetentionMode: 'tiered',
    memoryCacheStrategy: 'balanced',

    // 交互 —— 悬停浮层延迟（ms）。全站 hover-to-display 统一读它：
    // 状态效果气泡、在场角色心声气泡等。0 = 立即弹出。
    hoverDelayMs: 200,

    // 交互 —— 减少动态效果。默认**关**：开着才是特殊要求，不该替所有人做主。
    // 关掉时系统的 `prefers-reduced-motion` 仍然独立生效（本开关只做"额外强制开启"，
    // 不做"强制关闭系统偏好"）。判定与写入见 lib/reduced-motion.ts。
    reducedMotion: false,

    // 消息 & 系统事件可见性
    systemEventsVisible: true,
    systemEventFilters: {
      craft: true,
      char_gen: true,
      item_gen: true,
      combat: true,
      character_update: false,
      item_update: false,
      quest_update: false,
    },

    // 音频系统（全局环境属性，不属于存档状态 — 设计 §4.1）
    audioMasterVolume: 0.7,
    audioMasterMuted: false,
    audioMusicVolume: 0.7,
    audioMusicMuted: false,
    audioSfxVolume: 0.7,
    audioSfxMuted: false,
    audioRepeat: 'all',
    audioShuffle: false,
    audioLastPlaylistId: '',
    /** 内置曲目不可删，只能隐藏（设计 §2）— 对齐 beautifierBuiltinDisabled 先例 */
    audioHiddenBuiltinIds: [],
    /**
     * 进入新地点时自动换 BGM。默认开 —— 这是场景配乐的主路径。
     * 关掉之后地点变化不再触发，音乐完全由用户手动控制（AI 的 <play_audio> 标记同样不生效）。
     */
    audioSceneAutoPlay: true,

    // 输出美化
    beautifierEnabled: true,
    // 🔴 Phase 0b 已迁出，此处刻意**不留默认值**：
    //   · beautifierRules      → Dexie `beautifierRules` 表（唯一入口 beautifier-store）
    //   · beautifierPresetRules → 派生缓存，改为 beautifier-store 的纯内存 ref，不再持久化
    //   留个空数组会让消费端以为这里仍是真相来源，而 deep watch 又会把它写回 localStorage。
    //   下面这项是几个 id 的开关列表，体积无关紧要，继续留在设置里。
    beautifierBuiltinDisabled: [],

    // 图像生成（设计 §11）——
    // 🔴 常量一律从 `image-defaults.ts` 取，**不照抄设计文档里的字面值**：
    //    画质后缀与基础负向都是长串，抄一份进来就是第二个真相来源，而两处漂移
    //    的症状只是「画出来的东西不太对」，不会有任何报错。
    //    尺寸/步数/采样器那几个是录制样本值（§6.1），它们没有常量，如实写在这里。
    imageGenMode: 'manual',
    imageEndpointId: null,
    imageModel: DEFAULT_IMAGE_MODEL,
    imageQualitySuffix: DEFAULT_IMAGE_QUALITY_SUFFIX,
    imageBaseNegative: DEFAULT_IMAGE_BASE_NEGATIVE,
    imageExtraNegative: '',
    imageMaxRating: 'general',
    imageBlurByDefault: false,
    imageAutoConfirmed: false,
    imageWidth: 1216,
    imageHeight: 832,
    imageSteps: 23,
    imageScale: 4.5,
    imageSampler: 'k_euler_ancestral',
    imageNoiseSchedule: 'karras',
    imageUcPreset: 0,
    // 🔴 'unset' 而不是 'opus'：没问过用户就假设他有 Opus，等于替他宣布「这些图不要钱」
    imageNaiTier: 'unset',
    imageMaxPerMessage: DEFAULT_IMAGE_MAX_PER_MESSAGE,
    imageMaxPerHour: DEFAULT_IMAGE_MAX_PER_HOUR,
  };
}

// ===== Store =====

export const useSettingsStore = defineStore('settings', () => {
  // 从 localStorage 恢复
  let saved: Record<string, any> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch {
    /* 解析失败用默认值 */
  }

  // 合并：已存值覆盖默认值（支持未来新增字段自动补默认值）
  const defaults = getDefaults();
  const merged = { ...defaults, ...saved };

  // Q-18：老用户那 12 张 per-Agent map → `agents`。
  //
  // 🔴 位置不可挪动：必须在 `ref()` **之前**、同步执行。放到 ref 之后就有一段
  //    「响应式状态里是旧形状」的窗口，而 deep watch 会把那一拍原样写回 localStorage；
  //    放到 setTimeout 里更糟 —— 首屏渲染会先读到一个空的 `agents`，
  //    每个 Agent 的模型/提示词会当场显示成默认值。
  //    它是纯内存重排、无 I/O、幂等，所以这里同步跑没有代价。
  migrateLegacyAgentMaps(merged);

  // Phase 0: 内置世界书合并已搬去 worldbook-store 的 init()（设计 D4 第 6 步）——
  // 必须在 localStorage→Dexie 迁移**之后**、针对 Dexie 执行，否则会把内置书写回
  // localStorage，源数组在迁移脚下漂移。
  setTimeout(async () => {
    // 🔴 内容-引擎分离波 1 / D22：一次性迁移 presets 镜像 → Dexie。
    //    必须在 loadAgentProjectDefaults 之前跑：seed 那步只在 Dexie 空时播种出厂预设，
    //    迁移先把用户的第三方预设从镜像搬进 Dexie，seed 就不会覆盖它们。
    //    迁移幂等：完成后从 settings 删除 presets 字段并 persist，下次启动不再触发。
    await migratePresetsMirrorToDexie(settings.value as Record<string, unknown>, () => {
      try {
        localStorage.setItem(STORAGE_KEY, serializeSettingsForLocalStorage(settings.value));
        return true;
      } catch {
        return false;
      }
    });

    // 加载项目默认 Agent 配置
    await loadAgentProjectDefaults();

    // Phase 0b: 美化预设规则的启动加载已搬去 beautifier-store 的 init()。
    // 必须在 localStorage→Dexie 迁移**之后**跑，否则算出来的 22 条（~378 KB）会被
    // 塞回 settings.beautifierPresetRules，源对象在迁移脚下漂移。
    // 现在它只进 beautifier-store 的纯内存 ref，不再持久化。
  }, 0);

  const settings = ref<UiSettings>(merged);
  const apiSecretsReady = ref(false);
  const apiSecretsError = ref<string | null>(null);
  const lastApiKeyMigration = ref<ApiKeyMigrationOutcome | null>(null);
  // New/sanitized profiles can persist immediately. Legacy profiles pause until their only key
  // copy has been verified in Dexie.
  let settingsPersistenceEnabled = !containsApiPoolKey(saved);
  let apiInitPromise: Promise<ApiKeyMigrationOutcome> | null = null;

  function persistRedactedSettings(): boolean {
    try {
      localStorage.setItem(STORAGE_KEY, serializeSettingsForLocalStorage(settings.value));
      return true;
    } catch {
      return false;
    }
  }

  // deep watch → 自动存
  watch(
    settings,
    () => {
      saveNow();
    },
    { deep: true },
  );

  /** 手动触发存储（正常情况下不需要调用，deep watch 自动处理） */
  function saveNow(): boolean {
    // Before migration succeeds, overwriting localStorage could destroy the only key copy.
    if (!settingsPersistenceEnabled) return false;
    return persistRedactedSettings();
  }

  async function initApiSecrets(): Promise<ApiKeyMigrationOutcome> {
    if (!apiInitPromise) apiInitPromise = doInitApiSecrets();
    const outcome = await apiInitPromise;
    if (outcome.status === 'failed') apiInitPromise = null;
    return outcome;
  }

  async function doInitApiSecrets(): Promise<ApiKeyMigrationOutcome> {
    const outcome = await migrateApiKeysToDexie({
      settings: settings.value,
      persistSettings: persistRedactedSettings,
    });
    lastApiKeyMigration.value = outcome;
    apiSecretsReady.value = true;

    if (outcome.status === 'failed') {
      apiSecretsError.value = outcome.message;
      // With no legacy secret at risk, unrelated settings may still be persisted safely.
      settingsPersistenceEnabled = !outcome.legacyKeysRetained;
      return outcome;
    }

    settings.value.apiPool = outcome.entries;
    apiSecretsError.value = null;
    settingsPersistenceEnabled = true;
    persistRedactedSettings();
    return outcome;
  }

  async function saveApiEntry(entry: ApiEntry): Promise<void> {
    const initialized = await initApiSecrets();
    if (initialized.status === 'failed') {
      throw new Error(`API key storage is unavailable: ${initialized.message}`);
    }
    const copy = JSON.parse(JSON.stringify(entry)) as ApiEntry;
    await saveApiEndpoint(apiEntryToEndpoint(copy));
    const index = (settings.value.apiPool as ApiEntry[]).findIndex((item) => item.id === copy.id);
    if (index >= 0) settings.value.apiPool[index] = copy;
    else settings.value.apiPool.push(copy);
    persistRedactedSettings();
  }

  async function removeApiEntry(id: string): Promise<void> {
    const initialized = await initApiSecrets();
    if (initialized.status === 'failed') {
      throw new Error(`API key storage is unavailable: ${initialized.message}`);
    }
    await deleteApiEndpoint(id);
    settings.value.apiPool = (settings.value.apiPool as ApiEntry[]).filter(
      (entry) => entry.id !== id,
    );
    persistRedactedSettings();
  }

  async function reloadApiEntries(): Promise<void> {
    const rows = await getApiEndpoints();
    settings.value.apiPool = rows.map((row) => apiEndpointToEntry(row));
    settingsPersistenceEnabled = true;
    apiSecretsError.value = null;
    apiSecretsReady.value = true;
    persistRedactedSettings();
  }

  /** 重置所有设置为默认值 */
  function resetAll() {
    settings.value = getDefaults();
    saveNow();
  }

  /**
   * 恢复世界书为默认：清除旧数据，重新从 data/worldbooks/ 加载。
   *
   * Phase 0 起书本体在 Dexie，实现委托给 worldbook-store（唯一入口）。
   * 这里保留薄壳只为不动既有调用点。动态 import 是为了避开
   * worldbook-store → settings-store 的循环依赖。
   */
  async function resetWorldBooksToDefaults() {
    try {
      const { useWorldBookStore } = await import('./worldbook-store');
      await useWorldBookStore().resetToDefaults();
      saveNow();
    } catch {
      /* fetch / IndexedDB 不可用时静默跳过 */
    }
  }

  // ===== 项目默认 Agent 配置 =====

  const projectAgentDefaults = ref<AgentProjectDefaults>({ version: 1, agents: {} });

  /** 从 data/defaults/agent-config.json 加载项目默认配置 */
  async function loadAgentProjectDefaults() {
    // 内容-引擎分离（波 1 T2 / D16）：经 ContentProvider 收口。
    // 🔴 `loadProjectDefaults()` 内部 `await contentReadyPromise`——保证 T7 的 pack 叠加层
    //    有机会在 fetch 落地前灌注。本波（T2）ready 立即 resolve，等价于直接 fetch。
    //    装载失败上报 contentStatus（不阻塞启动），这里照旧走空骨架兜底。
    const { useContentStore } = await import('./content-store');
    const config = (await useContentStore().loadProjectDefaults()) as {
      version?: number;
      agents?: Record<string, AgentDefaultEntry>;
    };
    try {
      if (config && config.agents) {
        projectAgentDefaults.value = config as AgentProjectDefaults;
      }
    } catch {
      // 形状不符，使用空骨架
    }
    // 对未被用户配置过的 agent 补上项目默认值
    const pd = projectAgentDefaults.value?.agents;
    if (!pd) return;
    for (const [agentId, entry] of Object.entries(pd)) {
      // Q-18：此前是 13 段逐字同形的 `if (!(agentId in map))` 手抄（其中 template
      // 那段还抄了**两遍**，一模一样）。加第 14 个旋钮要记得在这里再抄一段。
      // 语义原样保留：只填空位不覆盖用户已改的；historyLayers/historySlice 来源没给
      // 就不写键，把「走引擎按类别的默认」那条语义还回去。
      fillMissingAgentSettings(settings.value, agentId, entry);
      // 预设：DB 空 → seed 出厂预设；DB 有同 id → 同步出厂 name（保留用户 prompts 编辑）
      //
      // 🔴 内容-引擎分离波 1 / D22：预设只写 Dexie，不再碰 `settings.presets` 镜像。
      //    （此前这里还同步写镜像 —— 镜像删除后那段是死代码。）响应式视图由
      //    usePresets composable 提供，本处 seed 之后下次 loadPresets 自然读到。
      if (entry.preset && entry.presetId) {
        try {
          const { getPresets, savePreset } = await import('@engine/database');
          const existing = await getPresets();
          const embedded = JSON.parse(JSON.stringify(entry.preset)) as PresetItem;
          if (!existing || existing.length === 0) {
            await savePreset(embedded);
          } else {
            // M5.1: 出厂预设改名同步 —— id 匹配时把 DB 预设 name 更新为出厂版
            // （prompts/settings 保留用户编辑；仅 name 跟随 agent-config.json）
            const dbMatch = existing.find((p) => p.id === embedded.id);
            if (dbMatch && dbMatch.name !== embedded.name) {
              await savePreset({ ...dbMatch, name: embedded.name });
            }
          }
        } catch {
          /* IndexedDB 不可用时静默跳过 */
        }
        if (!settings.value.activePresetId) {
          settings.value.activePresetId = entry.presetId;
        }
      }
    }
  }

  /** 保存项目默认 Agent 配置到 data/defaults/agent-config.json */
  async function saveAgentProjectDefaults(data: AgentProjectDefaults): Promise<boolean> {
    try {
      const res = await fetch('/api/defaults/agent-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data, null, 2),
      });
      if (res.ok) {
        projectAgentDefaults.value = data;
        return true;
      }
    } catch {
      // 网络错误
    }
    return false;
  }

  /** 获取浏览器存储用量 */
  async function getStorageUsage(): Promise<{ used: number; quota: number; pct: number } | null> {
    try {
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        const est = await navigator.storage.estimate();
        const used = est.usage ?? 0;
        const quota = est.quota ?? 0;
        return { used, quota, pct: quota > 0 ? (used / quota) * 100 : 0 };
      }
    } catch {
      /* 浏览器不支持 */
    }
    return null;
  }

  return {
    settings,
    apiSecretsReady,
    apiSecretsError,
    lastApiKeyMigration,
    saveNow,
    initApiSecrets,
    saveApiEntry,
    removeApiEntry,
    reloadApiEntries,
    resetAll,
    resetWorldBooksToDefaults,
    getStorageUsage,
    projectAgentDefaults,
    loadAgentProjectDefaults,
    saveAgentProjectDefaults,
  };
});
