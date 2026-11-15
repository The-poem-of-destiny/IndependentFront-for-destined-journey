/**
 * plugin-manifest.ts — 插件 manifest.json → `PluginManifest`（插件系统设计 §3.2、§3.6、§8）
 *
 * 为什么存在: manifest 是玩家拿到手的第三方文件，安装页展示的每一句话都从这里来。
 * 把「读 manifest」收进一个纯函数，口径照 `src/core/workshop/workshop-manifest.ts`：
 * **永不抛异常**，认不出的字段丢弃并记一条处置记录（`droppedNotes`）。
 *
 * 三种结局（互不混淆）:
 * - `errors` 非空：结构不合格（id、名称、入口路径、联网域名等），`manifest = null`，不可安装。
 *   `network` 里任何一项不合规，整个插件不可安装，不做「丢掉坏项继续装」（§3.2）。
 * - `incompatible` 有值：结构合格但本宿主满足不了（`pluginApi` 范围不满足、
 *   `manifestVersion` 不认识、声明了不认识的能力或贡献点），`manifest` 照常返回以便展示，
 *   但不可安装、不能启用（§3.6、§8）。
 * - 两者都没有：`installable = true`。
 *
 * 用户可见的文字（errors / droppedNotes / incompatible）一律简体中文。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无浏览器全局、无异常。
 */

import { semverGte } from '../content/content-source';
import type {
  PluginCapabilities,
  PluginContribution,
  PluginManifest,
  PluginSlot,
  PluginSurfaceKind,
} from '../types/types-plugin';
import { validatePluginNetwork } from './plugin-network';
import {
  isSafePluginRelPath,
  PLUGIN_AI,
  PLUGIN_API_VERSION,
  PLUGIN_COMMANDS,
  PLUGIN_EVENTS,
  PLUGIN_SLOTS,
  PLUGIN_STORAGE,
  PLUGIN_VIEWS,
} from './plugin-surface';

/** `coercePluginManifest` 的结果 */
export interface PluginManifestCoercion {
  /** 规整后的 manifest；`errors` 非空时为 `null` */
  manifest: PluginManifest | null;
  /** 没有错误且兼容时为 true */
  installable: boolean;
  /** 不兼容的原因（多条以「；」连接）；兼容时缺省 */
  incompatible?: string;
  /** 被丢弃的未知字段或无效可选值的处置记录 */
  droppedNotes: string[];
  /** 致命错误；任何一条都让插件不可安装 */
  errors: string[];
}

/** 插件 id 规则（§3.2），全局唯一键 */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/** 贡献项 id：插件内唯一，只收安全字符 */
const CONTRIBUTION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** 文本字段长度上限（UTF-16 码元） */
const TEXT_LIMITS = {
  name: 64,
  version: 32,
  author: 64,
  description: 1000,
  label: 32,
  pluginApi: 64,
} as const;

/** 贡献窗口尺寸上限（像素） */
const MAX_SURFACE_PX = 4096;

const SURFACE_KINDS: readonly PluginSurfaceKind[] = ['window', 'overlay', 'panel'];

/** 入口必须是 HTML 文件 */
const HTML_ENTRY_RE = /\.html?$/i;

/** 图标只收图片 */
const ICON_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

const KNOWN_TOP_LEVEL = new Set([
  'manifestVersion',
  'id',
  'name',
  'version',
  'author',
  'description',
  'pluginApi',
  'contributions',
  'background',
  'network',
  'capabilities',
]);

const KNOWN_CONTRIBUTION_FIELDS = new Set([
  'slot',
  'id',
  'label',
  'icon',
  'surface',
  'entry',
  'width',
  'height',
]);

/** 能力类别 → 宿主认识的名称表（§3.6 声明即契约） */
const CAPABILITY_TABLES: Record<keyof PluginCapabilities, readonly string[]> = {
  read: PLUGIN_VIEWS,
  commands: Object.keys(PLUGIN_COMMANDS),
  events: PLUGIN_EVENTS,
  ai: PLUGIN_AI,
  storage: PLUGIN_STORAGE,
};

