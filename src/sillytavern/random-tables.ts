/**
 * NPC 生成随机表 — schema + 抽样纯函数（Phase 8.5；内容-引擎分离 波 2 / D25③）
 *
 * 提供 code 层随机化工具，供 Agentic Agent (char_gen) 通过工具调用获取真实随机值。
 *
 * 🔴 **本模块不再持有名字池 / 发色池 / 瞳色池 / 性格池的数据**（D25③）。它们住在内容
 * 注册表的 `namePools` 面（占位来源 `/data/content/name-pools.json`，装包后由 pack 的
 * `namePools` 分节替换）。这里只留：形状（{@link NamePoolsContent}）、注册表读取缝、
 * 抽样纯函数，以及**属性投点算法**（`rollAttributes` / `getTierAttributeCap` 是数值机制，
 * 不是内容，留在引擎）。
 *
 * 🔴 **空池一律确定性兜底、绝不抛**：名字/发色/瞳色返回空串，性格返回
 * `{ code: '', description: '' }`。注册表在 boot 链上灌注（content-store 的
 * `ensureContentRegistryLoaded()`，D16 时序契约），而工具执行必在其后。
 *
 * 抽样函数都收一个可选的内容参数（默认 = 注册表当前值），与 `location-db.ts` 的
 * `(nodes, …)` 参数式同一口径：调用方不必知道注册表，测试可直接喂 fixture。
 */

import { getContentRegistry } from '../ui/stores/content-store';

// ========== 通用随机工具 ==========

/** 从数组中随机取一个元素；空数组 / 缺失返回 undefined（不抛） */
function pick<T>(arr: readonly T[] | undefined): T | undefined {
  if (!arr || arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 在 [min, max] 范围内随机整数（两端包含） */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ═══════════════════════════════════════════════════════════
// 形状（注册表 `namePools` 面 / pack `namePools` 分节）
// ═══════════════════════════════════════════════════════════

/** 一个种族的名称池 */
export interface NamePool {
  male: string[];
  female: string[];
  surnames: string[];
}

/** 性格维度的一项（编码 + 人类可读描述） */
export interface PersonalityTrait {
  code: string;
  desc: string;
}

/** 性格池：五维 + 稳定性，各是一组可选项 */
export interface PersonalityPool {
  warmth: PersonalityTrait[];
  openness: PersonalityTrait[];
  urgency: PersonalityTrait[];
  firmness: PersonalityTrait[];
  persistence: PersonalityTrait[];
  stability: PersonalityTrait[];
}

/** 性格维度的键（用于遍历/校验；顺序即编码拼接顺序） */
const PERSONALITY_AXES = [
  'warmth',
  'openness',
  'urgency',
  'firmness',
  'persistence',
  'stability',
] as const;

/** 注册表 `namePools` 面的整体形状 */
export interface NamePoolsContent {
  /** 名字池查不到该种族时回退到的种族键；缺省 = 不回退 */
  defaultRace?: string;
  /** 发色/瞳色池查不到该种族时回退到的键；缺省 = 不回退 */
  defaultColorKey?: string;
  namePools: Record<string, NamePool>;
  hairColors: Record<string, string[]>;
  eyeColors: Record<string, string[]>;
  personality: Partial<PersonalityPool>;
}

/** 空内容（注册表未就绪 / 形状不对时的确定性兜底） */
const EMPTY_NAME_POOLS_CONTENT: NamePoolsContent = {
  namePools: {},
  hairColors: {},
  eyeColors: {},
  personality: {},
};

// ═══════════════════════════════════════════════════════════
// 注册表读取缝
// ═══════════════════════════════════════════════════════════

/**
 * 取当前生效的名字池内容（同步读注册表）。
 *
 * 该面未就绪 / 形状不对 → 返回空内容（各池为空对象）。逐段做最小形状校验，
 * 坏的一段只让那一段变空，不牵连其余段。
 */
export function getNamePoolsContent(): NamePoolsContent {
  const raw: unknown = getContentRegistry().namePools;
  if (!isPlainObject(raw)) return EMPTY_NAME_POOLS_CONTENT;
  return {
    defaultRace: typeof raw.defaultRace === 'string' ? raw.defaultRace : undefined,
    defaultColorKey: typeof raw.defaultColorKey === 'string' ? raw.defaultColorKey : undefined,
    namePools: parseNamePools(raw.namePools),
    hairColors: parseStringListMap(raw.hairColors),
    eyeColors: parseStringListMap(raw.eyeColors),
    personality: parsePersonality(raw.personality),
  };
}

/** 窄化：值是不是普通对象（非 null / 非数组） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 只保留字符串元素的数组（非数组 → 空数组） */
function parseStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** `Record<string, string[]>` 形状（发色池 / 瞳色池） */
function parseStringListMap(v: unknown): Record<string, string[]> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(v)) out[key] = parseStringList(value);
  return out;
}

/** `Record<string, NamePool>` 形状（名字池） */
function parseNamePools(v: unknown): Record<string, NamePool> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, NamePool> = {};
  for (const [race, value] of Object.entries(v)) {
    if (!isPlainObject(value)) continue;
    out[race] = {
      male: parseStringList(value.male),
      female: parseStringList(value.female),
      surnames: parseStringList(value.surnames),
    };
  }
  return out;
}

