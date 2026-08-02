<script setup lang="ts">
import { computed } from 'vue';
import {
  compileBeautifierSegments,
  escapeHtmlBasic,
  type BeautifierMatchSegment,
} from '@engine/beautifier';
import type { BeautifierRule } from '@engine/types';
import { useBeautify } from '../../composables/useBeautify';
import BeautifierFrame from './BeautifierFrame.vue';

const props = withDefaults(
  defineProps<{
    text: string;
    rules?: BeautifierRule[];
    force?: boolean;
    streaming?: boolean;
    forwardContextMenu?: boolean;
    depth?: number;
  }>(),
  {
    rules: undefined,
    force: false,
    streaming: false,
    forwardContextMenu: false,
    depth: 0,
  },
);

const emit = defineEmits<{
  resize: [height: number];
}>();

const { getBeautifierRules, isBeautifierEnabled } = useBeautify();

const segments = computed(() => {
  if (!props.text) return [];
  // Incomplete matches change on nearly every token. Keep streaming output
  // readable and promote it to rich frames once the committed message arrives;
  // this also prevents legacy scripts from executing repeatedly mid-generation.
  if (props.streaming || (!props.force && !isBeautifierEnabled())) {
    return [{ kind: 'text' as const, text: props.text }];
  }
  return compileBeautifierSegments(props.text, 'maintext', props.rules ?? getBeautifierRules(), {
    depth: props.depth,
  });
});

function isMatch(segment: (typeof segments.value)[number]): segment is BeautifierMatchSegment {
  return segment.kind === 'match';
}

function isNativeMatch(segment: BeautifierMatchSegment): boolean {
  // This template is app-owned, contains only escaped captures, and relies on
  // the host's dialogue-card CSS. Every imported/user rich rule stays isolated.
  return segment.ruleId === 'builtin-dialogue-card';
}

const hasFrameContent = computed(() =>
  segments.value.some(
    (segment) => isMatch(segment) && Boolean(segment.replacement) && !isNativeMatch(segment),
  ),
);

/**
 * Upstream regex scripts share one message DOM. Keep that execution unit intact:
 * unmatched source is escaped, while authored replacements remain byte-for-byte
 * markup. A sole full-document replacement is returned without a wrapper so the
 * frame document splitter can retain its head/body structure.
 */
const frameMarkup = computed(() => {
  const visible = segments.value.filter(
    (segment) => segment.kind === 'match' || segment.text.trim().length > 0,
  );
  if (visible.length === 1 && visible[0].kind === 'match') return visible[0].replacement;

  return segments.value
    .map((segment) =>
      segment.kind === 'match'
        ? segment.replacement
        : `<span data-beautifier-source-text>${escapeHtmlBasic(segment.text)}</span>`,
    )
    .join('');
});

const frameRuleName = computed(() =>
  [
    ...new Set(
      segments.value
        .filter(
          (segment): segment is BeautifierMatchSegment =>
            isMatch(segment) && Boolean(segment.replacement) && !isNativeMatch(segment),
        )
        .map((segment) => segment.ruleName),
    ),
  ].join('、'),
);

function paragraphs(text: string): string[] {
  return text.split(/\n\n+/).filter((part, index, list) => part.length > 0 || list.length === 1);
}
</script>

<template>
  <div class="beautified-narrative">
    <BeautifierFrame
      v-if="hasFrameContent"
      :markup="frameMarkup"
      :rule-name="frameRuleName"
      :forward-context-menu="forwardContextMenu"
      @resize="emit('resize', $event)"
    />
    <template v-else v-for="(segment, index) in segments" :key="index">
      <template v-if="!isMatch(segment)">
        <p v-for="(paragraph, paragraphIndex) in paragraphs(segment.text)" :key="paragraphIndex">
          {{ paragraph }}
        </p>
      </template>
      <div
        v-else-if="segment.replacement && isNativeMatch(segment)"
        class="beautifier-native-match"
      >
        <div class="dialogue-card">
          <div class="dialogue-header">
            <span class="dialogue-avatar">{{ segment.captures[0] }}</span>
            <span class="dialogue-name">{{ segment.captures[0] }}</span>
          </div>
          <div class="dialogue-body">"{{ segment.captures[2] }}"</div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.beautified-narrative {
  min-width: 0;
}

.beautified-narrative p {
  margin: 0 0 0.6em;
  text-indent: 2em;
  white-space: pre-wrap;
}

.beautified-narrative p:last-child {
  margin-bottom: 0;
}

.beautifier-native-match :deep(.dialogue-card) {
  margin: 10px 0;
  padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--theme-primary) 22%, var(--theme-card-border));
  border-radius: var(--theme-radius-md, 8px);
  background: color-mix(in srgb, var(--theme-surface-muted) 80%, transparent);
}

.beautifier-native-match :deep(.dialogue-header) {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.beautifier-native-match :deep(.dialogue-avatar) {
  display: inline-flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--theme-primary) 16%, transparent);
  color: var(--theme-primary);
  font-size: 0.75rem;
  font-weight: 700;
}

.beautifier-native-match :deep(.dialogue-name) {
  color: var(--theme-primary);
  font-weight: 700;
}

.beautifier-native-match :deep(.dialogue-body) {
  color: var(--theme-text-primary);
  text-indent: 0;
}
</style>
