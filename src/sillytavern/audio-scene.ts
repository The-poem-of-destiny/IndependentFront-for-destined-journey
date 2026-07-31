/**
 * audio-scene.ts — 场景选曲：多维度标签累计打分 (Phase Audio)
 *
 * 为什么存在: 叙事里的地点名是**自由文本**（七段连字符路径 / "铁炉堡的锻炉区"），
 * 而曲库标签是有限的几十个（"地点:奥古斯提姆帝国"）。两者永远不会字面相等，
 * 所以需要一层解析：地点沿层级链模糊找、分数随回退深度衰减，再与人物/情绪/
 * 情境三个维度**加权累计**，总分最高者胜出。
 *
 * 唯一选曲入口是 `resolveSceneByTags`。此前那版「只看地点、逐级短路」的
 * `resolveSceneAudio` 已撤除 —— 短路与累计分是互斥的两套语义，同时留着只会
 * 让"为什么选了这首"有两个答案。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无 AudioContext —— 与 audio-names.ts
 * 同级的纯函数模块，必须在 vitest environment:'node' 下可导入。
 *
 * 名字口径: 复用 audio-names.ts 的 normalizeAudioName，不另起一套归一化规则。
 *
 * 🔴 已知限制（刻意不做）:
 * - 不做拼音/罗马化匹配（继承 normalizeAudioName 的限制）
 * - 不做同义词词典（"帝都" ≠ "艾瑟嘉德"）；别名靠 manifest 的 tags 显式写出
 * - 不做跨兄弟节点检索（隔壁城市的曲子绝不会被拿来顶替）
 */

import { normalizeAudioName } from './audio-names';
import { groupTrackTags, tagValuesFor, type AudioTagType, type GroupedTags } from './audio-tags';
import { DEFAULT_LOCATIONS } from './location-db';
import type { AudioTrack, AudioTrackKind, LocationNode } from './types';

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/**
 * 相似度门槛。低于此值一律不算命中 —— 宁可回退到父级地点，
 * 也不要拿一首八竿子打不着的曲子糊弄。
 */
export const SCENE_MATCH_THRESHOLD = 0.5;

/** 祖先链最大深度。防御 parentId 成环（数据错误不该让解析器死循环） */
const MAX_CHAIN_DEPTH = 8;

/**
 * 位置路径的分隔符。
 *
 * 正典格式来自 `agent-config.json` 的 `<tp_format>`:
 * `${大陆方位}-${区域}-${势力}-${子级势力}-${聚落/地标}-${区位}-${详细位置}`
 * 连字符是主用分隔符；`/` 是 `getLocationPath()` 的产出格式，一并认。
 *
 * **刻意不含 `·`**: 地名里就带间隔号（`诺瓦·瓦伦蒂亚城`、`拜特·纳尔`、
 * `达尔·苏克`），拿它分段会把一个地名劈成两半。
 */
const PATH_SEPARATORS = /[-－—–/／>＞]/;

/**
 * 变体语义（来自素材作者的约定）:
 * - A: 平静 / 白天 / 探索
 * - B: 活动 / 夜晚 / 不安
 */
export type SceneVariant = 'A' | 'B';

/** 变体的等价标签 —— manifest 里写中文，调用方传 'A'/'B'，两边都认 */
const VARIANT_ALIASES: Readonly<Record<SceneVariant, readonly string[]>> = {
  A: ['a', '平静', '白天', '探索'],
  B: ['b', '活动', '夜晚', '不安'],
};

// ═══════════════════════════════════════════════════════════
// 相似度
// ═══════════════════════════════════════════════════════════

/** 取字符二元组集合；单字返回该字本身，保证短串也有可比的特征 */
function bigrams(s: string): Set<string> {
  if (s.length <= 1) return new Set(s ? [s] : []);
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * 两个名字的相似度，值域 [0, 1]。
 *
 * 分三档，档与档之间不重叠 —— 包含关系永远压过纯字形相似，
 * 免得「碎星群岛」被「碎冕冰脊」的共享字骗过去:
 * - 归一化后相等          → 1
 * - 一方包含另一方        → 0.6 + 0.4 × 长度比（越接近整词越高，上限 <1）
 * - 其余                  → Dice 系数 × 0.55（上限 0.55，压在包含档之下）
 */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeAudioName(a);
  const y = normalizeAudioName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  if (x.includes(y) || y.includes(x)) {
    const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
    return 0.6 + 0.4 * ratio;
  }

  const gx = bigrams(x);
  const gy = bigrams(y);
  if (gx.size === 0 || gy.size === 0) return 0;
  let shared = 0;
  for (const g of gx) if (gy.has(g)) shared += 1;
  return ((2 * shared) / (gx.size + gy.size)) * 0.55;
}

