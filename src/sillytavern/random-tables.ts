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
  /** 音素种子 profile（世界书 uid 480748 移植，2026-08-15）；缺面 = 空对象（种子工具返回空） */
  seedProfiles: Record<string, SeedProfile>;
  hairColors: Record<string, string[]>;
  eyeColors: Record<string, string[]>;
  personality: Partial<PersonalityPool>;
}

/** 空内容（注册表未就绪 / 形状不对时的确定性兜底） */
const EMPTY_NAME_POOLS_CONTENT: NamePoolsContent = {
  namePools: {},
  seedProfiles: {},
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
    seedProfiles: parseSeedProfiles(raw.seedProfiles),
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
// IPA 音素种子（世界书 uid 480748 [角色命名指导] 的 IPA-Seed 机制移植，2026-08-15）
// ═══════════════════════════════════════════════════════════
//
// 世界书的原设计：不直接随机「整名」，而是先生成**音素种子**，再交给命名规则拼装，
// 降低同质化（固定名字池抽来抽去总是那几十个名，真机已撞过「奥斯瓦尔德」）。
// 按 ADR-28 移植口径：结果（AI 拿到多样化取名灵感）照搬，手段工程化——
// 种子生成（随机）归 Code，创名（创意：文化风格分析→发音转写中文）归 AI（ADR-11）。
//
// 分工与 D25③ 同口径：**音素池/修饰符算法是机制，留在引擎；种族 profile 是世界数据，
// 住内容仓 `name-pools.json` 的 `seedProfiles` 面**（pack 搭 namePools 分节整体替换）。

/** 音素池键：P 强力（爆破/塞擦）/ S 丝滑（擦音/流音/滑音）/ D 深沉（鼻音/喉化）/ X 异质（点击/内爆/喷音/喉塞）/ V 元音 */
export type PhonemePoolKey = 'P' | 'S' | 'D' | 'X' | 'V';

/** 五组 IPA 音素池（语言通用的音系分类，不是世界数据） */
const IPA_POOLS: Record<PhonemePoolKey, readonly string[]> = {
  P: [
    'p',
    'b',
    't',
    'd',
    'k',
    'ɡ',
    'q',
    'ʈ',
    'ɖ',
    'c',
    'ɟ',
    'ts',
    'dz',
    'tʃ',
    'dʒ',
    'tɕ',
    'dʑ',
    'ʈʂ',
    'ɖʐ',
  ],
  S: [
    'f',
    's',
    'v',
    'z',
    'ʃ',
    'ʒ',
    'ɕ',
    'ʑ',
    'ʂ',
    'ʐ',
    'ɸ',
    'β',
    'θ',
    'ð',
    'ç',
    'x',
    'h',
    'ɬ',
    'ɮ',
    'l',
    'r',
    'ɹ',
    'ɾ',
    'ɽ',
    'ʎ',
    'j',
    'w',
  ],
  D: ['m', 'ɱ', 'n', 'ɳ', 'ɲ', 'ŋ', 'ɴ', 'ʁ', 'ʀ', 'ɣ', 'χ', 'ʕ', 'ɫ', 'ɢ'],
  X: ['ǃ', 'ʘ', 'ǀ', 'ǁ', 'ǂ', 'ɓ', 'ɗ', 'ʄ', 'ɠ', 'ʛ', "p'", "t'", "k'", "q'", "ts'", "tʃ'", 'ʔ'],
  V: [
    'i',
    'y',
    'ɨ',
    'ʉ',
    'ɯ',
    'u',
    'ɪ',
    'ʏ',
    'ʊ',
    'e',
    'ø',
    'ɘ',
    'ɵ',
    'ɤ',
    'o',
    'ə',
    'ɛ',
    'œ',
    'ɜ',
    'ɞ',
    'ʌ',
    'ɔ',
    'æ',
    'ɐ',
    'a',
    'ɶ',
    'ɑ',
    'ɒ',
  ],
};

/** 音素 → 所属池（O(1) 反查表） */
const PHONEME_POOL_OF: ReadonlyMap<string, PhonemePoolKey> = new Map(
  (Object.keys(IPA_POOLS) as PhonemePoolKey[]).flatMap((key) =>
    IPA_POOLS[key].map((ph) => [ph, key] as const),
  ),
);

/** 元音亮/暗两组（vowelTone 修饰符的换字来源） */
const BRIGHT_VOWELS = ['i', 'y', 'e', 'ø', 'ɪ', 'ʏ', 'ɛ', 'œ', 'æ'];
const DARK_VOWELS = ['u', 'ɯ', 'o', 'ɤ', 'ʊ', 'ɔ', 'ɑ', 'ɒ', 'ʌ', 'ɞ'];

/** 连读音变规则（音系通用的同化现象，不是世界数据） */
const MUTATION_RULES: ReadonlyArray<{
  prev: readonly string[];
  curr: readonly string[];
  to: string;
}> = [
  { prev: ['s', 'z'], curr: ['j', 'i', 'ɪ'], to: 'ʃ' },
  { prev: ['t'], curr: ['s'], to: 'ts' },
  { prev: ['d'], curr: ['z'], to: 'dz' },
  { prev: ['t'], curr: ['ʃ'], to: 'tʃ' },
  { prev: ['d'], curr: ['ʒ'], to: 'dʒ' },
  { prev: ['n'], curr: ['k', 'ɡ', 'q', 'ɢ'], to: 'ŋ' },
];

/** 种族种子 profile 的修饰符层 */
export interface SeedProfileMods {
  startPrefer: PhonemePoolKey[];
  endPrefer: PhonemePoolKey[];
  maxConsecutiveConsonants: number;
  vowelTone: 'neutral' | 'bright' | 'dark';
  mutationChance: number;
}

/** 一个种族的音素种子 profile（世界书 raceProfiles 的形状） */
export interface SeedProfile {
  /** 各池抽样权重（值越大越容易抽到；缺省池 = 权重 0） */
  weights: Partial<Record<PhonemePoolKey, number>>;
  /** 强制池（按顺序至少抽到这些池各 1 个） */
  force: PhonemePoolKey[];
  /** 本轮总音素数量区间 [min, max] */
  count: [number, number];
  mods: SeedProfileMods;
}

const SEED_POOL_KEYS: readonly PhonemePoolKey[] = ['P', 'S', 'D', 'X', 'V'];

/** `Record<string, SeedProfile>` 的容错解析：坏 profile 整条丢弃，不牵连其余 */
function parseSeedProfiles(v: unknown): Record<string, SeedProfile> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, SeedProfile> = {};
  for (const [race, value] of Object.entries(v)) {
    if (!isPlainObject(value)) continue;
    const weights: Partial<Record<PhonemePoolKey, number>> = {};
    if (isPlainObject(value.weights)) {
      for (const key of SEED_POOL_KEYS) {
        const w = Number(value.weights[key]);
        if (Number.isFinite(w) && w >= 0) weights[key] = w;
      }
    }
    const force = Array.isArray(value.force)
      ? value.force.filter((k): k is PhonemePoolKey => SEED_POOL_KEYS.includes(k as PhonemePoolKey))
      : [];
    const rawCount = Array.isArray(value.count) ? value.count.map(Number) : [];
    let lo = Number.isFinite(rawCount[0]) ? Math.floor(rawCount[0]) : 3;
    let hi = Number.isFinite(rawCount[1]) ? Math.floor(rawCount[1]) : 4;
    if (lo > hi) [lo, hi] = [hi, lo];
    lo = Math.min(Math.max(lo, 1), 12);
    hi = Math.min(Math.max(hi, lo), 12);

    const mods = isPlainObject(value.mods) ? value.mods : {};
    const parseKeyList = (x: unknown): PhonemePoolKey[] =>
      Array.isArray(x)
        ? x.filter((k): k is PhonemePoolKey => SEED_POOL_KEYS.includes(k as PhonemePoolKey))
        : [];
    const tone =
      mods.vowelTone === 'bright' || mods.vowelTone === 'dark' ? mods.vowelTone : 'neutral';
    const chance = Number(mods.mutationChance);
    out[race] = {
      weights,
      force,
      count: [lo, hi],
      mods: {
        startPrefer: parseKeyList(mods.startPrefer),
        endPrefer: parseKeyList(mods.endPrefer),
        maxConsecutiveConsonants: Math.min(
          Math.max(Math.floor(Number(mods.maxConsecutiveConsonants) || 2), 1),
          6,
        ),
        vowelTone: tone,
        mutationChance: Number.isFinite(chance) ? Math.min(Math.max(chance, 0), 1) : 0,
      },
    };
  }
  return out;
}

