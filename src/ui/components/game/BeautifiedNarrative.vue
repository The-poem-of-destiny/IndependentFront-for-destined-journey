<script setup lang="ts">
import { computed } from 'vue';
import {
  compileBeautifierSegments,
  type BeautifierMatchSegment,
  type BeautifierSegment,
} from '@engine/beautifier';
import { splitSceneImageSegments } from '@engine/image-segments';
import type { BeautifierRule } from '@engine/types';
import type { ImageGenMode, SceneImageMarker } from '@engine/types-image';
import { useBeautify } from '../../composables/useBeautify';
import { useSceneImageStore } from '../../stores/scene-image-store';
import BeautifierFrame from './BeautifierFrame.vue';
import SceneImageSegment from './SceneImageSegment.vue';

const props = withDefaults(
  defineProps<{
    text: string;
    rules?: BeautifierRule[];
    force?: boolean;
    streaming?: boolean;
    forwardContextMenu?: boolean;
    depth?: number;
    /**
     * 这段正文属于哪条消息。**省略 = 没有锚点**（流式草稿、规则预览），此时插画
     * 标记照样被剥掉，但一格都不渲染 —— 没有 messageId 就没有记录可挂。
     */
    messageId?: string;
    /** 所属消息的 turn（限额 L3 的同回合去重键） */
    turn?: number;
    /** 三档开关；缺省 `off` = 这个子系统在 UI 上完全不存在（真值表第一行） */
    imageMode?: ImageGenMode;
  }>(),
  {
    rules: undefined,
    force: false,
    streaming: false,
    forwardContextMenu: false,
    depth: 0,
    messageId: undefined,
    turn: 0,
    imageMode: 'off',
  },
);

const emit = defineEmits<{
  resize: [height: number];
}>();

const { getBeautifierRules, isBeautifierEnabled } = useBeautify();

/**
 * 🔴 **分段在美化之前，且 always-on、不看美化开关**（D3 / §10.1）。
 *
 * 两个后果都是想要的:
 * - 美化关掉、或流式输出途中，`<scene_image>` 也**绝不会漏成一行尖括号**给玩家看见
 * - 美化规则不会跨过一张插画去匹配（一条规则不该把插图吞进替换里）
 */
const narrativeSegments = computed(() => splitSceneImageSegments(props.text));

const hasImageSegments = computed(() =>
  narrativeSegments.value.some((segment) => segment.kind === 'image'),
);

/**
 * 标记左右那些换行是**正文的字节**，分段器刻意原样留着（它不替渲染层做排版决定）。
 * 这里做那个决定: 标记独占一行时，剥掉之后剩下的首尾换行会各排出一个空段落，把
 * 插画上下各顶开一大块。**只在真的切出了图片段时才收边**，没有标记的正文一个
 * 字节都不动（那是绝大多数消息，行为与改造前逐字节一致）。
 */
function trimAroundImages(text: string): string {
  return hasImageSegments.value ? text.replace(/^[\r\n]+|[\r\n]+$/g, '') : text;
}

/** 美化仍受开关 / 流式约束 —— 这一层没变，变的只是它现在**逐个文本段**跑 */
function beautify(text: string): BeautifierSegment[] {
  // Incomplete matches change on nearly every token. Keep streaming output
  // readable and promote it to rich frames once the committed message arrives;
  // this also prevents legacy scripts from executing repeatedly mid-generation.
  if (props.streaming || (!props.force && !isBeautifierEnabled())) {
    return [{ kind: 'text' as const, text }];
  }
  return compileBeautifierSegments(text, 'maintext', props.rules ?? getBeautifierRules(), {
    depth: props.depth,
  });
}

type RenderPart =
  | { kind: 'prose'; segments: BeautifierSegment[] }
  | { kind: 'image'; occurrence: number; marker: SceneImageMarker };

const parts = computed<RenderPart[]>(() => {
  if (!props.text) return [];
  const out: RenderPart[] = [];
  for (const segment of narrativeSegments.value) {
    if (segment.kind === 'image') {
      out.push({ kind: 'image', occurrence: segment.occurrence, marker: segment.marker });
      continue;
    }
    const text = trimAroundImages(segment.text);
    if (text === '') continue;
    out.push({ kind: 'prose', segments: beautify(text) });
  }
  return out;
});

/** 喂给侧链的「所属消息正文」—— 已剥掉全部标记（§8.5 要的就是这个） */
const strippedNarrative = computed(() =>
  narrativeSegments.value
    .filter(
      (segment): segment is Extract<typeof segment, { kind: 'text' }> => segment.kind === 'text',
    )
    .map((segment) => segment.text)
    .join('')
    .trim(),
);

/**
 * 消息末尾那条图带（D33 / §10.2b）。
 *
 * 🔴 **它不走 `splitSceneImageSegments`** —— 玩家从右键菜单主动要的图在正文里没有
 * 对应字节，是**由记录驱动**、在段落渲染完之后追加的。两条路径刻意不合并，否则
 * 分段器要去关心它看不到的东西。
 */
const messageEndOccurrences = computed<number[]>(() => {
  const id = props.messageId;
  if (id === undefined) return [];
  // 懒取 store: 没有 messageId 的用法（规则预览 / 流式草稿）根本不碰 Pinia
  const seen = new Set<number>();
  for (const record of useSceneImageStore().byMessage(id)) {
    if (record.anchorKind === 'message-end') seen.add(record.occurrence);
  }
  return [...seen].sort((a, b) => a - b);
});

function isMatch(segment: BeautifierSegment): segment is BeautifierMatchSegment {
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
    <template v-for="(part, partIndex) in parts" :key="partIndex">
      <!-- 正文标记切出来的图片段（anchorKind: 'marker'） -->
      <SceneImageSegment
        v-if="part.kind === 'image' && messageId !== undefined"
        :message-id="messageId"
        :occurrence="part.occurrence"
        anchor-kind="marker"
        :mode="imageMode"
        :turn="turn"
        :marker="part.marker"
        :narrative="strippedNarrative"
      />

      <template v-for="(segment, index) in part.kind === 'prose' ? part.segments : []" :key="index">
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
    </template>

    <!-- 🔴 记录驱动的图带，追加在段落之后（§10.2b）—— 不经过分段器 -->
    <SceneImageSegment
      v-for="occurrence in messageEndOccurrences"
      :key="`message-end-${occurrence}`"
      :message-id="messageId ?? ''"
      :occurrence="occurrence"
      anchor-kind="message-end"
      :mode="imageMode"
      :turn="turn"
      :narrative="strippedNarrative"
    />
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
