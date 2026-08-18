/**
 * remote-asset-catalogue.ts — 远程素材**声明**的纯函数解析层（远程素材 v1 / 波 1）
 *
 * 为什么存在: 远程素材的地址由**本地载体**声明，一共两种 ——
 * ①世界书条目正文里上游 `char-info-ejs-builder` 约定的那段 `profile` 字面量；
 * ②内容包新增的 `remoteAssets` 分节。两者形状完全不同，但下游要的东西是同一个：
 * 一串「谁 / 哪一类 / 哪个变体 / 从哪下」。本模块把两种载体各自归一成
 * {@link RemoteAssetDecl}，**到此为止** —— 下载、落库、镜像同步全在 UI 波，
 * 本层一个字节都不碰网络。
 *
 * 这条分工与 `asset-import-plan.ts` 是同一个规矩（那边是「zip 条目 → 导入计划」，
 * 这边是「本地声明 → 下载清单」）: 决策是纯同步函数，执行方只做一件蠢事。
 *
 * 🔴 **永不抛**。声明的两个来源都是第三方可编辑的数据（别人的世界书 / 别人的内容包），
 * 里头有一半东西是给上游那套 EJS 前端看的、我们根本不认。认不出的块跳过、认不出的
 * 行跳过，返回值永远是一个合法数组。一个写坏了的角色卡不该让另外十四个角色没有立绘。
 *
 * 🔴 **名字与变体走既有闸门，不另立一套**: `violatesNamingInvariant`（D16 类型 token）
 * 与 `violatesZipEntryName`（D19 zip 条目名可承载性）都从 `asset-filename.ts` 取。
 * 远程素材最终会落成**普通素材行**（同一张 assetMeta 表、同一套导出 zip），所以它必须
 * 从一开始就满足素材行的全部命名不变式 —— 在这里放进来一个 `圣殿/内庭`，症状会推迟到
 * 半年后某次「导出再导入之后少了几张图」。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无浏览器全局（含 `URL` —— http(s) 判定用正则，
 * 好让本模块在任何宿主里都是同一个答案）。
 */

import {
  DEFAULT_ASSET_TYPE,
  violatesNamingInvariant,
  violatesZipEntryName,
} from './asset-filename';
import { isAssetTypeToken } from './asset-types';
import type { AssetType, WorldBook } from './types';

// ═══════════════════════════════════════════════════════════
// 形状
// ═══════════════════════════════════════════════════════════

/**
 * 一条远程素材声明 —— 「谁 / 哪一类 / 哪个变体 / 从哪下」。
 *
 * **过程形状，不是落库实体**（照 `ParsedAssetName` / `PlannedAsset` 的先例本地声明本地
 * 导出，不进 types.ts）: 落库的那一行是 `AssetMetaRecord`，它带 `remote` 戳记录来源。
 *
 * `name` / `variant` 的口径与素材行**逐字相同**: 原始字符串、`===` 匹配、不做任何
 * 归一化（D2）。`variant` 缺省 = 基图位（不是空串，空串与缺省会变成两种等价形状）。
 */
export interface RemoteAssetDecl {
  /** 角色名，`===` 匹配素材行的 name（D2 不归一化） */
  name: string;
  type: AssetType;
  /** 缺省 = 基图位 */
  variant?: string;
  /** http/https 绝对地址 */
  url: string;
}

/** 内容包 `remoteAssets` 分节里的一行（宽松形状，解析器负责收窄） */
interface RawPackRow {
  name?: unknown;
  url?: unknown;
  type?: unknown;
  variant?: unknown;
}

// ═══════════════════════════════════════════════════════════
// 上游 builder 块的定位
// ═══════════════════════════════════════════════════════════

/**
 * 上游 `char-info-ejs-builder` 的块界标记。
 *
 * 🔴 **版本号是通配的**（`:v2` / `:v3` / 没有都吃）: 我们只从块里捞 URL，而上游改版号
 * 改的是它自己那套 `setLocalVar` 写法 —— 把版本钉死的唯一效果是「上游一升版，
 * 所有角色的立绘悄悄消失」。
 */
