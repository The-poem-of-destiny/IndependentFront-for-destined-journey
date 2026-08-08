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
 * `systemPrompt` 无法做同样的比较（方言 JSON 要 fetch，而本函数是同步的），所以
 * 一律当覆盖搬 —— 内容与默认相同的覆盖是**无害**的：行为逐字节一致，只是多存一份。
 */
import { FALLBACK_IMAGE_DIALECT } from '@engine/image-dialect';
import { DEFAULT_IMAGE_BASE_NEGATIVE, DEFAULT_IMAGE_QUALITY_SUFFIX } from '@engine/image-defaults';
import type { ImageDialectOverride, NaiBillingTier } from '@engine/types-image';
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
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 默认值 —— **只在袋子缺席/是垃圾时**用。
 *
 * 正常路径上 `settings-store` 的 `{ ...getDefaults(), ...saved }` 已经把袋子铺好了，
 * 这里重复一份是为了让本函数**单独可测且永不抛**：拿一个 `imageNovelai: 5` 的坏档案
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

/**
 * 就地把平铺 `image*` 折进 per-provider 袋子与方言覆盖，然后删掉旧键。
 *
 * **必须在 settings 被 `ref()` 包起来之前调用**（见文件头）。调用后
 * `bag.imageNovelai` / `bag.imageComfy` / `bag.imageDialectOverrides` 一定是对象；
 * 旧平铺键一定不存在。
 */
export function migrateImageSettings(bag: Record<string, unknown>): ImageSettingsMigrationResult {
  const present = ALL_LEGACY_KEYS.filter((key) => key in bag);

  const empty: ImageSettingsMigrationResult = {
    migrated: false,
    removedKeys: [],
    dialectOverrideFields: [],
    movedAgentPrompt: false,
  };
  // 旧键一个都不在：全新用户，或上一次已经搬完。什么都不做（含 agents 袋那步，见文件头）。
  if (present.length === 0) return empty;

  // 袋子兜底：正常路径上 getDefaults() 已经铺好，这里只处理坏档案
  if (!isPlainObject(bag.imageNovelai)) bag.imageNovelai = { ...NOVELAI_FALLBACK };
  if (!isPlainObject(bag.imageComfy)) bag.imageComfy = { ...COMFY_FALLBACK };
  if (!isPlainObject(bag.imageDialectOverrides)) bag.imageDialectOverrides = {};
  if (typeof bag.imageDialectId !== 'string' || bag.imageDialectId === '') {
    bag.imageDialectId = DEFAULT_DIALECT_ID;
  }
  if (bag.imageProvider !== 'novelai' && bag.imageProvider !== 'comfyui') {
    bag.imageProvider = 'novelai';
  }

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
  const agents = isPlainObject(bag.agents) ? bag.agents : undefined;
  const imagePromptEntry =
    agents && isPlainObject(agents.image_prompt) ? agents.image_prompt : null;
  if (imagePromptEntry) {
    const prompt = imagePromptEntry.systemPrompt;
    if (typeof prompt === 'string' && prompt !== '') {
      putOverride('systemPrompt', prompt);
      movedAgentPrompt = true;
    }
    // 搬没搬走都清掉：留着会让「Agent 袋里那份」与「方言覆盖那份」同时存在，
    // 而 C5 之后前者已经没有消费方 —— 那正是 D53 警告的第三份拷贝
    if ('systemPrompt' in imagePromptEntry) delete imagePromptEntry.systemPrompt;
  }

  // 删源放在最后：上面任何一步抛了，旧键都还在，下次启动原样重来
  for (const key of present) delete bag[key];

  return {
    migrated: true,
    removedKeys: present,
    dialectOverrideFields,
    movedAgentPrompt,
  };
}
