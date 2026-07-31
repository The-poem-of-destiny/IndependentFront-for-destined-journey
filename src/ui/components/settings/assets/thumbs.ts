/**
 * 素材缩略图的 object URL 装载 —— 素材库与角色抽屉共用的一份。
 *
 * 为什么上提成一个模块（对齐 audio/format.ts 的做法，§6.3「Reuse, don't clone」）:
 * object URL 的规矩（不持久化、LRU 命中要复算、卸载后不许再写状态）是
 * **两个组件都要遵守同一套**的东西。抄两份就等着两份慢慢分叉，而分叉的表现是泄漏
 * 或死链缩略图 —— 两种都很难在界面上一眼看出来。
 *
 * 边界: 只调 asset-store 的公开动作（`assetUrl` / `peekAssetUrl`），自己不认识
 * Dexie、也不碰 `URL.createObjectURL` —— 铸造与撤销全归 lib/asset-url.ts 的 LRU。
 *
 * ⚠️ **本模块刻意不在行离开可见集合时撤销 URL**，只把本地引用剪掉。理由是
 * 「同一份 LRU 有两个使用面」这个事实: 素材库网格与角色抽屉同时挂着，而抽屉列的
 * 那些行**正是**平铺列表里那些行。若这里按 drop-out 撤销，抽屉一关 `rows()` 就变空，
 * 于是它会把身后网格**正在显示**的 URL 全撤掉 —— 表现为一屏死图。
 * 生命周期因此归分区卸载时的 `revokeAllUrls()`（由素材库调一次，抽屉不调）。
 * 这也正是设计 §7.5 写的那套。测试 thumbs.test.ts 把这条同时钉成了两个断言:
 * 掉出可见集合的行不再有本地引用，而另一个使用面手上的 URL 依然可用。
 *
 * 📌 lib/asset-url.ts 现在**带引用计数**了（`release()` 归零才撤销，容量逐出绝不
 * 碰被持有的条目）。本模块的行为刻意保持不变 —— 只取不还，于是它取过的每条
 * URL 都被钉住不会被逐出，缓存会涨到本使用面见过的条目数（素材库量级 ~40-100，
 * 分区一卸载就归零）。这是**取舍不是泄漏**: 换来的是滚过 64 张缩略图之后，
 * 正在显示的图不会被后来者挤掉。日后若要收紧，正确做法是在对账剪掉本地引用时
 * 一并 `releaseAssetUrl(id)`，并把 `peekAssetUrl` 的快路径去掉（peek 不计数，
 * 拿它当持有会 release 掉别人的引用）。
 */
import { onUnmounted, ref, watch } from 'vue';
import type { AssetMetaRecord } from '@engine/types';
import { useAssetStore } from '../../../stores/asset-store';

export interface AssetThumbs {
  /** 已装载则给出 object URL；未装载 / 字节缺失时是 null（调用方渲染占位） */
  thumbFor(id: string): string | null;
}

/**
 * URL 的来源 —— asset-store 那两个动作的最小切面。
 *
 * 抽出接口纯粹是为了**注入缝**（对齐 lib/asset-url.ts 的 options 风格，
 * 刻意不用模块级全局钩子）: 生产路径永远是 asset-store 单例，测试则塞一份
 * 真 `createAssetUrlCache` + 计数用的 create/revoke 假件，于是「恰好撤销一次」
 * 这条会计恒等式能在 environment 里连一个真实的 object URL 都不碰的情况下钉住。
 */
export interface AssetThumbSource {
  assetUrl(id: string): Promise<string | null>;
  peekAssetUrl(id: string): string | null;
}

export interface AssetThumbsOptions {
  /** 注入缝；缺省即 asset-store 单例（只在缺省时才会去碰 Pinia） */
  source?: AssetThumbSource;
}

/**
 * 跟着 `rows()` 的结果装载缩略图。
 *
 * @param rows 当前**可见**的行（筛选后的那批）。它变一次就对账一次:
 *             不在可见集合里的键从本地表里剪掉（LRU 里的 URL 由缓存自己按容量
 *             逐出，这里只负责不留下指向已逐出 URL 的死引用）。
 */
export function useAssetThumbs(
  rows: () => readonly AssetMetaRecord[],
  options: AssetThumbsOptions = {},
): AssetThumbs {
  // `??` 是短路的 —— 注入了 source 就绝不会去调 useAssetStore()，于是本模块
  // 在没有 Pinia 的环境里也能单测
  const assets: AssetThumbSource = options.source ?? useAssetStore();
  /** id → object URL。只存**当前可见**那批 */
  const urls = ref<Record<string, string>>({});

  /**
   * 卸载守卫。`assetUrl()` 是异步的（Dexie 读 + 铸造），用户完全可能在它兑现之前
   * 就切走分区；那时再往 `urls` 里写，写的是一份没人看、也没人撤销的引用。
   * 对齐 AudioSection 壳层的 `unmounted` 守卫。
   */
  let disposed = false;

  /**
   * 对账世代号。可见集合变得比装载快时（连着敲搜索框就是），上一轮 reconcile
   * 还在 await 里，它手上那份 `list` 已经过期了 —— 让它回来继续写，就会把新一轮
   * 刚剪掉的 id 又装回去，`urls` 于是不再等于可见集合（那条引用没人再剪，
   * 撞上 LRU 逐出就成了一张死图）。所以每轮领一个号，await 回来先验号再落笔。
   * 同 lib/asset-url.ts 与 MusicChannel 的加载世代号做法。
   */
  let generation = 0;

  async function reconcile(list: readonly AssetMetaRecord[], gen: number): Promise<void> {
    const visible = new Set(list.map((r) => r.id));
    for (const id of Object.keys(urls.value)) {
      if (!visible.has(id)) delete urls.value[id];
    }
    for (const row of list) {
      if (disposed || gen !== generation) return;
      // 已经装过就跳过；LRU 里还在的话 peek 是同步命中，连一次 await 都不用等
      if (urls.value[row.id]) continue;
      const cached = assets.peekAssetUrl(row.id);
      if (cached) {
        urls.value[row.id] = cached;
        continue;
      }
      const url = await assets.assetUrl(row.id);
      // 过期的一轮到此为止: URL 本身不撤销（它归 LRU，且很可能正被新一轮用着），
      // 只是不再往这份表里写
      if (disposed || gen !== generation) return;
      // 字节缺失（元数据在、blob 没了）→ 什么都不记，渲染成占位；重试仍可成功
      if (url) urls.value[row.id] = url;
    }
  }

  watch(
    rows,
    (list) => {
      generation += 1;
      void reconcile(list, generation);
    },
    { immediate: true },
  );

  onUnmounted(() => {
    disposed = true;
  });

  return {
    thumbFor: (id: string): string | null => urls.value[id] ?? null,
  };
}
