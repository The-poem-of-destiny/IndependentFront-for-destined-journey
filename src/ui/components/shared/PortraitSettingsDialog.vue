<script setup lang="ts">
/**
 * PortraitSettingsDialog — 画像的**唯一**调节面
 *
 * 画像本身（{@link CharacterPortrait}）现在是干净的一张图，不带任何按钮或徽章。
 * 「调取景 / 换图」这两件事全部收到这一个弹窗里 —— 上一版把旋钮和相机徽章
 * 盖在画像上、再弹一层浮层盖住画像自己，等于让用户一边调一边看不见调的结果。
 *
 * 这里**同时是预览台**: 左边那张就是 `CharacterPortrait` 本体（不是另画一份
 * 近似效果），滑块拖到哪它就长什么样。预览与真身共用一个组件，是"所见即所得"
 * 唯一可信的写法 —— 复制一份预览样式，迟早会与真身漂开。
 *
 * 🔴 **落库防抖，且欠账连 id 一起记。** 一次拖拽产生几十上百个 `input`，逐个写
 * Dexie 既拖慢拖拽本身，也会让 `refreshAssets()` 在拖拽中途反复重建索引。
 * 而只记「脏了」、落库时现读 `props.assetId` 是个真陷阱: 换角色/换图那一刻补写，
 * 会把上一张图的取景写到新那条上。关窗与卸载都必须补掉欠账，否则最后 300ms 的
 * 调整会凭空丢掉。
 *
 * 📌 **换图不在这里实现**，只发 `replace` 事件。文件字节的分流（图片进裁剪台、
 * mp4 直通）在调用方，而调用方**本来就有**一条同样的路径（画像上没有素材时
 * 点一下直接开文件框）。两处各写一遍就是两套会漂开的规则。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  ASSET_FRAMING_MAX_SCALE,
  ASSET_FRAMING_MIN_SCALE,
  clampAssetFraming,
} from '@engine/asset-types';
import { DEFAULT_ASSET_FRAMING, type AssetFraming } from '@engine/types';
import { useAssetStore } from '../../stores/asset-store';
import AppButton from './AppButton.vue';
import AppModal from './AppModal.vue';
import CharacterPortrait from './CharacterPortrait.vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** 角色名 —— 标题与 alt 用，本组件从不改名 */
    name: string;
    /** 预览用的 object URL */
    src?: string | null;
    /** 这份字节是 mp4 吗（由**行**判定，别嗅 URL） */
    video?: boolean;
    /** 取景写回哪一条。null = 没有落点，滑块整体禁用 */
    assetId?: string | null;
    /** 库里存的取景，**可以是任意来路的垃圾**，交给 clamp 收敛 */
    framing?: AssetFraming | null;
  }>(),
  { src: null, video: false, assetId: null, framing: null },
);

const emit = defineEmits<{
  (e: 'close'): void;
  /** 「更换图片」—— 字节分流归调用方，这里只说"用户要换" */
  (e: 'replace'): void;
}>();

const assets = useAssetStore();

/** 拖动期间的本地覆盖 —— 落库是防抖的，但画面必须**当帧**跟手 */
const draft = ref<AssetFraming | null>(null);

/** 交给预览的那一份，**永远夹逼过** */
const framing = computed<AssetFraming>(() => clampAssetFraming(draft.value ?? props.framing));

/** 没有落点就没法写回 —— 滑块禁用而不是藏起来，藏起来只会让人以为这里坏了 */
const editable = computed(() => props.assetId !== null);

// ═══ 落库 ═══════════════════════════════════════════════════

const PERSIST_DEBOUNCE_MS = 300;
let timer: number | undefined;
/** 欠着的那一笔，**连 id 一起记**（见文件头） */
let pending: { id: string; framing: AssetFraming } | null = null;

/** 立刻落库（防抖到点、换图、关窗或卸载时补写）。没有欠账就什么都不做 */
function flushPersist(): void {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  const owed = pending;
  pending = null;
  if (owed === null) return;
  // store 自己会再夹逼一次（写入侧收敛），这里给的已经是夹过的
  void assets.setAssetFraming(owed.id, owed.framing);
}

function schedulePersist(): void {
  const id = props.assetId;
  if (id === null) return;
  pending = { id, framing: framing.value };
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(flushPersist, PERSIST_DEBOUNCE_MS);
}

/**
 * 换了一条素材就丢掉草稿 —— 否则上一张的取景会挂在下一张脸上，
 * 而下一次拖动会把它当作「用户对这张图的选择」落库。
 * 先补掉欠**上一条**的那一笔（`pending` 记的是当时的 id）。
 */
