/**
 * content-source.ts — 内容-引擎分离（波 1）的纯函数层（ContentProvider 的引擎半边）。
 *
 * 设计全文: `docs/planning/2026-08-05-content-engine-separation-design.md` §5.1。
 *
 * 为什么存在: 内容包（content pack）的校验、分节解析、安装计划**全部是纯同步函数**，
 * 零 I/O 全可单测——这与工坊子系统（`workshop-install-plan.ts`）和素材子系统
 * （`asset-import-plan.ts`）是同一个规矩：把决策从执行里剥出来，store 拿到计划后只做
 * 一件蠢事（照单写行）。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue。**有**一处对浏览器全局的惰性引用——SHA-256
 * 工具经 `media-hash.ts`（仓里唯一一份实现，见该文件头注释）惰性取 `crypto.subtle`；
 * 不安全上下文下返回 `undefined`，调用方回落到同步确定性 hash。planner 的逐书基线
 * 冲突判定**不**用 SHA-256（异步会把 planner 传染成 async），用的是本文件导出的同步
 * `hashContentDeterministic`（照 `workshop-install-plan.ts` 的 `hashWorkshopContent` 先例）。
 *
 * 本波（T1）交付范围:
 * - `validatePackOrThrow` —— 完整实现（格式 / 引擎版本 / 分节形状 / `creative_workshop` 分区拒绝）
 * - `hashContentDeterministic` / `hashWorldBook` / `hashPackSectionSha256` —— 完整实现
 * - `resolveSection` —— 完整实现（三态语义，纯函数）
 * - `planPackInstall` —— **只立骨架 + 类型**（签名 + 返回 `// TODO(T6)` 空计划）；
 *   四态判定逻辑是 T6 的任务
 *
 * 设计: docs/planning/2026-08-05-content-engine-separation-design.md §4 / §5.1 / §5.2 / D8 / D17 / D19 / D20
 */

import { isMediaHashAvailable, hashMediaBytes } from '../ui/lib/media-hash';
import type {
  ContentPack,
  EngineVersionGate,
  PackBaseline,
  PackFormatVersion,
  PackInstallPlan,
  PackValidationNote,
} from './types-content';
import { emptySectionPlan } from './types-content';
import type { WorldBook, WorkshopNote } from './types';

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/** 当前合法的内容包格式版本（§4）。未知值一律记 error note */
export const CURRENT_PACK_FORMAT_VERSION: PackFormatVersion = 1;

/** 工坊分区名（D8: pack 校验器拒绝此分区的世界书） */
const CREATIVE_WORKSHOP_PARTITION = 'creative_workshop';

/**
 * 占位世界书 uid 保留段下界（D43）。
 *
 * 占位书 uid ∈ `[900001, ...)`，与真实语料 uid 空间（max ≈ 509）物理隔离。
 * pack 的真实世界书**不该**用这个段——校验器对落在保留段的 pack 书记 warning，
 * 不阻止安装（真实包理论上不会踩，但留个提示位防构建器 bug）。
 */
export const PLACEHOLDER_UID_RESERVED_BASE = 900001;

// ═══════════════════════════════════════════════════════════
// 确定性 hash 工具（同步，planner 内部用）
// ═══════════════════════════════════════════════════════════

/**
 * 内容正文的确定性 hash（同步，不依赖 `crypto.subtle`）。
 *
 * 🔴 **planner 的逐书基线冲突判定专用**。它刻意**不用** `crypto.subtle`：
 * 1. `crypto.subtle` 是异步的，用它就得把 `planPackInstall` 改成 async，而「纯同步出计划」
 *    是这一层存在的全部理由（照 `workshop-install-plan.ts` 的 `hashWorkshopContent` 先例）。
 * 2. 冲突判定不需要密码学强度——没有对手在构造碰撞，只有用户在编辑条目正文，任何一次
 *    真实编辑都会翻动大量比特。
 *
 * 实现是双种子 FNV-1a 32 位拼成 16 位十六进制（约 64 位空间），与
 * `hashWorkshopContent` **同算法**（刻意复刻而非复用，避免引擎层依赖工坊纯函数模块；
 * T6 planner 落地后如需统一可再收口）。
 *
 * **不变式**: 同输入永远产同 hash；不同输入（不同长度或不同字符）极大概率产不同 hash。
 * 测试钉住这两条。
 */