// ═══════════════════════════════════════════════════════════
// 地点链
// ═══════════════════════════════════════════════════════════

/** 链上的一环: 地点名 + 它相对查询地点的回退深度 */
export interface SceneChainLink {
  name: string;
  /** 0 = 查询地点自身（含它在 location-db 里的规范名）；1 = 父级；2 = 祖父… */
  depth: number;
}

/**
 * 拆位置路径为「由细到粗」的段序列。
 *
 * `大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德`
 *   → `['艾瑟嘉德', '奥古斯提姆帝国', '大陆中东部区域']`
 *
 * 非路径的单段输入（叙事里直接写的地名）原样返回单元素数组。
 */
export function splitLocationPath(location: string): string[] {
  return (location ?? '')
    .split(PATH_SEPARATORS)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .reverse();
}

/**
 * 构造「本地点 → 父 → 祖父 → …」的回退链。
 *
 * 层级的**首要来源是位置路径本身** —— 正典位置就是七段连字符路径，路径里
 * 已经写明了「大陆方位-区域-势力-子级势力-聚落-区位-详细位置」，最细的一段
 * 是 depth 0，往左每退一段深一级。这比查 location-db 覆盖面大得多:
 * `location-db` 只有三十来个节点，「大陆中东部区域」这类方位段、「龙脊山脉」
 * 这类地貌名它根本没有。
 *
 * `location-db` 退居**补充**: 把最细那段能定位到的节点的祖先接在链尾。
 * 对完整路径而言这些祖先通常已在路径里，去重后等于没加；对「白曜城中央广场」
 * 这种没写路径的单段输入，它就是唯一的层级来源。一条规则同时照顾两种形状。
 *
 * 规范名与输入名同属 depth 0: 它们指的是同一个地方，谁命中都不算「回退」。
 */
