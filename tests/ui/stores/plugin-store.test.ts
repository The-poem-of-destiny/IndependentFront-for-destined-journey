/**
 * plugin-store —— 插件注册表 Store 测试（插件系统设计 §3.3、§3.4、§4.8；计划决策 7、8、9）。
 *
 * 本地文件夹（BFF）走 plugin-client 替身，自检与图标洗图也替身掉；
 * 数据层是真 Dexie + fake-indexeddb（tests/setup.ts 注入）。
 *
 * @vitest-environment jsdom
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  clearAllData,
  getSave,
  initializeDatabase,
  saveSaveSlot,
} from '@engine/persistence/database';
import {
  getPluginRecord,
  listPluginRecords,
  setPluginSaveConsent,
} from '@engine/persistence/plugin-storage';
import type { SaveSlot } from '@engine/types/types';
import type { LocalPluginListing } from '../../../src/ui/lib/plugin-client';
import type { PluginSelfCheckResult } from '../../../src/ui/lib/plugin-selfcheck';

// ─── 替身 ───

/** 本地插件文件夹：插件 id → 路径 → 字节 */
const folder = new Map<string, Map<string, Uint8Array>>();

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function buildListing(): LocalPluginListing {
  return {
    enabled: true,
    dir: '/plugins',
    dirExists: true,
    plugins: [...folder.entries()].map(([id, files]) => {
      const manifest = files.get('manifest.json');
      const list = [...files.entries()].map(([path, bytes]) => ({
        path,
        size: bytes.byteLength,
        sha256: sha256(bytes),
      }));
      return {
        id,
        manifestText: manifest ? new TextDecoder().decode(manifest) : null,
        files: list,
        totalBytes: list.reduce((n, f) => n + f.size, 0),
      };
    }),
  };
}

const clientMock = vi.hoisted(() => ({
  fetchLocalPlugins: vi.fn(),
  fetchLocalPluginFile: vi.fn(),
}));
vi.mock('../../../src/ui/lib/plugin-client', () => clientMock);

const selfCheckMock = vi.hoisted(() => ({ runPluginSelfCheck: vi.fn() }));
vi.mock('../../../src/ui/lib/plugin-selfcheck', () => selfCheckMock);

vi.mock('../../../src/ui/lib/plugin-icon', () => ({
  preparePluginIcon: vi.fn(async () => 'data:image/png;base64,QUJD'),
}));

import { usePluginStore } from '../../../src/ui/stores/plugin-store';
import type {
  PluginConfirmation,
  PluginEntryView,
  PluginStoreResult,
} from '../../../src/ui/stores/plugin-store';
import { useGameStore } from '../../../src/ui/stores/game-store';

const fetchMock = vi.fn();

// ─── 夹具 ───

const PLUGIN_ID = 'example.shop';
const SAVE_ID = 'save-plugin-store';
const CONFIRMED: PluginConfirmation = { confirmed: true };

function manifestBytes(patch: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      manifestVersion: 1,
      id: PLUGIN_ID,
      name: '杂货铺',
      version: '1.0.0',
      pluginApi: '^1.0',
      contributions: [
        {
          slot: 'game.toolbar',
          id: 'shop',
          label: '杂货铺',
          icon: 'icon.png',
          surface: 'window',
          entry: 'shop.html',
        },
      ],
      network: ['api.example.com'],
      capabilities: { read: ['player'] },
      ...patch,
    }),
  );
}

