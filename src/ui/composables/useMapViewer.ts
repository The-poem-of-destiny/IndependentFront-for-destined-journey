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
  key: 'small' | 'large';
  name: string;
  url: string;
}

export const MAP_SOURCES: MapSourceConfig[] = [
  {
    key: 'small',
    name: '高清地图',
    url: 'https://i.ibb.co/G3rrhgVS/Maplite-1.webp',
  },
  {
    key: 'large',
    name: '超清地图',
    url: 'https://i.ibb.co/2zYccsJ/Map.webp',
  },
];

const MAP_OPEN_TIMEOUT_MS = 30000;

export function useMapViewer(containerRef: Ref<HTMLDivElement | null>) {
  const status = ref<MapViewerStatus>('loading');
  const errorMessage = ref('');
  const viewerRef = shallowRef<OpenSeadragon.Viewer | null>(null);
  const currentSourceKey = ref<'small' | 'large'>('small');

  const objectUrlCache = new Map<'small' | 'large', string>();
  let abortController: AbortController | null = null;
  let openSequence = 0;

  // ========== 创建 Viewer ==========
  function createViewer() {
    if (!containerRef.value || viewerRef.value) return;

    const viewer = OpenSeadragon({
      element: containerRef.value,
      prefixUrl: 'https://openseadragon.github.io/openseadragon/images/',
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
  async function loadSource(key: 'small' | 'large') {
    const viewer = viewerRef.value;
    if (!viewer) return;

    const config = MAP_SOURCES.find((s) => s.key === key);
    if (!config) return;

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
