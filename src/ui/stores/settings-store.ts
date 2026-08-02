/**
 * 设置持久化 Store — 通用 key-value 自动存 localStorage
 *
 * 用法：
 *   const s = useSettingsStore()
 *   s.settings.apiPool = [...]        // 写入 → 自动存
 *   s.settings.任意新字段 = 值         // 加新设置零改动
 *
 * 设计：一个 ref 装所有设置，deep watch 自动写 localStorage。
 */
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { deleteApiEndpoint, getApiEndpoints, saveApiEndpoint } from '@engine/database';
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
  apiType: 'chat' | 'embedding';
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
  const copy = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
  if (Array.isArray(copy.apiPool)) {
    for (const entry of copy.apiPool) {
      if (entry && typeof entry === 'object' && 'apiKey' in entry) {
        (entry as Record<string, unknown>).apiKey = '';
      }
    }
  }
  return JSON.stringify(copy);
}

function getDefaults(): Record<string, any> {
  return {
    // API 池
    apiPool: [] as ApiEntry[],

    // Agent 配置
    activeAgent: null as string | null,
    agentModels: {} as Record<string, string>,
    agentWorldbookEnabled: {} as Record<string, boolean>,
    agentWorldbookIds: {} as Record<string, string[]>,
    agentPrompts: {} as Record<string, string>,
    /** Phase 10: 用户自定义的 Agent 上下文模板 ({{PLACEHOLDER}} 字符串) */
    agentTemplates: {} as Record<string, string>,
    agentPromptEdited: false,
    agentDirty: {} as Record<string, boolean>,

    // Agent LLM 参数 (每 Agent 独立)
    agentTemperature: {} as Record<string, number>,
    agentTopP: {} as Record<string, number>,
    agentFreqPen: {} as Record<string, number>,
    agentPresPen: {} as Record<string, number>,
    agentMaxTokens: {} as Record<string, number>,
    // Phase 8.6: Agent 上下文注入 (每 Agent 独立)
    agentHistoryLayers: {} as Record<string, number>,
    agentHistorySlice: {} as Record<string, number>,

    // 预设系统 (ChatPreset)
    presets: [] as PresetItem[],
    activePresetId: '',

    // Phase 8: 世界书管理
    // 🔴 `worldBooks` 已迁出（Phase 0 / 设计 D2）：书本体在 Dexie `worldBooks` 表，
    //    唯一入口是 worldbook-store。此处刻意**不留默认值** —— 留个空数组会让消费端
    //    以为这里仍是真相来源，而 deep watch 又会把它写回 localStorage。
    //    下面几项是 UI 选择/开关，不是书内容，继续留在设置里。
    activeWorldBookId: null as string | null,
    worldBookDirty: false,
    allowEditBuiltInBooks: false, // 允许编辑内置世界书（默认只读保护）

    // 剧情系统（新档默认值 — 捏人页初始化时读入，字段形状对齐 create-store / types.ts PlotSettings）
    plotMode: 'off' as string,
    plotDurationYears: 5,
    plotDifficultyTier: 'adaptive' as string | number,
    plotAllowNonWorldbookNpc: true,
    plotGenrePreference: ['combat', 'social'] as string[],
    plotCustomPreference: '',
    plotFocusRegion: '',
    plotTabooContent: '',
    plotChapterCount: 0 as number,
    plotEventsPerChapter: 0 as number,

    // 记忆 & 缓存
    memoryRecallCount: 20,
    memoryCompressionThreshold: 100,
    memorySnapshotLimit: 30,
    snapshotRetentionMode: 'tiered' as 'tiered' | 'dense',
    memoryCacheStrategy: 'balanced' as string,

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
    } as Record<string, boolean>,

    // 音频系统（全局环境属性，不属于存档状态 — 设计 §4.1）
    audioMasterVolume: 0.7,
    audioMasterMuted: false,
    audioMusicVolume: 0.7,
    audioMusicMuted: false,
    audioSfxVolume: 0.7,
    audioSfxMuted: false,
    audioRepeat: 'all' as 'off' | 'all' | 'one',
    audioShuffle: false,
    audioLastPlaylistId: '',
    /** 内置曲目不可删，只能隐藏（设计 §2）— 对齐 beautifierBuiltinDisabled 先例 */
    audioHiddenBuiltinIds: [] as string[],
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
    beautifierBuiltinDisabled: [] as string[],
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

  // Phase 0: 内置世界书合并已搬去 worldbook-store 的 init()（设计 D4 第 6 步）——
  // 必须在 localStorage→Dexie 迁移**之后**、针对 Dexie 执行，否则会把内置书写回
  // localStorage，源数组在迁移脚下漂移。
  setTimeout(async () => {
    // 加载项目默认 Agent 配置
    await loadAgentProjectDefaults();

    // Phase 0b: 美化预设规则的启动加载已搬去 beautifier-store 的 init()。
    // 必须在 localStorage→Dexie 迁移**之后**跑，否则算出来的 22 条（~378 KB）会被
    // 塞回 settings.beautifierPresetRules，源对象在迁移脚下漂移。
    // 现在它只进 beautifier-store 的纯内存 ref，不再持久化。
  }, 0);

  const settings = ref<Record<string, any>>(merged);
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
    try {
      const res = await fetch('/data/defaults/agent-config.json');
      if (res.ok) {
        projectAgentDefaults.value = await res.json();
      }
    } catch {
      // 文件不存在或 fetch 失败，使用空骨架
    }
    // 对未被用户配置过的 agent 补上项目默认值
    const pd = projectAgentDefaults.value?.agents;
    if (!pd) return;
    for (const [agentId, entry] of Object.entries(pd)) {
      if (!(agentId in (settings.value.agentModels as Record<string, string>))) {
        settings.value.agentModels[agentId] = entry.model ?? '';
      }
      if (!(agentId in (settings.value.agentWorldbookEnabled as Record<string, boolean>))) {
        settings.value.agentWorldbookEnabled[agentId] = entry.worldBookEnabled ?? false;
      }
      if (!(agentId in (settings.value.agentWorldbookIds as Record<string, string[]>))) {
        settings.value.agentWorldbookIds[agentId] = [...(entry.worldBookIds ?? [])];
      }
      if (!(agentId in (settings.value.agentPrompts as Record<string, string>))) {
        settings.value.agentPrompts[agentId] = entry.systemPrompt ?? '';
      }
      // Phase 10: 从项目默认加载上下文模板
      if (
        entry.template &&
        !(agentId in (settings.value.agentTemplates as Record<string, string>))
      ) {
        settings.value.agentTemplates[agentId] = entry.template;
      }
      // LLM 参数（缺省使用合理默认值）
      if (!(agentId in (settings.value.agentTemperature as Record<string, number>))) {
        settings.value.agentTemperature[agentId] = entry.temperature ?? 0.7;
      }
      if (!(agentId in (settings.value.agentTopP as Record<string, number>))) {
        settings.value.agentTopP[agentId] = entry.topP ?? 1.0;
      }
      if (!(agentId in (settings.value.agentFreqPen as Record<string, number>))) {
        settings.value.agentFreqPen[agentId] = entry.freqPen ?? 0;
      }
      if (!(agentId in (settings.value.agentPresPen as Record<string, number>))) {
        settings.value.agentPresPen[agentId] = entry.presPen ?? 0;
      }
      if (!(agentId in (settings.value.agentMaxTokens as Record<string, number>))) {
        settings.value.agentMaxTokens[agentId] = entry.maxTokens ?? 16384;
      }
      // Phase 8.6: 历史注入层数/截断字数 — 不设则留空 (引擎侧 defaultHistoryLayers/Slice 兜底)
      if (
        entry.historyLayers !== undefined &&
        !(agentId in (settings.value.agentHistoryLayers as Record<string, number>))
      ) {
        settings.value.agentHistoryLayers[agentId] = entry.historyLayers;
      }
      if (
        entry.historySlice !== undefined &&
        !(agentId in (settings.value.agentHistorySlice as Record<string, number>))
      ) {
        settings.value.agentHistorySlice[agentId] = entry.historySlice;
      }
      // Phase 10: 从项目默认加载 Agent 上下文模板
      if (
        entry.template &&
        !(agentId in (settings.value.agentTemplates as Record<string, string>))
      ) {
        settings.value.agentTemplates[agentId] = entry.template;
      }
      // 预设：DB 空 → seed 出厂预设；DB 有同 id → 同步出厂 name（保留用户 prompts 编辑）
      if (entry.preset && entry.presetId) {
        try {
          const { getPresets, savePreset } = await import('@engine/database');
          const existing = await getPresets();
          const embedded: any = JSON.parse(JSON.stringify(entry.preset));
          if (!existing || existing.length === 0) {
            await savePreset(embedded);
          } else {
            // M5.1: 出厂预设改名同步 —— id 匹配时把 DB 预设 name 更新为出厂版
            // （prompts/settings 保留用户编辑；仅 name 跟随 agent-config.json）
            const dbMatch = existing.find((p: any) => p.id === embedded.id);
            if (dbMatch && dbMatch.name !== embedded.name) {
              const updated = { ...dbMatch, name: embedded.name };
              await savePreset(updated);
              const idx = (settings.value.presets as PresetItem[]).findIndex(
                (p) => p.id === embedded.id,
              );
              if (idx >= 0) (settings.value.presets as PresetItem[])[idx] = updated as PresetItem;
            }
          }
        } catch {
          /* IndexedDB 不可用时静默跳过 */
        }
        const existingPreset = (settings.value.presets as PresetItem[]).find(
          (p) => p.id === entry.presetId,
        );
        if (!existingPreset && entry.preset) {
          (settings.value.presets as PresetItem[]).push(entry.preset);
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
