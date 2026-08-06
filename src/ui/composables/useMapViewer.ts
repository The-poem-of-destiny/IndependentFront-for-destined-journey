/**
 * useMapViewer — OpenSeadragon 生命周期管理 composable
 *
 * 对标原版 use-map-viewer.ts，适配 Vue 3 Composition API。
 * 负责 OSD Viewer 的创建、图片加载、销毁。
 * 砍掉了 SW Cache（原版用 Service Worker 缓存 webp，我们直接 fetch）。
 */

import { ref, shallowRef, onBeforeUnmount, type Ref } from 'vue';
import OpenSeadragon from 'openseadragon';

export type MapViewerStatus = 'loading' | 'ready' | 'error';

export interface MapSourceConfig {
  /** 源标识（历史上是 'small' / 'large'，现由内容供给，任意字符串） */
  key: string;
  name: string;
  url: string;
}

/**
 * OSD 控件雪碧图前缀（D23 外链三清之三）。
 *
 * 🔴 原值指向 openseadragon.github.io 上的官方贴图目录 —— 一条**没人会发现
 * 失败**的外链：图挂了只是按钮变空白方块，控件仍然可点。离线 / CDN 故障 / 大陆网络下
 * 每个玩家都在裸奔。现在整套图随 `public/osd/` 自托管（从已装的 `openseadragon` 包里
 * 原样复制，不下载外部文件），行为与今日一致。
 *
 * 用字面量而不是 `import.meta.env.BASE_URL`：仓库未配置 vite `base`，且这条常量要能在
 * 纯 `tsc` 与 node 侧测试里读，不引入 vite/client 类型依赖。
 */
const OSD_PREFIX_URL = '/osd/';

/**
 * 从注册表 `branding` 面解析地图图源（D23）。
 *
 * 🔴 **公开仓默认空**：原来这里硬编码着两条 `i.ibb.co` 热链（第三方图床，既是外部资源
 * 也是世界内容），已删。图源改由内容包的 `branding.mapSources` 供给；没有内容包时返回
 * 空数组，MapPanel 渲染空态而不是去连一个不存在的地址。
 *
 * 形状容错：`branding` 是注册表的 `unknown` 面，可能是 undefined / 任意 JSON。
 * 逐项校验三个字符串字段，坏项跳过而不是整份丢弃。
 */
export function resolveMapSources(branding: unknown): MapSourceConfig[] {
  if (!branding || typeof branding !== 'object') return [];
  const raw = (branding as { mapSources?: unknown }).mapSources;
  if (!Array.isArray(raw)) return [];
  const out: MapSourceConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { key, name, url } = item as Record<string, unknown>;
    if (typeof key !== 'string' || !key) continue;
    if (typeof url !== 'string' || !url) continue;
    out.push({ key, name: typeof name === 'string' && name ? name : key, url });
  }
  return out;
}

const MAP_OPEN_TIMEOUT_MS = 30000;

/**
 * @param containerRef OSD 挂载容器
 * @param sourcesRef   可用图源列表（D23：由 MapPanel 从注册表 branding 面解析后传入）
 */
