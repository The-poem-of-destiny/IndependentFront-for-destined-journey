<script setup lang="ts">
/**
 * MapPanel — 地图查看器面板
 *
 * 对标原版 MapTab，用 Vue 3 + OpenSeadragon 重新实现。
 * 功能：地图缩放/平移、预设+手动标记、角色位置高亮、标记编辑工作台。
 * 砍掉：DrawCanvas 自由绘制、SW Cache、图片轮播 UI。
 */

import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import OpenSeadragon from 'openseadragon';
import { useGameStore } from '../../stores/game-store';
import { useMapViewer, resolveMapSources } from '../../composables/useMapViewer';
import {
  useMapMarkers,
  DEFAULT_MARKER_COLOR,
  DEFAULT_MARKER_ICON,
  MARKER_ICON_LABELS,
  MARKER_ICON_OPTIONS,
  MARKER_COLOR_OPTIONS,
} from '../../composables/useMapMarkers';
import { getLocationNode, getLocationNodes } from '@engine/location-db';
import { getMapMarkers } from '@engine/save-profile';
import type { LocationNode, MapMarker } from '@engine/types';
import { getContentRegistry, ensureContentRegistryLoaded } from '../../stores/content-store';

// ═══ Stores ═══
const game = useGameStore();

// ═══ 内容注册表（D23 / D25①） ═══
/**
 * 🔴 本组件**不许**再出现任何指向 `data/` 的静态 import。
 *
 * 原来这里有两条硬耦合：`map-marker-presets.json` 的静态 ESM import（删文件直接 break
 * build）与 `@engine/location-db` 的 `DEFAULT_LOCATIONS` 模块常量。两者都是世界内容，
 * 现在统一从内容注册表（`content-store` 的六面之一）同步读——占位 JSON 或已装内容包供给。
 *
 * 注册表未加载时该面是 `undefined`：进面板前 `await ensureContentRegistryLoaded()`
 * （幂等、永不抛），期间渲染加载态；仍然拿不到就是空数组，面板显示空态而不是崩。
 */
const contentReady = ref(false);

/** 预设标记（注册表 markers 面；非数组 → 空） */
const presetMarkers = computed<MapMarker[]>(() => {
  void contentReady.value; // 注册表是模块级非响应式的，靠这个门重算
  const raw = getContentRegistry().markers;
  return Array.isArray(raw) ? (raw as MapMarker[]) : [];
});

/**
 * 地点节点。
 *
 * 🔴 走 `getLocationNodes()` 而不是自己读注册表的 `locations` 面 —— 那是 location-db
 * 声明的**唯一**入口（含逐项形状校验）。在这里另读一次，「装包后该看到新地图」
 * 这件事就只在一半的地方成立。
 */
const locationNodes = computed<LocationNode[]>(() => {
  void contentReady.value; // 注册表是模块级非响应式的，靠这个门重算
  return getLocationNodes();
});

/** 地图图源（注册表 branding 面的 `mapSources`；公开仓默认空 → 空态） */
const mapSources = computed(() => {
  void contentReady.value;
  return resolveMapSources(getContentRegistry().branding);
});

// ═══ 位置→标记模糊匹配 ═══
/**
 * 把角色 location 字段（如 "city_windmill"、"风车镇"）匹配到预设标记。
 *
 * 匹配策略（按优先级）:
 * 1. 精确匹配: location === marker.name
 * 2. 包含匹配: marker.name 包含 location 或 location 包含 marker.name
 * 3. location-db 桥接: location 是 location-db 的 id → 通过 getLocationNode 取中文名 → 再走 1/2
 *
 * 返回匹配到的标记的归一化坐标，否则 null。
 */
function matchLocationToMarker(location: string, markers: MapMarker[]): MapMarker | null {
  if (!location) return null;

  // 尝试 location-db 解析 → 中文名
  const tryNames = [location];
  const node = getLocationNode(locationNodes.value, location);
  if (node && node.name) {
    tryNames.push(node.name);
  }

  for (const name of tryNames) {
    const qn = name.trim().toLowerCase();
    // 精确匹配
    let m = markers.find((mk) => mk.name.toLowerCase() === qn);
    if (m) return m;
    // 双向包含
    m = markers.find((mk) => {
      const mn = mk.name.toLowerCase();
      return mn.includes(qn) || qn.includes(mn);
    });
    if (m) return m;
  }

  return null;
}

