<script setup lang="ts">
/**
 * MapPanel — 地图查看器面板
 *
 * 对标原版 MapTab，用 Vue 3 + OpenSeadragon 重新实现。
 * 功能：地图缩放/平移、预设+手动标记、角色位置高亮、标记编辑工作台。
 * 砍掉：DrawCanvas 自由绘制、SW Cache、图片轮播 UI。
 */

import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useGameStore } from '../../stores/game-store'
import { useMapViewer, MAP_SOURCES } from '../../composables/useMapViewer'
import {
  useMapMarkers,
  DEFAULT_MARKER_COLOR,
  DEFAULT_MARKER_ICON,
  MARKER_ICON_LABELS,
  MARKER_ICON_OPTIONS,
  MARKER_COLOR_OPTIONS,
} from '../../composables/useMapMarkers'
import { DEFAULT_LOCATIONS, getLocationNode } from '@engine/location-db'
import { getMapMarkers } from '@engine/save-profile'
import type { MapMarker } from '@engine/types'
import presetMarkersJson from '../../../../data/defaults/map-marker-presets.json'

// ═══ Stores ═══
const game = useGameStore()

// ═══ Refs ═══
const containerRef = ref<HTMLDivElement | null>(null)
const workbenchOpen = ref(false)
const activeTab = ref<'list' | 'editor'>('list')

// 编辑表单
const editingName = ref('')
const editingGroup = ref('')
const editingDescription = ref('')
const editingIcon = ref<string>(DEFAULT_MARKER_ICON)
const editingColor = ref(DEFAULT_MARKER_COLOR)

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
} = useMapViewer(containerRef)

const {
  markers,
  activeMarkerId,
  activeMarker,
  markerAddMode,
  searchQuery,
  filteredMarkers,
  setMarkers,
  updateMarker,
  deleteMarker: removeMarker,
  addMarkerAt,
  selectMarker,
  focusMarker,
  syncOverlays,
  clearOverlays,
} = useMapMarkers(viewerRef)

// ═══ 角色当前位置 =========
const playerLocationId = computed(() => game.player?.location ?? null)
const playerLocationNode = computed(() => {
  const locId = playerLocationId.value
  if (!locId) return null
  return getLocationNode(DEFAULT_LOCATIONS, locId) ?? null
})

// ═══ 持久化 ═══
let persistTimer: ReturnType<typeof setTimeout> | null = null
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(persistTimer, 1000)
}

watch(markers, () => schedulePersist(), { deep: true })

// ═══ 地图源切换 ═══
function switchSource(key: 'small' | 'large') {
  loadSource(key)
  nextTick(() => {
    setTimeout(() => syncOverlays(), 500)
  })
}

// ═══ 标记操作 ═══
function handleUpdateMarker(id: string, patch: Partial<MapMarker>) {
  updateMarker(id, patch)
}

function handleDeleteMarker(id: string) {
  removeMarker(id)
}

function handleAddMarker(nx: number, ny: number) {
  addMarkerAt(nx, ny)
}

function handleSelectMarker(id: string | null) {
  selectMarker(id)
  if (id) {
    activeTab.value = 'editor'
    const m = markers.value.find(mm => mm.id === id)
    if (m) {
      editingName.value = m.name
      editingGroup.value = m.group ?? ''
      editingDescription.value = m.description ?? ''
      editingIcon.value = m.icon ?? DEFAULT_MARKER_ICON
      editingColor.value = m.color ?? DEFAULT_MARKER_COLOR
    }
  } else {
    activeTab.value = 'list'
  }
}

function handleSaveEditor() {
  const id = activeMarkerId.value
  if (!id) return
  handleUpdateMarker(id, {
    name: editingName.value,
    group: editingGroup.value,
    description: editingDescription.value,
    icon: editingIcon.value as MapMarker['icon'],
    color: editingColor.value,
  })
}

// ═══ 地图点击 → 添加标记 ═══
function onMapClick(event: MouseEvent) {
  if (!markerAddMode.value) return
  const target = event.target as HTMLElement
  if (target.closest('.osd-marker')) return

  const point = clientPointToNormalized(event.clientX, event.clientY)
  if (!point) return
  handleAddMarker(point.nx, point.ny)
  markerAddMode.value = false
}

