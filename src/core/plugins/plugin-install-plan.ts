/**
 * plugin-install-plan.ts — 插件安装计划器（插件系统设计 §3.3、§3.4、§3.5）
 *
 * 为什么存在: 本地文件夹与创意工坊两条渠道共用同一个「这次安装要做什么」的决策
 * （§3.3 接入点二），口径照 `src/core/workshop/workshop-install-plan.ts`：
 * 一次安装/更新的全部判断收在一个**纯同步函数**里 —— manifest 合不合格、包里的文件
 * 合不合规、是新装/更新/没变、要不要重新过风险确认、按存档的确认是否作废。
 * store 拿到计划之后只做一件事：弹窗、照单写行。
 *
 * 判定口径:
 * - `requiresReconsent`：新装一定要确认；内容哈希变了就是更新，任何内容变化都要重新过
 *   安装确认（§3.4，内容可能整个换掉）。
 * - `invalidatesSaveConsents`：只有 `network` 的规范哈希变了，按存档的确认才作废
 *   （决策 7：确认只存在本机 `PluginRecord.saveConsents`）。
 * - `networkAdded`：更新时相对旧版本新增的域名，确认窗里高亮；新装时为空数组
 *   （确认窗的「更新」标题由「传没传 networkAdded」决定，新装不要传）。
 *
 * 🔴 文件规则（路径、扩展名、体积上限）与 `server/plugin-dir.ts` 同口径，
 *    由 tests/core/plugins/plugin-install-plan.test.ts 的一致性测试钉住。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无浏览器全局、无 `crypto`、无异常。
 */

import type { PluginManifest, PluginRecord } from '../types/types-plugin';
import { hashWorkshopContent } from '../workshop/workshop-install-plan';
import { coercePluginManifest } from './plugin-manifest';
import { canonicalNetworkHash } from './plugin-network';
import { isSafePluginRelPath, PLUGIN_FILE_TYPES, PLUGIN_LIMITS } from './plugin-surface';

/** manifest 在包内的固定位置 */
const MANIFEST_PATH = 'manifest.json';

/** 包内的一个文件（清单层面：只要路径与字节数，不要字节本身） */
export interface PluginInstallFile {
  path: string;
  size: number;
}

/** `planPluginInstall` 的输入 */
export interface PluginInstallInput {
  /** manifest 的原文（JSON 文本）或已解析的值；本地渠道直接传 `manifestText` */
  manifestRaw: unknown;
  /** 包内全部文件（含 `manifest.json`） */
  files: readonly PluginInstallFile[];
  /** 整包内容哈希，见 `computePluginContentHash` */
  contentHash: string;
  source: PluginRecord['source'];
  /** 本机已安装的同 id 记录；未安装为 `undefined` */
  existing: PluginRecord | undefined;
  /** 本地渠道的文件夹名；给了就要求与 manifest 的 id 一致 */
  folderId?: string;
}

/** 安装计划 */
export interface PluginInstallPlan {
  /** `invalid`：有错误，不可安装；`incompatible`：结构合格但本宿主满足不了；`ok`：可安装 */
  status: 'ok' | 'invalid' | 'incompatible';
  /** 相对本机已装版本：新装 / 更新（内容哈希变了）/ 没变 */
  action: 'install' | 'update' | 'unchanged';
  /** 规整后的 manifest；manifest 本身不合格时为 `null`（文件层面的错误不影响它） */
  manifest: PluginManifest | null;
  source: PluginRecord['source'];
  contentHash: string;
  /** `network` 的规范哈希；`manifest` 为 `null` 时为 `null` */
  networkHash: string | null;
  /** 更新时相对旧版本新增的域名（排序）；新装时为空数组 */
  networkAdded: string[];
  /** 是否必须重新过安装确认 */
  requiresReconsent: boolean;
  /** 是否作废本机所有按存档的确认（`network` 变了） */
  invalidatesSaveConsents: boolean;
  fileCount: number;
  totalBytes: number;
  /** 致命错误（简体中文，可直接展示）；非空即 `status = 'invalid'` */
  errors: string[];
  /** 不兼容的原因（多条以「；」连接）；兼容时缺省 */
  incompatible?: string;
  /** manifest 里被丢弃的字段的处置记录 */
  droppedNotes: string[];
}