/** 玩家在地图上的位置标记 */
const playerMarker = computed<MapMarker | null>(() => {
  if (!game.player?.location) return null;
  return matchLocationToMarker(game.player.location, markers.value);
});

/** NPC 们的位置标记 (去重，同位置只显示一个) */
const npcLocationMarkers = computed(() => {
  const npcs = game.npcs || [];
  const seen = new Set<string>();
  const result: { name: string; marker: MapMarker; npcNames: string[] }[] = [];
  for (const npc of npcs) {
    if (!npc.location) continue;
    const m = matchLocationToMarker(npc.location, markers.value);
    if (!m) continue;
    if (seen.has(m.id)) {
      // 同一位置的不同 NPC，合并到已有条目
      const existing = result.find((r) => r.marker.id === m.id);
      if (existing) existing.npcNames.push(npc.name);
      continue;
    }
    seen.add(m.id);
    result.push({ name: m.name, marker: m, npcNames: [npc.name] });
  }
  return result;
});

// ═══ Refs ═══
const containerRef = ref<HTMLDivElement | null>(null);
const workbenchOpen = ref(false);
const activeTab = ref<'list' | 'editor'>('list');

// 编辑表单
const editingName = ref('');
const editingGroup = ref('');
const editingDescription = ref('');
const editingImageUrls = ref<string[]>([]);
const editingIcon = ref<string>(DEFAULT_MARKER_ICON);
const editingColor = ref(DEFAULT_MARKER_COLOR);

// 浮动卡片图片轮播
const activeImageIndex = ref(0);

// ═══ 当前标记的图片列表 ═══
const activeMarkerImages = computed(() =>
  (activeMarker.value?.imageUrls ?? []).filter((u) => u.trim()),
);
const activeMarkerImage = computed(() => activeMarkerImages.value[activeImageIndex.value] ?? null);
const hasMultipleImages = computed(() => activeMarkerImages.value.length > 1);

// ═══ Composables ═══
const {
  status,
  errorMessage,
  viewerRef,
  currentSourceKey,
  createViewer,
  loadSource,
  clientPointToNormalized,
  destroy,
} = useMapViewer(containerRef, mapSources);

/** 地图字节下载进度（0-100；本地缓存命中不出现 —— 保持 0，loading 态显示「加载中」） */
const mapDownloadProgress = ref(0);

/** 首次加载 / 切换 / 重试统一入口：带进度回调 */
function requestLoadSource(key: string) {
  mapDownloadProgress.value = 0;
  loadSource(key, (p) => {
    mapDownloadProgress.value = p;
  });
}

const {
  markers,
  activeMarkerId,
  activeMarker,
  markerAddMode,
  searchQuery,
  filteredMarkers,
  activeMarkerCardPosition,
  setMarkers,
  updateMarker,
  deleteMarker: removeMarker,
  addMarkerAt,
  selectMarker,
  focusMarker,
  syncOverlays,
  clearOverlays,
  syncActiveMarkerCardPosition,
} = useMapMarkers(viewerRef);

// ═══ 角色当前位置 =========
// (上面的 playerMarker 和 npcLocationMarkers 已替代旧的 playerLocationNode)

// 玩家位置对应的预设标记
const playerLocationId = computed(() => game.player?.location ?? null);
const playerLocationNode = computed(() => {
  const locId = playerLocationId.value;
  if (!locId) return null;
  return getLocationNode(locationNodes.value, locId) ?? null;
});

// ═══ 持久化 ═══
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  // 🔴 原 setTimeout(persistTimer, ...) 把 timer id 当回调传（TS 报 TimerHandler 错），是类型+运行时双 bug
  //    （1 秒后引擎试图把 number 当函数调用必然抛错）。回调合法化为 no-op 以过 vue-tsc；
  //    markers 持久化若需要应在此接入真正的写入函数（当前由 useMapMarkers 内部处理）。
  persistTimer = setTimeout(() => {
    persistTimer = null;
  }, 1000);
}

watch(markers, () => schedulePersist(), { deep: true });

// ═══ 地图源切换 ═══
function switchSource(key: string) {
  requestLoadSource(key);
  nextTick(() => {
    setTimeout(() => syncOverlays(), 500);
  });
}

