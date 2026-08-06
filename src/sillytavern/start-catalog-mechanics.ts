/**
 * start-catalog-mechanics.ts — 捏人目录的**机制半边**（内容-引擎分离 D24）。
 *
 * 设计真源: `docs/planning/2026-08-05-content-engine-separation-design.md` D24。
 *
 * 这里住的是「换一套世界观也不会变」的东西：
 * - **schema / 类型**（`CatalogItem` / `BackgroundTemplate` / `DestinyCore` / `CascaderOption`…）
 * - **机制常量**（`DIFFICULTY_PRESETS` 难度档位 / `GENDER_OPTIONS` 性别枚举 /
 *   `BACKGROUND_RESTRICTIONS` 限定覆盖表）—— 它们是玩法规则，不是世界观内容，
 *   所以 **不进 pack**，随引擎走。
 * - **纯函数 / 校验 / 计算规则**（`parseCatalogData` 容错解析 / 点数查表 / 地点树扁平化 /
 *   背景分类）
 *
 * 🔴 **这里不许出现任何一条具体条目内容**。七个池（装备/物品/技能、背景、命定核心、
 * 种族/身份点数表、起始地树）已抽成 `data/content/catalog.json`，经内容注册表
 * （`content-store.getContentRegistry().catalog`）供给，pack 可整份替换。
 * 往本文件里加一件装备、一个背景、一个地名，就是把内容重新焊回引擎。
 *
 * 消费方拿到的是 `unknown`（注册表六面都是 unknown），**统一经 `parseCatalogData()`
 * 收窄**：它永不抛，坏输入退化成空池而不是让捏人页白屏。
 */

// ═══════════════════════════════════════════════════════════
// 1. Schema / 类型
// ═══════════════════════════════════════════════════════════

/**
 * 捏人页物品稀有度编码（英文，CDN 数据遗留）。
 * ⚠️ 与 field-enums 的 `Rarity`（中文 7 级）同名不同义 —— 本类型专用于目录数据；
 * 转中文品质统一走 `normalizeRarity`（field-enums），禁止直接 `as` 强转。
 */
export type CatalogRarityCode =
  'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic' | 'only';

export interface DifficultyPreset {
  id: string;
  label: string;
  points: number;
  desc: string;
}

export interface CatalogItem {
  id: string;
  name: string;
  category: 'equipment' | 'item' | 'skill';
  type: string;
  rarity: CatalogRarityCode;
  tag: string[];
  effect: Record<string, string>;
  consume?: string;
  description: string;
  cost: number;
  quantity?: number;
  /** 装备战斗数值（英文键，对齐 combat-resolver: atk/defense/dr/penetration/hit/dodge） */
  stats?: Record<string, number>;
}

export interface BackgroundTemplate {
  id: string;
  name: string;
  description: string;
  fullText: string;
  requiredRace?: string;
  requiredIdentity?: string;
  requiredLocation?: string;
  requiredDestinyCore?: string;
}

export interface DestinyCore {
  id: string;
  name: string;
  author: string;
  theme: string;
  description?: string;
  mode?: string;
}

export interface CascaderOption {
  label: string;
  value: string;
  children?: CascaderOption[];
}

/**
 * 捏人目录的内容面（= 注册表 `catalog` 面 / pack `catalog.data` 的形状）。
 *
 * 真值住在 `data/content/catalog.json`。字段名与旧常量一一对应：
 * `destinyCores` ← DEFAULT_DESTINY_CORES、`equipmentPool` ← DEFAULT_EQUIPMENT_POOL、
 * `itemPool` ← DEFAULT_ITEM_POOL、`skillPool` ← DEFAULT_SKILL_POOL、
 * `backgrounds` ← DEFAULT_BACKGROUNDS、`raceCosts` ← DEFAULT_RACE_COSTS、
 * `identityCosts` ← DEFAULT_IDENTITY_COSTS、`startLocations` ← START_LOCATIONS。
 */
export interface CatalogData {
  destinyCores: DestinyCore[];
  equipmentPool: CatalogItem[];
  itemPool: CatalogItem[];
  skillPool: CatalogItem[];
  backgrounds: BackgroundTemplate[];
  raceCosts: Record<string, number>;
  identityCosts: Record<string, number>;
  startLocations: CascaderOption[];
}

// ═══════════════════════════════════════════════════════════
// 2. 机制常量（不进 pack，随引擎走）
// ═══════════════════════════════════════════════════════════

