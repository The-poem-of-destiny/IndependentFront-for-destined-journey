/**
 * asset-import-plan.ts — 导入计划器 (Asset System v1)
 *
 * 为什么存在: 这是整个素材子系统的**承重模块**（D15）。一次导入的全部决策 ——
 * 路由、媒体规则、命名不变式、碰撞编号、哈希去重、清单元数据合并 —— 全部收在
 * 一个**纯同步函数**里，于是每一条规则都变成对普通数据的断言：没有 IndexedDB、
 * 没有 fflate、循环里没有 `crypto`。store 拿到计划之后只做一件蠢事：照单写行。
 *
 * 哈希在**上游**算（D18）: `crypto.subtle.digest` 是异步的，而本模块是纯同步的，
 * 所以条目进来时 `hash` 已经算好。把哈希塞进这里，签名就是在撒谎 —— 第一个想
 * 加哈希的人只能把整个计划器改成 async。
 *
 * 上限也不在这里（§5.1）: 计划器拿到的是**已经解压完**的字节，无从中途终止，
 * 上限放这儿等于炸弹已经把内存填满了才有人检查。所以体积上限住在
 * `asset-zip.ts` 的流式回调里；`PlannedSkip.reason` 保留 `'oversize'` 是为了
 * 让摘要口径统一，本模块**永不产出**它。
 *
 * 同理 `'suspect-filename-encoding'` 告警也**永不由本模块产出**: 判定要看
 * latin1 高位字节串，那是解码层的信息（asset-zip.ts）。联合成员留在这里，
 * 是为了让 store 能把两侧告警并进同一个数组。
 *
 * 形状归属: `DecodedEntry` / `ExistingRows` / `Planned*` / `ImportPlan` /
 * `ImportManifest` 都是**过程形状，不是落库实体**，本地声明本地导出 —— 与
 * asset-filename.ts 自持 `ParsedAssetName`、asset-index.ts 自持 `AssetIndex`
 * 同一个规矩；它们不进 types.ts。
 *
 * ⚠️ `DecodedEntry` 必须**声明在引擎侧**，由 `src/ui/lib/asset-zip.ts` 反向
 * import —— 引擎禁止 import `src/ui/`，所以生产者只能 import 消费者的契约。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无 crypto、无浏览器全局。
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md §5 / §6.1
 */

import { explainAssetFilename } from './asset-filename';
import { clampAssetFraming, mimeForAssetExtension } from './asset-types';
import { AUDIO_MIME_BY_EXTENSION, normalizeAudioName, uniqueAudioName } from './audio-names';
import type { AssetFraming, AssetMetaRecord, AssetType, AudioTrack } from './types';

// ═══════════════════════════════════════════════════════════
// 输入形状
// ═══════════════════════════════════════════════════════════

/**
 * 解码后的单个条目 —— 计划器的输入（§6.1）。
 *
 * `path` 允许带目录（`assets/苏婉_头像.png`），本模块一律**拍平成 basename**
 * 再判断: 拖 40 个文件的包与带 `assets/`+`audio/` 子目录的包必须表现一致
 * （§5.1）。没有文件系统要落地，所以嵌套路径需要的是拍平而不是拒绝。
 * asset-zip.ts 已经拍平过一次，这里再拍是幂等空操作。
 */
export interface DecodedEntry {
  path: string;
  bytes: Uint8Array;
  /** sha-256 hex；`crypto.subtle` 不可用时缺省 → 该条**完全跳过去重**（§4.4） */
  hash?: string;
}

/**
 * 库里已有的行 —— 去重与碰撞编号的比对基准。
 *
 * 刻意只要 `Pick`: 计划器不需要 createdAt/bytes/mime，多要一个字段就多一处
 * 让调用方以为"计划器会看它"的误解。
 */
export interface ExistingRows {
  assets: Pick<AssetMetaRecord, 'id' | 'name' | 'type' | 'variant' | 'hash'>[];
  audio: (Pick<AudioTrack, 'id' | 'name' | 'source'> & { hash?: string })[];
}

