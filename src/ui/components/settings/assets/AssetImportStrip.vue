<script setup lang="ts">
/**
 * ① 导入 / 导出条 —— 一键导入一个素材包、导出一个可原样导回的包
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md §7.2 / §7.6 / §4.5
 *
 * 本组件只做四件事，全部照 store 的回执如实呈现，自己**不做任何判断**:
 *   ① 选文件（按钮 / 拖放）与导出下载 —— **压缩包与散装媒体文件都收**（§1 / §7.3）
 *   ② 进度条 + 取消（不可取消的转圈是用户中途强刷的原因，§7.6）
 *   ③ 一次导入的结构化回执（新增 / 跳过重复 / 自动编号 / 命名冲突 / 警告 …）
 *   ④ 配额条（`navigator.storage.estimate()` + `persist()` 的结果）
 *
 * 「取消不是失败、部分成功要如实说」这条纪律归 store（它已经把 cancelled 与
 * failed 分成两个字段），这里只负责把两者分开显示。
 *
 * 一条入口（D9）: 拖放/选择拿到的整个 `File[]` 原样交给 `importAny`，**本组件不做
 * 任何路由** —— 拆包与散装的分流、两半合并、只弹一条提示全在 store 里。于是扩展名
 * 路由（拖进来的 .mp3 照样落音频库）、D16 拒收、去重、编号、部分成功回执全都一致，
 * 这里不必为散装路径分叉任何显示逻辑。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ImportWarning } from '@engine/asset-import-plan';
import { ASSET_MIME_BY_EXTENSION } from '@engine/asset-types';
import { AUDIO_MIME_BY_EXTENSION } from '@engine/audio-names';
import AppButton from '../../shared/AppButton.vue';
import {
  useAssetStore,
  type AssetImportSummary,
  type AssetStorageEstimate,
} from '../../../stores/asset-store';
import { fmtBytes } from '../audio/format';
import { createProgressTracker } from './progress';

const emit = defineEmits<{
  /** 一次性事件的无障碍播报，由外层写进唯一的 aria-live 区 */
  (e: 'announce', message: string): void;
}>();

const assets = useAssetStore();

const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const quota = ref<AssetStorageEstimate | null>(null);

/**
 * 上一次导入的回执。
 *
 * 一次用户动作 = 一次 `importAny` = **一份**回执、**一条** toast（§7.2）。
 * 拆包/散装的分流、两半的合并、以及"一个坏包 + 一批好图"该怎么报，全在 store 里 ——
 * 这里曾经有一份 UI 侧的分流与合并，现在整段删掉了: 路由决策跟着导入管线走，
 * 两边各留一份就是漂移的来路。
 */
const summary = ref<AssetImportSummary | null>(null);

/**
 * 文件选择器的 `accept`。
 *
 * **从两张真表推**（`ASSET_MIME_BY_EXTENSION` / `AUDIO_MIME_BY_EXTENSION`），
 * 不手写清单 —— 手写的那份迟早与计划器真正接受的集合漂移，而漂移的表现是
 * "选择器里灰掉、但拖进去其实能导"。扩展名与 MIME 都给上: 有些平台只认其一。
 */
const acceptAttr = computed(() => {
  const exts = [...Object.keys(ASSET_MIME_BY_EXTENSION), ...Object.keys(AUDIO_MIME_BY_EXTENSION)];
  const mimes = [
    ...new Set([
      ...Object.values(ASSET_MIME_BY_EXTENSION),
      ...Object.values(AUDIO_MIME_BY_EXTENSION),
    ]),
  ];
  return ['.zip', 'application/zip', ...exts.map((e) => `.${e}`), ...mimes].join(',');
});

/** 卸载守卫: 配额查询与导入都是异步的，兑现后不能再往已卸载的组件里写状态 */
let disposed = false;

onMounted(async () => {
  const est = await assets.getStorageEstimate();
  if (disposed) return;
  quota.value = est;
});

onUnmounted(() => {
  disposed = true;
});

// ═══ 进度 ═════════════════════════════════════════════════

/**
 * 「永不倒退」的判定住在 ./progress.ts（纯归约器，可穷举测试）。
 *
 * 它要扛住**三种**分母不作准的情形: 解压段没有分母、**混合导入整段没有分母**
 * （后面几批的行数要等各自规划完才知道，store 因此把 `progressTotal` 钉成 0，
 * 而此时 `phase` 已经是 `'write'`）、以及分母万一又变回"会长的数"。
 * 判定刻意只看这两个数、不看相位 —— 相位只用来挑文案。
 */
const tracker = createProgressTracker();
const shownRatio = ref(0);
const progressIndeterminate = ref(true);

watch(
  () => [assets.progressDone, assets.progressTotal] as const,
  ([done, total]) => {
    const state = tracker.observe(done, total);
    shownRatio.value = state.ratio;
    progressIndeterminate.value = state.indeterminate;
  },
);