/** 取路径最后一段的扩展名（小写、不带点）；没有扩展名或以点开头的文件名返回 null */
function fileExtension(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** 扩展名是否在白名单里（只认自有属性，`constructor` 之类不算） */
function isAllowedFileType(path: string): boolean {
  const ext = fileExtension(path);
  return ext !== null && Object.prototype.hasOwnProperty.call(PLUGIN_FILE_TYPES, ext);
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

/** 逐个文件校验路径、类型、体积；返回合法文件的路径集合与总字节数 */
function checkFiles(
  files: readonly PluginInstallFile[],
  errors: string[],
): { paths: Set<string>; totalBytes: number } {
  const paths = new Set<string>();
  let totalBytes = 0;

  if (files.length > PLUGIN_LIMITS.files) {
    errors.push(`文件数 ${files.length} 超过 ${PLUGIN_LIMITS.files} 个的上限`);
  }

  for (const file of files) {
    const path = file.path;
    if (typeof path !== 'string' || !isSafePluginRelPath(path)) {
      errors.push(`文件路径不安全：${String(path)}`);
      continue;
    }
    if (paths.has(path)) {
      errors.push(`文件重复：${path}`);
      continue;
    }
    paths.add(path);
    if (!isAllowedFileType(path)) {
      errors.push(`不允许的文件类型：${path}`);
    }
    const size = file.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      errors.push(`文件大小无效：${path}`);
      continue;
    }
    totalBytes += size;
    const limit = path === MANIFEST_PATH ? PLUGIN_LIMITS.manifestBytes : PLUGIN_LIMITS.fileBytes;
    if (size > limit) {
      errors.push(
        path === MANIFEST_PATH
          ? `manifest.json 超过 ${PLUGIN_LIMITS.manifestBytes / 1024}KB 上限`
          : `文件超过 ${formatBytes(limit)} 上限：${path}`,
      );
    }
  }

  if (totalBytes > PLUGIN_LIMITS.pluginBytes) {
    errors.push(`插件合计超过 ${formatBytes(PLUGIN_LIMITS.pluginBytes)} 上限`);
  }
  if (!paths.has(MANIFEST_PATH)) errors.push('包内缺少 manifest.json');
  return { paths, totalBytes };
}

/** manifest 引用的入口、图标、后台页面必须在包内 */
function checkReferences(manifest: PluginManifest, paths: Set<string>, errors: string[]): void {
  manifest.contributions.forEach((c, index) => {
    const at = `contributions[${index}]`;
    if (!paths.has(c.entry)) errors.push(`${at}.entry 指向的文件不在包内：${c.entry}`);
    if (c.icon !== undefined && !paths.has(c.icon)) {
      errors.push(`${at}.icon 指向的文件不在包内：${c.icon}`);
    }
  });
  if (manifest.background !== undefined && !paths.has(manifest.background)) {
    errors.push(`background 指向的文件不在包内：${manifest.background}`);
  }
}

/**
 * 出一份插件安装计划。纯函数，永不抛。
 */
export function planPluginInstall(input: PluginInstallInput): PluginInstallPlan {
  const { files, contentHash, source, existing, folderId } = input;
  const coercion = coercePluginManifest(input.manifestRaw);
  const errors = [...coercion.errors];
  const manifest = coercion.manifest;

  const { paths, totalBytes } = checkFiles(files, errors);

  if (manifest !== null) {
    checkReferences(manifest, paths, errors);
    if (folderId !== undefined && manifest.id !== folderId) {
      errors.push(`manifest 的 id「${manifest.id}」与文件夹名「${folderId}」不一致`);
    }
    if (existing !== undefined && existing.id !== manifest.id) {
      errors.push(`已安装记录的 id「${existing.id}」与 manifest 的 id「${manifest.id}」不一致`);
    }
  }

  const action: PluginInstallPlan['action'] =
    existing === undefined
      ? 'install'
      : existing.contentHash === contentHash
        ? 'unchanged'
        : 'update';

  const networkHash = manifest === null ? null : canonicalNetworkHash(manifest.network);

  let networkAdded: string[] = [];
  if (action === 'update' && manifest !== null && existing !== undefined) {
    const before = new Set(existing.manifest.network);
    networkAdded = manifest.network.filter((host) => !before.has(host)).sort();
  }

  // 没变也要看安装确认记的是不是这份内容：记录与确认对不上时宁可再问一次
  const requiresReconsent =
    action !== 'unchanged' ||
    existing === undefined ||
    existing.installConsent.contentHash !== contentHash ||
    existing.installConsent.networkHash !== networkHash;

  const invalidatesSaveConsents =
    existing !== undefined && networkHash !== null && existing.networkHash !== networkHash;

  const status: PluginInstallPlan['status'] =
    errors.length > 0 ? 'invalid' : coercion.incompatible !== undefined ? 'incompatible' : 'ok';

  const plan: PluginInstallPlan = {
    status,
    action,
    manifest,
    source,
    contentHash,
    networkHash,
    networkAdded,
    requiresReconsent,
    invalidatesSaveConsents,
    fileCount: files.length,
    totalBytes,
    errors,
    droppedNotes: coercion.droppedNotes,
  };
  if (coercion.incompatible !== undefined) plan.incompatible = coercion.incompatible;
  return plan;
}

/**
 * 整包内容哈希（16 位十六进制）：按路径排序后把「路径 + 文件 SHA-256」逐行拼起来再哈希。
 * 与文件列出的顺序、SHA-256 的大小写无关；任何一个文件的增删改都会改变它。
 * 合法路径不含控制字符，所以制表符与换行做分隔不会有歧义。
 *
 * 只用来回答「包变了没有」（§3.3 逐个比对内容哈希），不承担完整性校验 ——
 * 那由逐文件的 SHA-256 负责。
 */
export function computePluginContentHash(
  files: readonly { path: string; sha256: string }[],
): string {
  const lines = files
    .map((f) => `${f.path}\t${f.sha256.toLowerCase()}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return hashWorkshopContent(lines.join('\n'));
}
