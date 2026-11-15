import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_LIMITS } from '../../../src/core/plugins/plugin-surface';
import type { PluginManifest, PluginResult } from '../../../src/core/types/types-plugin';
import {
  createPluginBridge,
  type PluginBridgeHost,
  type PluginHostCall,
  type PluginHostCallContext,
  type PluginHostExtension,
} from '../../../src/ui/lib/plugin-bridge';

function manifest(): PluginManifest {
  return {
    manifestVersion: 1,
    id: 'demo.shop',
    name: '杂货铺',
    version: '1.0.0',
    pluginApi: '^1.0',
    contributions: [],
    network: [],
    capabilities: {
      read: ['player'],
      commands: ['money.spend', 'item.grant'],
      events: ['turn.end'],
      ai: ['note'],
      storage: ['save'],
    },
  };
}

type FrameMessage = Record<string, unknown>;

const open: MessagePort[] = [];

afterEach(() => {
  for (const port of open.splice(0)) port.close();
});

/** 建一座桥，返回帧那一端和收到的消息 */
function setup(options: { host?: PluginBridgeHost; now?: () => number; surfaceId?: string } = {}) {
  const channel = new MessageChannel();
  open.push(channel.port1, channel.port2);
  const invoke = vi.fn(async (call: PluginHostCall): Promise<PluginResult<unknown>> => ({
    ok: true,
    value: { method: call.method },
  }));
  const host: PluginBridgeHost = options.host ?? { invoke };
  const bridge = createPluginBridge({
    pluginId: 'demo.shop',
    manifest: manifest(),
    port: channel.port1,
    host,
    now: options.now,
    surfaceId: options.surfaceId,
  });
  const frame = channel.port2;
  const received: FrameMessage[] = [];
  const waiters: (() => void)[] = [];
  frame.addEventListener('message', (event) => {
    received.push(event.data as FrameMessage);
    for (const w of waiters.splice(0)) w();
  });
  frame.start();

  /** 等到满足条件的消息出现 */
  async function waitFor(pred: (m: FrameMessage) => boolean): Promise<FrameMessage> {
    for (;;) {
      const hit = received.find(pred);
      if (hit) return hit;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  /** 发一个请求并等它的回复 */
  async function request(id: number | string, method: string, args: unknown[] = []) {
    frame.postMessage({ type: 'req', id, method, args });
    return waitFor((m) => m.type === 'res' && m.id === id);
  }

  let sentinels = 0;
  /** 发一个哨兵请求：它回来时，之前发的消息都已处理完 */
  async function settle(): Promise<void> {
    sentinels += 1;
    await request(`sentinel-${sentinels}`, 'ui.toast', ['哨兵']);
  }

  return { bridge, frame, received, invoke, request, settle, waitFor };
}

describe('plugin-bridge 协议与形状校验', () => {
  it('合法请求转交宿主并原样回复结果', async () => {
    const { request, invoke } = setup();
    const res = await request(1, 'read', ['player']);
    expect(res).toEqual({ type: 'res', id: 1, ok: true, value: { method: 'read' } });
    expect(invoke).toHaveBeenCalledWith({
      pluginId: 'demo.shop',
      method: 'read',
      args: ['player'],
    });
  });

  it('形状不对的消息静默丢弃，不回话也不调宿主', async () => {
    const { frame, received, settle, invoke } = setup();
    frame.postMessage('纯字符串');
    frame.postMessage(null);
    frame.postMessage([1, 2]);
    frame.postMessage({ type: 'req', id: 2, method: 42, args: [] });
    frame.postMessage({ type: 'req', id: 1.5, method: 'ui.toast', args: [] });
    frame.postMessage({ type: 'req', id: '', method: 'ui.toast', args: [] });
    frame.postMessage({ type: 'req', id: 'x'.repeat(65), method: 'ui.toast', args: [] });
    frame.postMessage({ type: 'req', id: 3, method: 'ui.toast', args: '不是数组' });
    frame.postMessage({ type: 'unknown', id: 4, method: 'ui.toast' });
    frame.postMessage({ type: 'ready', env: {} });
    await settle();
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('sentinel-1');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('未知方法回 INVALID，不调宿主', async () => {
    const { request, invoke } = setup();
    const res = await request(1, 'engine.eval', ['1+1']);
    expect(res).toMatchObject({ ok: false, code: 'INVALID' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('身份取自构造参数：消息里自报的 pluginId / surfaceId 不采信', async () => {
    const { frame, waitFor, invoke } = setup({ surfaceId: 'toolbar.shop' });
    frame.postMessage({
      type: 'req',
      id: 7,
      method: 'ui.toast',
      args: ['你好'],
      pluginId: 'evil.other',
      surfaceId: 'evil.surface',
    });
    await waitFor((m) => m.id === 7);
    expect(invoke).toHaveBeenCalledWith({
      pluginId: 'demo.shop',
      method: 'ui.toast',
      args: ['你好'],
      surfaceId: 'toolbar.shop',
    });
  });

  it('宿主抛错或返回认不出的结果都变成失败回复', async () => {
    const thrower = setup({
      host: {
        invoke: () => Promise.reject(new Error('炸了')),
      },
    });
    expect(await thrower.request(1, 'ui.toast', ['x'])).toMatchObject({
      ok: false,
      code: 'INVALID',
    });
    const garbage = setup({
      host: { invoke: async () => ({ nope: true }) as unknown as PluginResult<unknown> },
    });
    expect(await garbage.request(1, 'ui.toast', ['x'])).toMatchObject({
      ok: false,
      code: 'INVALID',
    });
  });

  it('宿主的失败结果原样带 code、message、index 回去', async () => {
    const { request } = setup({
      host: {
        invoke: async () => ({
          ok: false,
          code: 'PRECONDITION_FAILED',
          message: '余额不足',
          index: 0,
        }),
      },
    });
    const res = await request(1, 'commit', [{ commands: [{ type: 'money.spend', amount: 30 }] }]);
    expect(res).toEqual({
      type: 'res',
      id: 1,
      ok: false,
      code: 'PRECONDITION_FAILED',
      message: '余额不足',
      index: 0,
    });
  });
});

describe('plugin-bridge 大小与频率上限', () => {
  it('超过单条大小上限：能取到 id 回 INVALID，不调宿主', async () => {
    const { request, invoke } = setup();
    const big = 'x'.repeat(PLUGIN_LIMITS.messageBytes);
    const res = await request(1, 'ui.toast', [big]);
    expect(res).toMatchObject({ ok: false, code: 'INVALID' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('二进制按字节数计入大小', async () => {
    const { request, invoke } = setup();
    const res = await request(1, 'ui.toast', [new Uint8Array(PLUGIN_LIMITS.messageBytes + 1)]);
    expect(res).toMatchObject({ ok: false, code: 'INVALID' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('超大且取不到 id 的消息直接丢弃', async () => {
    const { frame, received, settle } = setup();
    frame.postMessage({ type: 'ready', env: { pad: 'x'.repeat(PLUGIN_LIMITS.messageBytes) } });
    await settle();
    expect(received.map((m) => m.id)).toEqual(['sentinel-1']);
  });

  it('每秒超过 60 条回 QUOTA，时间窗过去后恢复', async () => {
    let t = 1000;
    const { frame, waitFor, request, invoke } = setup({ now: () => t });
    const limit = PLUGIN_LIMITS.messagesPerSecond;
    for (let i = 0; i < limit + 1; i++) {
      frame.postMessage({ type: 'req', id: i, method: 'ui.toast', args: [] });
    }
    const last = await waitFor((m) => m.id === limit);
    expect(last).toMatchObject({ ok: false, code: 'QUOTA' });
    await waitFor((m) => m.id === limit - 1);
    expect(invoke).toHaveBeenCalledTimes(limit);

    t += 1000;
    expect(await request('after', 'ui.toast', [])).toMatchObject({ ok: true });
  });
});

describe('plugin-bridge 能力闸门（DENIED 一律不到宿主）', () => {
  const deniedCases: [string, string, unknown[]][] = [
    ['未声明的投影 read', 'read', ['vars']],
    ['未声明的投影 subscribe', 'subscribe', ['vars']],
    ['未声明的事件 on', 'on', ['turn.start']],
    ['未声明的事件 off', 'off', ['turn.start']],
    [
      '含未声明命令的 commit',
      'commit',
      [
        {
          commands: [
            { type: 'money.spend', amount: 1 },
            { type: 'fp.add', amount: 1 },
          ],
        },
      ],
    ],
    ['未声明的 AI 手段', 'ai.context.set', ['常驻']],
    ['未声明的存储区', 'storage.global.get', ['k']],
  ];

  for (const [label, method, args] of deniedCases) {
    it(`${label} → DENIED`, async () => {
      const { request, invoke } = setup();
      const res = await request(1, method, args);
      expect(res).toMatchObject({ ok: false, code: 'DENIED' });
      expect(invoke).not.toHaveBeenCalled();
    });
  }

  it('commit 被拒时带出错命令的下标', async () => {
    const { request } = setup();
    const res = await request(1, 'commit', [
      { commands: [{ type: 'item.grant' }, { type: 'vars.set' }] },
    ]);
    expect(res).toMatchObject({ ok: false, code: 'DENIED', index: 1 });
  });

  it('commit 形状不对回 INVALID', async () => {
    const { request, invoke } = setup();
    expect(await request(1, 'commit', [{ commands: 'x' }])).toMatchObject({ code: 'INVALID' });
    expect(await request(2, 'commit', [{ commands: [{ amount: 1 }] }])).toMatchObject({
      code: 'INVALID',
      index: 0,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('已声明的手段照常转交宿主', async () => {
    const { request, invoke } = setup();
    expect(await request(1, 'ai.note', ['一次性告知'])).toMatchObject({ ok: true });
    expect(await request(2, 'storage.save.set', ['k', 1])).toMatchObject({ ok: true });
    expect(
      await request(3, 'commit', [{ commands: [{ type: 'money.spend', amount: 30 }] }]),
    ).toMatchObject({ ok: true });
    expect(invoke.mock.calls.map(([call]) => call.method)).toEqual([
      'ai.note',
      'storage.save.set',
      'commit',
    ]);
  });
});

describe('plugin-bridge 订阅与推送', () => {
  it('pushView 只推已订阅且已声明的投影，退订后停止', async () => {
    const { bridge, request, received, settle, invoke } = setup();
    bridge.pushView('player', { money: 1 });
    expect(await request(1, 'subscribe', ['player'])).toMatchObject({ ok: true });
    bridge.pushView('player', { money: 2 });
    bridge.pushView('vars', { secret: true });
    await settle();
    expect(received.filter((m) => m.type === 'view')).toEqual([
      { type: 'view', view: 'player', value: { money: 2 } },
    ]);

    await request(2, 'unsubscribe', ['player']);
    bridge.pushView('player', { money: 3 });
    await settle();
    expect(received.filter((m) => m.type === 'view')).toHaveLength(1);
    // 订阅簿记在桥里，宿主只收到哨兵
    expect(invoke.mock.calls.map(([call]) => call.method)).toEqual(['ui.toast', 'ui.toast']);
  });

  it('pushEvent 只推经 on 订阅且已声明的事件', async () => {
    const { bridge, request, received, settle } = setup();
    bridge.pushEvent('turn.end', { n: 1 });
    await request(1, 'on', ['turn.end']);
    bridge.pushEvent('turn.end', { n: 2 });
    bridge.pushEvent('turn.start', { n: 3 });
    await settle();
    expect(received.filter((m) => m.type === 'event')).toEqual([
      { type: 'event', name: 'turn.end', payload: { n: 2 } },
    ]);
    await request(2, 'off', ['turn.end']);
    bridge.pushEvent('turn.end', { n: 4 });
    await settle();
    expect(received.filter((m) => m.type === 'event')).toHaveLength(1);
  });

  it('推送的值先深拷贝成纯数据（代理与函数不过端口）', async () => {
    const { bridge, request, waitFor } = setup();
    await request(1, 'subscribe', ['player']);
    const proxied = new Proxy({ money: 5, nested: { a: 1 } }, {});
    bridge.pushView('player', { ...proxied, fn: () => 1, nested: new Proxy({ a: 1 }, {}) });
    const msg = await waitFor((m) => m.type === 'view');
    expect(msg.value).toEqual({ money: 5, nested: { a: 1 } });
  });
});

describe('plugin-bridge 销毁', () => {
  it('dispose 后不再回复、不再推送、不再调宿主，重复 dispose 无害', async () => {
    let release: (r: PluginResult<unknown>) => void = () => {};
    const slow = vi.fn(
      () =>
        new Promise<PluginResult<unknown>>((resolve) => {
          release = resolve;
        }),
    );
    const { bridge, frame, received, request } = setup({ host: { invoke: slow } });
    await request(1, 'subscribe', ['player']);
    frame.postMessage({ type: 'req', id: 2, method: 'ui.toast', args: [] });
    await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1));

    bridge.dispose();
    bridge.dispose();
    release({ ok: true });
    bridge.pushView('player', { money: 1 });
    frame.postMessage({ type: 'req', id: 3, method: 'ui.toast', args: [] });
    await new Promise((r) => setTimeout(r, 30));
    expect(received.map((m) => m.id)).toEqual([1]);
    expect(slow).toHaveBeenCalledTimes(1);
  });
});

describe('plugin-bridge 宿主扩展类型', () => {
  it('扩展方法表可以按 PluginHostCallContext 实现并接到 host.invoke 上', async () => {
    const extension: PluginHostExtension = {
      methods: {
        'ui.toast': async (ctx, args) => ({
          ok: true,
          value: `${ctx.pluginId}:${String(args[0])}`,
        }),
      },
    };
    const ctx: PluginHostCallContext = {
      pluginId: 'demo.shop',
      manifest: manifest(),
      saveId: null,
      guard: () => 'ok',
      canWrite: () => ({ ok: false, code: 'NO_SAVE', message: '没有存档' }),
      afterWrite: async () => {},
    };
    const host: PluginBridgeHost = {
      invoke: (call) =>
        extension.methods[call.method]?.(ctx, call.args) ??
        Promise.resolve({ ok: false, code: 'INVALID', message: '未知' }),
    };
    const { request } = setup({ host });
    expect(await request(1, 'ui.toast', ['好'])).toMatchObject({ ok: true, value: 'demo.shop:好' });
  });
});
