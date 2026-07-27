<script setup lang="ts">
/**
 * ③ 曲库 —— 表头用量 / 音乐文件夹条 / 上传组 / 筛选工具栏 / 曲目行 + 行内编辑
 *
 * 内置曲目不可改名/改标签/删除（store 拒绝），只能隐藏 —— 隐藏名单存
 * settings.audioHiddenBuiltinIds（对齐 beautifierBuiltinDisabled 先例）。
 * 传入的 tracks 已由外层按隐藏名单过滤（隐藏名单同时影响播放列表的选曲下拉，
 * 所以这份过滤住在外层，本组件只在其上叠搜索 / 类型 / 标签三道筛选）。
 */
import { ref, computed, watch, onMounted, inject } from 'vue'
import { useAudioStore } from '../../../stores/audio-store'
import { useSettingsStore } from '../../../stores/settings-store'
import { useUIStore } from '../../../stores/ui-store'
import type { AudioTrack, AudioTrackKind } from '@engine/types'
import AppButton from '../../shared/AppButton.vue'
import AudioFolderStrip from './AudioFolderStrip.vue'
import { audioDialogsKey } from './dialogs'
import { fmtBytes, fmtDuration, sourceLabel, sourceHint, isHiddenBuiltin } from './format'

const props = defineProps<{
  /** 隐藏名单过滤后的曲目（供本组件再叠搜索/类型/标签筛选） */
  tracks: AudioTrack[]
  /** 「显示已隐藏的内置曲目」开关 —— 外层持有，因为它同时影响播放列表选曲 */
  showHidden: boolean
}>()

const emit = defineEmits<{
  (e: 'update:showHidden', value: boolean): void
  /** 一次性事件的无障碍播报（上传结果），由外层写进唯一的 aria-live 区 */
  (e: 'announce', message: string): void
}>()

const audio = useAudioStore()
const cfg = useSettingsStore()
const ui = useUIStore()
const s = cfg.settings
const dialogs = inject(audioDialogsKey)!

const storageInfo = ref<{ used: number; quota: number; pct: number } | null>(null)

onMounted(async () => {
  storageInfo.value = await cfg.getStorageUsage()
})

// ===== 筛选 =====

const search = ref('')
const kindFilter = ref<'all' | AudioTrackKind>('all')
const tagFilter = ref('')
const uploadKind = ref<AudioTrackKind>('music')
const fileInput = ref<HTMLInputElement | null>(null)
const editingId = ref<string>('')
const editName = ref('')
const editTags = ref('')
const editKind = ref<AudioTrackKind>('music')

const showHiddenBuiltins = computed({
  get: () => props.showHidden,
  set: (v: boolean) => emit('update:showHidden', v),
})

/** 内置曲目隐藏名单（内置不可删，只能隐藏 —— §2） */
const hiddenBuiltinIds = computed<string[]>(() => s.audioHiddenBuiltinIds ?? [])

function isHidden(t: AudioTrack): boolean {
  return isHiddenBuiltin(t, hiddenBuiltinIds.value)
}

const allTags = computed(() => {
  const set = new Set<string>()
  for (const t of audio.tracks) for (const tag of t.tags ?? []) set.add(tag)
  return [...set].sort()
})

const filteredTracks = computed(() => {
  const q = search.value.trim().toLowerCase()
  return props.tracks.filter((t) => {
    if (kindFilter.value !== 'all' && t.kind !== kindFilter.value) return false
    if (tagFilter.value && !(t.tags ?? []).includes(tagFilter.value)) return false
    if (q && !t.name.toLowerCase().includes(q)) return false
    return true
  })
})

// ===== 多选 + 批量操作 =====
// 选中集合按 id 存，跨筛选保留 —— 换个筛选条件不该把已选的东西悄悄丢掉。
// 但「全选」只作用于**当前筛选结果**，所以勾选框旁边写死了筛选后的条数，
// 免得用户以为自己全选了整个曲库。

const selectedIds = ref<Set<string>>(new Set())
/** shift 区间选择的锚点（上一次点过的行） */
const anchorId = ref('')
/** 批量加入的目标播放列表 */
const batchPlaylistId = ref('')

function isSelected(t: AudioTrack): boolean {
  return selectedIds.value.has(t.id)
}