/**
 * 难度档位（机制，D24）。
 *
 * 这是**玩法规则**——「六档、创造模式无限、地狱模式 100 点」这套梯度换世界观也不会变，
 * 所以它留引擎、不进内容包。`CreateStepDifficulty.vue` 直接 import 本常量，
 * 天然不需要走注册表加载门。
 */
export const DIFFICULTY_PRESETS: DifficultyPreset[] = [
  { id: 'creative', label: '创造模式', points: 1000000, desc: '随心所欲，打造理想开局' },
  { id: 'easy', label: '轻松', points: 5000, desc: '充裕的资源，舒服的开局体验' },
  { id: 'simple', label: '简单', points: 2000, desc: '适中的资源，需要一些规划' },
  { id: 'normal', label: '普通', points: 1000, desc: '标准的开局资源，每一步都需斟酌' },
  { id: 'hard', label: '困难', points: 500, desc: '匮乏的资源，精打细算才能生存' },
  { id: 'hell', label: '地狱', points: 100, desc: '绝境求生，命运对你毫不留情' },
];

/** 性别枚举（机制，D24）——与世界观无关的表单选项集。 */
export const GENDER_OPTIONS = [
  '男',
  '女',
  '雌性',
  '雄性',
  '扶他',
  '男娘',
  '假小子',
  '自定义',
] as const;

/**
 * 背景限定条件的覆盖表（机制，D24）。
 *
 * 历史遗留：限定条件（requiredRace/requiredIdentity/…）现在内联在每条背景自身上，
 * 本表因此为空。保留它是因为「限定条件可以由引擎侧覆盖内容侧」这条机制仍成立，
 * 且外部签名不变。
 */
export const BACKGROUND_RESTRICTIONS: Record<string, Partial<BackgroundTemplate>> = {};

/** 种族/身份查不到时的兜底点数（机制常量，原先散在 create-store 的两个 `?? 80`）。 */
export const CUSTOM_COST_FALLBACK = 80;

/** 自定义选项的键名（种族/身份表里那一格） */
export const CUSTOM_OPTION_KEY = '自定义';

// ═══════════════════════════════════════════════════════════
// 3. 校验 / 解析（注册表 `unknown` → `CatalogData`）
// ═══════════════════════════════════════════════════════════