export function hashContentDeterministic(content: string): string {
  let h1 = 0x811c9dc5; // FNV offset basis
  let h2 = 0x01000193; // 换一个起点，让两条链不同步
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((code << 5) | (code >>> 11)), 0x85ebca6b) >>> 0;
  }
  // 长度进哈希：截断/追加空白这类「同字符集」编辑也能被区分
  h2 = Math.imul(h2 ^ content.length, 0xc2b2ae35) >>> 0;
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * 一本世界书的确定性 hash（按其正文拼成稳定串后过 `hashContentDeterministic`）。
 *
 * 只把**内容语义**字段拼进 hash —— `id` / `name` / `partition` / `builtIn` 不进：
 * 它们是稳定标识，hash 的目的是判「正文被人改过吗」（D20 四态规则的 `updated` vs
 * `conflicted` 判据），改了名字/分区等于换了书，不该被当成「同一本书被编辑过」。
 * 条目的 `uid` 也不进 hash（uid 是引擎内寻址句柄，铁律 1：逻辑键 = 名字）。
 *
 * @param book 一本世界书
 * @returns 16 位十六进制 hash 串
 */
export function hashWorldBook(book: WorldBook): string {
  // 条目按 uid 稳定排序后拼，避免条目重排导致 hash 漂移
  const entries = [...book.entries].sort((a, b) => a.uid - b.uid);
  const payload = entries
    .map(
      (e) =>
        `${e.name} ${e.enabled ? 1 : 0} ${e.content} ${e.key.join(',')} ${e.selectiveLogic} ${e.order}`,
    )
    .join('');
  return hashContentDeterministic(payload);
}

/**
 * 一段任意字节/字符串的 SHA-256 hash（异步，依赖 `crypto.subtle`）。
 *
 * 🔴 这是构建器给 `sectionHashes`（§4）盖章用的——D40 升级 diff 展示与快速比对。
 * **不**用于 planner 的逐书基线冲突判定（那是同步的 `hashContentDeterministic`）。
 * 两者用途不同、不许混用（D18 hash 分工）。
 *
 * @returns SHA-256 小写 hex（带 `sha256:` 前缀，对齐 §4 的 `sectionHashes` 形状）；
 *          `crypto.subtle` 不可用时返回 `undefined`
 */
export async function hashPackSectionSha256(content: string): Promise<string | undefined> {
  if (!isMediaHashAvailable()) return undefined;
  const bytes = new TextEncoder().encode(content);
  const digest = await hashMediaBytes(bytes);
  return digest ? `sha256:${digest}` : undefined;
}

// ═══════════════════════════════════════════════════════════
// 校验（§5.2：validate 先于任何写入）
// ═══════════════════════════════════════════════════════════

/**
 * 校验一个内容包，返回问题记录数组（**不 throw**，§4 规则）。
 *
 * 校验项:
 * 1. `formatVersion` 必须是 `1`（CURRENT_PACK_FORMAT_VERSION）；非数值 / 未知值 → error
 * 2. `packId` / `packVersion` 必须是非空字符串；缺 → error
 * 3. `minEngineVersion` 与 `__ENGINE_VERSION__` semver 比对（D40）—— **本波缺省=跳过**：
 *    `typeof __ENGINE_VERSION__ === 'undefined'` 时不做版本门（见 {@link checkEngineVersion}）
 * 4. 各分节 if-present 形状校验（数组/对象类型；`agentDefaults.version` / `.agents` 等）
 * 5. 🔴 拒 `creative_workshop` 分区的世界书（D8：工坊分区是信任边界，不许 pack 染指）→ error
 *
 * 调用方据 `notes.some(n => n.level === 'error')` 判是否阻止安装。
 *
 * @param pack 待校验的内容包（已是 `JSON.parse` 后的对象）
 * @returns 校验问题记录数组（空 = 通过）
 */