/** 选中的曲目按曲库顺序取，与当前筛选无关 */
const selectedTracks = computed(() => audio.tracks.filter((t) => selectedIds.value.has(t.id)))
const selectedCount = computed(() => selectedTracks.value.length)
const selectedMusicCount = computed(() => selectedTracks.value.filter((t) => t.kind === 'music').length)
const selectedSfxCount = computed(() => selectedCount.value - selectedMusicCount.value)

const allFilteredSelected = computed(
  () => filteredTracks.value.length > 0 && filteredTracks.value.every((t) => selectedIds.value.has(t.id)),
)
const someFilteredSelected = computed(
  () => !allFilteredSelected.value && filteredTracks.value.some((t) => selectedIds.value.has(t.id)),
)

/**
 * 行勾选。shift + 点击 → 从锚点到本行的连续区间一并选中（区间只加不减，
 * 这是列表多选的通用预期）；否则就是单纯的切换。
 * 模板用 @click.prevent 接管，勾选态完全由这里的集合驱动，不让 DOM 自己跑偏。
 */
function onRowSelect(t: AudioTrack, e: MouseEvent): void {
  const next = new Set(selectedIds.value)
  const list = filteredTracks.value
  const to = list.findIndex((x) => x.id === t.id)
  const from = anchorId.value ? list.findIndex((x) => x.id === anchorId.value) : -1
  if (e.shiftKey && from >= 0 && to >= 0) {
    const [a, b] = from <= to ? [from, to] : [to, from]
    for (let i = a; i <= b; i += 1) next.add(list[i].id)
  } else if (next.has(t.id)) {
    next.delete(t.id)
  } else {
    next.add(t.id)
  }
  anchorId.value = t.id
  selectedIds.value = next
}

/** 全选/取消全选 —— **只作用于当前筛选结果**，不碰筛选之外的曲目 */
function toggleSelectAllFiltered(): void {
  const next = new Set(selectedIds.value)
  const all = allFilteredSelected.value
  for (const t of filteredTracks.value) {
    if (all) next.delete(t.id)
    else next.add(t.id)
  }
  anchorId.value = ''
  selectedIds.value = next
}

function clearSelection(): void {
  selectedIds.value = new Set()
  anchorId.value = ''
}

// 曲目被删掉（这里删的、别处删的都算）之后不能留下悬空的选中 id，
// 否则「已选 N 首」会一直虚报，批量操作也会对着不存在的曲目发号施令。
watch(
  () => audio.tracks,
  (list) => {
    if (selectedIds.value.size === 0) return
    const alive = new Set(list.map((t) => t.id))
    const next = new Set([...selectedIds.value].filter((id) => alive.has(id)))
    if (next.size !== selectedIds.value.size) selectedIds.value = next
  },
)

/**
 * 批量删除的确认必须说清爆炸半径（对齐单曲删除的既有标准）：
 * 牵动几个播放列表、哪些是磁盘文件（文件不会被删）、哪些在浏览器存储里、
 * 以及内置曲目根本删不掉这件事。
 */
function buildBatchDeleteMessage(list: AudioTrack[]): string {
  const deletable = list.filter((t) => !t.builtin)
  const builtinCount = list.length - deletable.length
  const lines = [`删除选中的 ${deletable.length} 首曲目？`]

  const affected = new Set<string>()
  let inLists = 0
  for (const t of deletable) {
    const hits = audio.playlists.filter((p) => p.trackIds.includes(t.id))
    if (hits.length > 0) inLists += 1
    for (const p of hits) affected.add(p.id)
  }
  if (inLists > 0) {
    lines.push(`其中 ${inLists} 首共出现在 ${affected.size} 个播放列表中，删除后将一并移出。`)
  }

  const fileCount = deletable.filter((t) => t.source === 'file').length
  const blobCount = deletable.length - fileCount
  if (fileCount > 0) {
    lines.push(`其中 ${fileCount} 首来自音乐文件夹，只移除曲库记录，磁盘上的文件不会被删除。`)
  }
  if (blobCount > 0) {
    lines.push(`${fileCount > 0 ? '另有' : '其中'} ${blobCount} 首存放在浏览器存储中，删除后不可撤销。`)
  }
  if (builtinCount > 0) {
    lines.push(`另选中的 ${builtinCount} 首是内置曲目，不会被删除（内置曲目只能隐藏）。`)
  }
  return lines.join('\n')
}

