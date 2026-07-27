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
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useAudioStore } from '../../stores/audio-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useUIStore } from '../../stores/ui-store'
import type { AudioTrack, AudioTrackKind, AudioRepeatMode } from '@engine/types'
import AppButton from '../shared/AppButton.vue'
import AppCard from '../shared/AppCard.vue'
import AppModal from '../shared/AppModal.vue'

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
  // 卸载时把悬着的 Promise 收干净，避免调用方永远 await 不到
  closeConfirm(false)
  closePrompt(null)
  clearSeekSettle() // 别让安定计时器烧到已拆掉的组件上
  audio.stopPositionPolling()
})

// ===== 确认 / 输入 弹窗（取代 window.confirm / window.prompt） =====
// 只在本组件内做，不引入全局服务；一次只有一个弹窗在场。

const confirmDialog = ref({ open: false, title: '', message: '', confirmLabel: '确认', danger: false })
let confirmResolve: ((ok: boolean) => void) | null = null

function askConfirm(
  opts: { title: string; message: string; confirmLabel?: string; danger?: boolean },
): Promise<boolean> {
  closeConfirm(false) // 保险：清掉任何残留的上一轮
  return new Promise<boolean>((resolve) => {
    confirmResolve = resolve
    confirmDialog.value = {
      open: true,
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? '确认',
      danger: opts.danger ?? false,
    }
  })
}

/** 唯一出口 —— 取消 / Esc / 遮罩 / 确认 都走这里，保证 resolve 只兑现一次 */
function closeConfirm(ok: boolean): void {
  const resolve = confirmResolve
  confirmResolve = null
  confirmDialog.value.open = false
  resolve?.(ok)
}

const promptDialog = ref({ open: false, title: '', label: '', value: '' })
const promptInput = ref<HTMLInputElement | null>(null)
let promptResolve: ((value: string | null) => void) | null = null

/** 解析为 trim 后的非空字符串；取消返回 null（对齐 window.prompt 的语义） */
function askPrompt(opts: { title: string; label: string; value: string }): Promise<string | null> {
  closePrompt(null)
  return new Promise<string | null>((resolve) => {
    promptResolve = resolve
    promptDialog.value = { open: true, title: opts.title, label: opts.label, value: opts.value }
    void nextTick(() => {
      promptInput.value?.focus()
      promptInput.value?.select()
    })
  })
}

function closePrompt(value: string | null): void {
  const resolve = promptResolve
  promptResolve = null
  promptDialog.value.open = false
  resolve?.(value)
}

const promptValid = computed(() => promptDialog.value.value.trim().length > 0)

function submitPrompt(): void {
  if (!promptValid.value) return
  closePrompt(promptDialog.value.value.trim())
}

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

// ── 进度滑块：提交式 seek ────────────────────────────────
// store 以 ~4Hz 轮询回写 positionSec。若滑块直接绑定它，拖动时轮询会把把手
// 从手里抢回去（每 250ms 跳一次）。所以拖动期间显示值走本地草稿，只有 change
// （松手 / 方向键 / Home-End）才真的 seek。音量滑块不受影响 —— 那里需要
// input 的连续反馈。
//
// 冻结范围刻意收得很窄：**只在真的有交互时**冻结。单纯把焦点停在进度条上
// 不冻结任何东西 —— 否则用户 Tab 过来听歌，进度条和时钟就一起僵住，界面
// 等于在撒谎。提交后再压一个极短的安定窗口，挡掉那一两拍还在路上的陈旧
// 轮询值，随后无论焦点在哪都放开跟随真实播放位置。

/** 提交后的安定窗口(ms)：够盖住 1-2 拍 250ms 轮询，短到用户察觉不到 */
const SEEK_SETTLE_MS = 500

const seekDragging = ref(false)
const seekSettling = ref(false)
const seekDraft = ref(0)

let seekSettleTimer: ReturnType<typeof setTimeout> | null = null