/** 清单里单条的元数据 —— **只能追加**文件名承载不了的东西（D10 / §5.2） */
export interface ImportManifestMeta {
  tags?: string[];
  credit?: string;
  license?: string;
  /**
   * 取景（{@link AssetFraming}）。素材专用；音频半边读到也无处可落，静默忽略。
   *
   * 为什么它属于清单而 D10 依然成立: D10 护住的是**身份** —— 名字与类型只能来自
   * 文件名，清单永远不能改它们。取景是**显示元数据**，和 `credit` / `license`
   * 一样是文件名承载不了、又不改变"这是谁的哪一类图"的东西。不带它，一次
   * 导出→导入就把用户逐张调过的构图全部抹回默认值。
   *
   * 🔴 读侧一律先过 `clampAssetFraming`: 清单是**外来 JSON**，NaN / 越界 /
   * 字符串 / 数组都可能出现在这里，而一个 NaN 落库之后每次渲染都会让整条
   * `object-position` 失效。
   */
  framing?: AssetFraming;
}

/**
 * `manifest.json` 的形状 —— 两个按 **basename** 索引的字典。
 *
 * 两个分区都可缺省，缺省即"这半边没有元数据"。畸形值一律降级成"没有元数据"，
 * **绝不抛异常** —— 一个手写坏了的清单不该让整包导入失败。
 *
 * 🔴 它**永远不能改名或改类型**（§5.2）: 本模块只读 `tags`/`credit`/`license`/
 * `framing` 四个字段，清单里出现 `name`/`type` 会被静默忽略。身份的唯一来源是
 * 文件名 —— 清单只补**显示元数据**，从不参与身份。
 */
export interface ImportManifest {
  assets?: Record<string, ImportManifestMeta>;
  audio?: Record<string, ImportManifestMeta>;
}

// ═══════════════════════════════════════════════════════════
// 输出形状
// ═══════════════════════════════════════════════════════════

/** 计划落成一行素材 */
export interface PlannedAsset {
  kind: 'asset';
  entry: DecodedEntry;
  /** 原始字符串，`===` 匹配，不做任何归一化（D2） */
  name: string;
  type: AssetType;
  /** **编号之后的终值**；无变体时缺省 */
  variant?: string;
  ext: string;
  mime: string;
  credit?: string;
  license?: string;
  /**
   * 清单带来的取景，**已经夹逼过**（见 {@link ImportManifestMeta.framing}）。
   *
   * 只出现在**新落的行**上: 被哈希判成重复的条目在这之前就 `continue` 掉了，
   * 于是清单永远碰不到一条既有行的取景 —— 那条行可能是用户自己一格一格调出来的。
   */
  framing?: AssetFraming;
  /**
   * 分配前的变体 —— 只在**真的被改号**时出现，供摘要说明"它被挪到哪去了"。
   *
   * 原本无变体（从 base 位被挤走）时值为 **空串 `''`**。空串刻意用来表示
   * "本来没有变体"，与"没被改号"的 `undefined` 区分开 —— 一个字段只表达
   * 一件事：这行被改号了，且这是它原来的样子。
   */
  renumberedFrom?: string;
}

/** 计划落成一条音轨 */
export interface PlannedAudio {
  kind: 'audio';
  entry: DecodedEntry;
  /** 已过 `uniqueAudioName` 的终值（不含扩展名，同 audio-store 的上传口径） */
  name: string;
  mime: string;
  tags: string[];
  credit?: string;
  license?: string;
  renamedFrom?: string;
}

/**
 * 跳过的条目及理由。
 *
 * `'oversize'` 由 asset-zip.ts 的流式上限负责，本模块永不产出（§5.1）。
 */
