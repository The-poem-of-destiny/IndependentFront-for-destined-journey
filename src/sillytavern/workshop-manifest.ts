/**
 * workshop-manifest.ts — 上游 JSON → 内部形状（Phase 1 / P1-1）
 *
 * 为什么存在: 上游是**第三方持续演进的服务**，字段会增会删会改名。把「读上游 JSON」
 * 收在一个纯函数里，等于把整个兼容层的脆弱面压缩成一个可以逐字段断言的文件：
 * 上游加字段 → 我们忽略；上游删字段 → 我们给安全缺省；上游改类型 → 我们守类型。
 * **本模块永不抛异常**（除非调用方传的不是 JSON 可解析值），因为一次上游字段调整
 * 不应该让用户的工坊页整个白屏。
 *
 * 两条解析线各自独立:
 * - `parseProjectMeta()` 吃 `GET /api/projects/{id}` 的 `project` 对象（实测 33 字段）
 * - `parsePayload()` 吃 `downloadUrl` 的载荷文件 + 详情响应里的 `regexEntriesPreview`
 *
 * ⚠️ 上游世界书条目有**两种形状**（详见 workshop-types.WorkshopSourceEntry）:
 * 详情预览里 `uid` 是字符串且有 `enabled`；载荷文件里 `uid` 是数字且只有 `disable`。
 * 本模块把两者归一，下游不再需要知道差别。
 *
 * ⚠️ 载荷文件的**外层**也有三种形状（对齐上游 `normalizeWorldbookSourceEntries`）:
 * 裸数组 / `{ entries: [] }` / `{ entries: { <key>: {} } }`。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无浏览器全局、无异常。
 *
 * 设计: docs/planning/2026-07-31-creative-workshop-compat-design.md D13 / 附录 A / 附录 C
 */

import type {
  WorkshopPayload,
  WorkshopProjectMeta,
  WorkshopSourceEntry,
  WorkshopSourceRegex,
} from './workshop-types';

// ═══════════════════════════════════════════════════════════
// 取值原语 —— 每一个都「拿不到就给缺省」，绝不抛
// ═══════════════════════════════════════════════════════════

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}

/** 取第一个非空字符串；全都拿不到则返回 fallback */
function readString(source: unknown, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = pick(source, key);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return fallback;
}