/** 按种族取种子 profile；查不到回退 `defaultRace`（与 resolveNamePool 同链），仍查不到返回 undefined */
function resolveSeedProfile(race: string, content: NamePoolsContent): SeedProfile | undefined {
  const direct = content.seedProfiles[race];
  if (direct) return direct;
  const fallbackKey = content.defaultRace;
  return fallbackKey === undefined ? undefined : content.seedProfiles[fallbackKey];
}

// ── 修饰符管线（世界书原文的忠实移植；每步都保持纯函数式：改副本不动入参） ──

function pickWeightedPool(weights: Partial<Record<PhonemePoolKey, number>>): PhonemePoolKey {
  let total = 0;
  for (const key of SEED_POOL_KEYS) total += Math.max(0, weights[key] ?? 0);
  if (total <= 0) return 'V';
  let roll = Math.random() * total;
  for (const key of SEED_POOL_KEYS) {
    roll -= Math.max(0, weights[key] ?? 0);
    if (roll <= 0) return key;
  }
  return 'V';
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function poolKeyOf(phoneme: string): PhonemePoolKey {
  return PHONEME_POOL_OF.get(phoneme) ?? 'S';
}

function isVowelPhoneme(phoneme: string): boolean {
  return poolKeyOf(phoneme) === 'V';
}

function movePreferredToEdge(
  seed: string[],
  preferredPools: readonly PhonemePoolKey[],
  edge: 'start' | 'end',
): void {
  if (preferredPools.length === 0 || seed.length === 0) return;
  const target = edge === 'end' ? seed.length - 1 : 0;
  const idx = seed.findIndex((p) => preferredPools.includes(poolKeyOf(p)));
  if (idx > -1 && idx !== target) [seed[target], seed[idx]] = [seed[idx], seed[target]];
}

function smoothConsonantClusters(seed: string[], maxConsecutiveConsonants: number): void {
  let run = 0;
  for (let i = 0; i < seed.length; i++) {
    if (isVowelPhoneme(seed[i])) {
      run = 0;
      continue;
    }
    run += 1;
    if (run <= maxConsecutiveConsonants) continue;
    const vowelIndex = seed.findIndex((p, j) => j > i && isVowelPhoneme(p));
    if (vowelIndex > -1) {
      [seed[i], seed[vowelIndex]] = [seed[vowelIndex], seed[i]];
      run = 0;
      continue;
    }
    seed[i] = pick(IPA_POOLS.V)!; // 找不到后置元音就地把超额辅音换成元音
    run = 0;
  }
}

function shiftVowelTone(seed: string[], tone: 'neutral' | 'bright' | 'dark'): void {
  if (tone !== 'bright' && tone !== 'dark') return;
  for (let i = 0; i < seed.length; i++) {
    if (!isVowelPhoneme(seed[i]) || Math.random() >= 0.45) continue;
    if (tone === 'bright' && DARK_VOWELS.includes(seed[i])) seed[i] = pick(BRIGHT_VOWELS)!;
    else if (tone === 'dark' && BRIGHT_VOWELS.includes(seed[i])) seed[i] = pick(DARK_VOWELS)!;
  }
}

function applyMutations(seed: string[], chance: number): void {
  if (chance <= 0) return;
  for (let i = 1; i < seed.length; i++) {
    if (Math.random() >= chance) continue;
    for (const rule of MUTATION_RULES) {
      if (rule.prev.includes(seed[i - 1]) && rule.curr.includes(seed[i])) {
        seed[i] = rule.to;
        break;
      }
    }
  }
}

function dedupeAdjacent(seed: string[]): void {
  for (let i = 1; i < seed.length; i++) {
    if (seed[i] !== seed[i - 1]) continue;
    const pool = IPA_POOLS[poolKeyOf(seed[i])];
    if (pool.length < 2) continue;
    let replaced = seed[i];
    let guard = 0;
    while (replaced === seed[i] && guard < 8) {
      replaced = pick(pool)!;
      guard += 1;
    }
    seed[i] = replaced;
  }
}

function buildSeedOnce(profile: SeedProfile): string[] {
  const [lo, hi] = profile.count;
  const targetCount = randInt(lo, hi);
  const seed: string[] = [];
  for (const forcedPool of profile.force) {
    if (seed.length >= targetCount) break;
    seed.push(pick(IPA_POOLS[forcedPool]) ?? pick(IPA_POOLS.V)!);
  }
  while (seed.length < targetCount) {
    const poolKey = pickWeightedPool(profile.weights);
    seed.push(pick(IPA_POOLS[poolKey]) ?? pick(IPA_POOLS.V)!);
  }
  const next = shuffleInPlace(seed.slice());
  const mods = profile.mods;
  movePreferredToEdge(next, mods.startPrefer, 'start');
  movePreferredToEdge(next, mods.endPrefer, 'end');
  smoothConsonantClusters(next, mods.maxConsecutiveConsonants);
  shiftVowelTone(next, mods.vowelTone);
  applyMutations(next, mods.mutationChance);
  dedupeAdjacent(next);
  return next;
}

/**
 * 生成 IPA 音素种子（世界书 uid 480748 机制）。
 *
 * 返回 `['t/a/ʃ/i/n/ɑ', ...]` 形式的种子串——**不是成品名**，是取名灵感；
 * 创名（文化风格分析→按发音转写中文）是 AI 的活，规则在 char_gen 提示词。
 * 该种族没有 profile（且回退不到 defaultRace）→ 空数组（确定性兜底，工具层
 * 会提示 AI 改用 random_name）。
 *
 * @param count 生成几组（钳到 1-8；世界书口径人类 3 组、其余 1 组）
 */
export function randomNameSeed(
  race: string,
  count = 1,
  content: NamePoolsContent = getNamePoolsContent(),
): string[] {
  const profile = resolveSeedProfile(race, content);
  if (!profile) return [];
  const total = Math.min(Math.max(Math.floor(Number(count) || 1), 1), 8);
  return Array.from({ length: total }, () => buildSeedOnce(profile).join('/'));
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
