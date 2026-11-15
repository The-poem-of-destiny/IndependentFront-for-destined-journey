import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

/**
 * 本地插件目录的只读访问（设计文档 §3.3、§4.6 红线 C）。
 *
 * 🔴 本文件只读：结构闸门会扫描它，不得出现任何写入、改名、删除、建目录类的 fs 调用，
 *    也不得调用「解析真实路径」那一族函数 —— 后者会跟随链接，链接指向 UNC 路径时
 *    会触发 SMB 外连并泄漏 NTLM 凭据。路径安全只靠「逐段校验 + 逐级 lstat/readlink」。
 *
 * 🔴 server 自成一体，不 import `src/core`：扩展名表与路径规则在 core 里另有一份
 *    （`src/core/plugins/plugin-surface.ts`），两份由一致性测试钉住。
 */

/** 插件包允许的文件类型（扩展名 → MIME），与 core 的 `PLUGIN_FILE_TYPES` 保持一致 */
export const PLUGIN_FILE_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html',
  htm: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

/** 目录访问的各项上限 */
export const PLUGIN_DIR_LIMITS = {
  /** 单文件 5MB */
  maxFileBytes: 5 * 1024 * 1024,
  /** 单插件合计 20MB */
  maxPluginBytes: 20 * 1024 * 1024,
  /** manifest.json 上限 64KB */
  maxManifestBytes: 64 * 1024,
  /** 单个路径段的最大长度（UTF-16 码元） */
  maxSegmentLength: 128,
  /** 相对路径整体最大长度 */
  maxPathLength: 512,
  /** 相对路径最大段数（含文件名） */
  maxDepth: 16,
  /** 单插件最多文件数 */
  maxFiles: 1000,
} as const;

/** 插件 id 规则（§3.2），一级子目录名必须满足它才会被列出 */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/** Windows 保留设备名（带不带扩展名都算；含上标数字变体与控制台设备） */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/i;

