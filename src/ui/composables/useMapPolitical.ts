/**
 * useMapPolitical — 势力地图舞台的**状态与生命周期**（地图 v1 / 设计 §9）
 *
 * 装什么: 「这一份包的政治层建好了没有」这一个事实 —— 懒构建（页签首次打开才建）、
 *         按 `contentHash` 失效、关闭时释放、失败分档（缺图 / 解不开 / 环境不支持）。
 * 不装什么: 任何像素算法（`lib/map-political.ts`，纯函数）、任何 canvas 绘制
 *           （`MapPoliticalTab.vue`，它持有画布）、任何 fetch/解码（`lib/map-provinces-raster.ts`）。
 *
 * 🔴 **懒 + 释放，两头都要**（设计 §9 预算）：575 块 / 8.7M 像素一次构建约 280ms、
 *    常驻 `idBuf` 约 35MB。所以：不打开这个页签一个字节都不分配；Modal 一关（本组件卸载）
 *    整份丢掉。把它提到模块级「反正只建一次」是很诱人的，但那意味着玩家哪怕只手滑点开一次
 *    势力地图，之后整局游戏都常驻 35MB —— 而这一层的数据在关掉之后毫无用处。
 *
 * 🔴 **失效键是 `contentHash`**（设计 §3.4-3），不是 URL：`provinces.png` 的**路径**是常量，
 *    换图时它的**内容**变、路径不变。拿路径当键会让新图配着旧像素画，而那不报错 ——
 *    只是每一块地都指着隔壁那一块。这条纪律有两层：内存缓存按 `contentHash` 失效（本文件），
 *    HTTP 请求经 `provincesRasterUrl(hash)` 挂 `?v=` 参数回源（content-store，2026-08-13）——
 *    只堵内存那层时，换包重建仍可能拿浏览器缓存的旧像素配新 pack。附带按包对象同一性也比一次
 *    （`contentHash` 允许是空串 / `'placeholder'`，两份不同的坏包会撞成同一个键）。
 *
 * 🔴 **失败一律不抛**：这张图在公开仓根本不存在（占位包无像素面）。势力地图退化成友好空态，
 *    标记地图页签**照常可用** —— 两个页签共享一个 Modal，一次 throw 会把两个一起打成白屏。
 */

import { onBeforeUnmount, ref, shallowRef } from 'vue';
import { getMapPack } from '@engine/map-runtime';
import { isEmptyMapPack } from '@engine/map-pack';
import type { MapPack } from '@engine/types-map';
import {
  buildBorderPaths,
  buildPoliticalPaint,
  buildPoliticalTint,
  buildTileColorLookup,
  buildTraceKeys,
  type BorderPaths,
  type ProvinceRaster,
} from '../lib/map-political';
import { loadProvinceRaster } from '../lib/map-provinces-raster';
import { provincesRasterUrl } from '../stores/content-store';

/** `empty` 与 `error` 都是「画不出来」，但措辞与可操作性不同（缺内容 vs 环境/数据坏了） */
export type MapPoliticalStatus = 'idle' | 'building' | 'ready' | 'empty' | 'error';

/** 建好的政治层 —— 一次页签生命周期里不变（包换了就整份重建） */
export interface MapPoliticalStage {
  /** 建它时那一份包（对象同一性 + hash 双判据，见文件头） */
  pack: MapPack;
  contentHash: string;
  raster: ProvinceRaster;
  /** 整幅 RGBA 着色缓冲（灌进 tint 画布） */
  tint: Uint8ClampedArray;
  borders: BorderPaths;
}

/** 数据与图对不上的两个信号（>0 时界面出一行小字，真机走查靠它定位换图事故） */
export interface MapPoliticalDiagnostics {
  /** 认不出颜色的像素占比（0-1） */
  unknownRatio: number;
  /** 因撞色被丢弃的地块数 */
  ambiguousTiles: number;
  /** 构建耗时（ms） */
  buildMs: number;
}

