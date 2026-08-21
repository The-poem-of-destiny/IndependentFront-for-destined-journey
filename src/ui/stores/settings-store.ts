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
import { ref, watch, onScopeDispose } from 'vue';
import {
  deleteApiEndpoint,
  getApiEndpoints,
  getApiRpmPolicies,
  saveApiEndpoint,
  saveApiRpmPolicies as persistApiRpmPolicies,
} from '@engine/database';
import { credentialIdFor, replaceApiRpmPolicies } from '@engine/api-rpm-limiter';
import type { ApiRpmPolicy } from '@engine/types';
import {
  DEFAULT_IMAGE_MAX_PER_HOUR,
  DEFAULT_IMAGE_MAX_PER_MESSAGE,
  DEFAULT_IMAGE_MODEL,
} from '@engine/image-defaults';
import { FALLBACK_IMAGE_DIALECT } from '@engine/image-dialect';
import { detach } from './db-write';
import { migrateLegacyAgentOverrides } from './agent-settings';
import { migrateLegacyAgentMaps } from './agent-settings-migration';
import { migrateImageSettings, normalizeImageSettings } from './image-settings-migration';
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

    // 随机事件（随机事件系统 v1 / 裁定 §13-4）—— **全局设置**，不是新档默认值。
    // 🔴 默认必须是「开 + 1×」：这两格同时也是引擎的实际行为（main.ts 的 provider 转发它们），
    //    默认 false 的症状是整个子系统装好了、测试全绿、真机一个事件都不起，且无处报错。
    randomEventsEnabled: true,
    randomEventsFrequency: 1,

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

    // 首页 Astral Drift 动态背景。默认开；WebGL2 不可用或任一减动效来源为真时自动退回静态首页。
    homeBackdrop: true,

    // 开发者模式 —— 默认关闭。只控制诊断入口与原始技术细节；玩家可见的回合活动账本
    // 始终保留游戏语言，不随这个开关消失或变成控制台。
    developerMode: false,

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

    // 素材 —— 远程素材同步（远程素材 v1）。默认**开**：声明本来就写在世界书/内容包里，
    // 作者的意图就是「这些图从这儿取」，默认关掉等于让每个人先去设置页找一遍开关。
    // 关掉是彻底 no-op（连镜像删除都不做），见 settings-types.ts 那条注释。
    remoteAssetsEnabled: true,
    // 玩家改名/改过/删掉的远程素材槽位（「别再下回来」的备忘）。空 = 一个都没动过；
    // 每次同步后按当前声明清单收拢，不会无限长。见 settings-types.ts 那条注释。
    remoteAssetTombstones: [],

    // 图像生成（设计 §11；图像 v2 / C8 起是 per-provider 袋子）——
    // 🔴 常量一律从 `image-defaults.ts` / `image-dialect.ts` 取，**不照抄设计文档里的
    //    字面值**：抄一份进来就是第二个真相来源，而两处漂移的症状只是「画出来的
    //    东西不太对」，不会有任何报错。
    //    尺寸/步数/采样器那几个是录制样本值（§6.1），它们没有常量，如实写在这里。
    // 🔴 画质后缀与基础负向**不在这里**（C6）：它们是方言属性，默认值住在方言 JSON，
    //    这里只留一张空的覆盖表 —— 空 = 回落方言默认。
    imageProvider: 'novelai',
    imageDialectId: FALLBACK_IMAGE_DIALECT.id,
    imageDialectOverrides: {},
    imageGenMode: 'manual',
    imageWidth: 1216,
    imageHeight: 832,
    imageSteps: 23,
    imageScale: 4.5,
    imageMaxRating: 'general',
    imageBlurByDefault: false,
    imageAutoConfirmed: false,
    imageExtraNegative: '',
    imageNovelai: {
      endpointId: null,
      model: DEFAULT_IMAGE_MODEL,
      sampler: 'k_euler_ancestral',
      noiseSchedule: 'karras',
      ucPreset: 0,
      // 🔴 'unset' 而不是 'opus'：没问过用户就假设他有 Opus，等于替他宣布「这些图不要钱」
      tier: 'unset',
      maxPerMessage: DEFAULT_IMAGE_MAX_PER_MESSAGE,
      maxPerHour: DEFAULT_IMAGE_MAX_PER_HOUR,
    },
    imageComfy: {
      // 与应用同机的 ComfyUI 默认端口（dev.bat 场景）
      baseUrl: 'http://127.0.0.1:8188',
      // 空串 = 用内置最小 SDXL 图（C11），不是「没配置就不能跑」
      workflowJson: '',
      // 本地渲染慢：2 分钟硬闸会把仍在渲染的图记成失败，随后图又悄悄落在输出目录里
      timeoutMs: 600_000,
      pollIntervalMs: 1_500,
    },
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

  // 图像 v2 / C8：图像设置的**归一化 + 一次性形状迁移**，两件事分开跑。
  //
  // 🔴 位置同上，理由也同上：必须在 `ref()` **之前**同步跑。两者都是纯内存重排、
  //    无 I/O、幂等，所以在这里跑没有代价。放到 ref 之后会有一段「响应式状态里
  //    还是平铺形状」的窗口 —— 而设置页此刻读的是 `s.imageNovelai.model`，
  //    那一拍会当场炸在 undefined 上。
  //
  // 🔴 归一化**每次加载都跑，且不受旧平铺键闸门管**（2026-08-08 审查修正）：
  //    上面那句 `{ ...defaults, ...saved }` 只浅合并**一层** —— `saved.imageNovelai`
  //    整只盖掉 `defaults.imageNovelai`。于是
  //      · localStorage 里躺着 `imageNovelai: null` / `: 5`（手改 / 别的版本写坏）的
  //        **已迁过**的档案，此前永远修不回来，`checkQuota` 读 `.maxPerMessage` 直接 TypeError；
  //      · 日后往 `ImageNovelaiSettings` / `ImageComfySettings` 加字段，老用户拿到 `undefined`
  //        ——「加新设置要改两处」那条约定在袋子内部会静默失效。
  //    默认值从 `defaults` 传进去（`getDefaults()` 是唯一真源，迁移模块里那两份兜底
  //    只在它单独被调用时才用）。
  normalizeImageSettings(merged, {
    imageNovelai: defaults.imageNovelai,
    imageComfy: defaults.imageComfy,
  });
  // 一次性搬运：17 个平铺 `image*` → per-provider 袋子 + 方言覆盖（旧平铺键在不在就是信号）
  migrateImageSettings(merged);

  // Phase 0: 内置世界书合并已搬去 worldbook-store 的 init()（设计 D4 第 6 步）——
  // 必须在 localStorage→Dexie 迁移**之后**、针对 Dexie 执行，否则会把内置书写回
  // localStorage，源数组在迁移脚下漂移。
  /**
   * 构造期那个 `setTimeout(0)` 启动任务的**归属标记**。
   *
   * 🔴 这个任务此前是**无主**的：既不随 store 销毁而取消，也不检查自己是否还是当前 store。
   *    它于是能在自己那个 store 早已被替换之后，把那份陈旧快照写回 localStorage
   *    —— 生产上只有一个 store 所以看不见，HMR 与测试里各建一个 store 的场景下就是
   *    「刚清干净的 localStorage 又被上一个 store 写了回来」，下一个 store 读到幽灵快照。
   *    settings-store.test.ts 那条 API Key 用例的负载敏感偶发失败正是这样来的：
   *    幽灵快照里 `apiPool[0]` 是上一轮的**脱敏**条目（`apiKey: ''`），
   *    于是 `saveApiEntry` 把新条目 push 到了 index 1。
   */
  let bootTaskCancelled = false;
  const bootTimer = setTimeout(async () => {
    if (bootTaskCancelled) return;
    // 🔴 内容-引擎分离波 1 / D22：一次性迁移 presets 镜像 → Dexie。
    //    必须在 loadAgentProjectDefaults 之前跑：seed 那步只在 Dexie 空时播种出厂预设，
    //    迁移先把用户的第三方预设从镜像搬进 Dexie，seed 就不会覆盖它们。
    //    迁移幂等：完成后从 settings 删除 presets 字段并 persist，下次启动不再触发。
    await migratePresetsMirrorToDexie(settings.value as Record<string, unknown>, () => {
      if (bootTaskCancelled) return false;
      // 🔴 **必须走 `saveNow()`，不能直接 `localStorage.setItem`。**
      //    此前这里是裸 setItem，绕开了 `saveNow()` 的 `settingsPersistenceEnabled` 闸门
      //    —— 而那道闸门的全部意义就是「迁移验证通过之前不许覆写 localStorage，
      //    否则会毁掉密钥的唯一副本」（见 `saveNow` 的注释）。
      //    老档案（密钥还只在 localStorage 里）+ 一个 `presets` 键，就足以让这个
      //    启动任务在 `initApiSecrets()` 跑完之前把**脱敏后的** apiPool 写回去，
      //    此后 Dexie 若写不进（无痕模式 / 配额 / IndexedDB 不可用），密钥就永久没了。
      //    闸门关着时这里返回 false：presets 字段只在内存里删掉，
      //    等 `doInitApiSecrets` 验证通过后那次 `persistRedactedSettings()` 会一并落盘。
      return saveNow();
    });
    if (bootTaskCancelled) return;

    // 加载项目默认 Agent 配置
    await loadAgentProjectDefaults();

    // Phase 0b: 美化预设规则的启动加载已搬去 beautifier-store 的 init()。
    // 必须在 localStorage→Dexie 迁移**之后**跑，否则算出来的 22 条（~378 KB）会被
    // 塞回 settings.beautifierPresetRules，源对象在迁移脚下漂移。
    // 现在它只进 beautifier-store 的纯内存 ref，不再持久化。
  }, 0);

  // store 被销毁（`$dispose()` / HMR / 测试换 Pinia）时停掉启动任务 ——
  // 让它不再往一个已经不属于自己的 localStorage 里写东西。
  onScopeDispose(() => {
    bootTaskCancelled = true;
    clearTimeout(bootTimer);
  });

  const settings = ref<UiSettings>(merged);
  const apiSecretsReady = ref(false);
  const apiSecretsError = ref<string | null>(null);
  const apiRpmPolicies = ref<ApiRpmPolicy[]>([]);
  const apiRpmPoliciesError = ref<string | null>(null);
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
    // 🔴 2026-08-16（settings-store.test.ts 幽灵复活根因）：store 已销毁（$dispose /
    // HMR / 测试换 Pinia）后**一个字节都不许写**。此前只挡了 bootTimer 本体
    // （onScopeDispose → bootTaskCancelled），而构造期启动任务里的异步链
    // （loadAgentProjectDefaults → content-store → beautifier-store.refreshPresetRules）
    // 经实例绑定的 `settingsStore.saveNow` 调用的是本闭包 —— dispose 后那条链
    // 仍会把这份陈旧快照写回 localStorage，下一个 store 构造时把它当成自己的
    // apiPool 读进来（脱敏条目占住 index 0，新密钥被 push 到 index 1）。
    // 检查点放这里，覆盖所有经本实例的出写路径，不依赖调用方记得传标记。
    if (bootTaskCancelled) return false;
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
    try {
      apiRpmPolicies.value = await getApiRpmPolicies();
      replaceApiRpmPolicies(apiRpmPolicies.value);
      apiRpmPoliciesError.value = null;
    } catch (error) {
      apiRpmPoliciesError.value = String(error);
      apiRpmPolicies.value = [];
      replaceApiRpmPolicies([]);
    }
    persistRedactedSettings();
    return outcome;
  }

  async function saveRpmPolicies(policies: readonly ApiRpmPolicy[]): Promise<void> {
    if (policies.some((policy) => !Number.isSafeInteger(policy.rpmLimit) || policy.rpmLimit <= 0)) {
      throw new Error('RPM 必须是正整数');
    }
    const copy = policies.map((policy) => ({ ...policy }));
    await persistApiRpmPolicies(copy);
    apiRpmPolicies.value = copy;
    apiRpmPoliciesError.value = null;
    replaceApiRpmPolicies(copy);
  }

  async function saveApiEntry(entry: ApiEntry): Promise<void> {
    const initialized = await initApiSecrets();
    if (initialized.status === 'failed') {
      throw new Error(`API key storage is unavailable: ${initialized.message}`);
    }
    const copy = JSON.parse(JSON.stringify(entry)) as ApiEntry;
    const previous = (settings.value.apiPool as ApiEntry[]).find((item) => item.id === copy.id);
    const previousCredentialId = previous
      ? await credentialIdFor({
          baseUrl: previous.baseUrl,
          apiKey: previous.apiKey,
          label: previous.name,
        })
      : null;
    const nextCredentialId = await credentialIdFor({
      baseUrl: copy.baseUrl,
      apiKey: copy.apiKey,
      label: copy.name,
    });
    await saveApiEndpoint(apiEntryToEndpoint(copy));
    const index = (settings.value.apiPool as ApiEntry[]).findIndex((item) => item.id === copy.id);
    if (index >= 0) settings.value.apiPool[index] = copy;
    else settings.value.apiPool.push(copy);
    if (previousCredentialId && previousCredentialId !== nextCredentialId) {
      const previousPolicy = apiRpmPolicies.value.find(
        (policy) => policy.credentialId === previousCredentialId,
      );
      if (previousPolicy) {
        const stillReferenced = await hasCredentialReference(previousCredentialId, copy.id);
        const migrated = apiRpmPolicies.value.filter(
          (policy) => stillReferenced || policy.credentialId !== previousCredentialId,
        );
        if (!migrated.some((policy) => policy.credentialId === nextCredentialId)) {
          migrated.push({
            ...previousPolicy,
            credentialId: nextCredentialId,
            updatedAt: Date.now(),
          });
        }
        await saveRpmPolicies(migrated);
      }
    }
    persistRedactedSettings();
  }

  async function removeApiEntry(id: string): Promise<void> {
    const initialized = await initApiSecrets();
    if (initialized.status === 'failed') {
      throw new Error(`API key storage is unavailable: ${initialized.message}`);
    }
    const removed = (settings.value.apiPool as ApiEntry[]).find((entry) => entry.id === id);
    const removedCredentialId = removed
      ? await credentialIdFor({
          baseUrl: removed.baseUrl,
          apiKey: removed.apiKey,
          label: removed.name,
        })
      : null;
    await deleteApiEndpoint(id);
    settings.value.apiPool = (settings.value.apiPool as ApiEntry[]).filter(
      (entry) => entry.id !== id,
    );
    if (removedCredentialId && !(await hasCredentialReference(removedCredentialId))) {
      await saveRpmPolicies(
        apiRpmPolicies.value.filter((policy) => policy.credentialId !== removedCredentialId),
      );
    }
    persistRedactedSettings();
  }

  async function hasCredentialReference(credentialId: string, exceptId?: string): Promise<boolean> {
    for (const candidate of settings.value.apiPool as ApiEntry[]) {
      if (candidate.id === exceptId) continue;
      const candidateId = await credentialIdFor({
        baseUrl: candidate.baseUrl,
        apiKey: candidate.apiKey,
        label: candidate.name,
      });
      if (candidateId === credentialId) return true;
    }
    return false;
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

    // 🔴 内容-引擎分离波 1 / D44 修正 3：一次性指纹迁移。
    // 删 boot 播种后，旧安装的 settings.agents 里还存着 boot 抄进去的旧默认值
    // （看起来像用户改过）。命中历史默认指纹（scripts/build-agent-fingerprints.mjs
    // 从 data/defaults/agent-config.json 生成）的覆写键删除 → 默认层接管。
    // 用户真正改过的值指纹不匹配、原样保留。迁移幂等：第二次启动已无命中键。
    migrateLegacyAgentOverrides(settings.value);

    // 预设播种（与 agent 覆写层无关，仍走这一支）：DB 空 → seed 出厂预设；
    // DB 有同 id → 同步出厂 name（保留用户 prompts 编辑）
    //
    // 🔴 内容-引擎分离波 1 / D22：预设只写 Dexie，不再碰 `settings.presets` 镜像。
    //    （此前这里还同步写镜像 —— 镜像删除后那段是死代码。）响应式视图由
    //    usePresets composable 提供，本处 seed 之后下次 loadPresets 自然读到。
    // 🔴 D44：agent 数值/提示词/世界书不再 boot 播种进覆写层 —— 读侧
    //    （getAgentSettings）经 projectAgentDefaults 合默认层。本循环现在**只**负责
    //    story 的预设落 Dexie（其余 agent 没有嵌入式预设，entry.preset 为 null）。
    const pd = projectAgentDefaults.value?.agents;
    if (!pd) return;
    for (const [, entry] of Object.entries(pd)) {
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
    apiRpmPolicies,
    apiRpmPoliciesError,
    lastApiKeyMigration,
    saveNow,
    initApiSecrets,
    saveApiEntry,
    removeApiEntry,
    reloadApiEntries,
    saveRpmPolicies,
    resetAll,
    resetWorldBooksToDefaults,
    getStorageUsage,
    projectAgentDefaults,
    loadAgentProjectDefaults,
    saveAgentProjectDefaults,
  };
});