export function useMapViewer(
  containerRef: Ref<HTMLDivElement | null>,
  sourcesRef?: Ref<MapSourceConfig[]>,
) {
  const status = ref<MapViewerStatus>('loading');
  const errorMessage = ref('');
  const viewerRef = shallowRef<OpenSeadragon.Viewer | null>(null);
  const currentSourceKey = ref<string>('');

  const objectUrlCache = new Map<string, string>();
  let abortController: AbortController | null = null;
  let openSequence = 0;

  function availableSources(): MapSourceConfig[] {
    return sourcesRef?.value ?? [];
  }

  // ========== 创建 Viewer ==========
  function createViewer() {
    if (!containerRef.value || viewerRef.value) return;

    const viewer = OpenSeadragon({
      element: containerRef.value,
      prefixUrl: OSD_PREFIX_URL,
      showNavigator: true,
      showNavigationControl: true,
      showFullPageControl: false,
      visibilityRatio: 1,
      constrainDuringPan: true,
      preserveImageSizeOnResize: true,
      crossOriginPolicy: 'Anonymous',
      gestureSettingsMouse: {
        clickToZoom: false,
        dblClickToZoom: true,
        dragToPan: true,
        scrollToZoom: true,
      },
      gestureSettingsTouch: {
        pinchToZoom: true,
        dragToPan: true,
      },
    });

    viewerRef.value = viewer;

    viewer.addHandler('open-failed', (event: any) => {
      const message = event?.message || '地图资源打开失败';
      errorMessage.value = message;
      status.value = 'error';
    });

    // ResizeObserver 自动适应容器
    const resizeObserver = new ResizeObserver(() => {
      const v = viewerRef.value;
      if (!v || v.isDestroyed()) return;
      requestAnimationFrame(() => {
        v.forceResize();
        v.viewport.applyConstraints(true);
      });
    });
    resizeObserver.observe(containerRef.value);

    // 清理时注销
    const origDestroy = viewer.destroy.bind(viewer);
    viewer.destroy = () => {
      resizeObserver.disconnect();
      origDestroy();
    };
  }

  // ========== 加载地图源 ==========
  async function loadSource(key: string) {
    const viewer = viewerRef.value;
    if (!viewer) return;

    const config = availableSources().find((s) => s.key === key);
    // 🔴 没有这个源 = 没有图可加载。**必须落进 error 态**，不能悄悄 return ——
    //    否则内容包缺 branding.mapSources 时地图永远停在「地图加载中…」的转圈上，
    //    看着像卡死而不是「这里没有内容」。
    if (!config) {
      errorMessage.value = '没有可用的地图图源（需要内容包提供）';
      status.value = 'error';
      return;
    }

    currentSourceKey.value = key;
    status.value = 'loading';
    errorMessage.value = '';

    // 取消上一次加载
    abortController?.abort();
    const controller = new AbortController();
    abortController = controller;
    const currentSequence = ++openSequence;

    const isLatest = () => openSequence === currentSequence;

    try {
      // 超时控制
      const timeoutId = setTimeout(() => {
        controller.abort();
        if (isLatest()) {
          errorMessage.value = '地图加载超时，请稍后重试';
          status.value = 'error';
        }
      }, MAP_OPEN_TIMEOUT_MS);

      // 检查缓存
      let objectUrl = objectUrlCache.get(key);

      if (!objectUrl) {
        const response = await fetch(config.url, {
          mode: 'cors',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        objectUrlCache.set(key, objectUrl);
      }

      clearTimeout(timeoutId);
      if (!isLatest()) return;

      // 等待 open 事件
      const onOpen = () => {
        viewer.removeHandler('open', onOpen);
        if (!isLatest()) return;
        status.value = 'ready';
        viewer.forceResize();
        viewer.viewport.applyConstraints(true);
      };
      viewer.addHandler('open', onOpen);

      viewer.open({
        tileSource: new OpenSeadragon.ImageTileSource({ url: objectUrl }),
      });
    } catch (err: any) {
      if (controller.signal.aborted || !isLatest()) return;
      errorMessage.value = err?.message || '地图加载失败';
      status.value = 'error';
    }
  }

  // ========== 销毁 ==========
  function destroy() {
    abortController?.abort();
    if (viewerRef.value && !viewerRef.value.isDestroyed()) {
      viewerRef.value.destroy();
    }
    viewerRef.value = null;
    objectUrlCache.forEach((url) => URL.revokeObjectURL(url));
    objectUrlCache.clear();
  }

  // ========== 焦点到指定归一化坐标 ==========
  function panTo(nx: number, ny: number) {
    const viewer = viewerRef.value;
    if (!viewer) return;
    const image = viewer.world.getItemAt(0);
    if (!image) return;
    const size = image.getContentSize();
    if (!size.x || !size.y) return;
    const imagePoint = new OpenSeadragon.Point(nx * size.x, ny * size.y);
    const viewportPoint = viewer.viewport.imageToViewportCoordinates(imagePoint);
    viewer.viewport.panTo(viewportPoint, true);
    viewer.viewport.applyConstraints(true);
  }

  // ========== 客户端坐标 → 归一化坐标 ==========
  function clientPointToNormalized(
    clientX: number,
    clientY: number,
  ): { nx: number; ny: number } | null {
    const viewer = viewerRef.value;
    if (!viewer) return null;
    const image = viewer.world.getItemAt(0);
    if (!image) return null;
    const size = image.getContentSize();
    if (!size.x || !size.y) return null;
    const rect = viewer.element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const point = new OpenSeadragon.Point(clientX - rect.left, clientY - rect.top);
    const imagePoint = viewer.viewport.viewerElementToImageCoordinates(point);
    return {
      nx: Math.max(0, Math.min(1, imagePoint.x / size.x)),
      ny: Math.max(0, Math.min(1, imagePoint.y / size.y)),
    };
  }

  onBeforeUnmount(() => {
    destroy();
  });

  return {
    status,
    errorMessage,
    viewerRef,
    currentSourceKey,
    createViewer,
    loadSource,
    panTo,
    clientPointToNormalized,
    destroy,
  };
}