export interface PlannedSkip {
  kind: 'skip';
  /** 拍平后的 basename；拍平后为空（纯目录条目）时退回原始 path */
  path: string;
  reason:
    | 'duplicate' //           哈希在作用域内命中（§4.4）
    | 'unknown-extension' //   两张路由表都不认（§5.1）
    | 'noise' //               __MACOSX / dotfile / 目录条目
    | 'mp4-on-立绘' //         媒体规则（D7）
    | 'naming-invariant' //    name 或 variant 里有类型 token（D16）
    | 'oversize'; //           单条体积上限（本模块不产出）
}

/**
 * 导入告警。
 *
 * - `hash-unavailable` 有条目没带哈希 → 那些条目**完全跳过去重**，退化到编号
 *   路径。绝不换第二种哈希算法（§4.4：诚实降级胜过静默换算法）。
 * - `suspect-filename-encoding` **由 asset-zip.ts 产出**，本模块永不产出。
 * - `suspect-missing-type` 疑似漏写类型 token（§2 / §12 的幻影角色组风险）。
 *   纯建议，不阻塞，**绝不自动纠正** —— 名字里带下划线是合法的（`圣殿_内庭`）。
 */
export type ImportWarning =
  'hash-unavailable' | 'suspect-filename-encoding' | 'suspect-missing-type';

export interface ImportPlan {
  assets: PlannedAsset[];
  audio: PlannedAudio[];
  skips: PlannedSkip[];
  warnings: ImportWarning[];
  summary: {
    assetsAdded: number;
    audioAdded: number;
    duplicatesSkipped: number;
    /**
     * 被自动改号的条数 —— **素材改号 + 音频改名之和**。
     *
     * 一个导入器只对用户播报一行摘要（§7.2 的 `编号 2`），所以这个计数覆盖
     * 两半边；两半边各自的明细在 `renumberedFrom` / `renamedFrom` 上。
     */
    renumbered: number;
    namingConflicts: number;
    noise: number;
  };
}

// ═══════════════════════════════════════════════════════════
// 路径与噪音
// ═══════════════════════════════════════════════════════════

/** 斜杠归一化: 部分 Windows 工具会写反斜杠分隔符 */
function normalizeSlashes(path: string): string {
  return (path ?? '').replace(/\\/g, '/');
}

/** 取 basename（拍平嵌套目录）；纯路径返回空串 */
function basenameOf(path: string): string {
  const norm = normalizeSlashes(path);
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
}

/** 小写扩展名（不含点）；无真尾缀返回空串（`dot > 0` 排除 `.png` 这种整串扩展名） */
function extensionOf(basename: string): string {
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot + 1).toLowerCase() : '';
}

/**
 * 可静默忽略的噪音（§5.1，与 asset-zip.ts:225 的 `isNoiseEntry` 同口径）:
 * 目录条目（尾斜杠）/ `__MACOSX` 任一路径段 / dotfile（含 AppleDouble `._x`）。
 *
 * 判定同时要**完整 path**（`__MACOSX` 是目录段）与 **basename**（dotfile 是
 * 文件名特征），所以拿原始 path 而不是拍平后的名字。
 *
 * dotfile 只看 basename: `.hidden/苏婉_头像.png` 会被导入 —— 目录名拍平之后
 * 已经没有意义，拿它当理由丢掉一个正常媒体文件才是真的数据损失。`__MACOSX`
 * 是唯一例外，那整棵树里没有一个字节是用户想要的。
 */
function isNoisePath(path: string): boolean {
  const norm = normalizeSlashes(path);
  if (norm === '' || norm.endsWith('/')) return true;
  const segments = norm.split('/');
  if (segments.some((seg) => seg.toLowerCase() === '__macosx')) return true;
  const base = segments[segments.length - 1];
  if (!base) return true;
  return base.startsWith('.');
}

/** 去掉真尾缀（同 audio-store 上传路径的 `stripExt`，音轨名不带扩展名） */
function stripExtension(basename: string): string {
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(0, dot) : basename;
}

