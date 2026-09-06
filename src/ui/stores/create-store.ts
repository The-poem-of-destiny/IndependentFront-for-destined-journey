/**
 * 捏人页 Store — 角色创建状态管理
 *
 * 数据来源:
 * - start-catalog-mechanics.ts — 难度档位/性别枚举 + 目录 schema 与纯函数（**引擎**，D24）
 * - 内容注册表 `catalog` 面 — 命定核心/背景/种族费用/身份费用/起始地树（**内容**，D24）
 * - 内容注册表 `bloodlines` 面 — 血脉集（D25②，经 `getBloodlineSet()` 读）
 * - 内容注册表 `branding` 面 — 纪元名（D9，存档创建时盖章）
 * - tier-constants.ts — 7 层级 HP/MP/SP 乘数
 * - custom_start_index.html — BP/AP/消耗计算 原版逻辑
 *
 * 🔴 **内容三面是异步加载的**（D16/D24）：`initContent()` 是本 store 的加载门，
 * 捏人页在挂载时 await 它。加载完成前所有目录派生的 computed 都是空列表 ——
 * 组件必须看 `contentStatus` 决定画加载态/空态，而不是把空列表当成「没有内容」。
 */

import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type {
  CharacterState,
  CreatePreset,
  PlotSettings,
  PlotOutline,
  ApiEndpoint,
  AgentConfig,
  ExperienceMode,
} from '@engine/types';
import { calcResources } from '@engine/tier-constants';
// 🆕 经验系统改造 v1：创建角色时 totalExp/expToNext 用累计表语义（旧 expCap 已退役）
import { getRequiredXpForLevel, xpToNextNumber } from '@engine/exp-table';
// Q-05：从模型输出抢救 JSON 的唯一入口
import { extractJsonPayload } from '@engine/model-json';
import { getBloodlineList, getBloodlineSet, type BloodlineSet } from '@engine/bloodlines';
import { AgentClient } from '@engine/agent-client';
import {
  tryParseOutline,
  createOutlineFromAgent,
  type ParsedOutlineOutput,
} from '@engine/plot-outline';
import type { AgentContext } from '@engine/types';
import { createDefaultTime, formatGameTime, GAME_EPOCH_YEAR } from '@engine/time-system';
import { normalizeRarity } from '@engine/field-enums';
import { useSettingsStore } from './settings-store';
import {
  type CatalogItem,
  type CatalogData,
  type BackgroundTemplate,
  type DestinyCore,
  type DifficultyPreset,
  type CatalogRarityCode,
  type BackgroundCategory,
  GENDER_OPTIONS,
  ATTRIBUTE_NAMES,
  ATTR_CN_TO_EN,
  parseCatalogData,
  isCatalogPopulated,
  findDifficultyPreset,
  lookupCost,
  costTableOptions,
  flattenLocationTree,
  filterBackgroundsByCategory,
  countBackgroundsByCategory,
} from '@engine/start-catalog';
import { ensureContentRegistryLoaded, getContentRegistry } from './content-store';
import { getBranding } from '../branding-defaults';
import { loadWorldBooksWithFallback } from '@engine/builtin-worldbooks';
import { useWorldBookStore } from './worldbook-store';
import { useWorkshopStore } from './workshop-store';
import { getAgentSettings } from './agent-settings';
// 🆕 F10（2026-09-04）：plot_outline 端点解析与 game-pipeline 走同一个 fail-closed 解析器
import { resolveAgentEndpoint } from '../lib/endpoint-resolver';
import { filterBooksByEnabledEntries } from '@engine/worldbook-loader';
import type { WorldBook, WorldBookEntry } from '@engine/types';
import {
  applyWorkshopSelection,
  buildWorkshopEnableOptions,
  type WorkshopEnableOption,
} from '../lib/workshop-enable';

// ===== 类型 =====

/**
 * 捏人预设 —— 定义已迁到 `@engine/types`（分层收口）。
 *
 * 它是 Dexie `createPresets` 表的落库形状，`database.ts` 要拿它标 `CreatePresetRecord.data`；
 * 留在本 store 里就只能让引擎反向 `import type ... from '../ui/stores/create-store'`。
 * 这里 re-export 同一个名字，`PresetModal.vue` 等既有消费方的 import 路径一字未改。
 */
export type { CreatePreset } from '@engine/types';

// ===== 原版常量 (custom_start_index.html) =====
const MAX_BP = 25;
const BP_PER_ATTR_MAX = 6;

function getTier(level: number): number {
  if (level <= 4) return 1;
  if (level <= 8) return 2;
  if (level <= 12) return 3;
  if (level <= 16) return 4;
  if (level <= 20) return 5;
  if (level <= 24) return 6;
  return 7;
}

const TIER_NAMES = ['普通', '中坚', '精英', '史诗', '传说', '神话', '神祗'];

// ===== Store =====