/** 全空目录：注册表那一面缺席 / 坏掉时的取值。**不是**错误信号，是「还没内容」。 */
export const EMPTY_CATALOG: CatalogData = Object.freeze({
  destinyCores: [],
  equipmentPool: [],
  itemPool: [],
  skillPool: [],
  backgrounds: [],
  raceCosts: {},
  identityCosts: {},
  startLocations: [],
}) as CatalogData;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 取一个数组面；不是数组就退化成空数组（不抛） */
function arrayFace<T>(raw: unknown, key: string): T[] {
  if (!isRecord(raw)) return [];
  const v = raw[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * 取一个「名字 → 点数」表面。
 *
 * 🔴 逐键过滤成有限数字，并**丢弃原型键**（`__proto__` / `constructor` / `prototype`）：
 * 这张表的键是内容侧自由文本，而下游拿它做 `costs[race]` 查表 —— 不过滤的话
 * 一个 `__proto__` 键就能把查表结果变成原型对象。同 field-enums 的原型键纪律。
 */
function costFace(raw: unknown, key: string): Record<string, number> {
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  if (!isRecord(raw)) return { ...out };
  const table = raw[key];
  if (!isRecord(table)) return { ...out };
  for (const [k, v] of Object.entries(table)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return { ...out };
}

/**
 * 把注册表 `catalog` 面（`unknown`）收窄成 `CatalogData`。**永不抛**。
 *
 * 逐面独立降级：某一面坏了只让那一面变空，其余照常。捏人页因此在内容缺席时
 * 是「空列表 + 空态」，而不是白屏或异常。
 */
export function parseCatalogData(raw: unknown): CatalogData {
  return {
    destinyCores: arrayFace<DestinyCore>(raw, 'destinyCores'),
    equipmentPool: arrayFace<CatalogItem>(raw, 'equipmentPool'),
    itemPool: arrayFace<CatalogItem>(raw, 'itemPool'),
    skillPool: arrayFace<CatalogItem>(raw, 'skillPool'),
    backgrounds: arrayFace<BackgroundTemplate>(raw, 'backgrounds'),
    raceCosts: costFace(raw, 'raceCosts'),
    identityCosts: costFace(raw, 'identityCosts'),
    startLocations: arrayFace<CascaderOption>(raw, 'startLocations'),
  };
}

/**
 * 目录里有没有可用内容（加载门判据）。
 *
 * 🔴 判据是「**任何**一面非空」而不是「全部非空」：`skillPool` 今天就是空的
 * （技能运行时从仓库 JSON 加载），拿「全部非空」当就绪判据会让捏人页永远卡在加载态。
 */
export function isCatalogPopulated(data: CatalogData): boolean {
  return (
    data.destinyCores.length > 0 ||
    data.equipmentPool.length > 0 ||
    data.itemPool.length > 0 ||
    data.skillPool.length > 0 ||
    data.backgrounds.length > 0 ||
    data.startLocations.length > 0 ||
    Object.keys(data.raceCosts).length > 0 ||
    Object.keys(data.identityCosts).length > 0
  );
}

// ═══════════════════════════════════════════════════════════
// 4. 纯函数 / 计算规则
// ═══════════════════════════════════════════════════════════

/** 按 id 查难度档位；查不到返回 undefined（调用方保持原状，不许静默换档）。 */
export function findDifficultyPreset(id: string): DifficultyPreset | undefined {
  return DIFFICULTY_PRESETS.find((d) => d.id === id);
}

/**
 * 查一个选项的点数消耗（种族 / 身份共用）。
 *
 * 「自定义」与查无此项都落 `CUSTOM_COST_FALLBACK`——自定义内容不可估价，
 * 按最贵的自定义档收费是既有规则。
 */
export function lookupCost(table: Record<string, number>, key: string): number {
  const k = key === CUSTOM_OPTION_KEY ? CUSTOM_OPTION_KEY : key;
  const v = Object.prototype.hasOwnProperty.call(table, k) ? table[k] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : CUSTOM_COST_FALLBACK;
}

/**
 * 点数表 → 下拉选项名单：原序保留，「自定义」永远排最后一位。
 *
 * 内容侧不必操心把「自定义」放哪一行 —— 它是机制项，位置由引擎钉死。
 */
export function costTableOptions(table: Record<string, number>): string[] {
  const rest = Object.keys(table).filter((k) => k !== CUSTOM_OPTION_KEY);
  return [...rest, CUSTOM_OPTION_KEY];
}

/**
 * 级联地点树 → 扁平叶子列表（`{ label: '洲 > 国 > 城', value }`）。
 *
 * 只有叶子进结果：中间节点的 `value` 是分组键（如 `central_east`），不是合法出生地。
 */
export function flattenLocationTree(
  nodes: readonly CascaderOption[],
  prefix = '',
): { label: string; value: string }[] {
  const result: { label: string; value: string }[] = [];
  for (const n of nodes) {
    const label = prefix ? `${prefix} > ${n.label}` : n.label;
    if (!n.children || n.children.length === 0) {
      result.push({ label, value: n.value });
    } else {
      result.push(...flattenLocationTree(n.children, label));
    }
  }
  return result;
}

/** 背景的四个侧栏分类 */
export type BackgroundCategory = 'universal' | 'identity' | 'race' | 'location';

/**
 * 一条背景归哪一类（**唯一**判定，四处调用点共用）。
 *
 * 优先级刻意与旧 `backgroundCategories` 的 if/else 链一致：身份 > 种族 > 地区/核心 > 通用。
 * 一条背景同时限定身份与种族时只算身份那一类——计数与筛选必须用同一条规则，
 * 否则侧栏数字与列表长度对不上。
 */
export function classifyBackground(bg: BackgroundTemplate): BackgroundCategory {
  if (bg.requiredIdentity) return 'identity';
  if (bg.requiredRace) return 'race';
  if (bg.requiredLocation || bg.requiredDestinyCore) return 'location';
  return 'universal';
}

/** 按分类筛背景（与 `classifyBackground` 同源） */
export function filterBackgroundsByCategory(
  pool: readonly BackgroundTemplate[],
  category: BackgroundCategory,
): BackgroundTemplate[] {
  return pool.filter((bg) => classifyBackground(bg) === category);
}

/** 四类各有多少条（与 `filterBackgroundsByCategory` 同源，保证数字对得上） */
export function countBackgroundsByCategory(
  pool: readonly BackgroundTemplate[],
): Record<BackgroundCategory, number> {
  const counts: Record<BackgroundCategory, number> = {
    universal: 0,
    identity: 0,
    race: 0,
    location: 0,
  };
  for (const bg of pool) counts[classifyBackground(bg)]++;
  return counts;
}