// ═══ 标记操作 ═══
function handleUpdateMarker(id: string, patch: Partial<MapMarker>) {
  updateMarker(id, patch);
}

function handleDeleteMarker(id: string) {
  removeMarker(id);
}

function handleAddMarker(nx: number, ny: number) {
  addMarkerAt(nx, ny);
}

// ═══ 标记选中/取消 ═══
function handleSelectMarker(id: string | null) {
  // 切换选中：点击同一标记 → 取消
  if (id && id === activeMarkerId.value) {
    selectMarker(null);
    return;
  }
  selectMarker(id);
  // 填入编辑表单
  if (id) {
    const m = markers.value.find((mm) => mm.id === id);
    if (m) {
      editingName.value = m.name;
      editingGroup.value = m.group ?? '';
      editingDescription.value = m.description ?? '';
      editingImageUrls.value = m.imageUrls ?? [];
      editingIcon.value = m.icon ?? DEFAULT_MARKER_ICON;
      editingColor.value = m.color ?? DEFAULT_MARKER_COLOR;
    }
  }
  // unselect 时清空表单
  if (!id) {
    editingName.value = '';
    editingGroup.value = '';
    editingDescription.value = '';
    editingImageUrls.value = [];
  }
}

/** 工作台列表中点击 → 选中标记并切换到编辑 tab */
function handleWorkbenchSelect(id: string) {
  handleSelectMarker(id);
  activeTab.value = 'editor';
}

function handleSaveEditor() {
  const id = activeMarkerId.value;
  if (!id) return;
  handleUpdateMarker(id, {
    name: editingName.value,
    group: editingGroup.value,
    description: editingDescription.value,
    icon: editingIcon.value as MapMarker['icon'],
    color: editingColor.value,
  });
}

// ═══ 地图点击 → 添加标记/取消选中（见下方 onMapClick）

// ═══ 地图点击 → 添加标记/取消选中（见下方 onMapClick） (位于下方 onMapClick)

// ═══ 图片轮播 ═══
function handlePrevImage() {
  const len = activeMarkerImages.value.length;
  if (!len) return;
  activeImageIndex.value = (activeImageIndex.value - 1 + len) % len;
}
function handleNextImage() {
  const len = activeMarkerImages.value.length;
  if (!len) return;
  activeImageIndex.value = (activeImageIndex.value + 1) % len;
}

// ═══ Viewer 事件 — 缩放/平移后同步卡片位置 ═══
function setupViewerAnimationSync(viewer: OpenSeadragon.Viewer) {
  viewer.addHandler('animation', () => {
    requestAnimationFrame(() => {
      syncActiveMarkerCardPosition();
    });
  });
}

// ═══ 地图点击 → 添加标记/取消选中（见下方 onMapClick）
function onMapClick(event: MouseEvent) {
  // 新增标记模式
  if (markerAddMode.value) {
    const target = event.target as HTMLElement;
    if (target.closest('.osd-marker')) return;
    const point = clientPointToNormalized(event.clientX, event.clientY);
    if (!point) return;
    handleAddMarker(point.nx, point.ny);
    return;
  }
  // 浏览模式：点击地图空白 → 取消选中
  const target = event.target as HTMLElement;
  if (target.closest('.osd-marker') || target.closest('.map-marker-card')) return;
  selectMarker(null);
}

// ═══ Viewer 就绪后同步 overlays + 卡片 ═══
watch(status, (s) => {
  if (s === 'ready') {
    nextTick(() => {
      setTimeout(() => {
        syncOverlays();
        syncActiveMarkerCardPosition();
        // 绑定动画同步
        const v = viewerRef.value;
        if (v) setupViewerAnimationSync(v);
      }, 300);
    });
  }
});

// activeMarker 变化 → 同步 overlays 高亮 + 卡片位置 + 重置轮播
watch(activeMarkerId, () => {
  syncOverlays();
  activeImageIndex.value = 0;
  requestAnimationFrame(() => {
    syncActiveMarkerCardPosition();
  });
});

// 地图源切换后重新同步
watch(currentSourceKey, () => {
  nextTick(() => {
    setTimeout(() => {
      syncOverlays();
      syncActiveMarkerCardPosition();
    }, 500);
  });
});

