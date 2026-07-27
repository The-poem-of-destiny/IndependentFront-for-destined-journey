<script setup lang="ts">
/**
 * ② 播放列表 —— 左侧列表选择器 / 右侧曲目排序
 *
 * 可选曲目由外层传入（已过滤掉隐藏的内置曲目，且只收 music —— 播放列表是
 * 音序器概念，见设计稿 §4.3）。选中项是本组件的局部状态，别处不关心。
 */
import { ref, computed, inject } from 'vue'
import { useAudioStore } from '../../../stores/audio-store'
import { useUIStore } from '../../../stores/ui-store'
import type { AudioTrack } from '@engine/types'
import AppButton from '../../shared/AppButton.vue'
import { audioDialogsKey } from './dialogs'

defineProps<{
  /** 可加入播放列表的曲目（外层已按隐藏名单 + kind 过滤） */
  musicTracks: AudioTrack[]
}>()

const emit = defineEmits<{
  /** 排序结果的无障碍播报，由外层写进唯一的 aria-live 区 */
  (e: 'announce', message: string): void
}>()

const audio = useAudioStore()
const ui = useUIStore()
const dialogs = inject(audioDialogsKey)!

const selectedPlaylistId = ref<string>('')

const selectedPlaylist = computed(() =>
  selectedPlaylistId.value ? audio.findPlaylist(selectedPlaylistId.value) : undefined,
)

const playlistTracks = computed<AudioTrack[]>(() => {
  const p = selectedPlaylist.value
  if (!p) return []
  return p.trackIds.map((id) => audio.findTrack(id)).filter((t): t is AudioTrack => !!t)
})

const addTrackId = ref<string>('')

/**
 * 手工命名撞名时 store 拒绝写入。这里不把用户刚打的字丢掉 —— 说清是哪个名字
 * 被占了，然后带着原文重新弹出输入框，让人改一个字就能继续。取消才退出。
 */
async function createPlaylist(): Promise<void> {
  let draft = '新播放列表'
  for (;;) {
    const name = await dialogs.askPrompt({ title: '新建播放列表', label: '新建播放列表名称', value: draft })
    if (!name) return
    const list = await audio.createPlaylist(name)
    if (list) {
      selectedPlaylistId.value = list.id
      return
    }
    draft = name
    ui.toast(`已有名为「${name}」的播放列表，请换一个名字。`, 'error')
  }
}

async function renameSelectedPlaylist(): Promise<void> {
  const p = selectedPlaylist.value
  if (!p) return
  let draft = p.name
  for (;;) {
    const name = await dialogs.askPrompt({ title: '重命名播放列表', label: '播放列表名称', value: draft })
    if (!name) return
    if (await audio.renamePlaylist(p.id, name)) return
    draft = name
    ui.toast(`已有名为「${name}」的播放列表，请换一个名字。`, 'error')
  }
}

async function deleteSelectedPlaylist(): Promise<void> {
  const p = selectedPlaylist.value
  if (!p) return
  const ok = await dialogs.askConfirm({
    title: '删除播放列表',
    message: `删除播放列表「${p.name}」？曲目本身不会被删除。`,
    confirmLabel: '删除',
    danger: true,
  })
  if (!ok) return
  await audio.deletePlaylist(p.id)
  selectedPlaylistId.value = ''
}

async function addSelectedTrack(): Promise<void> {
  const p = selectedPlaylist.value
  if (!p || !addTrackId.value) return
  await audio.addTrackToPlaylist(p.id, addTrackId.value)
  addTrackId.value = ''
}

// ===== 排序 =====
// 排序只有拖拽这一条路（按需求移除了 ▲▼ 兜底），写路径唯一：
// moveTrack → store.reorderPlaylist。

/** 把第 from 位挪到第 to 位；越界或原地一律不写库 */
async function moveTrack(from: number, to: number): Promise<void> {
  const p = selectedPlaylist.value
  if (!p) return
  const ids = [...p.trackIds]
  if (from < 0 || from >= ids.length) return
  if (to < 0 || to >= ids.length || to === from) return
  const [moved] = ids.splice(from, 1)
  ids.splice(to, 0, moved)
  await audio.reorderPlaylist(p.id, ids)
  const name = audio.findTrack(moved)?.name ?? '曲目'
  emit('announce', `已将「${name}」移动到第 ${to + 1} 位，共 ${ids.length} 首。`)
}

