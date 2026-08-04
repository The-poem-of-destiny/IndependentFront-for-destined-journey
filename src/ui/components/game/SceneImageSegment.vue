<script setup lang="ts">
/**
 * SceneImageSegment.vue — 正文里一格插画的六种样子（设计 §10.2 状态真值表）
 *
 * 本组件**不判定**该显示什么 —— 那是 `scene-image-view.ts` 的纯函数
 * {@link resolveSceneImageView} 的事（尤其那格「无记录 + auto 出按钮而不是去生成」，
 * D15/D21）。这里只负责把判定结果画出来，并把点击转成 store 调用。
 *
 * 三条布局/文案纪律，每条都对应一个真实的糟糕体验:
 *
 * 1. 🔴 **按钮态 / 排队态 / 生成中态占同样高度**（`.si-frame` 的 `min-height`）——
 *    否则每张图落地时整个对话流会往下跳一截，正在读的那一行被推走。
 * 2. 🔴 **占位框里始终写着 title 与 intent**（D37）。5–60 秒的灰框是纯死时间，而
 *    「这张图画的是什么」本来就在记录里 —— 写上去，等待变成期待，成本为零。
 * 3. 🔴 **两种取消的措辞完全不同**（D36）：排队中取消一个字节都没花；在飞中止
 *    上游照样计费，按钮上必须说出来。
 *
 * object URL 走 `composables/useSceneImageUrls.ts`（它自己走 `lib/asset-url.ts` 的
 * 引用计数 LRU）—— **本组件不写第二套铸造/撤销**，也与 CG 图鉴共用同一份缓存。
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import type {
  ImageGenMode,
  ImageRating,
  SceneImageAnchorKind,
  SceneImageMarker,
} from '@engine/types-image';
import { clampRating } from '@engine/image-prompt';
import { useManualSceneImage } from '../../composables/useManualSceneImage';
import { useSceneImageUrls } from '../../composables/useSceneImageUrls';
import { useSceneImageStore } from '../../stores/scene-image-store';
import { useImagePresetStore } from '../../stores/image-preset-store';
import { useUIStore } from '../../stores/ui-store';
import AppButton from '../shared/AppButton.vue';
import { missingPresetHint, resolveSceneImageView } from './scene-image-view';

const props = withDefaults(
  defineProps<{
    /** 这一格挂在哪条消息上 */
    messageId: string;
    /** 同 anchorKind 内的序号（marker 段的编号来自 splitSceneImageSegments） */
    occurrence: number;
    anchorKind?: SceneImageAnchorKind;
    /** 三档开关。**只影响「无记录」那一行**；缺省 `off` = 这个子系统不存在 */
    mode?: ImageGenMode;
    /** 所属消息的 turn（限额 L3 的同回合去重键） */
    turn?: number;
    /** 标记那一格的元数据；`message-end` 的图带没有标记 */
    marker?: SceneImageMarker | undefined;
    /** 所属消息正文（已剥标记），喂侧链判断氛围/光线/时间 */
    narrative?: string;
    /**
     * rating **上限**（D38），来自 `settings.imageMaxRating`。
     *
     * 🔴 它钳住的是**标记写的** rating —— 玩家把上限设成 `general` 通常有现实原因
     * （在外面玩），而 story agent 写一句 `rating="explicit"` 不该穿透它。
     * 缺省 `general` 与设置默认值同档: 猜错了只是画得保守，反过来是把人推进麻烦里。
     */
    maxRating?: ImageRating;
  }>(),
  {
    anchorKind: 'marker',
    // 🔴 缺省 `off`: 设置项（§11）还没落地之前，渲染层绝不能自己假设功能是开的 ——
    // 「默认关」错了只是少画一张图，「默认开」错了是直接花钱。
    mode: 'off',
    turn: 0,
    marker: undefined,
    narrative: '',
    maxRating: 'general',
  },
);

const store = useSceneImageStore();
const presets = useImagePresetStore();
const ui = useUIStore();

// 幂等；放在 setup 而不是 onMounted —— init() 同步就把 loading 置 true，于是
// 「预设还没读完」与「这个角色真的没有预设」在**第一帧**就是可分辨的两件事。
void presets.init();

// ═══ 记录与派生 ═══

const takes = computed(() => store.takesAt(props.messageId, props.anchorKind, props.occurrence));
const record = computed(() =>
  store.displayedAt(props.messageId, props.anchorKind, props.occurrence),
);

/** 角标 `2/3` 只数**真的画出来了**的那些 —— 失败/排队中的 take 不是一张图 */
const shownTakes = computed(() =>
  takes.value.filter((r) => r.status === 'done' && r.blobDropped !== true),
);

const queuePosition = computed(() => {
  const id = record.value?.id;
  if (id === undefined) return undefined;
  const i = store.queue.indexOf(id);
  return i < 0 ? undefined : i + 1;
});