export const useCreateStore = defineStore('create', () => {
  // ═══════════════════════════════════════════════════════
  // 步骤控制
  // ═══════════════════════════════════════════════════════
  const currentStep = ref(0);

  const stepValid = computed<Record<number, boolean>>(() => ({
    0: difficulty.value !== null,
    1: name.value.trim().length > 0 && race.value !== '' && attributesFullyAllocated.value,
    // 命定核心：内置条目**或**工坊系统项目，二者择一即可放行。
    // 只认前者时，选了工坊核心的用户会卡死在这一步（按钮永远不亮，且没有任何提示）。
    2: selectedSystemCoreEntryUid.value !== null || selectedWorkshopCoreProjectId.value !== null,
    3: true, // 角色启用（可选）
    4: true, // 装备选择
    5: true, // 背景故事
    6: true, // 剧情规划
    7: attributesFullyAllocated.value, // 确认提交前再次守住预设晚加载等绕过路径
  }));

  function nextStep() {
    if (currentStep.value < 7 && stepValid.value[currentStep.value]) currentStep.value++;
  }
  function prevStep() {
    if (currentStep.value > 0) currentStep.value--;
  }

  // ═══════════════════════════════════════════════════════
  // 内容加载门（D16/D24）—— 捏人页整页的前置
  // ═══════════════════════════════════════════════════════

  /**
   * 目录内容态。组件按它画加载态/空态。
   *
   * - `idle` 还没有人 await 过 `initContent()`
   * - `loading` 首轮加载在飞
   * - `ready` 注册表给出了非空目录
   * - `empty` 注册表就绪但目录是空的（内容缺席 / JSON 坏了 / fetch 失败）
   *
   * 🔴 `empty` **不是异常**，是「这台机器上没有内容」。捏人页要画空态而不是崩 ——
   * 注册表的逐面加载器本身永不抛（失败面保持原值），所以「加载失败」在这里
   * 与「内容确实为空」不可区分，也不必区分。
   */
  /**
   * 当前目录内容（注册表 `catalog` 面的收窄结果）。
   *
   * 🔴 **必须是 ref 而不是直接读 `getContentRegistry()`**：注册表是模块级普通变量、
   * 不带响应式，computed 里直接读它会在首次求值后永久缓存住空目录 —— 表现是
   * 内容加载完了但捏人页还是空的。装包重灌注册表时同理，靠 `initContent(true)` 重取。
   *
   * 🔴 构造时**同步**取一次：boot 链（`loadProjectDefaults`）已经灌过注册表，
   * 于是常态下 store 一建好就有内容，加载门只在冷路径（直接进捏人页 URL / 装包后）
   * 才真的等。少了这一步，每次进页面都会先闪一帧空列表。
   */
  const catalog = ref<CatalogData>(parseCatalogData(getContentRegistry().catalog));

  /** 当前血脉集（注册表 `bloodlines` 面，D25②）——同样为了响应式才落 ref */
  const bloodlineSet = ref<BloodlineSet>(getBloodlineSet());

  /**
   * 纪元名（注册表 `branding` 面，D9）。
   *
   * 🔴 引擎里**没有**具体纪元名（`time-system` 的缺省是中性空串）。真值由内容侧供给，
   * 内容缺席时落 `NEUTRAL_BRANDING.era`（中性名，不是 IP 纪元名）。
   * 存档创建时它被盖章进 `SaveProfile.gameTime.era`，此后只读存档（D9）。
   *
   * 🔴 解析走 `branding-defaults` 的 `getBranding()`（品牌面**唯一**解析处，D26），
   * 不在这里另写一个「读 raw.era」—— 两个解析器就是漂移的来路。
   */
  const era = ref(getBranding().era);

  const contentStatus = ref<'idle' | 'loading' | 'ready' | 'empty'>(
    isCatalogPopulated(catalog.value) ? 'ready' : 'idle',
  );

  /** 首轮加载的 memo（幂等闸）；`initContent(true)` 清掉它重取 */
  let contentPromise: Promise<void> | null = null;

  /**
   * 捏人页的内容加载门（幂等、**永不抛**）。
   *
   * 组件在 `onMounted` 里 `await store.initContent()`；重复调用零 I/O。
   * 注册表自身的 fetch 已经逐面兜底并上报 `contentStatus`（content-store），
   * 这里只负责把它的结果搬进响应式 ref 并给出四态。
   *
   * @param force 装包/卸载后重取（跳过 memo）
   */
  function initContent(force = false): Promise<void> {
    if (force) contentPromise = null;
    if (contentPromise) return contentPromise;
    // 已经同步拿到内容就不画加载态（否则每次进页面都闪一下「正在加载」）
    if (contentStatus.value !== 'ready') contentStatus.value = 'loading';
    contentPromise = (async () => {
      try {
        await ensureContentRegistryLoaded();
      } catch {
        /* ensureContentRegistryLoaded 自己就永不抛；这里只兜最外层意外 */
      }
      const reg = getContentRegistry();
      catalog.value = parseCatalogData(reg.catalog);
      bloodlineSet.value = getBloodlineSet();
      era.value = getBranding().era;
      contentStatus.value = isCatalogPopulated(catalog.value) ? 'ready' : 'empty';
    })();
    return contentPromise;
  }

  // ═══════════════════════════════════════════════════════
  // 难度
  // ═══════════════════════════════════════════════════════
  const difficulty = ref<DifficultyPreset | null>(null);
  const reincarnationPoints = ref(1000);

  function selectDifficulty(id: string) {
    const preset = findDifficultyPreset(id);
    if (preset) {
      difficulty.value = preset;
      reincarnationPoints.value = preset.points;
    }
  }

  // ═══════════════════════════════════════════════════════
  // 角色基本信息 (→ 变量路径)
  // ═══════════════════════════════════════════════════════
  const name = ref('');
  const gender = ref('男');
  const customGender = ref('');
  const age = ref(18);
  const race = ref('人类');
  const customRace = ref('');
  const identity = ref('非贵族平民');
  const customIdentity = ref('');
  const startLocation = ref('大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德');
  const customStartLocation = ref('');
  /** 角色性格描述 */
  const personality = ref('');
  /** 角色身材描述 */
  const physics = ref('');
  /** 角色身世简述 */
  const backstory = ref('');
  /** 补充说明 */
  const extra = ref('');

  /** 起始地级联树（内容侧） */
  const startLocationTree = computed(() => catalog.value.startLocations);
  /** 扁平化地点列表（叶子；树 → `{ label: '洲 > 国 > 城', value }`） */
  const flatLocationOptions = computed(() => flattenLocationTree(catalog.value.startLocations));

  // 🔴 血脉走 `bloodlineSet` 这个 ref 而不是无参 `getBloodlineList()`（D25②/T10）：
  //    后者同步读模块级注册表，而注册表不是响应式的 —— computed 会把首次求值时
  //    那份空集永久缓存住，内容加载完了种族下拉仍然只有「自定义」一项。
  const raceOptions = computed(() => {
    const bloodlines = getBloodlineList(bloodlineSet.value);
    return [
      ...bloodlines.map((b) => ({ label: b.name, value: b.name })),
      { label: '自定义', value: '自定义' },
    ];
  });

  const identityOptions = computed(() => costTableOptions(catalog.value.identityCosts));

  // ═══════════════════════════════════════════════════════
  // 等级 & 属性 (→ 变量路径) — 对齐原版 custom_start_index.html
  // ═══════════════════════════════════════════════════════
  const level = ref(1);
  /** 🆕 经验档位（简单/普通模式，2026-08-24）：创建存档时写入 SaveProfile.experienceMode，游戏内可随时切换 */
  const experienceMode = ref<ExperienceMode>('normal');
  const basePoints = ref<Record<string, number>>({ 力量: 0, 敏捷: 0, 体质: 0, 智力: 0, 精神: 0 });
  const attributePoints = ref<Record<string, number>>({
    力量: 0,
    敏捷: 0,
    体质: 0,
    智力: 0,
    精神: 0,
  });

  const tier = computed(() => getTier(level.value));
  const tierName = computed(() => TIER_NAMES[tier.value - 1]);
  const tierBonus = computed(() => tier.value - 1);

  const usedBP = computed(() => Object.values(basePoints.value).reduce((a, b) => a + b, 0));
  const remainingBP = computed(() => MAX_BP - usedBP.value);

  function addBasePoint(attr: string) {
    if (remainingBP.value > 0 && (basePoints.value[attr] || 0) < BP_PER_ATTR_MAX) {
      basePoints.value = { ...basePoints.value, [attr]: (basePoints.value[attr] || 0) + 1 };
    }
  }
  function removeBasePoint(attr: string) {
    if ((basePoints.value[attr] || 0) > 0) {
      basePoints.value = { ...basePoints.value, [attr]: (basePoints.value[attr] || 0) - 1 };
    }
  }

  const maxAP = computed(() => Math.max(0, level.value - 1));
  const usedAP = computed(() => Object.values(attributePoints.value).reduce((a, b) => a + b, 0));
  const remainingAP = computed(() => maxAP.value - usedAP.value);
  const attributesFullyAllocated = computed(
    () => remainingBP.value === 0 && remainingAP.value === 0,
  );

  function addAttributePoint(attr: string) {
    if (remainingAP.value > 0) {
      attributePoints.value = {
        ...attributePoints.value,
        [attr]: (attributePoints.value[attr] || 0) + 1,
      };
    }
  }
  function removeAttributePoint(attr: string) {
    if ((attributePoints.value[attr] || 0) > 0) {
      attributePoints.value = {
        ...attributePoints.value,
        [attr]: (attributePoints.value[attr] || 0) - 1,
      };
    }
  }

  // 原版: 等级变化时重置 AP
  // flush: 'sync' 确保预设加载时 level 赋值后 watch 立即执行完毕，
  // 再由后续 attributePoints = {...} 恢复预设值，不被异步 flush 覆盖。
  watch(
    level,
    () => {
      attributePoints.value = { 力量: 0, 敏捷: 0, 体质: 0, 智力: 0, 精神: 0 };
    },
    { flush: 'sync' },
  );

  const finalAttributes = computed(() => {
    const result: Record<string, number> = {};
    for (const attr of ATTRIBUTE_NAMES) {
      result[attr] =
        (basePoints.value[attr] || 0) + tierBonus.value + (attributePoints.value[attr] || 0);
    }
    return result;
  });

  const resourcesPreview = computed(() => {
    const a = finalAttributes.value;
    return calcResources(tier.value, {
      str: a['力量'] || 5,
      dex: a['敏捷'] || 5,
      con: a['体质'] || 5,
      int: a['智力'] || 5,
      spi: a['精神'] || 5,
    });
  });
  const hpPreview = computed(() => resourcesPreview.value.hp);
  const mpPreview = computed(() => resourcesPreview.value.mp);
  const spPreview = computed(() => resourcesPreview.value.sp);

  // ═══════════════════════════════════════════════════════
  // 经济 — 对齐原版消耗公式
  // ═══════════════════════════════════════════════════════
  const destinyPoints = ref(0);
  const money = ref(0);

  const raceCost = computed(() => lookupCost(catalog.value.raceCosts, race.value));
  const identityCost = computed(() => lookupCost(catalog.value.identityCosts, identity.value));
  const equipmentCost = computed(() =>
    selectedEquipments.value.reduce((s, e) => s + (e.cost || 0), 0),
  );
  const itemCost = computed(() =>
    selectedItems.value.reduce((s, i) => s + (i.cost || 0) * (i.quantity || 1), 0),
  );
  const skillCost = computed(() => selectedSkills.value.reduce((s, sk) => s + (sk.cost || 0), 0));
  const moneyCost = computed(() => Math.ceil(money.value / 100));
  const destinyCost = computed(() => Math.ceil(destinyPoints.value / 2));
  const levelCost = computed(() => Math.max(0, level.value - 1) * 5);

  const totalCost = computed(
    () =>
      raceCost.value +
      identityCost.value +
      levelCost.value +
      usedAP.value +
      equipmentCost.value +
      itemCost.value +
      skillCost.value +
      moneyCost.value +
      destinyCost.value,
  );
  const remainingPoints = computed(() => reincarnationPoints.value - totalCost.value);

  // ═══════════════════════════════════════════════════════
  // 命定核心
  // ═══════════════════════════════════════════════════════
  const destinyCore = ref<DestinyCore | null>(null);
  const destinyCorePool = computed(() => catalog.value.destinyCores);

  function selectDestinyCore(coreId: string) {
    const core = catalog.value.destinyCores.find((c) => c.id === coreId);
    destinyCore.value = core ?? null;
  }

  // ═══════════════════════════════════════════════════════
  // Phase 10h: 世界书驱动的命定核心 + 角色启用
  // ═══════════════════════════════════════════════════════

  /** system_core 世界书条目列表（命定核心候选） */
  const systemCoreEntries = ref<WorldBookEntry[]>([]);

  /** character 世界书条目列表（可启用角色） */
  const characterEntries = ref<WorldBookEntry[]>([]);

  /** 选中的命定核心 entry uid */
  const selectedSystemCoreEntryUid = ref<number | null>(null);

  /** 选中的命定核心条目 */
  const selectedSystemCoreEntry = computed<WorldBookEntry | null>(() => {
    if (selectedSystemCoreEntryUid.value === null) return null;
    return systemCoreEntries.value.find((e) => e.uid === selectedSystemCoreEntryUid.value) ?? null;
  });

  /** 勾选的 character entry uids */
  const enabledCharacterEntryUids = ref<Set<number>>(new Set());

  // ── P1-5: 第三条轴 —— 启用的工坊项目（项目级多选，D10/D12）──────────
  //
  // 刻意**不**挤命定核心那个单选槽: 一个工坊项目是 N 条条目，塞不进单个 uid 的
  // `selectedSystemCoreEntryUid`。这里存项目 id，落库时才展开成
  // `creative_workshop:<uid>` —— 与 system_core / character 同一套机制，无特判。

  /** 已装工坊项目（含各自条目 uid），由 {@link loadWorldBookEntries} 填充 */
  const workshopOptions = ref<WorkshopEnableOption[]>([]);

  /** 勾选的工坊项目 id（**不含**被选作命定核心的那个，见下） */
  const enabledWorkshopProjectIds = ref<Set<string>>(new Set());

  /**
   * 上游标了「系统」标签的工坊项目 —— 它们是**命定核心候选**，不是附加内容。
   *
   * ★ 分成两拨的理由: 命定核心是单选且必选（`stepValid[2]`），而附加内容是多选且
   * 可选。此前工坊项目一律进多选那拨，于是「选了一个工坊命定核心」既满足不了
   * 核心的必选闸门（用户卡在这一步过不去），语义上也说不通 —— 两个命定核心同时
   * 生效，世界观直接打架。
   */
  const workshopSystemOptions = computed(() =>
    workshopOptions.value.filter((o) => o.tags.includes('系统')),
  );

  /** 其余工坊项目（角色/事件/扩展…）—— 附加内容，多选 */
  const workshopExtraOptions = computed(() =>
    workshopOptions.value.filter((o) => !o.tags.includes('系统')),
  );

  /**
   * 选作命定核心的工坊项目 id。与 {@link selectedSystemCoreEntryUid} **互斥** ——
   * 命定核心只有一个，内置的和工坊的抢同一个位置。
   */
  const selectedWorkshopCoreProjectId = ref<string | null>(null);

  /** 选中的工坊命定核心（展示用） */
  const selectedWorkshopCore = computed<WorkshopEnableOption | null>(
    () =>
      workshopSystemOptions.value.find(
        (o) => o.projectId === selectedWorkshopCoreProjectId.value,
      ) ?? null,
  );

  /** 单选工坊命定核心（传 null 取消）。选中即清掉内置核心 —— 互斥 */
  function selectWorkshopCore(projectId: string | null) {
    selectedWorkshopCoreProjectId.value = projectId;
    if (projectId !== null) selectedSystemCoreEntryUid.value = null;
  }

  /** toggle 勾选工坊项目（项目级，一次连带其全部条目） */
  function toggleWorkshopProject(projectId: string) {
    const next = new Set(enabledWorkshopProjectIds.value);
    if (next.has(projectId)) {
      next.delete(projectId);
    } else {
      next.add(projectId);
    }
    enabledWorkshopProjectIds.value = next;
  }

  /**
   * 加载 system_core 和 character 条目。
   *
   * Phase 0 起改读 worldbook-store（Dexie 全量：内置 + 用户导入/编辑 + 将来的工坊书），
   * 不再直读 `data/worldbooks/*.json` —— 此前用户在设置页对内置书的编辑
   * 进不了捏人页。store 为空（IndexedDB 不可用）时仍回落 fetch 本地 JSON。
   */
  async function loadWorldBookEntries() {
    try {
      const wb = useWorldBookStore();
      await wb.init();
      const books = await loadWorldBooksWithFallback(wb.books as WorldBook[]);
      systemCoreEntries.value = books
        .filter((b) => b.partition === 'system_core')
        .flatMap((b) => b.entries);
      characterEntries.value = books
        .filter((b) => b.partition === 'character')
        .flatMap((b) => b.entries);
      // P1-5: 工坊项目走自己的项目级列表（未安装的不出现）
      const ws = useWorkshopStore();
      await ws.init();
      workshopOptions.value = buildWorkshopEnableOptions(ws.projects, books);
    } catch {
      // fetch 不可用时静默跳过，保持空数组
      systemCoreEntries.value = [];
      characterEntries.value = [];
      workshopOptions.value = [];
    }
  }

  /** 单选命定核心（传 null 取消选择）。选中即清掉工坊核心 —— 互斥 */
  function selectSystemCoreEntry(uid: number | null) {
    selectedSystemCoreEntryUid.value = uid;
    if (uid !== null) selectedWorkshopCoreProjectId.value = null;
  }

  /** toggle 勾选角色 */
  function toggleCharacterEntry(uid: number) {
    const next = new Set(enabledCharacterEntryUids.value);
    if (next.has(uid)) {
      next.delete(uid);
    } else {
      next.add(uid);
    }
    enabledCharacterEntryUids.value = next;
  }

  /** 构建存档用的世界书条目 ID 列表（partition:uid 格式） */
  function buildEnabledWorldBookEntries(): string[] {
    const ids: string[] = [];

    // 命定核心 → system_core:uid
    if (selectedSystemCoreEntryUid.value !== null) {
      ids.push(`system_core:${selectedSystemCoreEntryUid.value}`);
    }

    // 启用角色 → character:uid
    for (const uid of enabledCharacterEntryUids.value) {
      ids.push(`character:${uid}`);
    }

    // P1-5: 启用的工坊项目 → 展开成该项目全部条目的 creative_workshop:uid（D12）。
    // 走同一个纯函数，与建档后的每存档面板共用一套展开语义。
    //
    // 工坊命定核心与附加项目在**存储上没有区别**（都是 creative_workshop:uid），
    // 区别只在捏人页的选择语义（单选/必选 vs 多选/可选）。所以这里合流即可，
    // 下游 filterBooksByEnabledEntries 不需要知道哪个是核心。
    const projectIds = new Set(enabledWorkshopProjectIds.value);
    if (selectedWorkshopCoreProjectId.value !== null) {
      projectIds.add(selectedWorkshopCoreProjectId.value);
    }
    return applyWorkshopSelection(ids, workshopOptions.value, projectIds);
  }

  // ═══════════════════════════════════════════════════════
  // 装备/道具/技能 选择 (→ 开场提示词路径)
  // ═══════════════════════════════════════════════════════
  const selectedEquipments = ref<CatalogItem[]>([]);
  const selectedItems = ref<CatalogItem[]>([]);
  const selectedSkills = ref<CatalogItem[]>([]);

  const activeCategory = ref<'equipment' | 'item' | 'skill'>('equipment');
  const rarityFilter = ref<CatalogRarityCode | 'all'>('all');
  const typeFilter = ref<string>('all');

  // ═══ 装备/道具/技能 — 运行时从仓库 fetch，保留分组结构 ═══
  // 对齐参考仓库 Selections: 数据是 { 外层分组key: [物品] } 结构，
  // 外层 key（剑类武器/头部防具/戒指…）就是子分类。旧实现爬取时丢了外层 key，
  // 只留了对象内 type(武器/防具) 与 tag[0](单手剑)，导致分类粒度错位。
  const REPO_DATA_BASE =
    'https://testingcf.jsdelivr.net/gh/The-poem-of-destiny/FrontEnd-for-destined-journey@1.8.2/public/assets/data';

  const equipmentGroups = ref<Record<string, CatalogItem[]>>({});
  const itemGroups = ref<Record<string, CatalogItem[]>>({});
  const skillGroups = ref<Record<string, CatalogItem[]>>({});

  /** 仓库原始对象 → CatalogItem */
  function parseCatalogItem(
    raw: any,
    category: 'equipment' | 'item' | 'skill',
    group: string,
  ): CatalogItem {
    return {
      id: `${category[0]}_${group}_${(raw.name || '').replace(/[^a-zA-Z一-鿿]/g, '_')}`,
      name: raw.name || '',
      category,
      type: raw.type || '',
      rarity: raw.rarity || 'common',
      tag: raw.tag || [],
      effect: raw.effect || {},
      consume: raw.consume || '',
      description: raw.description || '',
      cost: raw.cost ?? 30,
      ...(category === 'item' ? { quantity: raw.quantity ?? 1 } : {}),
    };
  }

  /** fetch 仓库 JSON 并保留 {分组: [物品]} 结构（清洗注释/尾逗号） */
  async function loadGroupedCatalog(
    file: string,
    category: 'equipment' | 'item' | 'skill',
  ): Promise<Record<string, CatalogItem[]>> {
    try {
      const resp = await fetch(`${REPO_DATA_BASE}/${file}.json`);
      const text = await resp.text();
      const cleaned = text
        .replace(/\/\/.*$/gm, '')
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']');
      const data = JSON.parse(cleaned);
      const result: Record<string, CatalogItem[]> = {};
      for (const [group, list] of Object.entries(data)) {
        if (!Array.isArray(list)) continue;
        result[group] = (list as any[]).map((raw) => parseCatalogItem(raw, category, group));
      }
      return result;
    } catch {
      return {};
    }
  }

  // 三类并行加载（Node 测试环境 fetch 失败则保持空 {}，筛选相关测试见空跳过）
  // `void` + `.catch` 是刻意的：这是发射后不管的预热，失败就保持空目录（上面
  // loadGroupedCatalog 已经自己吞过一层），但**不能**让拒绝漏成未处理拒绝。
  void Promise.all([
    loadGroupedCatalog('equipments', 'equipment'),
    loadGroupedCatalog('items', 'item'),
    loadGroupedCatalog('skills', 'skill'),
  ])
    .then(([eq, it, sk]) => {
      equipmentGroups.value = eq;
      itemGroups.value = it;
      skillGroups.value = sk;
    })
    .catch((err: unknown) => {
      console.error('[create-store] 目录预热失败，保持空目录:', err);
    });

  /** 当前大分类对应的分组数据 */
  const activeGroups = computed<Record<string, CatalogItem[]>>(() => {
    switch (activeCategory.value) {
      case 'equipment':
        return equipmentGroups.value;
      case 'item':
        return itemGroups.value;
      case 'skill':
        return skillGroups.value;
      default:
        return {};
    }
  });

  const filteredPool = computed(() => {
    const groups = activeGroups.value;
    // typeFilter 现存的是「分组 key」（剑类武器/头部防具…），'all' = 跨组全部
    let pool: CatalogItem[];
    if (typeFilter.value !== 'all' && groups[typeFilter.value]) {
      pool = groups[typeFilter.value];
    } else {
      pool = Object.values(groups).flat();
    }
    if (rarityFilter.value !== 'all') {
      pool = pool.filter((i) => i.rarity === rarityFilter.value);
    }
    return pool;
  });

  watch(activeCategory, () => {
    typeFilter.value = 'all';
  });

  /**
   * 子分类 = 当前大分类下仓库的分组 key
   * 装备 → 剑类武器/斧锤类武器/头部防具/戒指… · 技能 → 主动/被动…
   * 完全对齐参考仓库 Selections 的 Object.keys(data) 语义
   */
  const subCategories = computed(() =>
    Object.keys(activeGroups.value).sort((a, b) => a.localeCompare(b, 'zh')),
  );

  function isSelected(item: CatalogItem): boolean {
    switch (item.category) {
      case 'equipment':
        return selectedEquipments.value.some((e) => e.id === item.id);
      case 'item':
        return selectedItems.value.some((i) => i.id === item.id);
      case 'skill':
        return selectedSkills.value.some((s) => s.id === item.id);
    }
  }

  /** 检查物品是否可以选中: 点数足够 + 未选中 + 种族/身份限制 */
  function canSelect(item: CatalogItem): boolean {
    if (isSelected(item)) return true; // 已选中 = 可以保留
    const cost = item.cost || 0;
    if (remainingPoints.value < cost) return false;
    // 种族限制 (为未来数据扩展预留)
    if ((item as any).requiredRace && (item as any).requiredRace !== race.value) return false;
    // 身份限制 (为未来数据扩展预留)
    if ((item as any).requiredIdentity && (item as any).requiredIdentity !== identity.value)
      return false;
    return true;
  }

  function addEquipment(item: CatalogItem) {
    if (isSelected(item)) return;
    // 允许同一个 type 选多个装备（不强制替换）
    selectedEquipments.value = [...selectedEquipments.value, item];
  }

  function removeEquipment(itemId: string) {
    selectedEquipments.value = selectedEquipments.value.filter((e) => e.id !== itemId);
  }

  function addItem(item: CatalogItem) {
    const existing = selectedItems.value.find((i) => i.id === item.id);
    if (existing) {
      selectedItems.value = selectedItems.value.map((i) =>
        i.id === item.id ? { ...i, quantity: (i.quantity || 1) + (item.quantity || 1) } : i,
      );
    } else {
      selectedItems.value = [...selectedItems.value, { ...item }];
    }
  }

  function removeItem(itemId: string) {
    selectedItems.value = selectedItems.value.filter((i) => i.id !== itemId);
  }

  function addSkill(item: CatalogItem) {
    if (isSelected(item)) return;
    selectedSkills.value = [...selectedSkills.value, item];
  }

  function removeSkill(skillId: string) {
    selectedSkills.value = selectedSkills.value.filter((s) => s.id !== skillId);
  }

  /** 编辑自定义物品（按 id 原地替换，供 SelectedPanel 编辑入口） */
  function updateEquipment(item: CatalogItem) {
    selectedEquipments.value = selectedEquipments.value.map((e) => (e.id === item.id ? item : e));
  }
  function updateItem(item: CatalogItem) {
    selectedItems.value = selectedItems.value.map((i) => (i.id === item.id ? item : i));
  }
  function updateSkill(item: CatalogItem) {
    selectedSkills.value = selectedSkills.value.map((s) => (s.id === item.id ? item : s));
  }

  function clearAllSelections() {
    selectedEquipments.value = [];
    selectedItems.value = [];
    selectedSkills.value = [];
  }

  // ═══════════════════════════════════════════════════════
  // 背景故事
  // ═══════════════════════════════════════════════════════
  const selectedBackground = ref<BackgroundTemplate | null>(null);
  const customBackgroundText = ref('');

  function selectBackground(bg: BackgroundTemplate | null) {
    selectedBackground.value = bg;
    // 不再清空 customBackgroundText — 用户可能在预设和自定义之间切换，
    // buildOpeningPrompt 优先用预设，所以保留自定义文本不影响正确性。
  }

  // ═══════════════════════════════════════════════════════
  // 背景分类 (4 侧栏: 通用/身份/种族/地区)
  // ═══════════════════════════════════════════════════════

  const activeBackgroundCategory = ref<BackgroundCategory>('universal');

  // 计数与筛选共用 `classifyBackground`（start-catalog-mechanics）：
  // 各写一套判定就会出现「侧栏写 7 条、点进去只有 5 条」那种对不上。
  const backgroundCategories = computed(() => {
    const counts = countBackgroundsByCategory(catalog.value.backgrounds);
    return [
      { key: 'universal' as const, label: '通用开局', count: counts.universal },
      { key: 'identity' as const, label: '身份限定', count: counts.identity },
      { key: 'race' as const, label: '种族限定', count: counts.race },
      { key: 'location' as const, label: '地区限定', count: counts.location },
    ];
  });

  const filteredBackgrounds = computed(() =>
    filterBackgroundsByCategory(catalog.value.backgrounds, activeBackgroundCategory.value),
  );

  /** 检查单个背景是否满足所有限定条件 */
  function checkBackgroundConditions(bg: BackgroundTemplate): {
    valid: boolean;
    missing: string[];
  } {
    const missing: string[] = [];
    if (bg.requiredRace && race.value !== bg.requiredRace) {
      missing.push(`种族需为「${bg.requiredRace}」`);
    }
    if (bg.requiredIdentity && identity.value !== bg.requiredIdentity) {
      missing.push(`身份需为「${bg.requiredIdentity}」`);
    }
    if (bg.requiredLocation) {
      const loc = startLocation.value;
      // 前缀匹配: 如 "诺瓦·瓦伦蒂亚城" 匹配 "大陆中南部区域-瓦伦蒂亚公国-诺瓦·瓦伦蒂亚城-外城区"
      if (loc !== bg.requiredLocation && !loc.includes(bg.requiredLocation)) {
        missing.push(`出生地需在「${bg.requiredLocation}」`);
      }
    }
    if (bg.requiredDestinyCore) {
      const dc = destinyCore.value?.name;
      if (!dc || !dc.includes(bg.requiredDestinyCore)) {
        missing.push(`命定核心需为「${bg.requiredDestinyCore}」`);
      }
    }
    return { valid: missing.length === 0, missing };
  }

  // ═══════════════════════════════════════════════════════
  // 剧情规划 — 对齐 PlotSettings 类型 (types.ts)
  // ═══════════════════════════════════════════════════════
  const plotMode = ref<'off' | 'side' | 'main'>('off');
  const plotDurationYears = ref(5);
  const plotAllowNonWorldbookNpc = ref(true);
  const plotDifficultyTier = ref<number | 'adaptive'>('adaptive');
  const plotGenrePreference = ref<
    Array<
      | 'combat'
      | 'mystery'
      | 'social'
      | 'romance'
      | 'exploration'
      | 'politics'
      | 'survival'
      | 'tragedy'
    >
  >(['combat']);
  const plotCustomPreference = ref('');
  const plotFocusRegion = ref('');
  const plotChapterCount = ref(0);
  const plotEventsPerChapter = ref(0);
  const plotTabooContent = ref('');
  const plotOutline = ref<PlotOutline | null>(null);
  /** 结构化章节（含 keyEvents）— startJourney 时经 outlineToEvents 生成事件树 */
  const plotOutlineChapters = ref<ParsedOutlineOutput['chapters']>([]);
  const isPlotGenerating = ref(false);
  /** 大纲预览是否已揭示（防剧透遮罩，捏人页本地状态） */
  const plotOutlineRevealed = ref(false);
  const plotGenerationError = ref<string | null>(null);

  /** 流式生成实时统计（捏人页统计条用；null = 非生成中） */
  const plotStreamStats = ref<{
    phase: 'connecting' | 'streaming';
    round: number;
    chars: number;
    reasoningChars: number;
    charsPerSec: number;
    estimatedTotal: number;
    estimatedRemainingSec: number | null;
    elapsedSec: number;
  } | null>(null);
  /** 当前生成轮的 AbortController（取消按钮用） */
  let plotAbortController: AbortController | null = null;

  /**
   * 预计大纲总字数 —— 三档：上轮 raw 实际长度最准 → 历史版 content 膨胀 → 公式兜底。
   * 公式：章节数 × 每章事件数 × 每事件 220 字 × XML 膨胀 1.8 + 固定开销 1800；
   * 思维链 ≈ 正文 × 0.5（deepseek 类推理模型经验值）。
   */
  function estimateOutlineChars(): number {
    const lastRaw = lastPlotGenerationMeta.value?.rawResponse?.length;
    if (lastRaw && lastRaw > 0) return lastRaw;
    const hist = outlineHistory.value[outlineHistory.value.length - 1];
    if (hist?.content?.length) return Math.round(hist.content.length * 1.6);
    const ps = plotSettings.value;
    const chapters = ps.main?.chapterCount || 3;
    const eventsPerCh = ps.main?.eventsPerChapter || 3;
    const body = chapters * eventsPerCh * 220 * 1.8 + 1800;
    return Math.round(body + body * 0.5);
  }

  /** 取消当前大纲生成（用户主动中止） */
  function abortPlotGeneration(): void {
    plotAbortController?.abort();
  }
  /** 最近一次大纲生成的完整 AI 数据（供导出） */
  const lastPlotGenerationMeta = ref<{
    messages: Array<{ role: string; content: string }>;
    rawResponse: string;
    reasoning?: string;
    finishReason?: string;
    model: string;
    timestamp: number;
  } | null>(null);
  /** 会话内大纲历史（最多 5 版，重新生成/修改时旧版入栈，可回退） */
  const outlineHistory = ref<PlotOutline[]>([]);
  const chaptersHistory = ref<ParsedOutlineOutput['chapters'][]>([]);

  const plotSettings = computed<PlotSettings>(() => {
    const ps: PlotSettings = { mode: plotMode.value, tabooContent: plotTabooContent.value.trim() };
    if (plotMode.value === 'main') {
      const tier = plotDifficultyTier.value === 'adaptive' ? undefined : plotDifficultyTier.value;
      ps.main = {
        durationYears: plotDurationYears.value,
        allowNonWorldbookNpc: plotAllowNonWorldbookNpc.value,
        ...(tier !== undefined ? { difficultyTier: tier } : {}),
        genrePreference: plotGenrePreference.value,
        customPreference: plotCustomPreference.value.trim() || '',
      };
      if (plotChapterCount.value > 0) ps.main.chapterCount = plotChapterCount.value;
      if (plotEventsPerChapter.value > 0) ps.main.eventsPerChapter = plotEventsPerChapter.value;
    } else if (plotMode.value === 'side') {
      ps.side = {
        focusRegion: plotFocusRegion.value.trim() || '',
      };
      if (plotChapterCount.value > 0) ps.side.chapterCount = plotChapterCount.value;
      if (plotEventsPerChapter.value > 0) ps.side.eventsPerChapter = plotEventsPerChapter.value;
    }
    return ps;
  });

  // ═══════════════════════════════════════════════════════
  // localStorage 草稿 key — 必须定义在 initPlotDefaultsFromSettings
  // （会调用 tryRestoreDraft）之前，避免 TDZ 报错
  // ═══════════════════════════════════════════════════════
  const DRAFT_KEY = 'plotOutlineDraft_v1';

  // ═══════════════════════════════════════════════════════
  // 剧情设置默认值 — 从设置页（settings-store）读入新档默认值
  // ═══════════════════════════════════════════════════════

  function initPlotDefaultsFromSettings() {
    try {
      const s = useSettingsStore().settings;
      const mode = s.plotMode;
      if (mode === 'off' || mode === 'side' || mode === 'main') plotMode.value = mode;
      const dur = Number(s.plotDurationYears);
      if (Number.isFinite(dur) && dur > 0) plotDurationYears.value = dur;
      const tier = s.plotDifficultyTier;
      plotDifficultyTier.value =
        tier === 'adaptive' || tier === undefined || tier === null || tier === ''
          ? 'adaptive'
          : Number(tier);
      plotAllowNonWorldbookNpc.value = s.plotAllowNonWorldbookNpc !== false;
      if (Array.isArray(s.plotGenrePreference) && s.plotGenrePreference.length > 0) {
        plotGenrePreference.value = [...s.plotGenrePreference] as typeof plotGenrePreference.value;
      }
      plotCustomPreference.value =
        typeof s.plotCustomPreference === 'string' ? s.plotCustomPreference : '';
      plotFocusRegion.value = typeof s.plotFocusRegion === 'string' ? s.plotFocusRegion : '';
      plotTabooContent.value = typeof s.plotTabooContent === 'string' ? s.plotTabooContent : '';
      const cc = Number(s.plotChapterCount);
      plotChapterCount.value = Number.isFinite(cc) && cc > 0 ? cc : 0;
      const ec = Number(s.plotEventsPerChapter);
      plotEventsPerChapter.value = Number.isFinite(ec) && ec > 0 ? ec : 0;
    } catch {
      /* settings 不可用时保持内置默认 */
    }
  }

  initPlotDefaultsFromSettings();
  // 尝试恢复之前保存的大纲草稿（仅浏览器环境，Node 测试环境跳过）
  if (typeof localStorage !== 'undefined') tryRestoreDraft();

  // ═══════════════════════════════════════════════════════
  // 剧情大纲生成 — 捏人页走模板系统 (buildAgentMessagesAsync)
  // ═══════════════════════════════════════════════════════

  /**
   * 端点解析（对齐 game-pipeline.buildEndpoints + resolveAgentEndpoint）。
   * 🔴 F10：`plot_outline` 的 `model` 键存 **API 池 id**（历史命名不改），显式绑定失效时
   *    绝不回落 `pool[0]`（那会把大纲偷偷送去另一家 provider）——返回带原因的失败，
   *    调用方（runOutlineGeneration）把原因翻译成用户可见文案。
   */
  function resolvePlotOutlineEndpoint():
    | { ok: true; endpoint: ApiEndpoint }
    | { ok: false; reason: 'missing-pool' | 'stale-binding'; requestedPoolId?: string } {
    try {
      const store = useSettingsStore();
      const s = store.settings;
      const pool = ((s.apiPool ?? []) as any[]).map((entry: any) => ({
        id: entry.id || '',
        name: entry.name || '',
        provider: entry.provider || entry.apiType || 'custom',
        baseUrl: entry.baseUrl || '',
        apiKey: entry.apiKey || '',
        defaultModel: entry.defaultModel || entry.model || '',
        models: entry.models || [],
        timeout: entry.timeout ?? 60000,
        enableThinking: entry.enableThinking ?? false,
      })) as ApiEndpoint[];
      const poolId = getAgentSettings(
        s,
        'plot_outline',
        store.projectAgentDefaults?.agents ?? {},
      ).model;
      const resolution = resolveAgentEndpoint({ boundPoolId: poolId, apiPool: pool });
      if (resolution.status === 'resolved') return { ok: true, endpoint: resolution.endpoint };
      if (resolution.status === 'stale-binding') {
        return { ok: false, reason: 'stale-binding', requestedPoolId: resolution.requestedId };
      }
      return { ok: false, reason: 'missing-pool' };
    } catch {
      return { ok: false, reason: 'missing-pool' };
    }
  }

  /** 角色信息 → 最小 CharacterState（供模板系统 {{CHARACTER_STATE}} 占位符） */
  function buildOutlineCharacterState(): CharacterState {
    return buildCharacterState('create-outline');
  }

  /** 剧情配置文本（含雷点，通过 localParams['PLOT_EVENTS'] 覆盖模板占位符） */
  function buildOutlinePlotSettingsText(): string {
    const ps = plotSettings.value;
    const parts: string[] = [];
    parts.push(''); // 前导空行使合并后分隔清晰
    parts.push('# 剧情配置');
    parts.push(`模式: ${ps.mode}`);
    if (ps.main) {
      parts.push(`持续年份: ${ps.main.durationYears}`);
      parts.push(`难度层级: ${ps.main.difficultyTier ?? '自适应'}`);
      parts.push(`允许世界书外NPC: ${ps.main.allowNonWorldbookNpc ? '是' : '否'}`);
      parts.push(`剧情偏向: ${ps.main.genrePreference.join('、')}`);
      if (ps.main.customPreference) parts.push(`自定义偏好: ${ps.main.customPreference}`);
      if (ps.main.chapterCount) parts.push(`章节数量: ${ps.main.chapterCount} 章`);
      if (ps.main.eventsPerChapter) parts.push(`每章事件: ${ps.main.eventsPerChapter} 个`);
    }
    if (ps.side) {
      if (ps.side.focusRegion) parts.push(`专注区域: ${ps.side.focusRegion}`);
      if (ps.side.chapterCount) parts.push(`章节数量: ${ps.side.chapterCount} 章`);
      if (ps.side.eventsPerChapter) parts.push(`每章事件: ${ps.side.eventsPerChapter} 个`);
    }
    if (ps.tabooContent) {
      parts.push('');
      parts.push('雷点（绝对禁止出现的内容，优先级高于一切偏好）:');
      parts.push(ps.tabooContent);
    }
    return parts.join('\n');
  }

  /** 加载 agent-config.json 中的 Agent 配置 */
  async function loadOutlineAgentConfigs(): Promise<AgentConfig[]> {
    // 内容-引擎分离（波 1 T2 / D16）：经 ContentProvider 收口。
    // provider 内部 await contentReadyPromise + 上报 contentStatus；失败返回空骨架不抛。
    try {
      const { useContentStore } = await import('./content-store');
      const json = (await useContentStore().loadProjectDefaults()) as {
        agents?: Record<string, any>;
      };
      if (!json.agents) return [];
      const result: AgentConfig[] = [];
      for (const [id, cfg] of Object.entries(json.agents) as [string, any][]) {
        result.push({ ...cfg, agentId: id } as AgentConfig);
      }
      return result;
    } catch {
      return [];
    }
  }

  /** 加载剧情大纲 Agent 可见的世界书（统一数据源：store 优先 + 文件兜底；worldBookIds + 捏人勾选过滤） */
  async function loadPlotOutlineWorldBooks(agentConfigs: AgentConfig[]): Promise<WorldBook[]> {
    try {
      // 统一数据源：读 worldbook-store（Dexie，含用户在 WorldBookEditor 的 enabled 修改），
      // 不再绕过 store 读原始文件
      const wb = useWorldBookStore();
      await wb.init();
      const all = await loadWorldBooksWithFallback(wb.books as WorldBook[]);
      const cfg = agentConfigs.find((c) => c.agentId === 'plot_outline');
      let filtered = all;
      if (cfg && cfg.worldBookIds?.length) {
        filtered = all.filter((wb) => cfg.worldBookIds!.includes(wb.id));
      }
      // 对齐游戏页面：只注入用户在捏人页勾选的角色 + 命定核心
      const enabledEntries = buildEnabledWorldBookEntries();
      return filterBooksByEnabledEntries(filtered, enabledEntries);
    } catch {
      return [];
    }
  }

  /**
   * AI 未输出 timerange 时的兜底区间（基准 = 纪元年 488；正常路径由 createOutlineFromAgent
   * 用 AI 的 parsed.timeRange）。
   *
   * 🔴 纪元名取自内容侧（D9），**不许写死**。内容缺席时 `era` 是空串，
   * 于是这里退化成「0488年01月01日」—— 一眼看得出「纪元名没接上」，
   * 而一个看着合理的硬编码缺省会把接线漏洞伪装成正常。
   */
  function buildOutlineTimeRange(): { start: string; end: string } {
    const years = plotMode.value === 'main' ? plotDurationYears.value : 1;
    const startYear = String(GAME_EPOCH_YEAR).padStart(4, '0');
    const endYear = String(GAME_EPOCH_YEAR + Math.max(1, years)).padStart(4, '0');
    return { start: `${era.value}${startYear}年01月01日`, end: `${era.value}${endYear}年12月30日` };
  }

  /** 历史入栈（最多 5 版，超出丢最旧） */
  function pushOutlineHistory() {
    if (!plotOutline.value) return;
    outlineHistory.value = [...outlineHistory.value, plotOutline.value].slice(-5);
    chaptersHistory.value = [...chaptersHistory.value, plotOutlineChapters.value].slice(-5);
  }

  /** 从原始输出提取结构化自检（score/weaknesses/suggestions）。
   *  主路径：XML `<self_critique score="N">...<weakness>..</weakness><suggestion>..</suggestion></self_critique>`（v2 prompt 实际输出）
   *  兜底：legacy JSON `{ selfCritique: { score, weaknesses, suggestions } }`（旧格式/测试 fixture） */
  function extractSelfCritique(
    raw: string,
  ): { score: number; weaknesses: string[]; suggestions: string[] } | null {
    // 1. XML 主路径：定位 self_critique 块（自闭合 <self_critique score="N" /> 也走属性匹配）
    const blockMatch = raw.match(/<self_critique\b[^>]*>[\s\S]*?<\/self_critique\s*>/i);
    const block = blockMatch ? blockMatch[0] : '';
    const scoreMatch = (block || raw).match(/<self_critique\b[^>]*\bscore\s*=\s*"?(\d+)/i);
    if (scoreMatch) {
      const score = parseInt(scoreMatch[1], 10);
      const extractTags = (src: string, tag: string): string[] => {
        const re = new RegExp(`<\\s*${tag}\\s*>([\\s\\S]*?)<\\/\\s*${tag}\\s*>`, 'gi');
        const out: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) out.push(m[1].trim());
        return out;
      };
      const scope = block || raw;
      return {
        score,
        weaknesses: extractTags(scope, 'weakness'),
        suggestions: extractTags(scope, 'suggestion'),
      };
    }
    // 2. legacy JSON 兜底（Q-05：剥壳走 model-json，多认围栏与 <json> 标签）
    const payload = extractJsonPayload(raw);
    if (!payload) return null;
    try {
      const parsed = JSON.parse(payload);
      const sc = parsed?.selfCritique;
      if (!sc || typeof sc.score !== 'number') return null;
      return {
        score: sc.score,
        weaknesses: Array.isArray(sc.weaknesses) ? sc.weaknesses : [],
        suggestions: Array.isArray(sc.suggestions) ? sc.suggestions : [],
      };
    } catch {
      return null;
    }
  }

  /**
   * 流式调用 chatStream，一边实时更新 plotStreamStats（字数/速率/剩余估算），
   * 一边把流聚合回 Promise 结果。用户取消（abort）与真实错误用 `cancelled` 区分。
   */
  function streamOutlineChat(
    client: AgentClient,
    request: {
      model: string;
      temperature: number;
      maxTokens: number;
      topP: number;
      messages: Array<{ role: string; content: string }>;
    },
    round: number,
  ): Promise<{
    rawResponse: string;
    reasoning?: string;
    finishReason?: string;
    completionTokens?: number;
    error?: string;
    cancelled?: boolean;
  }> {
    return new Promise((resolve) => {
      const controller = new AbortController();
      plotAbortController = controller;
      const startedAt = Date.now();
      let fullText = '';
      let fullReasoning = '';
      plotStreamStats.value = {
        phase: 'connecting',
        round,
        chars: 0,
        reasoningChars: 0,
        charsPerSec: 0,
        estimatedTotal: estimateOutlineChars(),
        estimatedRemainingSec: null,
        elapsedSec: 0,
      };
      // 速率滑动窗口（近 10s 平均；开头数据少不估算）
      const window_: Array<{ ts: number; chars: number }> = [];

      const finishStats = () => {
        if (!plotStreamStats.value) return;
        plotStreamStats.value.chars = fullText.length;
        plotStreamStats.value.reasoningChars = fullReasoning.length;
        plotStreamStats.value.elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      };

      void client.chatStream(
        request,
        {
          onChunk(text, _isComplete) {
            fullText += text;
            const now = Date.now();
            window_.push({ ts: now, chars: fullText.length });
            const cutoff = now - 10000;
            while (window_.length > 0 && window_[0].ts < cutoff) window_.shift();
            const first = window_[0];
            const last = window_[window_.length - 1];
            const span = last.ts - first.ts;
            const delta = last.chars - first.chars;
            const cps = span > 0 ? (delta * 1000) / span : 0;
            const st = plotStreamStats.value;
            if (!st) return;
            st.phase = 'streaming';
            st.chars = fullText.length;
            st.charsPerSec = Math.round(cps);
            st.elapsedSec = Math.round((now - startedAt) / 1000);
            // 数据足够（≥500 字）才给剩余估算；宁偏大不偏小（×1.15 缓冲）
            if (fullText.length >= 500 && cps > 0) {
              const remaining = Math.max(0, st.estimatedTotal - fullText.length);
              st.estimatedRemainingSec = Math.round((remaining / cps) * 1.15);
            } else {
              st.estimatedRemainingSec = null;
            }
          },
          onReasoning(text) {
            fullReasoning += text;
            const st = plotStreamStats.value;
            if (st) st.reasoningChars = fullReasoning.length;
          },
          onComplete(result) {
            fullText = result.fullText;
            fullReasoning = result.reasoning || '';
            finishStats();
            resolve({
              rawResponse: result.fullText,
              reasoning: result.reasoning || undefined,
              completionTokens: result.completionTokens,
            });
          },
          onError(err) {
            finishStats();
            const cancelled = err === 'Request aborted';
            resolve({
              rawResponse: fullText,
              reasoning: fullReasoning || undefined,
              error: cancelled ? undefined : err,
              cancelled,
            });
          },
        },
        controller.signal,
      );
    });
  }

  /** 核心生成循环: 通过模板系统 buildAgentMessagesAsync 构建上下文，selfCritique.score < 6 时重试（最多 2 次调用） */
  async function runOutlineGeneration(initialUserMessage: string): Promise<boolean> {
    plotGenerationError.value = null;
    await useSettingsStore().initApiSecrets();
    // 🔴 F10：端点解析失败时区分「还没配」与「绑定了但已失效」——
    //    前者让人去配置，后者是设置页里那个池被删了，指引到 Agent 配置重选。
    const resolved = resolvePlotOutlineEndpoint();
    if (!resolved.ok) {
      plotGenerationError.value =
        resolved.reason === 'stale-binding'
          ? `「大纲生成」Agent 绑定的 API 池已失效（原 id: ${resolved.requestedPoolId ?? ''}），请在设置 → Agent 配置重新选择`
          : '未配置 API 端点或模型，请在设置页为「大纲生成」Agent 配置 API';
      return false;
    }
    const endpoint = resolved.endpoint;
    if (!endpoint.defaultModel) {
      plotGenerationError.value = '未配置 API 端点或模型，请在设置页为「大纲生成」Agent 配置 API';
      return false;
    }

    isPlotGenerating.value = true;
    try {
      const settingsStore = useSettingsStore();
      const settings = settingsStore.settings;

      // 加载模板系统依赖: Agent 配置 + 世界书
      // 🔴 必须用 **Async** 版（2026-08-01 修 F3）：plot_outline 可见的世界书里有 22 条含 EJS 的条目，
      //    同步的 `buildAgentMessages` 会在宿主 realm 直接 `new Function` 求值它们 ——
      //    绕开 `getEjsBackend()` 的隔离后端（无中断、无预算、构造器可逃逸），
      //    而应用此时对外报告的是「已隔离」。异步版先预渲染再灌 memo，EJS 只在后端里跑。
      const { buildAgentMessagesAsync } = await import('@engine/agent-templates');
      const agentConfigs = await loadOutlineAgentConfigs();
      const worldBooks = await loadPlotOutlineWorldBooks(agentConfigs);

      // 构建 AgentContext
      const ctx: AgentContext = {
        userInput: initialUserMessage,
        history: [],
        characters: [buildOutlineCharacterState()],
        memories: [],
        plotEvents: [],
        plotSettings: plotSettings.value,
        variables: {},
        agentOutputs: new Map(),
        worldBooks: [],
      };

      // localParams: 用剧情配置文本覆盖模板中的 {{PLOT_EVENTS}}
      const localParams: Record<string, string> = {
        PLOT_EVENTS: buildOutlinePlotSettingsText(),
      };

      const baseMessages = await buildAgentMessagesAsync(
        'plot_outline',
        ctx,
        agentConfigs,
        worldBooks,
        undefined,
        localParams,
      );
      const messages: Array<{ role: string; content: string }> = baseMessages
        ? [...baseMessages]
        : [{ role: 'system', content: '' }];

      const client = new AgentClient({
        endpoint,
        agentId: 'plot_outline',
        saveId: 'create',
        // 真机修(2026-07-21): plot_outline 一次性重操作 — 大 systemPrompt(世界书注入 ~40 万字符)
        // + 复杂产出(先 if_absent 再切 event + 多事件 desc/trigger/complete/fail) + 自检重试，
        // AI 生成稳定 >120s。提至 300s。配合 agent-client 的 AbortError 友好化。
        // 🔴 2026-08-08 再次拉满: 章节×事件规模 5×5 时输出 ~10k+ 字、慢模型 4-8 分钟，
        //    300s 会掐在生成中途。maxTokens 已拉满(384000)，这里把墙钟也放开到 30 分钟 —
        //    让「能生成完」而不是「在超时边缘赌命」。
        timeout: 1800000,
      });
      // Q-18: 默认值不再在这里重述一遍（此前 0.7 / 16384 / 1.0 三处字面量与
      // 设置页、game-pipeline 的拷贝靠人眼保持一致）
      // D44 修正 1：合默认层 —— 用户没覆写数值时取默认层（pack > 占位）给的值。
      const plotAgentCfg = getAgentSettings(
        settings,
        'plot_outline',
        settingsStore.projectAgentDefaults?.agents ?? {},
      );
      const llmParams = {
        model: endpoint.defaultModel,
        temperature: plotAgentCfg.temperature,
        maxTokens: plotAgentCfg.maxTokens,
        topP: plotAgentCfg.topP,
      };

      let best: { parsed: ParsedOutlineOutput; raw: string } | null = null;
      let userMessage = initialUserMessage;

      for (let attempt = 0; attempt < 2; attempt++) {
        // 替换最后一条 user 消息为当前 userMessage（首次用 initialUserMessage，重试带弱点）
        // 如果 baseMessages 最后一条是 user，替换它；否则追加
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
          messages[messages.length - 1] = { role: 'user', content: userMessage };
        } else {
          messages.push({ role: 'user', content: userMessage });
        }

        const result = await streamOutlineChat(client, { ...llmParams, messages }, attempt + 1);
        if (result.cancelled) {
          plotGenerationError.value = '大纲生成已取消';
          plotStreamStats.value = null;
          return false;
        }
        if (result.error || !result.rawResponse) {
          if (best) break;
          plotGenerationError.value = `大纲生成失败: ${result.error ?? 'AI 返回为空'}`;
          plotStreamStats.value = null;
          return false;
        }
        const parsed = tryParseOutline(result.rawResponse);
        if (!parsed) {
          if (best) break;
          // 🔴 2026-08-08 诊断: 解析失败必须留痕 —— 此前只有一句「解析失败」、
          // 零日志、raw 不留档，5×5 失败原因完全不可查。
          const raw = result.rawResponse ?? '';
          const hasClosing = /<\/\s*outline\s*>/i.test(raw);
          // 截断判据：API 明说截断，或「有 <outline 开头但没闭合」——后者是截断的
          // 特征形；纯垃圾输出（连 <outline 都没有）不算截断，是格式损坏。
          const hasOutlineOpen = /<\s*outline\b/i.test(raw);
          const truncated = result.finishReason === 'length' || (hasOutlineOpen && !hasClosing);
          console.error('[PlotOutline] 大纲输出解析失败', {
            finishReason: result.finishReason ?? '未知',
            rawLength: raw.length,
            hasClosingOutlineTag: hasClosing,
            completionTokens: result.completionTokens ?? 0,
            head: raw.slice(0, 200),
            tail: raw.slice(-400),
          });
          // 失败轮也留档 —— 「导出 AI 调试数据」按钮可导出原始输出
          lastPlotGenerationMeta.value = {
            messages: messages.map((m) => ({ ...m })),
            rawResponse: raw,
            reasoning: result.reasoning ?? undefined,
            model: llmParams.model,
            finishReason: result.finishReason,
            timestamp: Date.now(),
          };
          plotGenerationError.value = truncated
            ? '大纲输出被截断（输出未完整闭合），请减少章节/事件数量后重试，或检查 API 输出上限'
            : '大纲输出解析失败，请重试（失败详情已写入控制台，可导出 AI 调试数据）';
          plotStreamStats.value = null;
          return false;
        }
        best = { parsed, raw: result.rawResponse };
        // 保存本轮完整 AI 数据，供导出调试用
        lastPlotGenerationMeta.value = {
          messages: messages.map((m) => ({ ...m })),
          rawResponse: best.raw,
          reasoning: result.reasoning ?? undefined,
          finishReason: result.finishReason,
          model: llmParams.model,
          timestamp: Date.now(),
        };

        const critique = extractSelfCritique(result.rawResponse);
        if (!critique || critique.score >= 6) break;
        userMessage = [
          initialUserMessage,
          '',
          `# 上一版大纲（自检评分 ${critique.score}/10，未达标，需重写）`,
          result.rawResponse,
          '# 待改进点',
          ...(critique.weaknesses.length ? critique.weaknesses : ['（未给出）']),
          '# 改进建议',
          ...(critique.suggestions.length ? critique.suggestions : ['（未给出）']),
          '请针对以上不足重写大纲，输出完整大纲 XML（<outline>...</outline>）。',
        ].join('\n');
      }

      if (!best) {
        plotGenerationError.value = '大纲生成失败';
        return false;
      }
      plotStreamStats.value = null;

      const outline = createOutlineFromAgent(
        '',
        plotMode.value,
        best.raw,
        buildOutlineTimeRange(),
        (plotOutline.value?.version ?? 0) + 1,
      );
      if (!outline) {
        plotGenerationError.value = '大纲输出解析失败，请重试';
        return false;
      }
      pushOutlineHistory();
      plotOutline.value = outline;
      plotOutlineChapters.value = best.parsed.chapters;
      autoSaveDraft();
      return true;
    } catch (err) {
      plotGenerationError.value = `大纲生成失败: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    } finally {
      isPlotGenerating.value = false;
    }
  }

  /** 导出本轮 AI 调试数据（系统提示词 + 思维链 + 正文输出） */
  function exportAIDebugDump(): boolean {
    if (!lastPlotGenerationMeta.value) return false;
    const m = lastPlotGenerationMeta.value;
    const data = {
      exportedAt: new Date().toISOString(),
      model: m.model,
      timestamp: m.timestamp,
      systemPrompt: m.messages.find((msg) => msg.role === 'system')?.content ?? '',
      userMessage: m.messages.find((msg) => msg.role === 'user')?.content ?? '',
      allMessages: m.messages,
      reasoning: m.reasoning,
      finishReason: m.finishReason,
      rawResponse: m.rawResponse,
      parsedOutline: plotOutline.value
        ? {
            title: plotOutline.value.title,
            summary: plotOutline.value.summary,
            content: plotOutline.value.content,
            timeRange: plotOutline.value.timeRange,
          }
        : null,
      plotSettings: plotSettings.value,
    };
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `AI调试数据-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch {
      return false;
    }
  }

  /** 生成剧情大纲（重新生成时旧版入栈 history 可回退） */
  async function generatePlotOutline(): Promise<boolean> {
    if (isPlotGenerating.value) return false;
    // 简单的初始 user 消息 — 模板系统的 systemPrompt 已包含完整指令
    const message = '# 剧情大纲生成请求\n\n请根据角色背景和剧情配置，生成完整剧情大纲。';
    return runOutlineGeneration(message);
  }

  /** 大纲重 roll（修改模式）: 带上一版完整 JSON + 用户修改要求让 AI 重写 */
  async function reviseOutline(userRequest: string): Promise<boolean> {
    if (isPlotGenerating.value) return false;
    if (!plotOutline.value) {
      plotGenerationError.value = '尚无大纲可修改，请先生成大纲';
      return false;
    }
    const previousJson = JSON.stringify(
      {
        title: plotOutline.value.title,
        summary: plotOutline.value.summary,
        content: plotOutline.value.content,
        chapters: plotOutlineChapters.value,
      },
      null,
      2,
    );
    const message = [
      '# 修改模式',
      '',
      '## 上一版大纲（完整 JSON）',
      previousJson,
      '',
      '## 用户的修改要求',
      userRequest.trim(),
      '',
      '请根据以上要求重写大纲。修改要求与雷点冲突时雷点优先。输出完整大纲 XML（<outline>...</outline>）。',
    ].join('\n');
    return runOutlineGeneration(message);
  }

  /** 回退到上一版大纲 */
  function rollbackOutline(): boolean {
    if (outlineHistory.value.length === 0) return false;
    const prev = outlineHistory.value[outlineHistory.value.length - 1];
    outlineHistory.value = outlineHistory.value.slice(0, -1);
    const prevChapters = chaptersHistory.value[chaptersHistory.value.length - 1] ?? [];
    chaptersHistory.value = chaptersHistory.value.slice(0, -1);
    plotOutline.value = prev;
    plotOutlineChapters.value = prevChapters;
    autoSaveDraft();
    return true;
  }

  // ═══════════════════════════════════════════════════════
  // 模板替换: <user> → 角色名
  // ═══════════════════════════════════════════════════════

  /** 将文本中的 &lt;user&gt; 替换为当前角色名（未填写时用中性占位名） */
  function substituteUser(text: string): string {
    const userName = name.value.trim() || '未命名者';
    return text.replace(/<user>/g, userName);
  }

  // ═══════════════════════════════════════════════════════
  // 提交: 变量路径
  // ═══════════════════════════════════════════════════════

  function buildCharacterState(saveId: string): CharacterState {
    const charId = crypto.randomUUID();
    const englishAttrs: Record<string, number> = {};
    for (const attr of ATTRIBUTE_NAMES) {
      englishAttrs[ATTR_CN_TO_EN[attr]] = finalAttributes.value[attr];
    }

    // ═══ 真机修（2026-07-23）: 开局装备/道具/技能不再直接结构化落库 ═══
    // 此前直接落库的 inventory 只有 effects(描述字符串) 没有 stats(战斗数值)，且会让
    // request_dispatcher 误判为「已有物品」→ 永不触发 item_gen → 战斗数值全 0。
    // 现在改为：选中项全部写进 buildOpeningPrompt 开场正文 → 开局轮 {{USER_INPUT}} 把
    // 这份开场提示词原样喂给 request_dispatcher（含「--- 初始装备 --- / --- 初始技能 ---」
    // 原始清单）→ dispatcher 按原名/原描述发 <item_gen_request> → item_gen 正式生成
    // stats+effects 落库（ADR: AI 填叙事字段，Code 补账务字段）。
    // ⚠️ 不能依赖 story 正文复述物品名 —— story 会改写名字（法师长袍→深蓝色天鹅绒长袍），
    //    dispatcher 必须从 {{USER_INPUT}} 的原始清单认物品，否则名字漂移、数值被 item_gen 重掷。
    // HP/MP/SP/五维等基础属性仍在此 Code 计算。

    return {
      id: charId,
      saveId,
      type: 'player',
      name: name.value.trim(),
      race: race.value === '自定义' ? customRace.value || '人类' : race.value,
      identity: [
        identity.value === '自定义' ? customIdentity.value || '非贵族平民' : identity.value,
      ],
      occupation: [],
      tier: tier.value,
      tierName: tierName.value,
      level: level.value,
      // 🆕 累计表语义（2026-08-24）：totalExp = 升到当前等级所需累计门槛（Lv1 → 0），
      //    expToNext = 当前级累计门槛。与旧 expCap 语义解耦，新档即符合累加式。
      //    level-1 ∈ [1,24] 恒为 number（Lv25 的 level-1=24 有值），as number 安全。
      totalExp: level.value <= 1 ? 0 : (getRequiredXpForLevel(level.value - 1) as number),
      expToNext: xpToNextNumber(level.value),
      attributes: englishAttrs as CharacterState['attributes'],
      freeAttrPoints: 0,
      hp: hpPreview.value,
      maxHp: hpPreview.value,
      mp: mpPreview.value,
      maxMp: mpPreview.value,
      sp: spPreview.value,
      maxSp: spPreview.value,
      ascension: {
        enabled: false,
        elements: [],
        authority: [],
        law: [],
        deityPosition: '',
        divineKingdom: { name: '', description: '' },
      },
      // 开局 inventory/skills 留空 — 装备/道具/技能由开场正文经 item_gen 链正式生成落库
      skills: [],
      inventory: [],
      statusEffects: [],
      money: money.value,
      location: startLocation.value === '自定义' ? customStartLocation.value : startLocation.value,
      present: true,
      adventurerRank: '未评级',
      currentAction: '',
      bloodlineIds: [],
      // 正式字段（规范 §2.1；M6 T2 双写退役完成，customFields 只留真扩展数据）
      gender: gender.value === '自定义' ? customGender.value : gender.value,
      personality: personality.value.trim(),
      appearance: physics.value.trim(),
      background: [backstory.value.trim(), extra.value.trim()].filter(Boolean).join('\n\n'),
      customFields: {
        // M6 T2: saveId/gender/personality/physics/backstory 已升一等字段停写
        age: age.value,
        destinyCoreId: destinyCore.value?.id ?? null,
        destinyPoints: destinyPoints.value,
        extra: extra.value.trim(),
      },
    };
  }

  // ═══════════════════════════════════════════════════════
  // 提交: 开场提示词 — 组装自然语言叙事，作为首条用户消息注入管线
  // ═══════════════════════════════════════════════════════
  // 原则：
  // - name / LV / 五维 / HP / race / identity / location → 写死在 CharacterState 字段
  //   → {{CHARACTER_STATE}} system prompt 占位符自动格式化注入
  // - 装备 / 技能 / 物品 / 背景 / 性格身材身世 → 下游 Agent 需要处理
  //   → 组装为自然语言，作为开场 user 消息注入，走 story→request_dispatcher→vars_update 链路
  // - 命定核心由已启用的 system_core 世界书条目单独注入；开场 user 消息不替它规定人格或显现方式

  function buildOpeningPrompt(): string {
    const charName = name.value.trim() || '未命名';
    const lines: string[] = [];

    const openingTime = formatGameTime(createDefaultTime(era.value)).replace(
      /^(.+年)-(\d{2}月)-(\d{2}日)-(周.)-(\d{2}:\d{2})$/,
      '$1$2$3，$4$5',
    );
    lines.push(`${openingTime}，${charName}的故事由此开始。`);

    // 开局剧情是已经发生的事实。直接把场景交给 story，不用「数据」「区块」等元语言
    // 给首轮定下清单式语气。
    if (selectedBackground.value) {
      lines.push('');
      lines.push(substituteUser(selectedBackground.value.fullText));
    } else if (customBackgroundText.value.trim()) {
      lines.push('');
      lines.push(substituteUser(customBackgroundText.value.trim()));
    }

    // 初始金钱（2026-08-08）：把开局经济作为**既成事实**写进开场白，与初始装备同地位。
    // 🔴 防的是「系统权威数值被 AI 叙事覆盖」：story prompt 的 CHARACTER_STATE 里明明有
    //    金钱: N G，AI 却会因为它和「前文推导的金额」对不上，主动判面板为错误、改用叙事值。
    //    保留精确金额，但用世界内语言表达，不把 G 与「开局财产」写成面板播报。
    lines.push('');
    if (money.value > 0) {
      lines.push(`${charName}随身带着 ${money.value} 枚帝冕币，除此之外再无钱财。`);
    } else {
      lines.push(`${charName}身无分文，衣袋里连一枚帝冕币也没有。`);
    }

    // 装备
    if (selectedEquipments.value.length > 0) {
      lines.push('');
      lines.push(`${charName}带着这些装备。`);
      const STATS_CN: Record<string, string> = {
        atk: '攻击力',
        defense: '防御',
        penetration: '穿透',
        hit: '命中',
        dodge: '闪避',
        dr: '减伤',
      };
      for (const e of selectedEquipments.value) {
        const rarity = normalizeRarity(e.rarity) ?? e.rarity;
        const desc = e.description ? `，${e.description}` : '';
        const effects =
          e.effect && Object.keys(e.effect).length > 0
            ? `；它的特性包括${Object.entries(e.effect)
                .map(([k, v]) => `${k}（${v}）`)
                .join('、')}`
            : '';
        const tags = e.tag?.length ? `，常被归为${e.tag.join('、')}` : '';
        const statsStr =
          e.stats && Object.keys(e.stats).length > 0
            ? `；其${Object.entries(e.stats)
                .map(([k, v]) => `${STATS_CN[k] ?? k}为${v}`)
                .join('、')}`
            : '';
        lines.push(`${e.name}是一件${rarity}品质的${e.type}${desc}${tags}${effects}${statsStr}。`);
      }
    }

    // 技能
    if (selectedSkills.value.length > 0) {
      lines.push('');
      lines.push(`${charName}已经掌握这些本领。`);
      for (const s of selectedSkills.value) {
        const rarity = normalizeRarity(s.rarity) ?? s.rarity;
        const desc = s.description ? `，${s.description}` : '';
        const effects =
          s.effect && Object.keys(s.effect).length > 0
            ? `；它能带来${Object.entries(s.effect)
                .map(([k, v]) => `${k}（${v}）`)
                .join('、')}`
            : '';
        const consume = s.consume ? `；施展时需要${s.consume}` : '';
        const tags = s.tag?.length ? `，属于${s.tag.join('、')}` : '';
        lines.push(
          `${s.name}是一项${rarity}品质的${s.type}本领${desc}${tags}${effects}${consume}。`,
        );
      }
    }

    // 背包物品
    if (selectedItems.value.length > 0) {
      lines.push('');
      lines.push(`${charName}的行囊里还有这些东西。`);
      for (const i of selectedItems.value) {
        const rarity = normalizeRarity(i.rarity) ?? i.rarity;
        const desc = i.description ? `，${i.description}` : '';
        const effects =
          i.effect && Object.keys(i.effect).length > 0
            ? `；它的用途包括${Object.entries(i.effect)
                .map(([k, v]) => `${k}（${v}）`)
                .join('、')}`
            : '';
        const tags = i.tag?.length ? `，常被归为${i.tag.join('、')}` : '';
        lines.push(
          `${charName}有${i.quantity || 1}件${i.name}，那是${rarity}品质的${i.type}${desc}${tags}${effects}。`,
        );
      }
    }

    // 角色补充信息
    if (personality.value.trim()) {
      lines.push('');
      lines.push(`${charName}生性${personality.value.trim()}。`);
    }
    if (physics.value.trim()) {
      lines.push('');
      lines.push(`${charName}的身形与外貌给人的印象是：${physics.value.trim()}。`);
    }
    if (backstory.value.trim() || extra.value.trim()) {
      lines.push('');
      lines.push(
        `关于${charName}的来历，已知的是：\n${[backstory.value.trim(), extra.value.trim()].filter(Boolean).join('\n\n')}`,
      );
    }

    // 收尾只做世界内的叙事交接，不再写「请复述 / 不要解释」一类元指令。命定核心不在这里
    // 点名或规定演出，完全服从单独注入的世界书条目。
    lines.push('');
    lines.push(
      `故事便从这个瞬间继续。周遭的景象、人物的目光与声音渐次鲜明，而接下来发生的一切，都将从${charName}此刻的处境自然延伸。`,
    );

    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════
  // 提交: 写入 DB + 跳转
  // ═══════════════════════════════════════════════════════

  async function startJourney(): Promise<string> {
    // 最终持久化边界必须重验；角色预设可以在任一步加载，不能只依赖曾经通过过 Step 1。
    if (!attributesFullyAllocated.value) {
      currentStep.value = 1;
      throw new Error('请先分配全部基础属性点和额外属性点');
    }

    const saveId = crypto.randomUUID();
    const charState = buildCharacterState(saveId);
    const openingPrompt = buildOpeningPrompt();
    console.log('[create-store] startJourney — openingPrompt:', openingPrompt.slice(0, 200));
    console.log('[create-store] startJourney — openingPrompt length:', openingPrompt.length);

    const { saveCharacter, saveSaveSlot } = await import('@engine/database');

    await saveCharacter(charState);

    // 存档名：主角名 + 层级 + 日期
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const saveName = `${charState.name} · ${charState.tierName} · ${dateStr}`;

    await saveSaveSlot({
      id: saveId,
      name: saveName,
      slot: 0, // TODO: 自动分配空闲槽位（多槽位属产品功能非字段规范）
      createdAt: Date.now(),
      updatedAt: Date.now(),
      activeSnapshotId: null,
      metadata: {
        characterName: charState.name,
        userName: '玩家',
        gameStartTime: new Date().toISOString(),
        totalTurns: 0,
        enabledWorldBookEntries: buildEnabledWorldBookEntries(), // 🆕
        openingPrompt: openingPrompt, // 🆕
        openingPromptConsumed: false, // 🆕
        plotSettings: JSON.parse(JSON.stringify(plotSettings.value)), // §5.2: 本档剧情配置随档落库（含雷点）
      } as any,
    });

    // 真机修(2026-07-23): 开局兑换的命运点 → 初始化到存档级 SaveProfile.fp
    // ADR-22: FP 是存档级元货币，独立于 CharacterState。此前 destinyPoints 只写进
    // customFields.destinyPoints，游戏内 FP(SaveProfile.fp) 从未拿到这笔，开局兑换的 FP 丢失。
    const { getProfile, addFP, updateProfile } = await import('@engine/save-profile');
    // 🔴 era 必须透传（T12 的 D9 线程化）：SaveProfile 是惰性创建的，这里是生产上
    //    唯一的创建点。不传就等于让新档的纪元名落成空串，而存档一旦盖章就永不重读内容包。
    const profile = await getProfile(saveId, era.value);
    // 经验档位与命运点兑换彼此独立：零兑换也必须把用户选择盖章进新存档。
    profile.experienceMode = experienceMode.value === 'easy' ? 'easy' : 'normal';
    if (destinyPoints.value > 0) {
      // addFP 会持久化 profile，正数分支不重复 updateProfile。
      await addFP(profile, destinyPoints.value, '开局兑换的命运点', 'other');
    } else {
      await updateProfile(profile);
    }

    // §5.2: 主线/支线已生成大纲 → 落库确认版 + 结构化事件树（全部 hidden）；历史版本不落库
    if ((plotMode.value === 'main' || plotMode.value === 'side') && plotOutline.value) {
      const { savePlotOutline, savePlotEvents } = await import('@engine/database');
      const { outlineToEvents } = await import('@engine/plot-outline');
      const confirmed: PlotOutline = {
        ...JSON.parse(JSON.stringify(plotOutline.value)),
        saveId,
        confirmed: true,
      };
      await savePlotOutline(confirmed);
      const events = outlineToEvents(JSON.parse(JSON.stringify(plotOutlineChapters.value)), saveId);
      if (events.length > 0) await savePlotEvents(events);
    } else if (plotOutline.value) {
      const { savePlotOutline } = await import('@engine/database');
      await savePlotOutline({ ...JSON.parse(JSON.stringify(plotOutline.value)), saveId });
    }

    return saveId;
  }

  /** 成功开局后清除草稿 */
  async function startJourneyAndClearDraft(): Promise<string> {
    const saveId = await startJourney();
    clearDraft();
    return saveId;
  }

  // ═══════════════════════════════════════════════════════
  // localStorage 草稿 — 大纲自动保存/恢复/清除
  // ═══════════════════════════════════════════════════════

  /** 自动保存草稿（大纲生成/修改/回退后调用） */
  function autoSaveDraft() {
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          outline: plotOutline.value,
          chapters: plotOutlineChapters.value,
          outlineHistory: outlineHistory.value.slice(-5),
          chaptersHistory: chaptersHistory.value.slice(-5),
          savedAt: Date.now(),
        }),
      );
    } catch {
      /* localStorage full — silently skip */
    }
  }

  /** 尝试恢复草稿，成功返回 true */
  function tryRestoreDraft(): boolean {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return false;
      const draft = JSON.parse(raw);
      if (!draft.outline?.title || !draft.chapters?.length) {
        localStorage.removeItem(DRAFT_KEY);
        return false;
      }
      plotOutline.value = draft.outline;
      plotOutlineChapters.value = draft.chapters;
      outlineHistory.value = Array.isArray(draft.outlineHistory) ? draft.outlineHistory : [];
      chaptersHistory.value = Array.isArray(draft.chaptersHistory) ? draft.chaptersHistory : [];
      return true;
    } catch {
      localStorage.removeItem(DRAFT_KEY);
      return false;
    }
  }

  /** 清除草稿（开局成功后调用） */
  function clearDraft() {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* silent */
    }
  }

  /** 清除当前大纲（回到未生成状态）+ 清草稿；不动角色捏人数据 */
  function clearOutline() {
    plotOutline.value = null;
    plotOutlineChapters.value = [];
    outlineHistory.value = [];
    chaptersHistory.value = [];
    plotGenerationError.value = null;
    isPlotGenerating.value = false;
    clearDraft();
  }

  // ═══════════════════════════════════════════════════════
  // 预设系统
  // ═══════════════════════════════════════════════════════
  const showPresetModal = ref(false);
  const presets = ref<CreatePreset[]>([]);

  function getCurrentPresetData(): Omit<CreatePreset, 'id' | 'name' | 'createdAt' | 'updatedAt'> {
    return {
      difficulty: difficulty.value?.id ?? '',
      character: {
        name: name.value,
        gender: gender.value,
        customGender: customGender.value,
        age: age.value,
        race: race.value,
        customRace: customRace.value,
        identity: identity.value,
        customIdentity: customIdentity.value,
        startLocation: startLocation.value,
        customStartLocation: customStartLocation.value,
        level: level.value,
        basePoints: { ...basePoints.value },
        attributePoints: { ...attributePoints.value },
        money: money.value,
        destinyPoints: destinyPoints.value,
      },
      equipments: [...selectedEquipments.value],
      items: [...selectedItems.value],
      skills: [...selectedSkills.value],
      background: selectedBackground.value,
      customBackgroundText: customBackgroundText.value,
      destinyCoreId: destinyCore.value?.id ?? null,
      plotSettings: plotSettings.value,
      systemCoreEntryUid: selectedSystemCoreEntryUid.value,
      enabledCharacterEntryUids: [...enabledCharacterEntryUids.value],
      personality: personality.value,
      physics: physics.value,
      backstory: backstory.value,
      extra: extra.value,
    };
  }

  function applyPresetData(data: CreatePreset) {
    selectDifficulty(data.difficulty);
    name.value = data.character.name;
    gender.value = data.character.gender;
    customGender.value = data.character.customGender || '';
    age.value = data.character.age;
    race.value = data.character.race;
    customRace.value = data.character.customRace || '';
    identity.value = data.character.identity;
    customIdentity.value = data.character.customIdentity || '';
    startLocation.value = data.character.startLocation;
    customStartLocation.value = data.character.customStartLocation || '';
    level.value = data.character.level;
    basePoints.value = { ...data.character.basePoints };
    attributePoints.value = { ...data.character.attributePoints };
    money.value = data.character.money;
    destinyPoints.value = data.character.destinyPoints;
    clearAllSelections();
    data.equipments.forEach((e) => addEquipment(e));
    data.items.forEach((i) => addItem(i));
    data.skills.forEach((s) => addSkill(s));
    selectedBackground.value = data.background;
    customBackgroundText.value = data.customBackgroundText || '';
    if (data.destinyCoreId) selectDestinyCore(data.destinyCoreId);
    if (data.systemCoreEntryUid) selectSystemCoreEntry(data.systemCoreEntryUid);
    if (data.enabledCharacterEntryUids) {
      enabledCharacterEntryUids.value = new Set(data.enabledCharacterEntryUids);
    }
    personality.value = data.personality || '';
    physics.value = data.physics || '';
    backstory.value = data.backstory || '';
    extra.value = data.extra || '';
    if (data.plotSettings) {
      plotMode.value = data.plotSettings.mode;
      plotTabooContent.value = data.plotSettings.tabooContent ?? '';
      if (data.plotSettings.main) {
        plotDurationYears.value = data.plotSettings.main.durationYears;
        plotAllowNonWorldbookNpc.value = data.plotSettings.main.allowNonWorldbookNpc;
        plotDifficultyTier.value = (data.plotSettings.main.difficultyTier ??
          'adaptive') as typeof plotDifficultyTier.value;
        plotGenrePreference.value = data.plotSettings.main
          .genrePreference as typeof plotGenrePreference.value;
        plotCustomPreference.value = data.plotSettings.main.customPreference;
        if (data.plotSettings.main.chapterCount)
          plotChapterCount.value = data.plotSettings.main.chapterCount;
        if (data.plotSettings.main.eventsPerChapter)
          plotEventsPerChapter.value = data.plotSettings.main.eventsPerChapter;
      }
      if (data.plotSettings.side) {
        plotFocusRegion.value = data.plotSettings.side.focusRegion;
        if (data.plotSettings.side.chapterCount)
          plotChapterCount.value = data.plotSettings.side.chapterCount;
        if (data.plotSettings.side.eventsPerChapter)
          plotEventsPerChapter.value = data.plotSettings.side.eventsPerChapter;
      }
    }

    // 预设入口在全部步骤都可用；晚加载的旧预设若没有完整分配属性，立即返回基础信息页。
    if (!attributesFullyAllocated.value && currentStep.value > 1) currentStep.value = 1;
  }

  // ═══════════════════════════════════════════════════════
  // 重置 — 对齐原版 resetCharacter
  // ═══════════════════════════════════════════════════════
  function resetAll() {
    currentStep.value = 0;
    difficulty.value = null;
    reincarnationPoints.value = 1000;
    name.value = '';
    gender.value = '男';
    customGender.value = '';
    age.value = 18;
    race.value = '人类';
    customRace.value = '';
    identity.value = '非贵族平民';
    customIdentity.value = '';
    startLocation.value = '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德';
    customStartLocation.value = '';
    level.value = 1;
    basePoints.value = { 力量: 0, 敏捷: 0, 体质: 0, 智力: 0, 精神: 0 };
    attributePoints.value = { 力量: 0, 敏捷: 0, 体质: 0, 智力: 0, 精神: 0 };
    destinyPoints.value = 0;
    money.value = 0;
    clearAllSelections();
    destinyCore.value = null;
    selectedBackground.value = null;
    customBackgroundText.value = '';
    plotOutline.value = null;
    isPlotGenerating.value = false;
    plotOutlineChapters.value = [];
    outlineHistory.value = [];
    chaptersHistory.value = [];
    plotGenerationError.value = null;
    plotMode.value = 'off';
    plotDurationYears.value = 5;
    plotAllowNonWorldbookNpc.value = true;
    plotDifficultyTier.value = 'adaptive';
    plotGenrePreference.value = ['combat'];
    plotCustomPreference.value = '';
    plotFocusRegion.value = '';
    plotTabooContent.value = '';
    plotChapterCount.value = 0;
    plotEventsPerChapter.value = 0;
    initPlotDefaultsFromSettings();
    showPresetModal.value = false;
    selectedSystemCoreEntryUid.value = null;
    selectedWorkshopCoreProjectId.value = null;
    enabledCharacterEntryUids.value = new Set();
    enabledWorkshopProjectIds.value = new Set();
    systemCoreEntries.value = [];
    characterEntries.value = [];
    workshopOptions.value = [];
  }

  return {
    // 内容加载门（D16/D24）
    contentStatus,
    initContent,
    catalog,
    era,
    // 步骤
    currentStep,
    stepValid,
    nextStep,
    prevStep,
    // 难度
    difficulty,
    selectDifficulty,
    // 角色 (→ 变量)
    name,
    gender,
    customGender,
    age,
    race,
    customRace,
    raceOptions,
    identity,
    customIdentity,
    identityOptions,
    startLocation,
    customStartLocation,
    // 起始地树：内容侧供给，名字保持 START_LOCATIONS 以免动 8 个模板消费点
    START_LOCATIONS: startLocationTree,
    flatLocationOptions,
    GENDER_OPTIONS,
    // 角色补充信息
    personality,
    physics,
    backstory,
    extra,
    // 属性 (→ 变量)
    level,
    experienceMode,
    basePoints,
    attributePoints,
    tier,
    tierName,
    tierBonus,
    finalAttributes,
    MAX_BP,
    BP_PER_ATTR_MAX,
    usedBP,
    remainingBP,
    maxAP,
    usedAP,
    remainingAP,
    attributesFullyAllocated,
    addBasePoint,
    removeBasePoint,
    addAttributePoint,
    removeAttributePoint,
    hpPreview,
    mpPreview,
    spPreview,
    // 经济
    reincarnationPoints,
    destinyPoints,
    money,
    raceCost,
    identityCost,
    levelCost,
    equipmentCost,
    itemCost,
    skillCost,
    moneyCost,
    destinyCost,
    totalCost,
    remainingPoints,
    // 命定核心
    destinyCore,
    destinyCorePool,
    selectDestinyCore,
    // Phase 10h: 世界书驱动
    systemCoreEntries,
    characterEntries,
    selectedSystemCoreEntryUid,
    selectedWorkshopCoreProjectId,
    selectedWorkshopCore,
    selectWorkshopCore,
    workshopSystemOptions,
    workshopExtraOptions,
    selectedSystemCoreEntry,
    enabledCharacterEntryUids,
    loadWorldBookEntries,
    selectSystemCoreEntry,
    toggleCharacterEntry,
    buildEnabledWorldBookEntries,
    // P1-5: 工坊项目启用轴（项目级多选）
    workshopOptions,
    enabledWorkshopProjectIds,
    toggleWorkshopProject,
    // 选择 (→ 开场提示词)
    selectedEquipments,
    selectedItems,
    selectedSkills,
    activeCategory,
    rarityFilter,
    typeFilter,
    subCategories,
    filteredPool,
    isSelected,
    canSelect,
    addEquipment,
    removeEquipment,
    addItem,
    removeItem,
    addSkill,
    removeSkill,
    updateEquipment,
    updateItem,
    updateSkill,
    clearAllSelections,
    // 背景
    selectedBackground,
    customBackgroundText,
    selectBackground,
    activeBackgroundCategory,
    backgroundCategories,
    filteredBackgrounds,
    checkBackgroundConditions,
    // 剧情
    plotMode,
    plotDurationYears,
    plotAllowNonWorldbookNpc,
    plotDifficultyTier,
    plotGenrePreference,
    plotCustomPreference,
    plotFocusRegion,
    plotTabooContent,
    plotChapterCount,
    plotEventsPerChapter,
    plotSettings,
    plotOutline,
    plotOutlineChapters,
    isPlotGenerating,
    plotStreamStats,
    abortPlotGeneration,
    plotOutlineRevealed,
    plotGenerationError,
    outlineHistory,
    exportAIDebugDump,
    lastPlotGenerationMeta,
    generatePlotOutline,
    reviseOutline,
    rollbackOutline,
    initPlotDefaultsFromSettings,
    // 提交
    buildCharacterState,
    buildOpeningPrompt,
    startJourney: startJourneyAndClearDraft,
    // 模板
    substituteUser,
    // localStorage 草稿
    autoSaveDraft,
    tryRestoreDraft,
    clearDraft,
    clearOutline,
    // 预设
    showPresetModal,
    presets,
    getCurrentPresetData,
    applyPresetData,
    // 重置
    resetAll,
  };
});