function clearSeekSettle(): void {
  if (seekSettleTimer !== null) {
    clearTimeout(seekSettleTimer)
    seekSettleTimer = null
  }
  seekSettling.value = false
}

/** 用户正在操纵进度条（或刚松手） → 冻结轮询对显示值的写入 */
const seekHeld = computed(() => seekDragging.value || seekSettling.value)

/** 进度条把手与时间文字共用的显示值，保证两者永远一致 */
const displayPositionSec = computed(() => (seekHeld.value ? seekDraft.value : audio.positionSec))

/** 拖动过程中只更新草稿，不真的 seek */
function onSeekInput(raw: string | number): void {
  clearSeekSettle() // 新交互作废上一次的安定窗口
  seekDragging.value = true
  seekDraft.value = Number(raw)
}

/** 提交才 seek —— 松手、方向键、Home/End 都会触发 change */
function onSeekCommit(raw: string | number): void {
  const sec = Number(raw)
  clearSeekSettle()
  seekDraft.value = sec
  seekDragging.value = false
  audio.seek(sec)
  seekSettling.value = true
  seekSettleTimer = setTimeout(() => {
    seekSettleTimer = null
    seekSettling.value = false
  }, SEEK_SETTLE_MS)
}

/** 松手时值没变则不会有 change —— 兜住这条路径，别把冻结态留在原地 */
function onSeekPointerUp(): void {
  if (!seekDragging.value) return
  seekDragging.value = false
  clearSeekSettle()
}

