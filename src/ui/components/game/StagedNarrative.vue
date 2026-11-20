<script setup lang="ts">
/**
 * StagedNarrative — 一条直出正文（或流式草稿）按节放出（交互式推进 T6）
 *
 * 只画、不判：切节与进度来自 `lib/stage-playback.ts` 的 view，登场名单由 ChatFlow 按名册锁定后传入。
 *
 * - 每节一个 BeautifiedNarrative。本实例挂载前读者已看过的节（`settledEnd` 之前起头的，
 *   即草稿交接带过来的那些）静默显示；之后放出的节用 `reveal="once"` 浮现一次。
 * - 插画：`<scene_image>` 的 occurrence 按整条消息计数，所以每节带上「本节之前的图片数」，
 *   侧链拿整条正文；记录驱动的 message-end 图带只挂在全文末节 —— 不重复、不错位。
 *   草稿不传 messageId（与原草稿一致：标记照剥，不画插画格）。
 * - 节内某段落正文只放出一半（临时段落切换成模型断点时）按游标截断，已放出的字不回退。
 * - 名字下划线只给该名字首次出现的那一节，避免每节各划一次。
 */
import { computed } from 'vue';
import { splitSceneImageSegments } from '@engine/image/image-segments';
import type { ImageGenMode, ImageRating } from '@engine/types/types-image';
import type { NameIndex } from '../../lib/narrative-names';
import type { StagePlaybackView, StageSection } from '../../lib/stage-playback';
import BeautifiedNarrative from './BeautifiedNarrative.vue';
import CharacterEntrance from './CharacterEntrance.vue';

const props = withDefaults(
  defineProps<{
    view: StagePlaybackView;
    /** 整条正文（剥过 `<beat/>`），用于插画计数与名字首现定位 */
    content: string;
    /** 本实例挂载前读者已看到的正文末尾偏移；起点在它之前的节静默显示 */
    settledEnd?: number;
    /** 节序号 → 该节之前要登场的人物名 */
    entrances?: ReadonlyMap<number, readonly string[]>;
    /** 早先已经演过的登场：卡片因润色等换了位置重挂时静态显示，不再画一遍 */
    stillEntrances?: ReadonlySet<string>;
    messageId?: string;
    turn?: number;
    depth?: number;
    forwardContextMenu?: boolean;
    imageMode?: ImageGenMode;
    imageMaxRating?: ImageRating;
    imageBlurByDefault?: boolean;
    imageDialectId?: string;
    mentions?: { names: readonly string[]; index: NameIndex };
    seal?: 'off' | 'still' | 'pressed';
    /** 追上进度、下文未到时的提示（只有流式草稿会等） */
    waitingText?: string;
    /** 末尾的小条（全文 / 快进 / 全部显示）—— 只给正在演的那一条 */
    controls?: boolean;
    fastForwarding?: boolean;
  }>(),
  {
    settledEnd: 0,
    entrances: () => new Map(),
    stillEntrances: () => new Set(),
    messageId: undefined,
    turn: 0,
    depth: 0,
    forwardContextMenu: false,
    imageMode: 'off',
    imageMaxRating: 'general',
    imageBlurByDefault: false,
    imageDialectId: '',
    mentions: undefined,
    seal: 'off',
    waitingText: '',
    controls: false,
    fastForwarding: false,
  },
);

const emit = defineEmits<{
  resize: [height: number];
  'show-full': [];
  'fast-forward': [];
  'skip-all': [];
}>();

const revealed = computed(() => props.view.sections.slice(0, props.view.revealedCount));

/** 本节要显示的文字：整节，或游标截在节内时只到游标 */
function textOf(section: StageSection): string {
  if (props.view.visibleEnd >= section.end) return section.text;
  return props.content.slice(section.start, props.view.visibleEnd).replace(/\s+$/, '');
}

const imageCounts = computed(() => {
  if (props.messageId === undefined) return new Map<number, number>();
  const counts = new Map<number, number>();
  for (const section of props.view.sections) {
    const before = splitSceneImageSegments(props.content.slice(0, section.start)).filter(
      (segment) => segment.kind === 'image',
    ).length;
    counts.set(section.index, before);
  }
  return counts;
});

const strippedNarrative = computed(() =>
  splitSceneImageSegments(props.content)
    .map((segment) => (segment.kind === 'text' ? segment.text : ''))
    .join('')
    .trim(),
);

function imageSliceOf(section: StageSection) {
  if (props.messageId === undefined) return undefined;
  return {
    base: imageCounts.value.get(section.index) ?? 0,
    narrative: strippedNarrative.value,
    tail: section.index === props.view.sections.length - 1,
  };
}

/** 名字 → 首次出现的节序号 */
const mentionSections = computed(() => {
  const owner = new Map<string, number>();
  for (const name of props.mentions?.names ?? []) {
    const at = props.content.indexOf(name);
    if (at < 0) continue;
    const section = props.view.sections.find((s) => at >= s.start && at < s.end);
    if (section) owner.set(name, section.index);
  }
  return owner;
});