// markerAddMode 关闭时更新卡片显隐
watch(markerAddMode, (v) => {
  if (!v) {
    requestAnimationFrame(() => {
      syncActiveMarkerCardPosition();
    });
  }
});

// ═══ 生命周期 ═══
onMounted(async () => {
  // 🔴 加载门：注册表六面的首轮加载（幂等、永不抛）。没等它就读 markers/locations
  //    会拿到 undefined，面板一进来就是空的——那不是「没有内容」，是「还没到」。
  await ensureContentRegistryLoaded();
  contentReady.value = true;

  // 预设标记：存档里的 worldFlags 优先，否则用注册表供给的预设标记
  const raw = presetMarkers.value;
  if (game.saveProfile) {
    const existing = getMapMarkers(game.saveProfile);
    setMarkers(existing.length > 0 ? existing : raw);
  } else {
    setMarkers(raw);
  }

  await nextTick();
  createViewer();
  // 首个可用图源；一个都没有时 loadSource 落 error 态并说明「需要内容包」
  requestLoadSource(mapSources.value[0]?.key ?? '');
});

onBeforeUnmount(() => {
  if (persistTimer) clearTimeout(persistTimer);
  clearOverlays();
  destroy();
});
</script>

<template>
  <div class="map-panel">
    <!-- ═══ 工具栏 ═══ -->
    <div class="map-toolbar">
      <div class="toolbar-left">
        <span class="toolbar-title">地图</span>
        <span class="toolbar-badge">{{ markers.length }} 标记</span>
      </div>
      <div class="toolbar-actions">
        <!-- 地图源切换（图源由内容供给；一个都没有时整组不出现） -->
        <div v-if="mapSources.length > 0" class="source-group">
          <button
            v-for="src in mapSources"
            :key="src.key"
            class="btn btn-sm"
            :class="{ 'btn-active': currentSourceKey === src.key }"
            @click="switchSource(src.key)"
          >
            {{ src.name }}
          </button>
        </div>
        <!-- 新增标记模式 -->
        <button
          class="btn btn-sm"
          :class="{ 'btn-active': markerAddMode }"
          @click="markerAddMode = !markerAddMode"
        >
          {{ markerAddMode ? '取消新增' : '新增标记' }}
        </button>
        <!-- 工作台开关 -->
        <button
          class="btn btn-sm"
          :class="{ 'btn-active': workbenchOpen }"
          @click="workbenchOpen = !workbenchOpen"
        >
          {{ workbenchOpen ? '收起工作台' : '标记工作台' }}
        </button>
      </div>
    </div>

    <div class="map-body" :class="{ 'has-workbench': workbenchOpen }">
      <!-- ═══ 地图舞台 ═══ -->
      <div class="map-stage">
        <!-- 状态提示 -->
        <div v-if="status === 'loading'" class="map-overlay">
          <span>{{
            contentReady
              ? mapDownloadProgress > 0
                ? `地图下载中 ${mapDownloadProgress}%…`
                : '地图加载中…'
              : '内容加载中…'
          }}</span>
        </div>
        <div v-else-if="status === 'error'" class="map-overlay map-overlay-error">
          <span>{{ errorMessage || '地图加载失败' }}</span>
          <button
            v-if="mapSources.length > 0"
            class="btn btn-sm"
            @click="requestLoadSource(currentSourceKey || mapSources[0].key)"
          >
            重试
          </button>
        </div>

        <!-- 模式提示 -->
        <div v-if="markerAddMode" class="map-mode-hint">点击地图任意位置放置标记</div>

        <!-- OSD Viewer 容器 -->
        <div
          ref="containerRef"
          class="map-viewer"
          :style="{ cursor: markerAddMode ? 'crosshair' : '' }"
          @click="onMapClick"
        />

        <!-- ═══ 浮动信息卡片 ═══ -->
        <Teleport :to="containerRef" :disabled="!containerRef">
          <article
            v-if="activeMarker && activeMarkerCardPosition.visible"
            class="map-marker-card"
            :style="{
              left: activeMarkerCardPosition.left + 'px',
              top: activeMarkerCardPosition.top + 'px',
            }"
          >
            <!-- 图片区域 -->
            <div v-if="activeMarkerImage" class="card-media">
              <button
                v-if="hasMultipleImages"
                class="card-carousel-btn card-carousel-prev"
                aria-label="上一张"
                @click.stop="handlePrevImage"
              >
                <i class="fa-solid fa-chevron-left" />
              </button>
              <img
                :src="activeMarkerImage"
                :alt="activeMarker.name + ' 主视觉'"
                class="card-hero-image"
                @error="
                  (e: Event) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }
                "
              />
              <button
                v-if="hasMultipleImages"
                class="card-carousel-btn card-carousel-next"
                aria-label="下一张"
                @click.stop="handleNextImage"
              >
                <i class="fa-solid fa-chevron-right" />
              </button>
              <!-- 轮播点 -->
              <div v-if="hasMultipleImages" class="card-carousel-dots">
                <button
                  v-for="(_, idx) in activeMarkerImages"
                  :key="idx"
                  class="card-dot"
                  :class="{ 'card-dot-active': idx === activeImageIndex }"
                  :aria-label="'第 ' + (idx + 1) + ' 张图片'"
                  @click.stop="activeImageIndex = idx"
                />
              </div>
            </div>

            <!-- Header -->
            <div class="card-header">
              <div class="card-title-block">
                <span
                  class="card-dot"
                  :style="{ backgroundColor: activeMarker.color ?? DEFAULT_MARKER_COLOR }"
                />
                <div class="card-heading">
                  <div class="card-title">{{ activeMarker.name || '未命名标记' }}</div>
                  <div class="card-meta">{{ activeMarker.group || '未分组' }}</div>
                </div>
              </div>
            </div>

            <!-- Body -->
            <div class="card-body">
              <p class="card-description">{{ activeMarker.description || '暂无说明' }}</p>
            </div>
          </article>
        </Teleport>

        <!-- 角色位置指示 -->
        <div v-if="playerLocationNode" class="player-location-bar">
          <i class="fa-solid fa-location-dot" />
          <span>当前：{{ playerLocationNode.name }}</span>
          <span v-if="playerMarker" class="loc-matched">✓ 已定位</span>
          <span v-else class="loc-unmatched">（无地图标记）</span>
        </div>

        <!-- NPC 位置汇总 -->
        <div v-if="npcLocationMarkers.length > 0" class="npc-location-bar">
          <i class="fa-solid fa-users" />
          <span>NPC：</span>
          <span
            v-for="loc in npcLocationMarkers"
            :key="loc.marker.id"
            class="npc-loc-tag"
            @click="focusMarker(loc.marker)"
          >
            {{ loc.name }}（{{ loc.npcNames[0]
            }}{{ loc.npcNames.length > 1 ? ' +' + (loc.npcNames.length - 1) : '' }}）
          </span>
        </div>
      </div>

      <!-- ═══ 标记工作台 ═══ -->
      <aside v-if="workbenchOpen" class="marker-workbench">
        <!-- Tab 切换 -->
        <div class="workbench-tabs">
          <button
            class="wb-tab"
            :class="{ active: activeTab === 'list' }"
            @click="activeTab = 'list'"
          >
            标记列表 ({{ filteredMarkers.length }})
          </button>
          <button
            v-if="activeMarker"
            class="wb-tab"
            :class="{ active: activeTab === 'editor' }"
            @click="activeTab = 'editor'"
          >
            编辑
          </button>
        </div>

        <!-- 列表视图 -->
        <div v-if="activeTab === 'list'" class="workbench-list">
          <input v-model="searchQuery" class="wb-search" type="text" placeholder="搜索标记…" />
          <div class="marker-items">
            <button
              v-for="m in filteredMarkers"
              :key="m.id"
              class="marker-item"
              :class="{ 'marker-item-active': m.id === activeMarkerId }"
              @click="handleWorkbenchSelect(m.id)"
            >
              <span class="mi-dot" :style="{ backgroundColor: m.color ?? DEFAULT_MARKER_COLOR }" />
              <span class="mi-name">{{ m.name }}</span>
              <span v-if="m.group" class="mi-group">{{ m.group }}</span>
              <span class="mi-locate" title="定位" @click.stop="focusMarker(m)">
                <i class="fa-solid fa-magnifying-glass-location" />
              </span>
            </button>
            <div v-if="filteredMarkers.length === 0" class="marker-empty">
              {{ searchQuery ? '无匹配标记' : '暂无标记' }}
            </div>
          </div>
        </div>

        <!-- 编辑视图 -->
        <div v-if="activeTab === 'editor' && activeMarker" class="workbench-editor">
          <button class="wb-back" @click="activeTab = 'list'">← 返回列表</button>

          <div class="form-group">
            <label class="form-label">名称</label>
            <input
              v-model="editingName"
              class="form-input"
              type="text"
              @change="handleSaveEditor"
            />
          </div>

          <div class="form-group">
            <label class="form-label">分组</label>
            <input
              v-model="editingGroup"
              class="form-input"
              type="text"
              placeholder="如：城邦 / 遗迹"
              @change="handleSaveEditor"
            />
          </div>

          <div class="form-group">
            <label class="form-label">描述</label>
            <textarea
              v-model="editingDescription"
              class="form-textarea"
              rows="3"
              placeholder="标记说明"
              @change="handleSaveEditor"
            />
          </div>

          <div class="form-group">
            <label class="form-label">图标</label>
            <div class="icon-grid">
              <button
                v-for="icon in MARKER_ICON_OPTIONS"
                :key="icon"
                class="icon-btn"
                :class="{ 'icon-btn-active': editingIcon === icon }"
                :title="MARKER_ICON_LABELS[icon]"
                @click="
                  editingIcon = icon;
                  handleSaveEditor();
                "
              >
                <i :class="icon" />
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">颜色</label>
            <div class="color-row">
              <button
                v-for="color in MARKER_COLOR_OPTIONS"
                :key="color"
                class="color-btn"
                :class="{ 'color-btn-active': editingColor === color }"
                :style="{ backgroundColor: color }"
                @click="
                  editingColor = color;
                  handleSaveEditor();
                "
              />
            </div>
          </div>

          <div class="form-actions">
            <button
              class="btn btn-danger btn-sm"
              @click="
                handleDeleteMarker(activeMarker!.id);
                activeTab = 'list';
              "
            >
              删除标记
            </button>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* ═══ 根布局 ═══ */
