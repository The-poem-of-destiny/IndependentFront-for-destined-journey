/**
 * plugin-runtime-store —— 插件运行时 Store 测试（插件系统设计 §5.5、§5.7、§6.1、§6.2、§6.5）。
 *
 * game-store / plugin-store / ui-store 换成假对象；挂帧、读包文件、Web Lock、存档落库全部替身。
 * 桥与宿主会话用真的：帧侧拿 MessageChannel 的另一端，按端口协议发请求、收事件。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, reactive } from 'vue';
import { createDefaultSaveProfile } from '@engine/persistence/database';
import type { PluginManifest, PluginRecord } from '@engine/types/types-plugin';
import { beautifierHardened } from '../../../src/ui/lib/beautifier-hardening';
import {
  emitPluginTurnSignal,
  getPluginPromptInputs,
  resetPluginRunSignalsForTest,
} from '../../../src/ui/lib/plugin-run-signals';

// ─── 替身 ───

const SAVE_ID = 'save-runtime';

/** 每次挂帧建一条 MessageChannel：port1 给宿主，port2 留给测试扮演帧 */
const mounted = vi.hoisted(
  () =>
    [] as Array<{
      pluginId: string;
      entry: string;
      container: HTMLElement;
      hostPort: MessagePort;
      framePort: MessagePort;
      dispose: ReturnType<typeof vi.fn>;
    }>,
);
const frameMock = vi.hoisted(() => ({ mountPluginFrame: vi.fn() }));
vi.mock('../../../src/ui/lib/plugin-frame', () => frameMock);

const storageMock = vi.hoisted(() => ({
  getPluginFiles: vi.fn(async () => [
    { pluginId: 'x', path: 'index.html', bytes: new Uint8Array([60]), size: 1, sha256: 'a' },
  ]),
  pluginKvGet: vi.fn(),
  pluginKvSet: vi.fn(),
  pluginKvRemove: vi.fn(),
}));
vi.mock('@engine/persistence/plugin-storage', () => storageMock);

const lockMock = vi.hoisted(() => ({
  acquirePluginSaveLock: vi.fn(),
  release: vi.fn(),
}));
vi.mock('../../../src/ui/lib/plugin-save-lock', () => ({
  acquirePluginSaveLock: lockMock.acquirePluginSaveLock,
}));

const profileMock = vi.hoisted(() => ({
  readPluginPromptInputs: vi.fn(),
  getPluginSaveBag: vi.fn(),
  writePluginSaveKv: vi.fn(),
  setPluginContext: vi.fn(),
  enqueuePluginNote: vi.fn(),
}));
vi.mock('@engine/state/save-profile', () => profileMock);

vi.mock('@engine/state/state-manager', () => ({ createStateManager: vi.fn() }));

const dbMock = vi.hoisted(() => ({ getCharacters: vi.fn(async () => [] as unknown[]) }));
vi.mock('@engine/persistence/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@engine/persistence/database')>()),
  getCharacters: dbMock.getCharacters,
}));

const uiMock = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../../../src/ui/stores/ui-store', () => ({ useUIStore: () => uiMock }));

const fakeGame = vi.hoisted(() => ({ current: null as unknown as Record<string, unknown> }));
vi.mock('../../../src/ui/stores/game-store', () => ({ useGameStore: () => fakeGame.current }));

const fakePlugins = vi.hoisted(() => ({ current: null as unknown as Record<string, unknown> }));
vi.mock('../../../src/ui/stores/plugin-store', () => ({
  usePluginStore: () => fakePlugins.current,
}));

import { createStateManager } from '@engine/state/state-manager';
import { usePluginRuntimeStore } from '../../../src/ui/stores/plugin-runtime-store';

// ─── 夹具 ───

function manifestOf(id: string, patch: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifestVersion: 1,
    id,
    name: `插件${id}`,
    version: '1.0.0',
    pluginApi: '^1.0',
    contributions: [
      { slot: 'game.toolbar', id: 'main', label: '主面板', surface: 'window', entry: 'index.html' },
      { slot: 'game.overlay', id: 'ov', label: '覆盖层', surface: 'overlay', entry: 'ov.html' },
    ],
    network: [],
    capabilities: {
      read: ['player'],
      commands: [],
      events: ['turn.start', 'turn.end', 'turn.failed', 'combat.start'],
      ai: [],
      storage: [],
    },
    ...patch,
  };
}