/**
 * 进度文字。
 *
 * store 现在给了 `progressPhase`（`'read'` 解压/读盘段分母恒为 0，`'write'` 写库段
 * 分母固定），所以不确定态下**可以**说清现在在干什么了 —— 上一版刻意用中性措辞，
 * 是因为那时分不清阶段，说了就可能说错。高水位那套仍然留着当兜底: 它不依赖
 * 这个标志，万一哪天口径又变，条也只会退化成转圈，绝不会往回抽。
 */
const progressText = computed(() => {
  if (!progressIndeterminate.value) return `${assets.progressDone} / ${assets.progressTotal}`;
  if (assets.progressDone > 0) {
    return assets.progressPhase === 'read'
      ? `正在读取… ${assets.progressDone}`
      : `已处理 ${assets.progressDone}`;
  }
  return assets.progressPhase === 'read' ? '正在读取…' : '正在准备…';
});

// ═══ 取消 ═════════════════════════════════════════════════

/**
 * 已经按过取消。`abort()` 本身幂等，这个标志只为了给出反馈（按钮改字并禁用）——
 * 否则用户会以为没点上，然后连点五次。随 `importing` 落下自动复位。
 */
const cancelRequested = ref(false);

watch(
  () => assets.importing,
  (on) => {
    if (!on) cancelRequested.value = false;
  },
);

function cancelImport(): void {
  cancelRequested.value = true;
  assets.cancelImport();
  emit('announce', '正在停止导入，已写入的内容会保留。');
}

// ═══ 导入 ═════════════════════════════════════════════════

function pickFile(): void {
  fileInput.value?.click();
}

async function onFilePicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  // 先清空再用: 同一批文件连选两次也要能触发 change
  input.value = '';
  await runImport(files);
}

async function onDrop(e: DragEvent): Promise<void> {
  dragging.value = false;
  await runImport(Array.from(e.dataTransfer?.files ?? []));
}

/**
 * 一次用户动作 = 一次 `importAny` = 一份回执 + 一条 toast（§7.2 / D9）。
 *
 * **这里不做任何路由**: 整个 `File[]` 原样交给 store，由它拆包/散装分流、
 * 两半都过同一个 executeImport、合并计数、只弹一条提示。UI 侧曾经有一份
 * `isZipFile` + 分流 + 合并，已整段删除 —— "什么算压缩包"是路由决策，
 * 跟着管线走才不会两边各留一份、慢慢漂移（Windows 那点 MIME 平台知识
 * 也随之搬进了 store 的 `isZipFile`，并且在那边有测试钉着）。
 */
async function runImport(files: File[]): Promise<void> {
  if (files.length === 0) {
    emit('announce', '没有可导入的文件。');
    return;
  }
  const res = await assets.importAny(files);
  if (disposed) return;
  summary.value = res;
  // toast 由 store 负责（唯一那条汇总），这里只补一次无障碍播报
  emit('announce', res.message || '导入结束。');
  const est = await assets.getStorageEstimate();
  if (disposed) return;
  quota.value = est;
}

// ═══ 导出 ═════════════════════════════════════════════════