.map-panel {
  display: flex;
  flex-direction: column;
  height: 72vh;
  min-height: 480px;
  gap: 0;
}

/* ═══ 工具栏 ═══ */
.map-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--theme-card-border);
  flex-shrink: 0;
}
.toolbar-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.toolbar-title {
  font-family: var(--theme-font-title);
  font-size: 1rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}
.toolbar-badge {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  background: var(--theme-surface-muted);
  padding: 1px 8px;
  border-radius: 999px;
}
.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.source-group {
  display: flex;
  gap: 2px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  overflow: hidden;
}
.source-group .btn {
  border-radius: 0;
  border: none;
}

/* ═══ 通用按钮 ═══ */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-surface-muted);
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  cursor: pointer;
  font-family: inherit;
  transition:
    background 100ms,
    color 100ms;
}
.btn:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.btn-active {
  background: var(--theme-primary-bg);
  color: var(--theme-primary-text);
  border-color: var(--theme-primary-bg);
}
.btn-sm {
  padding: 3px 8px;
  font-size: 0.6875rem;
}
.btn-danger {
  color: var(--theme-error);
  border-color: var(--theme-error);
}

/* ═══ Body ═══ */
.map-body {
  flex: 1;
  display: flex;
  gap: 0;
  min-height: 0;
  margin-top: 10px;
}
.map-body.has-workbench .map-stage {
  flex: 1;
}