/** 出场角色里查不到预设的那些（D41）。预设库还在读时报空，不冤枉任何人 */
const missing = computed<string[]>(() => {
  const r = record.value;
  if (!r || presets.loading) return [];
  return r.characters.filter((name) => presets.find('character', name) === undefined);
});

/** 「已用 N 秒」的时钟；只在真的有一张在飞时才走 */
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
watch(
  () => record.value?.status === 'generating',
  (on) => {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
    if (!on) return;
    now.value = Date.now();
    ticker = setInterval(() => {
      now.value = Date.now();
    }, 1000);
  },
  { immediate: true },
);

const view = computed(() =>
  resolveSceneImageView({
    mode: props.mode,
    record: record.value,
    marker: props.marker,
    queuePosition: queuePosition.value,
    now: now.value,
    missingPresets: missing.value,
    takeIndex: shownTakes.value.findIndex((r) => r.id === record.value?.id) + 1,
    takeCount: shownTakes.value.length,
  }),
);

const presetHint = computed(() =>
  view.value.kind === 'done' ? missingPresetHint(view.value.missingPresets) : '',
);

// ═══ object URL ═══

/**
 * 装载走 `useSceneImageUrls`（它自己走 `lib/asset-url.ts` 的引用计数 LRU）——
 * **本组件不碰第二套铸造/撤销**。图鉴与正文插图共用同一份缓存，同一张图不会
 * 被铸出两条各撤各的 URL。
 */
const urls = useSceneImageUrls({ source: store });

/** 有字节可显示的那一格才取 URL；`dropped` 刻意取不到（它没有字节，不是破图） */
const bytesId = computed(() => (view.value.kind === 'done' ? view.value.recordId : null));

watch(
  bytesId,
  (id) => {
    if (id !== null) urls.load(id);
  },
  { immediate: true },
);

const url = computed(() => (bytesId.value === null ? null : urls.urlFor(bytesId.value)));

onUnmounted(() => {
  if (ticker !== undefined) clearInterval(ticker);
  // URL 的归还由 useSceneImageUrls 的 onScopeDispose 负责，这里只收自己的定时器
});

// ═══ 动作 ═══

const promptDraft = ref('');
const promptOpen = ref(false);

/**
 * 手动开火那一条路（D24）—— 被限额拦下时**立起确认框而不是弹个 toast 就结束**。
 *
 * 本组件里每一次生成都是手动的（自动档由编排器回调开火，不经过渲染层），所以
 * 三个动作（首次生成 / 重画 / 用自己写的提示词重画）共用同一个 composable。
 */
const {
  busy,
  pending: quotaPending,
  request: requestImage,
  confirm: confirmQuota,
  dismiss: dismissQuota,
} = useManualSceneImage({
  generate: (input) => store.generate(input),
  notify: (message) => ui.toast(message, 'warning'),
});

/** 手动开火 —— 无记录那一格的按钮。**只有这里会新建记录**（自动档由编排器回调开火） */
async function fire(): Promise<void> {
  const saveId = store.activeSaveId;
  if (saveId === null) {
    ui.toast('还没有载入存档，暂时画不了', 'warning');
    return;
  }
  await requestImage({
    saveId,
    messageId: props.messageId,
    turn: props.turn,
    anchorKind: props.anchorKind,
    occurrence: props.occurrence,
    intent: props.marker?.bodyText ?? '',
    title: props.marker?.title ?? '',
    characters: props.marker?.characters ?? [],
    // 🔴 标记写的 rating 在这里就被上限钳住（D38）—— 记录里那个值还会喂给侧链，
    //    只在 composePrompt 里钳的话，上限管得住图、管不住送去侧链的那句话
    rating: clampRating(props.marker?.rating, props.maxRating),
    narrative: props.narrative,
  });
}

/**
 * 重画 / 重试 —— 追加一个 take，源记录一个字节都不动（D17）。
 *
 * `redrawFrom` 让新记录继承 `scenePrompt` / `editedScenePrompt`，于是**不重跑侧链**
 * （D31）：重试一次失败的出图不该再烧一次 LLM token。
 */
async function redraw(): Promise<void> {
  const r = record.value;
  if (!r) return;
  await requestImage({
    saveId: r.saveId,
    messageId: r.messageId,
    turn: r.turn,
    anchorKind: r.anchorKind,
    occurrence: r.occurrence,
    intent: r.intent,
    title: r.title,
    description: r.description,
    characters: r.characters,
    // 重画沿用这一条记录的 rating，但上限可能在这期间被调低了 —— 照样钳一次
    rating: clampRating(r.rating, props.maxRating),
    narrative: props.narrative,
    redrawFrom: r.id,
  });
}

