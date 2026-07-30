<script setup lang="ts">
/**
 * ① 导入 / 导出条 —— 一键导入一个素材包、导出一个可原样导回的包
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md §7.2 / §7.6 / §4.5
 *
 * 本组件只做四件事，全部照 store 的回执如实呈现，自己**不做任何判断**:
 *   ① 选包（按钮 / 拖放）与导出下载
 *   ② 进度条 + 取消（不可取消的转圈是用户中途强刷的原因，§7.6）
 *   ③ 一次导入的结构化回执（新增 / 跳过重复 / 自动编号 / 命名冲突 / 警告 …）
 *   ④ 配额条（`navigator.storage.estimate()` + `persist()` 的结果）
 *
 * 「取消不是失败、部分成功要如实说」这条纪律归 store（它已经把 cancelled 与
 * failed 分成两个字段），这里只负责把两者分开显示。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ImportWarning } from '@engine/asset-import-plan'
import AppButton from '../../shared/AppButton.vue'
import {
  useAssetStore,
  type AssetImportSummary,
  type AssetStorageEstimate,
} from '../../../stores/asset-store'
import { fmtBytes } from '../audio/format'

const emit = defineEmits<{
  /** 一次性事件的无障碍播报，由外层写进唯一的 aria-live 区 */
  (e: 'announce', message: string): void
}>()

const assets = useAssetStore()

const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const summary = ref<AssetImportSummary | null>(null)
const quota = ref<AssetStorageEstimate | null>(null)

/** 卸载守卫: 配额查询与导入都是异步的，兑现后不能再往已卸载的组件里写状态 */
let disposed = false

onMounted(async () => {
  const est = await assets.getStorageEstimate()
  if (disposed) return
  quota.value = est
})

onUnmounted(() => {
  disposed = true
})

// ═══ 进度 ═════════════════════════════════════════════════

/**
 * ⚠️ **`progressTotal` 不是一上来就知道的，它会边解包边长**。
 *
 * zip 的条目总数写在文件**末尾**的中央目录里，而读包是从头往后流式扫本地头的 ——
 * 所以解压阶段每发现一个条目分母就大一点，`done/total` 完全可能**往回走**；
 * 随后写库阶段又会把 `done` 归零、把 `total` 换成计划里的最终行数（比条目数**小**，
 * 噪音与跳过的都不在里面）。一条会倒退的 scaleX 比一个转圈更糟，所以这里不直接
 * 用 computed 算比例，而是维护一个**高水位**，并且允许自己说"我现在不知道"。
 *
 * 规则（store 眼下没有 phase 标志，只能从这两个数自己推；日后它给了标志就换掉这段）:
 *   ① `total <= 0` → 不确定（没有可用的分母）
 *   ② `total` 从一个非零值**变了**（长大或换阶段）→ 分母不作准，这一帧不确定，
 *      并把高水位清零 —— 旧比例是按旧分母算的，留着就会污染下一阶段
 *   ③ 算出来的比例**低于**高水位 → 宁可不确定，绝不把条往回抽
 *   ④ 其余情况 → 确定，抬高水位
 *
 * 于是: 解压期分母每帧在动 → 一路走 ②，整段是不确定态（转圈 + 计数）；
 * 阶段切换时 ② 命中一帧；写库期分母稳定、`done` 单增 → 干净的确定态。
 * 而在 `readAssetZip` 眼下**根本不报解压进度**的现实里（0 → N 一步到位，
 * ② 被 `lastTotal > 0` 挡住），写库进度照旧是确定态，行为与之前一致。
 */
const shownRatio = ref(0)
const progressIndeterminate = ref(true)
let lastTotal = 0

function resetProgressTracking(): void {
  shownRatio.value = 0
  progressIndeterminate.value = true
  lastTotal = 0
}

watch(
  () => [assets.progressDone, assets.progressTotal] as const,
  ([done, total]) => {
    // importZip 起手就把两个数归零 —— 这就是"新一轮开始"的信号，不必另设标志位
    if (done === 0 && total === 0) {
      resetProgressTracking()
      return
    }
    if (total <= 0) {
      progressIndeterminate.value = true
      return
    }
    const changed = lastTotal > 0 && total !== lastTotal
    lastTotal = total
    if (changed) {
      shownRatio.value = 0
      progressIndeterminate.value = true
      return
    }
    const ratio = Math.min(1, Math.max(0, done / total))
    if (ratio < shownRatio.value) {
      progressIndeterminate.value = true
      return
    }
    shownRatio.value = ratio
    progressIndeterminate.value = false
  },
)

