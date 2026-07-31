/**
 * useMapMarkers — 地图标记状态管理 composable
 *
 * 对标原版 use-map-markers.ts，适配 Vue 3 Composition API。
 * 负责标记的 CRUD、Overlay 同步、搜索过滤。
 */

import { ref, computed, shallowRef, type Ref } from 'vue';
import OpenSeadragon from 'openseadragon';
import type { MapMarker, MapMarkerIcon } from '@engine/types';

export const DEFAULT_MARKER_COLOR = '#ffcc66';
export const DEFAULT_MARKER_ICON: MapMarkerIcon = 'fa-solid fa-location-dot';

export const MARKER_ICON_LABELS: Record<MapMarkerIcon, string> = {
  'fa-solid fa-location-dot': '地点',
  'fa-solid fa-star': '星标',
  'fa-solid fa-flag': '旗帜',
  'fa-solid fa-landmark': '地标',
  'fa-solid fa-skull-crossbones': '危险',
  'fa-solid fa-city': '城市',
  'fa-solid fa-mountain': '山脉',
  'fa-solid fa-tree': '森林',
  'fa-solid fa-water': '水域',
  'fa-solid fa-campground': '营地',
};

export const MARKER_ICON_OPTIONS: MapMarkerIcon[] = [
  'fa-solid fa-location-dot',
  'fa-solid fa-star',
  'fa-solid fa-flag',
  'fa-solid fa-landmark',
  'fa-solid fa-skull-crossbones',
  'fa-solid fa-city',
  'fa-solid fa-mountain',
  'fa-solid fa-tree',
  'fa-solid fa-water',
  'fa-solid fa-campground',
];

export const MARKER_COLOR_OPTIONS = [
  '#ffcc66',
  '#ff6b6b',
  '#4dabf7',
  '#63e6be',
  '#845ef7',
  '#ffd43b',
  '#ffffff',
  '#000000',
];