async function batchDelete(): Promise<void> {
  const list = selectedTracks.value
  if (list.length === 0) return
  const deletable = list.filter((t) => !t.builtin)
  if (deletable.length === 0) {
    ui.toast('选中的都是内置曲目，内置曲目只能隐藏，不能删除。', 'warning')
    return
  }
  const ok = await dialogs.askConfirm({
    title: '批量删除曲目',
    message: buildBatchDeleteMessage(list),
    confirmLabel: `删除 ${deletable.length} 首`,
    danger: true,
  })
  if (!ok) return
  // 汇总提示由 store 负责（尽力做完模式），这里只管清选择与刷新用量
  const res = await audio.deleteTracks(deletable.map((t) => t.id))
  clearSelection()
  emit('announce', res.failed > 0
    ? `已删除 ${res.ok} 首曲目，${res.failed} 首未能删除。`
    : `已删除 ${res.ok} 首曲目。`)
  storageInfo.value = await cfg.getStorageUsage()
}

/** 播放列表是音序器概念，只收 music（§4.3）；选中的音效如实跳过并在批量条上写明 */
async function batchAddToPlaylist(): Promise<void> {
  const ids = selectedTracks.value.filter((t) => t.kind === 'music').map((t) => t.id)
  if (ids.length === 0 || !batchPlaylistId.value) return
  const res = await audio.addTracksToPlaylist(batchPlaylistId.value, ids)
  clearSelection()
  emit('announce', res.skipped > 0
    ? `已加入 ${res.ok} 首曲目，${res.skipped} 首已在列表中，已跳过。`
    : `已加入 ${res.ok} 首曲目。`)
}

function toggleHideBuiltin(t: AudioTrack): void {
  const list = [...hiddenBuiltinIds.value]
  const i = list.indexOf(t.id)
  if (i >= 0) list.splice(i, 1)
  else list.push(t.id)
  s.audioHiddenBuiltinIds = list
}

// ===== 上传 =====

function pickFiles(): void {
  fileInput.value?.click()
}

/** 上传超过 20MB 给一次软确认（§3.5），不做任何自动清理 */
const SOFT_LIMIT_BYTES = 20 * 1024 * 1024

async function onFilesPicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length === 0) return
  const total = files.reduce((n, f) => n + f.size, 0)
  // 软确认要拿新鲜的配额说话 —— 缓存值可能是几分钟前的
  if (total > SOFT_LIMIT_BYTES) {
    storageInfo.value = await cfg.getStorageUsage()
    const ok = await dialogs.askConfirm({
      title: '上传音频',
      message: `本次上传约 ${fmtBytes(total)}，会占用浏览器存储配额（与存档共用）。继续吗？`,
      confirmLabel: '继续上传',
    })
    if (!ok) return
  }
  try {
    const created = await audio.uploadFiles(files, uploadKind.value)
    ui.toast(`已添加 ${created.length} 个音频`, 'success')
    emit('announce', `已添加 ${created.length} 个音频`)
  } catch (err) {
    if (isQuotaError(err)) {
      ui.toast(
        '存储空间不足，无法保存音频。可改用「音乐文件夹」，文件将留在磁盘上不占用浏览器空间。',
        'error',
      )
    } else {
      const detail = err instanceof Error ? err.message : String(err)
      ui.toast(`上传失败：${detail}`, 'error')
    }
  }
  storageInfo.value = await cfg.getStorageUsage()
}

/** 配额耗尽在各浏览器里的两种名字 */
function isQuotaError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
}

// ===== 行内编辑 / 删除 / 试听 =====

function startEdit(t: AudioTrack): void {
  editingId.value = t.id
  editName.value = t.name
  editTags.value = (t.tags ?? []).join(', ')
  editKind.value = t.kind
}

function cancelEdit(): void {
  editingId.value = ''
}

async function saveEdit(t: AudioTrack): Promise<void> {
  const name = editName.value.trim()
  // 撞名 → store 拒绝。行内编辑面板原样留着（用户填的名字/标签都还在），改个名再存。
  if (name && name !== t.name && !(await audio.renameTrack(t.id, name))) {
    ui.toast(`已有名为「${name}」的曲目，请换一个名字。`, 'error')
    return
  }
  const tags = editTags.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
  await audio.setTrackTags(t.id, tags)
  if (editKind.value !== t.kind) await audio.setTrackKind(t.id, editKind.value)
  editingId.value = ''
}