const BUILDER_MARKER_RE = /<%#\s*char-info-ejs-builder:(start|end)(?::v\d+)?\s*%>/g;

/** `const profile = ` 的声明头（`let` / `var` 一并吃，上游手改过的卡见过） */
const PROFILE_DECL_RE = /\b(?:const|let|var)\s+profile\s*=\s*/g;

/** http(s) 绝对地址 —— 不含空白。刻意不用 `URL`（浏览器/宿主全局，见文件头纯度约束） */
const HTTP_URL_RE = /^https?:\/\/[^\s]+$/i;

/**
 * 取出 `content` 里所有 builder 块的**块内正文**（不含标记本身）。
 *
 * 状态机而不是「一条正则配 start...end」: 正文里 EJS 噪音极多，贪婪/惰性两种量词都会
 * 在多块场景下切错边。开着的块没等到 end（作者删了半截）→ 整块丢弃，不猜边界。
 */
function findBuilderBlocks(content: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(BUILDER_MARKER_RE.source, 'g');
  let openAt = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match[1] === 'start') {
      // 嵌套/重复 start：以**最后一个**为准（前一个显然没写完）
      openAt = match.index + match[0].length;
    } else if (openAt >= 0) {
      blocks.push(content.slice(openAt, match.index));
      openAt = -1;
    }
  }
  return blocks;
}

/**
 * 从 `start` 处读一个**括号配平**的对象字面量，返回含首尾花括号的原文。
 *
 * 为什么不能只找下一个 `}`: `profile` 里嵌着 `gallery` 数组与对象，第一个 `}` 落在
 * gallery 项上。为什么要认字符串: 登场台词是作者自由书写的中文，里头出现 `}` 完全合法，
 * 而那一下会把字面量截断成不可解析的半截（然后整个角色静默没有图）。
 *
 * 只认引号不认注释: JSON 兼容的字面量里不该有注释，真有也只会让 `JSON.parse` 失败 ——
 * 那条路径已经是「跳过这一块」，不需要在这里多一套语法。
 */
function readBalancedObject(src: string, start: number): string | undefined {
  if (src[start] !== '{') return undefined;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return undefined;
}

/** 窄化: 值是不是普通对象（非 null / 非数组） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 是不是一个可下载的 http(s) 地址（data:/blob:/相对路径一律不是） */
function isHttpUrl(v: unknown): v is string {
  return typeof v === 'string' && HTTP_URL_RE.test(v.trim());
}

// ═══════════════════════════════════════════════════════════
// 变体位分配（本次抽取内去重）
// ═══════════════════════════════════════════════════════════

/** `(name, type)` → 本次抽取里已占用的变体位（基图位记作空串） */
type SlotMap = Map<string, Set<string>>;

function slotKey(name: string, type: AssetType): string {
  // JSON.stringify 而非拼接: 名字是任意用户字符串，任何分隔符都可能出现在里面
  return JSON.stringify([name, type]);
}

/**
 * 给一张 gallery 图定终态变体位。
 *
 * 编号方案（与设计一致）:
 * - 该角色**整份 gallery 拉平后的第一张** → 基图位（无变体）
 * - 一个 gallery 项的第一张 → 变体 = 该项标题 `T`
 * - 同项的后续源 → `T` + 序数（`主立绘2` / `主立绘3`）—— 一个项里的多个 source
 *   是**不同的图**，不是同一张的镜像
 * - 撞位（标题重名、或基图位已被前一份 profile 占了）→ 在 `T` 上继续加序数直到空位
 *
 * 撞位一律**让路而不是覆盖**，与 D11「一个组只有一个基图、永不覆盖」同一条政策。
 */
function allocateSlot(slots: Set<string>, label: string, desired: string): string {
  if (!slots.has(desired)) {
    slots.add(desired);
    return desired;
  }
  // 想要的位被占了 —— 先退到裸标题（`desired` 是基图位空串时最常走这一支），
  // 🔴 但空标题不能当退路: 那就是基图位本身，让一张后来的图占进去等于覆盖基图
  if (label !== '' && desired !== label && !slots.has(label)) {
    slots.add(label);
    return label;
  }
  let ordinal = 2;
  let candidate = `${label}${ordinal}`;
  while (slots.has(candidate)) {
    ordinal += 1;
    candidate = `${label}${ordinal}`;
  }
  slots.add(candidate);
  return candidate;
}

