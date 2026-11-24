<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import {
  compileBeautifierSegments,
  DIALOGUE_CARD_RULE_ID,
  type BeautifierMatchSegment,
  type BeautifierSegment,
} from '@engine/story/beautifier';
import { splitSceneImageSegments } from '@engine/image/image-segments';
import type { BeautifierRule } from '@engine/types/types';
import type { ImageGenMode, ImageRating, SceneImageMarker } from '@engine/types/types-image';
import { useBeautify } from '../../composables/useBeautify';
import { useSceneImageStore } from '../../stores/scene-image-store';
import BeautifierFrame from './BeautifierFrame.vue';
import NarrativeParagraph, { type ParagraphMode, type TextRange } from './NarrativeParagraph.vue';
import { useFxEnabled } from '../../lib/fx-gate';
import { createRevealMemory, REVEAL_MS } from '../../lib/narrative-reveal';
import { scanNames, type NameIndex } from '../../lib/narrative-names';
import SceneImageSegment from './SceneImageSegment.vue';
import TurnSeal from './TurnSeal.vue';
import ActionPanel from './ActionPanel.vue';
import DialogueCard from './DialogueCard.vue';
import {
  parseActionPanel,
  rulesClaimActionInfo,
  splitActionInfo,
  type ActionPanel as ActionPanelData,
} from '../../lib/action-panel';

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
    /**
     * rating **上限**（D38），来自 `settings.imageMaxRating` —— 钳住标记写的 rating。
     * 缺省 `general`（最保守的一档）与设置默认值同步。
     */
    imageMaxRating?: ImageRating;
    /**
     * 打码显示（D46），来自 `settings.imageBlurByDefault`。
     *
     * 🔴 **本组件渲染两处 `SceneImageSegment`**（marker 段 + message-end 图带），
     * 这个 prop 必须两处都透传 —— 只改一处的表现是「有的图糊、有的不糊」，
     * 而不糊的那一张正是打码本来要挡住的那种场合。
     */
    imageBlurByDefault?: boolean;
    /**
     * 当前方言 id（C14），来自 `settings.imageDialectId`。与上一个 prop 同一条纪律：
     * **两处 `SceneImageSegment` 都要透传** —— 只改一处的表现是「有的图提示、有的不提示」，
     * 而漏掉的那一处照样会拿着为另一方言写的提示词去重画。
     */
    imageDialectId?: string;
    /**
     * 特效层的正文浮现方式（动效 v1）。缺省 `off` = 与改造前逐字节相同。
     * - `stream`：只让新追加的尾巴逐词洇开（`streaming` 为真时自动取这一档）
     * - `once`：整条一次到达的新消息，段落与卡片按块浮现一次
     * 特效闸门关闭时一律当 `off`。
     */
    reveal?: 'off' | 'stream' | 'once';
    /**
     * 这条新消息里「初次登场」的名字（ChatFlow 判定）。`index` 是全部已知名的索引，
     * 段内定位用它做最长匹配，免得在更长的已知名字内部划线。
     */
    mentions?: { names: readonly string[]; index: NameIndex };
    /**
     * 行末回合印记（ChatFlow 判定）：`off` 不盖 / `still` 静止 / `pressed` 刚落定时盖一下。
     * 🔴 是 prop 不是插槽：条件插槽会让父组件每次渲染都强制重渲染每一条历史正文
     *    （流式时每帧一次，闸门关着也一样）。prop 只在这一条的值真的变了才触发重渲染。
     */
    seal?: 'off' | 'still' | 'pressed';
    /**
     * 🆕 逐节演出（交互式推进）：本实例只渲染整条消息的**一节**时由 StagedNarrative 传入。
     * `<scene_image>` 的 occurrence 按整条消息计数（image-segments.ts 的不变式），所以要加上
     * 本节之前的图片数 `base`；侧链的「所属消息正文」用整条的 `narrative`；记录驱动的
     * message-end 图带只在 `tail`（末节）上画一次。缺省 = 本实例就是整条消息，行为不变。
     */
    imageSlice?: { base: number; narrative: string; tail: boolean };
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
    imageMaxRating: 'general',
    imageBlurByDefault: false,
    imageDialectId: '',
    reveal: 'off',
    mentions: undefined,
    seal: 'off',
    imageSlice: undefined,
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
  if (props.streaming || !beautifierActive()) {
    return [{ kind: 'text' as const, text }];
  }
  return compileBeautifierSegments(text, 'maintext', currentRules(), {
    depth: props.depth,
  });
}