export function useMapPolitical() {
  const status = ref<MapPoliticalStatus>('idle');
  const message = ref('');
  const stage = shallowRef<MapPoliticalStage | null>(null);
  const diagnostics = ref<MapPoliticalDiagnostics | null>(null);

  let controller: AbortController | null = null;
  let building: Promise<void> | null = null;
  /** 在建的是**哪一份包**（构建复用只对同一份包成立；换包中途要弃旧起新） */
  let buildingPack: MapPack | null = null;

  /**
   * 建（或复用）政治层。**幂等**：并发调用共享同一个 promise，已建好且包没变时立刻返回。
   *
   * 页签来回切时它会被反复调用 —— 每次重建就等于每次 280ms 卡顿加一次 35MB 垃圾。
   */
  async function ensureBuilt(): Promise<void> {
    const pack = getMapPack();

    if (isEmptyMapPack(pack)) {
      stage.value = null;
      diagnostics.value = null;
      status.value = 'empty';
      message.value = '地图数据未安装';
      return;
    }

    const built = stage.value;
    if (built !== null && built.pack === pack && built.contentHash === pack.contentHash) {
      status.value = 'ready';
      return;
    }

    // 🔴 在建复用只对**同一份包**成立：换包中途返回旧包的构建，等到的是一版马上要作废的
    //    舞台（280ms + 35MB 白干一轮），随后还得再建一次。包变了就弃旧起新。
    if (building !== null && buildingPack === pack) return building;

    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    status.value = 'building';
    message.value = '';

    buildingPack = pack;
    const run = (async () => {
      const startedAt = Date.now();
      const lookup = buildTileColorLookup(pack.tiles);
      // 🔴 取图必须走 `provincesRasterUrl`（content-store）：内存缓存按 contentHash 失效
      //    只堵了一半，HTTP 缓存是同一个坑的第二处 —— 换包后的重建会拿浏览器缓存里的
      //    **旧像素**配新 pack 画，整层错位且不报错。`?v=<hash>` 让「包变 → 地址变 → 必然回源」。
      const result = await loadProvinceRaster(provincesRasterUrl(pack.contentHash), lookup, signal);

      if (signal.aborted) return;

      if (!result.ok) {
        stage.value = null;
        diagnostics.value = null;
        if (result.reason === 'aborted') return;
        if (result.reason === 'missing') {
          status.value = 'empty';
          message.value = '地图图形数据未安装（缺少 provinces.png）';
        } else {
          status.value = 'error';
          message.value =
            result.reason === 'unsupported'
              ? '当前环境无法绘制势力地图（画布不可用）'
              : `地图图形数据无法解析${result.detail === undefined ? '' : `：${result.detail}`}`;
        }
        return;
      }

      const raster = result.raster;
      const tint = buildPoliticalTint(raster, buildPoliticalPaint(pack));
      const borders = buildBorderPaths(raster, buildTraceKeys(pack));

      if (signal.aborted) return;

      stage.value = { pack, contentHash: pack.contentHash, raster, tint, borders };
      const totalPixels = raster.w * raster.h;
      diagnostics.value = {
        unknownRatio: totalPixels > 0 ? raster.unknownPixels / totalPixels : 0,
        ambiguousTiles: lookup.ambiguous,
        buildMs: Date.now() - startedAt,
      };
      status.value = 'ready';
    })();

    const tracked: Promise<void> = run
      .catch((err: unknown) => {
        // 到这里只可能是意料之外的（loadProvinceRaster 自己永不抛）——照样不许穿出去
        if (signal.aborted) return;
        stage.value = null;
        status.value = 'error';
        message.value = `势力地图构建失败：${err instanceof Error ? err.message : String(err)}`;
      })
      .finally(() => {
        // 🔴 只清**自己**：换包弃旧起新后，旧构建的 finally 晚于新构建的登记到来，
        //    无条件置 null 会把新构建的在建标记抹掉，下一次调用就会再起第三份
        if (building === tracked) {
          building = null;
          buildingPack = null;
        }
      });
    building = tracked;

    return tracked;
  }

  /** 丢掉全部大缓冲（Modal 关闭 = 本组件卸载）。可重入。 */
  function release(): void {
    controller?.abort();
    controller = null;
    stage.value = null;
    diagnostics.value = null;
    status.value = 'idle';
    message.value = '';
  }

  onBeforeUnmount(release);

  return { status, message, stage, diagnostics, ensureBuilt, release };
}
