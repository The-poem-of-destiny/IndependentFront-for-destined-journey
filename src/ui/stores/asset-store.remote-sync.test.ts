/**
 * asset-store.remote-sync.test.ts — `syncRemoteAssets()` 这条 action 的契约（远程素材 v1）
 *
 * 清单本身（谁下、谁删、谁让路）在 `lib/remote-asset-sync.test.ts` 里穷举过了；
 * 本文件只钉 **store 那一层**的三件事，它们各自对应一个真实的失败形态：
 *
 * 1. **单飞** —— 启动链踢一脚、设置页的按钮也踢一脚。两次同时进来若各跑一遍，
 *    两条同步会拿着**同一份旧库快照**去算镜像清单：第二条会把第一条刚落的行当成
 *    「不在清单里的远程行」删掉。这是本特性最贵的一条竞态，所以它有专门的用例。
 * 2. **开关关着 = 彻底 no-op** —— 尤其是**一行都不许删**。「关掉同步」不该等于
 *    「把之前下的都收走」。
 * 3. **前置齐了才跑** —— 声明的一半住在世界书里（含工坊装的书），另一半在内容
 *    注册表那一面。少等哪一个，症状都是「装了包却没有立绘」，且不报错。
 *
 * 数据层是真 Dexie + fake-indexeddb；四个前置 store 用替身（它们各自有自己的测试）。
 * **fetch 全程 mock，一个字节都不出网。**
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { AssetMetaRecord } from '@engine/types';

// ── 四个前置 store 的替身（asset-store 是动态 import 它们的，照样 mock 得到）──

const settingsBag = { remoteAssetsEnabled: true as boolean };
vi.mock('./settings-store', () => ({
  useSettingsStore: () => ({ settings: settingsBag }),
}));

const worldbookInit = vi.fn(async () => {});
const worldbookBooks: unknown[] = [];
vi.mock('./worldbook-store', () => ({
  useWorldBookStore: () => ({ init: worldbookInit, books: worldbookBooks }),
}));

const workshopInit = vi.fn(async () => {});
vi.mock('./workshop-store', () => ({
  useWorkshopStore: () => ({ init: workshopInit }),
}));

/** 注册表那一面的当前值 + 一个可以人为拖住的加载门（单飞用例靠它制造重叠窗口） */
let registryFace: unknown = [];
let registryGate: Promise<void> | null = null;
const ensureContentRegistryLoaded = vi.fn(async () => {
  if (registryGate) await registryGate;
});
vi.mock('./content-store', () => ({
  ensureContentRegistryLoaded: () => ensureContentRegistryLoaded(),
  getContentRegistry: () => ({ remoteAssets: registryFace }),
}));

// ── audio-store：素材 store 静态引它，同步路径用不到，替身掉免得起 AudioManager ──
vi.mock('./audio-store', () => ({
  useAudioStore: () => ({ refreshTracks: async () => {}, builtinTracks: [] }),
}));

import {
  clearAllData,
  initializeDatabase,
  getAssets,
  saveAsset as dbSaveAsset,
} from '@engine/database';
import { useAssetStore } from './asset-store';
import { useUIStore } from './ui-store';

// ═══════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function pngResponse(): Response {
  return new Response(PNG.slice().buffer as ArrayBuffer, {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}

/** 往库里塞一条**带远程戳**的行（= 上一次同步下下来的） */
async function seedRemoteRow(name: string, url: string): Promise<AssetMetaRecord> {
  const now = Date.now();
  const meta: AssetMetaRecord = {
    id: `seed_${name}`,
    name,
    type: '头像',
    ext: 'png',
    mime: 'image/png',
    bytes: PNG.length,
    createdAt: now,
    updatedAt: now,
    remote: { url, syncedAt: now },
  };
  await dbSaveAsset(meta, new Blob([PNG.slice().buffer as ArrayBuffer], { type: 'image/png' }));
  return meta;
}

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;
function installFetchMock(): void {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => pngResponse());
}