export function validatePackOrThrow(pack: unknown): PackValidationNote[] {
  const notes: PackValidationNote[] = [];

  // pack 顶层必须是对象
  if (!isPlainObject(pack)) {
    notes.push(makeError('not-object', '内容包根必须是 JSON 对象，实际是 ' + typeof pack));
    return notes; // 不是对象，后续校验无意义
  }

  // formatVersion
  if (pack.formatVersion !== CURRENT_PACK_FORMAT_VERSION) {
    notes.push(
      makeError(
        'bad-format-version',
        `formatVersion 必须是 ${CURRENT_PACK_FORMAT_VERSION}，实际是 ${JSON.stringify(pack.formatVersion)}`,
      ),
    );
  }

  // packId / packVersion
  if (typeof pack.packId !== 'string' || pack.packId.length === 0) {
    notes.push(makeError('missing-pack-id', 'packId 必须是非空字符串'));
  }
  if (typeof pack.packVersion !== 'string' || pack.packVersion.length === 0) {
    notes.push(makeError('missing-pack-version', 'packVersion 必须是非空 semver 字符串'));
  }

  // minEngineVersion（D40）—— 本波缺省=跳过
  const minEngineVersion =
    typeof pack.minEngineVersion === 'string' ? pack.minEngineVersion : undefined;
  const gate = checkEngineVersion(minEngineVersion);
  if (gate.result === 'too-new') {
    notes.push(
      makeError(
        'engine-too-old',
        `pack 要求引擎 ≥ ${gate.packMin}，当前引擎版本 ${gate.engineVersion ?? '(未注入)'} 不满足`,
      ),
    );
  }

  // worldBooks 分节形状 + creative_workshop 分区拒绝（D8）
  if (pack.worldBooks !== undefined) {
    const wbNotes = validateWorldBooksSection(pack.worldBooks);
    notes.push(...wbNotes);
  }

  // agentDefaults 分节形状
  if (pack.agentDefaults !== undefined) {
    notes.push(...validateAgentDefaultsSection(pack.agentDefaults));
  }

  // presets 分节形状
  if (pack.presets !== undefined) {
    if (!Array.isArray(pack.presets)) {
      notes.push(makeError('bad-presets-section', 'presets 分节必须是数组'));
    }
  }

  // beautifierRules 分节形状
  if (pack.beautifierRules !== undefined) {
    notes.push(...validateBeautifierRulesSection(pack.beautifierRules));
  }

  // 数组型分节的统一形状校验
  const arraySectionNames = ['mapMarkers', 'locations'] as const;
  for (const name of arraySectionNames) {
    const v = pack[name];
    if (v !== undefined && !Array.isArray(v)) {
      notes.push(makeError(`bad-${name}-section`, `${name} 分节必须是数组`));
    }
  }

  // 对象型分节的统一形状校验
  const objectSectionNames = ['catalog', 'bloodlines', 'namePools', 'branding'] as const;
  for (const name of objectSectionNames) {
    const v = pack[name];
    if (v !== undefined && !isPlainObject(v)) {
      notes.push(makeError(`bad-${name}-section`, `${name} 分节必须是 JSON 对象`));
    }
  }

  return notes;
}

/**
 * `__ENGINE_VERSION__` 版本门（D40）。
 *
 * 🔴 **本波先接受缺省=跳过**: `__ENGINE_VERSION__` 的 vite define 注入是 D26 的活，
 * 落在 T13。当前 `typeof __ENGINE_VERSION__ === 'undefined'` 时（裸 tsc / vitest node
 * 环境都成立），本函数返回 `'skipped'`，不阻止安装。
 *
 * TODO(T13): D26 落地 `vite.config.ts` 的 `define: { __ENGINE_VERSION__: JSON.stringify(pkg.version) }`
 * 后，删掉 `typeof` 缺省分支，让 `'skipped'` 不可达；并补「过新包被拒绝」的测试
 * （minEngineVersion > __ENGINE_VERSION__ 时 result === 'too-new'）。
 *
 * semver 比对用朴素的三段数值比较（pack 的 minEngineVersion 约定为 `MAJOR.MINOR.PATCH`）；
 * 解析失败 → 视为「pack 声明了无法解析的版本要求」，记 `'too-new'`（保守拒绝）。
 *
 * @param packMin pack 声明的最低引擎版本（semver 串）；undefined = pack 没声明，放行
 */
export function checkEngineVersion(packMin: string | undefined): EngineVersionGate {
  // pack 未声明 minEngineVersion → 无版本要求，直接放行（不需要引擎版本）
  if (packMin === undefined) {
    return { packMin: undefined, engineVersion: readEngineVersion(), result: 'ok' };
  }
  // 🔴 T13 之前 __ENGINE_VERSION__ 未注入 → 跳过版本门
  // （裸 tsc 与 vitest node 环境下此分支恒成立）
  const engineVersion = readEngineVersion();
  if (engineVersion === undefined) {
    return { packMin, engineVersion: undefined, result: 'skipped' };
  }
  if (semverGte(engineVersion, packMin)) {
    return { packMin, engineVersion, result: 'ok' };
  }
  return { packMin, engineVersion, result: 'too-new' };
}

