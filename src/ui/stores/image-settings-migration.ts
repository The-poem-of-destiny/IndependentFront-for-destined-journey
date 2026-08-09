/**
 * 图像设置的形状迁移：17 个平铺 `image*` 字段 → per-provider 袋子（图像 v2 / C8）。
 *
 * ## 与「六步迁移」的关系
 *
 * 与 `agent-settings-migration.ts` 完全同一类，不是 `legacy-dexie-migration.ts` 那一类：
 * 在**同一个 settings 对象内**重排字段，一个字节都不跨存储。于是同样刻意做得更简单：
 *
 * - **没有标志位**。「旧平铺键还在不在」本身就是信号，搬完就删 —— 幂等由构造保证。
 * - **在 `ref()` 之前跑**（settings-store 构造期，同步）。响应式状态从第一拍起就只有
 *   新形状，读取侧**不需要**兼容分支，没有「有时是平铺、有时是袋子」的两套形态。
 * - **纯函数、无 I/O、永不抛**。落盘由 store 原有的 deep watch 负责。
 *
 * 最坏情况是这个函数什么都没干（旧键原样留着），用户的设置一个字节都不会丢。
 *
 * ## 🔴 为什么「一个旧平铺键都不在」时**整个**早退（连 agents 袋那步也不做）
 *
 * `agents.image_prompt.systemPrompt` 也要搬进方言覆盖（C5/C8：那份提示词退役成
 * `danbooru-anime` 方言的默认值）。但这一步**不能**脱离旧平铺键单独触发：迁移每次
 * 启动都跑，而设置页在 T7a 之前仍可能让用户往那个字段里写字 —— 无条件搬运会在
 * **下一次启动时把用户刚写的提示词偷走**，症状是「我改的提示词自己没了」。
 *
 * 用旧平铺键当总闸是安全的：`image_prompt` 这个 agent 与那 17 个平铺字段是同一版
 * （图像 v1）上线的，任何存着 `image_prompt.systemPrompt` 的档案必然也存着平铺键。
 *
 * ## 覆盖只在「与默认不同」时才落（C6）
 *
 * `qualitySuffix` / `baseNegative` 等于 `image-defaults` 的常量 → **不落覆盖**，
 * 直接丢弃：相等意味着用户从没改过，落一份覆盖会把今天的默认值永久钉死在这个档案上，
 * 日后方言 JSON 改了默认再也够不到他。
 *
 * 🔴 `systemPrompt` **同样要比**（2026-08-08 审查修正）。此前这里写着「方言 JSON 要
 * fetch、本函数是同步的，所以一律当覆盖搬，内容相同的覆盖无害」—— 后半句是错的：
 * PR #29（2026-08-05 boot 播种默认值进 `settings.agents`）到 PR #42（D44 删播种）
 * 之间建的档案，覆写层里躺着的正是**出厂原文**。把它搬进方言覆盖，用户就被永久钉死在
 * 今天这段提示词上（日后方言 JSON / pack 更新一个字节也够不到他），设置页还会显示一个
 * 他从没写过的、填满的覆盖框。而这一步**并不需要** fetch：出厂原文有两份编译期可得的
 * 拷贝，见 `isFactoryImagePrompt`。
 *
 * ## 🔴 归一化（`normalizeImageSettings`）与迁移是**两件事**
 *
 * 迁移一次性、靠旧平铺键当信号；归一化**每次加载都跑**，与旧键在不在无关：
 *
 * - 袋子不是对象（`imageNovelai: null` / `: 5`，手改 localStorage 或别的版本写坏）→ 整只重建。
 *   此前这段修复被关在旧键闸门后面，于是**已经迁过的**坏档案永远修不好，
 *   下游 `checkQuota` 的 `s.imageNovelai.maxPerMessage` 当场 TypeError。
 * - 袋内**缺字段**→ 从默认值补。store 的 `{ ...getDefaults(), ...saved }` 只浅合并一层，
 *   日后往 `ImageNovelaiSettings` / `ImageComfySettings` 里加字段，老用户拿到的是
 *   `undefined` ——「加新设置要改两处」那条约定在袋子内部会静默失效。
 */
import { FALLBACK_IMAGE_DIALECT } from '@engine/image-dialect';
import { DEFAULT_IMAGE_BASE_NEGATIVE, DEFAULT_IMAGE_QUALITY_SUFFIX } from '@engine/image-defaults';
import fingerprintsJson from '@engine/agent-defaults-fingerprints.json';
import type { ImageDialectOverride, NaiBillingTier } from '@engine/types-image';
import { fingerprintValue } from './agent-settings';
import type { ImageComfySettings, ImageNovelaiSettings } from './settings-types';

