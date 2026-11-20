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
 * - 控制条（全文 / 快进 / 全部显示）不在这里：2026-11-20 起由 ChatFlow 挂在输入框上方（StageControls.vue）。
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
  },
);

const emit = defineEmits<{
  resize: [height: number];
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
</style>