/**
 * 读 `__ENGINE_VERSION__` 注入值；未注入返回 undefined。
 *
 * 独立成函数是为了 vitest 能在不污染全局的情况下跑：测试直接调 `checkEngineVersion`
 * 传字符串参数即可，不依赖 define 注入。
 */
function readEngineVersion(): string | undefined {
  // 引擎版本经 vite define 注入；裸 tsc / vitest node 环境下未定义。
  const scope = globalThis as { __ENGINE_VERSION__?: unknown };
  const v = scope.__ENGINE_VERSION__;
  return typeof v === 'string' ? v : undefined;
}

/**
 * 朴素 semver 三段比对: `current >= required` ?
 *
 * 只认 `MAJOR.MINOR.PATCH`（可选 `-prerelease`，prerelease 让版本**更小**）。
 * 解析失败 → `false`（保守拒绝：声明的版本要求看不懂，不让装）。
 *
 * 不引 `semver` 包: 引擎层零新增依赖是本波的口径，且本比对只用于版本门一处。
 */
export function semverGte(current: string, required: string): boolean {
  const c = parseSemver(current);
  const r = parseSemver(required);
  if (!c || !r) return false;
  // 主.次.修 数值比较
  if (c.major !== r.major) return c.major > r.major;
  if (c.minor !== r.minor) return c.minor > r.minor;
  if (c.patch !== r.patch) return c.patch > r.patch;
  // 三段相等时：无 prerelease 的版本 ≥ 带 prerelease 的版本
  // （1.0.0 ≥ 1.0.0-beta，但 1.0.0-beta 不 ≥ 1.0.0）
  if (c.prerelease === undefined && r.prerelease === undefined) return true;
  if (c.prerelease === undefined) return true; // 正式版 ≥ 任何 prerelease
  if (r.prerelease === undefined) return false; // prerelease 不 ≥ 正式版
  return c.prerelease >= r.prerelease; // 同版本 prerelease 字符串比较
}

/** 解析 semver 串；解析失败返回 undefined */
function parseSemver(
  v: string,
): { major: number; minor: number; patch: number; prerelease: string | undefined } | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return undefined;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch))
    return undefined;
  return { major, minor, patch, prerelease: m[4] };
}

/**
 * 校验 worldBooks 分节（§4 / D8）。
 *
 * 🔴 **拒 `creative_workshop` 分区的书**: 工坊分区是信任边界，pack 染指它等于
 * 把未经审查的社区内容伪装成官方内容混进信任域（§0.3 / D8）。
 */
function validateWorldBooksSection(section: unknown): PackValidationNote[] {
  const notes: PackValidationNote[] = [];
  if (!Array.isArray(section)) {
    notes.push(makeError('bad-worldbooks-section', 'worldBooks 分节必须是数组'));
    return notes;
  }
  for (let i = 0; i < section.length; i++) {
    const book = section[i];
    if (!isPlainObject(book)) {
      notes.push(makeError('bad-worldbook-row', `worldBooks[${i}] 必须是 JSON 对象`));
      continue;
    }
    if (typeof book.id !== 'string' || book.id.length === 0) {
      notes.push(makeError('bad-worldbook-row', `worldBooks[${i}] 缺少非空 id`));
    }
    if (typeof book.name !== 'string' || book.name.length === 0) {
      notes.push(makeError('bad-worldbook-row', `worldBooks[${i}] 缺少非空 name`));
    }
    if (book.partition === CREATIVE_WORKSHOP_PARTITION) {
      notes.push(
        makeError(
          'workshop-partition-rejected',
          `worldBooks[${i}]（id=${String(book.id)}）声明了 creative_workshop 分区，pack 不允许染指工坊信任域（D8）`,
        ),
      );
    }
    // 条目结构：必须是数组，每条要有 uid/name/content
    if (!Array.isArray(book.entries)) {
      notes.push(
        makeError(
          'bad-worldbook-row',
          `worldBooks[${i}]（id=${String(book.id)}）的 entries 必须是数组`,
        ),
      );
    } else {
      for (let j = 0; j < book.entries.length; j++) {
        const e = book.entries[j];
        if (!isPlainObject(e) || typeof e.uid !== 'number' || typeof e.name !== 'string') {
          notes.push(
            makeError(
              'bad-worldbook-entry',
              `worldBooks[${i}].entries[${j}] 必须含 uid(number) 与 name(string)`,
            ),
          );
        }
      }
    }
    // 占位 uid 保留段警告（D43）：真实包的书不该踩 900001+
    if (Array.isArray(book.entries)) {
      for (const e of book.entries) {
        if (
          isPlainObject(e) &&
          typeof e.uid === 'number' &&
          e.uid >= PLACEHOLDER_UID_RESERVED_BASE
        ) {
          notes.push({
            level: 'warning',
            code: 'placeholder-uid-range',
            text: `worldBooks[${i}]（id=${String(book.id)}）含 uid=${e.uid}，落在占位保留段 ${PLACEHOLDER_UID_RESERVED_BASE}+（D43），真实包通常不该用此段`,
          });
          break; // 每本书最多记一条
        }
      }
    }
  }
  return notes;
}