// ═══ Viewer 就绪后同步 overlays ═══
watch(status, (s) => {
  if (s === 'ready') {
    nextTick(() => {
      setTimeout(() => syncOverlays(), 300)
    })
  }
})

watch(activeMarkerId, () => {
  syncOverlays()
})

// ═══ 生命周期 ═══
onMounted(async () => {
  // 预设标记：worldFlags 优先，否则用静态导入的原版标记
  const raw: MapMarker[] = Array.isArray(presetMarkersJson) ? presetMarkersJson : (presetMarkersJson as any).default ?? []
  if (game.saveProfile) {
    const existing = getMapMarkers(game.saveProfile)
    setMarkers(existing.length > 0 ? existing : raw)
  } else {
    setMarkers(raw)
  }

  await nextTick()
  createViewer()
  loadSource('small')
})

onBeforeUnmount(() => {
  if (persistTimer) clearTimeout(persistTimer)
  clearOverlays()
  destroy()
})
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
        <!-- 地图源切换 -->
        <div class="source-group">
          <button
            v-for="src in MAP_SOURCES"
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
          <span>地图加载中…</span>
        </div>
        <div v-else-if="status === 'error'" class="map-overlay map-overlay-error">
          <span>{{ errorMessage || '地图加载失败' }}</span>
          <button class="btn btn-sm" @click="loadSource(currentSourceKey)">重试</button>
        </div>

        <!-- 模式提示 -->
        <div v-if="markerAddMode" class="map-mode-hint">
          📍 点击地图任意位置放置标记
        </div>

        <!-- OSD Viewer 容器 -->
        <div
          ref="containerRef"
          class="map-viewer"
          @click="onMapClick"
          :style="{ cursor: markerAddMode ? 'crosshair' : '' }"
        />

        <!-- 角色位置指示 -->
        <div
          v-if="playerLocationNode"
          class="player-location-bar"
        >
          <i class="fa-solid fa-location-dot" />
          <span>当前：{{ playerLocationNode.name }}</span>
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
          <input
            v-model="searchQuery"
            class="wb-search"
            type="text"
            placeholder="搜索标记…"
          />
          <div class="marker-items">
            <button
              v-for="m in filteredMarkers"
              :key="m.id"
              class="marker-item"
              :class="{ 'marker-item-active': m.id === activeMarkerId }"
              @click="handleSelectMarker(m.id)"
            >
              <span class="mi-dot" :style="{ backgroundColor: m.color ?? DEFAULT_MARKER_COLOR }" />
              <span class="mi-name">{{ m.name }}</span>
              <span class="mi-group" v-if="m.group">{{ m.group }}</span>
              <span class="mi-locate"
                title="定位"
                @click.stop="focusMarker(m)"
              >
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
          <button class="wb-back" @click="activeTab = 'list'">
            ← 返回列表
          </button>

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
                @click="editingIcon = icon; handleSaveEditor()"
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
                @click="editingColor = color; handleSaveEditor()"
              />
            </div>
          </div>

          <div class="form-actions">
            <button class="btn btn-danger btn-sm" @click="handleDeleteMarker(activeMarker!.id); activeTab = 'list'">
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
  transition: background 100ms, color 100ms;
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
  transition: color 100ms, border-color 100ms;
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
</style>

<!-- ═══ 全局样式（非 scoped — 用于 OSD overlay 元素） ═══ -->
<style>
/* OSD marker overlay 样式 */
.osd-marker {
  position: relative;
  width: 18px;
  height: 18px;
  transform: translate(-50%, -50%);
  cursor: pointer;
  pointer-events: auto;
  z-index: 3;
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
}
.osd-marker-label {
  position: absolute;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--theme-card-bg, #1a1a2e);
  border: 1px solid var(--theme-card-border, #333);
  border-radius: 10px;
  padding: 1px 6px;
  font-size: 10px;
  white-space: nowrap;
  color: var(--theme-text-primary, #eee);
  pointer-events: none;
}
</style>