/** 0..1 —— 进度条用 scaleX，绝不过渡 width（design.md §1 禁令） */
const progressRatio = computed(() => {
  const d = durationSec.value
  if (d <= 0) return 0
  return Math.min(1, Math.max(0, displayPositionSec.value / d))
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

// ===== 状态播报（唯一 aria-live 区域） =====
// 只播报离散的、用户会关心的转变：播放/暂停、曲库与文件夹的忙碌态、上传结果。
// 绝不播报进度或音量这类连续值 —— 那会把屏幕阅读器淹掉。

const liveMessage = ref('')

watch(
  () => [isPlaying.value, currentTrack.value?.name] as const,
  ([playing, name]) => {
    liveMessage.value = name ? `${playing ? '正在播放' : '已暂停'}：${name}` : ''
  },
)

// 忙碌态结束必须改写这行字：留着「正在扫描…」既是骗人，也会让下一次扫描
// 因为字符串没变而彻底不播报。有结果的报结果（沿用文件夹条的措辞），没有的清空。
watch(() => audio.scanning, (on) => {
  liveMessage.value = on ? '正在扫描音乐文件夹…' : `已收录 ${fileTrackCount.value} 首本地曲目。`
})
watch(() => audio.loading, (on) => {
  liveMessage.value = on ? '正在翻检曲库…' : ''
})

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

/**
 * 手工命名撞名时 store 拒绝写入。这里不把用户刚打的字丢掉 —— 说清是哪个名字
 * 被占了，然后带着原文重新弹出输入框，让人改一个字就能继续。取消才退出。
 */
async function createPlaylist(): Promise<void> {
  let draft = '新播放列表'
  for (;;) {
    const name = await askPrompt({ title: '新建播放列表', label: '新建播放列表名称', value: draft })
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
    const name = await askPrompt({ title: '重命名播放列表', label: '播放列表名称', value: draft })
    if (!name) return
    if (await audio.renamePlaylist(p.id, name)) return
    draft = name
    ui.toast(`已有名为「${name}」的播放列表，请换一个名字。`, 'error')
  }
}

async function deleteSelectedPlaylist(): Promise<void> {
  const p = selectedPlaylist.value
  if (!p) return
  const ok = await askConfirm({
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
  const ok = await askConfirm({
    title: '取消关联音乐文件夹',
    message: `取消关联「${name}」？曲库记录与播放列表位次都会保留，重新选回同一个文件夹即可恢复播放。`,
    confirmLabel: '取消关联',
    danger: true,
  })
  if (!ok) return
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
  // 软确认要拿新鲜的配额说话 —— 缓存值可能是几分钟前的
  if (total > SOFT_LIMIT_BYTES) {
    storageInfo.value = await cfg.getStorageUsage()
    const ok = await askConfirm({
      title: '上传音频',
      message: `本次上传约 ${fmtBytes(total)}，会占用浏览器存储配额（与存档共用）。继续吗？`,
      confirmLabel: '继续上传',
    })
    if (!ok) return
  }
  try {
    const created = await audio.uploadFiles(files, uploadKind.value)
    ui.toast(`已添加 ${created.length} 个音频`, 'success')
    liveMessage.value = `已添加 ${created.length} 个音频`
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
  const ok = await askConfirm({ title: '删除曲目', message: msg, confirmLabel: '删除', danger: true })
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

    <!-- 唯一状态播报区：播放/暂停、扫描、上传结果。视觉隐藏，只给辅助技术 -->
    <p class="sr-only" role="status" aria-live="polite">{{ liveMessage }}</p>

    <!-- ═══ ① 混音台 ═══ -->
    <AppCard padding="md" class="audio-card">
      <h4 class="band-title">混音台</h4>

      <div v-for="ch in channels" :key="ch.key" class="mix-row">
        <span class="mix-label">{{ ch.label }}</span>
        <button
          class="icon-btn"
          :class="{ 'icon-btn-off': ch.muted }"
          :aria-label="ch.muted ? `取消静音：${ch.label}` : `静音：${ch.label}`"
          :aria-pressed="ch.muted"
          @click="toggleMute(ch.key, ch.muted)"
        ><i class="fa-solid" :class="ch.muted ? 'fa-volume-xmark' : 'fa-volume-high'" aria-hidden="true" /></button>
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
            :aria-valuetext="`${Math.round(ch.volume * 100)}%`"
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
        <div class="slider progress">
          <div class="slider-track">
            <div class="slider-fill" :style="{ transform: `scaleX(${progressRatio})` }" />
          </div>
          <input
            class="slider-input"
            type="range"
            min="0"
            :max="Math.max(1, Math.floor(durationSec))"
            step="1"
            :value="Math.floor(displayPositionSec)"
            :disabled="durationSec <= 0"
            aria-label="播放进度"
            :aria-valuetext="`${fmtDuration(displayPositionSec)} / ${fmtDuration(durationSec)}`"
            @input="onSeekInput(($event.target as HTMLInputElement).value)"
            @change="onSeekCommit(($event.target as HTMLInputElement).value)"
            @pointerup="onSeekPointerUp"
            @pointercancel="onSeekPointerUp"
          />
        </div>
        <div class="transport-row">
          <span class="time-text">{{ fmtDuration(displayPositionSec) }} / {{ fmtDuration(durationSec) }}</span>
          <div class="transport-btns">
            <button class="icon-btn" aria-label="上一曲" @click="audio.prev()">
              <i class="fa-solid fa-backward-step" aria-hidden="true" />
            </button>
            <button class="icon-btn" :aria-label="isPlaying ? '暂停' : '播放'" @click="audio.toggle()">
              <i class="fa-solid" :class="isPlaying ? 'fa-pause' : 'fa-play'" aria-hidden="true" />
            </button>
            <button class="icon-btn" aria-label="下一曲" @click="audio.next()">
              <i class="fa-solid fa-forward-step" aria-hidden="true" />
            </button>
            <button
              class="chip-btn"
              :class="{ 'chip-on': audio.state.music.repeat !== 'off' }"
              :aria-label="`循环模式：${repeatLabel}`"
              @click="cycleRepeat()"
            ><i class="fa-solid fa-repeat" aria-hidden="true" /> {{ repeatLabel }}</button>
            <button
              class="chip-btn"
              :class="{ 'chip-on': audio.state.music.shuffle }"
              :aria-pressed="audio.state.music.shuffle"
              aria-label="随机播放"
              @click="audio.setShuffle(!audio.state.music.shuffle)"
            ><i class="fa-solid fa-shuffle" aria-hidden="true" /> 随机</button>
          </div>
        </div>
        <p v-if="!audio.state.unlocked" class="hint-text">浏览器需要一次点击才能开始播放。</p>
      </div>
    </AppCard>

    <!-- ═══ ② 播放列表 ═══ -->
    <AppCard padding="md" class="audio-card">
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
            <div v-for="(t, i) in playlistTracks" :key="t.id + '_' + i" class="track-row">
              <span
                class="kind-dot"
                :class="`dot-${t.kind}`"
                role="img"
                :aria-label="t.kind === 'sfx' ? '音效' : '音乐'"
              />
              <span class="track-name">{{ t.name }}</span>
              <button class="icon-btn" aria-label="上移" :disabled="i === 0" @click="movePlaylistTrack(i, -1)">
                <i class="fa-solid fa-chevron-up" aria-hidden="true" />
              </button>
              <button class="icon-btn" aria-label="下移" :disabled="i === playlistTracks.length - 1" @click="movePlaylistTrack(i, 1)">
                <i class="fa-solid fa-chevron-down" aria-hidden="true" />
              </button>
              <button class="icon-btn icon-danger" aria-label="移出列表" @click="audio.removeTrackFromPlaylist(selectedPlaylist!.id, t.id)">
                <i class="fa-solid fa-xmark" aria-hidden="true" />
              </button>
            </div>
          </template>
          <div v-else class="empty-tab">先在左侧选择一个播放列表…</div>
        </div>
      </div>
    </AppCard>

    <!-- ═══ ③ 曲库 ═══ -->
    <AppCard padding="md" class="audio-card">
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
    </AppCard>

    <!-- ═══ 确认弹窗（取代 window.confirm） ═══ -->
    <AppModal
      :open="confirmDialog.open"
      :title="confirmDialog.title"
      size="sm"
      @update:open="closeConfirm(false)"
    >
      <p class="dialog-text">{{ confirmDialog.message }}</p>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="closeConfirm(false)">取消</AppButton>
        <AppButton
          :variant="confirmDialog.danger ? 'danger' : 'primary'"
          size="sm"
          @click="closeConfirm(true)"
        >{{ confirmDialog.confirmLabel }}</AppButton>
      </template>
    </AppModal>

    <!-- ═══ 输入弹窗（取代 window.prompt） ═══ -->
    <AppModal
      :open="promptDialog.open"
      :title="promptDialog.title"
      size="sm"
      @update:open="closePrompt(null)"
    >
      <label class="dialog-label">
        {{ promptDialog.label }}
        <input
          ref="promptInput"
          v-model="promptDialog.value"
          class="mini-input dialog-input"
          type="text"
          @keydown.enter.prevent="submitPrompt"
        />
      </label>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="closePrompt(null)">取消</AppButton>
        <AppButton variant="primary" size="sm" :disabled="!promptValid" @click="submitPrompt">确定</AppButton>
      </template>
    </AppModal>
  </section>
</template>

<style scoped>
/*
 * 分区标题 / 描述：值与 SettingsPage 的 `.section>h3` / `.section-desc` 一致
 * （1.4rem 落在 design.md §排版「设置页 section h3 = 1.3-1.4rem」区间内）。
 * 不能删掉靠继承 —— SettingsPage 的样式是 scoped 的，只能命中本组件的根节点，
 * 命不到根节点里面的 h3/p，删了这里标题就退回浏览器默认样式了。
 */
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
  margin-top: var(--theme-spacing-lg);
  box-shadow: var(--paper-stack);
}
/* 三段之间比首段与分区描述之间收一档，让三张卡读起来是一组 */
.audio-card + .audio-card {
  margin-top: var(--theme-spacing-md);
}

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

/* ═══ 滑块（手搓轨/填充，对齐 ResourceBar；交互层是原生 range） ═══
 * 视觉轨保持 6px 的纤细感，但交互层撑到 36px 命中区（design.md §8 触摸目标）。
 * range 自身只保留把手可见 —— 轨道与进度都交给下面的 .slider-track/.slider-fill。 */
.slider {
  position: relative;
  height: 36px;
  display: flex;
  align-items: center;
}
.slider-track {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(50% - 3px);
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
  height: 36px;
  margin: 0;
  background: transparent;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
}
.slider-input:disabled {
  cursor: default;
}

/* 原生轨道让位给手搓轨；把手是 range 唯一可见的部分 */
.slider-input::-webkit-slider-runnable-track {
  height: 36px;
  background: transparent;
  border: none;
}
.slider-input::-moz-range-track {
  height: 36px;
  background: transparent;
  border: none;
}
.slider-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  /* webkit 把手相对 runnable-track 顶部定位，手动居中：(36 - 16) / 2 */
  margin-top: 10px;
  border-radius: 50%;
  background: var(--theme-primary);
  border: 2px solid var(--theme-card-bg);
  box-shadow: var(--theme-shadow-sm);
  cursor: pointer;
}
.slider-input::-moz-range-thumb {
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--theme-primary);
  border: 2px solid var(--theme-card-bg);
  box-shadow: var(--theme-shadow-sm);
  cursor: pointer;
}
/* 三条各写各的 —— 选择器列表里混入厂商伪元素会让整条规则被另一引擎整体丢弃 */
.slider-off .slider-fill {
  background: var(--theme-text-muted);
}
.slider-off .slider-input::-webkit-slider-thumb {
  background: var(--theme-text-muted);
}
.slider-off .slider-input::-moz-range-thumb {
  background: var(--theme-text-muted);
}
/* 没有时长时进度条无意义 —— 把手收起来，不给假的可拖动暗示 */
.slider-input:disabled::-webkit-slider-thumb {
  opacity: 0;
}
.slider-input:disabled::-moz-range-thumb {
  opacity: 0;
}

/* 悬停：轨道一圈中性描边（轻） */
.slider:hover .slider-track {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-text-muted) 45%, transparent);
}
/*
 * 键盘焦点：轨道加粗成主色环 + 把手外扩光晕，与 hover / 鼠标按下明显区分。
 * 旧写法 `.slider-input:focus-visible + .slider-track` 永远不可能命中 ——
 * `.slider-track` 是 range 的**前**一个兄弟，`+` 只能往后选；退守的
 * `:focus-within` 又会在鼠标按下时误触发。改用外层 `:has()` 一次解决。
 */
.slider:has(.slider-input:focus-visible) .slider-track {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}
.slider-input:focus {
  outline: none;
}
.slider-input:focus-visible::-webkit-slider-thumb {
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}
.slider-input:focus-visible::-moz-range-thumb {
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-primary) 40%, transparent);
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

/* ═══ 按钮 ═══ */
/* 统一的键盘焦点环 —— 这片区域按钮最密，没有焦点提示等于让人闭眼穿行 */
.icon-btn:focus-visible,
.chip-btn:focus-visible,
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
.chip-btn i {
  font-size: 0.8125rem;
  line-height: 1;
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
/* ═══ 条状分组：音乐文件夹 / 上传组 / 行内编辑共用同一副外壳 ═══ */
.folder-strip,
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
.folder-strip {
  margin-bottom: var(--theme-spacing-md);
  transition: background var(--theme-transition-fast), border-color var(--theme-transition-fast);
}
.folder-strip-on {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
/* 文件夹条与上传组是同一种「条」，标题与说明共用一套排版 */
.folder-name,
.upload-label {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.folder-note,
.upload-hint {
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

/* ═══ 确认 / 输入弹窗 ═══ */
.dialog-text {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--theme-text-secondary);
  /* 删除曲目的第二句用 \n 换行，保留原文的断句 */
  white-space: pre-line;
}
.dialog-label {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
}
.dialog-input {
  width: 100%;
}
</style>