function recordOf(manifest: PluginManifest): PluginRecord {
  return {
    id: manifest.id,
    manifest,
    source: 'local',
    contentHash: `hash-${manifest.id}`,
    networkHash: 'net',
    fileCount: 1,
    totalBytes: 1,
    installedAt: 0,
    updatedAt: 0,
    installConsent: { version: '1.0.0', contentHash: 'h', networkHash: 'net', at: 0 },
    saveConsents: {},
  } as PluginRecord;
}

function setup(records: PluginRecord[], metadata: Record<string, unknown> = {}) {
  const game = reactive({
    activeSaveId: SAVE_ID as string | null,
    saves: [
      {
        id: SAVE_ID,
        metadata: { totalTurns: 3, enabledPluginIds: records.map((r) => r.id), ...metadata },
      },
    ],
    get activeSave(): { id: string; metadata: Record<string, unknown> } | null {
      return this.saves[0] ?? null;
    },
    characters: [] as unknown[],
    saveProfile: createDefaultSaveProfile(SAVE_ID),
    messages: [] as unknown[],
    activePlotEvents: [] as unknown[],
    isGenerating: false,
    isRewriting: false,
    isInCombat: false,
    generationMode: 'agent',
    timelineRestoreSeq: 0,
    player: null,
    refreshFromDb: vi.fn(async () => {}),
    addSystemMessage: vi.fn(),
    ensureSaveHardened: vi.fn(async () => true),
  });
  fakeGame.current = game as unknown as Record<string, unknown>;
  const pluginState = reactive({
    records,
    selfCheck: { ok: true, innerMode: 'srcdoc', items: [], ranAt: 0 },
    refresh: vi.fn(async () => {}),
    ensureSelfCheck: vi.fn(async () => {}),
    effectivePluginsForSave: (saveId: string) => (saveId === SAVE_ID ? pluginState.records : []),
  });
  fakePlugins.current = pluginState as unknown as Record<string, unknown>;
  return { game, pluginState };
}

/** 帧侧：发一条请求，等对应的 res */
let reqSeq = 0;
function request(
  port: MessagePort,
  method: string,
  args: unknown[] = [],
): Promise<Record<string, unknown>> {
  const id = ++reqSeq;
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown>;
      if (data.type === 'res' && data.id === id) {
        port.removeEventListener('message', onMessage);
        resolve(data);
      }
    };
    port.addEventListener('message', onMessage);
    port.postMessage({ type: 'req', id, method, args });
  });
}

/** 帧侧：等下一条 `event` */
function nextEvent(port: MessagePort, name: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown>;
      if (data.type === 'event' && data.name === name) {
        port.removeEventListener('message', onMessage);
        resolve(data);
      }
    };
    port.addEventListener('message', onMessage);
  });
}

/** 打开一个界面并把帧挂上，返回帧侧端口 */
async function openAndMount(
  store: ReturnType<typeof usePluginRuntimeStore>,
  pluginId: string,
  contributionId = 'main',
) {
  const surfaceId = store.openSurface(pluginId, contributionId);
  expect(surfaceId).not.toBeNull();
  const before = mounted.length;
  const handle = store.mountFrameFor(surfaceId!)(document.createElement('div'));
  await vi.waitFor(() => expect(mounted.length).toBe(before + 1));
  // 桥在挂帧后同步建好；再让一拍给 seedViews
  await Promise.resolve();
  const frame = mounted[mounted.length - 1];
  frame.framePort.start();
  return { surfaceId: surfaceId!, handle, frame };
}