// ═══════════════════════════════════════════════════════════
// 清单读取 —— 只读三个字段，其余静默忽略
// ═══════════════════════════════════════════════════════════

/**
 * 从清单里取一条元数据。
 *
 * 防御式逐字段读取，这既是"畸形不抛"的实现，也是"清单不能改名改类型"的实现
 * （§5.2）: `name` / `type` 之类的键根本没有被读的机会。
 */
function readManifestMeta(
  section: Record<string, ImportManifestMeta> | undefined,
  basename: string,
): ImportManifestMeta {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return {};
  if (!Object.prototype.hasOwnProperty.call(section, basename)) return {};
  const raw: unknown = (section as Record<string, unknown>)[basename];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const meta: ImportManifestMeta = {};
  if (Array.isArray(src.tags)) {
    const tags = src.tags.filter((t): t is string => typeof t === 'string');
    if (tags.length) meta.tags = tags;
  }
  if (typeof src.credit === 'string') meta.credit = src.credit;
  if (typeof src.license === 'string') meta.license = src.license;
  // 取景: **先判是不是个对象，再夹逼**。两步缺一不可 —— `clampAssetFraming`
  // 对任何垃圾都会交出一个合法值，所以单靠它，`"framing": "居中"` 这种写法会被
  // 悄悄翻译成默认取景并落库；而"清单里根本没写取景"与"清单写了个默认取景"
  // 在下游是同一件事，多写一行毫无意义的字段只会让人以为清单说了什么。
  if (typeof src.framing === 'object' && src.framing !== null && !Array.isArray(src.framing)) {
    meta.framing = clampAssetFraming(src.framing);
  }
  return meta;
}

// ═══════════════════════════════════════════════════════════
// 变体位分配 (§5.3 / D11) —— 永不覆盖任何东西
// ═══════════════════════════════════════════════════════════

/**
 * 无变体位（base 位）的哨兵键。
 *
 * 用 U+0000 前缀而不是空串: 变体是**任意用户字符串**，空串虽然被 asset-filename
 * 归一成"无变体"，但哨兵与真实变体共用一个 Set 时必须绝无可能撞键。
 */
const BASE_SLOT = '\u0000base';

/** 纯整数变体 —— base 位被挤走时分配的形态（裸整数，`2`） */
const NUMERIC_VARIANT_RE = /^\d+$/;

/** `<茎> <整数>` —— 已带编号尾缀的变体，改号时在原尾缀上换号而不是再套一层 */
const SUFFIXED_VARIANT_RE = /^(.*\S)\s+(\d+)$/;

function variantSlotKey(variant?: string): string {
  return variant === undefined || variant === '' ? BASE_SLOT : variant;
}

/** 某个 `(name, type)` 下已被占用的变体位 */
type SlotSet = Set<string>;

function groupKey(name: string, type: AssetType): string {
  // JSON.stringify 而非拼接: 名字是任意用户字符串，任何分隔符都可能出现在里面
  return JSON.stringify([name, type]);
}

/**
 * 数字家族的下一个号 = `max(已占数字变体, base 占用则记 1) + 1`。
 *
 * **max+1 而不是首个空位**（§5.3）: 确定、单调、中间行被删也稳定。首个空位会
 * 把 `_2` 回收到一个用户可能记成别的东西的位上。base 位隐含算作 1 号，所以
 * base 被占、无数字变体时首次分配得到 `2`。
 */
function nextNumericVariant(slots: SlotSet): number {
  let max = slots.has(BASE_SLOT) ? 1 : 0;
  for (const key of slots) {
    if (!NUMERIC_VARIANT_RE.test(key)) continue;
    const n = Number.parseInt(key, 10);
    if (n > max) max = n;
  }
  return max + 1;
}