watch(
  () => props.assetId,
  () => {
    flushPersist();
    draft.value = null;
  },
);

/** 关窗（含被调用方收起去让位给裁剪台）一律补写，草稿归零 */
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) return;
    flushPersist();
    draft.value = null;
  },
);

onBeforeUnmount(flushPersist);

// ═══ 滑块 ═══════════════════════════════════════════════════

/** 滑块 → 草稿。`valueAsNumber` 在空值时是 NaN，照样交给 clamp 兜（见文件头） */
function onSlide(key: keyof AssetFraming, e: Event): void {
  const raw = (e.target as HTMLInputElement).valueAsNumber;
  draft.value = { ...framing.value, [key]: raw };
  schedulePersist();
}

function reset(): void {
  draft.value = { ...DEFAULT_ASSET_FRAMING };
  schedulePersist();
}

function close(): void {
  emit('close');
}

function replace(): void {
  emit('replace');
}
</script>

<template>
  <AppModal :open="open" :title="`画像 · ${name}`" size="lg" @update:open="close">
    <div class="ps-grid">
      <!-- 预览就是真身本体，不是另画一份近似效果 -->
      <div class="ps-preview">
        <CharacterPortrait :name="name" :src="src" :video="video" :framing="framing">
          <span class="ps-blank" aria-hidden="true">—</span>
        </CharacterPortrait>
      </div>

      <div class="ps-controls">
        <h5 class="ps-label">取景</h5>

        <label class="ps-row">
          <span class="ps-name">水平</span>
          <input
            class="ps-range"
            type="range"
            min="0"
            max="100"
            step="1"
            :value="framing.x"
            :disabled="!editable"
            aria-label="水平位置"
            @input="onSlide('x', $event)"
          />
          <span class="ps-value">{{ Math.round(framing.x) }}%</span>
        </label>

        <label class="ps-row">
          <span class="ps-name">垂直</span>
          <input
            class="ps-range"
            type="range"
            min="0"
            max="100"
            step="1"
            :value="framing.y"
            :disabled="!editable"
            aria-label="垂直位置"
            @input="onSlide('y', $event)"
          />
          <span class="ps-value">{{ Math.round(framing.y) }}%</span>
        </label>

        <label class="ps-row">
          <span class="ps-name">缩放</span>
          <input
            class="ps-range"
            type="range"
            :min="ASSET_FRAMING_MIN_SCALE"
            :max="ASSET_FRAMING_MAX_SCALE"
            step="0.05"
            :value="framing.scale"
            :disabled="!editable"
            aria-label="缩放倍数"
            @input="onSlide('scale', $event)"
          />
          <span class="ps-value">{{ framing.scale.toFixed(2) }}×</span>
        </label>

        <p class="ps-hint">
          取景只影响这张图在状态栏里的呈现，不改动素材本身的字节。
          <template v-if="!editable">当前没有可调取景的素材，先换一张图。</template>
        </p>
      </div>
    </div>

    <template #footer>
      <AppButton variant="ghost" class="ps-reset" :disabled="!editable" @click="reset"
        >复位</AppButton
      >
      <AppButton variant="secondary" class="ps-replace" @click="replace">更换图片</AppButton>
      <AppButton variant="primary" @click="close">完成</AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.ps-grid {
  display: flex;
  align-items: flex-start;
  gap: var(--theme-spacing-lg);
  flex-wrap: wrap;
}
.ps-preview {
  flex: 0 1 16rem;
  min-width: 12rem;
}
.ps-blank {
  color: var(--theme-text-muted);
  opacity: 0.5;
}
.ps-controls {
  flex: 1 1 14rem;
  min-width: 12rem;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
}

/* design.md §5.1 Section 标题装饰线 */
.ps-label {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.ps-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}

.ps-row {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  min-height: 36px;
  cursor: pointer;
}
.ps-name {
  flex-shrink: 0;
  width: 2.5rem;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.ps-range {
  flex: 1;
  min-width: 0;
  accent-color: var(--theme-primary);
  cursor: pointer;
}
.ps-range:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.ps-range:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}
.ps-value {
  flex-shrink: 0;
  width: 3rem;
  text-align: right;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  font-variant-numeric: tabular-nums;
}
.ps-hint {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-text-muted);
}

/* 复位靠左，换图/完成留在右侧 —— 破坏性最小的那个不该挨着主按钮 */
.ps-reset {
  margin-right: auto;
}
</style>
