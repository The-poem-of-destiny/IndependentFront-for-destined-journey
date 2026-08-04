/**
 * useSceneImageUrls.ts — 情景插画字节 → object URL 的装载缝（CG 图鉴 / 正文插图共用）
 *
 * 设计: `docs/planning/2026-08-04-image-generation-design.md` §10.3。
 *
 * 🔴 **object URL 一律走 `lib/asset-url.ts` 的引用计数 LRU，绝不另写第二个**（§10.3）。
 * 图鉴一次挂几十张、切走要全部回收 —— 那正是那份 LRU 解决的问题。本模块只做两件
 * 那份 LRU 不该知道的事:
 *
 * 1. **字节从哪来** —— `scene-image-store.blobOf`（Dexie `sceneImageBlobs`），
 *    经 {@link SceneImageUrlSource} 注入，于是本模块不认识 Dexie 也不认识 Pinia。
 * 2. **谁欠几份** —— 每个使用面（= 每个组件实例）自己记账，卸载时**一份不多一份不少**
 *    地还回去。少还是泄漏（URL 被钉住不会被逐出），多还花的是**别人**的那一份
 *    （lib/asset-url.ts 的 `release` 契约写得很清楚: 计数只按 id 记、不记是谁欠的）。
 *
 * ⚠️ **不要持久化返回的 URL**。要存就存记录 id，渲染时再来取 —— object URL 只在
 * 当前会话有效。
 *
 * 边界: 缓存**按数据源共享一份**（`WeakMap`），不是每个组件建一个。同一批字节
 * 会被图鉴网格与详情大图同时挂着，两份缓存意味着同一张图铸两条 URL、各撤各的。
 */
import { onScopeDispose, ref, type Ref } from 'vue';
import { createAssetUrlCache, type AssetUrlCache } from '../lib/asset-url';

/** 字节来源 —— scene-image-store 的最小切面（生产恒是它，测试塞假件） */
export interface SceneImageUrlSource {
  /** 字节；已清理（`blobDropped`）或从未成功的返回 undefined —— **不是抛错** */
  blobOf(id: string): Promise<Blob | undefined>;
}

export interface UseSceneImageUrlsOptions {
  source: SceneImageUrlSource;
  /** 注入缝，测试用；缺省即按 source 共享的那一份 LRU */
  cache?: AssetUrlCache;
  /** LRU 容量。图鉴一屏几十格，默认给得比素材库宽一点 */
  capacity?: number;
}

export interface SceneImageUrls {
  /** 已装载则给 object URL；未装载 / 字节已清理 → null（调用方渲染占位，**不要渲染破图**） */
  urlFor(id: string): string | null;
  /**
   * 请求装载。**幂等**: 同一个 id 只会向 LRU 要一次，于是「滚动时反复进出视口」
   * 不会攒出一堆没人还的引用。
   */
  load(id: string): void;
  /** 手动拆除（一般不用，作用域结束时自动调） */
  dispose(): void;
  /** 响应式投影，模板里直接读；诊断/测试也看它 */
  readonly urls: Ref<Record<string, string>>;
}

/**
 * 数据源 → 共享缓存。`WeakMap` 而不是模块级单例: 测试里每个用例一份假源，
 * 用例之间不必互相清场，源被回收时缓存跟着走。
 */
const CACHE_BY_SOURCE = new WeakMap<SceneImageUrlSource, AssetUrlCache>();

/** 默认容量 —— 图鉴一屏 ~30 格，留两屏余量 */
export const SCENE_IMAGE_URL_CAPACITY = 96;

function sharedCache(source: SceneImageUrlSource, capacity: number): AssetUrlCache {
  const hit = CACHE_BY_SOURCE.get(source);
  if (hit) return hit;
  const made = createAssetUrlCache({
    loadBlob: (id) => source.blobOf(id),
    capacity,
  });
  CACHE_BY_SOURCE.set(source, made);
  return made;
}

/**
 * 装载一批插画的 object URL。
 *
 * **会计恒等式**（本模块唯一要守的东西）: 本实例一生的 `release` 次数 ===
 * 成功取到 URL 的次数。拿到 `null` 不欠（见 lib/asset-url.ts 的 `get` 契约）。
 */
export function useSceneImageUrls(options: UseSceneImageUrlsOptions): SceneImageUrls {
  const capacity = options.capacity ?? SCENE_IMAGE_URL_CAPACITY;
  const cache = options.cache ?? sharedCache(options.source, capacity);

  const urls = ref<Record<string, string>>({});
  /** 已经要过的 id —— 幂等闸，也是「欠了几份」的账本（每个 id 至多一份） */
  const requested = new Set<string>();
  /** 真正欠着的（成功取到 URL 的那些）。拿到 null 的留在 `requested` 里但不在这儿 */
  const owed = new Set<string>();
  let disposed = false;

  function load(id: string): void {
    if (disposed || id === '' || requested.has(id)) return;
    requested.add(id);
    void cache
      .get(id)
      .then((url) => {
        if (url === null) return; // 字节已清理 / 缺失 —— 不欠，也不缓存空值
        if (disposed) {
          // 拆除之后兑现的那一轮: 计数已经落地了，不还就是泄漏
          cache.release(id);
          return;
        }
        owed.add(id);
        urls.value = { ...urls.value, [id]: url };
      })
      .catch(() => {
        // 读字节失败（IndexedDB 不可用）→ 渲染占位，允许之后重试
        requested.delete(id);
      });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const id of owed) cache.release(id);
    owed.clear();
    requested.clear();
    urls.value = {};
  }

  onScopeDispose(dispose);

  return {
    urls,
    urlFor: (id) => urls.value[id] ?? null,
    load,
    dispose,
  };
}