/** 被搬进 `imageNovelai` 的旧平铺键 → 袋内字段名 */
const LEGACY_NOVELAI_KEYS: ReadonlyArray<readonly [string, keyof ImageNovelaiSettings]> = [
  ['imageEndpointId', 'endpointId'],
  ['imageModel', 'model'],
  ['imageSampler', 'sampler'],
  ['imageNoiseSchedule', 'noiseSchedule'],
  ['imageUcPreset', 'ucPreset'],
  ['imageNaiTier', 'tier'],
  ['imageMaxPerMessage', 'maxPerMessage'],
  ['imageMaxPerHour', 'maxPerHour'],
] as const;

/** 搬进方言覆盖（而不是袋子）的两个字符串旋钮 → 覆盖字段名 + 它的默认常量 */
const LEGACY_DIALECT_KEYS: ReadonlyArray<readonly [string, keyof ImageDialectOverride, string]> = [
  ['imageQualitySuffix', 'qualitySuffix', DEFAULT_IMAGE_QUALITY_SUFFIX],
  ['imageBaseNegative', 'baseNegative', DEFAULT_IMAGE_BASE_NEGATIVE],
] as const;

/** 全部旧平铺键 —— 「在不在」就是本迁移的信号 */
const ALL_LEGACY_KEYS: readonly string[] = [
  ...LEGACY_NOVELAI_KEYS.map(([key]) => key),
  ...LEGACY_DIALECT_KEYS.map(([key]) => key),
];

/** 侧链提示词退役后的落点（C5）：内置 danbooru 方言 */
const DEFAULT_DIALECT_ID = FALLBACK_IMAGE_DIALECT.id;