const CAPABILITY_KEYS = Object.keys(CAPABILITY_TABLES) as (keyof PluginCapabilities)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 给错误文案用的值摘要：截短，绝不抛 */
function describe(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = Object.prototype.toString.call(value);
    }
  }
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** 必填文本：去首尾空白后非空且不超长；否则返回 null 并记错误 */
function requiredText(value: unknown, field: string, max: number, errors: string[]): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${field} 必须是非空字符串`);
    return null;
  }
  const text = value.trim();
  if (text.length > max) {
    errors.push(`${field} 超过 ${max} 个字符`);
    return null;
  }
  return text;
}

/** 可选文本：缺省或无效时返回 undefined，无效时记处置记录 */
function optionalText(
  value: unknown,
  field: string,
  max: number,
  notes: string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    notes.push(`已忽略 ${field}：不是字符串`);
    return undefined;
  }
  const text = value.trim();
  if (text.length === 0) return undefined;
  if (text.length > max) {
    notes.push(`已忽略 ${field}：超过 ${max} 个字符`);
    return undefined;
  }
  return text;
}

/** 包内 HTML 入口路径；不合格时记错误 */
function htmlEntry(value: unknown, field: string, errors: string[]): string | null {
  if (typeof value !== 'string' || !isSafePluginRelPath(value)) {
    errors.push(`${field} 不是安全的包内相对路径：${describe(value)}`);
    return null;
  }
  if (!HTML_ENTRY_RE.test(value)) {
    errors.push(`${field} 必须是 .html 或 .htm 文件：${value}`);
    return null;
  }
  return value;
}

/** 可选尺寸：正数且不超过上限；无效时记处置记录 */
function optionalSize(value: unknown, field: string, notes: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_SURFACE_PX) {
    return Math.round(value);
  }
  notes.push(`已忽略 ${field}：必须是 1 到 ${MAX_SURFACE_PX} 之间的数`);
  return undefined;
}

function coerceContributions(
  raw: unknown,
  errors: string[],
  notes: string[],
  incompatible: string[],
): PluginContribution[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push('contributions 必须是数组');
    return [];
  }
  const out: PluginContribution[] = [];
  const seen = new Set<string>();
  (raw as unknown[]).forEach((item, index) => {
    const at = `contributions[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${at} 必须是对象`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (!KNOWN_CONTRIBUTION_FIELDS.has(key)) notes.push(`已丢弃未知字段 ${at}.${key}`);
    }

    let ok = true;
    const slot = item.slot;
    if (typeof slot !== 'string') {
      errors.push(`${at}.slot 必须是字符串`);
      ok = false;
    } else if (!(PLUGIN_SLOTS as readonly string[]).includes(slot)) {
      // 未来版本的贡献点：结构没错，只是本宿主不认识
      incompatible.push(`不认识的贡献点 ${slot}`);
    }

    const id = item.id;
    if (typeof id !== 'string' || !CONTRIBUTION_ID_RE.test(id)) {
      errors.push(`${at}.id 只能由字母、数字、点、下划线、连字符组成，长 1 到 64：${describe(id)}`);
      ok = false;
    } else if (seen.has(id)) {
      errors.push(`${at}.id 重复：${id}`);
      ok = false;
    } else {
      seen.add(id);
    }

    const label = requiredText(item.label, `${at}.label`, TEXT_LIMITS.label, errors);
    if (label === null) ok = false;

    const surface = item.surface;
    if (typeof surface !== 'string' || !SURFACE_KINDS.includes(surface as PluginSurfaceKind)) {
      errors.push(`${at}.surface 必须是 window、overlay 或 panel 之一：${describe(surface)}`);
      ok = false;
    }

    const entry = htmlEntry(item.entry, `${at}.entry`, errors);
    if (entry === null) ok = false;

    let icon: string | undefined;
    if (item.icon !== undefined) {
      if (typeof item.icon !== 'string' || !isSafePluginRelPath(item.icon)) {
        errors.push(`${at}.icon 不是安全的包内相对路径：${describe(item.icon)}`);
        ok = false;
      } else if (!ICON_RE.test(item.icon)) {
        errors.push(`${at}.icon 必须是图片文件：${item.icon}`);
        ok = false;
      } else {
        icon = item.icon;
      }
    }

    const width = optionalSize(item.width, `${at}.width`, notes);
    const height = optionalSize(item.height, `${at}.height`, notes);
    if (!ok) return;

    const contribution: PluginContribution = {
      slot: slot as PluginSlot,
      id: id as string,
      label: label as string,
      surface: surface as PluginSurfaceKind,
      entry: entry as string,
    };
    if (icon !== undefined) contribution.icon = icon;
    if (width !== undefined) contribution.width = width;
    if (height !== undefined) contribution.height = height;
    out.push(contribution);
  });
  return out;
}

function coerceCapabilities(
  raw: unknown,
  errors: string[],
  incompatible: string[],
): PluginCapabilities {
  const caps: PluginCapabilities = { read: [], commands: [], events: [], ai: [], storage: [] };
  if (raw === undefined) return caps;
  if (!isRecord(raw)) {
    errors.push('capabilities 必须是对象');
    return caps;
  }
  for (const key of Object.keys(raw)) {
    if (!(CAPABILITY_KEYS as string[]).includes(key)) {
      incompatible.push(`不认识的能力类别 capabilities.${key}`);
    }
  }
  for (const key of CAPABILITY_KEYS) {
    const list = raw[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errors.push(`capabilities.${key} 必须是字符串数组`);
      continue;
    }
    const known = CAPABILITY_TABLES[key];
    const names: string[] = [];
    for (const name of list as unknown[]) {
      if (typeof name !== 'string') {
        errors.push(`capabilities.${key} 里有非字符串项：${describe(name)}`);
        continue;
      }
      if (!known.includes(name)) {
        incompatible.push(`不认识的能力 capabilities.${key}：${describe(name)}`);
        continue;
      }
      if (!names.includes(name)) names.push(name);
    }
    caps[key] = names;
  }
  return caps;
}

/**
 * 解析并校验插件 manifest。永不抛。
 *
 * @param raw 已解析的 JSON 值；也接受 JSON 文本（内部 `JSON.parse`，解析失败记错误）
 */
export function coercePluginManifest(raw: unknown): PluginManifestCoercion {
  const errors: string[] = [];
  const droppedNotes: string[] = [];
  const incompatible: string[] = [];

  let source = raw;
  if (typeof raw === 'string') {
    try {
      source = JSON.parse(raw) as unknown;
    } catch {
      errors.push('manifest.json 不是合法的 JSON');
      return { manifest: null, installable: false, droppedNotes, errors };
    }
  }
  if (!isRecord(source)) {
    errors.push('manifest 必须是 JSON 对象');
    return { manifest: null, installable: false, droppedNotes, errors };
  }

  for (const key of Object.keys(source)) {
    if (KNOWN_TOP_LEVEL.has(key)) continue;
    droppedNotes.push(
      key === 'remoteCode'
        ? '已丢弃字段 remoteCode：该开关已废弃，联网插件能否取回代码只由 network 决定'
        : `已丢弃未知字段 ${key}`,
    );
  }

  const manifestVersion = source.manifestVersion;
  if (typeof manifestVersion !== 'number') {
    errors.push('manifestVersion 必须是数字');
  } else if (manifestVersion !== 1) {
    incompatible.push(`不认识的 manifestVersion ${manifestVersion}`);
  }

  const id = source.id;
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) {
    errors.push(
      `id 必须是 3 到 64 位小写字母、数字、点、下划线、连字符，且以字母或数字开头：${describe(id)}`,
    );
  }

  const name = requiredText(source.name, 'name', TEXT_LIMITS.name, errors);
  const version = requiredText(source.version, 'version', TEXT_LIMITS.version, errors);
  const author = optionalText(source.author, 'author', TEXT_LIMITS.author, droppedNotes);
  const description = optionalText(
    source.description,
    'description',
    TEXT_LIMITS.description,
    droppedNotes,
  );

  const pluginApi = requiredText(source.pluginApi, 'pluginApi', TEXT_LIMITS.pluginApi, errors);
  if (pluginApi !== null) {
    if (parseRange(pluginApi) === null) {
      errors.push(`pluginApi 不是可识别的版本范围：${pluginApi}`);
    } else if (!satisfiesPluginApi(pluginApi)) {
      incompatible.push(`需要宿主 API ${pluginApi}，本机是 ${PLUGIN_API_VERSION}`);
    }
  }

  const contributions = coerceContributions(
    source.contributions,
    errors,
    droppedNotes,
    incompatible,
  );

  let background: string | undefined;
  if (source.background !== undefined) {
    background = htmlEntry(source.background, 'background', errors) ?? undefined;
  }

  const network = validatePluginNetwork(source.network);
  if (!network.ok) {
    for (const e of network.errors) errors.push(`network：${describe(e.entry)} —— ${e.reason}`);
  }

  const capabilities = coerceCapabilities(source.capabilities, errors, incompatible);

  if (errors.length > 0 || !network.ok) {
    return { manifest: null, installable: false, droppedNotes, errors };
  }

  const manifest: PluginManifest = {
    manifestVersion: 1,
    id: id as string,
    name: name as string,
    version: version as string,
    pluginApi: pluginApi as string,
    contributions,
    network: network.hosts,
    capabilities,
  };
  if (author !== undefined) manifest.author = author;
  if (description !== undefined) manifest.description = description;
  if (background !== undefined) manifest.background = background;

  if (incompatible.length > 0) {
    return {
      manifest,
      installable: false,
      incompatible: incompatible.join('；'),
      droppedNotes,
      errors,
    };
  }
  return { manifest, installable: true, droppedNotes, errors };
}

// ═══════════════════════════════════════════════════════════
// pluginApi 版本范围（§8）
// ═══════════════════════════════════════════════════════════

/** 一个版本范围 = 下界（含）+ 可选上界（不含）；上界 null 表示无上限 */
interface VersionRange {
  min: string;
  maxExclusive: string | null;
}

/** `x`、`x.y`、`x.y.z`（只收数字段，不收 prerelease） */
const RANGE_RE = /^(\^|~|>=|=)?\s*(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?$/;

/**
 * 解析范围。支持的写法（不带 prerelease，段可省略）:
 * - `^x.y.z`：npm 口径，锁最左非零段（`^1.2` = ≥1.2.0 <2.0.0；`^0.2` = ≥0.2.0 <0.3.0）
 * - `~x.y.z`：锁次版本（`~1.2` = ≥1.2.0 <1.3.0；`~1` = ≥1.0.0 <2.0.0）
 * - `>=x.y.z`：只有下界
 * - `x.y.z` 或 `=x.y.z`：精确；省略的段视同通配（`1.2` = ≥1.2.0 <1.3.0）
 * 认不出返回 null。
 */
function parseRange(range: string): VersionRange | null {
  const m = RANGE_RE.exec(range.trim());
  if (!m) return null;
  const op = m[1] ?? '=';
  const major = Number(m[2]);
  const minor = m[3] === undefined ? undefined : Number(m[3]);
  const patch = m[4] === undefined ? undefined : Number(m[4]);
  const min = `${major}.${minor ?? 0}.${patch ?? 0}`;
  const v = (a: number, b: number, c: number) => `${a}.${b}.${c}`;

  switch (op) {
    case '>=':
      return { min, maxExclusive: null };
    case '~':
      return {
        min,
        maxExclusive: minor === undefined ? v(major + 1, 0, 0) : v(major, minor + 1, 0),
      };
    case '^':
      if (major > 0 || minor === undefined) return { min, maxExclusive: v(major + 1, 0, 0) };
      if (minor > 0 || patch === undefined) return { min, maxExclusive: v(0, minor + 1, 0) };
      return { min, maxExclusive: v(0, 0, patch + 1) };
    default:
      if (minor === undefined) return { min, maxExclusive: v(major + 1, 0, 0) };
      if (patch === undefined) return { min, maxExclusive: v(major, minor + 1, 0) };
      return { min, maxExclusive: v(major, minor, patch + 1) };
  }
}

/**
 * 宿主 API 版本是否满足插件声明的 `pluginApi` 范围。范围写法见 `parseRange`；
 * 认不出的范围或版本一律返回 false（保守拒绝）。
 */
export function satisfiesPluginApi(range: string, version: string = PLUGIN_API_VERSION): boolean {
  if (typeof range !== 'string' || typeof version !== 'string') return false;
  const parsed = parseRange(range);
  if (parsed === null) return false;
  if (!semverGte(version, parsed.min)) return false;
  return parsed.maxExclusive === null || !semverGte(version, parsed.maxExclusive);
}