/** Windows 文件名非法字符（`\` 与 `:` 单独给原因，这里是其余几个） */
const WINDOWS_INVALID_CHARS_RE = /[<>"|?*]/;

/** 控制字符：C0、DEL、C1 */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/;

// ─────────────────────────────────────────────────────────────────────────────
// 目录位置
// ─────────────────────────────────────────────────────────────────────────────

export type ResolvePluginsDirResult =
  | { ok: true; dir: string; source: 'env' | 'default' }
  | {
      ok: false;
      dir: string;
      reason: 'inside-public' | 'inside-dist-ui' | 'inside-root' | 'contains-root';
      message: string;
    };

/** `child` 是否等于 `parent` 或位于其下（沿用 resolve + relative 的包含判定） */
function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 解析插件目录：`POEM_PLUGINS_DIR` 覆盖，缺省为仓库上一级的 `poem-plugins/`。
 *
 * 🔴 解析结果落在 Vite 可服务的范围里（仓库根、`public/`、`dist-ui/`）一律拒绝：
 *    否则任何网页把浏览器导航过去，插件文件就在应用 origin 里执行。反过来，
 *    插件目录**包含**仓库根也拒绝 —— 那样仓库本身会被当成插件目录的一部分列出。
 *    纯函数，不碰文件系统，不抛错。
 */
export function resolvePluginsDir(
  env: Readonly<Record<string, string | undefined>>,
  repoRoot: string,
): ResolvePluginsDirResult {
  const root = resolve(repoRoot);
  const raw = env.POEM_PLUGINS_DIR?.trim();
  const source = raw ? 'env' : 'default';
  const dir = raw ? resolve(root, raw) : resolve(root, '..', 'poem-plugins');

  const fail = (reason: Extract<ResolvePluginsDirResult, { ok: false }>['reason']) => {
    const messages: Record<typeof reason, string> = {
      'inside-public': `插件目录 ${dir} 位于 public/ 之内，会被开发服务器按同源直接返回，已拒绝启用`,
      'inside-dist-ui': `插件目录 ${dir} 位于 dist-ui/ 之内，会被预览服务器按同源直接返回，已拒绝启用`,
      'inside-root': `插件目录 ${dir} 位于仓库根目录之内，会被开发服务器按同源直接返回，已拒绝启用`,
      'contains-root': `插件目录 ${dir} 包含仓库根目录，已拒绝启用`,
    };
    return { ok: false as const, dir, reason, message: messages[reason] };
  };

  if (isInsideOrEqual(dir, join(root, 'public'))) return fail('inside-public');
  if (isInsideOrEqual(dir, join(root, 'dist-ui'))) return fail('inside-dist-ui');
  if (isInsideOrEqual(dir, root)) return fail('inside-root');
  if (isInsideOrEqual(root, dir)) return fail('contains-root');
  return { ok: true, dir, source };
}

// ─────────────────────────────────────────────────────────────────────────────
// 路径段校验（§4.6）
// ─────────────────────────────────────────────────────────────────────────────

/** 校验单个路径段；合法返回 `null`，否则返回中文原因 */
export function checkPluginPathSegment(segment: string): string | null {
  if (segment === '') return '空路径段';
  if (segment === '.' || segment === '..') return `不允许的路径段「${segment}」`;
  if (segment.length > PLUGIN_DIR_LIMITS.maxSegmentLength) return '路径段过长';
  if (segment.includes('\\')) return '路径段含反斜杠';
  if (segment.includes('/')) return '路径段含斜杠';
  if (segment.includes(':')) return '路径段含冒号（盘符或 NTFS 备用数据流）';
  if (CONTROL_CHARS_RE.test(segment)) return '路径段含控制字符';
  if (WINDOWS_INVALID_CHARS_RE.test(segment)) return '路径段含 Windows 非法字符';
  if (/[. ]$/.test(segment)) return '路径段以点或空格结尾';
  // 保留名的判定取第一个点之前的部分并去掉尾随空格：`NUL.txt`、`con .js` 都算
  const stem = segment.split('.')[0].replace(/ +$/, '');
  if (WINDOWS_RESERVED_RE.test(stem)) return `Windows 保留设备名「${stem}」`;
  return null;
}

export type PluginRelPathCheck = { ok: true; segments: string[] } | { ok: false; reason: string };

/** 校验插件包内的相对路径（`/` 分隔）；任何一段不合法都整体拒绝 */
export function checkPluginRelPath(path: string): PluginRelPathCheck {
  if (path.length === 0) return { ok: false, reason: '路径为空' };
  if (path.length > PLUGIN_DIR_LIMITS.maxPathLength) return { ok: false, reason: '路径过长' };
  const segments = path.split('/');
  if (segments.length > PLUGIN_DIR_LIMITS.maxDepth) return { ok: false, reason: '路径层级过深' };
  for (const segment of segments) {
    const reason = checkPluginPathSegment(segment);
    if (reason !== null) return { ok: false, reason };
  }
  return { ok: true, segments };
}

/** 插件 id（即一级子目录名）是否合法 */
export function isValidPluginId(id: string): boolean {
  return PLUGIN_ID_RE.test(id) && checkPluginPathSegment(id) === null;
}

/** 按扩展名查 MIME；不在白名单里返回 `null` */
export function pluginFileMime(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(PLUGIN_FILE_TYPES, ext)
    ? PLUGIN_FILE_TYPES[ext]
    : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 不跟随链接的文件系统访问
// ─────────────────────────────────────────────────────────────────────────────

type NoLinkStat = { kind: 'ok'; stats: Stats } | { kind: 'missing' } | { kind: 'link' };

/**
 * `lstat` 一个路径并确认它不是链接。
 *
 * 🔴 Windows 上 `lstat` 对目录联接的判定未经验证，所以再用 `readlink` 交叉确认：
 *    `readlink` 不抛错就视为链接。
 */
async function lstatNoLink(absPath: string): Promise<NoLinkStat> {
  let stats: Stats;
  try {
    stats = await lstat(absPath);
  } catch {
    return { kind: 'missing' };
  }
  if (stats.isSymbolicLink()) return { kind: 'link' };
  try {
    await readlink(absPath);
    return { kind: 'link' };
  } catch {
    // 预期路径：不是链接
  }
  return { kind: 'ok', stats };
}

type ReadBytesResult = { ok: true; bytes: Buffer } | { ok: false; code: 'CHANGED' | 'TOO_LARGE' };

/**
 * 打开并读出一个已 lstat 过的普通文件。
 *
 * 打开后用句柄的 stat 比对 dev/ino：lstat 与打开之间文件被换成链接时，打开会跟随链接，
 * 两者的 inode 对不上就拒绝。读取量以 `maxBytes` 封顶，读的过程中文件变大同样拒绝。
 */
async function readCheckedFile(
  absPath: string,
  expected: Stats,
  maxBytes: number,
): Promise<ReadBytesResult> {
  const handle = await open(absPath, 'r');
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.ino !== expected.ino || actual.dev !== expected.dev) {
      return { ok: false, code: 'CHANGED' };
    }
    if (actual.size > maxBytes) return { ok: false, code: 'TOO_LARGE' };
    // 多留 1 字节，用来发现读取期间文件变大
    const buffer = Buffer.alloc(actual.size + 1);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > actual.size) return { ok: false, code: 'TOO_LARGE' };
    }
    return { ok: true, bytes: buffer.subarray(0, offset) };
  } finally {
    await handle.close();
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// 列目录
// ─────────────────────────────────────────────────────────────────────────────

interface PluginDirFile {
  /** 包内相对路径，`/` 分隔 */
  path: string;
  size: number;
  sha256: string;
}

interface PluginDirSkipped {
  path: string;
  reason: string;
}

export interface PluginDirEntry {
  id: string;
  /** 根部 `manifest.json` 的原文；没有该文件为 `null` */
  manifestText: string | null;
  files: PluginDirFile[];
  totalBytes: number;
  /** 名字不合法或类型不在白名单而被略过的条目（不进 `files`、不计哈希） */
  skipped: PluginDirSkipped[];
  /** 有值 = 整个插件不可用（含链接、超限等），此时 `files` 为空 */
  error?: string;
}

export type ListPluginsResult =
  | { ok: true; dirExists: boolean; plugins: PluginDirEntry[] }
  | { ok: false; code: 'DIR_IS_LINK' | 'DIR_NOT_DIRECTORY'; message: string };

class PluginScanError extends Error {}

interface ScannedFile {
  path: string;
  absPath: string;
  stats: Stats;
}

async function scanPluginTree(
  absDir: string,
  relPrefix: string,
  depth: number,
  out: ScannedFile[],
  skipped: PluginDirSkipped[],
): Promise<void> {
  const names = (await readdir(absDir)).sort();
  for (const name of names) {
    const relPath = relPrefix ? `${relPrefix}/${name}` : name;
    const absPath = join(absDir, name);
    const probe = await lstatNoLink(absPath);
    // 链接无论名字是否合法都让整个插件不可用：静默略过会掩盖可疑布局
    if (probe.kind === 'link') throw new PluginScanError(`包内含符号链接或目录联接：${relPath}`);
    if (probe.kind === 'missing') continue;
    const segmentReason = checkPluginPathSegment(name);
    if (segmentReason !== null) {
      skipped.push({ path: relPath, reason: segmentReason });
      continue;
    }
    if (probe.stats.isDirectory()) {
      if (depth + 1 >= PLUGIN_DIR_LIMITS.maxDepth) {
        throw new PluginScanError(`目录层级过深：${relPath}`);
      }
      await scanPluginTree(absPath, relPath, depth + 1, out, skipped);
      continue;
    }
    if (!probe.stats.isFile()) {
      skipped.push({ path: relPath, reason: '不是普通文件' });
      continue;
    }
    if (relPath.length > PLUGIN_DIR_LIMITS.maxPathLength) {
      skipped.push({ path: relPath, reason: '路径过长' });
      continue;
    }
    if (pluginFileMime(name) === null) {
      skipped.push({ path: relPath, reason: '文件类型不在白名单内' });
      continue;
    }
    if (probe.stats.size > PLUGIN_DIR_LIMITS.maxFileBytes) {
      throw new PluginScanError(`文件超过 5MB 上限：${relPath}`);
    }
    out.push({ path: relPath, absPath, stats: probe.stats });
    if (out.length > PLUGIN_DIR_LIMITS.maxFiles) {
      throw new PluginScanError(`文件数超过 ${PLUGIN_DIR_LIMITS.maxFiles} 个上限`);
    }
  }
}

async function describePlugin(absDir: string, id: string): Promise<PluginDirEntry> {
  const entry: PluginDirEntry = { id, manifestText: null, files: [], totalBytes: 0, skipped: [] };
  const scanned: ScannedFile[] = [];
  try {
    await scanPluginTree(absDir, '', 0, scanned, entry.skipped);
    const total = scanned.reduce((sum, file) => sum + file.stats.size, 0);
    if (total > PLUGIN_DIR_LIMITS.maxPluginBytes) {
      throw new PluginScanError('插件合计超过 20MB 上限');
    }
    const files: PluginDirFile[] = [];
    let manifestText: string | null = null;
    for (const file of scanned) {
      const isManifest = file.path === 'manifest.json';
      const limit = isManifest
        ? PLUGIN_DIR_LIMITS.maxManifestBytes
        : PLUGIN_DIR_LIMITS.maxFileBytes;
      const read = await readCheckedFile(file.absPath, file.stats, limit);
      if (!read.ok) {
        throw new PluginScanError(
          read.code === 'TOO_LARGE'
            ? `文件超过上限：${file.path}`
            : `文件在扫描期间发生变化：${file.path}`,
        );
      }
      files.push({ path: file.path, size: read.bytes.length, sha256: sha256Hex(read.bytes) });
      if (isManifest) manifestText = read.bytes.toString('utf-8');
    }
    entry.files = files;
    entry.totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    entry.manifestText = manifestText;
  } catch (error) {
    entry.error =
      error instanceof PluginScanError ? error.message : `读取插件目录失败：${String(error)}`;
    entry.files = [];
    entry.totalBytes = 0;
    entry.manifestText = null;
  }
  return entry;
}

/**
 * 列出插件目录下名字合法的一级子目录及其文件清单（大小 + sha256）。
 *
 * 插件目录本身是链接时整体拒绝；不存在时 `dirExists: false`。
 * 名字不合法的一级条目与目录根部的散文件直接忽略。
 */
export async function listPlugins(pluginsDir: string): Promise<ListPluginsResult> {
  const root = await lstatNoLink(pluginsDir);
  if (root.kind === 'missing') return { ok: true, dirExists: false, plugins: [] };
  if (root.kind === 'link') {
    return {
      ok: false,
      code: 'DIR_IS_LINK',
      message: `插件目录 ${pluginsDir} 是符号链接或目录联接`,
    };
  }
  if (!root.stats.isDirectory()) {
    return { ok: false, code: 'DIR_NOT_DIRECTORY', message: `插件目录 ${pluginsDir} 不是目录` };
  }

  const plugins: PluginDirEntry[] = [];
  for (const name of (await readdir(pluginsDir)).sort()) {
    if (!isValidPluginId(name)) continue;
    const absDir = join(pluginsDir, name);
    const probe = await lstatNoLink(absDir);
    if (probe.kind === 'missing') continue;
    if (probe.kind === 'link') {
      plugins.push({
        id: name,
        manifestText: null,
        files: [],
        totalBytes: 0,
        skipped: [],
        error: '插件目录是符号链接或目录联接',
      });
      continue;
    }
    if (!probe.stats.isDirectory()) continue;
    plugins.push(await describePlugin(absDir, name));
  }
  return { ok: true, dirExists: true, plugins };
}

// ─────────────────────────────────────────────────────────────────────────────
// 读单个文件
// ─────────────────────────────────────────────────────────────────────────────

export type ReadPluginFileErrorCode =
  | 'INVALID_ID'
  | 'INVALID_PATH'
  | 'TYPE_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'LINK'
  | 'NOT_FILE'
  | 'TOO_LARGE'
  | 'CHANGED';

export type ReadPluginFileResult =
  | { ok: true; bytes: Buffer; size: number; mime: string; sha256: string }
  | { ok: false; code: ReadPluginFileErrorCode; message: string };

/**
 * 读插件包内的一个文件。
 *
 * 先逐段校验路径，再从插件目录起逐级 `lstat`：遇到链接直接拒绝，中间段必须是目录，
 * 最后一段必须是普通文件。`mime` 是按扩展名查到的类型，仅供调用方参考 ——
 * 路由层的响应头固定为 `application/octet-stream`（§4.6）。
 */
export async function readPluginFile(
  pluginsDir: string,
  pluginId: string,
  relPath: string,
): Promise<ReadPluginFileResult> {
  const fail = (code: ReadPluginFileErrorCode, message: string) =>
    ({ ok: false, code, message }) as const;

  if (!isValidPluginId(pluginId)) return fail('INVALID_ID', '插件 id 不合法');
  const check = checkPluginRelPath(relPath);
  if (!check.ok) return fail('INVALID_PATH', check.reason);
  const segments = check.segments;
  const mime = pluginFileMime(segments[segments.length - 1]);
  if (mime === null) return fail('TYPE_NOT_ALLOWED', '文件类型不在白名单内');

  const base = resolve(pluginsDir);
  const target = resolve(base, pluginId, ...segments);
  // 逐段校验之后理应不会越界，这里再按 resolve + relative 兜一次底
  if (!isInsideOrEqual(target, join(base, pluginId)) || target === join(base, pluginId)) {
    return fail('INVALID_PATH', '路径越界');
  }

  // 从插件目录本身开始逐级检查，最后一项是目标文件
  const chain = [base, pluginId, ...segments];
  let current = '';
  let last: Stats | null = null;
  for (let i = 0; i < chain.length; i += 1) {
    current = i === 0 ? chain[0] : join(current, chain[i]);
    const probe = await lstatNoLink(current);
    if (probe.kind === 'missing') return fail('NOT_FOUND', '文件不存在');
    if (probe.kind === 'link') return fail('LINK', '路径中含符号链接或目录联接');
    const isLast = i === chain.length - 1;
    if (!isLast && !probe.stats.isDirectory()) return fail('NOT_FOUND', '文件不存在');
    if (isLast && !probe.stats.isFile()) return fail('NOT_FILE', '目标不是普通文件');
    last = probe.stats;
  }
  if (last === null) return fail('NOT_FOUND', '文件不存在');
  if (last.size > PLUGIN_DIR_LIMITS.maxFileBytes) return fail('TOO_LARGE', '文件超过 5MB 上限');

  const read = await readCheckedFile(current, last, PLUGIN_DIR_LIMITS.maxFileBytes);
  if (!read.ok) {
    return read.code === 'TOO_LARGE'
      ? fail('TOO_LARGE', '文件超过 5MB 上限')
      : fail('CHANGED', '文件在读取期间发生变化');
  }
  return {
    ok: true,
    bytes: read.bytes,
    size: read.bytes.length,
    mime,
    sha256: sha256Hex(read.bytes),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 静态服务拦截判定
// ─────────────────────────────────────────────────────────────────────────────

/** 反复百分号解码直到不再变化（封顶 5 轮，挡多重编码）；遇到坏编码就停在当前结果 */
function decodeRepeatedly(input: string): string {
  let current = input;
  for (let i = 0; i < 5; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * 把一条 URL 路径段按 Windows 的宽松解析规整：去掉 NTFS 数据流后缀（`x::$DATA`）
 * 与尾随的点和空格（`poem-plugins.` 与 `poem-plugins` 指向同一目录）。盘符段保留。
 */
function normalizeUrlSegment(segment: string): string {
  if (/^[a-z]:$/i.test(segment)) return segment;
  const colon = segment.indexOf(':');
  const withoutStream = colon >= 0 ? segment.slice(0, colon) : segment;
  const trimmed = withoutStream.replace(/[. ]+$/, '');
  // 「.」「..」本身要留给 resolve 处理
  return trimmed === '' && /^\.+$/.test(withoutStream) ? withoutStream : trimmed;
}

function candidateFsPaths(pathPart: string, root: string): string[] {
  const slashed = pathPart.replace(/\\/g, '/').replace(/\u0000/g, '');
  const normalized = slashed.split('/').map(normalizeUrlSegment).join('/');
  const candidates = [resolve(root, `.${normalized.startsWith('/') ? '' : '/'}${normalized}`)];

  const lower = normalized.toLowerCase();
  if (lower.startsWith('/@fs/')) {
    const rest = normalized.slice('/@fs/'.length);
    candidates.push(resolve(/^[a-z]:/i.test(rest) ? rest : `/${rest}`));
  }
  // 去掉前导斜杠后像绝对路径（盘符或 posix 根）的，也按绝对路径算一次：宁可多拦
  const stripped = normalized.replace(/^\/+/, '');
  if (/^[a-z]:/i.test(stripped)) candidates.push(resolve(stripped));
  if (normalized.startsWith('/')) candidates.push(resolve(normalized));
  return candidates;
}

/**
 * 这条请求解析后会不会落进插件目录（§4.6 第三层防线）。
 *
 * 覆盖：Vite 的 `/@fs/` 绝对路径形式、百分号编码与多重编码、反斜杠、大小写混写、
 * 尾随点与空格、NTFS 数据流后缀、`..` 穿越。比较一律不分大小写 —— 在大小写敏感的
 * 文件系统上这只会多拦，不会漏拦。
 *
 * 只做字符串判定，不碰文件系统。`/api/plugins` 前缀的豁免由调用方负责。
 * 已知不覆盖：8.3 短文件名（`POEM-P~1`）—— 靠 `server.fs.deny` 与目录不在 root 内兜底。
 */
export function isRequestIntoPluginsDir(url: string, pluginsDir: string, root: string): boolean {
  // 带 scheme 与 authority 的完整 URL 只取路径部分
  const withoutOrigin = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/\\]*/i, '');
  const rawPath = withoutOrigin.split(/[?#]/)[0];
  const decodedFull = decodeRepeatedly(withoutOrigin);
  const decodedPath = decodeRepeatedly(rawPath);
  const forms = new Set([
    decodedPath,
    decodedFull,
    decodedFull.split(/[?#]/)[0],
    decodedPath.split(/[?#]/)[0],
  ]);

  const target = resolve(pluginsDir).toLowerCase();
  const base = resolve(root);
  for (const form of forms) {
    for (const candidate of candidateFsPaths(form, base)) {
      if (isInsideOrEqual(candidate.toLowerCase(), target)) return true;
    }
  }
  return false;
}