function putLocalPlugin(opts: { html?: string; manifest?: Record<string, unknown> } = {}): void {
  folder.set(
    PLUGIN_ID,
    new Map([
      ['manifest.json', manifestBytes(opts.manifest)],
      ['shop.html', new TextEncoder().encode(opts.html ?? '<p>店</p>')],
      ['icon.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    ]),
  );
}

function makeSave(): SaveSlot {
  return {
    id: SAVE_ID,
    name: '插件测试档',
    slot: 0,
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: {
      characterName: '阿黑',
      userName: 'Tester',
      gameStartTime: '0488-01-01',
      totalTurns: 0,
    },
  };
}

function selfCheckResult(ok: boolean): PluginSelfCheckResult {
  return { ok, innerMode: ok ? 'srcdoc' : null, items: [], ranAt: 1 };
}

function viewOf(store: ReturnType<typeof usePluginStore>): PluginEntryView | undefined {
  return store.entries.find((e) => e.id === PLUGIN_ID);
}

function expectFailure(result: PluginStoreResult, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}

async function installed(store: ReturnType<typeof usePluginStore>) {
  await store.refresh();
  expect((await store.install(PLUGIN_ID, CONFIRMED)).ok).toBe(true);
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await initializeDatabase();
  await clearAllData();
  folder.clear();
  clientMock.fetchLocalPlugins.mockReset();
  clientMock.fetchLocalPlugins.mockImplementation(async () => ({
    ok: true,
    value: buildListing(),
  }));
  clientMock.fetchLocalPluginFile.mockReset();
  clientMock.fetchLocalPluginFile.mockImplementation(
    async (id: string, path: string, expected: string) => {
      const bytes = folder.get(id)?.get(path);
      if (!bytes) return { ok: false, code: 'HTTP', message: '404', status: 404 };
      if (sha256(bytes) !== expected) {
        return { ok: false, code: 'HASH_MISMATCH', message: '内容与清单不一致' };
      }
      return { ok: true, value: bytes };
    },
  );
  selfCheckMock.runPluginSelfCheck.mockReset();
  selfCheckMock.runPluginSelfCheck.mockImplementation(async () => selfCheckResult(true));
  // 第二回环主机名探活默认不可达（不让测试真的发网络请求）
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    throw new TypeError('Failed to fetch');
  });
  vi.stubGlobal('fetch', fetchMock);
  await saveSaveSlot(makeSave());
  await useGameStore().loadSaves();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── 测试 ───

describe('安装与更新必须经过确认', () => {
  it('未确认时拒绝安装，什么也不写', async () => {
    putLocalPlugin();
    const store = usePluginStore();
    await store.refresh();
    expect(viewOf(store)?.status).toBe('not-installed');

    expectFailure(await store.install(PLUGIN_ID, { confirmed: false }), 'NEEDS_CONFIRMATION');
    expect(await getPluginRecord(PLUGIN_ID)).toBeUndefined();
    expect(clientMock.fetchLocalPluginFile).not.toHaveBeenCalled();
  });

  it('确认后安装：落库、记安装确认、图标进内存、状态为已是最新', async () => {
    putLocalPlugin();
    const store = usePluginStore();
    await installed(store);

    const record = await getPluginRecord(PLUGIN_ID);
    expect(record?.installConsent.contentHash).toBe(record?.contentHash);
    expect(record?.installConsent.networkHash).toBe(record?.networkHash);
    expect(record?.installConsent.version).toBe('1.0.0');
    expect(record?.fileCount).toBe(3);
    expect(viewOf(store)?.status).toBe('up-to-date');
    expect(store.iconFor(PLUGIN_ID, 'shop')).toBe('data:image/png;base64,QUJD');
  });

  it('文件夹里的内容变了只标「有更新」，不静默更新', async () => {
    putLocalPlugin();
    const store = usePluginStore();
    await installed(store);
    const before = await getPluginRecord(PLUGIN_ID);

    putLocalPlugin({ html: '<p>新版</p>' });
    await store.refresh();

    expect(viewOf(store)?.status).toBe('update-available');
    expect((await getPluginRecord(PLUGIN_ID))?.contentHash).toBe(before?.contentHash);
    expectFailure(await store.install(PLUGIN_ID, { confirmed: false }), 'NEEDS_CONFIRMATION');

    expect((await store.install(PLUGIN_ID, CONFIRMED)).ok).toBe(true);
    expect((await getPluginRecord(PLUGIN_ID))?.contentHash).not.toBe(before?.contentHash);
    expect(viewOf(store)?.status).toBe('up-to-date');
  });

  it('取文件时哈希对不上（清单后被改）→ CHANGED，不落库', async () => {
    putLocalPlugin();
    const store = usePluginStore();
    await store.refresh();
    putLocalPlugin({ html: '<p>清单之后又改了</p>' });

    expectFailure(await store.install(PLUGIN_ID, CONFIRMED), 'CHANGED');
    expect(await getPluginRecord(PLUGIN_ID)).toBeUndefined();
  });

  it('无效插件不可安装', async () => {
    folder.set(PLUGIN_ID, new Map([['shop.html', new TextEncoder().encode('x')]]));
    const store = usePluginStore();
    await store.refresh();
    expect(viewOf(store)?.status).toBe('invalid');
    expect(viewOf(store)?.errors.length).toBeGreaterThan(0);
    expectFailure(await store.install(PLUGIN_ID, CONFIRMED), 'NOT_INSTALLABLE');
  });

  it('pluginApi 不满足时标「不兼容」', async () => {
    putLocalPlugin({ manifest: { pluginApi: '^9.0' } });
    const store = usePluginStore();
    await store.refresh();
    expect(viewOf(store)?.status).toBe('incompatible');
  });
});

describe('开发者自动重载', () => {
  it('开着时 network 没变的更新免确认直接装上', async () => {
    putLocalPlugin();
    const store = usePluginStore();
    await installed(store);
    const before = await getPluginRecord(PLUGIN_ID);

    putLocalPlugin({ html: '<p>热改</p>' });
    await store.refresh({ devAutoReload: true });

    expect((await getPluginRecord(PLUGIN_ID))?.contentHash).not.toBe(before?.contentHash);
    expect(viewOf(store)?.status).toBe('up-to-date');
  });

  it('开着时 network 变了仍要确认，不自动装', async () => {
    putLocalPlugin();
    const store = usePluginStore();
    await installed(store);
    const before = await getPluginRecord(PLUGIN_ID);

    putLocalPlugin({ manifest: { network: ['api.example.com', 'cdn.example.com'] } });
    await store.refresh({ devAutoReload: true });

    expect((await getPluginRecord(PLUGIN_ID))?.contentHash).toBe(before?.contentHash);
    expect(viewOf(store)?.status).toBe('update-available');
    expect(viewOf(store)?.plan?.networkAdded).toEqual(['cdn.example.com']);
  });
});

describe('按存档启用', () => {
  it('启用要确认；确认后记本机确认、写启用轴并置 pluginHardened', async () => {
    putLocalPlugin();
    const store = usePluginStore();
    await installed(store);
    await store.ensureSelfCheck();

    expectFailure(
      await store.enableForSave(SAVE_ID, PLUGIN_ID, { confirmed: false }),
      'NEEDS_CONFIRMATION',
    );
    expect(store.isEffectivelyEnabled(SAVE_ID, PLUGIN_ID)).toBe(false);

    expect((await store.enableForSave(SAVE_ID, PLUGIN_ID, CONFIRMED)).ok).toBe(true);
    const save = useGameStore().saves.find((s) => s.id === SAVE_ID);
    expect(save?.metadata?.enabledPluginIds).toEqual([PLUGIN_ID]);
    expect(save?.metadata?.pluginHardened).toBe(true);
    const record = await getPluginRecord(PLUGIN_ID);
    expect(record?.saveConsents[SAVE_ID]?.networkHash).toBe(record?.networkHash);
    expect(store.isEffectivelyEnabled(SAVE_ID, PLUGIN_ID)).toBe(true);
    expect(store.effectivePluginsForSave(SAVE_ID).map((r) => r.id)).toEqual([PLUGIN_ID]);
  });

  it('游玩中途启用时顺手踢一脚自检，自检通过后即生效', async () => {
    putLocalPlugin();
    await installed(usePluginStore());
    // 换一个从未跑过自检的页面会话，只读回已装记录（不经 refresh，免得它先踢自检）
    setActivePinia(createPinia());
    await useGameStore().loadSaves();
    const store = usePluginStore();
    store.records = await listPluginRecords();
    selfCheckMock.runPluginSelfCheck.mockClear();
    expect(store.selfCheck).toBeNull();

    expect((await store.enableForSave(SAVE_ID, PLUGIN_ID, CONFIRMED)).ok).toBe(true);
    expect(selfCheckMock.runPluginSelfCheck).toHaveBeenCalledTimes(1);
    await store.ensureSelfCheck();
    expect(store.isEffectivelyEnabled(SAVE_ID, PLUGIN_ID)).toBe(true);
  });

  it('实际生效三条件缺一不可：启用轴 / 本机确认 networkHash 一致 / 自检通过', async () => {
    putLocalPlugin();
    const store = usePluginStore();
    await installed(store);
    await store.ensureSelfCheck();
    await store.enableForSave(SAVE_ID, PLUGIN_ID, CONFIRMED);
    expect(store.isEffectivelyEnabled(SAVE_ID, PLUGIN_ID)).toBe(true);

    // 本机确认的 networkHash 对不上（例如旧版本留下的）
    const record = await getPluginRecord(PLUGIN_ID);
    await setPluginSaveConsent(PLUGIN_ID, SAVE_ID, {
      ...record!.saveConsents[SAVE_ID],
      networkHash: 'stale',
    });
    await store.refresh();
    expect(store.isEffectivelyEnabled(SAVE_ID, PLUGIN_ID)).toBe(false);
    expect(store.needsReconfirm(SAVE_ID).map((r) => r.id)).toEqual([PLUGIN_ID]);

    // 本机没有确认（导入的存档）
    await setPluginSaveConsent(PLUGIN_ID, SAVE_ID, null);
    await store.refresh();
    expect(store.isEffectivelyEnabled(SAVE_ID, PLUGIN_ID)).toBe(false);
    expect(store.needsReconfirm(SAVE_ID).map((r) => r.id)).toEqual([PLUGIN_ID]);

    // 重新确认后恢复；启用轴里没有它则不生效
    await store.enableForSave(SAVE_ID, PLUGIN_ID, CONFIRMED);
    expect(store.isEffectivelyEnabled(SAVE_ID, PLUGIN_ID)).toBe(true);
    expect(store.isEffectivelyEnabled('another-save', PLUGIN_ID)).toBe(false);
    await useGameStore().setSaveEnabledPlugins(SAVE_ID, []);
    expect(store.isEffectivelyEnabled(SAVE_ID, PLUGIN_ID)).toBe(false);
  });

  it('自检没通过时一律不生效', async () => {
    selfCheckMock.runPluginSelfCheck.mockImplementation(async () => selfCheckResult(false));
    putLocalPlugin();
    const store = usePluginStore();
    await installed(store);
    await store.ensureSelfCheck();
    await store.enableForSave(SAVE_ID, PLUGIN_ID, CONFIRMED);
    expect(store.selfCheckPassed).toBe(false);
    expect(store.isEffectivelyEnabled(SAVE_ID, PLUGIN_ID)).toBe(false);
    expect(store.effectivePluginsForSave(SAVE_ID)).toEqual([]);
  });

  it('更新后 network 变了：本机所有按存档确认作废；network 没变则保留', async () => {
    putLocalPlugin();
    const store = usePluginStore();
    await installed(store);
    await store.ensureSelfCheck();
    await store.enableForSave(SAVE_ID, PLUGIN_ID, CONFIRMED);

    putLocalPlugin({ html: '<p>只改内容</p>' });
    await store.refresh();
    await store.install(PLUGIN_ID, CONFIRMED);
    expect((await getPluginRecord(PLUGIN_ID))?.saveConsents[SAVE_ID]).toBeDefined();
    expect(store.isEffectivelyEnabled(SAVE_ID, PLUGIN_ID)).toBe(true);

    putLocalPlugin({ manifest: { network: ['other.example.com'] } });
    await store.refresh();
    await store.install(PLUGIN_ID, CONFIRMED);
    expect((await getPluginRecord(PLUGIN_ID))?.saveConsents).toEqual({});
    expect(store.isEffectivelyEnabled(SAVE_ID, PLUGIN_ID)).toBe(false);
    expect(store.needsReconfirm(SAVE_ID).map((r) => r.id)).toEqual([PLUGIN_ID]);
  });

  it('停用撤销本机确认并移出启用轴，pluginHardened 保持', async () => {
    putLocalPlugin();
    const store = usePluginStore();
    await installed(store);
    await store.enableForSave(SAVE_ID, PLUGIN_ID, CONFIRMED);

    expect((await store.disableForSave(SAVE_ID, PLUGIN_ID)).ok).toBe(true);
    const save = useGameStore().saves.find((s) => s.id === SAVE_ID);
    expect(save?.metadata?.enabledPluginIds).toEqual([]);
    expect(save?.metadata?.pluginHardened).toBe(true);
    expect((await getPluginRecord(PLUGIN_ID))?.saveConsents[SAVE_ID]).toBeUndefined();
  });

  it('存档启用轴里已有该插件但缺 pluginHardened（导入 / 手改）时，重新确认也补写加固', async () => {
    putLocalPlugin();
    const store = usePluginStore();
    await installed(store);
    const game = useGameStore();
    await saveSaveSlot({
      ...makeSave(),
      metadata: { ...makeSave().metadata, enabledPluginIds: [PLUGIN_ID] },
    });
    await game.loadSaves();
    expect(game.saves.find((s) => s.id === SAVE_ID)?.metadata?.pluginHardened).toBeUndefined();

    expect((await store.enableForSave(SAVE_ID, PLUGIN_ID, CONFIRMED)).ok).toBe(true);
    expect(game.saves.find((s) => s.id === SAVE_ID)?.metadata?.pluginHardened).toBe(true);
    expect((await getSave(SAVE_ID))?.metadata?.pluginHardened).toBe(true);
    expect(game.saves.find((s) => s.id === SAVE_ID)?.metadata?.enabledPluginIds).toEqual([
      PLUGIN_ID,
    ]);
  });

  it('卸载后存档里的启用项列为「启用了但没装」；forgetSave 清掉对已删存档的确认', async () => {
    putLocalPlugin();
    const store = usePluginStore();
    await installed(store);
    await store.enableForSave(SAVE_ID, PLUGIN_ID, CONFIRMED);

    await store.forgetSave(SAVE_ID);
    expect((await getPluginRecord(PLUGIN_ID))?.saveConsents[SAVE_ID]).toBeUndefined();

    expect((await store.uninstall(PLUGIN_ID)).ok).toBe(true);
    expect(await getPluginRecord(PLUGIN_ID)).toBeUndefined();
    expect(store.enabledButNotInstalled(SAVE_ID)).toEqual([PLUGIN_ID]);
    expect(store.iconFor(PLUGIN_ID, 'shop')).toBeNull();
    expect(viewOf(store)?.status).toBe('not-installed');
  });
});

describe('自检', () => {
  it('页面会话内只跑一次，并发调用共用同一轮', async () => {
    putLocalPlugin();
    const store = usePluginStore();
    expect(store.selfCheck).toBeNull();
    await installed(store);
    const [a, b] = await Promise.all([store.ensureSelfCheck(), store.ensureSelfCheck()]);
    await store.refresh();
    await store.ensureSelfCheck();

    expect(a).toBe(b);
    expect(selfCheckMock.runPluginSelfCheck).toHaveBeenCalledTimes(1);
    expect(store.selfCheck).toEqual(selfCheckResult(true));
  });

  it('「重新检查」丢掉缓存结果再跑一轮；跑着时不另起一轮', async () => {
    const store = usePluginStore();
    selfCheckMock.runPluginSelfCheck.mockImplementation(async () => selfCheckResult(false));
    await store.ensureSelfCheck();
    expect(store.selfCheckPassed).toBe(false);

    selfCheckMock.runPluginSelfCheck.mockImplementation(async () => selfCheckResult(true));
    const first = store.rerunSelfCheck();
    const second = store.rerunSelfCheck();
    expect(store.selfCheck).toBe('running');
    expect(await first).toBe(await second);
    expect(selfCheckMock.runPluginSelfCheck).toHaveBeenCalledTimes(2);
    expect(store.selfCheckPassed).toBe(true);
  });

  it('探针容器离屏但参与渲染（不是 display:none），跑完即拆', async () => {
    let seen: { position: string; left: string; display: string; attached: boolean } | null = null;
    selfCheckMock.runPluginSelfCheck.mockImplementation(async (deps) => {
      const handle = deps.mount.document({ html: '<p>探针</p>', sandbox: 'allow-scripts' });
      const frame = document.querySelector('iframe');
      const container = frame?.parentElement as HTMLElement;
      seen = {
        position: container.style.position,
        left: container.style.left,
        display: container.style.display,
        attached: document.body.contains(container),
      };
      handle.dispose();
      expect(deps.origin).toBe(location.origin);
      return selfCheckResult(true);
    });
    const store = usePluginStore();
    await store.ensureSelfCheck();

    expect(seen).toEqual({ position: 'fixed', left: '-10000px', display: '', attached: true });
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.body.children.length).toBe(0);
  });

  it('第二回环主机名探活失败时不传 secondLoopbackHost（S5 记为跳过）', async () => {
    let seenHost: unknown = 'unset';
    selfCheckMock.runPluginSelfCheck.mockImplementation(async (deps) => {
      seenHost = deps.secondLoopbackHost;
      return selfCheckResult(true);
    });
    await usePluginStore().ensureSelfCheck();

    expect(location.hostname).toBe('localhost');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${location.protocol}//127.0.0.1${location.port ? `:${location.port}` : ''}/api/plugins/__selfcheck/hits?n=`,
    );
    expect(init.mode).toBe('no-cors');
    expect(seenHost).toBeUndefined();
  });

  it('第二回环主机名探活拿到响应（不透明响应也算）时才传给自检', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    let seenHost: unknown = 'unset';
    selfCheckMock.runPluginSelfCheck.mockImplementation(async (deps) => {
      seenHost = deps.secondLoopbackHost;
      return selfCheckResult(true);
    });
    await usePluginStore().ensureSelfCheck();
    expect(seenHost).toBe('127.0.0.1');
  });

  it('本地文件夹不可用时记下原因，已装插件照常列出', async () => {
    putLocalPlugin();
    const store = usePluginStore();
    await installed(store);
    clientMock.fetchLocalPlugins.mockImplementation(async () => ({
      ok: true,
      value: { enabled: false, reason: 'inside-root', message: '插件目录不能放在仓库里' },
    }));
    await store.refresh();
    expect(store.listingError).toBe('插件目录不能放在仓库里');
    expect(viewOf(store)?.status).toBe('missing-source');
  });
});

