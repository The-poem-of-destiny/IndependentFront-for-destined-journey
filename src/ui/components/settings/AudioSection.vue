<script setup lang="ts">
/**
 * 音频设置分区 — 混音台 / 播放列表 / 曲库
 *
 * 设计: docs/planning/2026-07-26-audio-system-design.md §6.1
 * 三段式布局对齐 BeautifierSection:
 *   ① 混音台 —— 主/音乐/音效 音量与静音 + 传输控制
 *   ② 播放列表 —— 左选择器 / 右曲目排序
 *   ③ 曲库 —— 上传 / 搜索 / 过滤 / 行内编辑；表头显示存储用量
 *
 * 边界: 本组件只调 audio-store 的公开动作，不碰 AudioContext / Dexie。
 * 内置曲目不可改名/改标签/删除（store 拒绝），只能隐藏 —— 隐藏名单存
 * settings.audioHiddenBuiltinIds（对齐 beautifierBuiltinDisabled 先例）。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAudioStore } from '../../stores/audio-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useUIStore } from '../../stores/ui-store'
import type { AudioTrack, AudioTrackKind, AudioRepeatMode } from '@engine/types'
import AppButton from '../shared/AppButton.vue'
import AppCard from '../shared/AppCard.vue'

const audio = useAudioStore()
const cfg = useSettingsStore()
const ui = useUIStore()
const s = cfg.settings

// ===== 生命周期 =====

const storageInfo = ref<{ used: number; quota: number; pct: number } | null>(null)

onMounted(async () => {
  await audio.init()
  await audio.loadLibrary()
  // 进度条只在本分区打开时可见 → 轮询随挂载/卸载起停（引用计数，§6.3）
  audio.startPositionPolling()
  storageInfo.value = await cfg.getStorageUsage()
})

onUnmounted(() => {
  audio.stopPositionPolling()
})

// ===== ① 混音台 =====

type ChannelKey = 'master' | 'music' | 'sfx'

const channels = computed(() => [
  { key: 'master' as ChannelKey, label: '主音量', volume: audio.state.masterVolume, muted: audio.state.masterMuted },
  { key: 'music' as ChannelKey, label: '音乐', volume: audio.state.music.volume, muted: audio.state.music.muted },
  { key: 'sfx' as ChannelKey, label: '音效', volume: audio.state.sfx.volume, muted: audio.state.sfx.muted },
])

function setVolume(key: ChannelKey, raw: string | number): void {
  const v = Math.min(1, Math.max(0, Number(raw) / 100))
  if (key === 'master') audio.setMasterVolume(v)
  else audio.setChannelVolume(key, v)
}

function toggleMute(key: ChannelKey, current: boolean): void {
  if (key === 'master') audio.setMasterMuted(!current)
  else audio.setChannelMuted(key, !current)
}

// ===== 传输 =====

const currentTrack = computed<AudioTrack | undefined>(() => {
  const id = audio.state.music.trackId
  return id ? audio.findTrack(id) : undefined
})

const durationSec = computed(() => audio.state.music.durationSec || currentTrack.value?.duration || 0)

/** 0..1 —— 进度条用 scaleX，绝不过渡 width（design.md §1 禁令） */
const progressRatio = computed(() => {
  const d = durationSec.value
  if (d <= 0) return 0
  return Math.min(1, Math.max(0, audio.positionSec / d))
})

const isPlaying = computed(() => audio.state.music.status === 'playing')

const repeatLabel = computed(() => {
  const map: Record<AudioRepeatMode, string> = { off: '不循环', all: '列表循环', one: '单曲循环' }
  return map[audio.state.music.repeat] ?? '列表循环'
})

function cycleRepeat(): void {
  const order: AudioRepeatMode[] = ['off', 'all', 'one']
  const i = order.indexOf(audio.state.music.repeat)
  audio.setRepeat(order[(i + 1) % order.length])
}

function onSeek(raw: string | number): void {
  audio.seek(Number(raw))
}

// ===== ② 播放列表 =====

const selectedPlaylistId = ref<string>('')

const selectedPlaylist = computed(() =>
  selectedPlaylistId.value ? audio.findPlaylist(selectedPlaylistId.value) : undefined,
)

/** 播放列表是音序器概念 —— 只收 music 曲目（§4.3） */
const musicTracks = computed(() => visibleTracks.value.filter((t) => t.kind === 'music'))