/**
 * 具名家族的下一个号 = `max(茎本身占用则记 1, 已占 "茎 n" 的 n) + 1`。
 *
 * 与数字家族同一条 max+1 策略 —— 分配器**只有一套政策**。设计文档只对 base
 * 那一行明写了 "not first-free"，具名尾缀那两行只给了结果（`微笑` → `微笑 2`，
 * `微笑 2` → `微笑 3`），两者在 max+1 下都成立，而拆成两套政策正是这份设计
 * 一直在防的漂移。
 */
function nextSuffixedVariant(slots: SlotSet, stem: string): number {
  let max = 0;
  const prefix = `${stem} `;
  for (const key of slots) {
    if (key === stem) {
      if (max < 1) max = 1;
      continue;
    }
    if (!key.startsWith(prefix)) continue;
    const tail = key.slice(prefix.length);
    if (!NUMERIC_VARIANT_RE.test(tail)) continue;
    const n = Number.parseInt(tail, 10);
    if (n > max) max = n;
  }
  return max + 1;
}

/**
 * 给一行分配终态变体位。
 *
 * 三条规则（§5.3）:
 * - base 位被占 → 号进变体位（`苏婉_头像_2.png`），**绝不追加到名字上**
 *   （`苏婉 (2)_头像.png` 会解析成名字 `苏婉 (2)`，在 D2 下永远匹配不到角色）
 * - 已有变体被占 → 在变体里追加（`微笑` → `微笑 2`）
 * - 已带号的变体被占 → **换号，绝不嵌套**（`微笑 2` → `微笑 3`，不是 `微笑 2 2`）
 *
 * 用户手写的数字变体与自动分配的**不可区分，且这是接受的** —— 两者都表示
 * "另一张"，max+1 在哪种情况下都对。
 */
function allocateVariant(
  slots: SlotSet,
  desired: string | undefined,
): { variant?: string; renumberedFrom?: string } {
  if (desired === undefined || desired === '') {
    if (!slots.has(BASE_SLOT)) return {};
    // 从 base 位被挤走 —— renumberedFrom 用空串表示"本来没有变体"
    return { variant: String(nextNumericVariant(slots)), renumberedFrom: '' };
  }

  if (!slots.has(desired)) return { variant: desired };

  // 数字家族: 裸整数（含带空白的 ` 2`）都归这里，分配裸整数
  if (NUMERIC_VARIANT_RE.test(desired.trim())) {
    return { variant: String(nextNumericVariant(slots)), renumberedFrom: desired };
  }

  // 具名家族: 剥掉已有的 ` n` 尾缀拿到茎，然后换号
  const matched = SUFFIXED_VARIANT_RE.exec(desired);
  const stem = matched ? matched[1] : desired;
  return {
    variant: `${stem} ${nextSuffixedVariant(slots, stem)}`,
    renumberedFrom: desired,
  };
}

/**
 * 分配器的**非文件名入口** —— 给导入以外的调用方（改名、设为主图）用。
 *
 * 为什么要有它: 编号策略必须只有一套（max+1 / 换号不嵌套 / 单空格加整数），
 * 于是调用方本来只能把目标行格式化成文件名再喂给 `planImport` 反推 —— 而**文件名
 * 是有损载体**: `basenameOf` 会在最后一个分隔符处拍平，于是名字里带 `/` 或 `\`
 * 的行会被算到**另一个 `(name, type)` 组**上，两行都判成"base 位空着"，D11
 * "永不覆盖 / 一个组只有一个基图"当场破功；名字以 `.` 开头还会被判成 dotfile 噪音。
 *
 * 所以这里把**槽位计算**直接暴露出来，绕开文件名这层编码。它与 `planImport`
 * 内部共用同一个 {@link allocateVariant} 核心 —— 一套政策，两个入口。
 *
 * 差别只在工作集来源: `planImport` 维护一个随计划增长的增量工作集（整批分配，
 * 同一个 zip 里两条撞车的条目拿 `_2` 和 `_3`），本函数则按传进来的行现算。
 *
 * ⚠️ 本函数**只管槽位**: 命名不变式（D16）、媒体规则（D7）、以及名字能不能进
 * zip 条目名（D19）都由调用方自己把关 —— 那些是"这一行合不合法"，不是"它该占哪个位"。
 *
 * @param name 原始名字，`===` 比对，不归一化（D2）
 * @param desiredVariant 期望变体；`undefined` / `''` 表示想占 base 位
 * @param existing 比对基准（整库即可，本函数自己筛 `(name, type)`）
 */
