import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachCanaryUpgradeHandler,
  CANARY_DEFAULT_MAX_NONCES,
  CANARY_DEFAULT_TTL_MS,
  canaryNonceFromUrl,
  createCanaryStore,
  isValidCanaryNonce,
} from '../server/plugin-canary';

const NONCE_A = 'aaaaaaaaaaaaaaaa';
const NONCE_B = 'bbbbbbbbbbbbbbbb_-01';
const NONCE_C = 'cccccccccccccccc';

function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('金丝雀登记与命中', () => {
  it('只记事先登记过的 nonce', () => {
    const store = createCanaryStore();
    expect(store.register([NONCE_A])).toBe(true);
    expect(store.record(NONCE_A, { via: 'http', method: 'POST' })).toBe(true);
    expect(store.record(NONCE_B)).toBe(false);
    expect(store.hits([NONCE_A, NONCE_B])).toEqual({ [NONCE_A]: true, [NONCE_B]: false });
  });

  it('登记了但没命中的 nonce 查询为 false，重复命中保持 true', () => {
    const store = createCanaryStore();
    store.register([NONCE_A, NONCE_B]);
    store.record(NONCE_A);
    store.record(NONCE_A);
    expect(store.hits([NONCE_A, NONCE_B])).toEqual({ [NONCE_A]: true, [NONCE_B]: false });
  });

  it('缺省有效期是 60 秒，到期时刻起不再记录也查不到', () => {
    expect(CANARY_DEFAULT_TTL_MS).toBe(60_000);
    const clock = fakeClock();
    const store = createCanaryStore({ now: clock.now });
    store.register([NONCE_A, NONCE_B]);
    store.record(NONCE_A);
    clock.advance(59_999);
    expect(store.record(NONCE_B)).toBe(true);
    clock.advance(1);
    expect(store.record(NONCE_C)).toBe(false);
    expect(store.hits([NONCE_A, NONCE_B])).toEqual({ [NONCE_A]: false, [NONCE_B]: false });
    expect(store.size()).toBe(0);
  });

  it('过期后才命中的 nonce 不被记录', () => {
    const clock = fakeClock();
    const store = createCanaryStore({ ttlMs: 1_000, now: clock.now });
    store.register([NONCE_A]);
    clock.advance(1_000);
    expect(store.record(NONCE_A)).toBe(false);
  });

  it('重复登记刷新有效期并保留已有命中', () => {
    const clock = fakeClock();
    const store = createCanaryStore({ ttlMs: 1_000, now: clock.now });
    store.register([NONCE_A]);
    store.record(NONCE_A);
    clock.advance(900);
    expect(store.register([NONCE_A])).toBe(true);
    clock.advance(900);
    expect(store.hits([NONCE_A])).toEqual({ [NONCE_A]: true });
  });

  it('条数上限全有或全无，过期项腾出名额', () => {
    const clock = fakeClock();
    const store = createCanaryStore({ maxNonces: 2, ttlMs: 1_000, now: clock.now });
    expect(store.register([NONCE_A, NONCE_B])).toBe(true);
    expect(store.register([NONCE_C])).toBe(false);
    expect(store.size()).toBe(2);
    expect(store.record(NONCE_C)).toBe(false);
    // 已登记的重登不占新名额
    expect(store.register([NONCE_A])).toBe(true);
    clock.advance(1_000);
    expect(store.register([NONCE_C])).toBe(true);
    expect(store.size()).toBe(1);
  });

  it('缺省上限能挡住超量登记', () => {
    const store = createCanaryStore();
    const many = Array.from(
      { length: CANARY_DEFAULT_MAX_NONCES + 1 },
      (_, i) => `n${String(i).padStart(15, '0')}`,
    );
    expect(store.register(many)).toBe(false);
    expect(store.size()).toBe(0);
    expect(store.register(many.slice(0, CANARY_DEFAULT_MAX_NONCES))).toBe(true);
    expect(store.size()).toBe(CANARY_DEFAULT_MAX_NONCES);
  });

  it('格式不合法的 nonce 整批拒登，记录与查询都忽略', () => {
    const store = createCanaryStore();
    const bad = [
      'short',
      'a'.repeat(65),
      'aaaaaaaaaaaaaaa!',
      'aaaaaaaa%2Faaaaaaa',
      'aaaaaaaa aaaaaaa',
    ];
    for (const nonce of bad) {
      expect(isValidCanaryNonce(nonce)).toBe(false);
      expect(store.register([NONCE_A, nonce])).toBe(false);
      expect(store.record(nonce)).toBe(false);
    }
    expect(store.size()).toBe(0);
    expect(store.hits(bad)).toEqual({});
    expect(isValidCanaryNonce(42)).toBe(false);
    expect(isValidCanaryNonce('a'.repeat(16))).toBe(true);
    expect(isValidCanaryNonce('a'.repeat(64))).toBe(true);
  });
});