const playlistTracks = computed<AudioTrack[]>(() => {
  const p = selectedPlaylist.value
  if (!p) return []
  return p.trackIds.map((id) => audio.findTrack(id)).filter((t): t is AudioTrack => !!t)
})

const addTrackId = ref<string>('')

async function createPlaylist(): Promise<void> {
  const name = window.prompt('新建播放列表名称', '新播放列表')
  if (!name) return
  const list = await audio.createPlaylist(name.trim())
  selectedPlaylistId.value = list.id
}

async function renameSelectedPlaylist(): Promise<void> {
  const p = selectedPlaylist.value
  if (!p) return
  const name = window.prompt('重命名播放列表', p.name)
  if (!name) return
  await audio.renamePlaylist(p.id, name.trim())
}

async function deleteSelectedPlaylist(): Promise<void> {
  const p = selectedPlaylist.value
  if (!p) return
  if (!window.confirm(`删除播放列表「${p.name}」？曲目本身不会被删除。`)) return
  await audio.deletePlaylist(p.id)
  selectedPlaylistId.value = ''
}

async function addSelectedTrack(): Promise<void> {
  const p = selectedPlaylist.value
  if (!p || !addTrackId.value) return
  await audio.addTrackToPlaylist(p.id, addTrackId.value)
  addTrackId.value = ''
}

async function movePlaylistTrack(index: number, delta: number): Promise<void> {
  const p = selectedPlaylist.value
  if (!p) return
  const ids = [...p.trackIds]
  const to = index + delta
  if (to < 0 || to >= ids.length) return
  const [moved] = ids.splice(index, 1)
  ids.splice(to, 0, moved)
  await audio.reorderPlaylist(p.id, ids)
}

// ===== ③ 曲库 =====

const search = ref('')
const kindFilter = ref<'all' | AudioTrackKind>('all')
const tagFilter = ref('')
const uploadKind = ref<AudioTrackKind>('music')
const showHiddenBuiltins = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const editingId = ref<string>('')
const editName = ref('')
const editTags = ref('')
const editKind = ref<AudioTrackKind>('music')

/** 内置曲目隐藏名单（内置不可删，只能隐藏 —— §2） */
const hiddenBuiltinIds = computed<string[]>(() => s.audioHiddenBuiltinIds ?? [])

function isHidden(t: AudioTrack): boolean {
  return !!t.builtin && hiddenBuiltinIds.value.includes(t.id)
}

/** 隐藏名单过滤后的曲目（供播放列表选曲复用） */
const visibleTracks = computed(() =>
  audio.tracks.filter((t) => showHiddenBuiltins.value || !isHidden(t)),
)

const allTags = computed(() => {
  const set = new Set<string>()
  for (const t of audio.tracks) for (const tag of t.tags ?? []) set.add(tag)
  return [...set].sort()
})

const filteredTracks = computed(() => {
  const q = search.value.trim().toLowerCase()
  return visibleTracks.value.filter((t) => {
    if (kindFilter.value !== 'all' && t.kind !== kindFilter.value) return false
    if (tagFilter.value && !(t.tags ?? []).includes(tagFilter.value)) return false
    if (q && !t.name.toLowerCase().includes(q)) return false
    return true
  })
})

function toggleHideBuiltin(t: AudioTrack): void {
  const list = [...hiddenBuiltinIds.value]
  const i = list.indexOf(t.id)
  if (i >= 0) list.splice(i, 1)
  else list.push(t.id)
  s.audioHiddenBuiltinIds = list
}

function pickFiles(): void {
  fileInput.value?.click()
}

// ===== ③-A 音乐文件夹（addendum §UI changes） =====

/** 已收录在曲库里的「磁盘文件」曲目数（含暂时失联的） */
const fileTrackCount = computed(() => audio.tracks.filter((t) => t.source === 'file').length)

/**
 * 选择文件夹。用户取消时 store 静默返回 false（不是错误，不弹 toast）；
 * 但 picker 的其他异常会往外抛，这里兜住并提示，避免炸到组件外。
 */
async function chooseFolder(): Promise<void> {
  try {
    await audio.pickFolder()
  } catch {
    ui.toast('无法打开文件夹选择器，请检查浏览器权限设置。', 'error')
  }
}