function currentRules(): BeautifierRule[] {
  return props.rules ?? getBeautifierRules();
}

function beautifierActive(): boolean {
  return props.force || isBeautifierEnabled();
}

/**
 * `<action_info>` 面板拆分**常开**（Agent 与直出两种模式都生效），唯一例外：
 * 定稿消息、美化在生效（开关开或 `force`），且当前规则里有一条**启用的、scope 覆盖
 * maintext、深度范围含本条、能把本条正文里一整块 `<action_info>…</action_info>` 从头到尾
 * 匹配下来**的规则（判据见 `rulesClaimActionInfo`）—— 作者写了专门的面板美化，就让位给规则，
 * 整段文本原样交给美化管线。流式中美化本来就不跑，所以照常拆面板，定稿后再交给规则。
 */
const panelsYieldToRules = computed(
  () =>
    !props.streaming &&
    beautifierActive() &&
    rulesClaimActionInfo(currentRules(), props.text, 'maintext', props.depth),
);

type RenderPart =
  | { kind: 'panel'; panel: ActionPanelData }
  | { kind: 'prose'; segments: BeautifierSegment[] }
  | { kind: 'image'; occurrence: number; marker: SceneImageMarker };

/** 面板两侧的换行是标签外的排版字节，剥掉免得排出空段落（同 trimAroundImages 的道理） */
function trimAroundPanels(text: string): string {
  return text.replace(/^[\r\n]+|[\r\n]+$/g, '');
}