/** 删除会顺带把该曲目剪出所有播放列表 —— 先数清楚，写进确认文案 */
function playlistUseCount(trackId: string): number {
  return audio.playlists.filter((p) => p.trackIds.includes(trackId)).length
}

async function removeTrack(t: AudioTrack): Promise<void> {
  const base = t.source === 'file'
    ? `删除曲目「${t.name}」？只移除曲库记录，磁盘上的文件不会被删除。`
    : `删除曲目「${t.name}」？此操作不可撤销。`
  const n = playlistUseCount(t.id)
  const msg = n > 0
    ? `${base}\n该曲目在 ${n} 个播放列表中，删除后将一并移出。`
    : base
  const ok = await dialogs.askConfirm({ title: '删除曲目', message: msg, confirmLabel: '删除', danger: true })
  if (!ok) return
  await audio.deleteTrack(t.id)
  storageInfo.value = await cfg.getStorageUsage()
}

async function audition(t: AudioTrack): Promise<void> {
  if (t.missing) return
  if (t.kind === 'sfx') {
    const ok = await audio.playSfx(t.id)
    if (!ok) {
      ui.toast(
        audio.state.unlocked ? '播放失败。' : '浏览器尚未解锁音频，请先点击页面任意处再试听。',
        'warning',
      )
    }
    return
  }
  await audio.playTrack(t.id)
}
</script>