describe('game-store.ensureSaveHardened（决策 8 粘滞加固补齐）', () => {
  async function seedSave(metadata: Partial<NonNullable<SaveSlot['metadata']>>): Promise<void> {
    await saveSaveSlot({ ...makeSave(), metadata: { ...makeSave().metadata, ...metadata } });
    await useGameStore().loadSaves();
  }

  it('启用轴非空但缺 pluginHardened 时置真并落库', async () => {
    await seedSave({ enabledPluginIds: [PLUGIN_ID] });
    const game = useGameStore();
    expect(await game.ensureSaveHardened(SAVE_ID)).toBe(true);
    expect(game.saves.find((s) => s.id === SAVE_ID)?.metadata?.pluginHardened).toBe(true);
    expect((await getSave(SAVE_ID))?.metadata?.pluginHardened).toBe(true);
  });

  it('启用轴为空时不写加固标记', async () => {
    await seedSave({ enabledPluginIds: [] });
    const game = useGameStore();
    expect(await game.ensureSaveHardened(SAVE_ID)).toBe(true);
    expect((await getSave(SAVE_ID))?.metadata?.pluginHardened).toBeUndefined();
  });

  it('已加固时不重复写库', async () => {
    await seedSave({ enabledPluginIds: [PLUGIN_ID], pluginHardened: true });
    const game = useGameStore();
    const before = (await getSave(SAVE_ID))?.updatedAt;
    expect(await game.ensureSaveHardened(SAVE_ID)).toBe(true);
    expect((await getSave(SAVE_ID))?.updatedAt).toBe(before);
  });

  it('找不到存档时返回 false', async () => {
    expect(await useGameStore().ensureSaveHardened('no-such-save')).toBe(false);
  });
});
