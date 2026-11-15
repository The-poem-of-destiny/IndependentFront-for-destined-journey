/**
 * plugin-client.ts — 本地插件文件夹 BFF 的浏览器侧客户端（设计 §3.3）
 *
 * 浏览器列不了目录，由 BFF 只读提供。本模块只做两件事:
 *
 * 1. `fetchLocalPlugins()` — `GET /api/plugins`，拿插件清单（逐个文件的大小与 sha256）。
 * 2. `fetchLocalPluginFile()` — `GET /api/plugins/:id/file?path=`，取单个文件字节，并用
 *    `crypto.subtle` 复核 sha256。清单与取文件之间文件可能被改，哈希对不上就拒收，
 *    安装计划因此只会落下与清单一致的字节。
 *
 * ⚠️ **永不抛**：网络失败、HTTP 非 2xx、响应形状不对、哈希不符一律返回 `{ ok:false, code }`。
 * 只用相对地址（同源 BFF），不带凭据以外的任何东西；`fetch` 可注入，测试不发真实请求。
 */

import { hashMediaBytes } from './media-hash';

/** 清单里单个插件目录的摘要（与 BFF `GET /api/plugins` 一致） */
export interface LocalPluginEntry {
  id: string;
  manifestText: string | null;
  files: { path: string; size: number; sha256: string }[];
  totalBytes: number;
  error?: string;
}

/** `GET /api/plugins` 的两种形状：功能开着 / 被关掉（目录配置非法等） */
export type LocalPluginListing =
  | { enabled: true; dir: string; dirExists: boolean; plugins: LocalPluginEntry[] }
  | { enabled: false; reason: string; message: string };

type PluginClientErrorCode = 'NETWORK' | 'HTTP' | 'PARSE' | 'HASH_MISMATCH' | 'HASH_UNAVAILABLE';

export type PluginClientResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: PluginClientErrorCode; message: string; status?: number };

export interface PluginClientOptions {
  /** 注入的 fetch；不传时用全局 fetch */
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

const LIST_URL = '/api/plugins';

type Failure = Extract<PluginClientResult<never>, { ok: false }>;

function fail(code: PluginClientErrorCode, message: string, status?: number): Failure {
  return status === undefined ? { ok: false, code, message } : { ok: false, code, message, status };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 发请求；网络层异常与非 2xx 都转成失败结果 */
async function send(
  url: string,
  options: PluginClientOptions,
): Promise<{ ok: true; response: Response } | Failure> {
  const impl = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await impl(url, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (e) {
    return fail('NETWORK', `无法连接本地服务：${errorText(e)}`);
  }
  if (!response.ok) {
    let detail = '';
    try {
      const body = (await response.json()) as { code?: unknown; message?: unknown };
      if (typeof body?.message === 'string') detail = body.message;
      else if (typeof body?.code === 'string') detail = body.code;
    } catch {
      // 错误体不是 JSON，只报状态码
    }
    return fail(
      'HTTP',
      `本地服务返回 ${response.status}${detail ? `：${detail}` : ''}`,
      response.status,
    );
  }
  return { ok: true, response };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFileEntry(v: unknown): v is LocalPluginEntry['files'][number] {
  return (
    isRecord(v) &&
    typeof v.path === 'string' &&
    typeof v.size === 'number' &&
    typeof v.sha256 === 'string'
  );
}

function parseEntry(v: unknown): LocalPluginEntry | null {
  if (!isRecord(v)) return null;
  if (typeof v.id !== 'string') return null;
  if (v.manifestText !== null && typeof v.manifestText !== 'string') return null;
  if (!Array.isArray(v.files) || !v.files.every(isFileEntry)) return null;
  if (typeof v.totalBytes !== 'number') return null;
  if (v.error !== undefined && typeof v.error !== 'string') return null;
  return {
    id: v.id,
    manifestText: v.manifestText,
    files: v.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
    totalBytes: v.totalBytes,
    ...(typeof v.error === 'string' ? { error: v.error } : {}),
  };
}

function parseListing(raw: unknown): LocalPluginListing | null {
  if (!isRecord(raw)) return null;
  if (raw.enabled === false) {
    if (typeof raw.reason !== 'string' || typeof raw.message !== 'string') return null;
    return { enabled: false, reason: raw.reason, message: raw.message };
  }
  if (raw.enabled !== true) return null;
  if (typeof raw.dir !== 'string' || typeof raw.dirExists !== 'boolean') return null;
  if (!Array.isArray(raw.plugins)) return null;
  const plugins: LocalPluginEntry[] = [];
  for (const item of raw.plugins) {
    const entry = parseEntry(item);
    if (!entry) return null;
    plugins.push(entry);
  }
  return { enabled: true, dir: raw.dir, dirExists: raw.dirExists, plugins };
}

/** 取本地插件文件夹清单 */
export async function fetchLocalPlugins(
  options: PluginClientOptions = {},
): Promise<PluginClientResult<LocalPluginListing>> {
  const sent = await send(LIST_URL, options);
  if (!sent.ok) return sent;
  let raw: unknown;
  try {
    raw = await sent.response.json();
  } catch (e) {
    return fail('PARSE', `插件清单不是合法 JSON：${errorText(e)}`);
  }
  const listing = parseListing(raw);
  if (!listing) return fail('PARSE', '插件清单的格式不对');
  return { ok: true, value: listing };
}

/**
 * 取单个插件文件，并核对 sha256（小写 hex，与清单一致）。
 * 浏览器算不了哈希（非安全上下文）时返回 `HASH_UNAVAILABLE`，不放行未核对的字节。
 */
export async function fetchLocalPluginFile(
  id: string,
  path: string,
  expectedSha256: string,
  options: PluginClientOptions = {},
): Promise<PluginClientResult<Uint8Array>> {
  const url = `${LIST_URL}/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`;
  const sent = await send(url, options);
  if (!sent.ok) return sent;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await sent.response.arrayBuffer());
  } catch (e) {
    return fail('NETWORK', `读取文件内容失败：${errorText(e)}`);
  }
  const actual = await hashMediaBytes(bytes);
  if (actual === undefined) return fail('HASH_UNAVAILABLE', '当前环境无法校验文件哈希');
  if (actual !== expectedSha256.toLowerCase()) {
    return fail('HASH_MISMATCH', `文件 ${path} 的内容与清单不一致，可能刚被修改过`);
  }
  return { ok: true, value: bytes };
}