function readNumber(source: unknown, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = pick(source, key);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    // 上游偶有数字串（uid 在预览里就是 "0"）
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

/** 取可空数字：拿不到 → null（`minDepth` 实测就是 null，与「没设」同义） */
function readNullableNumber(source: unknown, keys: string[]): number | null {
  for (const key of keys) {
    const value = pick(source, key);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function readBoolean(source: unknown, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = pick(source, key);
    if (typeof value === 'boolean') return value;
  }
  return fallback;
}

function readStringArray(source: unknown, keys: string[]): string[] {
  for (const key of keys) {
    const value = pick(source, key);
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string');
    }
  }
  return [];
}

function readNumberArray(source: unknown, keys: string[]): number[] {
  for (const key of keys) {
    const value = pick(source, key);
    if (Array.isArray(value)) {
      return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
    }
  }
  return [];
}

// ═══════════════════════════════════════════════════════════
// 项目元数据（D13）
// ═══════════════════════════════════════════════════════════

/**
 * 上游 `project` 对象 → `WorkshopProjectMeta`。
 *
 * 只取 D13 要的那几个字段，其余 17 个身份/审核/社交字段刻意丢弃。
 *
 * @param raw 上游 `project` 对象；也容忍整个详情响应（会自动下钻 `.project`）
 * @returns 解析结果；**`id` 缺失时返回 `null`** —— 没有 id 的项目在本引擎里无法寻址
 *          （世界书 id、规则 id、分配器记录全靠它），落库只会造出一行找不回来的垃圾。
 *          这是本模块唯一的「拒绝」，其余字段一律给安全缺省。
 */
export function parseProjectMeta(raw: unknown): WorkshopProjectMeta | null {
  // 容忍调用方把整个 `{ project, worldbookEntriesPreview, regexEntriesPreview }` 丢进来
  const source = isRecord(raw) && isRecord(raw.project) ? raw.project : raw;

  const id = readString(source, ['id']).trim();
  if (!id) return null;

  const meta: WorkshopProjectMeta = {
    id,
    // 上游 rootProjectId 可选；自己就是根时回退到 id（实测首发项目两者相同）
    rootProjectId: readString(source, ['rootProjectId'], id),
    name: readString(source, ['name'], '未命名项目'),
    description: readString(source, ['description'], ''),
    // 上游 zod 的 default 也是 '1.0.0'；版本只做串比对不解析（D13）
    version: readString(source, ['version'], '1.0.0'),
    // authorGlobalName 优先，回退 authorName（D13）
    authorName: readString(source, ['authorGlobalName', 'authorName'], '未知作者'),
    tags: readStringArray(source, ['tags']),
    downloadUrl: readString(source, ['downloadUrl'], ''),
    fileSize: Math.max(0, Math.trunc(readNumber(source, ['fileSize'], 0))),
  };

  // 上游字段名是 coverImage；同时接受 coverUrl 以防上游改名
  const coverUrl = readString(source, ['coverImage', 'coverUrl']);
  if (coverUrl) meta.coverUrl = coverUrl;

  return meta;
}

// ═══════════════════════════════════════════════════════════
// 载荷
// ═══════════════════════════════════════════════════════════

/** 上游三种外层形状 → 条目数组（对齐上游 `normalizeWorldbookSourceEntries`） */
function unwrapEntryList(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  for (const key of keys) {
    const value = raw[key];
    if (Array.isArray(value)) return value;
    // `{ entries: { "0": {...} } }` —— ST 导出偶尔是对象映射
    if (isRecord(value)) return Object.values(value);
  }
  return [];
}

function clampSelectiveLogic(value: number): 0 | 1 | 2 | 3 {
  const n = Math.trunc(value);
  return n === 1 || n === 2 || n === 3 ? n : 0;
}

function parseSourceEntry(raw: unknown, index: number): WorkshopSourceEntry {
  const rawUid = pick(raw, 'uid');
  // 原样保留（string | number）供溯源；非法值退化成序号，保证 extra 里总有个可读的东西
  const sourceUid: string | number =
    typeof rawUid === 'string' || typeof rawUid === 'number' ? rawUid : index;

  // 名字是 D15 按名匹配的逻辑键，必须非空且在项目内稳定。
  // 上游 comment 为空时只能拿序号兜底 —— 这类条目在上游重排时会错配，
  // 但除此之外没有更好的锚点（内容会变，uid 是我们要抛弃的东西）。
  const name = readString(raw, ['comment', 'name']).trim() || `未命名条目 ${index + 1}`;

  // 预览形状有 `enabled`；载荷形状只有 `disable`。两者都没有 → 默认启用。
  const rawEnabled = pick(raw, 'enabled');
  const enabled =
    typeof rawEnabled === 'boolean' ? rawEnabled : !readBoolean(raw, ['disable'], false);

  return {
    sourceUid,
    name,
    content: readString(raw, ['content'], ''),
    enabled,
    key: readStringArray(raw, ['key', 'keys']),
    keysecondary: readStringArray(raw, ['keysecondary']),
    selectiveLogic: clampSelectiveLogic(readNumber(raw, ['selectiveLogic'], 0)),
    order: readNumber(raw, ['order'], 100),
    // ST 默认 position 0（before_char）；实测工坊条目多为 4（at_depth），原样保留
    position: readNumber(raw, ['position'], 0),
  };
}

function parseSourceRegex(raw: unknown, index: number): WorkshopSourceRegex {
  return {
    // 上游 uuid；缺失时用序号兜底，保证规则 id 在项目内唯一
    id: readString(raw, ['id'], `#${index}`),
    scriptName: readString(raw, ['scriptName', 'script_name'], ''),
    findRegex: readString(raw, ['findRegex', 'find_regex'], ''),
    replaceString: readString(raw, ['replaceString', 'replace_string'], ''),
    disabled: readBoolean(raw, ['disabled'], false),
    markdownOnly: readBoolean(raw, ['markdownOnly'], false),
    promptOnly: readBoolean(raw, ['promptOnly'], false),
    runOnEdit: readBoolean(raw, ['runOnEdit'], false),
    trimStrings: readStringArray(raw, ['trimStrings']),
    // ⚠️ 枚举非布尔（实测 0 / 2）。若上游哪天真给了布尔，true→1 / false→0，
    // 不让类型谎报；反正本引擎丢弃它，只用于「要不要记 note」。
    substituteRegex: (() => {
      const value = pick(raw, 'substituteRegex');
      if (typeof value === 'boolean') return value ? 1 : 0;
      return readNumber(raw, ['substituteRegex'], 0);
    })(),
    minDepth: readNullableNumber(raw, ['minDepth']),
    maxDepth: readNullableNumber(raw, ['maxDepth']),
    placement: readNumberArray(raw, ['placement']),
  };
}

/**
 * 上游载荷 → 规范化的两条内容轴。
 *
 * 世界书条目与正则条目在上游**来自不同的响应**（条目在 `downloadUrl` 文件里，
 * 正则在详情响应的 `regexEntriesPreview` 里 —— 实测正则预览带完整
 * `replaceString`，最长 340 KB，不是截断预览）。调用方可以分别传、也可以合成
 * 一个对象传，本函数两种都吃:
 *
 * ```ts
 * parsePayload(downloadedArray)                              // 只有条目
 * parsePayload({ entries: [...] })                           // ST 导出形状
 * parsePayload({ worldbookEntries: [...], regexEntries: [] }) // 合成形状
 * parsePayload({ ...detail, entries: downloadedArray })       // 详情 + 载荷
 * ```
 *
 * 永不抛：拿不到就是空数组。
 */
export function parsePayload(raw: unknown): WorkshopPayload {
  const worldbookRaw = unwrapEntryList(raw, [
    'entries',
    'worldbookEntries',
    'worldbook_entries',
    'worldbookEntriesPreview',
  ]);
  // 裸数组已被 worldbook 侧吃掉，正则只可能在对象形状里
  const regexRaw = Array.isArray(raw)
    ? []
    : unwrapEntryList(raw, ['regexEntries', 'regexEntriesPreview', 'regexes', 'regex_entries']);

  return {
    worldbookEntries: worldbookRaw.filter(isRecord).map(parseSourceEntry),
    regexEntries: regexRaw.filter(isRecord).map(parseSourceRegex),
  };
}