beforeEach(() => {
  setActivePinia(createPinia());
  resetPluginRunSignalsForTest();
  mounted.length = 0;
  reqSeq = 0;
  frameMock.mountPluginFrame.mockReset();
  frameMock.mountPluginFrame.mockImplementation(
    (container: HTMLElement, options: { pluginId: string; entry: string }) => {
      const channel = new MessageChannel();
      const dispose = vi.fn(() => {
        channel.port1.close();
        channel.port2.close();
      });
      mounted.push({
        pluginId: options.pluginId,
        entry: options.entry,
        container,
        hostPort: channel.port1,
        framePort: channel.port2,
        dispose,
      });
      return { port: channel.port1, dispose };
    },
  );
  lockMock.release.mockReset();
  lockMock.acquirePluginSaveLock.mockReset();
  lockMock.acquirePluginSaveLock.mockImplementation(async () => ({
    state: 'held',
    retry: vi.fn(async () => 'held'),
    release: lockMock.release,
  }));
  profileMock.readPluginPromptInputs.mockReset();
  profileMock.readPluginPromptInputs.mockResolvedValue({
    notes: [{ pluginName: '插件a', text: '收入一百' }],
    contexts: [],
  });
  uiMock.toast.mockReset();
});

afterEach(() => {
  usePluginRuntimeStore().leaveSave();
  for (const m of mounted) {
    m.hostPort.close();
    m.framePort.close();
  }
});

// ─── 用例 ───

describe('plugin-runtime-store 进出存档', () => {
  it('进入存档申请锁、挂提示词 provider、开加固；离开时全部撤销', async () => {
    setup([recordOf(manifestOf('a'))]);
    const store = usePluginRuntimeStore();
    await store.enterSave(SAVE_ID);

    await vi.waitFor(() => expect(store.lockState).toBe('held'));
    expect(lockMock.acquirePluginSaveLock).toHaveBeenCalledWith(SAVE_ID, expect.any(Object));
    expect(beautifierHardened.value).toBe(true);
    // 存档列了插件 → 进存档即补写粘滞加固标记
    expect(
      (fakeGame.current as { ensureSaveHardened: ReturnType<typeof vi.fn> }).ensureSaveHardened,
    ).toHaveBeenCalledWith(SAVE_ID);
    await vi.waitFor(() =>
      expect(getPluginPromptInputs().notes).toEqual([{ pluginName: '插件a', text: '收入一百' }]),
    );
    expect(profileMock.readPluginPromptInputs).toHaveBeenCalledWith(
      SAVE_ID,
      ['a'],
      expect.any(Function),
    );

    store.leaveSave();
    expect(lockMock.release).toHaveBeenCalledTimes(1);
    expect(store.lockState).toBe('released');
    expect(store.saveId).toBeNull();
    expect(beautifierHardened.value).toBe(false);
    expect(getPluginPromptInputs()).toEqual({ notes: [], contexts: [] });
  });

  it('存档没启用任何插件时不申请锁，但已粘滞的加固照样打开', async () => {
    setup([], { pluginHardened: true });
    const store = usePluginRuntimeStore();
    await store.enterSave(SAVE_ID);
    expect(lockMock.acquirePluginSaveLock).not.toHaveBeenCalled();
    expect(beautifierHardened.value).toBe(true);
  });

  it('存档列了插件但本机不生效、标记还没写上时，生效集合变化后加固仍保持打开', async () => {
    // 自检已缓存（ok），存档列了 a，但没有 pluginHardened
    const { pluginState } = setup([recordOf(manifestOf('a'))]);
    const store = usePluginRuntimeStore();
    await store.enterSave(SAVE_ID);
    expect(beautifierHardened.value).toBe(true);

    // a 变得不生效 → watch 触发 syncRuntime
    pluginState.records = [];
    await nextTick();
    await Promise.resolve();
    expect(store.saveId).toBe(SAVE_ID);
    expect(beautifierHardened.value).toBe(true);
  });

  it('拿不到锁时状态给横幅，重试后恢复', async () => {
    setup([recordOf(manifestOf('a'))]);
    const retry = vi.fn(async () => 'held' as const);
    lockMock.acquirePluginSaveLock.mockImplementation(async () => ({
      state: 'waiting',
      retry,
      release: lockMock.release,
    }));
    const store = usePluginRuntimeStore();
    await store.enterSave(SAVE_ID);
    await vi.waitFor(() => expect(store.lockState).toBe('waiting'));
    await store.retryLock();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(store.lockState).toBe('held');
  });
});