/** 校验 agentDefaults 分节形状 */
function validateAgentDefaultsSection(section: unknown): PackValidationNote[] {
  const notes: PackValidationNote[] = [];
  if (!isPlainObject(section)) {
    notes.push(makeError('bad-agent-defaults-section', 'agentDefaults 分节必须是 JSON 对象'));
    return notes;
  }
  if (typeof (section as { version?: unknown }).version !== 'number') {
    notes.push(makeError('bad-agent-defaults-section', 'agentDefaults.version 必须是数值'));
  }
  const agents = (section as { agents?: unknown }).agents;
  if (!isPlainObject(agents)) {
    notes.push(makeError('bad-agent-defaults-section', 'agentDefaults.agents 必须是 JSON 对象'));
  }
  return notes;
}

/** 校验 beautifierRules 分节形状 */
function validateBeautifierRulesSection(section: unknown): PackValidationNote[] {
  const notes: PackValidationNote[] = [];
  if (!isPlainObject(section)) {
    notes.push(makeError('bad-beautifier-section', 'beautifierRules 分节必须是 JSON 对象'));
    return notes;
  }
  if (typeof (section as { version?: unknown }).version !== 'number') {
    notes.push(makeError('bad-beautifier-section', 'beautifierRules.version 必须是数值'));
  }
  if (!Array.isArray((section as { rules?: unknown }).rules)) {
    notes.push(makeError('bad-beautifier-section', 'beautifierRules.rules 必须是数组'));
  }
  return notes;
}

// ═══════════════════════════════════════════════════════════
// 分节解析（D20 三态语义）
// ═══════════════════════════════════════════════════════════

/**
 * 解析一个分节，返回 pack payload 优先于占位的最终值（D20，纯函数）。
 *
 * 🔴 **三态语义**（§4）:
 * - pack 分节 `undefined`（absent）= 本包对该域无话可说 → 用 `placeholder`（占位）
 * - pack 分节 `[]`（空数组）= 刻意清空 → 返回 `[]`（**不**回落占位）
 * - pack 分节 `rows`（非空数组/对象）= 替换 → 返回 pack payload
 *
 * 本函数**不 fetch 任何东西**：`packSection` 与 `placeholderSection` 都由调用方传入
 * （planner 是纯函数，基线/占位来源由调用方作参数传入，D19/D20 裁定）。
 *
 * @param packSection pack 里该分节的值（可能 undefined）
 * @param placeholderSection 内置占位内容里该分节的值（可能 undefined）
 * @returns 该分节的最终值（可能 undefined = 两边都没声明）
 */
export function resolveSection<T>(
  packSection: T | undefined,
  placeholderSection: T | undefined,
): T | undefined {
  if (packSection !== undefined) return packSection;
  return placeholderSection;
}

// ═══════════════════════════════════════════════════════════
// planner 骨架（D19 / D20）—— 完整实现是 T6 的任务
// ═══════════════════════════════════════════════════════════

