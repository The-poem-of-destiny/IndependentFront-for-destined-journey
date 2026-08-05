/**
 * useSceneImageUrls.test.ts
 *
 * 钉的是**会计恒等式**: 一生的 `release` 次数 === 成功取到 URL 的次数。
 * 少还是泄漏（URL 被钉住不会被逐出），多还花的是别人的那一份 —— 两种在界面上
 * 都看不出来，只有这里看得出来。
 *
 * 用**真的** `createAssetUrlCache`（只把 create/revoke 换成计数假件），因为要钉的
 * 恰恰是本模块与那份 LRU 之间的账；换成假缓存就把被测的东西替掉了。
 */
import { describe, it, expect, vi } from 'vitest';
import { effectScope } from 'vue';
import { createAssetUrlCache } from '../lib/asset-url';
import { useSceneImageUrls, type SceneImageUrlSource } from './useSceneImageUrls';

function harness(blobs: Record<string, Blob | undefined>) {
  const revoked: string[] = [];
  let minted = 0;
  const source: SceneImageUrlSource = {
    blobOf: vi.fn(async (id: string) => blobs[id]),
  };
  const cache = createAssetUrlCache({
    loadBlob: (id) => source.blobOf(id),
    createObjectURL: () => `blob:mock-${(minted += 1)}`,
    revokeObjectURL: (u) => void revoked.push(u),
  });
  const scope = effectScope();
  const urls = scope.run(() => useSceneImageUrls({ source, cache }))!;
  return { source, cache, urls, scope, revoked };
}

const BYTES = { a: new Blob(['a']), b: new Blob(['b']) } as Record<string, Blob>;

/** 让所有挂着的微任务跑完（一次宏任务即可，本模块不用定时器） */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('useSceneImageUrls', () => {
  it('装载成功后 urlFor 给出 URL', async () => {
    const h = harness(BYTES);
    h.urls.load('a');
    await settle();
    expect(h.urls.urlFor('a')).toBe('blob:mock-1');
  });

  it('同一个 id 反复 load 只向缓存要一次（滚动时反复进出视口不攒引用）', async () => {
    const h = harness(BYTES);
    const spy = vi.spyOn(h.cache, 'get');
    h.urls.load('a');
    h.urls.load('a');
    await settle();
    h.urls.load('a');
    await settle();
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.cache.refCount('a')).toBe(1);
  });

  it('作用域结束时把每一份都还回去 —— 引用计数归零、URL 被撤销', async () => {
    const h = harness(BYTES);
    h.urls.load('a');
    h.urls.load('b');
    await settle();
    await settle();
    await settle();
    expect(h.cache.refCount('a')).toBe(1);
    expect(h.cache.refCount('b')).toBe(1);

    h.scope.stop();
    expect(h.cache.refCount('a')).toBe(0);
    expect(h.cache.refCount('b')).toBe(0);
    expect(h.revoked).toHaveLength(2);
    expect(h.urls.urlFor('a')).toBeNull();
  });

  it('字节已清理（blobOf 给 undefined）→ null，且**不欠**任何一份', async () => {
    const h = harness({ a: undefined });
    h.urls.load('a');
    await settle();
    await settle();
    expect(h.urls.urlFor('a')).toBeNull();
    expect(h.cache.refCount('a')).toBe(0);

    h.scope.stop();
    // 一次都没取到 → 一次都不还，否则还的是别人的那一份
    expect(h.revoked).toHaveLength(0);
  });

  it('🔴 拆除之后才兑现的那一轮当场还回去（不然就是无人认领的泄漏）', async () => {
    let release!: (b: Blob) => void;
    const pending = new Promise<Blob>((r) => {
      release = r;
    });
    const revoked: string[] = [];
    const source: SceneImageUrlSource = { blobOf: () => pending };
    const cache = createAssetUrlCache({
      loadBlob: (id) => source.blobOf(id),
      createObjectURL: () => 'blob:late',
      revokeObjectURL: (u) => void revoked.push(u),
    });
    const scope = effectScope();
    const urls = scope.run(() => useSceneImageUrls({ source, cache }))!;

    urls.load('a');
    scope.stop(); // 还在飞的时候把面板关掉
    release(new Blob(['a']));
    await settle();
    await settle();
    await settle();

    expect(cache.refCount('a')).toBe(0);
    expect(revoked).toEqual(['blob:late']);
    expect(urls.urlFor('a')).toBeNull();
  });

  it('读字节抛错不留死账 —— 之后重试仍可成功', async () => {
    let fail = true;
    const source: SceneImageUrlSource = {
      blobOf: async (id) => {
        if (fail) throw new Error('IndexedDB 挂了');
        return new Blob([id]);
      },
    };
    const cache = createAssetUrlCache({
      loadBlob: (id) => source.blobOf(id),
      createObjectURL: () => 'blob:retry',
      revokeObjectURL: () => {},
    });
    const scope = effectScope();
    const urls = scope.run(() => useSceneImageUrls({ source, cache }))!;

    urls.load('a');
    await settle();
    await settle();
    expect(urls.urlFor('a')).toBeNull();

    fail = false;
    urls.load('a');
    await settle();
    await settle();
    await settle();
    expect(urls.urlFor('a')).toBe('blob:retry');
    scope.stop();
  });
});