describe('plugin-runtime-store 界面', () => {
  it('同一时刻只留一个 overlay：开第二个会关掉第一个', async () => {
    setup([recordOf(manifestOf('a')), recordOf(manifestOf('b'))]);
    const store = usePluginRuntimeStore();
    await store.enterSave(SAVE_ID);

    const first = store.openSurface('a', 'ov');
    const win = store.openSurface('a', 'main');
    expect(store.hasOverlay).toBe(true);
    const second = store.openSurface('b', 'ov');

    const ids = store.openSurfaces.map((s) => s.surfaceId);
    expect(ids).not.toContain(first);
    expect(ids).toContain(win);
    expect(ids).toContain(second);
    expect(store.openSurfaces.filter((s) => s.mode === 'overlay')).toHaveLength(1);
    expect(store.focusedSurfaceId).toBe(second);
  });

  it('聚焦把界面提到最上层；关闭焦点界面后焦点落到剩下最上层的那个', async () => {
    setup([recordOf(manifestOf('a')), recordOf(manifestOf('b'))]);
    const store = usePluginRuntimeStore();
    await store.enterSave(SAVE_ID);
    const a = store.openSurface('a', 'main')!;
    const b = store.openSurface('b', 'main')!;
    store.focusSurface(a);
    const za = store.openSurfaces.find((s) => s.surfaceId === a)!.zIndex;
    const zb = store.openSurfaces.find((s) => s.surfaceId === b)!.zIndex;
    expect(za).toBeGreaterThan(zb);
    expect(store.focusedSurfaceId).toBe(a);
    store.closeSurface(a);
    expect(store.focusedSurfaceId).toBe(b);
  });

  it('未生效的插件打不开界面', async () => {
    setup([recordOf(manifestOf('a'))]);
    const store = usePluginRuntimeStore();
    await store.enterSave(SAVE_ID);
    expect(store.openSurface('ghost', 'main')).toBeNull();
    expect(store.openSurface('a', 'nope')).toBeNull();
  });
});

describe('plugin-runtime-store 后台页面', () => {
  it('后台页面最多启动 8 个，挂在离屏容器里而不是 display:none', async () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      recordOf(manifestOf(`bg${i}`, { background: 'bg.html' })),
    );
    setup(records);
    const store = usePluginRuntimeStore();
    await store.enterSave(SAVE_ID);

    await vi.waitFor(() => expect(mounted).toHaveLength(8));
    await new Promise((r) => setTimeout(r, 20));
    expect(mounted).toHaveLength(8);
    expect(mounted.every((m) => m.entry === 'bg.html')).toBe(true);
    const calls = frameMock.mountPluginFrame.mock.calls as Array<
      [HTMLElement, { hidden?: boolean }]
    >;
    expect(calls.every(([, options]) => options.hidden !== true)).toBe(true);
    const host = mounted[0].container.parentElement!;
    expect(host.style.left).toBe('-10000px');
    expect(host.style.display).not.toBe('none');
  });

  it('离开存档拆掉所有帧（后台与界面）', async () => {
    setup([recordOf(manifestOf('a', { background: 'bg.html' }))]);
    const store = usePluginRuntimeStore();
    await store.enterSave(SAVE_ID);
    await vi.waitFor(() => expect(mounted).toHaveLength(1));
    await openAndMount(store, 'a');
    expect(mounted).toHaveLength(2);

    store.leaveSave();
    for (const m of mounted) expect(m.dispose).toHaveBeenCalledTimes(1);
    expect(store.openSurfaces).toEqual([]);
  });
});