/**
 * 产出一个内容包的安装计划（§5.1 / D19 / D20）。
 *
 * 🔴 **本波（T1）只立骨架 + 类型签名**。完整四态判定逻辑（D20 四态规则：
 * 有上次装包基线→现hash=基线则覆盖 / ≠则冲突确认；无基线→现hash=占位基线则静默覆盖 /
 * ≠则冲突确认）是 **T6** 的任务。
 *
 * 本函数当前行为:
 * 1. 调 `validatePackOrThrow` 校验 pack；error 级 note 进 `validationErrors`
 * 2. 若校验通过（无 error），返回一个**全空计划**（每个 absent 分节不出现、出现的
 *    分节给 `emptySectionPlan()`）—— 这是 T6 填充四态逻辑的骨架
 * 3. 存档 uid 迁移步骤 / agentDefaults 名册 / branding 声明键 都只立结构占位
 *
 * @param pack 待安装的内容包
 * @param _current 当前库里各分节的状态（T6 用于 added/updated/conflicted 判定；本波未用）
 * @param _packBaseline 上次装包的逐项基线 hash（D20 四态规则操作数之一；本波未用）
 * @param _placeholderBaseline 占位内容的逐项基线 hash（D20 四态规则操作数之二；本波未用）
 */
export function planPackInstall(
  pack: ContentPack,
  // T6 会用到这三个参数；本波签名先立，避免 T6 改 planner 签名引发调用方连锁改动。
  _current?: {
    worldBooks?: readonly WorldBook[];
    presets?: readonly unknown[];
    beautifierRules?: readonly unknown[];
    mapMarkers?: readonly unknown[];
    locations?: readonly unknown[];
    bloodlines?: readonly unknown[];
  },
  _packBaseline?: PackBaseline,
  _placeholderBaseline?: PackBaseline,
): PackInstallPlan {
  const validationErrors = validatePackOrThrow(pack);
  const notes: WorkshopNote[] = [];

  const sections: PackInstallPlan['sections'] = {};

  // T6 在此填四态逻辑。本波给每个 present 分节一个空计划骨架。
  // TODO(T6): 实现 D20 四态规则:
  //   - 有上次装包基线 (_packBaseline): 现hash = 基线 → updated; ≠ → conflicted
  //   - 无装包基线（首次安装）: 现hash = 占位基线 (_placeholderBaseline) → updated(静默); ≠ → conflicted
  //   - pack 声明 [] → removed
  //   - 当前不存在 → added
  //   每项 hash 用 hashWorldBook / hashContentDeterministic 现算（D18: 从 payload 现算，不用 sectionHashes）
  if (pack.worldBooks !== undefined) {
    sections.worldBooks = emptySectionPlan();
  }
  if (pack.presets !== undefined) {
    sections.presets = emptySectionPlan();
  }
  if (pack.beautifierRules !== undefined) {
    sections.beautifierRules = emptySectionPlan();
  }
  if (pack.mapMarkers !== undefined) {
    sections.mapMarkers = emptySectionPlan();
  }
  if (pack.catalog !== undefined) {
    sections.catalog = emptySectionPlan();
  }
  if (pack.locations !== undefined) {
    sections.locations = emptySectionPlan();
  }
  if (pack.bloodlines !== undefined) {
    sections.bloodlines = emptySectionPlan();
  }
  if (pack.namePools !== undefined) {
    sections.namePools = emptySectionPlan();
  }

  const agentDefaults: PackInstallPlan['agentDefaults'] | undefined = pack.agentDefaults
    ? { agentIds: Object.keys(pack.agentDefaults.agents ?? {}) }
    : undefined;

  const branding: PackInstallPlan['branding'] | undefined = pack.branding
    ? { declaredKeys: Object.keys(pack.branding) }
    : undefined;

  // 存档 uid 迁移占位（T6/T43 实现）
  let saveUidMigration: PackInstallPlan['saveUidMigration'];
  if (pack.worldBooks !== undefined) {
    // TODO(T6/T43): 按 D43 三段式填迁移映射（按名配对 + needs_selection 标记）
    saveUidMigration = { rewrite: {}, needsSelectionPartitions: [] };
  }

  return {
    packId: typeof pack.packId === 'string' ? pack.packId : '',
    packVersion: typeof pack.packVersion === 'string' ? pack.packVersion : '',
    sections,
    agentDefaults,
    branding,
    saveUidMigration,
    notes,
    validationErrors,
  };
}

// ═══════════════════════════════════════════════════════════
// 小工具
// ═══════════════════════════════════════════════════════════

/** 造一条 error 级校验 note */
function makeError(code: string, text: string): PackValidationNote {
  return { level: 'error', code, text };
}

/** 窄化: 值是不是普通对象（非 null / 非数组） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}