<template>
  <div class="library-head">
    <h4 class="band-title">曲库</h4>
    <span v-if="storageInfo" class="usage-text">
      浏览器存储 {{ fmtBytes(storageInfo.used) }} / {{ fmtBytes(storageInfo.quota) }}
      （{{ storageInfo.pct.toFixed(1) }}%）
    </span>
  </div>
  <p class="library-note text-muted text-sm">
    音频与存档共用同一份浏览器配额；「清除所有数据」会一并删除曲库。
  </p>

  <!-- 音乐文件夹 -->
  <AudioFolderStrip />

  <!-- 上传（输入）：单独成组，避免上传类型被误读为列表过滤器 -->
  <div class="lib-upload">
    <span class="upload-label">上传为</span>
    <select v-model="uploadKind" class="mini-select" aria-label="上传类型">
      <option value="music">音乐</option>
      <option value="sfx">音效</option>
    </select>
    <AppButton variant="primary" size="sm" @click="pickFiles"><i class="fa-solid fa-plus" aria-hidden="true" /> 上传音频</AppButton>
    <input
      ref="fileInput"
      class="file-input"
      type="file"
      accept="audio/*"
      multiple
      aria-label="选择音频文件"
      @change="onFilesPicked"
    />
    <span class="upload-hint">决定接下来上传的文件如何归类，上传后可在曲目编辑中更改。</span>
  </div>

  <!-- 工具条（查看筛选） -->
  <div class="lib-toolbar">
    <input v-model="search" class="mini-input" type="search" placeholder="搜索曲名…" aria-label="搜索曲名" />
    <select v-model="kindFilter" class="mini-select" aria-label="按类型过滤">
      <option value="all">全部类型</option>
      <option value="music">音乐</option>
      <option value="sfx">音效</option>
    </select>
    <select v-model="tagFilter" class="mini-select" aria-label="按标签过滤">
      <option value="">全部标签</option>
      <option v-for="tag in allTags" :key="tag" :value="tag">{{ tag }}</option>
    </select>
    <label class="reveal-label">
      <input type="checkbox" v-model="showHiddenBuiltins" />
      <span>显示已隐藏的内置曲目</span>
    </label>
  </div>

  <!-- 批量操作条：选中数一直可见；「全选」写明只作用于当前筛选结果 -->
  <div class="batch-bar" role="group" aria-label="批量操作">
    <label class="batch-all">
      <input
        type="checkbox"
        class="batch-all-box"
        :checked="allFilteredSelected"
        :indeterminate="someFilteredSelected"
        :disabled="filteredTracks.length === 0"
        @click.prevent="toggleSelectAllFiltered"
      />
      <span>全选当前筛选结果（{{ filteredTracks.length }} 首）</span>
    </label>
    <span class="batch-count">已选 {{ selectedCount }} 首</span>
    <select
      v-model="batchPlaylistId"
      class="mini-select"
      aria-label="批量加入的目标播放列表"
      :disabled="audio.playlists.length === 0"
    >
      <option value="">加入播放列表…</option>
      <option v-for="p in audio.playlists" :key="p.id" :value="p.id">{{ p.name }}</option>
    </select>
    <AppButton
      variant="secondary"
      size="sm"
      :disabled="selectedMusicCount === 0 || !batchPlaylistId"
      @click="batchAddToPlaylist"
    >加入</AppButton>
    <AppButton variant="danger" size="sm" :disabled="selectedCount === 0" @click="batchDelete">删除选中</AppButton>
    <span v-if="selectedSfxCount > 0" class="batch-hint">
      其中 {{ selectedSfxCount }} 首音效不能加入播放列表
    </span>
  </div>

  <!-- 曲目列表 -->
  <div v-if="audio.loading" class="empty-tab">正在翻检曲库…</div>
  <div v-else-if="filteredTracks.length === 0" class="empty-tab">
    {{ audio.tracks.length === 0 ? '曲库尚空，上传音频以开始…' : '没有符合条件的曲目…' }}
  </div>
  <div
    v-for="t in filteredTracks"
    :key="t.id"
    class="track-row track-row-lib"
    :class="{ 'track-muted': isHidden(t) || t.missing, 'row-selected': isSelected(t) }"
  >
    <!-- 勾选：撑到 36px 触摸目标；选中态不只靠底色，勾选框本身就是形状指示 -->
    <label class="check-cell">
      <input
        type="checkbox"
        class="row-check"
        :checked="isSelected(t)"
        :aria-label="`选择「${t.name}」`"
        @click.prevent="onRowSelect(t, $event)"
      />
    </label>
    <span
      class="kind-dot"
      :class="`dot-${t.kind}`"
      role="img"
      :aria-label="t.kind === 'sfx' ? '音效' : '音乐'"
    />
    <span class="track-name">{{ t.name }}</span>
    <span v-if="t.missing" class="missing-badge">文件已移除</span>
    <span v-for="tag in t.tags" :key="tag" class="tag-chip">{{ tag }}</span>
    <!-- 提示语做成可见标签 + 视觉隐藏的补充文本；不再只靠 title/aria-label 撑着 -->
    <span class="src-text" :title="sourceHint(t)">{{ sourceLabel(t) }} <span class="sr-only">{{ sourceHint(t) }}</span></span>
    <span class="meta-text">{{ fmtDuration(t.duration) }}</span>
    <span class="meta-text">{{ fmtBytes(t.size) }}</span>
    <button
      class="icon-btn"
      :aria-label="t.missing ? '文件已移除，无法试听' : '试听'"
      :disabled="!!t.missing"
      @click="audition(t)"
    ><i class="fa-solid fa-play" aria-hidden="true" /></button>
    <template v-if="t.builtin">
      <button class="icon-btn" :aria-label="isHidden(t) ? '取消隐藏' : '隐藏内置曲目'" @click="toggleHideBuiltin(t)">
        <i class="fa-solid" :class="isHidden(t) ? 'fa-eye' : 'fa-eye-slash'" aria-hidden="true" />
      </button>
    </template>
    <template v-else>
      <button class="icon-btn" aria-label="编辑曲目" @click="startEdit(t)">
        <i class="fa-solid fa-pen" aria-hidden="true" />
      </button>
      <button class="icon-btn icon-danger" aria-label="删除曲目" @click="removeTrack(t)">
        <i class="fa-solid fa-trash" aria-hidden="true" />
      </button>
    </template>

    <!-- 行内编辑 -->
    <div v-if="editingId === t.id" class="edit-panel">
      <input v-model="editName" class="mini-input" aria-label="曲目名称" placeholder="曲目名称" />
      <input v-model="editTags" class="mini-input" aria-label="标签（逗号分隔）" placeholder="标签，逗号分隔" />
      <select v-model="editKind" class="mini-select" aria-label="曲目类型">
        <option value="music">音乐</option>
        <option value="sfx">音效</option>
      </select>
      <AppButton variant="primary" size="sm" @click="saveEdit(t)">保存</AppButton>
      <AppButton variant="ghost" size="sm" @click="cancelEdit">取消</AppButton>
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

/* ═══ 无障碍：视觉隐藏（保留在无障碍树里） ═══ */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
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