// ── 原生 HTML5 拖放 ───────────────────────────────────────
// 不引第三方库：整行 draggable，浏览器自带拖影，无需自己算指针位移与滚动。
// 语义是「放到目标行所在的位次」（不是行间插槽），所以落点指示就是给目标行
// 染底 + 一圈 1px 内描边（design.md 绝对禁令：不用 >1px 的彩色侧边条）。

/** 拖拽源的位次；-1 表示当前没有在拖 */
const dragIndex = ref(-1)
/** 悬停中的落点位次；-1 表示没有落点 */
const dropIndex = ref(-1)

function onDragStart(index: number, e: DragEvent): void {
  dragIndex.value = index
  dropIndex.value = index
  const dt = e.dataTransfer
  if (!dt) return
  dt.effectAllowed = 'move'
  // Firefox 不 setData 就根本不开始拖；个别环境禁止写入，失败也不该炸掉拖拽
  try { dt.setData('text/plain', String(index)) } catch { /* 忽略 */ }
}

function onDragOver(index: number, e: DragEvent): void {
  if (dragIndex.value < 0) return
  e.preventDefault() // 不 preventDefault 就不会触发 drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropIndex.value = index
}

async function onDrop(index: number, e: DragEvent): Promise<void> {
  e.preventDefault()
  const from = dragIndex.value
  resetDrag()
  await moveTrack(from, index) // 原地放下 → moveTrack 自己会短路，不写库
}

function resetDrag(): void {
  dragIndex.value = -1
  dropIndex.value = -1
}
</script>

<template>
  <h4 class="band-title">播放列表</h4>

  <div class="playlist-grid">
    <!-- 选择器 -->
    <div class="playlist-picker">
      <div class="picker-actions">
        <AppButton variant="primary" size="sm" @click="createPlaylist"><i class="fa-solid fa-plus" aria-hidden="true" /> 新建</AppButton>
        <AppButton variant="secondary" size="sm" :disabled="!selectedPlaylist" @click="renameSelectedPlaylist">重命名</AppButton>
        <AppButton variant="secondary" size="sm" :disabled="!selectedPlaylist" @click="deleteSelectedPlaylist">删除</AppButton>
      </div>
      <div v-if="audio.playlists.length === 0" class="empty-tab">书页尚空，尚未建立播放列表…</div>
      <button
        v-for="p in audio.playlists"
        :key="p.id"
        class="picker-item"
        :class="{ 'picker-active': p.id === selectedPlaylistId }"
        :aria-pressed="p.id === selectedPlaylistId"
        @click="selectedPlaylistId = p.id"
      >
        <span class="picker-name">{{ p.name }}</span>
        <span class="picker-count">{{ p.trackIds.length }}</span>
      </button>
    </div>

    <!-- 曲目 -->
    <div class="playlist-tracks">
      <template v-if="selectedPlaylist">
        <div class="picker-actions">
          <select v-model="addTrackId" class="mini-select" aria-label="选择要加入的曲目">
            <option value="">加入曲目…</option>
            <option v-for="t in musicTracks" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
          <AppButton variant="secondary" size="sm" :disabled="!addTrackId" @click="addSelectedTrack">加入</AppButton>
          <AppButton variant="secondary" size="sm" :disabled="playlistTracks.length === 0" @click="audio.playPlaylist(selectedPlaylist.id, 0)"><i class="fa-solid fa-play" aria-hidden="true" /> 播放</AppButton>
        </div>
        <div v-if="playlistTracks.length === 0" class="empty-tab">此列表尚无曲目…</div>
        <p v-else class="reorder-hint text-muted">可拖动曲目调整顺序。</p>
        <div
          v-for="(t, i) in playlistTracks"
          :key="t.id + '_' + i"
          class="track-row"
          :class="{ 'row-dragging': dragIndex === i, 'row-drop-target': dropIndex === i && dragIndex !== i }"
          draggable="true"
          @dragstart="onDragStart(i, $event)"
          @dragover="onDragOver(i, $event)"
          @drop="onDrop(i, $event)"
          @dragend="resetDrag"
        >
          <!-- 拖拽把手：纯装饰的可供性提示，真正可拖的是整行 -->
          <span class="drag-grip" aria-hidden="true"><i class="fa-solid fa-grip-vertical" aria-hidden="true" /></span>
          <span
            class="kind-dot"
            :class="`dot-${t.kind}`"
            role="img"
            :aria-label="t.kind === 'sfx' ? '音效' : '音乐'"
          />
          <span class="track-name">{{ t.name }}</span>
          <button class="icon-btn icon-danger" aria-label="移出列表" @click="audio.removeTrackFromPlaylist(selectedPlaylist!.id, t.id)">
            <i class="fa-solid fa-xmark" aria-hidden="true" />
          </button>
        </div>
      </template>
      <div v-else class="empty-tab">先在左侧选择一个播放列表…</div>
    </div>
  </div>