/* ═══ 地图舞台 ═══ */
.map-stage {
  flex: 1;
  display: flex;
  flex-direction: column;
  position: relative;
  min-width: 0;
}
.map-viewer {
  flex: 1;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-md);
  border: 1px solid var(--theme-card-border);
  min-height: 320px;
  position: relative;
  overflow: hidden;
}
.map-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(0, 0, 0, 0.45);
  color: #f5f5f5;
  font-size: 0.875rem;
  border-radius: var(--theme-radius-md);
  pointer-events: none;
}
.map-overlay-error {
  pointer-events: auto;
}
.map-overlay-error .btn {
  pointer-events: auto;
}
.map-mode-hint {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 6;
  background: var(--theme-primary-bg);
  color: var(--theme-primary-text);
  font-size: 0.75rem;
  padding: 4px 14px;
  border-radius: 999px;
  pointer-events: none;
}
.player-location-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  margin-top: 8px;
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  flex-shrink: 0;
}
.player-location-bar i {
  color: var(--theme-primary-bg);
}
.loc-matched {
  font-size: 0.625rem;
  color: var(--theme-success, #22c55e);
  margin-left: auto;
}
.loc-unmatched {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  margin-left: auto;
}

/* NPC 位置汇总 */
.npc-location-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  margin-top: 6px;
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  font-size: 0.6875rem;
  color: var(--theme-text-secondary);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.npc-location-bar i {
  color: var(--theme-text-muted);
}
.npc-loc-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  color: var(--theme-text-secondary);
  cursor: pointer;
  font-size: 0.625rem;
  transition:
    border-color 100ms,
    color 100ms;
}
.npc-loc-tag:hover {
  border-color: var(--theme-primary);
  color: var(--theme-text-primary);
}