async function runExport(): Promise<void> {
  const res = await assets.exportZip();
  if (disposed) return;
  emit('announce', res.message);
  if (!res.blob) return;
  // 下载全在这一层: store 只产出字节与建议文件名，不认识 DOM
  const url = URL.createObjectURL(res.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = res.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 浏览器是异步去取这份字节的，立刻撤销会让下载拿到死链 —— 留足时间再撤。
  // 即便此后组件卸载，这个定时器照样把 URL 收干净（这正是我们要的）。
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ═══ 回执呈现 ═════════════════════════════════════════════

/** 计数芯片 —— 0 的一律不显示，免得回执被一排「0」淹掉 */
const summaryChips = computed<{ label: string; value: number; tone: 'ok' | 'note' | 'warn' }[]>(
  () => {
    const s = summary.value;
    if (!s) return [];
    const all: { label: string; value: number; tone: 'ok' | 'note' | 'warn' }[] = [
      { label: '素材新增', value: s.assetsAdded, tone: 'ok' },
      { label: '音频新增', value: s.audioAdded, tone: 'ok' },
      { label: '跳过重复', value: s.duplicatesSkipped, tone: 'note' },
      { label: '自动编号', value: s.renumbered, tone: 'note' },
      { label: '命名冲突', value: s.namingConflicts, tone: 'warn' },
      { label: '立绘不支持 mp4', value: s.mediaRuleSkipped, tone: 'warn' },
      { label: '忽略无关文件', value: s.ignored, tone: 'note' },
      { label: '写入失败', value: s.failed, tone: 'warn' },
    ];
    return all.filter((c) => c.value > 0);
  },
);

/**
 * 警告的行内措辞。
 *
 * store 里的 `WARNING_TEXT` 是**那条 toast** 的文案且没有导出（范围栅栏也禁止改
 * asset-store.ts），所以行内这份是独立的一份，措辞刻意与它同义。两处都改的话
 * 记得对齐；不合并是当下的取舍，不是疏忽。
 */
const WARNING_HINT: Readonly<Record<ImportWarning, string>> = {
  'hash-unavailable':
    '这个环境拿不到哈希，本次没有做重复检测 —— 重复的文件会以编号变体的形式入库。',
  'suspect-filename-encoding':
    '压缩包里的文件名编码可疑（可能是 CP936）。名字已原样入库、绝不转码；如果显示成乱码，请用支持 UTF-8 的工具重新打包。',
  'suspect-missing-type':
    '有文件名疑似漏写了类型（例如把 `苏婉_微笑.png` 当成变体，实际会解析成名叫「苏婉_微笑」的另一个角色）。请到「按角色」里核对一下。',
};

const warningHints = computed(() => (summary.value?.warnings ?? []).map((w) => WARNING_HINT[w]));

/**
 * 读不出来的包，一条一句（`readErrors` 是可选字段，按 `?? []` 兜）。
 *
 * 与 `read` 分开呈现正是"一个坏包 + 一批好图"要的: 计数如实报好的那半，
 * 同时点名坏的那个 —— 塌成一个布尔就只剩"导入失败"，把成功的部分也抹掉了。
 */
const readErrors = computed<string[]>(() => summary.value?.readErrors ?? []);

/** 一条都没动过的导入也要说出来，否则界面看起来像什么都没发生 */
const nothingChanged = computed(() => {
  const s = summary.value;
  return !!s && s.assetsAdded === 0 && s.audioAdded === 0 && readErrors.value.length === 0;
});

// ═══ 配额 ═════════════════════════════════════════════════

const quotaRatio = computed(() => {
  const q = quota.value;
  if (!q || q.quota <= 0) return 0;
  return Math.min(1, Math.max(0, q.used / q.quota));
});

/**
 * 持久化存储的结果。**被拒不是错误**（§4.5）: 如实写出来，绝不阻塞导入。
 * null 是「还没问过 / 浏览器不支持」，与「问了被拒」是两件事，措辞要分开。
 */
const persistText = computed(() => {
  if (assets.storagePersisted === true) return '已获得持久化存储，磁盘紧张时不会被优先清理。';
  if (assets.storagePersisted === false) {
    return '浏览器拒绝了持久化存储：素材照常导入，但磁盘紧张时整库（含存档与音频）可能被清理，建议留一份导出包。';
  }
  return '尚未申请持久化存储（首次导入成功后会自动申请一次）。';
});
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
    <span class="io-label">导入</span>
    <span class="io-hint">
      把压缩包<strong>或散装的图片 / 视频 / 音频</strong>拖到这里，也可以点右边的按钮选。
      两种混着来也行，会当成一次导入。
    </span>
    <AppButton variant="primary" size="sm" :disabled="assets.importing" @click="pickFile">
      <i class="fa-solid fa-file-import" aria-hidden="true" /> 选择文件
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
      multiple
      :accept="acceptAttr"
      aria-label="选择素材包或媒体文件"
      @change="onFilePicked"
    />
  </div>

  <!--
    署名只能从 zip 根的 manifest.json 来（D10），散装文件带不了 —— 打包分发的人
    需要知道这件事，否则作者署名会在一次"随手拖几张图"里悄悄丢掉。
  -->
  <p class="band-note text-muted text-sm">
    散装文件不带署名与授权信息（清单只存在于压缩包根目录）。要为分发的素材保留
    <code class="conv-code">credit</code> / <code class="conv-code">license</code>，请打包成 zip
    再导入。
  </p>

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
    <div class="sum-chips">
      <span v-if="summary.cancelled" class="sum-chip chip-note">已取消（已写入的都保留）</span>
      <span v-for="c in summaryChips" :key="c.label" class="sum-chip" :class="`chip-${c.tone}`">
        {{ c.label }} {{ c.value }}
      </span>
      <span
        v-if="summaryChips.length === 0 && !summary.cancelled && readErrors.length === 0"
        class="sum-chip chip-note"
        >没有任何变化</span
      >
    </div>
    <p v-if="nothingChanged && !summary.cancelled" class="sum-note">
      这次导入的内容全部被跳过了，库没有变化 —— 通常是因为它们已经导入过一次。
    </p>
    <!--
      读不出来的包逐条点名。这与"读进来了但计数为 0"是两回事:
      一个坏包 + 一批好图时，上面的计数是真的，下面这几行说的是坏的那几个。
    -->
    <p v-for="err in readErrors" :key="err" class="sum-fail">{{ err }}</p>
    <p v-if="summary.quotaHit" class="sum-fail">
      浏览器存储空间已满，剩下的文件没有继续导入。已导入的都完整保留 ——
      可以先删掉一些素材或音频，再把同一批文件导一次（已有的会被识别成重复而跳过）。
    </p>
    <p v-for="hint in warningHints" :key="hint" class="sum-warn">{{ hint }}</p>
  </div>

  <!-- ═══ 配额 ═══ -->
  <div class="io-strip io-quota">
    <span class="io-label">浏览器存储</span>
    <template v-if="quota">
      <div class="bar-track" role="img" :aria-label="`已用 ${quota.pct.toFixed(1)}%`">
        <div
          class="bar-fill"
          :class="{ 'bar-hot': quota.pct >= 80 }"
          :style="{ transform: `scaleX(${quotaRatio})` }"
        />
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
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
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
