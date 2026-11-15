import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { canaryNonceFromUrl, isValidCanaryNonce } from '../plugin-canary';
import type { CanaryHitMeta, CanaryStore } from '../plugin-canary';
import { listPlugins, readPluginFile } from '../plugin-dir';
import type {
  PluginDirEntry,
  ReadPluginFileErrorCode,
  ResolvePluginsDirResult,
} from '../plugin-dir';

/**
 * 插件 BFF 路由 —— 挂在 `/api/plugins`（设计文档 §4.6、§4.8）。
 *
 * - `GET /`                              列插件目录
 * - `GET /:id/file?path=`                取包内单个文件的字节
 * - `GET /__selfcheck/register?n=csv`    登记金丝雀 nonce
 * - `GET /__selfcheck/hits?n=csv`        查金丝雀命中
 * - `ALL /__canary/:nonce`               金丝雀记录端点（命中由 app 最前面的记录器记下）
 * - `GET /__canary-redirect/:nonce?host=` 302 到另一个 loopback 主机名上的金丝雀（S5）
 *
 * 🔒 只读：本文件不出现任何写盘、改名、删除、建目录或解析真实路径的调用（结构闸门扫描）。
 * 🔒 除两条金丝雀路由外，一律只接受同源请求（`Sec-Fetch-Site: same-origin`），
 *    只注册 GET（HEAD 由 Hono 随 GET 一并处理），其余方法 405。
 *    全局 CORS 是 `*`，这条前缀不能跟着放开，所以响应里剥掉 `Access-Control-Allow-Origin`。
 */

/** 挂载前缀（与 `server/app.ts` 路由表里那一行一致） */
const PLUGINS_PREFIX = '/api/plugins';

/** 金丝雀记录端点前缀 —— 只有这一条记命中 */
const CANARY_RECORD_PREFIX = `${PLUGINS_PREFIX}/__canary/`;

/** 两条金丝雀路由（记录 + 重定向）的路径判据 */
const CANARY_PATH_RE = /^\/api\/plugins\/__canary(?:-redirect)?\//;

/** 一次登记 / 查询最多带多少个 nonce */
const MAX_NONCES_PER_CALL = 128;

/** 重定向端点只肯跳到这几个 loopback 主机名（S5） */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * 文件响应的固定头（§4.6）。错误与列表响应同样带上除 `Content-Disposition` 以外的几条：
 * 即使有人把浏览器直接导航到这些地址，也既不会按 HTML/SVG 渲染，也不会被缓存。
 */
const FIXED_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "sandbox; default-src 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** 读文件失败码 → HTTP 状态码 */
const READ_ERROR_STATUS: Readonly<Record<ReadPluginFileErrorCode, ContentfulStatusCode>> = {
  INVALID_ID: 400,
  INVALID_PATH: 400,
  TYPE_NOT_ALLOWED: 400,
  NOT_FOUND: 404,
  LINK: 403,
  NOT_FILE: 403,
  TOO_LARGE: 413,
  CHANGED: 409,
};

export interface PluginRoutesOptions {
  /** `resolvePluginsDir` 的结果；`ok: false` 时列表回 `enabled: false`，文件路由回 503 */
  pluginsDir: ResolvePluginsDirResult;
  /** 与 app 最前面的记录器、`upgrade` 处理器共用的那一份金丝雀存储 */
  canaryStore: CanaryStore;
}

/** 列表里单个插件的形状（契约字段；不下发 `skipped`） */
type PluginListingEntry = Pick<
  PluginDirEntry,
  'id' | 'manifestText' | 'files' | 'totalBytes' | 'error'
>;

/** `GET /api/plugins` 的响应体 */
export type PluginListingResponse =
  | {
      enabled: true;
      dir: string;
      dirExists: boolean;
      plugins: PluginListingEntry[];
    }
  | { enabled: false; reason: string; message: string };

/**
 * 这条请求 URL 是不是插件路由前缀本身（`/api/plugins`、`/api/plugins/…`、`/api/plugins?…`）。
 * vite 的插件目录拒绝中间件靠它放行 —— 这些请求只会进 Hono，不会落到静态文件服务。
 */
export function isPluginsApiPath(url: string): boolean {
  return (
    url === PLUGINS_PREFIX ||
    url.startsWith(`${PLUGINS_PREFIX}/`) ||
    url.startsWith(`${PLUGINS_PREFIX}?`)
  );
}

/** 这条路径是不是两条金丝雀路由之一（记录或重定向；不看查询串） */
export function isPluginCanaryPath(url: string): boolean {
  return CANARY_PATH_RE.test(url);
}

/**
 * 金丝雀记录器 —— 必须挂成 Hono app 的**第一个**中间件（§4.8）。
 *
 * 排在 `Origin: null` 守卫、CORS 与同源检查之前：探针帧发来的请求先记命中，
 * 后面的守卫再决定回什么。只认 `/api/plugins/__canary/:nonce`，重定向端点不记
 * （否则 S5 的第一跳本身就算命中，「重定向被 CSP 拦住」永远测不出来）。
 */
export function createCanaryRecorder(store: CanaryStore): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path.startsWith(CANARY_RECORD_PREFIX)) {
      const nonce = canaryNonceFromUrl(c.req.path);
      if (nonce !== null) {
        const meta: CanaryHitMeta = { via: 'http', method: c.req.method };
        store.record(nonce, meta);
      }
    }
    await next();
  };
}

/** 把 `?n=a,b,c` 切成 nonce 列表；缺省、为空或条数超限返回 `null` */
function parseNonceList(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const nonces = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (nonces.length === 0 || nonces.length > MAX_NONCES_PER_CALL) return null;
  return nonces;
}

