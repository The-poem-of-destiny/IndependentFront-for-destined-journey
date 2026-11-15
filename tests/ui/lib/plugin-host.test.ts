/**
 * plugin-host.ts —— 插件宿主会话（设计 §5.1–§5.4、§5.7、§6.1–§6.3、§6.5）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import type { PluginProjectionInput } from '../../../src/core/plugins/plugin-projection';
import { createDefaultCharacterState, type SaveProfile } from '../../../src/core/types/types';
import type {
  PluginManifest,
  PluginResult,
  PluginRunGuard,
} from '../../../src/core/types/types-plugin';
import type { PluginHostCallContext, PluginHostExtension } from '../../../src/ui/lib/plugin-bridge';
import {
  createPluginHost,
  type PluginHostDeps,
  type PluginHostStateManager,
} from '../../../src/ui/lib/plugin-host';
import {
  createPluginAiExtension,
  createPluginStorageExtension,
} from '../../../src/ui/lib/plugin-host-extensions';
import {
  resetPluginRunSignalsForTest,
  whenPluginWritesSettled,
} from '../../../src/ui/lib/plugin-run-signals';
import type { PluginSaveLockState } from '../../../src/ui/lib/plugin-save-lock';

const PLUGIN_ID = 'demo.shop';

function manifest(): PluginManifest {
  return {
    manifestVersion: 1,
    id: PLUGIN_ID,
    name: '杂货铺',
    version: '1.0.0',
    pluginApi: '^1.0',
    contributions: [],
    network: [],
    capabilities: {
      read: ['player'],
      commands: ['money.spend', 'item.grant'],
      events: [],
      ai: [],
      storage: ['save'],
    },
  };
}

function projectionInput(): PluginProjectionInput {
  const player = createDefaultCharacterState({
    id: 'p-1',
    saveId: 's-1',
    type: 'player',
    name: '艾琳',
    money: 120,
  });
  const profile: SaveProfile = {
    saveId: 's-1',
    experienceMode: 'normal',
    fp: 0,
    fpHistory: [],
    contracts: [],
    achievements: [],
    news: [],
    quests: {},
    focusQuest: '',
    affections: {},
    gameTime: { era: '复兴纪元', year: 1, month: 1, day: 1, hour: 8, minute: 0, weekday: 1 },
    variables: {},
    worldFlags: {},
    updatedAt: 1,
  };
  return {
    characters: [player],
    profile,
    messages: [],
    plotEvents: [],
    run: { generating: false, inCombat: false, turn: 3, mode: 'agent' },
  };
}

interface Harness {
  deps: PluginHostDeps;
  order: string[];
  state: {
    saveId: string | null;
    lock: PluginSaveLockState;
    guard: ReturnType<PluginRunGuard>;
    commitResult: PluginResult;
  };
  sm: PluginHostStateManager & {
    commitPluginCommand: ReturnType<typeof vi.fn>;
    amendCurrentTurnSnapshot: ReturnType<typeof vi.fn>;
  };
  ui: {
    close: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    toast: ReturnType<typeof vi.fn>;
    fillInput: ReturnType<typeof vi.fn>;
  };
}

function harness(
  overrides: { input?: PluginProjectionInput; extensions?: PluginHostExtension[] } = {},
): Harness {
  const order: string[] = [];
  const state: Harness['state'] = {
    saveId: 's-1',
    lock: 'held',
    guard: 'ok',
    commitResult: { ok: true },
  };
  const sm = {
    commitPluginCommand: vi.fn(async () => {
      order.push('commit');
      return state.commitResult;
    }),
    amendCurrentTurnSnapshot: vi.fn(async () => {
      order.push('amend');
    }),
  };
  const ui = {
    close: vi.fn(),
    resize: vi.fn(),
    toast: vi.fn(),
    fillInput: vi.fn(),
  };
  const deps: PluginHostDeps = {
    pluginId: PLUGIN_ID,
    manifest: manifest(),
    getSaveId: () => state.saveId,
    getProjectionInput: () => overrides.input ?? projectionInput(),
    guard: () => state.guard,
    lockState: () => state.lock,
    playerName: () => '艾琳',
    stateManagerFor: () => sm,
    refreshAfterWrite: vi.fn(async () => {
      order.push('refresh');
    }),
    pushViews: vi.fn(() => {
      order.push('push');
    }),
    ui,
    ...(overrides.extensions ? { extensions: overrides.extensions } : {}),
  };
  return { deps, order, state, sm, ui };
}

function call(method: string, args: unknown[], surfaceId?: string) {
  return surfaceId === undefined
    ? { pluginId: PLUGIN_ID, method, args }
    : { pluginId: PLUGIN_ID, method, args, surfaceId };
}

afterEach(() => {
  resetPluginRunSignalsForTest();
  vi.restoreAllMocks();
});

describe('read', () => {
  it('返回投影', async () => {
    const h = harness();
    const host = createPluginHost(h.deps);
    const result = await host.invoke(call('read', ['player']));
    expect(result.ok).toBe(true);
    expect(result.ok && (result.value as { name: string; money: number })).toMatchObject({
      name: '艾琳',
      money: 120,
    });
  });

  it('没有存档时返回 NO_SAVE', async () => {
    const h = harness();
    h.state.saveId = null;
    const host = createPluginHost(h.deps);
    const result = await host.invoke(call('read', ['player']));
    expect(result).toMatchObject({ ok: false, code: 'NO_SAVE' });
  });

  it('未知投影名返回 INVALID', async () => {
    const host = createPluginHost(harness().deps);
    expect(await host.invoke(call('read', ['secrets']))).toMatchObject({
      ok: false,
      code: 'INVALID',
    });
  });

  it('响应式输入读出来是可结构化克隆的纯数据', async () => {
    const input = reactive(projectionInput()) as unknown as PluginProjectionInput;
    const host = createPluginHost(harness({ input }).deps);
    const result = await host.invoke(call('read', ['player']));
    expect(result.ok).toBe(true);
    const value = result.ok ? result.value : undefined;
    expect(() => structuredClone(value)).not.toThrow();
    expect(value).toEqual(JSON.parse(JSON.stringify(value)));
  });
});

describe('commit', () => {
  const spend = [{ commands: [{ type: 'money.spend', amount: 30 }] }];

  it('按 翻译 → 提交 → 补快照 → 回读 → 推投影 的顺序执行', async () => {
    const h = harness();
    const host = createPluginHost(h.deps);
    const result = await host.invoke(call('commit', spend));
    expect(result).toEqual({ ok: true });
    expect(h.order).toEqual(['commit', 'amend', 'refresh', 'push']);
    const input = h.sm.commitPluginCommand.mock.calls[0][0] as {
      saveId: string;
      pluginId: string;
      patches: unknown[];
      expect: unknown[];
      commandIndexOfPatch: number[];
      isAllowed: PluginRunGuard;
    };
    expect(input.saveId).toBe('s-1');
    expect(input.pluginId).toBe(PLUGIN_ID);
    expect(input.patches).toHaveLength(1);
    // money.spend 的隐含前置条件来自翻译层
    expect(input.expect).toEqual([{ view: 'player.money', gte: 30 }]);
    expect(input.commandIndexOfPatch).toEqual([0]);
    expect(input.isAllowed).toBe(h.deps.guard);
  });

  it('整段写入登记为在途：等待方要等到回读与推投影都做完', async () => {
    const h = harness();
    let releaseRefresh!: () => void;
    h.deps.refreshAfterWrite = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRefresh = () => {
            h.order.push('refresh');
            resolve();
          };
        }),
    );
    const host = createPluginHost(h.deps);
    const pending = host.invoke(call('commit', spend));
    let settled = false;
    const waiter = whenPluginWritesSettled().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(h.order).toEqual(['commit', 'amend']));
    expect(settled).toBe(false);
    releaseRefresh();
    await pending;
    await waiter;
    expect(settled).toBe(true);
    expect(h.order).toEqual(['commit', 'amend', 'refresh', 'push']);
  });

  it('没有存档返回 NO_SAVE，不翻译不提交', async () => {
    const h = harness();
    h.state.saveId = null;
    const host = createPluginHost(h.deps);
    expect(await host.invoke(call('commit', spend))).toMatchObject({ ok: false, code: 'NO_SAVE' });
    expect(h.sm.commitPluginCommand).not.toHaveBeenCalled();
  });

  it.each(['waiting', 'unsupported', 'released'] as const)(
    '跨标签页锁为 %s 时拒绝写入（BUSY）',
    async (lock) => {
      const h = harness();
      h.state.lock = lock;
      const host = createPluginHost(h.deps);
      expect(await host.invoke(call('commit', spend))).toMatchObject({ ok: false, code: 'BUSY' });
      expect(h.sm.commitPluginCommand).not.toHaveBeenCalled();
    },
  );

  it.each(['BUSY', 'IN_COMBAT'] as const)('运行守卫返回 %s 时原样拒绝', async (guard) => {
    const h = harness();
    h.state.guard = guard;
    const host = createPluginHost(h.deps);
    expect(await host.invoke(call('commit', spend))).toMatchObject({ ok: false, code: guard });
    expect(h.sm.commitPluginCommand).not.toHaveBeenCalled();
  });

  it('翻译错误原样透传（含下标），不提交', async () => {
    const h = harness();
    const host = createPluginHost(h.deps);
    const result = await host.invoke(
      call('commit', [{ commands: [{ type: 'money.spend', amount: 'x' }] }]),
    );
    expect(result).toMatchObject({ ok: false, code: 'INVALID', index: 0 });
    expect(h.sm.commitPluginCommand).not.toHaveBeenCalled();
  });

  it('未声明的命令在翻译层被拒为 DENIED', async () => {
    const h = harness();
    const host = createPluginHost(h.deps);
    const result = await host.invoke(
      call('commit', [{ commands: [{ type: 'fp.add', amount: 1 }] }]),
    );
    expect(result).toMatchObject({ ok: false, code: 'DENIED' });
  });

  it('提交失败时不补快照、不回读、不推投影', async () => {
    const h = harness();
    h.state.commitResult = {
      ok: false,
      code: 'PRECONDITION_FAILED',
      message: '余额不足',
      index: 0,
    };
    const host = createPluginHost(h.deps);
    const result = await host.invoke(call('commit', spend));
    expect(result).toEqual({
      ok: false,
      code: 'PRECONDITION_FAILED',
      message: '余额不足',
      index: 0,
    });
    expect(h.order).toEqual(['commit']);
  });

  it('补快照失败不把已落库的提交报成失败', async () => {
    const h = harness();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.sm.amendCurrentTurnSnapshot.mockRejectedValueOnce(new Error('锁超时'));
    const host = createPluginHost(h.deps);
    expect(await host.invoke(call('commit', spend))).toEqual({ ok: true });
    expect(h.order).toEqual(['commit', 'refresh', 'push']);
  });
});

describe('ui.*', () => {
  it('close / resize 带界面 id 调回调，尺寸取整', async () => {
    const h = harness();
    const host = createPluginHost(h.deps);
    expect(await host.invoke(call('ui.close', [], 'surf-1'))).toEqual({ ok: true });
    expect(h.ui.close).toHaveBeenCalledWith('surf-1');
    expect(await host.invoke(call('ui.resize', [320.4, 240.6], 'surf-1'))).toEqual({ ok: true });
    expect(h.ui.resize).toHaveBeenCalledWith('surf-1', 320, 241);
  });

  it('后台页面（无界面 id）不能 close / resize', async () => {
    const h = harness();
    const host = createPluginHost(h.deps);
    expect(await host.invoke(call('ui.close', []))).toMatchObject({ code: 'INVALID' });
    expect(await host.invoke(call('ui.resize', [100, 100]))).toMatchObject({ code: 'INVALID' });
    expect(h.ui.close).not.toHaveBeenCalled();
    expect(h.ui.resize).not.toHaveBeenCalled();
  });

  it.each([[[Number.NaN, 100]], [[100, Infinity]], [[-1, 100]], [['100', 100]], [[100]]])(
    'resize 参数 %j 不合法',
    async (args) => {
      const h = harness();
      const host = createPluginHost(h.deps);
      expect(await host.invoke(call('ui.resize', args, 'surf-1'))).toMatchObject({
        code: 'INVALID',
      });
      expect(h.ui.resize).not.toHaveBeenCalled();
    },
  );

  it('toast 校验类型与长度', async () => {
    const h = harness();
    const host = createPluginHost(h.deps);
    expect(await host.invoke(call('ui.toast', ['已购买']))).toEqual({ ok: true });
    expect(h.ui.toast).toHaveBeenCalledWith('已购买');
    expect(await host.invoke(call('ui.toast', [42]))).toMatchObject({ code: 'INVALID' });
    expect(await host.invoke(call('ui.toast', ['  ']))).toMatchObject({ code: 'INVALID' });
    expect(await host.invoke(call('ui.toast', ['长'.repeat(201)]))).toMatchObject({
      code: 'INVALID',
    });
    expect(h.ui.toast).toHaveBeenCalledTimes(1);
  });

  it('fillInput 只回填输入框，绝不提交或写入', async () => {
    const h = harness();
    const host = createPluginHost(h.deps);
    expect(await host.invoke(call('ui.fillInput', ['买一瓶药水']))).toEqual({ ok: true });
    expect(h.ui.fillInput).toHaveBeenCalledWith('买一瓶药水');
    expect(h.sm.commitPluginCommand).not.toHaveBeenCalled();
    expect(h.deps.refreshAfterWrite).not.toHaveBeenCalled();
    expect(h.order).toEqual([]);
  });

  it('fillInput 校验类型、长度与存档', async () => {
    const h = harness();
    const host = createPluginHost(h.deps);
    expect(await host.invoke(call('ui.fillInput', [null]))).toMatchObject({ code: 'INVALID' });
    expect(await host.invoke(call('ui.fillInput', ['字'.repeat(4001)]))).toMatchObject({
      code: 'INVALID',
    });
    h.state.saveId = null;
    expect(await host.invoke(call('ui.fillInput', ['x']))).toMatchObject({ code: 'NO_SAVE' });
    expect(h.ui.fillInput).not.toHaveBeenCalled();
  });
});

describe('扩展方法', () => {
  it('分派到扩展并给出正确的上下文', async () => {
    let seen: PluginHostCallContext | undefined;
    let seenArgs: unknown[] | undefined;
    const ext: PluginHostExtension = {
      methods: {
        'storage.save.set': async (ctx, args) => {
          seen = ctx;
          seenArgs = args;
          return { ok: true, value: 'done' };
        },
      },
    };
    const h = harness({ extensions: [ext] });
    const host = createPluginHost(h.deps);
    const result = await host.invoke(call('storage.save.set', ['k', 1], 'surf-1'));
    expect(result).toEqual({ ok: true, value: 'done' });
    expect(seenArgs).toEqual(['k', 1]);
    expect(seen).toMatchObject({
      pluginId: PLUGIN_ID,
      saveId: 's-1',
      surfaceId: 'surf-1',
    });
    expect(seen?.manifest).toBe(h.deps.manifest);
    expect(seen?.guard).toBe(h.deps.guard);
  });

  it('ctx.canWrite 依次检查存档、锁、守卫', async () => {
    let ctx: PluginHostCallContext | undefined;
    const ext: PluginHostExtension = {
      methods: {
        'ai.note': async (c) => {
          ctx = c;
          return { ok: true };
        },
      },
    };
    const h = harness({ extensions: [ext] });
    const host = createPluginHost(h.deps);
    await host.invoke(call('ai.note', ['x']));
    expect(ctx?.canWrite()).toEqual({ ok: true });
    h.state.guard = 'IN_COMBAT';
    expect(ctx?.canWrite()).toMatchObject({ ok: false, code: 'IN_COMBAT' });
    h.state.lock = 'waiting';
    expect(ctx?.canWrite()).toMatchObject({ ok: false, code: 'BUSY' });
    h.state.saveId = null;
    expect(ctx?.canWrite()).toMatchObject({ ok: false, code: 'NO_SAVE' });
  });

  it('ctx.afterWrite 补快照 → 回读 → 推投影，并登记为在途写入', async () => {
    const ext: PluginHostExtension = {
      methods: {
        'storage.save.remove': async (ctx) => {
          void ctx.afterWrite();
          return { ok: true };
        },
      },
    };
    const h = harness({ extensions: [ext] });
    const host = createPluginHost(h.deps);
    await host.invoke(call('storage.save.remove', ['k']));
    await whenPluginWritesSettled();
    expect(h.order).toEqual(['amend', 'refresh', 'push']);
  });

  /** 手动兑现的 Promise：模拟还在飞的落库 */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  /** 判断等待器此刻是否已放行（让微任务先跑几拍） */
  async function isSettled(p: Promise<unknown>): Promise<boolean> {
    let done = false;
    void p.then(() => {
      done = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return done;
  }

  it('storage.save.set 落库还在飞时，whenPluginWritesSettled 不放行（§6.1）', async () => {
    const write = deferred<PluginResult>();
    const ext = createPluginStorageExtension({
      getSaveBag: vi.fn(async () => ({})),
      writeSaveKv: vi.fn(() => write.promise),
      kvGet: vi.fn(),
      kvSet: vi.fn(),
      kvRemove: vi.fn(),
    });
    const h = harness({ extensions: [ext] });
    const host = createPluginHost(h.deps);
    const pending = host.invoke(call('storage.save.set', ['gold', 5]));
    const waiter = whenPluginWritesSettled();
    expect(await isSettled(waiter)).toBe(false);
    write.resolve({ ok: true });
    await waiter;
    expect(await pending).toEqual({ ok: true });
    // 收尾也一并等完
    expect(h.order).toEqual(['amend', 'refresh', 'push']);
  });

  it('ai.note 落库还在飞时，whenPluginWritesSettled 不放行（§6.1）', async () => {
    const note = deferred<PluginResult>();
    const ext = createPluginAiExtension({
      enqueueNote: vi.fn(() => note.promise),
      setContext: vi.fn(async () => ({ ok: true }) as PluginResult),
      currentTurn: () => 3,
      addSystemNotice: vi.fn(),
    });
    const h = harness({ extensions: [ext] });
    const host = createPluginHost(h.deps);
    const pending = host.invoke(call('ai.note', ['金币变多了']));
    const waiter = whenPluginWritesSettled();
    expect(await isSettled(waiter)).toBe(false);
    note.resolve({ ok: true });
    await waiter;
    expect(await pending).toEqual({ ok: true });
    expect(h.order).toEqual(['amend', 'refresh', 'push']);
  });

  it('设备级存储 storage.global.set 不碰存档，不登记为在途写入', async () => {
    const write = deferred<PluginResult<unknown>>();
    const ext = createPluginStorageExtension({
      getSaveBag: vi.fn(async () => ({})),
      writeSaveKv: vi.fn(async () => ({ ok: true }) as PluginResult),
      kvGet: vi.fn(),
      kvSet: vi.fn(() => write.promise),
      kvRemove: vi.fn(),
    });
    const host = createPluginHost(harness({ extensions: [ext] }).deps);
    const pending = host.invoke(call('storage.global.set', ['theme', 'dark']));
    expect(await isSettled(whenPluginWritesSettled())).toBe(true);
    write.resolve({ ok: true });
    await pending;
  });

  it('没有扩展处理的方法返回 INVALID', async () => {
    const host = createPluginHost(harness().deps);
    expect(await host.invoke(call('ui.openExternal', ['https://example.org']))).toMatchObject({
      ok: false,
      code: 'INVALID',
    });
    expect(await host.invoke(call('storage.global.get', ['k']))).toMatchObject({
      code: 'INVALID',
    });
  });

  it('扩展方法与内建方法或彼此重名时装配直接报错', () => {
    const dup: PluginHostExtension = { methods: { 'ai.note': async () => ({ ok: true }) } };
    const builtin: PluginHostExtension = { methods: { commit: async () => ({ ok: true }) } };
    expect(() => createPluginHost(harness({ extensions: [dup, dup] }).deps)).toThrow();
    expect(() => createPluginHost(harness({ extensions: [builtin] }).deps)).toThrow();
  });
});

describe('会话', () => {
  it('销毁后一切调用返回 INVALID', async () => {
    const h = harness();
    const host = createPluginHost(h.deps);
    host.dispose();
    expect(await host.invoke(call('read', ['player']))).toMatchObject({ code: 'INVALID' });
    expect(await host.invoke(call('ui.toast', ['x']))).toMatchObject({ code: 'INVALID' });
    expect(h.ui.toast).not.toHaveBeenCalled();
  });

  it('pluginId 对不上时拒绝', async () => {
    const host = createPluginHost(harness().deps);
    expect(
      await host.invoke({ pluginId: 'other.plugin', method: 'read', args: ['player'] }),
    ).toMatchObject({ code: 'INVALID' });
  });
});