/** 名字/变体过不过既有闸门（D2 非空 + D16 类型 token + D19 zip 条目名） */
function nameGatesPass(name: string, variant?: string): boolean {
  if (name === '') return false;
  if (violatesNamingInvariant(name, variant)) return false;
  return !violatesZipEntryName(name, variant);
}

// ═══════════════════════════════════════════════════════════
// profile → 声明
// ═══════════════════════════════════════════════════════════

/**
 * 把一份已 parse 的 `profile` 对象摊成声明。
 *
 * 只读三个字段: `characterName` / `avatarUrl` / `gallery`。
 * `raceColor` / `tierColor` / `entranceQuote` 是上游前端的显示旋钮，与我们无关 ——
 * 读进来就得给它们找个落处，而那个落处不存在。
 */
function declsFromProfile(profile: unknown, slots: SlotMap): RemoteAssetDecl[] {
  if (!isPlainObject(profile)) return [];
  const name = typeof profile.characterName === 'string' ? profile.characterName : '';
  // 名字过不了闸门 → 整份 profile 作废: 它的每一条声明都会带着同一个坏名字
  if (!nameGatesPass(name)) return [];

  const out: RemoteAssetDecl[] = [];

  // ── 头像 ──
  if (isHttpUrl(profile.avatarUrl)) {
    out.push({ name, type: '头像', url: profile.avatarUrl.trim() });
  }

  // ── 立绘（gallery 按声明序拉平）──
  const gallery = Array.isArray(profile.gallery) ? profile.gallery : [];
  const key = slotKey(name, '立绘');
  let taken = slots.get(key);
  if (taken === undefined) {
    taken = new Set<string>();
    slots.set(key, taken);
  }

  let flatIndex = 0;
  for (const item of gallery) {
    if (!isPlainObject(item)) continue;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const sources = Array.isArray(item.sources) ? item.sources : [];
    for (let i = 0; i < sources.length; i += 1) {
      const url = sources[i];
      if (!isHttpUrl(url)) continue;
      // 拉平后的第一张想占基图位（空串）；其余按标题 + 序数
      const desired = flatIndex === 0 ? '' : i === 0 ? title : `${title}${i + 1}`;
      const allocated = allocateSlot(taken, title, desired);
      flatIndex += 1;
      const variant = allocated === '' ? undefined : allocated;
      // 变体过不了闸门（标题恰好是「立绘」之类）→ 只丢这一条，不牵连同角色其它图
      if (!nameGatesPass(name, variant)) continue;
      out.push(
        variant === undefined
          ? { name, type: '立绘', url: url.trim() }
          : { name, type: '立绘', variant, url: url.trim() },
      );
    }
  }

  return out;
}

// ═══════════════════════════════════════════════════════════
// 公开入口
// ═══════════════════════════════════════════════════════════

/**
 * 从**一条世界书条目正文**里抽出全部远程素材声明。
 *
 * 正文里 99% 是 EJS 噪音与角色设定散文，本函数只认 builder 块里的 `profile` 字面量。
 * 一条正文可以有多个块（一张卡里塞两个角色是常见写法），逐块独立处理：某一块的
 * `profile` 是坏 JSON 只让**那一块**作废。
 *
 * 🔴 **不做去重**: 同一条正文里两个块声明同一个角色的同一张图是合法的（作者复制粘贴），
 * 而「哪一条赢」是调用方的策略。要去重就显式调 {@link dedupeRemoteAssetDecls}。
 * 变体**位**的分配倒是跨块共享的 —— 否则第二块的第一张图会跟第一块抢基图位。
 */