/**
 * 同源判定：`Sec-Fetch-Site` 必须是 `same-origin`；带了 `Origin` 的，还必须与本请求自身的
 * origin 一致。缺 `Sec-Fetch-Site`（非安全上下文，如局域网 IP 走 HTTP）一律按跨源处理 ——
 * 插件在那种环境下本就不可用（计划 §5）。
 */
function isSameOriginRequest(c: Context): boolean {
  if (c.req.header('Sec-Fetch-Site') !== 'same-origin') return false;
  const origin = c.req.header('Origin');
  if (origin === undefined) return true;
  return origin === new URL(c.req.url).origin;
}

function jsonError(c: Context, status: ContentfulStatusCode, error: string, message: string) {
  return c.json({ error, message }, status);
}

/** 把插件目录条目裁成契约形状 */
function toListingEntry(entry: PluginDirEntry): PluginListingEntry {
  const out: PluginListingEntry = {
    id: entry.id,
    manifestText: entry.manifestText,
    files: entry.files,
    totalBytes: entry.totalBytes,
  };
  if (entry.error !== undefined) out.error = entry.error;
  return out;
}

export function createPluginRoutes(options: PluginRoutesOptions): Hono {
  const { pluginsDir, canaryStore } = options;
  const app = new Hono();

  app.use('*', async (c, next) => {
    const canary = isPluginCanaryPath(c.req.path);
    if (!canary) {
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        c.header('Allow', 'GET, HEAD');
        return jsonError(c, 405, 'METHOD_NOT_ALLOWED', '插件路由只接受 GET');
      }
      if (!isSameOriginRequest(c)) {
        return jsonError(c, 403, 'CROSS_ORIGIN', '插件路由只接受同源请求');
      }
    }
    await next();
    // 全局 CORS 中间件给所有响应都加了 `*`；这条前缀不对任何跨源读者开放
    c.res.headers.delete('Access-Control-Allow-Origin');
    c.res.headers.delete('Access-Control-Expose-Headers');
    if (!canary) {
      for (const [name, value] of Object.entries(FIXED_HEADERS)) c.res.headers.set(name, value);
    }
  });

  // ── 金丝雀（不做同源检查；命中已由 app 最前面的记录器记下）──────────────

  app.all('/__canary/:nonce', (c) => c.body(null, 204));

  app.get('/__canary-redirect/:nonce', (c) => {
    const nonce = c.req.param('nonce');
    if (!isValidCanaryNonce(nonce)) return jsonError(c, 400, 'INVALID_NONCE', 'nonce 格式不合法');
    const host = c.req.query('host') ?? '';
    if (!LOOPBACK_HOSTS.has(host)) {
      return jsonError(c, 400, 'INVALID_HOST', '只允许跳到 localhost、127.0.0.1 或 [::1]');
    }
    // 端口与协议沿用本请求自身的，不接受调用方指定
    const self = new URL(c.req.url);
    const port = self.port === '' ? '' : `:${self.port}`;
    const location = `${self.protocol}//${host}${port}${CANARY_RECORD_PREFIX}${nonce}`;
    c.header('Cache-Control', 'no-store');
    return c.redirect(location, 302);
  });

  // ── 自检用的金丝雀登记与查询（同源）───────────────────────────────

  app.get('/__selfcheck/register', (c) => {
    const nonces = parseNonceList(c.req.query('n'));
    if (nonces === null) return jsonError(c, 400, 'INVALID_NONCES', 'nonce 列表为空或超过上限');
    if (!canaryStore.register(nonces)) {
      return jsonError(c, 400, 'REGISTER_REJECTED', 'nonce 格式不合法或登记数已达上限');
    }
    return c.json({ ok: true, count: nonces.length });
  });

  app.get('/__selfcheck/hits', (c) => {
    const nonces = parseNonceList(c.req.query('n'));
    if (nonces === null) return jsonError(c, 400, 'INVALID_NONCES', 'nonce 列表为空或超过上限');
    return c.json({ hits: canaryStore.hits(nonces) });
  });

  // ── 插件目录 ──────────────────────────────────────────────────

  app.get('/', async (c) => {
    if (!pluginsDir.ok) {
      const body: PluginListingResponse = {
        enabled: false,
        reason: pluginsDir.reason,
        message: pluginsDir.message,
      };
      return c.json(body);
    }
    const listed = await listPlugins(pluginsDir.dir);
    if (!listed.ok) {
      const body: PluginListingResponse = {
        enabled: false,
        reason: listed.code,
        message: listed.message,
      };
      return c.json(body);
    }
    const body: PluginListingResponse = {
      enabled: true,
      dir: pluginsDir.dir,
      dirExists: listed.dirExists,
      plugins: listed.plugins.map(toListingEntry),
    };
    return c.json(body);
  });

  app.get('/:id/file', async (c) => {
    if (!pluginsDir.ok) return jsonError(c, 503, 'PLUGINS_DISABLED', pluginsDir.message);
    const relPath = c.req.query('path');
    if (relPath === undefined || relPath === '') {
      return jsonError(c, 400, 'INVALID_PATH', '缺少 path 参数');
    }
    const result = await readPluginFile(pluginsDir.dir, c.req.param('id'), relPath);
    if (!result.ok)
      return jsonError(c, READ_ERROR_STATUS[result.code], result.code, result.message);
    // 🔴 一律 octet-stream + attachment，绝不按扩展名回真实类型（§4.6）
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', 'attachment');
    return c.body(new Uint8Array(result.bytes), 200);
  });

  return app;
}