/* ═══ 多选 ═══ */
/* 无过渡与动画，prefers-reduced-motion 下无需额外处理 */
.row-selected {
  background: color-mix(in srgb, var(--theme-primary) 8%, transparent);
}
/* 原生勾选框只有十几像素；套一层 36px 的 label 把触摸目标撑起来 */
.check-cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  cursor: pointer;
}
.row-check,
.batch-all-box {
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: var(--theme-primary);
}
.row-check:focus-visible,
.batch-all-box:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}

/* ═══ 批量操作条（与上传组 / 行内编辑同一副外壳） ═══ */
.batch-bar {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  margin-bottom: var(--theme-spacing-sm);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
}
.batch-all {
  display: inline-flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  cursor: pointer;
}
.batch-count {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  font-variant-numeric: tabular-nums;
}
.batch-hint {
  flex: 1;
  min-width: 10rem;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  line-height: 1.55;
}

/*
 * 隐藏 / 失联的行只压曲名与类型点，**不整行降透明度**。
 * 原来的 `opacity: .55` 把 meta 文字压到约 2.5:1、「文件已移除」徽章压到约 3.2:1 ——
 * 偏偏这些正是用户最需要读清楚的信息（出了什么事、文件多大、来源在哪）。
 */
.track-muted .track-name {
  color: var(--theme-text-muted);
  font-weight: 400;
}
.track-muted .kind-dot {
  opacity: 0.5;
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
/*
 * 徽章/标签的纵向内边距刻意保留 1px 硬编码：间距体系最小档是
 * --theme-spacing-xs(4px)，换上去药丸会明显变胖、把曲目行撑高一档，
 * 与右侧 meta 文字的基线也就对不齐了。横向仍走 token。
 */
.tag-chip {
  font-size: 0.6875rem;
  padding: 1px var(--theme-spacing-sm);
  border-radius: var(--theme-radius-full);
  background: color-mix(in srgb, var(--theme-primary) 12%, transparent);
  color: var(--theme-primary);
}
.meta-text {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 3rem;
  text-align: right;
}
.src-text {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  cursor: help;
}
/* 纵向 1px 同 .tag-chip：这是一枚与标签同高的药丸，不能只把它撑胖 */
.missing-badge {
  font-size: 0.6875rem;
  padding: 1px var(--theme-spacing-sm);
  border-radius: var(--theme-radius-full);
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  color: var(--theme-warning);
}

/* ═══ 曲库工具条 ═══ */
.library-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--theme-spacing-md);
  flex-wrap: wrap;
}
/*
 * 表头里的标题不再另加下边距；并要撑开成弹性项 —— 否则它收缩到文字宽度，
 * `::after` 那条 flex:1 的装饰线就只剩 0 宽，三段里唯独曲库少一条线。
 */
.library-head .band-title {
  flex: 1;
  margin: 0;
}
.usage-text {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.library-note {
  margin: var(--theme-spacing-xs) 0 var(--theme-spacing-md);
}

/* ═══ 条状分组：上传组 / 行内编辑共用同一副外壳（音乐文件夹条同款，见该组件） ═══ */
.lib-upload,
.edit-panel {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
}
.upload-label {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.upload-hint {
  flex: 1;
  min-width: 12rem;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  line-height: 1.55;
}

/* 上传组：输入模式，独立成组，与下方的查看筛选区分开 */
.lib-upload {
  margin-bottom: var(--theme-spacing-sm);
}

.lib-toolbar {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  margin-bottom: var(--theme-spacing-md);
}
.file-input {
  display: none;
}
.mini-input,
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
.mini-input:focus,
.mini-select:focus {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}
.mini-input {
  min-width: 9rem;
  flex: 1;
}
.reveal-label {
  display: inline-flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  cursor: pointer;
}
.edit-panel {
  flex-basis: 100%;
  margin-top: var(--theme-spacing-sm);
}

/* ═══ 按钮 ═══ */
/* 统一的键盘焦点环 —— 这片区域按钮最密，没有焦点提示等于让人闭眼穿行 */
.icon-btn:focus-visible {
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
.icon-btn:hover:not(:disabled) {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.icon-danger:hover:not(:disabled) {
  color: var(--theme-error);
  border-color: color-mix(in srgb, var(--theme-error) 45%, var(--theme-card-border));
}
</style>