export function allocateVariantSlot(
  name: string,
  type: AssetType,
  desiredVariant: string | undefined,
  existing: readonly Pick<AssetMetaRecord, 'name' | 'type' | 'variant'>[],
): { variant?: string; renumberedFrom?: string } {
  const slots: SlotSet = new Set<string>();
  for (const row of existing) {
    if (row.name !== name || row.type !== type) continue;
    slots.add(variantSlotKey(row.variant));
  }
  return allocateVariant(slots, desiredVariant);
}

// ═══════════════════════════════════════════════════════════
// 计划
// ═══════════════════════════════════════════════════════════

/**
 * 往「键 → 已占哈希集」里记一笔。
 *
 * 一个键可以记多个哈希（同名不同字节的行共存），一个哈希也可以记在多个键下
 * （音频改名时 desired 与终名两处都要能查到，见下方调用点的说明）。
 */
function rememberHash(map: Map<string, Set<string>>, key: string, hash: string): void {
  let hashes = map.get(key);
  if (hashes === undefined) {
    hashes = new Set<string>();
    map.set(key, hashes);
  }
  hashes.add(hash);
}

/** 告警的固定输出顺序 —— 计划必须逐字节确定，所以不能让 Set 的插入序漏出去 */
const WARNING_ORDER: readonly ImportWarning[] = [
  'hash-unavailable',
  'suspect-filename-encoding',
  'suspect-missing-type',
];

/**
 * 把一批已解码、已哈希的条目变成一份导入计划。
 *
 * **纯同步、无副作用**: 不写 Dexie、不碰字节存储、不算哈希。对固定输入，输出
 * 完全有序且每次一致 —— 这正是它可以被当数据断言的原因（§6.1）。
 *
 * 编号是**整批分配的，不是逐条的**（§6.1）: 同一个 zip 里两条撞车的条目拿到
 * `_2` 和 `_3`，绝不会都拿 `_2`。实现方式是工作集随计划增长，已计划的行与
 * 库里的行占位等价。
 */