async function grantFolder(): Promise<void> {
  try {
    const ok = await audio.grantFolderPermission()
    if (!ok) ui.toast('浏览器拒绝了音乐文件夹的访问授权。', 'warning')
  } catch {
    ui.toast('申请文件夹访问授权失败。', 'error')
  }
}

async function rescanFolder(): Promise<void> {
  try {
    await audio.rescanFolder()
  } catch {
    ui.toast('扫描音乐文件夹失败。', 'error')
  }
}

/** 取消关联只丢句柄；曲目行与播放列表位次都留着（addendum §forgetFolder） */
async function forgetFolder(): Promise<void> {
  const name = audio.folderName || '音乐文件夹'
  if (!window.confirm(
    `取消关联「${name}」？曲库记录与播放列表位次都会保留，重新选回同一个文件夹即可恢复播放。`,
  )) return
  try {
    await audio.forgetFolder()
  } catch {
    ui.toast('取消关联失败。', 'error')
  }
}

/** 曲目字节来源的低调标注（不是徽章，只是一行 meta 文字） */
function sourceLabel(t: AudioTrack): string {
  if (t.source === 'file') return '磁盘'
  if (t.source === 'builtin') return '内置'
  return '浏览器'
}

function sourceHint(t: AudioTrack): string {
  if (t.source === 'file') return '从音乐文件夹读取'
  if (t.source === 'builtin') return '随应用附带'
  return '存放在浏览器存储中'
}

/** 上传超过 20MB 给一次软确认（§3.5），不做任何自动清理 */
const SOFT_LIMIT_BYTES = 20 * 1024 * 1024

async function onFilesPicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length === 0) return
  const total = files.reduce((n, f) => n + f.size, 0)
  if (total > SOFT_LIMIT_BYTES && !window.confirm(
    `本次上传约 ${fmtBytes(total)}，会占用浏览器存储配额（与存档共用）。继续吗？`,
  )) return
  await audio.uploadFiles(files, uploadKind.value)
  storageInfo.value = await cfg.getStorageUsage()
}

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
  if (name && name !== t.name) await audio.renameTrack(t.id, name)
  const tags = editTags.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
  await audio.setTrackTags(t.id, tags)
  if (editKind.value !== t.kind) await audio.setTrackKind(t.id, editKind.value)
  editingId.value = ''
}

async function removeTrack(t: AudioTrack): Promise<void> {
  const msg = t.source === 'file'
    ? `删除曲目「${t.name}」？只移除曲库记录，磁盘上的文件不会被删除。`
    : `删除曲目「${t.name}」？此操作不可撤销。`
  if (!window.confirm(msg)) return
  await audio.deleteTrack(t.id)
  storageInfo.value = await cfg.getStorageUsage()
}

async function audition(t: AudioTrack): Promise<void> {
  if (t.missing) return
  if (t.kind === 'sfx') await audio.playSfx(t.id)
  else await audio.playTrack(t.id)
}

// ===== 格式化 =====