/** 性格池形状（逐维度校验，缺失维度直接不出现） */
function parsePersonality(v: unknown): Partial<PersonalityPool> {
  if (!isPlainObject(v)) return {};
  const out: Partial<PersonalityPool> = {};
  for (const axis of PERSONALITY_AXES) {
    const list = v[axis];
    if (!Array.isArray(list)) continue;
    const traits: PersonalityTrait[] = [];
    for (const item of list) {
      if (!isPlainObject(item)) continue;
      if (typeof item.code !== 'string' || typeof item.desc !== 'string') continue;
      traits.push({ code: item.code, desc: item.desc });
    }
    out[axis] = traits;
  }
  return out;
}

/** 按种族取名字池；查不到回退 `defaultRace`，仍查不到返回 undefined */
function resolveNamePool(race: string, content: NamePoolsContent): NamePool | undefined {
  const direct = content.namePools[race];
  if (direct) return direct;
  const fallbackKey = content.defaultRace;
  return fallbackKey === undefined ? undefined : content.namePools[fallbackKey];
}

/** 按种族取颜色池；查不到回退 `defaultColorKey`，仍查不到返回空数组 */
function resolveColorPool(
  race: string,
  map: Record<string, string[]>,
  content: NamePoolsContent,
): string[] {
  const direct = map[race];
  if (direct) return direct;
  const fallbackKey = content.defaultColorKey;
  return (fallbackKey === undefined ? undefined : map[fallbackKey]) ?? [];
}

// ═══════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════

/**
 * 随机生成角色名称（名+姓，中间阶层格式）。
 *
 * 50% 概率带姓氏；🔴 该种族**没有姓氏池**（如世界书里明确「无姓氏」的种族）时
 * 只返回名，不再拼一个空姓——原实现在这里会产出 `名·undefined`。
 * 名字池为空 → 返回空串（确定性兜底）。
 *
 * @param avoid 已有角色名单（防重名，2026-08-15）。比较粒度是「·」前的**给定名**——
 *   已有 `奥斯瓦尔德·狼牙` 时，`奥斯瓦尔德` 与 `奥斯瓦尔德·X` 都算撞车，直接从
 *   候选池里剔除后再抽（真机教训：同一存档抽中两个「奥斯瓦尔德」）。候选池被
 *   avoid 全覆盖（池小或同名 NPC 成批）时退回原名池——空名比重名更坏
 *   （`<char_result><name>` 为空会打断整条生成链）。avoid 为空时行为与旧版逐字节一致。
 */
export function randomName(
  race: string,
  gender: '男' | '女' = '男',
  content: NamePoolsContent = getNamePoolsContent(),
  avoid: readonly string[] = [],
): string {
  const pool = resolveNamePool(race, content);
  const givenNames = gender === '男' ? pool?.male : pool?.female;
  if (!givenNames || givenNames.length === 0) return '';

  const avoidGiven = new Set(
    avoid.filter(Boolean).map((n) => n.split('·')[0].trim().toLowerCase()),
  );
  const candidates = avoidGiven.size
    ? givenNames.filter((g) => !avoidGiven.has(g.toLowerCase()))
    : givenNames;
  // 候选池被 avoid 全覆盖 → 退回原名池（好过空串打断生成链）
  const source = candidates.length > 0 ? candidates : givenNames;
  const given = source[Math.floor(Math.random() * source.length)];

  // 50% 概率有姓氏（中层阶级）
  if (Math.random() < 0.5) {
    const surname = pick(pool?.surnames);
    if (surname !== undefined) return `${given}·${surname}`;
  }
  return given;
}

/** 随机生成发色（池为空 → 空串） */
export function randomHairColor(
  race: string,
  content: NamePoolsContent = getNamePoolsContent(),
): string {
  return pick(resolveColorPool(race, content.hairColors, content)) ?? '';
}

/** 随机生成瞳色（池为空 → 空串） */
export function randomEyeColor(
  race: string,
  content: NamePoolsContent = getNamePoolsContent(),
): string {
  return pick(resolveColorPool(race, content.eyeColors, content)) ?? '';
}

/** 性格维度键 → 描述行前缀（描述文案的组装顺序与 PERSONALITY_AXES 一致） */
const PERSONALITY_AXIS_LABELS: Record<(typeof PERSONALITY_AXES)[number], string> = {
  warmth: '亲近度',
  openness: '坦露度',
  urgency: '急切度',
  firmness: '刚柔度',
  persistence: '执着度',
  stability: '稳定性',
};

/**
 * 随机生成性格编码和描述（五维模型 + 稳定性）。
 *
 * 编码形如 `wOaGz(A)`：前五维直接拼接，稳定性用括号包住。
 * 某一维池为空 → 该维不进编码也不进描述；全空 → `{ code: '', description: '' }`。
 */
