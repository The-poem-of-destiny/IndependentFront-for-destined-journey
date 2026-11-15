import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * 插件启动自检的金丝雀记录器（设计文档 §4.8）。
 *
 * 宿主先经同源调用登记一批 nonce，再让探针帧对 `/api/plugins/__canary/:nonce`
 * 发起各种请求；BFF 就在 loopback 上，所以某个 nonce「零命中」直接等于
 * 「该手段够不着本机」。本文件只管内存里的登记与命中，不挂路由（路由接线在
 * `server/routes/plugins.ts`）。
 *
 * 🔒 只记事先登记过且未过期的 nonce；nonce 格式严格、总条数有上限，
 *    防止任意来源借记录路由往进程里灌数据。
 */

/** 默认有效期：60 秒（§4.8） */
export const CANARY_DEFAULT_TTL_MS = 60_000;

/** 默认同时存活的 nonce 上限 */
export const CANARY_DEFAULT_MAX_NONCES = 512;

/** nonce 格式：16–64 位的 `[A-Za-z0-9_-]`，不接受百分号编码或其他字符 */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** 记录路由与重定向路由的路径（不含查询串） */
const CANARY_PATH_PATTERN = /^\/api\/plugins\/__canary(?:-redirect)?\/([^/?#]*)$/;

/** 命中的附带信息：从哪条通道来、用的什么方法 */
export interface CanaryHitMeta {
  via?: 'http' | 'websocket';
  method?: string;
}

interface CanaryEntry {
  expiresAt: number;
  hit: boolean;
  hitAt?: number;
  meta?: CanaryHitMeta;
}

export interface CanaryStoreOptions {
  /** nonce 自登记起的有效期（毫秒），缺省 60 秒 */
  ttlMs?: number;
  /** 同时存活的 nonce 上限 */
  maxNonces?: number;
  /** 注入时钟，测试用 */
  now?: () => number;
}

export interface CanaryStore {
  /**
   * 登记一批 nonce。全有或全无：任一 nonce 格式不合法，或登记后会超过上限，
   * 就一个都不登记并返回 `false`。重复登记同一 nonce 会刷新有效期但保留已有命中。
   */
  register(nonces: readonly string[]): boolean;
  /** 记一次命中。只对已登记且未过期的 nonce 生效，返回是否记下 */
  record(nonce: string, meta?: CanaryHitMeta): boolean;
  /** 查询命中。未登记、已过期或格式不合法的 nonce 一律视为未命中 */
  hits(nonces: readonly string[]): Record<string, boolean>;
  /** 当前存活的 nonce 条数（先清掉过期项） */
  size(): number;
}

/** nonce 是否符合严格格式 */
export function isValidCanaryNonce(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && NONCE_PATTERN.test(nonce);
}

export function createCanaryStore(options: CanaryStoreOptions = {}): CanaryStore {
  const ttlMs = options.ttlMs ?? CANARY_DEFAULT_TTL_MS;
  const maxNonces = options.maxNonces ?? CANARY_DEFAULT_MAX_NONCES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, CanaryEntry>();

  /** 清掉过期项；有效期截止时刻本身即视为过期 */
  function prune(at: number): void {
    for (const [nonce, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(nonce);
    }
  }

  function liveEntry(nonce: string, at: number): CanaryEntry | undefined {
    const entry = entries.get(nonce);
    if (!entry) return undefined;
    if (entry.expiresAt <= at) {
      entries.delete(nonce);
      return undefined;
    }
    return entry;
  }

  return {
    register(nonces) {
      if (nonces.length === 0) return true;
      if (!nonces.every(isValidCanaryNonce)) return false;
      const at = now();
      prune(at);
      const fresh = new Set(nonces.filter((nonce) => !entries.has(nonce)));
      if (entries.size + fresh.size > maxNonces) return false;
      const expiresAt = at + ttlMs;
      for (const nonce of nonces) {
        const existing = entries.get(nonce);
        if (existing) existing.expiresAt = expiresAt;
        else entries.set(nonce, { expiresAt, hit: false });
      }
      return true;
    },

    record(nonce, meta) {
      if (!isValidCanaryNonce(nonce)) return false;
      const at = now();
      const entry = liveEntry(nonce, at);
      if (!entry) return false;
      // 只留第一次命中的时刻与信息，后续命中不覆盖
      if (!entry.hit) {
        entry.hit = true;
        entry.hitAt = at;
        if (meta) entry.meta = { ...meta };
      }
      return true;
    },

    hits(nonces) {
      const at = now();
      const result: Record<string, boolean> = {};
      for (const nonce of nonces) {
        if (!isValidCanaryNonce(nonce)) continue;
        result[nonce] = liveEntry(nonce, at)?.hit ?? false;
      }
      return result;
    },

    size() {
      prune(now());
      return entries.size;
    },
  };
}

/**
 * 从请求 URL 里取金丝雀 nonce。只认 `/api/plugins/__canary/:nonce` 与
 * `/api/plugins/__canary-redirect/:nonce`（可带查询串）；路径多一段、少一段、
 * nonce 格式不对，一律返回 `null`。
 */
export function canaryNonceFromUrl(url: string): string | null {
  const path = url.split(/[?#]/, 1)[0] ?? '';
  const match = CANARY_PATH_PATTERN.exec(path);
  if (!match) return null;
  const nonce = match[1];
  return isValidCanaryNonce(nonce) ? nonce : null;
}

/**
 * 给 Node http 服务挂金丝雀的 WebSocket 握手处理器。
 *
 * WebSocket 握手走 `upgrade` 事件，不经过 Hono 与 Vite 中间件，所以要另挂。
 * 金丝雀路径：记命中后直接销毁套接字。
 * 🔴 其他路径一概不碰 —— Vite HMR 共用这个事件，销毁或应答别人的套接字会弄断热更新。
 *
 * 返回解除挂载的函数。
 */
export function attachCanaryUpgradeHandler(httpServer: Server, store: CanaryStore): () => void {
  const onUpgrade = (request: IncomingMessage, socket: Duplex): void => {
    const nonce = canaryNonceFromUrl(request.url ?? '');
    if (nonce === null) return;
    store.record(nonce, { via: 'websocket', method: request.method ?? 'GET' });
    socket.destroy();
  };
  httpServer.on('upgrade', onUpgrade);
  return () => {
    httpServer.off('upgrade', onUpgrade);
  };
}