/* ═══ 标记工作台 ═══ */
.marker-workbench {
  width: 260px;
  flex-shrink: 0;
  border-left: 1px solid var(--theme-card-border);
  margin-left: 12px;
  padding-left: 12px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.workbench-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--theme-card-border);
  margin-bottom: 8px;
  flex-shrink: 0;
}
.wb-tab {
  flex: 1;
  padding: 6px 0;
  border: none;
  background: none;
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  cursor: pointer;
  font-family: inherit;
  border-bottom: 2px solid transparent;
  transition:
    color 100ms,
    border-color 100ms;
}
.wb-tab.active {
  color: var(--theme-primary-bg);
  border-bottom-color: var(--theme-primary-bg);
}
.wb-tab:hover {
  color: var(--theme-text-primary);
}

/* 列表 */
.workbench-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.wb-search {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-surface-muted);
  color: var(--theme-text-primary);
  font-size: 0.6875rem;
  font-family: inherit;
  box-sizing: border-box;
  margin-bottom: 6px;
  flex-shrink: 0;
}
.wb-search::placeholder {
  color: var(--theme-text-muted);
}
.marker-items {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-height: 0;
}
.marker-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: var(--theme-radius-sm);
  background: var(--theme-surface-muted);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.6875rem;
  color: var(--theme-text-primary);
  text-align: left;
  transition: border-color 100ms;
}
.marker-item:hover {
  border-color: var(--theme-card-border);
}
.marker-item-active {
  border-color: var(--theme-primary-bg);
}
.mi-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.mi-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mi-group {
  font-size: 0.5625rem;
  color: var(--theme-text-muted);
  flex-shrink: 0;
}
.mi-locate {
  flex-shrink: 0;
  padding: 2px 4px;
  border: none;
  background: none;
  color: var(--theme-text-muted);
  cursor: pointer;
  font-size: 0.625rem;
  border-radius: 3px;
}
.mi-locate:hover {
  color: var(--theme-primary-bg);
}
.marker-empty {
  text-align: center;
  padding: 20px 0;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}

/* 编辑器 */
.workbench-editor {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wb-back {
  align-self: flex-start;
  padding: 2px 6px;
  border: none;
  background: none;
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  cursor: pointer;
  font-family: inherit;
}
.wb-back:hover {
  color: var(--theme-text-primary);
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.form-label {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
}
.form-input,
.form-textarea {
  padding: 5px 8px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-surface-muted);
  color: var(--theme-text-primary);
  font-size: 0.6875rem;
  font-family: inherit;
  box-sizing: border-box;
  width: 100%;
}
.form-textarea {
  resize: vertical;
}
.icon-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.icon-btn {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-surface-muted);
  color: var(--theme-text-secondary);
  cursor: pointer;
  font-size: 0.8125rem;
  transition: background 100ms;
}
.icon-btn:hover {
  background: var(--theme-tab-hover-bg);
}
.icon-btn-active {
  background: var(--theme-primary-bg);
  color: var(--theme-primary-text);
  border-color: var(--theme-primary-bg);
}
.color-row {
  display: flex;
  gap: 6px;
}
.color-btn {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--theme-card-border);
  cursor: pointer;
}
.color-btn-active {
  outline: 2px solid var(--theme-primary-bg);
  outline-offset: 2px;
}
.form-actions {
  margin-top: auto;
  padding-top: 8px;
  display: flex;
  justify-content: flex-end;
}