export function useMapMarkers(viewerRef: Ref<OpenSeadragon.Viewer | null>) {
  const markers = ref<MapMarker[]>([]);
  const activeMarkerId = ref<string | null>(null);
  const markerAddMode = ref(false);
  const searchQuery = ref('');

  const overlayMap = new Map<string, HTMLElement>();

  // ═══ 浮动信息卡片位置 ═══
  const activeMarkerCardPosition = ref<{
    left: number;
    top: number;
    visible: boolean;
  }>({
    left: 0,
    top: 0,
    visible: false,
  });

  /**
   * 同步浮动卡片位置 — 根据 activeMarker 的归一化坐标计算像素位置。
   * 照抄原版 MapTab.syncActiveMarkerCardPosition。
   */
  function syncActiveMarkerCardPosition() {
    const viewer = viewerRef.value;
    if (!viewer || viewer.isDestroyed()) {
      activeMarkerCardPosition.value = { ...activeMarkerCardPosition.value, visible: false };
      return;
    }

    const marker = activeMarker.value;
    if (!marker || markerAddMode.value) {
      activeMarkerCardPosition.value = { ...activeMarkerCardPosition.value, visible: false };
      return;
    }

    const image = viewer.world.getItemAt(0);
    if (!image) {
      activeMarkerCardPosition.value = { ...activeMarkerCardPosition.value, visible: false };
      return;
    }

    const size = image.getContentSize();
    const container = viewer.element;
    if (!size.x || !size.y || !container) {
      activeMarkerCardPosition.value = { ...activeMarkerCardPosition.value, visible: false };
      return;
    }

    const imagePoint = new OpenSeadragon.Point(
      marker.position.nx * size.x,
      marker.position.ny * size.y,
    );
    const viewerPoint = viewer.viewport.imageToViewerElementCoordinates(imagePoint);
    const containerRect = container.getBoundingClientRect();

    const horizontalPadding = 12;
    const topPadding = 12;
    const bottomPadding = 18;
    const pointerGap = 18;
    const fallbackCardWidth = window.innerWidth <= 768 ? 280 : 360;
    const fallbackCardHeight = 220;
    const cardWidth = fallbackCardWidth;
    const cardHeight = fallbackCardHeight;

    let left = viewerPoint.x;
    const minLeft = horizontalPadding + cardWidth / 2;
    const maxLeft = containerRect.width - horizontalPadding - cardWidth / 2;
    if (minLeft <= maxLeft) {
      left = Math.min(Math.max(left, minLeft), maxLeft);
    } else {
      left = containerRect.width / 2;
    }

    let top = viewerPoint.y - pointerGap;
    const cardTop = top - cardHeight;
    if (cardTop < topPadding) {
      // 卡片超出上方，翻转到标记下方
      top = viewerPoint.y + pointerGap + cardHeight;
    }
    if (top > containerRect.height - bottomPadding) {
      top = containerRect.height - bottomPadding;
    }

    activeMarkerCardPosition.value = {
      left,
      top,
      visible: true,
    };
  }

  // ========== 派生状态 ==========
  const activeMarker = computed(
    () => markers.value.find((m) => m.id === activeMarkerId.value) ?? null,
  );

  const filteredMarkers = computed(() => {
    const q = searchQuery.value.trim().toLowerCase();
    if (!q) return markers.value;
    return markers.value.filter((m) =>
      [m.name, m.group, m.description].filter(Boolean).some((t) => t!.toLowerCase().includes(q)),
    );
  });

  // ========== ID 生成 ==========
  function generateId(): string {
    return `marker-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }

  // ========== CRUD ==========
  function setMarkers(newMarkers: MapMarker[]) {
    markers.value = newMarkers;
  }

  function updateMarker(id: string, patch: Partial<MapMarker>) {
    const idx = markers.value.findIndex((m) => m.id === id);
    if (idx >= 0) {
      markers.value[idx] = { ...markers.value[idx], ...patch };
    }
  }

  function deleteMarker(id: string) {
    const viewer = viewerRef.value;
    const el = overlayMap.get(id);
    if (el && viewer && !viewer.isDestroyed()) {
      viewer.removeOverlay(el);
    }
    overlayMap.delete(id);
    markers.value = markers.value.filter((m) => m.id !== id);
    if (activeMarkerId.value === id) {
      activeMarkerId.value = null;
    }
  }

  function addMarkerAt(nx: number, ny: number): MapMarker {
    const marker: MapMarker = {
      id: generateId(),
      name: '新标记',
      group: '',
      description: '',
      icon: DEFAULT_MARKER_ICON,
      color: DEFAULT_MARKER_COLOR,
      position: { nx, ny },
    };
    markers.value.push(marker);
    activeMarkerId.value = marker.id;
    markerAddMode.value = false;
    return marker;
  }

  function selectMarker(id: string | null) {
    activeMarkerId.value = id;
  }

  // ========== 定位到标记 ==========
  function focusMarker(marker: MapMarker) {
    const viewer = viewerRef.value;
    if (!viewer) return;
    const image = viewer.world.getItemAt(0);
    if (!image) return;
    const size = image.getContentSize();
    if (!size.x || !size.y) return;
    const imagePoint = new OpenSeadragon.Point(
      marker.position.nx * size.x,
      marker.position.ny * size.y,
    );
    const viewportPoint = viewer.viewport.imageToViewportCoordinates(imagePoint);
    viewer.viewport.panTo(viewportPoint, true);
    viewer.viewport.applyConstraints(true);
  }

  // ========== Overlay 同步 ==========
  function createOverlayElement(marker: MapMarker): HTMLElement {
    const el = document.createElement('div');
    el.className = 'osd-marker';
    el.dataset.markerId = marker.id;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;

    const iconWrap = document.createElement('div');
    iconWrap.className = 'osd-marker-icon';
    iconWrap.style.color = marker.color ?? DEFAULT_MARKER_COLOR;

    const icon = document.createElement('i');
    icon.className = marker.icon ?? DEFAULT_MARKER_ICON;
    iconWrap.appendChild(icon);
    el.appendChild(iconWrap);

    const label = document.createElement('div');
    label.className = 'osd-marker-label';
    label.textContent = marker.name || '未命名';
    el.appendChild(label);

    // 点击选中标记 + 阻止事件冒泡到 OSD（pointer 事件阻止拖拽，click 触发选中）
    el.addEventListener('pointerdown', (e: PointerEvent) => {
      e.stopPropagation();
    });
    el.addEventListener('pointerup', (e: PointerEvent) => {
      e.stopPropagation();
    });
    new OpenSeadragon.MouseTracker({
      element: el,
      clickHandler: (event: any) => {
        event.originalEvent.preventDefault();
        event.originalEvent.stopPropagation();
        activeMarkerId.value = marker.id;
        // 延迟一帧等 OSD viewport 稳定后同步卡片位置
        requestAnimationFrame(() => {
          syncActiveMarkerCardPosition();
        });
      },
    });

    return el;
  }

  function updateOverlayElement(el: HTMLElement, marker: MapMarker, isActive: boolean) {
    el.classList.toggle('osd-marker-active', isActive);
    const iconWrap = el.querySelector('.osd-marker-icon') as HTMLElement | null;
    if (iconWrap) {
      iconWrap.style.color = marker.color ?? DEFAULT_MARKER_COLOR;
      const icon = iconWrap.querySelector('i');
      if (icon) icon.className = marker.icon ?? DEFAULT_MARKER_ICON;
    }
    const label = el.querySelector('.osd-marker-label') as HTMLElement | null;
    if (label) label.textContent = marker.name || '未命名';
  }

  function syncOverlays() {
    const viewer = viewerRef.value;
    if (!viewer || viewer.isDestroyed()) return;

    const image = viewer.world.getItemAt(0);
    if (!image) return;
    const size = image.getContentSize();
    if (!size.x || !size.y) return;

    const currentMarkers = markers.value;
    const markerIds = new Set(currentMarkers.map((m) => m.id));
    const currentActiveId = activeMarkerId.value;

    // 移除已删除的 overlay
    overlayMap.forEach((el, id) => {
      if (!markerIds.has(id)) {
        viewer.removeOverlay(el);
        overlayMap.delete(id);
      }
    });

    // 新增/更新 overlay
    currentMarkers.forEach((marker) => {
      const imagePoint = new OpenSeadragon.Point(
        marker.position.nx * size.x,
        marker.position.ny * size.y,
      );
      const viewportPoint = viewer.viewport.imageToViewportCoordinates(imagePoint);
      let el = overlayMap.get(marker.id);

      if (!el) {
        el = createOverlayElement(marker);
        overlayMap.set(marker.id, el);
        viewer.addOverlay({
          element: el,
          location: viewportPoint,
          placement: OpenSeadragon.Placement.CENTER,
        });
      } else {
        viewer.updateOverlay(el, viewportPoint, OpenSeadragon.Placement.CENTER);
      }
      updateOverlayElement(el, marker, marker.id === currentActiveId);
    });
  }

  function clearOverlays() {
    const viewer = viewerRef.value;
    if (!viewer || viewer.isDestroyed()) return;
    overlayMap.forEach((el) => viewer.removeOverlay(el));
    overlayMap.clear();
  }

  return {
    // 状态
    markers,
    activeMarkerId,
    activeMarker,
    markerAddMode,
    searchQuery,
    filteredMarkers,
    activeMarkerCardPosition,
    // 操作
    setMarkers,
    updateMarker,
    deleteMarker,
    addMarkerAt,
    selectMarker,
    focusMarker,
    // Overlay
    syncOverlays,
    clearOverlays,
    syncActiveMarkerCardPosition,
    // 工具
    generateId,
  };
}
