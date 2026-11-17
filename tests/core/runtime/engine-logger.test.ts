/**
 * engine-logger.ts — 分级闸门 / thunk 惰性 / 序列化鲁棒性 / 精确脱敏 / 回合作用域与层号 /
 * console 采集 / 批量交付 / 失败兜底。sink 用内存替身，不碰 Dexie。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_LOG_SAVE_ID,
  beginLogScope,
  configureEngineLogger,
  flushEngineLog,
  installEngineLogSink,
  isEngineLogEnabled,
  logEngine,
  NO_TURN_LAYER,
  onEngineLogStorageFull,
  registerLogSecret,
  resetEngineLoggerForTest,
} from '../../../src/core/runtime/engine-logger';
import type {
  EngineLogEntry,
  EngineLogLayerHead,
  EngineLogSink,
} from '../../../src/core/runtime/engine-logger';

class MemorySink implements EngineLogSink {
  rows: EngineLogEntry[] = [];
  batches = 0;
  heads = new Map<string, EngineLogLayerHead>();
  headCalls = 0;
  failWith: unknown = null;
  async write(entries: EngineLogEntry[]): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.batches++;
    this.rows.push(...entries.map((entry) => ({ ...entry })));
  }
  async getLayerHead(saveId: string): Promise<EngineLogLayerHead> {
    this.headCalls++;
    return this.heads.get(saveId) ?? { layer: 0 };
  }
  find(msg: string): EngineLogEntry | undefined {
    return this.rows.find((row) => row.msg === msg);
  }
}

let sink: MemorySink;

beforeEach(() => {
  resetEngineLoggerForTest();
  sink = new MemorySink();
  installEngineLogSink(sink);
});

afterEach(() => {
  resetEngineLoggerForTest();
  vi.useRealTimers();
});

describe('开关与级别闸门', () => {
  it('关闭时不执行 thunk、不写库、不开作用域', async () => {
    const thunk = vi.fn(() => ({ big: 'x' }));
    logEngine('error', 'cat', 'msg', thunk);
    const scope = beginLogScope({ saveId: 's', turnId: 't', layerKey: 'k' });
    scope.end('ok');
    await flushEngineLog();
    expect(thunk).not.toHaveBeenCalled();
    expect(sink.rows).toHaveLength(0);
    expect(sink.headCalls).toBe(0);
    expect(isEngineLogEnabled('error')).toBe(false);
  });

  it('低于最低级别不执行 thunk；达到级别才记', async () => {
    configureEngineLogger({ enabled: true, level: 'warn' });
    const low = vi.fn(() => 1);
    logEngine('info', 'cat', 'low', low);
    logEngine('warn', 'cat', 'high', () => ({ ok: true }));
    await flushEngineLog();
    expect(low).not.toHaveBeenCalled();
    expect(sink.rows.map((row) => row.msg)).toEqual(['high']);
    expect(sink.rows[0].payload).toBe('{"ok":true}');
    expect(isEngineLogEnabled('info')).toBe(false);
    expect(isEngineLogEnabled('error')).toBe(true);
  });

  it('关闭后再记录无效，关闭前已记下的条目仍会交付', async () => {
    configureEngineLogger({ enabled: true, level: 'trace' });
    logEngine('info', 'cat', 'before');
    configureEngineLogger({ enabled: false });
    logEngine('error', 'cat', 'after');
    await flushEngineLog();
    expect(sink.rows.map((row) => row.msg)).toEqual(['before']);
  });

  it('thunk 抛错不外抛，记成说明性 payload', async () => {
    configureEngineLogger({ enabled: true, level: 'trace' });
    expect(() =>
      logEngine('info', 'cat', 'boom', () => {
        throw new Error('炸了');
      }),
    ).not.toThrow();
    await flushEngineLog();
    expect(sink.rows[0].payload).toContain('炸了');
  });
});

describe('payload 序列化', () => {
  beforeEach(() => configureEngineLogger({ enabled: true, level: 'trace' }));

  it('循环引用记为 [Circular]，共享引用不误判', async () => {
    const shared = { v: 1 };
    const node: Record<string, unknown> = { name: 'root', a: shared, b: shared };
    node.self = node;
    logEngine('info', 'cat', 'cycle', node);
    await flushEngineLog();
    const parsed = JSON.parse(sink.rows[0].payload) as Record<string, unknown>;
    expect(parsed.self).toBe('[Circular]');
    expect(parsed.a).toEqual({ v: 1 });
    expect(parsed.b).toEqual({ v: 1 });
  });

  it('BigInt / 函数 / Error / Map / Set / 非有限数都能落成 JSON', async () => {
    const error = new Error('出错了');
    (error as Error & { cause?: unknown }).cause = error;
    logEngine('info', 'cat', 'types', {
      big: 10n,
      fn: function named() {},
      error,
      map: new Map([['k', 1]]),
      set: new Set([1, 2]),
      nan: Number.NaN,
      date: new Date(0),
      skip: undefined,
    });
    await flushEngineLog();
    const parsed = JSON.parse(sink.rows[0].payload) as Record<string, unknown>;
    expect(parsed.big).toBe('10n');
    expect(parsed.fn).toBe('[Function named]');
    expect((parsed.error as Record<string, unknown>).message).toBe('出错了');
    expect((parsed.error as Record<string, unknown>).cause).toBe('[Circular]');
    expect(parsed.map).toEqual({ '[Map]': [['k', 1]] });
    expect(parsed.set).toEqual({ '[Set]': [1, 2] });
    expect(parsed.nan).toBe('NaN');
    expect(parsed.date).toBe('1970-01-01T00:00:00.000Z');
    expect('skip' in parsed).toBe(false);
  });

  it('getter 抛错 / toJSON 抛错不外抛', async () => {
    const hostile = {
      get bad(): never {
        throw new Error('getter');
      },
    };
    const badJson = {
      toJSON(): never {
        throw new Error('toJSON');
      },
    };
    expect(() => logEngine('info', 'cat', 'hostile', { hostile })).not.toThrow();
    expect(() => logEngine('info', 'cat', 'badJson', badJson)).not.toThrow();
    await flushEngineLog();
    expect(sink.find('hostile')!.payload).toContain('读取失败');
    expect(sink.find('badJson')!.payload).toContain('序列化失败');
  });

  it('Proxy（仿 reactive）被切断成纯数据', async () => {
    const target = { nested: { list: [1, 2] } };
    const proxy = new Proxy(target, {
      get(obj, key, receiver) {
        const value = Reflect.get(obj, key, receiver) as unknown;
        return value && typeof value === 'object' ? new Proxy(value, {}) : value;
      },
    });
    logEngine('info', 'cat', 'proxy', proxy);
    await flushEngineLog();
    expect(JSON.parse(sink.rows[0].payload)).toEqual({ nested: { list: [1, 2] } });
  });

  it('超过 2,000,000 字符的字符串截断并标注原长度', async () => {
    const huge = 'a'.repeat(2_000_010);
    logEngine('info', 'cat', 'huge', { huge });
    await flushEngineLog();
    const parsed = JSON.parse(sink.rows[0].payload) as { huge: string };
    expect(parsed.huge.startsWith('a'.repeat(100))).toBe(true);
    expect(parsed.huge).toContain('原长度 2000010 字符');
    expect(parsed.huge.length).toBeLessThan(2_000_100);
    expect(sink.rows[0].size).toBe(sink.rows[0].payload.length);
  });

  it('无 payload 时为空串', async () => {
    logEngine('info', 'cat', 'none');
    await flushEngineLog();
    expect(sink.rows[0].payload).toBe('');
    expect(sink.rows[0].size).toBe(0);
  });
});

describe('脱敏', () => {
  beforeEach(() => configureEngineLogger({ enabled: true, level: 'trace' }));

  it('登记过的密钥在 msg 与 payload 里都换成 ***，不登记的长串原样保留', async () => {
    const secret = 'sk-live-ABCDEFGHIJKLMNOP';
    const quoted = 'pa"ss\\word123';
    registerLogSecret(secret);
    registerLogSecret(quoted);
    registerLogSecret('abc'); // 太短，不登记
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const hash = 'a'.repeat(64);
    logEngine('info', 'cat', `key=${secret}`, {
      headers: { Authorization: `Bearer ${secret}` },
      prompt: `id ${uuid} hash ${hash} abc`,
      weird: `x${quoted}y`,
    });
    await flushEngineLog();
    const line = JSON.stringify(sink.rows);
    expect(line).not.toContain(secret);
    expect(sink.rows[0].payload).not.toContain(JSON.stringify(quoted).slice(1, -1));
    expect(sink.rows[0].msg).toBe('key=***');
    const parsed = JSON.parse(sink.rows[0].payload) as Record<string, unknown>;
    expect(parsed.prompt).toBe(`id ${uuid} hash ${hash} abc`);
    expect(parsed.weird).toBe('x***y');
  });

  it('按键名结构化脱敏：嵌套 apiKey / 敏感键 / 短头值都不落盘，计数类键不受影响', async () => {
    // 均未登记（模拟「记录时密钥还没登记」与「短于 6 字符永不登记」两种情形）
    const longKey = 'sk-unregistered-LONGKEY123456';
    const shortHeader = 'q9z';
    logEngine('info', 'cat', 'msg', {
      request: {
        endpoint: {
          name: '主号',
          baseUrl: 'https://api.example.com',
          apiKey: longKey,
          headerOverrides: { 'X-Tenant': shortHeader, 'X-Trace': 'tr4' },
        },
        nested: [{ API_KEY: 'k1-secret-value', Authorization: 'Bearer abcdef' }],
        password: 'pw1',
        'x-api-key': 'xak4',
        'X-Goog-Api-Key': 'goog5',
        headers: [['X-Pair', 'pv6'], 'X-Name-Only'],
        // 业务字段：世界书 uid / 剧情选角秘密，排查时要看，不能被当成凭据抹掉
        token: 'wb-uid-42',
        secret: '她其实是王女',
      },
      maxTokens: 4096,
      tokensUsed: 123,
      promptTokens: 77,
      tokenizer: 'cl100k',
    });
    await flushEngineLog();
    const payload = sink.rows[0].payload;
    for (const leaked of [
      longKey,
      shortHeader,
      'tr4',
      'k1-secret-value',
      'Bearer abcdef',
      'pw1',
      'xak4',
      'goog5',
      'pv6',
    ]) {
      expect(payload).not.toContain(leaked);
    }
    const parsed = JSON.parse(payload) as {
      request: {
        endpoint: Record<string, unknown>;
        nested: Array<Record<string, unknown>>;
        headers: unknown;
        token: string;
        secret: string;
      };
      maxTokens: number;
      tokensUsed: number;
      promptTokens: number;
      tokenizer: string;
    };
    expect(parsed.request.endpoint.apiKey).toBe('***');
    // 头名保留，头值全部脱敏
    expect(parsed.request.endpoint.headerOverrides).toEqual({
      'X-Tenant': '***',
      'X-Trace': '***',
    });
    expect(parsed.request.headers).toEqual([['X-Pair', '***'], 'X-Name-Only']);
    expect(parsed.request.token).toBe('wb-uid-42');
    expect(parsed.request.secret).toBe('她其实是王女');
    expect(parsed.request.nested[0]).toEqual({ API_KEY: '***', Authorization: '***' });
    expect(parsed.request.endpoint.name).toBe('主号');
    expect(parsed.request.endpoint.baseUrl).toBe('https://api.example.com');
    expect(parsed.maxTokens).toBe(4096);
    expect(parsed.tokensUsed).toBe(123);
    expect(parsed.promptTokens).toBe(77);
    expect(parsed.tokenizer).toBe('cl100k');
  });

  it('Error 自有字段与 Map 字符串键同样按键名脱敏', async () => {
    const error = Object.assign(new Error('boom'), { apiKey: 'err-key-value-1' });
    logEngine('error', 'cat', 'msg', {
      error,
      map: new Map<string, unknown>([['apiKey', 'map-token-value']]),
    });
    await flushEngineLog();
    const payload = sink.rows[0].payload;
    expect(payload).not.toContain('err-key-value-1');
    expect(payload).not.toContain('map-token-value');
  });
});

describe('回合作用域与层号', () => {
  beforeEach(() => configureEngineLogger({ enabled: true, level: 'trace' }));

  it('不带 saveId 的调用归入最近一个活跃作用域；作用域外为应用级层 0', async () => {
    const scope = beginLogScope({ saveId: 's1', turnId: 't1', turn: 3, layerKey: 'm1' });
    logEngine('info', 'deep', 'inside', undefined, { agentId: 'story', callId: 'c1' });
    scope.end('ok');
    logEngine('info', 'deep', 'outside');
    logEngine('info', 'deep', 'save-no-scope', undefined, { saveId: 's1' });
    await flushEngineLog();
    const inside = sink.find('inside')!;
    expect(inside).toMatchObject({
      saveId: 's1',
      layer: 1,
      turn: 3,
      turnId: 't1',
      layerKey: 'm1',
      agentId: 'story',
      callId: 'c1',
    });
    expect(sink.find('outside')).toMatchObject({ saveId: APP_LOG_SAVE_ID, layer: NO_TURN_LAYER });
    expect(sink.find('save-no-scope')).toMatchObject({ saveId: 's1', layer: NO_TURN_LAYER });
    expect(sink.find('scope.begin')?.layer).toBe(1);
    expect(sink.find('scope.end')?.payload).toBe('{"status":"ok"}');
  });

  it('同一 layerKey 不开新层；不同才 +1；不传 layerKey 归入当前层', async () => {
    const layers: number[] = [];
    for (const key of ['m1', 'm1', undefined, 'm2', 'm2', 'm3']) {
      const scope = beginLogScope({ saveId: 's1', turnId: `t-${String(key)}`, layerKey: key });
      logEngine('info', 'cat', `probe-${layers.length}`);
      scope.end();
      layers.push(layers.length);
    }
    await flushEngineLog();
    const got = layers.map((i) => sink.find(`probe-${i}`)!.layer);
    expect(got).toEqual([1, 1, 1, 2, 2, 3]);
  });

  it('首个作用域没有 layerKey 也会开第 1 层（不落进无回合层）', async () => {
    const scope = beginLogScope({ saveId: 'fresh', turnId: 't' });
    logEngine('info', 'cat', 'first');
    scope.end();
    await flushEngineLog();
    expect(sink.find('first')!.layer).toBe(1);
  });

  it('从 sink 查到的历史层号续接：同 key 归入旧层，新 key 开下一层', async () => {
    sink.heads.set('old', { layer: 41, layerKey: 'm41' });
    const same = beginLogScope({ saveId: 'old', turnId: 't1', layerKey: 'm41' });
    logEngine('info', 'cat', 'same');
    same.end();
    const fresh = beginLogScope({ saveId: 'old', turnId: 't2', layerKey: 'm42' });
    logEngine('info', 'cat', 'fresh');
    fresh.end();
    await flushEngineLog();
    expect(sink.find('same')!.layer).toBe(41);
    expect(sink.find('fresh')!.layer).toBe(42);
    expect(sink.headCalls).toBe(1);
  });

  it('不同存档的作用域互不串层；显式 saveId 找该存档自己的作用域', async () => {
    const a = beginLogScope({ saveId: 'A', turnId: 'ta', layerKey: 'a1' });
    const b = beginLogScope({ saveId: 'B', turnId: 'tb', layerKey: 'b1' });
    logEngine('info', 'cat', 'toA', undefined, { saveId: 'A' });
    logEngine('info', 'cat', 'latest');
    b.end();
    a.end();
    await flushEngineLog();
    expect(sink.find('toA')).toMatchObject({ saveId: 'A', turnId: 'ta' });
    expect(sink.find('latest')).toMatchObject({ saveId: 'B', turnId: 'tb' });
  });

  it('end 幂等', async () => {
    const scope = beginLogScope({ saveId: 's', turnId: 't' });
    scope.end('ok');
    scope.end('again');
    await flushEngineLog();
    expect(sink.rows.filter((row) => row.msg === 'scope.end')).toHaveLength(1);
  });
});

describe('交付', () => {
  it('500ms 定时批量交付', async () => {
    vi.useFakeTimers();
    configureEngineLogger({ enabled: true, level: 'trace' });
    logEngine('info', 'cat', 'one');
    logEngine('info', 'cat', 'two');
    expect(sink.rows).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(499);
    expect(sink.rows).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sink.rows.map((row) => row.msg)).toEqual(['one', 'two']);
    expect(sink.batches).toBe(1);
  });

  it('缓冲超过 2M 字符立即交付', async () => {
    vi.useFakeTimers();
    configureEngineLogger({ enabled: true, level: 'trace' });
    logEngine('info', 'cat', 'big', 'x'.repeat(2_000_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.rows).toHaveLength(1);
  });

  it('无 sink 时积压，装上 sink 后交付', async () => {
    installEngineLogSink(null);
    configureEngineLogger({ enabled: true, level: 'trace' });
    logEngine('info', 'cat', 'queued');
    await flushEngineLog();
    expect(sink.rows).toHaveLength(0);
    installEngineLogSink(sink);
    await flushEngineLog();
    expect(sink.rows.map((row) => row.msg)).toEqual(['queued']);
  });

  it('积压超过 64M 字符丢最旧并记一条 log.dropped', async () => {
    installEngineLogSink(null);
    configureEngineLogger({ enabled: true, level: 'trace' });
    const chunk = 'y'.repeat(1_999_000);
    for (let i = 0; i < 34; i++) logEngine('info', 'cat', `chunk-${i}`, chunk);
    installEngineLogSink(sink);
    await flushEngineLog();
    const dropped = sink.find('log.dropped');
    expect(dropped).toMatchObject({ level: 'warn', cat: 'log', saveId: APP_LOG_SAVE_ID });
    expect((JSON.parse(dropped!.payload) as { dropped: number }).dropped).toBeGreaterThan(0);
    expect(sink.find('chunk-0')).toBeUndefined();
    expect(sink.find('chunk-33')).toBeDefined();
  });

  it('sink 写失败不外抛，只用原始 console 报一次', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    configureEngineLogger({ enabled: true, level: 'trace' });
    sink.failWith = new Error('disk');
    logEngine('info', 'cat', 'a');
    await expect(flushEngineLog()).resolves.toBeUndefined();
    logEngine('info', 'cat', 'b');
    await flushEngineLog();
    const reports = errorSpy.mock.calls.filter((call) => String(call[0]).includes('[engine-log]'));
    expect(reports).toHaveLength(1);
    // 兜底报错本身不被采集成条目
    sink.failWith = null;
    await flushEngineLog();
    expect(sink.rows.some((row) => row.cat === 'console')).toBe(false);
    errorSpy.mockRestore();
  });

  it('配额错误：停写、通知监听者、关→开后恢复', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const listener = vi.fn();
    onEngineLogStorageFull(listener);
    configureEngineLogger({ enabled: true, level: 'trace' });
    sink.failWith = { name: 'AbortError', inner: { name: 'QuotaExceededError' } };
    logEngine('info', 'cat', 'full');
    await flushEngineLog();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(isEngineLogEnabled('error')).toBe(false);
    sink.failWith = null;
    const thunk = vi.fn(() => 1);
    logEngine('error', 'cat', 'ignored', thunk);
    await flushEngineLog();
    expect(thunk).not.toHaveBeenCalled();
    expect(sink.rows).toHaveLength(0);

    configureEngineLogger({ enabled: false });
    configureEngineLogger({ enabled: true, level: 'trace' });
    logEngine('info', 'cat', 'resumed');
    await flushEngineLog();
    expect(sink.rows.map((row) => row.msg)).toEqual(['resumed']);
    errorSpy.mockRestore();
  });
});

describe('console 采集', () => {
  it('开启时采集 log/info/warn/error 并照常输出；关闭时恢复原函数', async () => {
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    const passthrough = vi.fn();
    console.warn = passthrough;
    const warnBefore = console.warn;
    configureEngineLogger({ enabled: true, level: 'trace' });
    expect(console.warn).not.toBe(warnBefore);
    console.warn('出事了', { code: 7 });
    expect(passthrough).toHaveBeenCalledWith('出事了', { code: 7 });
    await flushEngineLog();
    const row = sink.rows.find((r) => r.cat === 'console')!;
    expect(row).toMatchObject({ level: 'warn', msg: '出事了 [Object]' });
    expect(JSON.parse(row.payload)).toEqual(['出事了', { code: 7 }]);

    configureEngineLogger({ enabled: false });
    expect(console.warn).toBe(warnBefore);
    console.warn = original.warn;
    expect(console.log).toBe(original.log);
    expect(console.info).toBe(original.info);
    expect(console.error).toBe(original.error);
  });

  it('级别映射：log→debug、info→info、error→error；低于最低级别不采集', async () => {
    const restore = { log: console.log, info: console.info, error: console.error };
    console.log = vi.fn();
    console.info = vi.fn();
    console.error = vi.fn();
    configureEngineLogger({ enabled: true, level: 'info' });
    console.log('L');
    console.info('I');
    console.error(new Error('E'));
    configureEngineLogger({ enabled: false });
    await flushEngineLog();
    const consoleRows = sink.rows.filter((row) => row.cat === 'console');
    expect(consoleRows.map((row) => [row.level, row.msg])).toEqual([
      ['info', 'I'],
      ['error', 'Error: E'],
    ]);
    Object.assign(console, restore);
  });

  it('序列化期间触发的 console 调用不会递归采集', async () => {
    const restore = console.warn;
    console.warn = vi.fn();
    configureEngineLogger({ enabled: true, level: 'trace' });
    const noisy = {
      get value() {
        console.warn('getter 里打日志');
        return 1;
      },
    };
    logEngine('info', 'cat', 'noisy', noisy);
    await flushEngineLog();
    expect(sink.rows.filter((row) => row.cat === 'console')).toHaveLength(0);
    expect(sink.find('noisy')!.payload).toBe('{"value":1}');
    configureEngineLogger({ enabled: false });
    console.warn = restore;
  });
});