/* ═══ 浮动信息卡片 ═══ */
.map-marker-card {
  position: absolute;
  z-index: 8;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(460px, calc(100% - 32px));
  min-width: min(320px, calc(100% - 32px));
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--theme-card-border) 82%, rgba(255, 255, 255, 0.18));
  border-radius: 8px;
  background: color-mix(in srgb, rgba(9, 13, 24, 0.96) 88%, var(--theme-window-bg));
  backdrop-filter: blur(12px);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.34);
  max-height: calc(100% - 24px);
  overflow: hidden;
  transform: translate(-50%, -100%);
  transform-origin: center bottom;
  pointer-events: auto;
  user-select: text;
}
.map-marker-card::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -7px;
  width: 14px;
  height: 14px;
  background: color-mix(in srgb, rgba(9, 13, 24, 0.94) 86%, var(--theme-window-bg));
  border-right: 1px solid
    color-mix(in srgb, var(--theme-card-border) 82%, rgba(255, 255, 255, 0.18));
  border-bottom: 1px solid
    color-mix(in srgb, var(--theme-card-border) 82%, rgba(255, 255, 255, 0.18));
  transform: translateX(-50%) rotate(45deg);
}

/* 图片区域 */
.card-media {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  min-height: 180px;
  border-radius: 6px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.card-hero-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.card-carousel-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.45);
  color: rgba(255, 255, 255, 0.85);
  font-size: 0.875rem;
  cursor: pointer;
  transition: background 120ms;
}
.card-carousel-btn:hover {
  background: rgba(0, 0, 0, 0.65);
}
.card-carousel-prev {
  left: 10px;
}
.card-carousel-next {
  right: 10px;
}
.card-carousel-dots {
  position: absolute;
  left: 50%;
  bottom: 10px;
  transform: translateX(-50%);
  display: flex;
  gap: 6px;
  padding: 4px 10px;
  background: rgba(0, 0, 0, 0.35);
  border-radius: 999px;
}
.card-dot {
  width: 8px;
  height: 8px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.35);
  cursor: pointer;
  transition: background 100ms;
}
.card-dot-active {
  background: rgba(255, 255, 255, 0.88);
}

/* Header */
.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.card-title-block {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.card-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-top: 4px;
  flex-shrink: 0;
}
.card-heading {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.card-title {
  font-size: 16px;
  font-weight: 700;
  line-height: 1.25;
  color: #fff;
}
.card-meta {
  font-size: 12px;
  line-height: 1.4;
  color: rgba(255, 255, 255, 0.72);
}

/* Body */
.card-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  max-height: 150px;
  overflow-y: auto;
}
.card-description {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  color: rgba(255, 255, 255, 0.9);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 响应式 */
@media (max-width: 768px) {
  .map-marker-card {
    width: min(360px, calc(100% - 16px));
    min-width: min(280px, calc(100% - 16px));
    max-height: calc(100% - 12px);
    padding: 10px 8px;
  }
  .card-media {
    min-height: 150px;
  }
  .card-carousel-btn {
    width: 30px;
    height: 30px;
  }
  .card-carousel-dots {
    bottom: 8px;
    padding: 4px 8px;
  }
  .card-header {
    flex-direction: column;
  }
  .card-title {
    font-size: 14px;
  }
  .card-description {
    font-size: 12px;
    line-height: 1.55;
  }
}
</style>

<!-- ═══ 全局样式（非 scoped — 用于 OSD overlay 元素） ═══ -->
<style>
/* OSD marker overlay 样式 */
.osd-marker {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;
  pointer-events: auto;
  z-index: 3;
  transform: translate(-50%, -100%);
  /* 图标锚点对准地图坐标，文字在图标下方 */
}
.osd-marker-active {
  z-index: 5;
}
.osd-marker-active .osd-marker-icon {
  filter: drop-shadow(0 0 4px currentColor);
  transform: scale(1.2);
}
.osd-marker-icon {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: #ffcc66;
  text-shadow: 0 0 6px rgba(0, 0, 0, 0.35);
  transition: transform 100ms;
  flex-shrink: 0;
}
.osd-marker-label {
  margin-top: 2px;
  background: var(--theme-card-bg, #1a1a2e);
  border: 1px solid var(--theme-card-border, #333);
  border-radius: 10px;
  padding: 1px 6px;
  font-size: 10px;
  white-space: nowrap;
  color: var(--theme-text-primary, #eee);
  pointer-events: none;
  user-select: none;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