export function extractRemoteAssetDecls(content: string): RemoteAssetDecl[] {
  if (typeof content !== 'string' || content === '') return [];
  const out: RemoteAssetDecl[] = [];
  const slots: SlotMap = new Map();

  for (const block of findBuilderBlocks(content)) {
    const re = new RegExp(PROFILE_DECL_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(block)) !== null) {
      const literal = readBalancedObject(block, match.index + match[0].length);
      if (literal === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(literal);
      } catch {
        // 上游约定写的是 JSON 兼容字面量；不兼容（带尾逗号 / 模板串 / 表达式）就跳过
        continue;
      }
      out.push(...declsFromProfile(parsed, slots));
    }
  }

  return out;
}

/**
 * 扫一批世界书，收齐全部远程素材声明。
 *
 * 🔴 **只扫 `enabled !== false` 的条目**: 关掉的条目对提示词一个字都不注入，凭什么
 * 替它下十几张图。判据写成 `!== false` 而不是 `=== true` 是为了容忍缺字段的历史行
 * （工坊装进来的条目、手写 JSON 导入的书）—— 那些行在注入侧同样按「开着」处理。
 *
 * 不去重（理由同 {@link extractRemoteAssetDecls}）。
 */
export function collectWorldBookRemoteAssets(books: readonly WorldBook[]): RemoteAssetDecl[] {
  const out: RemoteAssetDecl[] = [];
  for (const book of books ?? []) {
    for (const entry of book?.entries ?? []) {
      if (entry?.enabled === false) continue;
      out.push(...extractRemoteAssetDecls(entry?.content ?? ''));
    }
  }
  return out;
}

/**
 * 把内容包 `remoteAssets` 分节收窄成声明（第三方数据，容错口径照 `workshop-manifest.ts`）。
 *
 * 行形状 `{ name, url, type?, variant? }`:
 * - `type` 缺省 = `头像`（与文件名约定的缺省类型同一个常量，不另写字面量）
 * - `type` 写了个不认识的值 → **跳过这一行，绝不回落缺省**: 作者写 `立绘bg2` 是想要
 *   一个我们没有的类型，替他改成头像等于把图放错位置且没人会发现
 * - `name` / `variant` 过不了命名闸门 → 跳过该行
 *
 * 非数组（作者写成了对象、或整节缺席）→ 空数组。
 */
export function normalizePackRemoteAssets(rows: unknown): RemoteAssetDecl[] {
  if (!Array.isArray(rows)) return [];
  const out: RemoteAssetDecl[] = [];
  for (const raw of rows) {
    if (!isPlainObject(raw)) continue;
    const row = raw as RawPackRow;
    if (typeof row.name !== 'string' || row.name === '') continue;
    if (!isHttpUrl(row.url)) continue;

    let type: AssetType = DEFAULT_ASSET_TYPE;
    if (row.type !== undefined) {
      if (typeof row.type !== 'string' || !isAssetTypeToken(row.type)) continue;
      type = row.type as AssetType;
    }

    let variant: string | undefined;
    if (row.variant !== undefined) {
      if (typeof row.variant !== 'string') continue;
      // 空串与缺省是同一行（基图位），归一成缺省，免得下游多一种等价形状
      if (row.variant !== '') variant = row.variant;
    }

    if (!nameGatesPass(row.name, variant)) continue;
    out.push(
      variant === undefined
        ? { name: row.name, type, url: row.url.trim() }
        : { name: row.name, type, variant, url: row.url.trim() },
    );
  }
  return out;
}

/**
 * 按 `(name, type, variant)` 去重，**先来的赢**。
 *
 * URL 不进键: 同一个 (角色, 类型, 变体) 位只能落一张图，两条声明给了不同地址时
 * 「后写的覆盖先写的」会让结果取决于世界书的扫描顺序 —— 那是个每次装卸插件都会变的
 * 顺序。先来先得至少是稳定的，且与素材行「永不覆盖」的政策同向。
 */
export function dedupeRemoteAssetDecls(decls: readonly RemoteAssetDecl[]): RemoteAssetDecl[] {
  const seen = new Set<string>();
  const out: RemoteAssetDecl[] = [];
  for (const decl of decls ?? []) {
    const key = JSON.stringify([decl.name, decl.type, decl.variant ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(decl);
  }
  return out;
}