export interface ImageSettingsMigrationResult {
  /** 本次真的搬了东西吗（false = 旧平铺键一个都不在，全新用户或已迁过） */
  migrated: boolean;
  /** 实际删掉的旧平铺键 */
  removedKeys: string[];
  /** 落进 `imageDialectOverrides[DEFAULT_DIALECT_ID]` 的字段名（便于测试与排查） */
  dialectOverrideFields: string[];
  /** `agents.image_prompt.systemPrompt` 被搬走了吗 */
  movedAgentPrompt: boolean;
  /**
   * 覆写层里那份提示词是**出厂原文**，已直接丢弃而不是搬成覆盖。
   * 与 `movedAgentPrompt` 互斥；两个都 false = 那个字段本来就不在（或是空串）。
   */
  droppedFactoryAgentPrompt: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 兜底袋 —— **只在调用方没给默认值时**用（`normalizeImageSettings` 的 `defaults` 参数缺席）。
 *
 * 生产路径上 `settings-store` 会把 `getDefaults()` 的两个袋子传进来（那是唯一真源）；
 * 这里重复一份是为了让本模块**单独可测且永不抛**：拿一个 `imageNovelai: 5` 的坏档案
 * 调它，也应该得到一个合法袋子而不是 TypeError。
 */
const NOVELAI_FALLBACK: ImageNovelaiSettings = {
  endpointId: null,
  model: '',
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  ucPreset: 0,
  tier: 'unset',
  maxPerMessage: 2,
  maxPerHour: 20,
};

const COMFY_FALLBACK: ImageComfySettings = {
  baseUrl: 'http://127.0.0.1:8188',
  workflowJson: '',
  timeoutMs: 600_000,
  pollIntervalMs: 1_500,
};

const NAI_TIERS: readonly NaiBillingTier[] = ['opus', 'metered', 'unset'];

/** 按袋内字段的类型收下旧值；认不出就返回 `undefined`（保留袋子里的默认值） */
function coerceNovelaiValue(
  field: keyof ImageNovelaiSettings,
  raw: unknown,
): ImageNovelaiSettings[keyof ImageNovelaiSettings] | undefined {
  switch (field) {
    case 'endpointId':
      // null 是**有意义的值**（「还没选端点」），必须收下而不是当垃圾丢掉
      if (raw === null) return null;
      return typeof raw === 'string' ? raw : undefined;
    case 'model':
    case 'sampler':
    case 'noiseSchedule':
      return typeof raw === 'string' ? raw : undefined;
    case 'ucPreset':
    case 'maxPerMessage':
    case 'maxPerHour':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
    case 'tier':
      return NAI_TIERS.includes(raw as NaiBillingTier) ? (raw as NaiBillingTier) : undefined;
    default:
      return undefined;
  }
}

// ═══ 出厂提示词识别（审查修正 / finding 1）═══

/**
 * 指纹表里 `image_prompt.systemPrompt` 那一格 —— 与 `migrateLegacyAgentOverrides`
 * 用的是**同一张表、同一个 hash 口径**（`fingerprintValue`），不另造一套。
 */
const FACTORY_IMAGE_PROMPT_FINGERPRINT: string | undefined = (
  fingerprintsJson as Record<string, Record<string, string>>
).image_prompt?.systemPrompt;

/**
 * 这份提示词是**出厂原文**吗（= 用户从没写过，只是 boot 播种抄进覆写层的）。
 *
 * 🔴 **两条判据缺一不可**，因为出厂原文在历史上有过两版：
 *
 * 1. `FALLBACK_IMAGE_DIALECT.systemPrompt`（= `DEFAULT_IMAGE_PROMPT_SYSTEM`，715 字）——
 *    这就是 PR #29→#42 窗口里 boot 真正抄进覆写层的那份，与 `image-dialects.json` 的
 *    danbooru 提示词逐字节相同。**直接比串**，不必 fetch 方言 JSON。
 * 2. 指纹表里的那一格（950 字的更早一版）—— 更老的档案命中它。
 *
 * 🔴 只查指纹表是**不够**的：那张表由 `scripts/build-agent-fingerprints.mjs` 从当时的
 *    `data/defaults/agent-config.json` 生成，而 715 字那版上线时表没有重新生成 ——
 *    表里至今只有 950 字那版的指纹。只比指纹会让本次审查点名的那批档案一个都拦不住。
 *
 * 判据 1 同时也是**语义上正确**的那条：值等于方言默认值时，删掉它行为逐字节不变，
 * 而留着它会把今天的文本永久钉死。
 */
function isFactoryImagePrompt(prompt: string): boolean {
  if (prompt === FALLBACK_IMAGE_DIALECT.systemPrompt) return true;
  return (
    FACTORY_IMAGE_PROMPT_FINGERPRINT !== undefined &&
    fingerprintValue(prompt) === FACTORY_IMAGE_PROMPT_FINGERPRINT
  );
}

// ═══ 归一化（每次加载都跑）═══

/** `normalizeImageSettings` 可选的默认值来源 —— 生产上就是 `getDefaults()` 的那两个袋子 */
export interface ImageBagDefaults {
  imageNovelai?: ImageNovelaiSettings;
  imageComfy?: ImageComfySettings;
}

export interface ImageSettingsNormalizeResult {
  /** 被整只重建/改写的键（袋子名或标量名），便于测试与排查 */
  rebuilt: string[];
  /** 袋内补上的缺失字段，形如 `imageNovelai.tier` */
  filledFields: string[];
}

/** 一只袋子：不是对象就整只重建；是对象就逐字段补默认（`undefined` 也算缺） */
function normalizeBag(
  bag: Record<string, unknown>,
  key: 'imageNovelai' | 'imageComfy',
  fallback: Record<string, unknown>,
  result: ImageSettingsNormalizeResult,
): void {
  const current = bag[key];
  if (!isPlainObject(current)) {
    bag[key] = { ...fallback };
    result.rebuilt.push(key);
    return;
  }
  for (const [field, value] of Object.entries(fallback)) {
    // `undefined` 与「键不在」同样处理：JSON 往返会把前者变成后者，两种形态都得补
    if (current[field] === undefined) {
      current[field] = value;
      result.filledFields.push(`${key}.${field}`);
    }
  }
}

/**
 * 把图像设置**修成合法形状** —— 幂等、纯内存、永不抛，**每次加载都要跑**。
 *
 * 与 `migrateImageSettings` 的分工见文件头：那个是一次性搬运（旧平铺键当信号），
 * 这个与旧键无关，负责「`useSettingsStore()` 永远不会暴露一只非法或残缺的袋子」。
 *
 * @param defaults 生产上传 `getDefaults()` 的两个袋子（唯一真源）；缺省用本模块的兜底袋
 */
export function normalizeImageSettings(
  bag: Record<string, unknown>,
  defaults?: ImageBagDefaults,
): ImageSettingsNormalizeResult {
  const result: ImageSettingsNormalizeResult = { rebuilt: [], filledFields: [] };

  normalizeBag(
    bag,
    'imageNovelai',
    (defaults?.imageNovelai ?? NOVELAI_FALLBACK) as unknown as Record<string, unknown>,
    result,
  );
  normalizeBag(
    bag,
    'imageComfy',
    (defaults?.imageComfy ?? COMFY_FALLBACK) as unknown as Record<string, unknown>,
    result,
  );

  if (!isPlainObject(bag.imageDialectOverrides)) {
    bag.imageDialectOverrides = {};
    result.rebuilt.push('imageDialectOverrides');
  }
  if (typeof bag.imageDialectId !== 'string' || bag.imageDialectId === '') {
    bag.imageDialectId = DEFAULT_DIALECT_ID;
    result.rebuilt.push('imageDialectId');
  }
  if (bag.imageProvider !== 'novelai' && bag.imageProvider !== 'comfyui') {
    bag.imageProvider = 'novelai';
    result.rebuilt.push('imageProvider');
  }

  return result;
}

/**
 * 就地把平铺 `image*` 折进 per-provider 袋子与方言覆盖，然后删掉旧键。
 *
 * **必须在 settings 被 `ref()` 包起来之前调用**（见文件头）。调用后
 * `bag.imageNovelai` / `bag.imageComfy` / `bag.imageDialectOverrides` 一定是对象；
 * 旧平铺键一定不存在。
 */
export function migrateImageSettings(
  bag: Record<string, unknown>,
  defaults?: ImageBagDefaults,
): ImageSettingsMigrationResult {
  // 🔴 归一化在早退**之前**：坏袋子的修复不能被旧键闸门挡住，否则已经迁过的档案
  //    永远修不好（下游 `checkQuota` 直接 TypeError）。它幂等，生产上 store 已经先跑过一遍。
  normalizeImageSettings(bag, defaults);

  const present = ALL_LEGACY_KEYS.filter((key) => key in bag);

  const empty: ImageSettingsMigrationResult = {
    migrated: false,
    removedKeys: [],
    dialectOverrideFields: [],
    movedAgentPrompt: false,
    droppedFactoryAgentPrompt: false,
  };
  // 旧键一个都不在：全新用户，或上一次已经搬完。什么都不搬（含 agents 袋那步，见文件头）。
  if (present.length === 0) return empty;

  const novelai = bag.imageNovelai as Record<string, unknown>;
  const overrides = bag.imageDialectOverrides as Record<string, ImageDialectOverride>;

  // ── NAI 参数与限额 ──
  for (const [legacyKey, field] of LEGACY_NOVELAI_KEYS) {
    if (!(legacyKey in bag)) continue;
    const value = coerceNovelaiValue(field, bag[legacyKey]);
    if (value !== undefined) novelai[field] = value;
  }

  // ── 两个字符串旋钮 → 方言覆盖（与默认相同就只删不落，C6）──
  const dialectOverrideFields: string[] = [];
  function putOverride(field: keyof ImageDialectOverride, value: string) {
    if (!isPlainObject(overrides[DEFAULT_DIALECT_ID])) {
      overrides[DEFAULT_DIALECT_ID] = {};
    }
    overrides[DEFAULT_DIALECT_ID][field] = value;
    dialectOverrideFields.push(field);
  }

  for (const [legacyKey, field, defaultValue] of LEGACY_DIALECT_KEYS) {
    if (!(legacyKey in bag)) continue;
    const raw = bag[legacyKey];
    // 空串在这里也算「没改过」：v1 的输入框清空表达的是「用默认」，
    // 而 `resolveImageDialect` 本来就把空串覆盖当作回落（`ImageDialectOverride` 注释）
    if (typeof raw !== 'string' || raw === '' || raw === defaultValue) continue;
    putOverride(field, raw);
  }

  // ── agents 袋里用户改过的 image_prompt.systemPrompt → 同一条方言的覆盖（C5/C8）──
  let movedAgentPrompt = false;
  let droppedFactoryAgentPrompt = false;
  const agents = isPlainObject(bag.agents) ? bag.agents : undefined;
  const imagePromptEntry =
    agents && isPlainObject(agents.image_prompt) ? agents.image_prompt : null;
  if (imagePromptEntry) {
    const prompt = imagePromptEntry.systemPrompt;
    if (typeof prompt === 'string' && prompt !== '') {
      // 🔴 出厂原文一律**丢弃**而不是搬成覆盖（见 `isFactoryImagePrompt`）：
      //    那不是用户写的，搬过去只会把他永久钉死在今天这段文本上，
      //    还会在设置页显示一个他从没填过的覆盖框
      if (isFactoryImagePrompt(prompt)) {
        droppedFactoryAgentPrompt = true;
      } else {
        putOverride('systemPrompt', prompt);
        movedAgentPrompt = true;
      }
    }
    // 搬没搬走都清掉：留着会让「Agent 袋里那份」与「方言覆盖那份」同时存在，
    // 而 C5 之后前者已经没有消费方 —— 那正是 D53 警告的第三份拷贝
    if ('systemPrompt' in imagePromptEntry) delete imagePromptEntry.systemPrompt;
    // 整条空了就删掉，免得覆写层留一堆空壳（与 `migrateLegacyAgentOverrides` 同口径）
    if (agents && Object.keys(imagePromptEntry).length === 0) delete agents.image_prompt;
  }

  // 删源放在最后：上面任何一步抛了，旧键都还在，下次启动原样重来
  for (const key of present) delete bag[key];

  return {
    migrated: true,
    removedKeys: present,
    dialectOverrideFields,
    movedAgentPrompt,
    droppedFactoryAgentPrompt,
  };
}