function fmtBytes(n?: number): string {
  if (!n || n <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function fmtDuration(sec?: number): string {
  if (!sec || sec <= 0 || !Number.isFinite(sec)) return '—'
  const m = Math.floor(sec / 60)
  const rest = Math.floor(sec % 60)
  return `${m}:${String(rest).padStart(2, '0')}`
}
</script>

<template>
  <section class="section centered audio-section">
    <h3>音频</h3>
    <p class="section-desc">
      管理背景音乐与音效。曲库为全局资源，所有存档共用，不随存档导入导出。
    </p>

    <!-- ═══ ① 混音台 ═══ -->
    <AppCard padding="md" class="audio-card" style="margin-top: 16px">
      <h4 class="band-title">混音台</h4>

      <div v-for="ch in channels" :key="ch.key" class="mix-row">
        <span class="mix-label">{{ ch.label }}</span>
        <button
          class="icon-btn"
          :class="{ 'icon-btn-off': ch.muted }"
          :aria-label="ch.muted ? `取消静音：${ch.label}` : `静音：${ch.label}`"
          :aria-pressed="ch.muted"
          @click="toggleMute(ch.key, ch.muted)"
        >{{ ch.muted ? '🔇' : '🔊' }}</button>
        <div class="slider" :class="{ 'slider-off': ch.muted }">
          <div class="slider-track">
            <div class="slider-fill" :style="{ transform: `scaleX(${ch.volume})` }" />
          </div>
          <input
            class="slider-input"
            type="range"
            min="0"
            max="100"
            step="1"
            :value="Math.round(ch.volume * 100)"
            :aria-label="`${ch.label}音量`"
            @input="setVolume(ch.key, ($event.target as HTMLInputElement).value)"
          />
        </div>
        <span class="mix-value">{{ Math.round(ch.volume * 100) }}</span>
      </div>

      <!-- 传输 -->
      <div class="transport">
        <div class="transport-title">
          {{ currentTrack ? currentTrack.name : '未在播放' }}
        </div>
        <div class="slider progress" >
          <div class="slider-track">
            <div class="slider-fill" :style="{ transform: `scaleX(${progressRatio})` }" />
          </div>
          <input
            class="slider-input"
            type="range"
            min="0"
            :max="Math.max(1, Math.floor(durationSec))"
            step="1"
            :value="Math.floor(audio.positionSec)"
            :disabled="durationSec <= 0"
            aria-label="播放进度"
            @input="onSeek(($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="transport-row">
          <span class="time-text">{{ fmtDuration(audio.positionSec) }} / {{ fmtDuration(durationSec) }}</span>
          <div class="transport-btns">
            <button class="icon-btn" aria-label="上一曲" @click="audio.prev()">⏮</button>
            <button class="icon-btn" :aria-label="isPlaying ? '暂停' : '播放'" @click="audio.toggle()">
              {{ isPlaying ? '⏸' : '▶' }}
            </button>
            <button class="icon-btn" aria-label="下一曲" @click="audio.next()">⏭</button>
            <button
              class="chip-btn"
              :class="{ 'chip-on': audio.state.music.repeat !== 'off' }"
              :aria-label="`循环模式：${repeatLabel}`"
              @click="cycleRepeat()"
            >🔁 {{ repeatLabel }}</button>
            <button
              class="chip-btn"
              :class="{ 'chip-on': audio.state.music.shuffle }"
              :aria-pressed="audio.state.music.shuffle"
              aria-label="随机播放"
              @click="audio.setShuffle(!audio.state.music.shuffle)"
            >🔀 随机</button>
          </div>
        </div>
        <p v-if="!audio.state.unlocked" class="hint-text">浏览器需要一次点击才能开始播放。</p>
      </div>
    </AppCard>

    <!-- ═══ ② 播放列表 ═══ -->
    <AppCard padding="md" class="audio-card" style="margin-top: 12px">
      <h4 class="band-title">播放列表</h4>

      <div class="playlist-grid">
        <!-- 选择器 -->
        <div class="playlist-picker">
          <div class="picker-actions">
            <AppButton variant="primary" size="sm" @click="createPlaylist">＋ 新建</AppButton>
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
              <AppButton variant="secondary" size="sm" :disabled="playlistTracks.length === 0" @click="audio.playPlaylist(selectedPlaylist.id, 0)">▶ 播放</AppButton>
            </div>
            <div v-if="playlistTracks.length === 0" class="empty-tab">此列表尚无曲目…</div>
            <div v-for="(t, i) in playlistTracks" :key="t.id + '_' + i" class="track-row">
              <span class="kind-dot" :class="`dot-${t.kind}`" />
              <span class="track-name">{{ t.name }}</span>
              <button class="icon-btn" aria-label="上移" :disabled="i === 0" @click="movePlaylistTrack(i, -1)">▲</button>
              <button class="icon-btn" aria-label="下移" :disabled="i === playlistTracks.length - 1" @click="movePlaylistTrack(i, 1)">▼</button>
              <button class="icon-btn icon-danger" aria-label="移出列表" @click="audio.removeTrackFromPlaylist(selectedPlaylist!.id, t.id)">✕</button>
            </div>
          </template>
          <div v-else class="empty-tab">先在左侧选择一个播放列表…</div>
        </div>
      </div>
    </AppCard>

    <!-- ═══ ③ 曲库 ═══ -->
    <AppCard padding="md" class="audio-card" style="margin-top: 12px">
      <div class="library-head">
        <h4 class="band-title" style="margin:0">曲库</h4>
        <span v-if="storageInfo" class="usage-text">
          浏览器存储 {{ fmtBytes(storageInfo.used) }} / {{ fmtBytes(storageInfo.quota) }}
          （{{ storageInfo.pct.toFixed(1) }}%）
        </span>
      </div>
      <p class="text-muted text-sm" style="margin: 4px 0 12px">
        音频与存档共用同一份浏览器配额；「清除所有数据」会一并删除曲库。
      </p>

      <!-- 音乐文件夹 -->
      <div class="folder-strip" :class="{ 'folder-strip-on': audio.folderPermission === 'granted' }">
        <template v-if="audio.folderPermission === 'unsupported'">
          <span class="folder-name">音乐文件夹</span>
          <span class="folder-note">
            当前浏览器不支持 File System Access，无法直接读取本地文件夹；上传的音频会存进浏览器存储。
          </span>
        </template>

        <template v-else-if="audio.folderPermission === 'none'">
          <span class="folder-name">音乐文件夹</span>
          <span class="folder-note">指定一个文件夹，音频留在原处，曲库只记录目录。</span>
          <AppButton variant="secondary" size="sm" @click="chooseFolder">选择音乐文件夹</AppButton>
        </template>

        <template v-else-if="audio.folderPermission === 'prompt'">
          <span class="folder-name">{{ audio.folderName || '音乐文件夹' }}</span>
          <span class="folder-note">浏览器每次启动后需要重新确认一次访问权限。</span>
          <AppButton variant="primary" size="sm" @click="grantFolder">授权访问音乐文件夹</AppButton>
        </template>

        <template v-else-if="audio.folderPermission === 'granted'">
          <span class="folder-name">{{ audio.folderName || '音乐文件夹' }}</span>
          <span class="folder-note">已收录 {{ fileTrackCount }} 首本地曲目。</span>
          <AppButton variant="secondary" size="sm" :disabled="audio.scanning" @click="rescanFolder">
            {{ audio.scanning ? '扫描中…' : '重新扫描' }}
          </AppButton>
          <AppButton variant="ghost" size="sm" @click="forgetFolder">取消关联</AppButton>
        </template>

        <template v-else>
          <span class="folder-name">{{ audio.folderName || '音乐文件夹' }}</span>
          <span class="folder-note">浏览器拒绝了访问该文件夹，本地曲目暂时无法播放。</span>
          <AppButton variant="secondary" size="sm" @click="grantFolder">重新授权</AppButton>
        </template>
      </div>

      <!-- 工具条 -->
      <div class="lib-toolbar">
        <select v-model="uploadKind" class="mini-select" aria-label="上传类型">
          <option value="music">音乐</option>
          <option value="sfx">音效</option>
        </select>
        <AppButton variant="primary" size="sm" @click="pickFiles">＋ 上传音频</AppButton>
        <input
          ref="fileInput"
          class="file-input"
          type="file"
          accept="audio/*"
          multiple
          aria-label="选择音频文件"
          @change="onFilesPicked"
        />
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

      <!-- 曲目列表 -->
      <div v-if="audio.loading" class="empty-tab">正在翻检曲库…</div>
      <div v-else-if="filteredTracks.length === 0" class="empty-tab">
        {{ audio.tracks.length === 0 ? '曲库尚空，上传音频以开始…' : '没有符合条件的曲目…' }}
      </div>
      <div
        v-for="t in filteredTracks"
        :key="t.id"
        class="track-row track-row-lib"
        :class="{ 'track-muted': isHidden(t) || t.missing }"
      >
        <span class="kind-dot" :class="`dot-${t.kind}`" />
        <span class="track-name">{{ t.name }}</span>
        <span v-if="t.missing" class="missing-badge">文件已移除</span>
        <span v-for="tag in t.tags" :key="tag" class="tag-chip">{{ tag }}</span>
        <span class="src-text" :title="sourceHint(t)" :aria-label="sourceHint(t)">{{ sourceLabel(t) }}</span>
        <span class="meta-text">{{ fmtDuration(t.duration) }}</span>
        <span class="meta-text">{{ fmtBytes(t.size) }}</span>
        <button
          class="icon-btn"
          :aria-label="t.missing ? '文件已移除，无法试听' : '试听'"
          :disabled="!!t.missing"
          @click="audition(t)"
        >▶</button>
        <template v-if="t.builtin">
          <button class="icon-btn" :aria-label="isHidden(t) ? '取消隐藏' : '隐藏内置曲目'" @click="toggleHideBuiltin(t)">
            {{ isHidden(t) ? '👁' : '🚫' }}
          </button>
        </template>
        <template v-else>
          <button class="icon-btn" aria-label="编辑曲目" @click="startEdit(t)">✎</button>
          <button class="icon-btn icon-danger" aria-label="删除曲目" @click="removeTrack(t)">🗑</button>
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
    </AppCard>
  </section>
</template>

<style scoped>
.audio-section > h3 {
  font-family: var(--theme-font-title);
  font-size: 1.4rem;
  color: var(--theme-text-primary);
  margin: 0 0 var(--theme-spacing-xs);
}
.section-desc {
  margin: 0 0 var(--theme-spacing-xl);
  padding-bottom: var(--theme-spacing-md);
  font-size: 0.85rem;
  color: var(--theme-text-muted);
  border-bottom: 1px solid var(--theme-card-border);
}
.audio-card {
  box-shadow: var(--paper-stack);
}

/* ═══ 分段标题 + 装饰线 ═══ */
.band-title {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 0.95rem;
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

/* ═══ 混音台 ═══ */
.mix-row {
  display: grid;
  grid-template-columns: 4rem 36px minmax(0, 1fr) 2.2rem;
  align-items: center;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-xs) 0;
}
.mix-label {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
}
.mix-value {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* ═══ 滑块（手搓轨/填充，对齐 ResourceBar；交互层是透明 range） ═══ */
.slider {
  position: relative;
  height: 24px;
  display: flex;
  align-items: center;
}
.slider-track {
  position: absolute;
  left: 0;
  right: 0;
  height: 6px;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-full);
  overflow: hidden;
}
.slider-fill {
  height: 100%;
  width: 100%;
  background: var(--theme-primary);
  border-radius: var(--theme-radius-full);
  transform-origin: left center;
  transition: transform var(--theme-transition-fast);
}
.slider-input {
  position: relative;
  width: 100%;
  height: 24px;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.slider-input:disabled {
  cursor: default;
}
.slider-off .slider-fill {
  background: var(--theme-text-muted);
}
.slider-input:focus-visible + .slider-track,
.slider:focus-within .slider-track {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 30%, transparent);
}

/* ═══ 传输 ═══ */
.transport {
  margin-top: var(--theme-spacing-md);
  padding-top: var(--theme-spacing-md);
  border-top: 1px solid var(--theme-card-border);
}
.transport-title {
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  color: var(--theme-text-primary);
  margin-bottom: var(--theme-spacing-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.transport-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  margin-top: var(--theme-spacing-xs);
  flex-wrap: wrap;
}
.transport-btns {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  flex-wrap: wrap;
}
.time-text {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
}
.hint-text {
  margin: var(--theme-spacing-sm) 0 0;
  font-size: 0.75rem;
  font-style: italic;
  color: var(--theme-text-muted);
}

/* ═══ 按钮 ═══ */
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
.icon-btn:hover:not(:disabled) {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.icon-btn-off {
  color: var(--theme-text-muted);
}
.icon-danger:hover:not(:disabled) {
  color: var(--theme-error);
  border-color: color-mix(in srgb, var(--theme-error) 45%, var(--theme-card-border));
}
.chip-btn {
  height: 36px;
  padding: 0 var(--theme-spacing-md);
  background: transparent;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-full);
  color: var(--theme-text-secondary);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  transition: background var(--theme-transition-fast), color var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.chip-btn:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.chip-on {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-primary);
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
.track-muted {
  opacity: 0.55;
}
.kind-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot-music { background: var(--theme-primary); }
.dot-sfx { background: var(--theme-success); }
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
.tag-chip {
  font-size: 0.6875rem;
  padding: 1px 8px;
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

/* ═══ 曲库工具条 ═══ */
.library-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--theme-spacing-md);
  flex-wrap: wrap;
}
.usage-text {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
/* ═══ 音乐文件夹条 ═══ */
.folder-strip {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  margin-bottom: var(--theme-spacing-md);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  transition: background var(--theme-transition-fast), border-color var(--theme-transition-fast);
}
.folder-strip-on {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.folder-name {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.folder-note {
  flex: 1;
  min-width: 12rem;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  line-height: 1.55;
}
.src-text {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  cursor: help;
}
.missing-badge {
  font-size: 0.6875rem;
  padding: 1px 8px;
  border-radius: var(--theme-radius-full);
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  color: var(--theme-warning);
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
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 15%, transparent);
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
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  margin-top: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
}
</style>