export function randomPersonality(content: NamePoolsContent = getNamePoolsContent()): {
  code: string; // 如 'wOaGz(A)'
  description: string; // 人类可读描述
} {
  const picked = new Map<(typeof PERSONALITY_AXES)[number], PersonalityTrait>();
  for (const axis of PERSONALITY_AXES) {
    const trait = pick(content.personality[axis]);
    if (trait) picked.set(axis, trait);
  }

  let code = '';
  for (const axis of PERSONALITY_AXES) {
    const trait = picked.get(axis);
    if (!trait) continue;
    // 稳定性是最后一维，用括号包住；其余直接拼
    code += axis === 'stability' ? `(${trait.code})` : trait.code;
  }

  const description = PERSONALITY_AXES.filter((axis) => picked.has(axis))
    .map((axis) => `${PERSONALITY_AXIS_LABELS[axis]}: ${picked.get(axis)!.desc}`)
    .join('; ');

  return { code, description };
}

/** 按 Tier 获取属性随机范围（数值机制，非内容） */
export function getTierAttributeCap(tier: number): number {
  const CAPS: Record<number, number> = { 1: 8, 2: 10, 3: 12, 4: 14, 5: 16, 6: 18, 7: 20 };
  return CAPS[tier] ?? 8;
}

/**
 * 按 Tier 随机生成五维属性（三池分配模型）
 *
 * 公式: 每项 = [基础池分配] + [层级固定 tier-1] + {等级额外分配}
 * - 基础池: 0~25 点自由分配，每项上限 6（每项上限与层级实力无关，仅代表天赋与种族优劣）
 * - 层级固定: 每属性固定获得 tier-1 点
 * - 等级额外: 每等级 1 点自由分配（共 level-1 点），不超 tierCap
 * - 每项总上限由 tier 决定（见 getTierAttributeCap）
 */
export function rollAttributes(
  tier: number,
  level: number = 1,
): {
  str: number;
  dex: number;
  con: number;
  int: number;
  spi: number;
  /** 三池分解信息 */
  breakdown: {
    basePool: number;
    tierFixed: number;
    levelExtra: number;
    cap: number;
    baseCap: number;
    baseUsed: number;
    levelUsed: number;
  };
} {
  const cap = getTierAttributeCap(tier);
  const baseCap = 6; // 天赋基础每项上限 6
  const tierFixed = Math.max(0, tier - 1); // 每属性固定 +tier-1
  const basePool = randInt(0, 25); // 基础浮动池（天赋/种族优劣）
  const levelExtra = Math.max(0, level - 1); // 等级额外池

  const attrs: Record<string, number> = {
    str: 0,
    dex: 0,
    con: 0,
    int: 0,
    spi: 0,
  };
  const keys = ['str', 'dex', 'con', 'int', 'spi'] as const;

  // 阶段 1: 分配基础池 — 每项上限 baseCap(6)
  let baseRemaining = basePool;
  let baseUsed = 0;
  while (baseRemaining > 0) {
    const eligible = keys.filter((k) => attrs[k] < baseCap);
    if (eligible.length === 0) break;
    const key = eligible[Math.floor(Math.random() * eligible.length)];
    attrs[key]++;
    baseRemaining--;
    baseUsed++;
  }
  // 未分配完的 basePool 舍弃（已达每项 6 上限）

  // 阶段 2: 分配等级额外点 — 每项总上限 = cap - tierFixed（让最终值不超 cap）
  let levelRemaining = levelExtra;
  let levelUsed = 0;
  const levelCap = cap - tierFixed; // 这是等级额外的实际上限
  while (levelRemaining > 0) {
    const eligible = keys.filter((k) => attrs[k] < levelCap);
    if (eligible.length === 0) break;
    const key = eligible[Math.floor(Math.random() * eligible.length)];
    attrs[key]++;
    levelRemaining--;
    levelUsed++;
  }

  // 阶段 3: 每项 + tierFixed
  for (const k of keys) {
    attrs[k] += tierFixed;
  }

  return {
    str: attrs['str']!,
    dex: attrs['dex']!,
    con: attrs['con']!,
    int: attrs['int']!,
    spi: attrs['spi']!,
    breakdown: { basePool, tierFixed, levelExtra, cap, baseCap, baseUsed, levelUsed },
  };
}

/** 随机生成外貌描述摘要（年龄+体型，不含发色瞳色——请单独调用 random_hair_color / random_eye_color） */
export function randomAppearanceSummary(
  race: string,
  gender: '男' | '女',
): {
  ageAppearance: string; // 外观年龄范围
  build: string; // 体型描述
} {
  const agePool = ['少年', '青年', '壮年', '中年'];
  const buildMale = ['瘦削', '精壮', '魁梧', '匀称', '健硕'];
  const buildFemale = ['纤细', '匀称', '丰满', '娇小', '高挑'];
  const buildGeneric = ['中等', '匀称', '偏瘦', '偏壮'];

  const ageAppearance = pick(agePool) ?? '';
  const build =
    (gender === '男'
      ? pick(buildMale)
      : gender === '女'
        ? pick(buildFemale)
        : pick(buildGeneric)) ?? '';

  return { ageAppearance, build };
}