/** 自己写提示词（D42）—— 就地写，不是"去图鉴里填"（失败的记录根本不进图鉴） */
function openPrompt(): void {
  promptDraft.value = record.value?.editedScenePrompt ?? record.value?.scenePrompt ?? '';
  promptOpen.value = true;
}

async function submitPrompt(): Promise<void> {
  const r = record.value;
  const text = promptDraft.value.trim();
  if (!r || text === '') return;
  // 先存进这一条，再以它为源重画 —— 新 take 继承 editedScenePrompt 并跳过侧链
  await store.update(r.id, { editedScenePrompt: text });
  promptOpen.value = false;
  await redraw();
}

async function cancel(): Promise<void> {
  const r = record.value;
  if (!r) return;
  await store.cancel(r.id);
}

/** 缺预设那一行的「去设置」（D41）。角色名预填要等 §11 的图像分区落地 */
function goPresets(): void {
  ui.navigate('settings');
}
</script>

<template>
  <div v-if="view.kind !== 'hidden'" class="scene-image">
    <!-- 无记录 + manual/auto：按钮。🔴 auto 也在这里，绝不自动开火 -->
    <button
      v-if="view.kind === 'offer'"
      type="button"
      class="si-frame si-offer"
      :disabled="busy"
      @click="fire"
    >
      <span class="si-glyph" aria-hidden="true">❖</span>
      <span class="si-title">{{ view.title }}</span>
      <span class="si-intent">{{ view.intent }}</span>
      <span class="si-action-label">{{ busy ? '正在排队…' : '生成插画' }}</span>
    </button>

    <!-- 排队中：一个字节都没花，取消是免费的 -->
    <div v-else-if="view.kind === 'queued'" class="si-frame">
      <span class="si-title">{{ view.title }}</span>
      <span class="si-intent">{{ view.intent }}</span>
      <span class="si-status">队列中 · 第 {{ view.position }} 位</span>
      <AppButton variant="ghost" size="sm" @click="cancel">取消（不消耗）</AppButton>
    </div>

    <!-- 生成中：转圈 + 已用秒数；中止照样计费，按钮上要说出来 -->
    <div v-else-if="view.kind === 'generating'" class="si-frame" aria-busy="true">
      <span class="si-spinner" aria-hidden="true"></span>
      <span class="si-title">{{ view.title }}</span>
      <span class="si-intent">{{ view.intent }}</span>
      <span class="si-status">正在生成 · 已用 {{ view.elapsedSec }} 秒</span>
      <AppButton variant="ghost" size="sm" @click="cancel">中止（本次仍会计费）</AppButton>
    </div>

    <!-- 画好了 -->
    <figure v-else-if="view.kind === 'done'" class="si-figure">
      <div class="si-canvas">
        <img v-if="url" :src="url" :alt="view.title" :title="view.description" class="si-img" />
        <div v-else class="si-frame si-loading-bytes">
          <span class="si-title">{{ view.title }}</span>
          <span class="si-status">正在载入图片…</span>
        </div>
        <span v-if="view.takeCount > 1" class="si-take"
          >{{ view.takeIndex }}/{{ view.takeCount }}</span
        >
      </div>
      <figcaption class="si-caption">
        <span class="si-cap-title">{{ view.title }}</span>
        <span v-if="view.description" class="si-cap-desc">{{ view.description }}</span>
      </figcaption>
      <p v-if="presetHint" class="si-hint">
        {{ presetHint }}
        <button type="button" class="si-link" @click="goPresets">去设置</button>
      </p>
    </figure>

    <!-- 字节被清理过（D47）：配方还在，随时能重画。绝不渲染成一张破图 -->
    <div v-else-if="view.kind === 'dropped'" class="si-frame">
      <span class="si-title">{{ view.title }}</span>
      <span class="si-intent">{{ view.description }}</span>
      <span class="si-status">字节已清理</span>
      <AppButton variant="secondary" size="sm" :loading="busy" @click="redraw">重画</AppButton>
    </div>

    <!-- 失败：一行可读原因，绝不静默留白 -->
    <div v-else class="si-frame si-failed">
      <span class="si-title">{{ view.title }}</span>
      <span class="si-status si-error">{{ view.message }}</span>
      <div class="si-actions">
        <AppButton
          v-if="view.retryable"
          variant="secondary"
          size="sm"
          :loading="busy"
          @click="redraw"
        >
          重试
        </AppButton>
        <AppButton variant="ghost" size="sm" @click="openPrompt">自己写提示词</AppButton>
      </div>
      <div v-if="promptOpen" class="si-prompt">
        <textarea
          v-model="promptDraft"
          class="si-textarea"
          rows="3"
          placeholder="用 danbooru 标签描述这个画面，例如 tavern interior, warm candlelight, sitting"
        ></textarea>
        <div class="si-actions">
          <AppButton
            variant="primary"
            size="sm"
            :disabled="!promptDraft.trim()"
            @click="submitPrompt"
          >
            用这份提示词重画
          </AppButton>
          <AppButton variant="ghost" size="sm" @click="promptOpen = false">取消</AppButton>
        </div>
      </div>
    </div>

    <!--
      限额确认（D24）—— 手动**永不被拦死**，最多是要确认一下。
      🔴 显示的是 checkQuota 原样给的那句中文: 它已经按「还能继续、只是要确认」的
         口吻写好了，在这里改写会让一个照样点得动的按钮看起来像坏了。
    -->
    <div v-if="quotaPending" class="si-quota" role="alertdialog">
      <span class="si-quota-msg">{{ quotaPending.message }}</span>
      <div class="si-actions">
        <AppButton variant="primary" size="sm" :loading="busy" @click="confirmQuota">
          仍然生成
        </AppButton>
        <AppButton variant="ghost" size="sm" @click="dismissQuota">算了</AppButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scene-image {
  margin: var(--theme-spacing-md) 0;
}

