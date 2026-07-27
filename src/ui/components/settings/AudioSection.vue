<script setup lang="ts">
/**
 * 音频设置分区 —— 编排壳
 *
 * 设计: docs/planning/2026-07-26-audio-system-design.md §6.1
 * 三段式布局对齐 BeautifierSection，每段一个子组件（./audio/）：
 *   ① 混音台 AudioMixer     —— 主/音乐/音效 音量与静音 + 传输控制
 *   ② 播放列表 AudioPlaylists —— 左选择器 / 右曲目排序
 *   ③ 曲库 AudioLibrary      —— 音乐文件夹条 / 上传 / 筛选 / 行内编辑
 * 外加 AudioDialogs（确认 / 输入弹窗，provide 给各子组件用）。
 *
 * 本壳只做三件事：分区级生命周期（init / 曲库装载 / 进度轮询起停）、
 * 跨段共享的可见曲目派生、以及唯一的 aria-live 播报区。
 *
 * 边界: 本组件树只调 audio-store 的公开动作，不碰 AudioContext / Dexie。
 * 内置曲目不可改名/改标签/删除（store 拒绝），只能隐藏 —— 隐藏名单存
 * settings.audioHiddenBuiltinIds（对齐 beautifierBuiltinDisabled 先例）。
 */
import { ref, computed, watch, onMounted, onUnmounted, provide } from 'vue'
import { useAudioStore } from '../../stores/audio-store'
import { useSettingsStore } from '../../stores/settings-store'
import type { AudioTrack } from '@engine/types'
import AppCard from '../shared/AppCard.vue'
import AudioMixer from './audio/AudioMixer.vue'
import AudioPlaylists from './audio/AudioPlaylists.vue'
import AudioLibrary from './audio/AudioLibrary.vue'
import AudioDialogs from './audio/AudioDialogs.vue'
import { audioDialogsKey, type AudioConfirmOptions, type AudioPromptOptions } from './audio/dialogs'
import { isHiddenBuiltin } from './audio/format'

const audio = useAudioStore()
const cfg = useSettingsStore()
const s = cfg.settings

// ===== 弹窗能力下发 =====
// 弹窗本体挂在本壳里（一次只有一个在场），子组件通过 inject 拿到这两个方法。
// 这里包一层闭包而不是直接 provide 实例：provide 发生在挂载之前，那时 ref 还是空的。

const dialogsRef = ref<InstanceType<typeof AudioDialogs> | null>(null)

provide(audioDialogsKey, {
  askConfirm: (opts: AudioConfirmOptions) => dialogsRef.value!.askConfirm(opts),
  askPrompt: (opts: AudioPromptOptions) => dialogsRef.value!.askPrompt(opts),
})

// ===== 生命周期 =====

onMounted(async () => {
  await audio.init()
  await audio.loadLibrary()
  // 进度条只在本分区打开时可见 → 轮询随挂载/卸载起停（引用计数，§6.3）
  audio.startPositionPolling()
})

onUnmounted(() => {
  audio.stopPositionPolling()
})

// ===== 跨段共享：隐藏名单过滤后的曲目 =====
// 「显示已隐藏的内置曲目」的开关长在曲库工具条上，但过滤结果同时决定播放列表
// 能选到哪些曲子，所以这份派生住在壳里，两段各取所需。

const showHiddenBuiltins = ref(false)

const hiddenBuiltinIds = computed<string[]>(() => s.audioHiddenBuiltinIds ?? [])

const visibleTracks = computed<AudioTrack[]>(() =>
  audio.tracks.filter((t) => showHiddenBuiltins.value || !isHiddenBuiltin(t, hiddenBuiltinIds.value)),
)

/** 播放列表是音序器概念 —— 只收 music 曲目（§4.3） */
const musicTracks = computed(() => visibleTracks.value.filter((t) => t.kind === 'music'))

// ===== 状态播报（唯一 aria-live 区域） =====
// 只播报离散的、用户会关心的转变：播放/暂停、曲库与文件夹的忙碌态、上传结果。
// 绝不播报进度或音量这类连续值 —— 那会把屏幕阅读器淹掉。
// 三个 watch 的来源全是 store 状态，所以留在壳里；一次性事件（上传结果、
// 排序结果、批量操作结果）由各段 emit('announce') 上来，仍然只写这一处。

const liveMessage = ref('')

const isPlaying = computed(() => audio.state.music.status === 'playing')

const currentTrack = computed<AudioTrack | undefined>(() => {
  const id = audio.state.music.trackId
  return id ? audio.findTrack(id) : undefined
})

/** 已收录在曲库里的「磁盘文件」曲目数（含暂时失联的） */
const fileTrackCount = computed(() => audio.tracks.filter((t) => t.source === 'file').length)

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
      <AudioMixer />
    </AppCard>

    <!-- ═══ ② 播放列表 ═══ -->
    <AppCard padding="md" class="audio-card">
      <AudioPlaylists :music-tracks="musicTracks" @announce="liveMessage = $event" />
    </AppCard>

    <!-- ═══ ③ 曲库 ═══ -->
    <AppCard padding="md" class="audio-card">
      <AudioLibrary
        :tracks="visibleTracks"
        v-model:show-hidden="showHiddenBuiltins"
        @announce="liveMessage = $event"
      />
    </AppCard>

    <!-- ═══ 确认 / 输入弹窗（取代 window.confirm / window.prompt） ═══ -->
    <AudioDialogs ref="dialogsRef" />
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
</style>