const parts = computed<RenderPart[]>(() => {
  if (!props.text) return [];
  const out: RenderPart[] = [];
  const yieldToRules = panelsYieldToRules.value;
  for (const segment of narrativeSegments.value) {
    if (segment.kind === 'image') {
      out.push({ kind: 'image', occurrence: segment.occurrence, marker: segment.marker });
      continue;
    }
    const text = trimAroundImages(segment.text);
    if (text === '') continue;
    if (yieldToRules) {
      out.push({ kind: 'prose', segments: beautify(text) });
      continue;
    }
    const pieces = splitActionInfo(text, { partial: props.streaming });
    if (!pieces.some((piece) => piece.kind === 'panel')) {
      // 没有面板：整段照旧（流式中裁掉的半截残标签除外），与改造前逐字节一致
      const prose = pieces.map((piece) => (piece.kind === 'text' ? piece.text : '')).join('');
      const body = props.streaming ? prose : text;
      if (body) out.push({ kind: 'prose', segments: beautify(body) });
      continue;
    }
    for (const piece of pieces) {
      if (piece.kind === 'panel') {
        const panel = parseActionPanel(piece.raw);
        if (panel.sections.length === 0) continue;
        // 有「行动者」行的直出战斗逐拍也交给 ActionPanel（它按 view.kind 画成交锋）
        out.push({ kind: 'panel', panel });
        continue;
      }
      const prose = trimAroundPanels(piece.text);
      if (prose.trim()) out.push({ kind: 'prose', segments: beautify(prose) });
    }
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
  if (id === undefined || props.imageSlice?.tail === false) return [];
  // 懒取 store: 没有 messageId 的用法（规则预览 / 流式草稿）根本不碰 Pinia
  const seen = new Set<number>();
  for (const record of useSceneImageStore().byMessage(id)) {
    if (record.anchorKind === 'message-end') seen.add(record.occurrence);
  }
  return [...seen].sort((a, b) => a - b);
});

// ===== 特效层（动效 v1）：墨迹浮现 / 名字下划线 / 行末印记 =====

const fxEnabled = useFxEnabled();

/** 实际生效的浮现档：闸门关 → off；流式草稿 → stream */
const effectiveReveal = computed<'off' | 'stream' | 'once'>(() => {
  if (!fxEnabled.value) return 'off';
  return props.streaming ? 'stream' : props.reveal;
});

/** 交错上限：第 8 块之后不再往后排（与 --motion-stagger-step 相乘） */
const INK_ORDER_CAP = 8;
/** 与 `--motion-stagger-step` 同值，只用来算撤类名的时机 */
const STAGGER_STEP_MS = 36;

/**
 * `once` 只在挂载时生效一次：动画放完就撤掉类名，落定后的 DOM 与不开特效时相同。
 * 之后 props 再变（润色、重渲染）也不重播。
 */
const onceActive = ref(effectiveReveal.value === 'once');
let onceTimer: ReturnType<typeof setTimeout> | null = null;
if (onceActive.value) {
  onceTimer = setTimeout(
    () => {
      onceActive.value = false;
      onceTimer = null;
    },
    REVEAL_MS + INK_ORDER_CAP * STAGGER_STEP_MS + 120,
  );
}
onBeforeUnmount(() => {
  if (onceTimer !== null) clearTimeout(onceTimer);
});

/** 流式段落的跨重挂记忆（每个草稿实例一份） */
const revealMemory = createRevealMemory();

function paragraphKey(partIndex: number, segmentIndex: number, paragraphIndex: number): string {
  return `${partIndex}-${segmentIndex}-${paragraphIndex}`;
}

interface ParagraphPlan {
  order: number;
  marks: TextRange[];
}

/**
 * 一次遍历给出每个正文段落的交错序号、名字下划线区间与末段 key。
 * 闸门关时一步不走（历史消息不付这份成本）。
 */
const paragraphPlan = computed(() => {
  const plans = new Map<string, ParagraphPlan>();
  let lastKey: string | null = null;
  let lastIsParagraph = false;
  if (!fxEnabled.value) return { plans, lastKey };
  const pending = new Set(props.mentions?.names ?? []);
  const index = props.mentions?.index;
  let order = 0;
  parts.value.forEach((part, partIndex) => {
    if (part.kind !== 'prose') {
      lastIsParagraph = false;
      return;
    }
    part.segments.forEach((segment, segmentIndex) => {
      if (isMatch(segment)) {
        lastIsParagraph = false;
        return;
      }
      paragraphs(segment.text).forEach((paragraph, paragraphIndex) => {
        const key = paragraphKey(partIndex, segmentIndex, paragraphIndex);
        const marks: TextRange[] = [];
        if (index && pending.size > 0) {
          for (const match of scanNames(paragraph, index)) {
            if (!pending.has(match.name)) continue;
            pending.delete(match.name);
            marks.push({ start: match.start, end: match.end });
          }
        }
        plans.set(key, { order: Math.min(order++, INK_ORDER_CAP), marks });
        lastKey = key;
        lastIsParagraph = true;
      });
    });
  });
  return { plans, lastKey: lastIsParagraph ? lastKey : null };
});

/** 要不要盖行末印记：挂在最后一个正文段落末尾；最后一块不是段落时另起一行 */
const hasSeal = computed(() => fxEnabled.value && props.seal !== 'off');

/** 这个段落要不要交给 NarrativeParagraph（否则按原样渲染裸 `<p>`） */
function paragraphNeedsFx(key: string): boolean {
  if (!fxEnabled.value) return false;
  if (effectiveReveal.value === 'stream') return true;
  if (effectiveReveal.value === 'once' && onceActive.value) return true;
  if (hasSeal.value && paragraphPlan.value.lastKey === key) return true;
  return (paragraphPlan.value.plans.get(key)?.marks.length ?? 0) > 0;
}

function paragraphMode(): ParagraphMode {
  if (effectiveReveal.value === 'stream') return 'stream';
  if (effectiveReveal.value === 'once' && onceActive.value) return 'ink';
  return 'plain';
}

function planOf(key: string): ParagraphPlan | undefined {
  return paragraphPlan.value.plans.get(key);
}

/** 美化框 / 对话卡片在 `once` 档整块浮现，不逐词（行动面板走自己的入场） */
const blockInkClass = computed(() =>
  effectiveReveal.value === 'once' && onceActive.value ? 'fx-ink-block' : undefined,
);

function isMatch(segment: BeautifierSegment): segment is BeautifierMatchSegment {
  return segment.kind === 'match';
}

function isNativeMatch(segment: BeautifierMatchSegment): boolean {
  // 内置对话卡片不走规则的 replacement，由宿主 DialogueCard 组件按捕获组文本插值渲染
  // （名字 / 情绪 / 台词），吃宿主主题样式；其余导入 / 用户的富规则一律进隔离框。
  return segment.ruleId === DIALOGUE_CARD_RULE_ID;
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
  // 两张对话卡片 / 面板之间只剩换行时不出空段落，否则卡片之间多出一行空隙
  if (stripped.trim() === '') return [];
  return stripped
    .split(/\n\n+/)
    .filter((part, index, list) => part.length > 0 || list.length === 1);
}
</script>

<template>
  <div class="beautified-narrative">
    <template v-for="(part, partIndex) in parts" :key="partIndex">
      <!-- `<action_info>` 行动面板：once 档交给面板自己的样式入场（不叠 fx-ink-block，两段动画会互相覆盖） -->
      <ActionPanel
        v-if="part.kind === 'panel'"
        :panel="part.panel"
        :entrance="effectiveReveal === 'once' && onceActive"
      />
      <!-- 正文标记切出来的图片段（anchorKind: 'marker'） -->
      <SceneImageSegment
        v-if="part.kind === 'image' && messageId !== undefined"
        :message-id="messageId"
        :occurrence="part.occurrence + (imageSlice?.base ?? 0)"
        anchor-kind="marker"
        :mode="imageMode"
        :turn="turn"
        :marker="part.marker"
        :narrative="imageSlice?.narrative ?? strippedNarrative"
        :max-rating="imageMaxRating"
        :blur-by-default="imageBlurByDefault"
        :dialect-id="imageDialectId"
      />
      <template v-for="(segment, index) in part.kind === 'prose' ? part.segments : []" :key="index">
        <template v-if="!isMatch(segment)">
          <template
            v-for="(paragraph, paragraphIndex) in paragraphs(segment.text)"
            :key="paragraphIndex"
          >
            <NarrativeParagraph
              v-if="paragraphNeedsFx(paragraphKey(partIndex, index, paragraphIndex))"
              :text="paragraph"
              :mode="paragraphMode()"
              :order="planOf(paragraphKey(partIndex, index, paragraphIndex))?.order ?? 0"
              :marks="planOf(paragraphKey(partIndex, index, paragraphIndex))?.marks"
              :memory="revealMemory"
              :memory-key="paragraphKey(partIndex, index, paragraphIndex)"
            >
              <template
                v-if="
                  hasSeal &&
                  paragraphPlan.lastKey === paragraphKey(partIndex, index, paragraphIndex)
                "
                #default
              >
                <TurnSeal :pressed="seal === 'pressed'" />
              </template>
            </NarrativeParagraph>
            <p v-else>
              {{ paragraph }}
            </p>
          </template>
        </template>
        <BeautifierFrame
          v-else-if="segment.replacement && !isNativeMatch(segment)"
          :markup="segment.replacement"
          :rule-name="segment.ruleName"
          :forward-context-menu="forwardContextMenu"
          :class="blockInkClass"
          :scripts="scriptPolicy(segment)"
          @resize="emit('resize', $event)"
        />
        <div
          v-else-if="segment.replacement && isNativeMatch(segment)"
          class="beautifier-native-match"
          :class="blockInkClass"
        >
          <DialogueCard
            :name="segment.captures[0] ?? ''"
            :mood="segment.captures[1]"
            :body="segment.captures[2] ?? ''"
          />
        </div>
      </template>
    </template>

    <!-- 行末印记：最后一块不是正文段落（美化框 / 卡片 / 插画）时另起一行，仍是行内元素 -->
    <div v-if="hasSeal && paragraphPlan.lastKey === null && parts.length > 0" class="narrative-end">
      <TurnSeal :pressed="seal === 'pressed'" />
    </div>

    <!-- 🔴 记录驱动的图带，追加在段落之后（§10.2b）—— 不经过分段器 -->
    <SceneImageSegment
      v-for="occurrence in messageEndOccurrences"
      :key="`message-end-${occurrence}`"
      :message-id="messageId ?? ''"
      :occurrence="occurrence"
      anchor-kind="message-end"
      :mode="imageMode"
      :turn="turn"
      :narrative="imageSlice?.narrative ?? strippedNarrative"
      :max-rating="imageMaxRating"
      :blur-by-default="imageBlurByDefault"
      :dialect-id="imageDialectId"
    />
  </div>
</template>

<style scoped>
.beautified-narrative {
  min-width: 0;
}

.narrative-end {
  text-align: end;
  line-height: 1;
}

.beautified-narrative p {
  margin: 0 0 0.6em;
  text-indent: 2em;
  white-space: pre-wrap;
}

.beautified-narrative p:last-child {
  margin-bottom: 0;
}

/* 对话卡片与行动面板的样式归各自组件（DialogueCard.vue / ActionPanel.vue），这里不再叠 :deep 规则 */
</style>