/**
 * 🔴 按钮态 / 排队态 / 生成中态共用这一个外壳，于是它们**占同样高度** ——
 * 每张图落地时对话流不会跳。失败/已清理态也走这里，同理。
 */
.si-frame {
  display: flex;
  min-height: 132px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md, 6px);
  background: var(--theme-surface-muted);
  gap: var(--theme-spacing-xs);
  text-align: center;
}

.si-offer {
  width: 100%;
  border-color: color-mix(in srgb, var(--theme-primary) 25%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-surface-muted));
  color: inherit;
  cursor: pointer;
  font: inherit;
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}

.si-offer:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 12%, var(--theme-surface-muted));
}

.si-glyph {
  color: var(--theme-primary);
  font-size: 1.25rem;
  opacity: 0.7;
}

.si-title {
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  text-indent: 0;
}

.si-intent {
  max-width: 32em;
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  line-height: 1.55;
  text-indent: 0;
}

.si-status {
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
}

.si-error {
  color: var(--theme-error);
}

.si-action-label {
  margin-top: var(--theme-spacing-xs);
  color: var(--theme-primary);
  font-size: 0.75rem;
  font-weight: 600;
}

.si-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--theme-spacing-sm);
}

/* 转圈 —— 减少动态效果时停在原地（全局媒体查询也会兜一层，这里显式写出来） */
.si-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid color-mix(in srgb, var(--theme-primary) 30%, transparent);
  border-radius: 50%;
  border-top-color: var(--theme-primary);
  animation: si-spin 0.9s linear infinite;
}

@keyframes si-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .si-spinner {
    animation: none;
  }
  .si-offer {
    transition: none;
  }
}

.si-figure {
  margin: 0;
}

.si-canvas {
  position: relative;
}

.si-img {
  display: block;
  width: 100%;
  max-height: 60vh;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--paper-stack, 0 2px 8px rgba(0, 0, 0, 0.15));
  object-fit: contain;
}

.si-loading-bytes {
  width: 100%;
}

.si-take {
  position: absolute;
  right: var(--theme-spacing-sm);
  bottom: var(--theme-spacing-sm);
  padding: 2px 6px;
  border: 1px solid color-mix(in srgb, var(--theme-card-border) 60%, transparent);
  border-radius: var(--theme-radius-sm, 4px);
  background: color-mix(in srgb, var(--theme-window-bg) 70%, transparent);
  color: var(--theme-text-secondary);
  font-size: 0.6875rem;
}

.si-caption {
  display: flex;
  flex-direction: column;
  padding: var(--theme-spacing-xs) 0 0;
  gap: 2px;
  text-align: center;
}

.si-cap-title {
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
}

.si-cap-desc {
  color: var(--theme-text-muted);
  font-size: 0.75rem;
}

.si-hint {
  margin: var(--theme-spacing-xs) 0 0;
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  text-align: center;
  text-indent: 0;
}

.si-link {
  padding: 0 2px;
  border: 0;
  background: none;
  color: var(--theme-primary);
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
}

.si-prompt {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}

/* 限额确认（D24）—— 一条提醒，不是一堵墙。用 warning 色而非 error */
.si-quota {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 40%, var(--theme-card-border));
  border-radius: var(--theme-radius-md, 6px);
  background: color-mix(in srgb, var(--theme-warning) 8%, var(--theme-surface-muted));
  gap: var(--theme-spacing-sm);
  text-align: center;
}

.si-quota-msg {
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  line-height: 1.55;
  text-indent: 0;
}

.si-textarea {
  width: 100%;
  padding: var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-family: 'Cascadia Code', monospace;
  font-size: 0.75rem;
  resize: vertical;
}
</style>