describe('金丝雀 URL 解析', () => {
  it('认记录路由与重定向路由，可带查询串', () => {
    expect(canaryNonceFromUrl(`/api/plugins/__canary/${NONCE_A}`)).toBe(NONCE_A);
    expect(canaryNonceFromUrl(`/api/plugins/__canary/${NONCE_B}?t=1&x=y`)).toBe(NONCE_B);
    expect(canaryNonceFromUrl(`/api/plugins/__canary-redirect/${NONCE_A}?host=127.0.0.1`)).toBe(
      NONCE_A,
    );
    expect(canaryNonceFromUrl(`/api/plugins/__canary/${NONCE_A}#frag`)).toBe(NONCE_A);
  });

  it('其他路径与畸形 nonce 一律返回 null', () => {
    const rejected = [
      '',
      '/',
      '/@vite/client',
      '/api/plugins',
      '/api/plugins/__canary/',
      `/api/plugins/__canary/${NONCE_A}/`,
      `/api/plugins/__canary/${NONCE_A}/extra`,
      `/api/plugins/__canaryx/${NONCE_A}`,
      `/api/plugins/__selfcheck/hits?n=${NONCE_A}`,
      `/x/api/plugins/__canary/${NONCE_A}`,
      `http://localhost/api/plugins/__canary/${NONCE_A}`,
      '/api/plugins/__canary/short',
      '/api/plugins/__canary/aaaaaaaa%41aaaaaaa',
      `/api/plugins/__canary/../__canary/${NONCE_A}`,
    ];
    for (const url of rejected) expect(canaryNonceFromUrl(url)).toBeNull();
  });
});

describe('金丝雀 WebSocket 握手处理器', () => {
  let server: Server | null = null;

  afterEach(async () => {
    const s = server;
    server = null;
    if (s) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  async function listen(s: Server): Promise<number> {
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
    return (s.address() as AddressInfo).port;
  }

  /** 发一个 WebSocket 握手请求，返回连接被关时是否收到了任何应答 */
  function sendUpgrade(port: number, path: string): Promise<'closed' | 'upgraded'> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      });
      req.on('upgrade', (_res, socket) => {
        socket.destroy();
        resolve('upgraded');
      });
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET' || error.message.includes('socket hang up')) {
          resolve('closed');
        } else {
          reject(error);
        }
      });
      req.end();
    });
  }

  it('金丝雀路径的握手记下命中并销毁套接字', async () => {
    const store = createCanaryStore();
    store.register([NONCE_A]);
    server = createServer();
    attachCanaryUpgradeHandler(server, store);
    const port = await listen(server);

    expect(await sendUpgrade(port, `/api/plugins/__canary/${NONCE_A}?ws=1`)).toBe('closed');
    expect(store.hits([NONCE_A])).toEqual({ [NONCE_A]: true });
  });

  it('未登记的金丝雀 nonce 也销毁套接字但不记命中', async () => {
    const store = createCanaryStore();
    server = createServer();
    attachCanaryUpgradeHandler(server, store);
    const port = await listen(server);

    expect(await sendUpgrade(port, `/api/plugins/__canary/${NONCE_B}`)).toBe('closed');
    expect(store.hits([NONCE_B])).toEqual({ [NONCE_B]: false });
  });

  it('非金丝雀路径原样交给其他监听者，不销毁也不应答', async () => {
    const store = createCanaryStore();
    store.register([NONCE_A]);
    server = createServer();
    attachCanaryUpgradeHandler(server, store);
    const seen: { path: string | undefined; destroyed: boolean }[] = [];
    // 模拟 Vite HMR：它在金丝雀处理器之后才拿到同一个套接字，并自己完成握手
    server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
      seen.push({ path: request.url, destroyed: socket.destroyed });
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
    });
    const port = await listen(server);

    expect(await sendUpgrade(port, '/?token=hmr')).toBe('upgraded');
    expect(seen).toEqual([{ path: '/?token=hmr', destroyed: false }]);
    expect(store.hits([NONCE_A])).toEqual({ [NONCE_A]: false });
  });

  it('解除挂载后不再处理金丝雀握手', () => {
    const store = createCanaryStore();
    store.register([NONCE_A]);
    server = createServer();
    const detach = attachCanaryUpgradeHandler(server, store);
    detach();
    expect(server.listenerCount('upgrade')).toBe(0);
  });
});