/**
 * 进度文字。不确定态刻意**不写"正在读取"**: 两个阶段都可能落进不确定态，
 * 而我们分不清现在是哪个 —— 说一句分不清对错的话，不如只报手上确实有的那个计数。
 */
const progressText = computed(() => {
  if (!progressIndeterminate.value) return `${assets.progressDone} / ${assets.progressTotal}`
  return assets.progressDone > 0 ? `已处理 ${assets.progressDone}` : '正在解包…'
})

// ═══ 取消 ═════════════════════════════════════════════════

/**
 * 已经按过取消。`abort()` 本身幂等，这个标志只为了给出反馈（按钮改字并禁用）——
 * 否则用户会以为没点上，然后连点五次。随 `importing` 落下自动复位。
 */
const cancelRequested = ref(false)

watch(() => assets.importing, (on) => {
  if (!on) cancelRequested.value = false
})

function cancelImport(): void {
  cancelRequested.value = true
  assets.cancelImport()
  emit('announce', '正在停止导入，已写入的内容会保留。')
}

// ═══ 导入 ═════════════════════════════════════════════════

function pickFile(): void {
  fileInput.value?.click()
}

async function onFilePicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  // 先清空再取值: 同一个包连选两次也要能触发 change
  input.value = ''
  if (file) await runImport(file)
}

/** 拖放: 只认第一个 .zip；一个都没有就如实说，不去猜 */
async function onDrop(e: DragEvent): Promise<void> {
  dragging.value = false
  const files = Array.from(e.dataTransfer?.files ?? [])
  const zip = files.find((f) => /\.zip$/i.test(f.name))
  if (!zip) {
    emit('announce', '拖进来的不是压缩包，导入未开始。')
    return
  }
  await runImport(zip)
}

async function runImport(file: File): Promise<void> {
  const res = await assets.importZip(file)
  if (disposed) return
  summary.value = res
  // toast 由 store 负责（唯一那条汇总），这里只补一次无障碍播报
  emit('announce', res.message || '导入结束。')
  const est = await assets.getStorageEstimate()
  if (disposed) return
  quota.value = est
}

// ═══ 导出 ═════════════════════════════════════════════════

