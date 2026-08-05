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
  // HTML 注释（<!-- ... -->）是元数据：AI 的 itemThink/taskThink 思考块、作者注释等，
  // 不应当正文显示。Vue 的 {{ }} 会把它当字面文本转义后原样显示，很诡异——这里先剥离。
  // 用 [\s\S]*? 懒惰匹配，跨多行 + 多条注释（/g）都能一次清掉。
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '');
  return stripped.split(/\n\n+/).filter((part, index, list) => part.length > 0 || list.length === 1);
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
          <span class="dialogue-name">{{ segment.captures[0] }}</span>
          <div class="dialogue-body">{{ segment.captures[2] }}</div>
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

/* === 对话卡片 · 血色玫瑰窗 / 圣物匣风（仿 crimson reliquary） ===
   走 native 渲染（宿主 DOM），直接用 --theme-* 变量。
   拱形顶 + 双层描边（外卡边 + ::before 内嵌古金线）+ 顶部金色辉光 +
   ::after 渐变血色短线 + 名字旁血红宝石点（::before on name）+ inset 层次 */
.beautifier-native-match :deep(.dialogue-card) {
  position: relative;
  margin: var(--theme-spacing-md, 8px) 0;
  padding: 10px 16px 8px;
  background:
    radial-gradient(ellipse 80% 60% at 50% 0%, rgba(194, 163, 111, 0.08), transparent 70%),
    var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: 12px 12px 3px 3px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    inset 0 -1px 0 rgba(0, 0, 0, 0.25),
    var(--theme-shadow-sm);
}

.beautifier-native-match :deep(.dialogue-card)::before {
  content: '';
  position: absolute;
  inset: 3px;
  border: 1px solid rgba(194, 163, 111, 0.28);
  border-radius: 9px 9px 2px 2px;
  pointer-events: none;
}

.beautifier-native-match :deep(.dialogue-card)::after {
  content: '';
  position: absolute;
  top: -1px;
  left: 50%;
  transform: translateX(-50%);
  width: 28px;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--theme-primary), transparent);
  opacity: 0.6;
}

.beautifier-native-match :deep(.dialogue-name) {
  display: block;
  font-family: var(--theme-font-title, serif);
  font-size: 0.85em;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--theme-primary);
  text-shadow: 0 0 10px rgba(194, 163, 111, 0.25);
  margin-bottom: 4px;
}

.beautifier-native-match :deep(.dialogue-name)::before {
  content: '◆';
  color: var(--theme-primary);
  margin-right: 7px;
  font-size: 0.75em;
  opacity: 0.85;
}

.beautifier-native-match :deep(.dialogue-body) {
  color: var(--theme-text-primary);
  font-family: var(--theme-font-body, var(--theme-font-title, serif));
  line-height: 1.85;
  text-indent: 0;
}

</style>