beforeEach(async () => {
  try {
    await clearAllData();
  } catch {
    /* 首次运行时库还不存在 */
  }
  await initializeDatabase();
  setActivePinia(createPinia());
  settingsBag.remoteAssetsEnabled = true;
  worldbookBooks.length = 0;
  registryFace = [];
  registryGate = null;
  worldbookInit.mockClear();
  workshopInit.mockClear();
  ensureContentRegistryLoaded.mockClear();
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

// ═══════════════════════════════════════════════════════════

describe('syncRemoteAssets —— 开关', () => {
  it('🔴 关掉 = 彻底 no-op：不删、不下、连前置都不等', async () => {
    settingsBag.remoteAssetsEnabled = false;
    const orphan = await seedRemoteRow('旧角色', 'https://a.invalid/old.png');
    installFetchMock();
    const store = useAssetStore();

    // 清单为空 + 库里有一条孤儿远程行 —— 开着的话这一行**会被镜像删掉**，
    // 所以这条用例同时证明了「关掉」确实短路在删除之前
    const res = await store.syncRemoteAssets();

    expect(res).toBeNull();
    expect((await getAssets()).map((a) => a.id)).toEqual([orphan.id]);
    expect(ensureContentRegistryLoaded).not.toHaveBeenCalled();
    expect(worldbookInit).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.remoteSync.lastResult).toBeNull();
  });

  it('打开时同一份状态下会真的删（证明上一条不是因为清单本来就是空的）', async () => {
    await seedRemoteRow('旧角色', 'https://a.invalid/old.png');
    installFetchMock();
    const store = useAssetStore();

    const res = await store.syncRemoteAssets();

    expect(res?.deleted).toBe(1);
    expect(await getAssets()).toEqual([]);
  });
});

describe('syncRemoteAssets —— 单飞', () => {
  it('🔴 并发两次合并成一次（同一个 promise，前置只走一轮）', async () => {
    installFetchMock();
    let release!: () => void;
    registryGate = new Promise<void>((r) => {
      release = r;
    });
    const store = useAssetStore();

    const a = store.syncRemoteAssets();
    const b = store.syncRemoteAssets();
    expect(store.remoteSync.running).toBe(true);

    release();
    const [ra, rb] = await Promise.all([a, b]);

    // 🔴 判据是**同一份回执对象**而不是同一个 promise：Pinia 的 action 包装器会给每次
    //    调用再套一层 `.then`，两个 promise 天然不同 —— 拿 promise 判等只会测到 Pinia。
    //    两次跑出来的会是两个不同的对象，所以这条断言真的能红。
    expect(ra).toBe(rb);
    expect(ensureContentRegistryLoaded).toHaveBeenCalledTimes(1);
    expect(workshopInit).toHaveBeenCalledTimes(1);
    expect(store.remoteSync.running).toBe(false);
  });

  it('跑完之后闸放开，下一次照常跑（不是「一辈子只跑一次」）', async () => {
    installFetchMock();
    const store = useAssetStore();
    await store.syncRemoteAssets();
    await store.syncRemoteAssets();
    expect(ensureContentRegistryLoaded).toHaveBeenCalledTimes(2);
  });
});

describe('syncRemoteAssets —— 声明来源与回执', () => {
  it('内容包那一面的声明会被真的下下来并落库（带 remote 戳）', async () => {
    registryFace = [{ name: '苏婉', url: 'https://a.invalid/su.png' }];
    installFetchMock();
    const store = useAssetStore();

    const res = await store.syncRemoteAssets();

    expect(res).toMatchObject({ downloaded: 1, replaced: 0, deleted: 0, failed: [] });
    const rows = await getAssets();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: '苏婉', type: '头像', ext: 'png' });
    expect(rows[0].remote?.url).toBe('https://a.invalid/su.png');
    // 落库之后 store 的响应式库要跟着刷新（否则界面要刷新页面才看得见）
    expect(store.assets.map((a) => a.name)).toEqual(['苏婉']);
    // `remoteSync` 是 reactive 的，读出来是代理不是原对象 —— 判等而不是判同
    expect(store.remoteSync.lastResult).toEqual(res);
    expect(store.remoteSync.lastAt).toBeGreaterThan(0);
  });

  it('🔴 用户自己导入的同名行永远赢：一次请求都不发，行原样不动', async () => {
    const now = Date.now();
    const mine: AssetMetaRecord = {
      id: 'mine',
      name: '苏婉',
      type: '头像',
      ext: 'png',
      mime: 'image/png',
      bytes: PNG.length,
      createdAt: now,
      updatedAt: now,
    };
    await dbSaveAsset(mine, new Blob([PNG.slice().buffer as ArrayBuffer], { type: 'image/png' }));
    registryFace = [{ name: '苏婉', url: 'https://a.invalid/su.png' }];
    installFetchMock();

    const res = await useAssetStore().syncRemoteAssets();

    expect(res?.skippedUserOwned).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const rows = await getAssets();
    expect(rows).toHaveLength(1);
    expect(rows[0].remote).toBeUndefined();
  });

  it('全是 kept 时**不弹提示**（每次启动都响一次的提示等于没有提示）', async () => {
    await seedRemoteRow('苏婉', 'https://a.invalid/su.png');
    registryFace = [{ name: '苏婉', url: 'https://a.invalid/su.png' }];
    installFetchMock();

    const res = await useAssetStore().syncRemoteAssets();

    expect(res).toMatchObject({ kept: 1, downloaded: 0, deleted: 0 });
    expect(useUIStore().toasts).toEqual([]);
  });

  it('有变化就报一条（数字与回执同源）', async () => {
    registryFace = [{ name: '苏婉', url: 'https://a.invalid/su.png' }];
    installFetchMock();

    await useAssetStore().syncRemoteAssets();

    const toasts = useUIStore().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('远程素材同步：新增 1 · 更新 0 · 删除 0 · 跳过 0 · 失败 0');
  });

  it('前置 store 抛了也不炸：返回 null 并把 running 落回来（同步是旁路）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ensureContentRegistryLoaded.mockRejectedValueOnce(new Error('注册表挂了'));
    const store = useAssetStore();

    await expect(store.syncRemoteAssets()).resolves.toBeNull();
    expect(store.remoteSync.running).toBe(false);
    warn.mockRestore();
  });
});