</template>

<style scoped>
/* ═══ 分段标题 + 装饰线 ═══ */
.band-title {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  margin: 0 0 var(--theme-spacing-md);
}
.band-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}

/* ═══ 空态 ═══ */
.empty-tab {
  padding: var(--theme-spacing-xl) 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
}
.empty-tab::before {
  content: '—';
  display: block;
  margin-bottom: var(--theme-spacing-sm);
  font-size: 1.25rem;
  opacity: 0.3;
}

/* ═══ 播放列表 ═══ */
.playlist-grid {
  display: grid;
  grid-template-columns: 16rem minmax(0, 1fr);
  gap: var(--theme-spacing-lg);
}
@media (max-width: 720px) {
  .playlist-grid { grid-template-columns: minmax(0, 1fr); }
}
.picker-actions {
  display: flex;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  margin-bottom: var(--theme-spacing-sm);
}
.picker-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  width: 100%;
  min-height: 36px;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  margin-bottom: var(--theme-spacing-xs);
  background: transparent;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  color: var(--theme-text-secondary);
  font-family: inherit;
  font-size: 0.8125rem;
  text-align: left;
  cursor: pointer;
  transition: background var(--theme-transition-fast), color var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.picker-item:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.picker-active {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-text-primary);
  font-weight: 600;
}
.picker-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.picker-count {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}

/* ═══ 曲目行 ═══ */
.track-row {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  padding: var(--theme-spacing-sm) 0;
  border-bottom: 1px solid var(--theme-card-border);
}
.track-row:last-child {
  border-bottom: none;
}

/* ═══ 拖拽排序 ═══ */
/* 全程只有静态的染底/描边，没有任何过渡与动画 —— prefers-reduced-motion 下无需额外处理 */
.reorder-hint {
  margin: 0 0 var(--theme-spacing-sm);
  font-size: 0.75rem;
  line-height: 1.55;
}
/* 把手只是可供性提示；真正可拖的是整行，所以它不抢指针语义之外的东西 */
.drag-grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  flex-shrink: 0;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  cursor: grab;
}
.track-row:active .drag-grip {
  cursor: grabbing;
}
/* 被拖的那一行：只降透明度，不动布局属性 */
.row-dragging {
  opacity: 0.45;
}
/*
 * 落点指示：染底 + 一圈 1px 内描边。
 * 用 inset box-shadow 而不是 border —— 行本身只有 border-bottom，
 * 换成四边 border 会把行撑高一格，拖动时整列跟着抖。
 */
.row-drop-target {
  background: color-mix(in srgb, var(--theme-primary) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  border-radius: var(--theme-radius-sm);
}
.kind-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
}
/* 类型不能只靠颜色区分（WCAG 1.4.1）：音乐=圆点，音效=菱形，另有可读名字 */
.dot-music {
  background: var(--theme-primary);
  border-radius: 50%;
}
.dot-sfx {
  background: var(--theme-success);
  border-radius: 1px;
  transform: rotate(45deg);
}
.track-name {
  flex: 1;
  min-width: 8rem;
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ═══ 按钮 ═══ */
/* 统一的键盘焦点环 —— 这片区域按钮最密，没有焦点提示等于让人闭眼穿行 */
.icon-btn:focus-visible,
.picker-item:focus-visible {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}
.icon-btn {
  min-width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-secondary);
  font-family: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  transition: background var(--theme-transition-fast), color var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
/* 图标字体的视觉重量与 emoji 不同，单独给一档字号找回平衡（按钮尺寸不变） */
.icon-btn i {
  font-size: 0.875rem;
  line-height: 1;
}
/* 本段只剩「移出列表」一枚图标按钮，且它从不禁用 —— 故无 :disabled 分支 */
.icon-btn:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.icon-danger:hover {
  color: var(--theme-error);
  border-color: color-mix(in srgb, var(--theme-error) 45%, var(--theme-card-border));
}

/* ═══ 下拉（与曲库同一副 mini 外壳） ═══ */
.mini-select {
  height: 36px;
  padding: 0 var(--theme-spacing-sm);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.8125rem;
}
.mini-select:focus {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}
</style>