export function planImport(
  entries: readonly DecodedEntry[],
  existing: ExistingRows,
  manifest?: ImportManifest,
): ImportPlan {
  const assets: PlannedAsset[] = [];
  const audio: PlannedAudio[] = [];
  const skips: PlannedSkip[] = [];
  const warnings = new Set<ImportWarning>();

  // ── 素材工作集: (name,type) → 已占变体位 / 已占哈希 ──
  const assetSlots = new Map<string, SlotSet>();
  const assetHashes = new Map<string, Set<string>>();
  /** 已知素材名（含库里的与本批新增的）—— 供漏写类型 token 的启发式复查 */
  const knownAssetNames = new Set<string>();

  for (const row of existing.assets ?? []) {
    const key = groupKey(row.name, row.type);
    let slots = assetSlots.get(key);
    if (slots === undefined) {
      slots = new Set<string>();
      assetSlots.set(key, slots);
    }
    slots.add(variantSlotKey(row.variant));
    if (row.hash !== undefined && row.hash !== '') rememberHash(assetHashes, key, row.hash);
    knownAssetNames.add(row.name);
  }

  // ── 音频工作集: 名字池（给 uniqueAudioName）+ 规范名 → 已占哈希 ──
  const audioPool: { id: string; name: string }[] = (existing.audio ?? []).map((row) => ({
    id: row.id,
    name: row.name,
  }));
  const audioHashes = new Map<string, Set<string>>();
  for (const row of existing.audio ?? []) {
    if (row.hash === undefined || row.hash === '') continue;
    rememberHash(audioHashes, normalizeAudioName(row.name), row.hash);
  }

  let plannedAudioSeq = 0;

  for (const entry of entries ?? []) {
    const rawPath = entry?.path ?? '';
    const basename = basenameOf(rawPath);

    // ── 噪音: 目录条目 / __MACOSX / dotfile（§5.1）──
    if (isNoisePath(rawPath)) {
      skips.push({ kind: 'skip', path: basename || rawPath, reason: 'noise' });
      continue;
    }

    // ── 路由: 按扩展名，判在拍平后的 basename 上（§5.1）──
    // 音频表先查（D8: `webm` 已被 `audio/webm` 占用，改判是回退）。两张表
    // 都从引擎层唯一来源 import，本模块不复制任何一份路由表。
    const ext = extensionOf(basename);
    const audioMime = AUDIO_MIME_BY_EXTENSION[ext];

    if (audioMime !== undefined) {
      // ══ 音频 ══
      if (entry.hash === undefined || entry.hash === '') warnings.add('hash-unavailable');

      const desired = stripExtension(basename);
      const normalized = normalizeAudioName(desired);

      // 去重: 同规范名下哈希命中即跳（§4.4）。没哈希则**完全跳过去重**，
      // 直落编号路径 —— 绝不换第二种哈希空间。
      if (entry.hash !== undefined && entry.hash !== '') {
        if (audioHashes.get(normalized)?.has(entry.hash)) {
          skips.push({ kind: 'skip', path: basename, reason: 'duplicate' });
          continue;
        }
      }

      // 非同一字节的撞名照 `uniqueAudioName` 出厂设置走 —— D12 对音频唯一的
      // 改动就是上面那次哈希去重，编号规则一个字没动。
      const name = uniqueAudioName(audioPool, desired);
      const meta = readManifestMeta(manifest?.audio, basename);

      const planned: PlannedAudio = {
        kind: 'audio',
        entry,
        name,
        mime: audioMime,
        tags: meta.tags ?? [],
      };
      if (meta.credit !== undefined) planned.credit = meta.credit;
      if (meta.license !== undefined) planned.license = meta.license;
      if (name !== desired) planned.renamedFrom = desired;
      audio.push(planned);

      // 占位: 名字池与哈希集都随计划增长，于是整批分配成立
      plannedAudioSeq += 1;
      audioPool.push({ id: `\u0000planned:${plannedAudioSeq}`, name });
      if (entry.hash !== undefined && entry.hash !== '') {
        // 🔴 **两个键都要记**，而且两个都在防真事，不是图省事各记一份:
        //
        // - **desired**（改名前）: 库里已有一条**无哈希**的 `song` 时，本批第一个
        //   `song.mp3` 会被改名成 `song (2)`。若只记终名，第二个**字节相同**的
        //   `song.mp3` 去 `song` 底下查什么也查不到，于是落成 `song (3)` ——
        //   两份一模一样的字节落成两行，正是 D12 要防的半幂等。后来者请求的是
        //   同一个名字、同一份字节，那它就是重复，与先来者被改成什么无关。
        // - **终名**（改名后）: 本批里 `song.mp3` 变成 `song (2)` 之后，再来一个
        //   字节相同的 `song (2).mp3`，它请求的正是那一行 —— 同样是重复。
        //
        // 不会误杀: 命中要求**哈希也相等**，而「同名 + 同字节 = 重复」就是 D12 的
        // 定义本身。没改名时两个键相等，退化成一次 Set 写入。
        rememberHash(audioHashes, normalized, entry.hash);
        rememberHash(audioHashes, normalizeAudioName(name), entry.hash);
      }
      continue;
    }

    const assetMime = mimeForAssetExtension(ext);
    if (assetMime === undefined) {
      skips.push({ kind: 'skip', path: basename, reason: 'unknown-extension' });
      continue;
    }

    // ══ 素材 ══
    // 解析、命名不变式（D16）、媒体规则（D7）全归 explainAssetFilename ——
    // 它给出带理由的结论，理由名与 PlannedSkip.reason 对齐，直接透传。
    const parsed = explainAssetFilename(basename);
    if (!parsed.ok) {
      skips.push({ kind: 'skip', path: basename, reason: parsed.reason });
      continue;
    }
    const { name, type, variant: desiredVariant } = parsed.parsed;

    if (entry.hash === undefined || entry.hash === '') warnings.add('hash-unavailable');

    const key = groupKey(name, type);

    // 去重作用域是 `(name, type)`（§4.4）: 全局按哈希会让同一张占位图第一次
    // 成功、之后 29 次静默跳过。没哈希则完全跳过去重，落编号路径。
    if (entry.hash !== undefined && entry.hash !== '') {
      if (assetHashes.get(key)?.has(entry.hash)) {
        skips.push({ kind: 'skip', path: basename, reason: 'duplicate' });
        continue;
      }
    }

    let slots = assetSlots.get(key);
    if (slots === undefined) {
      slots = new Set<string>();
      assetSlots.set(key, slots);
    }

    const allocated = allocateVariant(slots, desiredVariant);
    const meta = readManifestMeta(manifest?.assets, basename);

    const planned: PlannedAsset = {
      kind: 'asset',
      entry,
      name,
      type,
      ext: parsed.parsed.ext,
      mime: assetMime,
    };
    if (allocated.variant !== undefined) planned.variant = allocated.variant;
    // 清单的 tags 对素材无处可落（AssetMetaRecord 无 tags 列，§4.1），静默忽略
    if (meta.credit !== undefined) planned.credit = meta.credit;
    if (meta.license !== undefined) planned.license = meta.license;
    if (meta.framing !== undefined) planned.framing = meta.framing;
    if (allocated.renumberedFrom !== undefined) planned.renumberedFrom = allocated.renumberedFrom;
    assets.push(planned);

    // 占位: 变体位与哈希集都随计划增长（整批分配）
    slots.add(variantSlotKey(allocated.variant));
    // ✅ 素材侧**没有**音频那个坑: 去重键是 `(name, type)`，编号只动 variant，
    // 而 variant 不在键里 —— 查与记用的是同一个 `key` 变量，分配前后不变。
    if (entry.hash !== undefined && entry.hash !== '') rememberHash(assetHashes, key, entry.hash);
    knownAssetNames.add(name);
  }

  // ── 漏写类型 token 的启发式（§2 / §12）──
  // 复查放在**全批规划完之后**，于是结论与 zip 内条目顺序无关: 一个包里同时有
  // `苏婉_头像.png` 与 `苏婉_微笑.png` 时，谁先出现都会告警。
  // 纯建议、不阻塞、绝不自动纠正 —— `圣殿_内庭` 是合法名字，无从区分。
  for (const planned of assets) {
    const cut = planned.name.lastIndexOf('_');
    if (cut <= 0) continue;
    if (knownAssetNames.has(planned.name.slice(0, cut))) {
      warnings.add('suspect-missing-type');
      break;
    }
  }

  let duplicatesSkipped = 0;
  let namingConflicts = 0;
  let noise = 0;
  for (const skip of skips) {
    if (skip.reason === 'duplicate') duplicatesSkipped += 1;
    else if (skip.reason === 'naming-invariant') namingConflicts += 1;
    else if (skip.reason === 'noise') noise += 1;
  }

  let renumbered = 0;
  for (const planned of assets) if (planned.renumberedFrom !== undefined) renumbered += 1;
  for (const planned of audio) if (planned.renamedFrom !== undefined) renumbered += 1;

  return {
    assets,
    audio,
    skips,
    warnings: WARNING_ORDER.filter((w) => warnings.has(w)),
    summary: {
      assetsAdded: assets.length,
      audioAdded: audio.length,
      duplicatesSkipped,
      renumbered,
      namingConflicts,
      noise,
    },
  };
}
