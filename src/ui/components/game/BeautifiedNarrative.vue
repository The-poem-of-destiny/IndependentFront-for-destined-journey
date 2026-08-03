<script setup lang="ts">
import { computed } from 'vue';
import { compileBeautifierSegments, type BeautifierMatchSegment } from '@engine/beautifier';
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

/**
 * 模型合成的卡片（`<item_info>` / `<task_info>`）不给脚本面。
 *
 * 隔离框够不到宿主是一回事，**该不该给这条正文脚本执行 + 网络出口**是另一回事：
 * 模型正文会被世界书 / 角色卡 / 工坊文案里的注入牵着走，而 story 预设的卡片本来就只有
 * div/b/span + 内联 style，不需要脚本。规则片段（用户自己装的）保持全开不变。
 */
function scriptPolicy(segment: BeautifierMatchSegment): 'allow' | 'block' {
  return segment.origin === 'model' ? 'block' : 'allow';
}

function paragraphs(text: string): string[] {
  return text.split(/\n\n+/).filter((part, index, list) => part.length > 0 || list.length === 1);
}
</script>

<template>
  <div class="beautified-narrative">
    <template v-for="(segment, index) in segments" :key="index">
      <template v-if="!isMatch(segment)">
        <p v-for="(paragraph, paragraphIndex) in paragraphs(segment.text)" :key="paragraphIndex">
          {{ paragraph }}
        </p>
      </template>
      <BeautifierFrame
        v-else-if="segment.replacement && !isNativeMatch(segment)"
        :markup="segment.replacement"
        :rule-name="segment.ruleName"
        :forward-context-menu="forwardContextMenu"
        :scripts="scriptPolicy(segment)"
        @resize="emit('resize', $event)"
      />
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