describe('plugin-runtime-store 事件与宿主回调', () => {
  it('管线回合信号转成插件事件，别的存档的信号不转', async () => {
    setup([recordOf(manifestOf('a'))]);
    const store = usePluginRuntimeStore();
    await store.enterSave(SAVE_ID);
    const { frame } = await openAndMount(store, 'a');

    const subscribed = await request(frame.framePort, 'on', ['turn.end']);
    expect(subscribed.ok).toBe(true);

    const received: string[] = [];
    frame.framePort.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as Record<string, unknown>;
      if (data.type === 'event') received.push(String(data.name));
    });
    const got = nextEvent(frame.framePort, 'turn.end');
    emitPluginTurnSignal({ type: 'turn.end', saveId: 'other-save' });
    emitPluginTurnSignal({ type: 'turn.end', saveId: SAVE_ID });
    const event = await got;
    expect(event.payload).toEqual({ turn: 3 });
    expect(received).toEqual(['turn.end']);
  });

  it('生成中写入返回 BUSY，战斗中返回 IN_COMBAT', async () => {
    const { game } = setup([recordOf(manifestOf('a'))]);
    const store = usePluginRuntimeStore();
    await store.enterSave(SAVE_ID);
    await vi.waitFor(() => expect(store.lockState).toBe('held'));
    const { frame } = await openAndMount(store, 'a');

    game.isGenerating = true;
    const busy = await request(frame.framePort, 'commit', [{ commands: [] }]);
    expect(busy).toMatchObject({ ok: false, code: 'BUSY' });
    expect(String(busy.message)).toContain('生成');

    game.isGenerating = false;
    game.isInCombat = true;
    const combat = await request(frame.framePort, 'commit', [{ commands: [] }]);
    expect(combat).toMatchObject({ ok: false, code: 'IN_COMBAT' });
  });

  it('openExternal 只把链接交给弹窗状态，不导航', async () => {
    setup([recordOf(manifestOf('a'))]);
    const store = usePluginRuntimeStore();
    await store.enterSave(SAVE_ID);
    const { frame } = await openAndMount(store, 'a');

    const res = await request(frame.framePort, 'ui.openExternal', ['https://example.com/shop']);
    expect(res.ok).toBe(true);
    expect(store.externalLink).toEqual({
      pluginName: '插件a',
      url: 'https://example.com/shop',
    });
  });

  it('fillInput 写进待回填文本，只填不发', async () => {
    setup([recordOf(manifestOf('a'))]);
    const store = usePluginRuntimeStore();
    await store.enterSave(SAVE_ID);
    const { frame } = await openAndMount(store, 'a');

    const res = await request(frame.framePort, 'ui.fillInput', ['买一把剑']);
    expect(res.ok).toBe(true);
    expect(store.pendingInputFill).toBe('买一把剑');
  });

  it('ui.close 关掉发起请求的那个界面', async () => {
    setup([recordOf(manifestOf('a'))]);
    const store = usePluginRuntimeStore();
    await store.enterSave(SAVE_ID);
    const { surfaceId, frame } = await openAndMount(store, 'a');

    // 界面关掉时桥一并拆除，这条请求不会有回话（帧本身也要销毁了）
    void request(frame.framePort, 'ui.close');
    await vi.waitFor(() =>
      expect(store.openSurfaces.map((s) => s.surfaceId)).not.toContain(surfaceId),
    );
    expect(frame.dispose).toHaveBeenCalledTimes(1);
  });

  it('插件提交 character.remove 成功后，回读把被删的角色从 game-store 内存里去掉', async () => {
    const { game } = setup([
      recordOf(
        manifestOf('a', {
          capabilities: {
            read: ['player'],
            commands: ['character.remove'],
            events: [],
            ai: [],
            storage: [],
          },
        }),
      ),
    ]);
    game.characters = [
      { id: 'c-player', name: '艾琳' },
      { id: 'c-goblin', name: '哥布林' },
    ];
    const commitPluginCommand = vi.fn(async () => ({ ok: true }));
    vi.mocked(createStateManager).mockReturnValue({
      commitPluginCommand,
      amendCurrentTurnSnapshot: vi.fn(async () => {}),
    } as unknown as ReturnType<typeof createStateManager>);
    // 库里已经没有哥布林；refreshFromDb 是合并语义，不会自己删
    dbMock.getCharacters.mockResolvedValue([{ id: 'c-player', name: '艾琳' }]);

    const store = usePluginRuntimeStore();
    await store.enterSave(SAVE_ID);
    await vi.waitFor(() => expect(store.lockState).toBe('held'));
    const { frame } = await openAndMount(store, 'a');

    const res = await request(frame.framePort, 'commit', [
      { commands: [{ type: 'character.remove', target: '哥布林' }] },
    ]);
    expect(res.ok).toBe(true);
    expect(commitPluginCommand).toHaveBeenCalledTimes(1);
    expect(game.refreshFromDb).toHaveBeenCalledWith(SAVE_ID);
    expect(dbMock.getCharacters).toHaveBeenCalledWith(SAVE_ID);
    expect((game.characters as Array<{ id: string }>).map((c) => c.id)).toEqual(['c-player']);
  });
});