export function buildLocationChain(
  location: string,
  nodes: readonly LocationNode[] = DEFAULT_LOCATIONS,
): SceneChainLink[] {
  const links: SceneChainLink[] = [];
  const seen = new Set<string>();

  const push = (name: string, depth: number): void => {
    const key = normalizeAudioName(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    links.push({ name, depth });
  };

  // ① 路径段: 由细到粗，每段一级
  const segments = splitLocationPath(location);
  segments.forEach((seg, i) => push(seg, i));
  if (links.length === 0) return links; // 空查询

  // ② location-db 补充: 由细到粗逐段定位，取**第一个**能定位到的段。
  // 路径最细的一段常常是 location-db 里没有的区位（「贵族区」），
  // 真正能接上地图的是稍粗的那段（「艾瑟嘉德」）—— 卡在第一段就白补了。
  let node: LocationNode | undefined;
  let matchedDepth = 0;
  for (let d = 0; d < segments.length; d += 1) {
    let best = SCENE_MATCH_THRESHOLD;
    for (const n of nodes) {
      const score = nameSimilarity(segments[d], n.name);
      if (score > best) {
        best = score;
        node = n;
      }
    }
    if (node) {
      matchedDepth = d;
      break;
    }
  }
  if (!node) return links;

  // 规范名的深度 = **命中它的那一段的深度**，不是 0。
  // 定位可能发生在较粗的段上（`永夜领-诺克瓦罗斯城-地穴` 里最细的「地穴」查不到，
  // 是「诺克瓦罗斯城」才接上地图的），无条件提到 0 会让城市级曲子跟区位级曲子平起
  // 平坐，最具体的那首反而要靠 createdAt 兜底才分胜负。
  push(node.name, matchedDepth);

  // ③ 沿 parentId 上溯，接在命中段之后
  const tailBase = matchedDepth;
  let cursor: LocationNode | undefined = node;
  for (let step = 1; step <= MAX_CHAIN_DEPTH; step += 1) {
    const parentId: string | null = cursor?.parentId ?? null;
    if (!parentId) break;
    const parent: LocationNode | undefined = nodes.find((n) => n.id === parentId);
    if (!parent) break;
    push(parent.name, tailBase + step);
    cursor = parent;
  }

  // ② 的规范名是 depth 0 却在数组尾部。地点分按 depth 衰减，链有序才便于阅读与
  // 断言；稳定排序保证同深度内「路径原文 → 规范名」的先后不变。
  return links.sort((a, b) => a.depth - b.depth);
}

// ═══════════════════════════════════════════════════════════
// 多维度累计打分
// ═══════════════════════════════════════════════════════════

/**
 * 各维度权重。
 *
 * **这是一组起始值，不是真理** —— 什么时候该让战斗曲盖过地点曲、人物主题该
 * 多强势，是配乐口味问题，调这里就行（也可以按次传 `opts.weights` 覆盖）。
 *
 * 当前取值下的相对强弱（地点分随深度衰减 `LOCATION_DEPTH_DECAY ** depth`）:
 *
 * | 对比 | 结果 |
 * |------|------|
 * | 地点 depth 0 (1.00) vs 情境 (0.75) | 站在有专属曲的地点上，地点曲赢 |
 * | 地点 depth 2 (0.64) vs 情境 (0.75) | 只能回退两级时，战斗/潜行曲接管 |
 * | 地点 depth 3 (0.51) vs 人物 (0.55) | 地点已经很泛，在场角色的主题曲接管 |
 * | 情绪 (0.35) | 独木难支，是用来在同分里挑边的 |
 */
export const SCENE_TAG_WEIGHTS: Readonly<Record<AudioTagType | 'variant', number>> = {
  location: 1,
  situation: 0.75,
  character: 0.55,
  mood: 0.35,
  variant: 0.2,
};

/**
 * 地点分的逐级衰减底数。`分 = 相似度 × 底数 ** 回退深度`。
 *
 * 为什么是衰减而不是短路: 累计打分要让各维度可比，一旦短路就没法把
 * 「地点很泛但人物很准」这种情况算出来。想要严格短路的调用方走
 * `resolveSceneAudio`（见上），两条路径刻意并存、各自命名。
 */
export const LOCATION_DEPTH_DECAY = 0.8;

export interface SceneTagQuery {
  /** 位置路径（七段连字符或单段地名皆可） */
  location?: string;
  /** 在场角色名 */
  characters?: readonly string[];
  /** 情绪/氛围词 */
  moods?: readonly string[];
  /** 情境词（探索/战斗/潜行/仪式…） */
  situations?: readonly string[];
  /** 氛围变体；作为**加分项**参与累计，不再是并列排序键 */
  variant?: SceneVariant;
  kind?: AudioTrackKind;
}

export type SceneScoreBreakdown = Record<AudioTagType | 'variant', number>;

export interface SceneTagResult {
  track: AudioTrack;
  /** 各维度加权分之和 */
  score: number;
  /** 逐维度得分，便于排查"为什么选了这首" */
  breakdown: SceneScoreBreakdown;
  /** 地点维命中的地点名与回退深度；地点维没命中时为 null */
  resolvedLocation: string | null;
  fallbackDepth: number | null;
  /** 各维度命中的标签值 */
  matchedTags: string[];
}

interface DimensionHit {
  score: number;
  matched: string;
}

/** 一组查询词对一组标签值的最佳相似度。多查询词取 **max** 而不是求和 */
function bestMatch(queries: readonly string[], values: readonly string[]): DimensionHit | null {
  let best = 0;
  let matched = '';
  for (const q of queries) {
    for (const v of values) {
      const s = nameSimilarity(q, v);
      if (s > best) {
        best = s;
        matched = v;
      }
    }
  }
  return best >= SCENE_MATCH_THRESHOLD ? { score: best, matched } : null;
}

/** 地点维: 沿回退链取「相似度 × 衰减」最高的一环 */
function scoreLocation(
  chain: readonly SceneChainLink[],
  values: readonly string[],
): (DimensionHit & { link: SceneChainLink }) | null {
  let best: (DimensionHit & { link: SceneChainLink }) | null = null;
  for (const link of chain) {
    for (const v of values) {
      const raw = nameSimilarity(link.name, v);
      if (raw < SCENE_MATCH_THRESHOLD) continue;
      const decayed = raw * LOCATION_DEPTH_DECAY ** link.depth;
      if (!best || decayed > best.score) best = { score: decayed, matched: v, link };
    }
  }
  return best;
}

interface ScoredTrack extends SceneTagResult {
  grouped: GroupedTags;
}

/**
 * 按多维度标签累计打分选曲。
 *
 * 与 `resolveSceneAudio` 的分工：
 * - `resolveSceneAudio` —— **只看地点**，逐级短路，本级有曲就定下来。地点是
 *   唯一依据时它更可预测。
 * - 本函数 —— **多维度加权累计**。地点分随回退深度衰减，于是「地点已经泛到
 *   势力一级，但在场角色有专属主题」这种情况能被算出来。
 *
 * 判定命中的门槛是**至少一个维度的原始相似度达标**（`SCENE_MATCH_THRESHOLD`），
 * 而不是看加权总分——总分是用来排序的，拿它当门槛会让权重低的维度天然出局。
 *
 * `missing`（文件已移除）的曲目直接排除；全不命中返回 null，由调用方决定
 * 保持当前 BGM 还是停止。
 */
export function resolveSceneByTags(
  tracks: readonly AudioTrack[],
  query: SceneTagQuery,
  opts: {
    nodes?: readonly LocationNode[];
    weights?: Partial<Record<AudioTagType | 'variant', number>>;
  } = {},
): SceneTagResult | null {
  const kind: AudioTrackKind = query.kind ?? 'music';
  const nodes = opts.nodes ?? DEFAULT_LOCATIONS;
  const w = { ...SCENE_TAG_WEIGHTS, ...opts.weights };

  const chain = query.location ? buildLocationChain(query.location, nodes) : [];
  const characters = query.characters ?? [];
  const moods = query.moods ?? [];
  const situations = query.situations ?? [];
  const variantWords = query.variant ? VARIANT_ALIASES[query.variant] : [];

  const scored: ScoredTrack[] = [];

  for (const track of tracks) {
    if (track.kind !== kind || track.missing) continue;
    const grouped = groupTrackTags(track.tags);

    const breakdown: SceneScoreBreakdown = {
      location: 0,
      character: 0,
      mood: 0,
      situation: 0,
      variant: 0,
    };
    const matchedTags: string[] = [];
    let anyDimensionMet = false;
    let resolvedLocation: string | null = null;
    let fallbackDepth: number | null = null;

    // 地点维: 曲名也算一个可比对的值（曲名常常就是地点名）
    if (chain.length > 0) {
      const values = [...tagValuesFor(grouped, 'location'), track.name];
      const hit = scoreLocation(chain, values);
      if (hit) {
        anyDimensionMet = true;
        breakdown.location = w.location * hit.score;
        matchedTags.push(hit.matched);
        resolvedLocation = hit.link.name;
        fallbackDepth = hit.link.depth;
      }
    }

    const dims: Array<[Exclude<AudioTagType, 'location'>, readonly string[]]> = [
      ['character', characters],
      ['situation', situations],
      ['mood', moods],
    ];
    for (const [dim, queries] of dims) {
      if (queries.length === 0) continue;
      const hit = bestMatch(queries, tagValuesFor(grouped, dim));
      if (!hit) continue;
      anyDimensionMet = true;
      breakdown[dim] = w[dim] * hit.score;
      matchedTags.push(hit.matched);
    }

    // 变体是加分项：它自己不足以让一首曲子入选
    if (variantWords.length > 0) {
      const pool = [...grouped.mood, ...grouped.situation, ...grouped.untyped];
      if (pool.some((v) => variantWords.includes(normalizeAudioName(v)))) {
        breakdown.variant = w.variant;
      }
    }

    if (!anyDimensionMet) continue;
    const score =
      breakdown.location +
      breakdown.character +
      breakdown.mood +
      breakdown.situation +
      breakdown.variant;
    scored.push({ track, score, breakdown, resolvedLocation, fallbackDepth, matchedTags, grouped });
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.track.createdAt !== b.track.createdAt) return a.track.createdAt - b.track.createdAt;
    return a.track.id < b.track.id ? -1 : a.track.id > b.track.id ? 1 : 0;
  });

  const { grouped: _grouped, ...result } = scored[0];
  return result;
}