async function runExport(): Promise<void> {
  const res = await assets.exportZip()
  if (disposed) return
  emit('announce', res.message)
  if (!res.blob) return
  // 下载全在这一层: store 只产出字节与建议文件名，不认识 DOM
  const url = URL.createObjectURL(res.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = res.filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 浏览器是异步去取这份字节的，立刻撤销会让下载拿到死链 —— 留足时间再撤。
  // 即便此后组件卸载，这个定时器照样把 URL 收干净（这正是我们要的）。
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ═══ 回执呈现 ═════════════════════════════════════════════

/** 计数芯片 —— 0 的一律不显示，免得回执被一排「0」淹掉 */
const summaryChips = computed<{ label: string; value: number; tone: 'ok' | 'note' | 'warn' }[]>(() => {
  const s = summary.value
  if (!s) return []
  const all: { label: string; value: number; tone: 'ok' | 'note' | 'warn' }[] = [
    { label: '素材新增', value: s.assetsAdded, tone: 'ok' },
    { label: '音频新增', value: s.audioAdded, tone: 'ok' },
    { label: '跳过重复', value: s.duplicatesSkipped, tone: 'note' },
    { label: '自动编号', value: s.renumbered, tone: 'note' },
    { label: '命名冲突', value: s.namingConflicts, tone: 'warn' },
    { label: '立绘不支持 mp4', value: s.mediaRuleSkipped, tone: 'warn' },
    { label: '忽略无关文件', value: s.ignored, tone: 'note' },
    { label: '写入失败', value: s.failed, tone: 'warn' },
  ]
  return all.filter((c) => c.value > 0)
})

/**
 * 警告的行内措辞。
 *
 * store 里的 `WARNING_TEXT` 是**那条 toast** 的文案且没有导出（范围栅栏也禁止改
 * asset-store.ts），所以行内这份是独立的一份，措辞刻意与它同义。两处都改的话
 * 记得对齐；不合并是当下的取舍，不是疏忽。
 */
const WARNING_HINT: Readonly<Record<ImportWarning, string>> = {
  'hash-unavailable': '这个环境拿不到哈希，本次没有做重复检测 —— 重复的文件会以编号变体的形式入库。',
  'suspect-filename-encoding':
    '压缩包里的文件名编码可疑（可能是 CP936）。名字已原样入库、绝不转码；如果显示成乱码，请用支持 UTF-8 的工具重新打包。',
  'suspect-missing-type':
    '有文件名疑似漏写了类型（例如把 `苏婉_微笑.png` 当成变体，实际会解析成名叫「苏婉_微笑」的另一个角色）。请到「按角色」里核对一下。',
}

const warningHints = computed(() => (summary.value?.warnings ?? []).map((w) => WARNING_HINT[w]))

/** 一条都没动过的导入也要说出来，否则界面看起来像什么都没发生 */
const nothingChanged = computed(() => {
  const s = summary.value
  return !!s && s.read && s.assetsAdded === 0 && s.audioAdded === 0
})

// ═══ 配额 ═════════════════════════════════════════════════

const quotaRatio = computed(() => {
  const q = quota.value
  if (!q || q.quota <= 0) return 0
  return Math.min(1, Math.max(0, q.used / q.quota))
})

/**
 * 持久化存储的结果。**被拒不是错误**（§4.5）: 如实写出来，绝不阻塞导入。
 * null 是「还没问过 / 浏览器不支持」，与「问了被拒」是两件事，措辞要分开。
 */
const persistText = computed(() => {
  if (assets.storagePersisted === true) return '已获得持久化存储，磁盘紧张时不会被优先清理。'
  if (assets.storagePersisted === false) {
    return '浏览器拒绝了持久化存储：素材照常导入，但磁盘紧张时整库（含存档与音频）可能被清理，建议留一份导出包。'
  }
  return '尚未申请持久化存储（首次导入成功后会自动申请一次）。'
})
</script>

<template>
  <h4 class="band-title">导入与导出</h4>
  <p class="band-note text-muted text-sm">
    一个压缩包同时收素材与音频：图片/视频按
    <code class="conv-code">名字_类型_变体.png</code> 归档（如
    <code class="conv-code">苏婉_头像.png</code>，类型可省略、默认「头像」），音频直接进曲库。
  </p>

  <!-- ═══ 选包 / 导出 ═══ -->
  <div
    class="io-strip"
    :class="{ 'io-strip-drag': dragging }"
    @dragover.prevent="dragging = true"
    @dragenter.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <span class="io-label">素材包</span>
    <span class="io-hint">把 .zip 拖到这里，或点右边的按钮选一个。</span>
    <AppButton variant="primary" size="sm" :disabled="assets.importing" @click="pickFile">
      <i class="fa-solid fa-file-zipper" aria-hidden="true" /> 导入素材包
    </AppButton>
    <AppButton
      variant="secondary"
      size="sm"
      :disabled="assets.exporting || assets.importing"
      @click="runExport"
    >
      {{ assets.exporting ? '正在打包…' : '导出素材包' }}
    </AppButton>
    <input
      ref="fileInput"
      class="file-input"
      type="file"
      accept=".zip,application/zip"
      aria-label="选择素材包"
      @change="onFilePicked"
    />
  </div>

  <!-- ═══ 进度 + 取消 ═══ -->
  <div v-if="assets.importing" class="io-strip io-progress" role="group" aria-label="导入进度">
    <span class="io-label">正在导入</span>
    <!--
      分母不作准时（解压期 / 阶段切换）走不确定态: 一条来回扫的窄带，而不是一条
      会往回抽的比例条。两种形态共用同一副轨道，只换里面那层的动画/变换。
    -->
    <div class="bar-track" role="img" :aria-label="`导入进度：${progressText}`">
      <div v-if="progressIndeterminate" class="bar-sweep" />
      <div v-else class="bar-fill" :style="{ transform: `scaleX(${shownRatio})` }" />
    </div>
    <span class="io-count">{{ progressText }}</span>
    <AppButton variant="ghost" size="sm" :disabled="cancelRequested" @click="cancelImport">
      {{ cancelRequested ? '正在停止…' : '取消导入' }}
    </AppButton>
  </div>

  <!-- ═══ 上一次导入的回执 ═══ -->
  <div v-if="summary" class="io-summary">
    <p v-if="!summary.read" class="sum-fail">{{ summary.message }}</p>
    <template v-else>
      <div class="sum-chips">
        <span v-if="summary.cancelled" class="sum-chip chip-note">已取消（已写入的都保留）</span>
        <span v-for="c in summaryChips" :key="c.label" class="sum-chip" :class="`chip-${c.tone}`">
          {{ c.label }} {{ c.value }}
        </span>
        <span v-if="summaryChips.length === 0 && !summary.cancelled" class="sum-chip chip-note">
          没有任何变化
        </span>
      </div>
      <p v-if="nothingChanged" class="sum-note">
        这个包里的内容全部被跳过了，库没有变化 —— 通常是因为它已经导入过一次。
      </p>
      <p v-for="hint in warningHints" :key="hint" class="sum-warn">{{ hint }}</p>
    </template>
  </div>

  <!-- ═══ 配额 ═══ -->
  <div class="io-strip io-quota">
    <span class="io-label">浏览器存储</span>
    <template v-if="quota">
      <div class="bar-track" role="img" :aria-label="`已用 ${quota.pct.toFixed(1)}%`">
        <div class="bar-fill" :class="{ 'bar-hot': quota.pct >= 80 }" :style="{ transform: `scaleX(${quotaRatio})` }" />
      </div>
      <span class="io-count">
        {{ fmtBytes(quota.used) }} / {{ fmtBytes(quota.quota) }}（{{ quota.pct.toFixed(1) }}%）
      </span>
    </template>
    <span v-else class="io-hint">这个浏览器不报告存储用量。</span>
    <span class="io-hint">{{ persistText }}</span>
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
  margin: 0 0 var(--theme-spacing-sm);
}
.band-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.band-note {
  margin: 0 0 var(--theme-spacing-md);
  line-height: 1.55;
}
.conv-code {
  font-family: 'Cascadia Code', monospace;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}

/* ═══ 条状分组外壳 —— 与音频分区的上传组 / 文件夹条同一副视觉 ═══ */
.io-strip {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  margin-bottom: var(--theme-spacing-sm);
  /* 只过渡颜色，绝不过渡布局属性（design.md §1 禁令） */
  transition: background var(--theme-transition-fast), border-color var(--theme-transition-fast);
}
.io-strip-drag {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.io-label {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.io-hint {
  flex: 1;
  min-width: 12rem;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  line-height: 1.55;
}
.io-count {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  font-variant-numeric: tabular-nums;
}
.file-input {
  display: none;
}

/* ═══ 进度 / 配额条 —— scaleX，绝不过渡 width ═══ */
.bar-track {
  flex: 1;
  min-width: 8rem;
  height: 6px;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-full);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  background: var(--theme-primary);
  border-radius: var(--theme-radius-full);
  transform-origin: left center;
  transition: transform var(--theme-transition-fast);
}
.bar-hot {
  background: var(--theme-warning);
}

/*
 * 不确定态: 一条来回扫的窄带。动的是 transform（合成层），不碰 width/left。
 * 用 scaleX+translateX 而不是 `left` 位移，同样是为了不过渡布局属性。
 */
.bar-sweep {
  width: 100%;
  height: 100%;
  background: var(--theme-primary);
  border-radius: var(--theme-radius-full);
  transform-origin: left center;
  animation: bar-sweep 1.1s ease-in-out infinite;
}
@keyframes bar-sweep {
  0% {
    transform: translateX(0) scaleX(0.25);
  }
  50% {
    transform: translateX(75%) scaleX(0.25);
  }
  100% {
    transform: translateX(0) scaleX(0.25);
  }
}

@media (prefers-reduced-motion: reduce) {
  .io-strip,
  .bar-fill {
    transition: none;
  }
  /*
   * 不做来回扫的动画，但仍要看起来"在忙"且明确区别于比例条 —— 停成一条半透明的
   * 满轨（旁边的计数文字仍在跳，那就是活着的证据）。
   */
  .bar-sweep {
    animation: none;
    transform: none;
    opacity: 0.4;
  }
}

/* ═══ 回执 ═══ */
.io-summary {
  padding: var(--theme-spacing-md);
  margin-bottom: var(--theme-spacing-sm);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
}
.sum-chips {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
}
/*
 * 纵向 1px 硬编码沿用音频曲库 .tag-chip 的既有取舍: 间距体系最小档是 4px，
 * 换上去药丸会明显变胖、与右侧计数文字的基线对不齐。横向仍走 token。
 */
.sum-chip {
  font-size: 0.6875rem;
  padding: 1px var(--theme-spacing-sm);
  border-radius: var(--theme-radius-full);
  font-variant-numeric: tabular-nums;
}
.chip-ok {
  background: color-mix(in srgb, var(--theme-success) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-success) 30%, transparent);
  color: var(--theme-success);
}
.chip-note {
  background: color-mix(in srgb, var(--theme-primary) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent);
  color: var(--theme-primary);
}
.chip-warn {
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  color: var(--theme-warning);
}
.sum-note,
.sum-warn,
.sum-fail {
  margin: var(--theme-spacing-sm) 0 0;
  font-size: 0.75rem;
  line-height: 1.55;
}
.sum-note {
  color: var(--theme-text-muted);
}
.sum-warn {
  color: var(--theme-warning);
}
.sum-fail {
  margin: 0;
  color: var(--theme-error);
}
</style>