function mentionsOf(section: StageSection) {
  const mentions = props.mentions;
  if (!mentions) return undefined;
  const names = mentions.names.filter((name) => mentionSections.value.get(name) === section.index);
  return names.length > 0 ? { names, index: mentions.index } : undefined;
}

function isSettled(section: StageSection): boolean {
  return section.start < props.settledEnd;
}

function sealOf(section: StageSection): 'off' | 'still' | 'pressed' {
  return props.view.finished && section.index === props.view.sections.length - 1
    ? props.seal
    : 'off';
}
</script>

<template>
  <div class="staged-narrative" :data-stage-revealed="view.revealedCount">
    <template v-for="section in revealed" :key="section.index">
      <CharacterEntrance
        v-for="name in entrances.get(section.index) ?? []"
        :key="`enter-${section.index}-${name}`"
        :name="name"
        :animate="!isSettled(section) && !stillEntrances.has(name)"
      />
      <BeautifiedNarrative
        class="stage-section"
        :text="textOf(section)"
        :depth="depth"
        :forward-context-menu="forwardContextMenu"
        :message-id="messageId"
        :turn="turn"
        :image-mode="imageMode"
        :image-max-rating="imageMaxRating"
        :image-blur-by-default="imageBlurByDefault"
        :image-dialect-id="imageDialectId"
        :image-slice="imageSliceOf(section)"
        :reveal="isSettled(section) ? 'off' : 'once'"
        :mentions="mentionsOf(section)"
        :seal="sealOf(section)"
        @resize="emit('resize', $event)"
      />
    </template>

    <p v-if="view.waiting && waitingText" class="stage-waiting" role="status" aria-live="polite">
      <span class="stage-waiting-dots" aria-hidden="true">···</span>
      {{ waitingText }}
    </p>

    <div v-if="controls" class="stage-bar" role="group" aria-label="正文演出">
      <span v-if="view.canAdvance" class="stage-hint">点击正文或按空格继续</span>
      <span class="stage-bar-actions">
        <span class="stage-mode" role="group" aria-label="正文显示方式">
          <button type="button" class="stage-btn" :aria-pressed="false" @click="emit('show-full')">
            全文
          </button>
          <button type="button" class="stage-btn is-current" :aria-pressed="true" disabled>
            演出
          </button>
        </span>
        <button
          type="button"
          class="stage-btn"
          :aria-pressed="fastForwarding"
          :class="{ 'is-current': fastForwarding }"
          @click="emit('fast-forward')"
        >
          <i class="fa-solid fa-forward" aria-hidden="true" /> 快进
        </button>
        <button type="button" class="stage-btn" @click="emit('skip-all')">
          <i class="fa-solid fa-forward-fast" aria-hidden="true" /> 全部显示
        </button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.stage-section + .stage-section,
.stage-entrance + .stage-section {
  margin-top: 0.6em;
}

.stage-waiting {
  margin: 0.8em 0 0;
  text-indent: 0;
  color: var(--theme-text-muted);
  font-family: var(--theme-font-body);
  font-size: 0.8125rem;
}
.stage-waiting-dots {
  display: inline-block;
  margin-right: 0.4em;
  color: color-mix(in srgb, var(--theme-primary) 60%, transparent);
  animation: stage-breathe 1.6s var(--motion-ease-standard) infinite alternate;
}
@keyframes stage-breathe {
  from {
    opacity: 0.35;
  }
  to {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .stage-waiting-dots {
    animation: none;
  }
}

.stage-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm, 8px);
  margin-top: 0.9em;
  padding-top: 0.5em;
  border-top: 1px solid color-mix(in srgb, var(--theme-primary) 14%, var(--theme-card-border));
  font-family: var(--theme-font-body);
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  opacity: 0.72;
  transition: opacity var(--motion-duration-fast) var(--motion-ease-standard);
}
.stage-bar:hover,
.stage-bar:focus-within {
  opacity: 1;
}
.stage-hint {
  letter-spacing: 0.04em;
}
.stage-bar-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.stage-mode {
  display: inline-flex;
}
.stage-mode .stage-btn:first-child {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.stage-mode .stage-btn:last-child {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  border-left-width: 0;
}
.stage-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: transparent;
  color: var(--theme-text-secondary);
  font: inherit;
  cursor: pointer;
  transition:
    color var(--motion-duration-fast) var(--motion-ease-standard),
    border-color var(--motion-duration-fast) var(--motion-ease-standard),
    background-color var(--motion-duration-fast) var(--motion-ease-standard);
}
.stage-btn:hover:not(:disabled) {
  color: var(--theme-text-primary);
  border-color: color-mix(in srgb, var(--theme-primary) 40%, var(--theme-card-border));
}
.stage-btn.is-current {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-text-primary);
}
.stage-btn:disabled {
  cursor: default;
}
</style>
