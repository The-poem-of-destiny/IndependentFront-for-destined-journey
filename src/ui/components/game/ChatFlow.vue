<script setup lang="ts">
import { effectiveMaxRating } from '@engine/image/image-prompt';
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import InputBar from './InputBar.vue';
import type { AgentActivityRun, ChatMessage, SystemEvent } from '@engine/types/types';
import { isDirectMode } from '@engine/story/generation-mode';
import { escapeHtml } from '@engine/story/beautifier';
import { resolveStoryStage } from '@engine/story/story-beats';
import { splitSceneImageSegments } from '@engine/image/image-segments';
import { getMapPack } from '@engine/map/map-runtime';
import { useSettingsStore } from '../../stores/settings-store';
import { useGameStore, type TimelineRestoreResult } from '../../stores/game-store';
import { confirmDialog } from '../../lib/confirm-dialog';
import { activityRunSideTaskLabel } from '../../lib/agent-activity';
import {
  findUnfinishedTurn,
  groupDiscardedAttempts,
  isDiscardedAttempt,
} from '../../lib/turn-recovery';
import TurnRecoveryPanel from './TurnRecoveryPanel.vue';
import { useUIStore } from '../../stores/ui-store';
import { useSceneImageStore } from '../../stores/scene-image-store';
import { useManualSceneImage } from '../../composables/useManualSceneImage';
import { computeConversationalDepths } from '../../lib/chat-depth';
import { useFxEnabled } from '../../lib/fx-gate';
import {
  buildNameIndex,
  collectKnownNames,
  findFirstMentions,
  type NameIndex,
} from '../../lib/narrative-names';
import { useFreshMessages } from '../../composables/useFreshMessages';
import {
  useStagedPlayback,
  type PlaybackRecord,
  type StageTarget,
  type StreamingStageSnapshot,
} from '../../composables/useStagedPlayback';
import { resolveEntrances, type StageRosterEntry } from '../../lib/stage-entrance';
import type { StagePlaybackView } from '../../lib/stage-playback';
import { hasOpenDialog } from '../../lib/modal-focus';
import StagedNarrative from './StagedNarrative.vue';
import StateUpdateBlock from './StateUpdateBlock.vue';
import { shouldShowUpdateBlock } from './state-update-view';
import StageControls from './StageControls.vue';
import AppButton from '../shared/AppButton.vue';
import AppModal from '../shared/AppModal.vue';
import BeautifiedNarrative from './BeautifiedNarrative.vue';
import TurnActivityLedger from './TurnActivityLedger.vue';
import CraftSystemCard from './cards/CraftSystemCard.vue';
import CharGenSystemCard from './cards/CharGenSystemCard.vue';
import CombatSystemCard from './cards/CombatSystemCard.vue';
import ItemSystemCard from './cards/ItemSystemCard.vue';
import SystemNotifBar from './cards/SystemNotifBar.vue';
import type { Component } from 'vue';

const CARD_COMPONENTS: Record<string, Component> = {
  craft: CraftSystemCard,
  char_gen: CharGenSystemCard,
  combat: CombatSystemCard,
  item_gen: ItemSystemCard,
};

const props = defineProps<{
  messages?: ChatMessage[];
  isGenerating?: boolean;
  systemEventsVisible?: boolean;
  systemEventFilters?: Record<string, boolean>;
  streamingText?: string;
  /** 流式分节快照（交互式推进）：只在直出模式有值，见 GamePage 的 streamingStage */
  streamingStage?: StreamingStageSnapshot | null;
}>();

const emit = defineEmits<{
  send: [content: string];
  'select-option': [text: string];
  stop: [];
  'retry-turn': [messageId: string];
}>();

const settings = useSettingsStore();
const s = settings.settings;
const game = useGameStore();
const ui = useUIStore();
const sceneImages = useSceneImageStore();

const container = ref<HTMLDivElement>();
const expandedIds = ref<Record<string, boolean>>({});
const pinnedToBottom = ref(true);
const messageDepths = computed(() => computeConversationalDepths(props.messages ?? []));
const activityRunsByMessage = computed(() => {
  const grouped = new Map<string, AgentActivityRun[]>();
  for (const run of game.agentActivityRuns ?? []) {
    if (!run.sourceMessageId) continue;
    const runs = grouped.get(run.sourceMessageId);
    if (runs) runs.push(run);
    else grouped.set(run.sourceMessageId, [run]);
  }
  return grouped;
});

/** 滚到底部（进存档 / 新消息 / 快照回退时调用）。nextTick 等本轮 DOM 落定。 */
function scrollToBottom() {
  nextTick(() => {
    const el = container.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// 新消息是 `messages.value.push` —— 数组原地变更，只有 length 会变，靠它触发。
watch(
  () => props.messages?.length,
  () => scrollToBottom(),
);

// 载入存档 / 快照回退是 `messages.value = await getMessages(...)` —— 整体换数组，
// **长度可能完全不变**（回到同一轮），length watcher 不会触发，必须盯数组引用。
watch(
  () => props.messages,
  () => scrollToBottom(),
);

watch(
  () => props.streamingText,
  () => {
    if (pinnedToBottom.value) handleNarrativeResize();
  },
);

function formatTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function messageDepth(id: string): number {
  return messageDepths.value.get(id) ?? 0;
}

function toggleExpand(id: string) {
  if (expandedIds.value[id]) {
    collapseCard(id);
  } else {
    expandedIds.value = { ...expandedIds.value, [id]: true };
  }
}

function collapseCard(id: string) {
  // 整体替换对象确保 Vue 3 响应式追踪
  const next: Record<string, boolean> = {};
  for (const key of Object.keys(expandedIds.value)) {
    if (key !== id) next[key] = expandedIds.value[key];
  }
  expandedIds.value = next;
}

function isComplexEvent(type: string): boolean {
  return type === 'craft' || type === 'char_gen' || type === 'combat' || type === 'item_gen';
}

/** 该系统事件是否应该显示 */
function isEventVisible(ev: SystemEvent): boolean {
  if (!props.systemEventsVisible) return false;
  if (props.systemEventFilters && ev.type in props.systemEventFilters) {
    return props.systemEventFilters[ev.type];
  }
  return true; // 未知类型默认显示
}

function eventIconClass(type: string): string {
  const icons: Record<string, string> = {
    craft: 'fa-solid fa-hammer',
    char_gen: 'fa-solid fa-user-plus',
    item_gen: 'fa-solid fa-gift',
    combat: 'fa-solid fa-swords' /* Font Awesome 6 pro — 降级为 fa-hand-fist */,
    character_update: 'fa-solid fa-arrow-trend-up',
    item_update: 'fa-solid fa-boxes-stacked',
    quest_update: 'fa-solid fa-list-check',
  };
  return icons[type] ?? 'fa-solid fa-circle-info';
}

function handleChatScroll() {
  const el = container.value;
  if (!el) return;
  pinnedToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  closeCtxMenu();
}

function handleNarrativeResize() {
  if (!pinnedToBottom.value) return;
  nextTick(() => {
    const el = container.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// ===== 特效层（动效 v1）：新消息浮现 / 名字初次登场 / 回合印记 =====
/**
 * 🔴 闸门关闭时这一节对模板零影响：`revealFor` 回 off、`mentionsFor` 回 undefined、
 *    不渲染印记、不加 `bubble-row-settled` —— 输出与改造前相同。
 *
 * 流式 → 提交的交接：草稿（`streamingText` 那一行）与正式消息是**两个不同的组件实例**。
 * 草稿在提交前就被清空、那一行随之卸载；正式消息随后 push 进数组。`useFreshMessages`
 * 记住它这一代生成流式过，于是正式消息不再浮现（`reveal = off`），也不重播
 * `.bubble-row` 的 msg-enter —— 读者刚在草稿里看完这些字，提交只是静默换成正式版。
 */
const fxEnabled = useFxEnabled();
const freshMessages = useFreshMessages({
  messages: () => props.messages,
  isGenerating: () => !!props.isGenerating,
  streamingText: () => props.streamingText,
});

/** 新消息怎么浮现：整条一次到达 → once；流式过 / 历史 → off */
function revealFor(msg: ChatMessage): 'off' | 'once' {
  if (!fxEnabled.value || !freshMessages.isFresh(msg.id)) return 'off';
  return freshMessages.wasStreamed(msg.id) ? 'off' : 'once';
}

/** 流式提交的那一条：跳过 msg-enter（草稿里已经看过一遍） */
function skipsEnter(msg: ChatMessage): boolean {
  return fxEnabled.value && freshMessages.wasStreamed(msg.id);
}

/**
 * 「名字初次登场」只算一次、只给新消息，按 id 缓存在本组件实例里（会话内，不落库）。
 * 已知名单与早先正文都在**第一次**判定时现取 —— 新消息很少，历史一条都不碰。
 */
const mentionCache = new Map<string, { names: readonly string[]; index: NameIndex } | null>();

function mentionsFor(msg: ChatMessage): { names: readonly string[]; index: NameIndex } | undefined {
  if (!fxEnabled.value || !freshMessages.isFresh(msg.id)) return undefined;
  let cached = mentionCache.get(msg.id);
  if (cached === undefined) {
    const list = props.messages ?? [];
    const at = list.findIndex((m) => m.id === msg.id);
    const names = collectKnownNames({
      characters: game.characters ?? [],
      mapTileNames: getMapPack().tiles.map((tile) => tile.name),
    });
    const index = buildNameIndex(names);
    const earlier = list.slice(0, at < 0 ? list.length : at).map((m) => m.content);
    const found = findFirstMentions(msg.content, index, earlier);
    cached = found.length > 0 ? { names: found, index } : null;
    mentionCache.set(msg.id, cached);
  }
  return cached ?? undefined;
}

// ===== 逐节演出（交互式推进 T6）=====
/**
 * 只对「开关开 × 直出模式 × 本次会话新到的故事正文」演出；其余一律原渲染（关掉开关时 DOM 与引入前一致）。
 * 进度簿在 `useStagedPlayback`，这里只管名册、输入与快进节拍。
 */
const stagedEnabled = () => s.stagedNarrative !== false && isDirectMode(game.generationMode);
const staged = useStagedPlayback({
  enabled: stagedEnabled,
  messages: () => props.messages,
  isGenerating: () => !!props.isGenerating,
  streamingText: () => props.streamingText,
  streamingStage: () => props.streamingStage,
  fresh: freshMessages,
});
const { draftView, draftEpoch, holdOptions: holdStageOptions } = staged;

/** 草稿行走演出：开关开、正在生成、草稿里有正文（流结束清预览后仍保留，直到正式消息领走） */
const stagedDraft = computed<PlaybackRecord | null>(() => {
  const record = staged.draft.value;
  if (!stagedEnabled() || !props.isGenerating || record === null) return null;
  return record.state.input.content.trim().length > 0 ? record : null;
});

function stagedViewOf(msg: ChatMessage): StagePlaybackView | null {
  return staged.viewFor(msg);
}

/**
 * 本楼状态更新块的显示时机（§12.4）：与行动选项相同 —— 逐节演出放完才出现；
 * 流式期间消息还是 pending，`shouldShowUpdateBlock` 本身就不放行。
 */
function showsUpdateBlock(msg: ChatMessage): boolean {
  const view = stagedViewOf(msg);
  return shouldShowUpdateBlock(msg, !view || view.finished);
}

function stagedSettledEnd(msg: ChatMessage): number {
  return staged.recordFor(msg)?.settledEnd ?? 0;
}

/** 登场名册条目：名字 + 别名 */
function rosterEntryOf(character: { name: string; aliases?: string[] }): StageRosterEntry {
  return { name: character.name, aliases: character.aliases };
}

/**
 * 开楼时的名册（草稿用）：生成开始那一刻的全部角色。sync —— 赶在本回合任何建档之前拍下。
 * 正式消息不用它：按 `introducedBy === 回合键` 把本楼新建的角色分出来（direct-output 的 add_character）。
 */
let generationRoster: StageRosterEntry[] | null = null;
watch(
  () => !!props.isGenerating,
  (generating, was) => {
    if (generating && !was) generationRoster = (game.characters ?? []).map(rosterEntryOf);
  },
  { flush: 'sync' },
);

/** 本条消息的登场名册：开楼名册 + 本楼新建（正式消息按 `introducedBy === 回合键` 分） */
function entranceRosters(msg: ChatMessage | null): {
  roster: StageRosterEntry[];
  created: StageRosterEntry[];
} {
  const characters = game.characters ?? [];
  if (!msg) return { roster: generationRoster ?? characters.map(rosterEntryOf), created: [] };
  const key = msg.storyTurnKey ?? msg.id;
  return {
    roster: characters.filter((c) => c.introducedBy !== key).map(rosterEntryOf),
    created: characters.filter((c) => c.introducedBy === key).map(rosterEntryOf),
  };
}

/** 一个登场名连同名册里同一人物的全部名字（播出时钉住，之后靠它认人、去重） */
function entranceNamesOf(name: string): string[] {
  const owner = (game.characters ?? []).find(
    (c) => c.name === name || (c.aliases ?? []).includes(name),
  );
  return [...new Set([name, ...(owner ? [owner.name, ...(owner.aliases ?? [])] : [])])];
}

/** 已钉住的登场卡当前该在哪一节：先认 enter 标记，再认名字首现，都没有就留在原处 */
function locatePinned(
  names: readonly string[],
  fallback: number,
  enters: readonly { name: string; at: number }[],
  sections: StagePlaybackView['sections'],
): number {
  const mark = enters.find((enter) => names.includes(enter.name.trim()));
  if (mark) {
    const hit = sections.find((s) => mark.at >= s.start && mark.at < s.end);
    return hit ? hit.index : sections.length - 1;
  }
  const mention = sections.find((s) => names.some((name) => s.text.includes(name)));
  return mention ? mention.index : Math.min(fallback, sections.length - 1);
}

interface StageEntrances {
  /** 节序号 → 该节之前登场的人物 */
  bySection: ReadonlyMap<number, readonly string[]>;
  /** 早先已经演过的名字（卡片换位重挂时静态显示） */
  still: ReadonlySet<string>;
}

/**
 * 已放出各节的登场卡 ——「演过就不再撤回」：
 *
 * - 已播出的卡钉在账本里（播出时的名字 + 同一人物的别名），之后无论名册回读、接纳状态、
 *   是否在生成都保持显示；位置每次按当前的节重新定位（临时段落换模型断点、润色挪节起点都跟着走）；
 * - 还没演的按现规则判定（名字不在开楼名册里就演，不拿新建名单过滤），且只在所在节是上次判定
 *   之后才放出的时候演 ——「已读过就不演」；
 * - 草稿交接时账本随记录带走。
 */
function entrancesFor(
  record: PlaybackRecord,
  view: StagePlaybackView,
  msg: ChatMessage | null,
): StageEntrances {
  const book = record.entrances;
  const still = new Set(book.pinned.keys());
  const sections = view.sections;
  const enters = msg ? resolveStoryStage(msg.content, msg.stage).enters : record.state.input.enters;
  const bySection = new Map<number, string[]>();
  const place = (index: number, name: string) => {
    if (index < 0 || index >= view.revealedCount) return;
    bySection.set(index, [...(bySection.get(index) ?? []), name]);
  };

  const taken = new Set<string>();
  for (const [name, entry] of book.pinned) {
    if (sections.length === 0) break;
    entry.section = locatePinned(entry.names, entry.section, enters, sections);
    for (const n of entry.names) taken.add(n);
    place(entry.section, name);
  }

  const { roster, created } = entranceRosters(msg);
  for (const entrance of resolveEntrances(enters, roster, created, sections)) {
    const names = entranceNamesOf(entrance.name);
    if (names.some((n) => taken.has(n))) continue;
    const section = sections[entrance.sectionIndex];
    if (entrance.sectionIndex >= view.revealedCount || section.start < book.evaluatedEnd) continue;
    book.pinned.set(entrance.name, { names, section: entrance.sectionIndex });
    for (const n of names) taken.add(n);
    place(entrance.sectionIndex, entrance.name);
  }

  book.evaluatedEnd = Math.max(book.evaluatedEnd, view.visibleEnd);
  return { bySection, still };
}

const NO_ENTRANCES: StageEntrances = { bySection: new Map(), still: new Set() };

/**
 * 同一份输入在多次渲染里只判定一次：判定会写账本，再判一次会把刚演的名字当成「早先演过」，
 * 卡片就不画了。输入 = 视图 + 名册（store 可能原地 push，连长度一起比）。
 */
const entranceCache = new WeakMap<
  PlaybackRecord,
  { view: StagePlaybackView; characters: unknown; count: number; result: StageEntrances }
>();

function messageEntrances(msg: ChatMessage): StageEntrances {
  const record = staged.recordFor(msg);
  const view = staged.viewFor(msg);
  if (!record || !view) return NO_ENTRANCES;
  const characters = game.characters;
  const count = characters?.length ?? 0;
  const hit = entranceCache.get(record);
  if (hit && hit.view === view && hit.characters === characters && hit.count === count) {
    return hit.result;
  }
  const result = entrancesFor(record, view, msg);
  entranceCache.set(record, { view, characters, count, result });
  return result;
}

const draftEntrances = computed<StageEntrances>(() => {
  const record = stagedDraft.value;
  const view = draftView.value;
  return record && view ? entrancesFor(record, view, null) : NO_ENTRANCES;
});

function advanceStage(): boolean {
  const advanced = staged.advance();
  if (advanced) handleNarrativeResize();
  return advanced;
}

function skipStage(target?: StageTarget) {
  stopFastForward();
  staged.skipAll(target);
  handleNarrativeResize();
}

/** 「全文」：关掉演出（全局设置），所有消息回到整段显示 */
function showFullText() {
  stopFastForward();
  s.stagedNarrative = false;
  ui.toast('已切换为全文显示，可在「设置 → 消息显示」重新开启演出', 'info');
}

/** 发送新输入：先把还在演的全部放完，再交给 GamePage */
function sendInput(content: string) {
  stopFastForward();
  staged.skipEverything();
  emit('send', content);
}

// ---- 快进：按住 Ctrl，或点小条上的「快进」 ----
const FAST_FORWARD_MS = 220;
const fastForwarding = ref<'key' | 'button' | null>(null);
let fastForwardTimer: ReturnType<typeof setInterval> | null = null;

function stepFastForward() {
  const current = staged.active.value;
  if (!current) {
    stopFastForward();
    return;
  }
  if (advanceStage()) return;
  // 按钮快进放到追上就停；按住 Ctrl 时还在流式，就等下文到了接着放
  if (fastForwarding.value === 'button' && !current.view.waiting) stopFastForward();
}

function startFastForward(source: 'key' | 'button') {
  fastForwarding.value = source;
  if (fastForwardTimer !== null) return;
  stepFastForward();
  if (fastForwarding.value !== null)
    fastForwardTimer = setInterval(stepFastForward, FAST_FORWARD_MS);
}

function stopFastForward() {
  fastForwarding.value = null;
  if (fastForwardTimer !== null) clearInterval(fastForwardTimer);
  fastForwardTimer = null;
}

function toggleFastForward() {
  if (fastForwarding.value !== null) stopFastForward();
  else startFastForward('button');
}

// ---- 输入：Space / Enter 推进、按住 Ctrl 快进、End 全部显示、左键点正文推进 ----
/** 点在这些东西上 / 焦点在这些东西里时，按键与点击归它们自己 */
const STAGE_YIELD_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'label',
  'summary',
  'iframe',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="link"]',
  '.system-notif',
  '.system-card-wrapper',
  '.combat-beat',
  '.action-panel-card',
  '.dialogue-card',
  '.scene-image',
  '.turn-actions',
  '.stage-bar',
  '.ctx-menu',
].join(', ');

function stageYields(target: EventTarget | null): boolean {
  if (ctxMenu.value !== null || hasOpenDialog() || game.activeModal != null || game.isInCombat) {
    return true;
  }
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
  if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) return true;
  return target instanceof Element && target.closest(STAGE_YIELD_SELECTOR) !== null;
}

/**
 * 按住 Ctrl 快进：单独按住超过 `CTRL_HOLD_MS`、期间没按别的键也没滚轮，才进入快进；松开即停。
 * 🔴 单按一下 Ctrl 本身不推进 —— Ctrl+F / Ctrl+R / Ctrl+滚轮缩放都以 Ctrl 起手，
 *    一按下就推进会把这些快捷键全变成误触。
 */
const CTRL_HOLD_MS = 300;
let ctrlHoldTimer: ReturnType<typeof setTimeout> | null = null;

function cancelCtrlHold() {
  if (ctrlHoldTimer !== null) clearTimeout(ctrlHoldTimer);
  ctrlHoldTimer = null;
  if (fastForwarding.value === 'key') stopFastForward();
}

function onStageKeydown(e: KeyboardEvent) {
  if (e.key === 'Control') {
    if (e.repeat || ctrlHoldTimer !== null || fastForwarding.value === 'key') return;
    if (e.altKey || e.metaKey || e.shiftKey || e.isComposing) return;
    if (!staged.active.value || stageYields(e.target)) return;
    ctrlHoldTimer = setTimeout(() => {
      ctrlHoldTimer = null;
      if (staged.active.value && !stageYields(null)) startFastForward('key');
    }, CTRL_HOLD_MS);
    return;
  }
  // 按住 Ctrl 期间按了别的键 = 别的意图（复制、查找、刷新）：取消快进，不抢
  cancelCtrlHold();
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
  if (!staged.active.value) return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.key !== ' ' && e.key !== 'Enter' && e.key !== 'End') return;
  if (stageYields(e.target)) return;
  if (e.key === 'End') {
    e.preventDefault();
    skipStage();
    return;
  }
  if (advanceStage()) e.preventDefault();
}

function onStageKeyup(e: KeyboardEvent) {
  if (e.key === 'Control') cancelCtrlHold();
}

/** 滚轮（含 Ctrl+滚轮缩放）一律取消按住 Ctrl 的快进 */
function onStageWheel() {
  if (ctrlHoldTimer !== null || fastForwarding.value === 'key') cancelCtrlHold();
}

function onStageBlur() {
  cancelCtrlHold();
}

function onStageClick(e: MouseEvent) {
  if (e.button !== 0 || e.defaultPrevented) return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (!staged.active.value || stageYields(e.target)) return;
  advanceStage();
}

/**
 * 战斗摘要行（game-pipeline 的战斗终局回注）。它显式传空标记落库，既无 `storyTurnStatus`
 * 也无 `diagnostic`，结构上与旧存档里无状态的正文没有区别 —— 只能认它固定的前缀。
 * 🔴 窄判据：只认行首这一个字面量，别扩成「含【…】」之类的模糊匹配（正文里完全可能出现）。
 */
const COMBAT_SUMMARY_PREFIX = '【战斗摘要】';

/**
 * 回合印记：完成了的、未作废的故事正文才盖。
 * 不盖：pending / 已废弃的尝试；`diagnostic` 行（`[系统] …部分状态未能写入` 一类通知与
 * craft_gen 叙述，都经 emitMessage 的默认标记带 `diagnostic: true`）；战斗摘要行。
 */
function showsSeal(msg: ChatMessage): boolean {
  return (
    fxEnabled.value &&
    msg.role === 'assistant' &&
    !msg.diagnostic &&
    msg.storyTurnStatus !== 'pending' &&
    !isDiscardedAttempt(msg) &&
    !msg.content.startsWith(COMBAT_SUMMARY_PREFIX) &&
    msg.content.trim().length > 0
  );
}

/**
 * 刚刚完成的那一回合：`isGenerating` 由真转假时盖一次印。
 *
 * 🔴 只盖**这一代生成里新到**、且已被正式接纳（`accepted`）的那条故事正文。生成开始时记下
 *    当时最新一条 assistant 的 id，结束时只在它之后找 —— 回合失败 / 被中止时之后没有新的
 *    accepted 正文，于是什么都不盖（否则会把上一回合的印再盖一遍）。
 */
const pressedSealId = ref<string | null>(null);
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let generationBaselineId: string | null = null;

/**
 * 交给 BeautifiedNarrative 的印记档。🔴 走 prop 不走条件插槽：条件插槽让每条历史正文在
 * ChatFlow 每次渲染时（流式时每帧）都被强制重渲染，闸门关着也一样。
 */
function sealFor(msg: ChatMessage): 'off' | 'still' | 'pressed' {
  if (!showsSeal(msg)) return 'off';
  return pressedSealId.value === msg.id ? 'pressed' : 'still';
}

function findPressTarget(): ChatMessage | undefined {
  const list = props.messages ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (msg.id === generationBaselineId) return undefined;
    if (
      msg.role === 'assistant' &&
      msg.storyTurnStatus === 'accepted' &&
      freshMessages.isFresh(msg.id) &&
      showsSeal(msg)
    ) {
      return msg;
    }
  }
  return undefined;
}

watch(
  () => !!props.isGenerating,
  (generating, wasGenerating) => {
    if (generating) {
      if (!wasGenerating) generationBaselineId = latestAssistantMsg.value?.id ?? null;
      return;
    }
    if (!wasGenerating || !fxEnabled.value) return;
    const msg = findPressTarget();
    if (!msg) return;
    pressedSealId.value = msg.id;
    if (pressTimer !== null) clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressedSealId.value = null;
      pressTimer = null;
    }, 900);
  },
);

// ===== 右键菜单（回退 / 复制 / 为这一段配图）=====
/**
 * 🔴 菜单项**按消息过滤**（D33）：
 *
 * - 回退 —— 只在**最新一条**消息上出现：assistant 消息「回退本轮」（撤回该轮、
 *   恢复上一轮快照、把输入回填输入框）；user 消息「回退到这条输入」（正文没生成
 *   或报错时，正文都点不到，正好右键自己的输入撤回重发）。对着三屏之前的消息给
 *   它，语义是空的。
 * - 为这一段配图 —— **哪条都行**。story 被教了「克制使用」，所以"AI 没配图但我想要
 *   这一刻"必然存在，而付钱的是玩家。
 * - 🔴 `off` 档下配图项**不出现**。整个功能关掉时右键里还留着一个能开始花钱的入口，
 *   是「关掉了但没完全关掉」那类最招人烦的 bug。
 *
 * 一项能做的都没有时**不拦浏览器默认右键** —— 选中文字复制仍然是这里最常用的操作。
 */
const ctxMenu = ref<{
  x: number;
  y: number;
  msgId: string;
  role: ChatMessage['role'];
  canRollback: boolean;
  canImage: boolean;
  canRewrite: boolean;
  canRestore: boolean;
} | null>(null);

/** 最新一条 assistant 消息（「回退本轮」仅对它生效）；已废弃的尝试不算（GAME-10） */
const latestAssistantMsg = computed<ChatMessage | undefined>(() => {
  const list = props.messages ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'assistant' && !isDiscardedAttempt(list[i])) return list[i];
  }
  return undefined;
});

/**
 * 已废弃的尝试（GAME-10）：重试后旧输出被标成 failed 但仍在列表里。连续的几条折成
 * 一行「已废弃的尝试（N）」，默认收起；它们没有操作条、没有右键、不画插画。
 */
const discarded = computed(() => groupDiscardedAttempts(props.messages ?? []));
const discardedOpen = ref<Record<string, boolean>>({});
function toggleDiscarded(id: string) {
  discardedOpen.value = { ...discardedOpen.value, [id]: !discardedOpen.value[id] };
}

/** 最新一条 user 消息（user 消息上「回退到这条输入」仅对它生效） */
const latestUserMsg = computed<ChatMessage | undefined>(() => {
  const list = props.messages ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'user') return list[i];
  }
  return undefined;
});

function activityRunsForMessage(messageId: string) {
  return activityRunsByMessage.value.get(messageId) ?? [];
}

/**
 * 🆕 「思考中」指示（2026-08-12）：生成期间显示当前 Agent 正在做什么。
 * 数据源：game.currentAgentActivityRun（running/stopping 的最新活动 run），
 * 取最新 running step 的 label（如「书写此刻」「推演战局」）+ 最新 tool 的
 * 友好文案（presentToolActivity 的 label）。无活动时兜底「正在构思…」。
 */
const thinkingText = computed(() => {
  const run = game.currentAgentActivityRun;
  if (!run) return '正在构思…';
  // 最新 running step（没有则取整个 run 的最后一个 step）
  const step =
    [...run.steps].reverse().find((s) => s.status === 'running') ?? run.steps[run.steps.length - 1];
  if (!step) return '正在构思…';
  const tool = step.tools[step.tools.length - 1];
  if (tool) return `${step.label} · ${tool.label}`;
  return step.label;
});

function canRetryRun(run: AgentActivityRun): boolean {
  const messageId = run.sourceMessageId;
  if (
    !messageId ||
    props.isGenerating ||
    game.isRewriting ||
    (run.status !== 'failed' && run.status !== 'cancelled') ||
    // 润色等手动侧链不是回合：它失败了「重试」会把整回合重发一遍（GAME-17）
    activityRunSideTaskLabel(run) !== null
  ) {
    return false;
  }
  const messageRuns = activityRunsForMessage(messageId).filter(
    (entry) => activityRunSideTaskLabel(entry) === null,
  );
  return (
    latestUserMsg.value?.id === messageId && messageRuns[messageRuns.length - 1]?.id === run.id
  );
}

/**
 * 回退 / 重新生成可不可用 —— 与 `game.rollbackOneTurn` 同一条判据：
 * 要回到「上一回合结束时」的快照，当前回合至少得是第 2 回合。开场回合不提供这两项，
 * 并在操作条上写明原因（GAME-15：此前是先给出入口、点了再 toast 拒绝）。
 */
const latestTurnRollbackable = computed(() => (latestUserMsg.value?.turn ?? 0) >= 2);
const OPENING_TURN_NOTE = '开场回合不能回退或重新生成';

/**
 * 最新一回合的最后一条消息（跳过系统卡片）—— 可见操作条只挂在它下面（GAME-04）。
 * 是正文 → 重新生成 / 回退 / 润色 / 配图 / 复制；是玩家输入（回合失败或被中止，
 * 没有正文）→ 「回退到这条输入」。
 */
const latestTurnMsg = computed<ChatMessage | undefined>(() => {
  const list = props.messages ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const role = list[i].role;
    if (role === 'user' || (role === 'assistant' && !isDiscardedAttempt(list[i]))) return list[i];
  }
  return undefined;
});

/**
 * GAME-09：回合没完成、而内存里的回合记录已经没了（去过设置页 / 刷新 / 切过存档）——
 * 从持久化状态推导出来，在那条输入下面立一条「上一回合未完成」横幅。
 */
const unfinishedTurn = computed(() =>
  findUnfinishedTurn(props.messages ?? [], {
    isGenerating: !!props.isGenerating,
    hasLiveRecord: (id) =>
      activityRunsForMessage(id).some((run) => activityRunSideTaskLabel(run) === null),
  }),
);

const UNFINISHED_MESSAGES = {
  failed: '上一回合没有完成。',
  interrupted: '上一回合在生成途中被中断，没有完成。',
  'no-reply': '这句输入还没有得到回应。',
} as const;

/** 操作条显示在这条消息下面吗（生成中 / 战斗中整条收起，那时一个都点不了） */
function showTurnActions(msg: ChatMessage): boolean {
  return latestTurnMsg.value?.id === msg.id && !props.isGenerating && !game.isAgentCombat;
}

function menuFor(msg: ChatMessage): {
  canRollback: boolean;
  canImage: boolean;
  canRewrite: boolean;
  canRestore: boolean;
} {
  // user 消息：只有最新一条能回退；「为这一段配图」是给正文的，user 上不出现
  if (msg.role === 'user') {
    return {
      canRollback: latestUserMsg.value?.id === msg.id && latestTurnRollbackable.value,
      canImage: false,
      canRewrite: false,
      canRestore: false,
    };
  }
  // 已废弃的尝试：什么都不给（不回退、不润色、不配图 —— 它已经不是故事的一部分）
  if (isDiscardedAttempt(msg)) {
    return { canRollback: false, canImage: false, canRewrite: false, canRestore: false };
  }
  const isLatest = latestAssistantMsg.value?.id === msg.id;
  return {
    canRollback: isLatest && latestTurnRollbackable.value,
    canImage: s.imageGenMode !== 'off',
    // 正文润色只对**最新一条**正文开放（改写的是「当前这一幕」，不是历史消息）
    canRewrite: isLatest && msg.content.trim().length > 0,
    canRestore: msg.preRewriteContent !== undefined,
  };
}

/** 这条消息上右键有没有事可做（也决定要不要把美化框里的右键转发上来） */
function canOpenMenu(msg: ChatMessage): boolean {
  if (game.isAgentCombat || props.isGenerating) return false;
  const can = menuFor(msg);
  return can.canRollback || can.canImage || can.canRewrite || can.canRestore;
}

const ctxMenuEl = ref<HTMLElement | null>(null);

function ctxMenuItems(): HTMLButtonElement[] {
  return [
    ...(ctxMenuEl.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
      []),
  ];
}

function onContextMenu(e: MouseEvent, msg: ChatMessage) {
  if (!canOpenMenu(msg)) return;
  e.preventDefault();
  // 视口夹紧，避免菜单溢出屏幕
  const x = Math.min(e.clientX, window.innerWidth - 200);
  const y = Math.min(e.clientY, window.innerHeight - 160);
  ctxMenu.value = { x, y, msgId: msg.id, role: msg.role, ...menuFor(msg) };
  // 焦点移进菜单：键盘用户能直接上下选、回车执行（preventScroll —— 滚动会把菜单关掉）
  nextTick(() => ctxMenuItems()[0]?.focus({ preventScroll: true }));
}

/** 菜单内方向键在项之间循环；Tab 离开即关菜单 */
function onCtxMenuKeydown(e: KeyboardEvent) {
  if (e.key === 'Tab') {
    closeCtxMenu();
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  e.preventDefault();
  const items = ctxMenuItems();
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  let next = 0;
  if (e.key === 'End') next = items.length - 1;
  else if (e.key === 'ArrowDown') next = (current + 1) % items.length;
  else if (e.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
  items[next].focus({ preventScroll: true });
}

function closeCtxMenu() {
  ctxMenu.value = null;
}

function findMessage(msgId: string | undefined): ChatMessage | undefined {
  return msgId ? (props.messages ?? []).find((m) => m.id === msgId) : undefined;
}

/** 回退结果的统一出口；true = 已在本存档回到上一回合 */
function reportRestore(result: TimelineRestoreResult): boolean {
  if (result.status === 'projection-failed') {
    ui.toast(result.error, 'error');
    ui.navigate('home');
    return false;
  }
  if (result.status === 'rejected') {
    ui.toast(result.error, 'warning');
    return false;
  }
  if (result.warning) ui.toast(result.warning, 'warning');
  return result.continuation === 'same-save';
}

/**
 * 「回退本轮」/「回退到这条输入」（GAME-06）：一个花钱生成的回合不能一点就没 ——
 * 先确认，说清楚丢掉的是什么。
 */
async function rollbackTurn(role: ChatMessage['role']): Promise<void> {
  const ok = await confirmDialog({
    title: role === 'user' ? '回退到这条输入？' : '回退这一回合？',
    message:
      role === 'user'
        ? '将回到上一回合结束时的状态，这句输入会填回输入框。'
        : '将回到上一回合结束时的状态，这一回合的输入会填回输入框。',
    details: [
      ...(role === 'user' ? [] : ['这一回合的正文会被丢弃（已花费的生成费用不会退回）']),
      '这一回合之后做的手动改动也会一并丢弃',
    ],
    confirmLabel: '回退',
    danger: true,
  });
  if (!ok) return;
  reportRestore(await game.rollbackOneTurn());
}

/**
 * 「重新生成」（GAME-04）：确认 → 回退本轮 → 用同一句输入走发送缝重发。
 * 🔴 不开第二条写路径：回退走 `rollbackOneTurn`，发送走与输入框同一个 `send` 事件
 *    （GamePage.handleSend）。`refillInput: false` 让那句话不再残留在输入框里。
 */
async function regenerateTurn(mode: 'regenerate' | 'rollback-retry' = 'regenerate'): Promise<void> {
  const input = latestUserMsg.value?.content;
  if (!input) return;
  const ok = await confirmDialog(
    mode === 'regenerate'
      ? {
          title: '重新生成这一回合？',
          message: '会丢弃这一回合的正文，用同一句输入重新调用模型（会再次计费）。',
          details: ['这一回合之后做的手动改动也会一并丢弃'],
          confirmLabel: '重新生成',
          danger: true,
        }
      : {
          // GAME-16：没完成的回合「回退并重试」—— 与不回退的「再次尝试」是两条不同的路
          title: '回退并重试？',
          message: '先回到上一回合结束时的状态，再用同一句输入重新调用模型（会再次计费）。',
          details: ['这一回合已经写入的内容会被丢弃'],
          confirmLabel: '回退并重试',
          danger: true,
        },
  );
  if (!ok) return;
  if (reportRestore(await game.rollbackOneTurn({ refillInput: false }))) emit('send', input);
}

async function copyMessage(msg: ChatMessage | undefined): Promise<void> {
  if (!msg) return;
  try {
    await navigator.clipboard.writeText(msg.content);
    ui.toast('已复制', 'success');
  } catch (e) {
    console.warn('[ChatFlow] 复制失败:', e);
    ui.toast('复制失败', 'warning');
  }
}

async function ctxRollback() {
  const role = ctxMenu.value?.role ?? 'assistant';
  closeCtxMenu();
  await rollbackTurn(role);
}

async function ctxCopy() {
  const msg = findMessage(ctxMenu.value?.msgId);
  closeCtxMenu();
  await copyMessage(msg);
}

// ===== 「润色正文」（DeepSeek beta 前缀续写侧链，手动触发）=====
/**
 * 把最新一条正文交给「正文润色」侧链改写，成功后就地覆盖。
 *
 * 🔴 依赖玩家在设置里给 `prose_rewrite` 绑定一个 **baseUrl 带 `/beta` 的 DeepSeek 源**；
 *    没绑定 / 绑定失效 / 协议不是 openai-chat 时侧链直接返回失败（端点识别在侧链里做），
 *    这里只负责把原因显示出来；`/beta` 缺失只回 warning，成功后再补一条提示。
 * 🔴 活动账本由 GamePipeline 维护（agent-activity 里有「润色这一段正文」文案），
 *    生成期间 ChatFlow 的思考指示会自动显示出来。
 */
async function ctxRewriteProse() {
  const msgId = ctxMenu.value?.msgId;
  closeCtxMenu();
  if (msgId) await rewriteProse(msgId);
}

/**
 * 🔴 GAME-07：润色进行中（`game.isRewriting`）不能再点第二次、不能发送新回合；
 *    原文由 store 留在消息上，「还原润色前」随时可换回去。
 */
async function rewriteProse(msgId: string) {
  if (game.isRewriting) return;
  // 🔴 立刻给一次反馈：侧链要等 API 回来才有结果，中途毫无提示会让玩家以为功能坏了。
  ui.toast('正在润色正文…', 'info');
  try {
    const result = await game.rewriteProse(msgId);
    if (result.ok) {
      ui.toast('正文已润色', 'success');
      // 端点识别只回了 warning（如 base_url 不含 /beta）→ 照常提示，但让玩家知道可能被上游拒
      if (result.warning) ui.toast(result.warning, 'warning');
    } else ui.toast(result.reason ?? '润色失败', 'warning');
  } catch (e) {
    ui.toast(`润色失败：${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

/** 「还原润色前」：换回润色前的原文（只在消息上留着备份时出现） */
async function restorePreRewrite(msgId: string) {
  if (await game.restorePreRewrite(msgId)) ui.toast('已还原润色前的正文', 'success');
}

async function ctxRestorePreRewrite() {
  const msgId = ctxMenu.value?.msgId;
  closeCtxMenu();
  if (msgId) await restorePreRewrite(msgId);
}

// ===== 「为这一段配图」（D33 / D34 / D24）=====

/**
 * 手动开火那一条路。被限额拦下时**立起确认框而不是弹个 toast 就结束**（D24）——
 * 判定与正文按钮共用同一个 `checkQuota`（§5.3 不变式），出路也共用同一个 composable。
 */
const {
  busy: imageBusy,
  pending: quotaPending,
  request: requestImage,
  confirm: confirmQuota,
  dismiss: dismissQuota,
} = useManualSceneImage({
  generate: (input) => sceneImages.generate(input),
  notify: (message) => ui.toast(message, 'warning'),
});

/** 整条消息正文，已剥掉全部插画标记 —— `message-end` 的 `intent` 就是它（§10.2b） */
function strippedNarrativeOf(content: string): string {
  return splitSceneImageSegments(content)
    .filter(
      (segment): segment is Extract<typeof segment, { kind: 'text' }> => segment.kind === 'text',
    )
    .map((segment) => segment.text)
    .join('')
    .trim();
}

async function ctxSceneImage() {
  const msg = findMessage(ctxMenu.value?.msgId);
  closeCtxMenu();
  await illustrate(msg);
}

async function illustrate(msg: ChatMessage | undefined) {
  if (!msg) return;
  const saveId = sceneImages.activeSaveId;
  if (saveId === null) {
    ui.toast('还没有载入存档，暂时画不了', 'warning');
    return;
  }
  const turn = msg.turn ?? 0;
  const narrative = strippedNarrativeOf(msg.content);
  await requestImage({
    saveId,
    messageId: msg.id,
    turn,
    // 🔴 message-end（D34）：渲染在该消息正文之后，occurrence 由 store 在同 anchorKind
    //    内顺延 —— 与标记那一路各自独立计数，互不干扰
    anchorKind: 'message-end',
    // 不做选中文本锚定：那是这套东西里最脆弱的一半（原文一改锚点就丢）
    intent: narrative,
    // 这里没有 story 写的标题，侧链跑完之前先用回合号占位（desc 之后会兼任说明）
    title: `第 ${turn} 回合的插画`,
    // 没有标记就没有出场角色名单 —— 侧链自己从正文里看
    characters: [],
    // 没有标记可钳，rating 上限就是这一张的 rating（D38）
    rating: effectiveMaxRating(s.imageMaxRating, s.nsfwContent),
    narrative,
  });
}

function handleGlobalClick() {
  closeCtxMenu();
}
function handleEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') closeCtxMenu();
}
function handleScrollClose() {
  closeCtxMenu();
}

onMounted(() => {
  window.addEventListener('click', handleGlobalClick);
  window.addEventListener('keydown', handleEsc);
  window.addEventListener('scroll', handleScrollClose, true); // capture：捕获容器内滚动
  window.addEventListener('keydown', onStageKeydown);
  window.addEventListener('keyup', onStageKeyup);
  window.addEventListener('blur', onStageBlur);
  window.addEventListener('wheel', onStageWheel, { capture: true, passive: true });
  // 进存档时消息早已就位，两个 watcher 都不会触发 —— 必须显式滚一次。
  // 后续插画字节异步装载会触发 resize（pinnedToBottom 初值 true），自动保持钉底。
  scrollToBottom();
});
onUnmounted(() => {
  window.removeEventListener('click', handleGlobalClick);
  window.removeEventListener('keydown', handleEsc);
  window.removeEventListener('scroll', handleScrollClose, true);
  window.removeEventListener('keydown', onStageKeydown);
  window.removeEventListener('keyup', onStageKeyup);
  window.removeEventListener('blur', onStageBlur);
  window.removeEventListener('wheel', onStageWheel, { capture: true });
  cancelCtrlHold();
  stopFastForward();
  if (pressTimer !== null) clearTimeout(pressTimer);
});

/**
 * 游戏页要读这一层：Esc 是分层的，游戏菜单在最底下 —— 右键菜单开着时菜单必须让路，
 * 否则一次 Esc 会同时关掉右键菜单并把游戏菜单弹出来。
 */
defineExpose({ ctxMenuOpen: computed(() => ctxMenu.value !== null) });
</script>

<template>
  <div class="chat-flow">
    <div
      ref="container"
      class="chat-messages"
      tabindex="0"
      @scroll="handleChatScroll"
      @click="onStageClick"
    >
      <div v-if="!messages || messages.length === 0" class="chat-empty">
        <span class="chat-empty-glyph" aria-hidden="true">❦</span>
        <p>等待冒险开始...</p>
        <p class="chat-empty-hint">在下方输入你的行动来推进故事</p>
      </div>

      <template v-for="msg in messages" :key="msg.id">
        <!-- 用户消息 -->
        <template v-if="msg.role === 'user'">
          <!-- 不挂原生 title：右键提示反复弹在正文上（GAME-22），可见入口改为下方操作条 -->
          <div class="bubble-row bubble-row-player" @contextmenu="onContextMenu($event, msg)">
            <div class="bubble bubble-player">
              <span class="bubble-prefix">你:</span>
              <!-- 内容先过 escapeHtml()，再只把换行还原成 <br>。别把 escapeHtml 摘掉 -->
              <!-- eslint-disable-next-line vue/no-v-html -->
              <span class="bubble-text" v-html="escapeHtml(msg.content).replace(/\n/g, '<br>')" />
              <span v-if="msg.timestamp" class="bubble-time">{{ formatTime(msg.timestamp) }}</span>
            </div>
          </div>

          <TurnActivityLedger
            v-for="run in activityRunsForMessage(msg.id)"
            :key="run.id"
            :run="run"
            :can-retry="canRetryRun(run)"
            :can-rollback-retry="latestTurnRollbackable"
            :rollback-blocked-reason="OPENING_TURN_NOTE"
            @retry="emit('retry-turn', msg.id)"
            @rollback-retry="regenerateTurn('rollback-retry')"
            @resize="handleNarrativeResize"
          />

          <!-- GAME-09：内存记录没了但存档里记着没完成 → 持久化推导出的横幅，出路与回合卡片一致 -->
          <TurnRecoveryPanel
            v-if="unfinishedTurn?.userMessageId === msg.id"
            class="turn-unfinished"
            :message="UNFINISHED_MESSAGES[unfinishedTurn.reason]"
            :cause-unknown="unfinishedTurn.reason !== 'no-reply'"
            :can-retry="!game.isRewriting && !game.isAgentCombat"
            :can-rollback-retry="!game.isRewriting && !game.isAgentCombat && latestTurnRollbackable"
            :can-rollback-edit="!game.isRewriting && !game.isAgentCombat && latestTurnRollbackable"
            :rollback-blocked-reason="latestTurnRollbackable ? undefined : OPENING_TURN_NOTE"
            @retry="emit('retry-turn', msg.id)"
            @rollback-retry="regenerateTurn('rollback-retry')"
            @rollback-edit="rollbackTurn('user')"
          />

          <!--
            最新输入没有正文（失败 / 中止）：可见的「回退到这条输入」（GAME-04）。
            「上一回合未完成」横幅在时，这一项已并进横幅的第三条出路，不再单独渲染一行
          -->
          <div
            v-if="showTurnActions(msg) && unfinishedTurn?.userMessageId !== msg.id"
            class="turn-actions turn-actions-player"
            role="group"
            aria-label="这条输入的操作"
          >
            <button
              v-if="latestTurnRollbackable"
              type="button"
              class="turn-action"
              :disabled="game.isRewriting"
              @click="rollbackTurn('user')"
            >
              <i class="fa-solid fa-rotate-left" aria-hidden="true" /> 回退到这条输入
            </button>
            <span v-else class="turn-actions-note">{{ OPENING_TURN_NOTE }}</span>
          </div>
        </template>

        <!--
          已废弃的尝试（GAME-10）：组首渲染一行可展开的「已废弃的尝试（N）」，其余组员不单独渲染。
          展开后只读：不转发右键、不画插画（不传 message-id = 没有插画锚点，档位 off）、没有操作条
        -->
        <div
          v-else-if="msg.role === 'assistant' && discarded.groups.has(msg.id)"
          class="bubble-row bubble-row-discarded"
        >
          <div class="discarded-attempts">
            <button
              type="button"
              class="discarded-toggle"
              :aria-expanded="!!discardedOpen[msg.id]"
              @click="toggleDiscarded(msg.id)"
            >
              <i
                class="fa-solid fa-chevron-right discarded-chevron"
                :class="{ 'is-open': discardedOpen[msg.id] }"
                aria-hidden="true"
              />
              已废弃的尝试（{{ discarded.groups.get(msg.id)!.length }}）
              <small>不属于故事，也不会交给模型</small>
            </button>
            <div v-if="discardedOpen[msg.id]" class="discarded-body">
              <BeautifiedNarrative
                v-for="attempt in discarded.groups.get(msg.id)"
                :key="attempt.id"
                class="narrative-body discarded-narrative"
                :text="attempt.content"
                image-mode="off"
                @resize="handleNarrativeResize"
              />
            </div>
          </div>
        </div>

        <!-- AI 叙事消息 — 只渲染美化正文 -->
        <!-- data-message-id 是 CG 图鉴「跳回那条消息」的锚点（§10.3），别删 -->
        <div
          v-else-if="msg.role === 'assistant' && !discarded.memberIds.has(msg.id)"
          :data-message-id="msg.id"
          class="bubble-row bubble-row-narrative"
          :class="{ 'bubble-row-settled': skipsEnter(msg) }"
          @contextmenu="onContextMenu($event, msg)"
        >
          <div class="bubble bubble-narrative-full">
            <!-- 逐节演出（交互式推进）：只给本次会话新到的直出正文；其余与引入前一致 -->
            <StagedNarrative
              v-if="stagedViewOf(msg)"
              class="narrative-body"
              :view="stagedViewOf(msg)!"
              :content="msg.content"
              :settled-end="stagedSettledEnd(msg)"
              :entrances="messageEntrances(msg).bySection"
              :still-entrances="messageEntrances(msg).still"
              :depth="messageDepth(msg.id)"
              :forward-context-menu="canOpenMenu(msg)"
              :message-id="msg.id"
              :turn="msg.turn ?? 0"
              :image-mode="s.imageGenMode"
              :image-max-rating="effectiveMaxRating(s.imageMaxRating, s.nsfwContent)"
              :image-blur-by-default="s.imageBlurByDefault"
              :image-dialect-id="s.imageDialectId"
              :mentions="mentionsFor(msg)"
              :seal="sealFor(msg)"
              @resize="handleNarrativeResize"
            />
            <BeautifiedNarrative
              v-else
              class="narrative-body"
              :text="msg.content"
              :depth="messageDepth(msg.id)"
              :forward-context-menu="canOpenMenu(msg)"
              :message-id="msg.id"
              :turn="msg.turn ?? 0"
              :image-mode="s.imageGenMode"
              :image-max-rating="effectiveMaxRating(s.imageMaxRating, s.nsfwContent)"
              :image-blur-by-default="s.imageBlurByDefault"
              :image-dialect-id="s.imageDialectId"
              :reveal="revealFor(msg)"
              :mentions="mentionsFor(msg)"
              :seal="sealFor(msg)"
              @resize="handleNarrativeResize"
            />
            <span v-if="msg.timestamp" class="bubble-time">{{ formatTime(msg.timestamp) }}</span>

            <!-- 本楼状态更新（状态树协议 §12）：已接纳、带记录、逐节演出放完才出现；默认收起 -->
            <StateUpdateBlock v-if="showsUpdateBlock(msg)" :message="msg" />

            <!--
              最新一回合的可见操作条（GAME-04）：常显但压低，悬停 / 聚焦时才提亮 ——
              正文优先，这一行不跟叙事抢视线。右键菜单保留为快捷方式。
            -->
            <div
              v-if="showTurnActions(msg)"
              class="turn-actions"
              role="group"
              aria-label="这一回合的操作"
            >
              <template v-if="latestTurnRollbackable">
                <button
                  type="button"
                  class="turn-action"
                  :disabled="game.isRewriting"
                  @click="regenerateTurn('regenerate')"
                >
                  <i class="fa-solid fa-arrows-rotate" aria-hidden="true" /> 重新生成
                </button>
                <button
                  type="button"
                  class="turn-action"
                  :disabled="game.isRewriting"
                  @click="rollbackTurn('assistant')"
                >
                  <i class="fa-solid fa-rotate-left" aria-hidden="true" /> 回退
                </button>
              </template>
              <button
                v-if="msg.content.trim().length > 0"
                type="button"
                class="turn-action"
                :disabled="game.isRewriting"
                @click="rewriteProse(msg.id)"
              >
                <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true" />
                {{ game.isRewriting ? '润色中…' : '润色' }}
              </button>
              <button
                v-if="msg.preRewriteContent !== undefined"
                type="button"
                class="turn-action"
                :disabled="game.isRewriting"
                @click="restorePreRewrite(msg.id)"
              >
                <i class="fa-solid fa-clock-rotate-left" aria-hidden="true" /> 还原润色前
              </button>
              <button
                v-if="s.imageGenMode !== 'off'"
                type="button"
                class="turn-action"
                :disabled="imageBusy"
                @click="illustrate(msg)"
              >
                <i class="fa-solid fa-image" aria-hidden="true" /> 配图
              </button>
              <button type="button" class="turn-action" @click="copyMessage(msg)">
                <i class="fa-solid fa-copy" aria-hidden="true" /> 复制
              </button>
              <span v-if="game.isRewriting" class="turn-actions-note" role="status">
                <span class="turn-actions-spinner" aria-hidden="true" />正在润色正文…
              </span>
              <span v-else-if="!latestTurnRollbackable" class="turn-actions-note">
                {{ OPENING_TURN_NOTE }}
              </span>
            </div>
          </div>
        </div>

        <!-- 系统事件消息 — 简单类型：纯通知条，无折叠 -->
        <div
          v-else-if="
            msg.role === 'system' &&
            msg.systemEvent &&
            isEventVisible(msg.systemEvent) &&
            !isComplexEvent(msg.systemEvent.type)
          "
          class="bubble-row bubble-row-system"
        >
          <SystemNotifBar :event="msg.systemEvent" />
        </div>

        <!-- 系统事件消息 — 复杂类型：通知条 ⇄ 卡片 -->
        <div
          v-else-if="msg.role === 'system' && msg.systemEvent && isEventVisible(msg.systemEvent)"
          class="bubble-row bubble-row-system"
        >
          <!-- 通知条 ⇄ 卡片：旧的一瞬淡出，新的自通知条处向下展开落定（design.md §4.6） -->
          <Transition name="card-unfold" mode="out-in">
            <!-- 折叠通知条 -->
            <div
              v-if="!expandedIds[msg.id]"
              key="notif"
              class="system-notif"
              :class="`system-notif-${msg.systemEvent.type}`"
              role="button"
              tabindex="0"
              :aria-expanded="false"
              @click="toggleExpand(msg.id)"
              @keydown.enter="toggleExpand(msg.id)"
              @keydown.space.prevent="toggleExpand(msg.id)"
            >
              <i :class="'system-notif-icon fa-solid ' + eventIconClass(msg.systemEvent.type)" />
              <span class="system-notif-text">{{ msg.content }}</span>
              <span class="system-notif-chevron">▸</span>
            </div>

            <!-- 展开卡片 -->
            <div v-else key="card" class="system-card-wrapper">
              <component
                :is="CARD_COMPONENTS[msg.systemEvent.type]"
                :event="msg.systemEvent"
                @collapse="collapseCard(msg.id)"
              />
            </div>
          </Transition>
        </div>
      </template>

      <!-- 🆕 思考中指示（2026-08-12）：生成态、正文未出时显示当前 Agent 活动 -->
      <div
        v-if="isGenerating && !streamingText && !stagedDraft"
        class="bubble-row bubble-row-thinking"
        role="status"
        aria-live="polite"
      >
        <div class="thinking-indicator">
          <span class="thinking-spinner" aria-hidden="true" />
          <span class="thinking-text">{{ thinkingText }}</span>
        </div>
      </div>

      <!-- 🆕 流式正文实时渲染 -->
      <div
        v-if="isGenerating && streamingText && !stagedDraft"
        class="bubble-row bubble-row-narrative"
      >
        <div class="bubble bubble-narrative-full">
          <BeautifiedNarrative
            class="narrative-body streaming-content"
            :text="streamingText"
            streaming
            @resize="handleNarrativeResize"
          />
        </div>
      </div>
      <!--
        演出中的草稿：只放出完整的节；流结束清预览后仍留着，直到正式消息领走进度（不回退、不重放）。
        重试会从头再流 —— draftEpoch 变了整块重挂
      -->
      <div v-else-if="stagedDraft && draftView" class="bubble-row bubble-row-narrative">
        <div class="bubble bubble-narrative-full">
          <StagedNarrative
            :key="draftEpoch"
            class="narrative-body"
            :view="draftView"
            :content="stagedDraft.state.input.content"
            :entrances="draftEntrances.bySection"
            :still-entrances="draftEntrances.still"
            :waiting-text="thinkingText"
            @resize="handleNarrativeResize"
          />
        </div>
      </div>
    </div>

    <!-- 润色进行中锁住发送（GAME-07）：润色结果会写回最新正文，期间开新回合会两头打架 -->
    <!-- 演出控制条：浮在输入框上沿，只给正在演的那一条；可收起（设置 stagedControlsCollapsed） -->
    <Transition name="stage-dock-fade">
      <StageControls
        v-if="staged.active.value"
        :can-advance="staged.active.value.view.canAdvance"
        :fast-forwarding="fastForwarding !== null"
        :collapsed="s.stagedControlsCollapsed"
        @update:collapsed="s.stagedControlsCollapsed = $event"
        @show-full="showFullText"
        @fast-forward="toggleFastForward"
        @skip-all="skipStage()"
      />
    </Transition>

    <InputBar
      :disabled="isGenerating"
      :stopping="game.currentAgentActivityRun?.status === 'stopping'"
      :locked-reason="game.isRewriting ? '正在润色正文，完成后再继续…' : undefined"
      :hold-options="holdStageOptions"
      @send="sendInput"
      @stop="emit('stop')"
    />

    <!-- 右键菜单（回退只在最新一条；配图哪条都行，off 档下整项不出现） -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        ref="ctxMenuEl"
        class="ctx-menu"
        role="menu"
        aria-label="消息操作"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @keydown="onCtxMenuKeydown"
      >
        <button
          v-if="ctxMenu.canRollback"
          type="button"
          role="menuitem"
          class="ctx-item"
          :disabled="game.isAgentCombat || game.isRewriting"
          @click.stop="ctxRollback"
        >
          <i class="fa-solid fa-rotate-left" aria-hidden="true" />
          {{ ctxMenu.role === 'user' ? '回退到这条输入' : '回退本轮' }}
        </button>
        <button
          v-if="ctxMenu.canImage"
          type="button"
          role="menuitem"
          class="ctx-item"
          @click.stop="ctxSceneImage"
        >
          <i class="fa-solid fa-image" aria-hidden="true" /> 为这一段配图
        </button>
        <button
          v-if="ctxMenu.canRewrite"
          type="button"
          role="menuitem"
          class="ctx-item"
          :disabled="game.isRewriting"
          @click.stop="ctxRewriteProse"
        >
          <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true" /> 润色正文
        </button>
        <button
          v-if="ctxMenu.canRestore"
          type="button"
          role="menuitem"
          class="ctx-item"
          :disabled="game.isRewriting"
          @click.stop="ctxRestorePreRewrite"
        >
          <i class="fa-solid fa-clock-rotate-left" aria-hidden="true" /> 还原润色前
        </button>
        <button type="button" role="menuitem" class="ctx-item" @click.stop="ctxCopy">
          <i class="fa-solid fa-copy" aria-hidden="true" /> 复制
        </button>
      </div>
    </Teleport>

    <!--
      限额确认（D24）—— 手动**永不被拦死**，最多是要确认一下。
      🔴 显示的是 checkQuota 原样给的那句中文：它已经按「还能继续、只是要确认」的
         口吻写好了，在这里改写会让人以为功能坏了。
    -->
    <AppModal
      :open="quotaPending !== null"
      title="继续生成这张插画？"
      size="sm"
      @update:open="dismissQuota"
    >
      <p class="quota-msg">{{ quotaPending?.message }}</p>
      <template #footer>
        <AppButton variant="ghost" @click="dismissQuota">算了</AppButton>
        <AppButton variant="primary" :loading="imageBusy" @click="confirmQuota">仍然生成</AppButton>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.stage-dock-fade-enter-active,
.stage-dock-fade-leave-active {
  transition: opacity var(--motion-duration-base) var(--motion-ease-standard);
}
.stage-dock-fade-leave-active {
  transition-duration: var(--motion-duration-fast);
}
.stage-dock-fade-enter-from,
.stage-dock-fade-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .stage-dock-fade-enter-active,
  .stage-dock-fade-leave-active {
    transition: none;
  }
}
.chat-flow {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.chat-messages {
  flex: 1;
  overflow-y: auto;
  /* 底部留够演出控制条的高度：它浮在输入框上沿，不能盖住最后一条消息的操作条 */
  padding: 24px 20px 56px;
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  max-width: 70ch;
  margin: 0 auto;
  color: var(--theme-text-muted);
  font-size: 1rem;
  font-family: var(--theme-font-title, serif);
}
.chat-empty-glyph {
  font-size: 1.5rem;
  color: color-mix(in srgb, var(--theme-primary) 55%, transparent);
  margin-bottom: 12px;
}
.chat-empty-hint {
  font-size: 0.8125rem;
  margin-top: 8px;
}
.bubble-row {
  display: flex;
  /* 消息入场（design.md §6）：入场缓动 —— 迅速到位、长尾落定，像下一页纸放到桌面上 */
  animation: msg-enter var(--motion-duration-slow) var(--motion-ease-enter) both;
}
@keyframes msg-enter {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .bubble-row {
    animation: none;
  }
}
/* 流式提交的正式消息：读者刚在草稿里看完，静默换上，不再从下方升起一次（仅特效层开启时挂此类） */
.bubble-row.bubble-row-settled {
  animation: none;
}
.bubble-row-player,
.bubble-row-narrative {
  justify-content: center;
}

/* 🆕 思考中指示（2026-08-12）：生成态占位 —— 中央居中的低调「正在…」提示 */
.bubble-row-thinking {
  justify-content: center;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
}

.thinking-indicator {
  display: inline-flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-xs) var(--theme-spacing-md);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 22%, var(--theme-card-border));
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-card-bg) 88%, var(--theme-content-bg));
  color: var(--theme-text-secondary);
  font-size: 0.8125rem;
  font-family: var(--theme-font-body);
}

.thinking-spinner {
  width: 0.875rem;
  height: 0.875rem;
  flex: 0 0 auto;
  border: 2px solid color-mix(in srgb, var(--theme-primary) 25%, transparent);
  border-top-color: var(--theme-primary);
  border-radius: 50%;
  animation: thinking-spin 0.8s linear infinite;
}

@keyframes thinking-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .thinking-spinner {
    animation: none;
  }
}
/* 正文列已经是屏宽 50%，宽度由布局决定而非 ch 上限 ——
   原先 72ch 会在宽屏上把正文钉在中间、两侧留出大片空白。 */
.bubble {
  width: 100%;
  max-width: 100%;
  padding: 10px 14px;
  border-radius: var(--theme-radius-md, 8px);
  font-size: 0.875rem;
  line-height: 1.6;
}
/* 玩家发言 — 手稿旁注: 淡金底 + 整圈细描边 */
.bubble-player {
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-card-bg));
  color: var(--theme-text-primary);
  text-align: left;
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
/* 叙事正文 — 书页而非卡片: 无边框无底色，靠留白与衬线成页 */
.bubble-narrative-full {
  width: 100%;
  max-width: 100%;
  padding: 4px 8px;
  color: var(--theme-text-primary);
  font-size: 0.9375rem;
  line-height: 1.8;
  text-align: left;
}

/* ===== 叙事正文 ===== */
.narrative-body {
  font-family: var(--theme-font-title, 'Noto Serif SC', serif);
  color: var(--theme-text-primary);
  line-height: 1.8;
  text-wrap: pretty;
}

/* 叙事正文段落排版 */
.narrative-body :deep(p) {
  text-indent: 2em;
  margin: 0 0 0.6em;
}
.narrative-body :deep(p:last-child) {
  margin-bottom: 0;
}

.bubble-prefix {
  font-weight: 600;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  margin-right: 6px;
  font-family: system-ui, sans-serif;
}
.bubble-time {
  display: block;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  margin-top: 4px;
}
/* ===== 流式正文 ===== */
.streaming-content {
  /* 流式渲染时使用闪烁光标提示正在输出 */
  position: relative;
}
.streaming-content::after {
  content: '▍';
  animation: cursor-blink 1s steps(1) infinite;
  color: var(--theme-primary);
  opacity: 0.8;
}
@keyframes cursor-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}

/* ===== 系统消息 ===== */
.bubble-row-system {
  justify-content: center;
}

/* 折叠通知条 */
.system-notif {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: var(--theme-radius-md, 8px);
  background: color-mix(in srgb, var(--theme-surface-muted) 70%, transparent);
  border: 1px solid var(--theme-card-border);
  cursor: pointer;
  max-width: 100%;
  width: 100%;
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  transition:
    background 0.15s,
    border-color 0.15s;
  user-select: none;
}
.system-notif:hover {
  background: var(--theme-surface-hover, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 35%, var(--theme-card-border));
}
.system-notif-icon {
  font-size: 0.8125rem;
  opacity: 0.7;
  width: 1.125rem;
  text-align: center;
}
.system-notif-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.system-notif-chevron {
  font-size: 0.625rem;
  opacity: 0.5;
  transition: transform 0.2s;
}

/* 展开卡片 */
.system-card-wrapper {
  max-width: 100%;
  width: 100%;
}

/* 通知条 ⇄ 卡片的切换（动效 v1）：只动 opacity / transform，行高的变化不做过渡
   （design.md §1 禁止过渡布局属性）；原点在顶部，读起来是「从通知条处展开」 */
.card-unfold-enter-active {
  transform-origin: top center;
  transition:
    opacity var(--motion-duration-base) var(--motion-ease-standard),
    transform var(--motion-duration-slow) var(--motion-ease-enter);
}
.card-unfold-leave-active {
  transition: opacity var(--motion-duration-instant) var(--motion-ease-exit);
}
.card-unfold-enter-from {
  opacity: 0;
  transform: translateY(-4px) scaleY(0.96);
}
.card-unfold-leave-to {
  opacity: 0;
}

/* ===== 上一回合未完成横幅（GAME-09）===== */
.turn-unfinished {
  width: 100%;
}

/* ===== 已废弃的尝试（GAME-10）=====
   压低到几乎只是一行旁注：默认收起，展开后正文也整体减淡，读得到但不像故事。 */
.bubble-row-discarded {
  justify-content: center;
}
.discarded-attempts {
  width: 100%;
  padding: 0 8px;
}
.discarded-toggle {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 6px;
  border: 1px dashed var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  background: none;
  color: var(--theme-text-muted);
  font-family: var(--theme-font-body, system-ui, sans-serif);
  font-size: 0.75rem;
  cursor: pointer;
}
.discarded-toggle small {
  font-size: 0.6875rem;
  opacity: 0.8;
}
.discarded-toggle:hover {
  color: var(--theme-text-secondary);
}
.discarded-toggle:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}
.discarded-chevron {
  font-size: 0.625rem;
  transition: transform 150ms ease;
}
.discarded-chevron.is-open {
  transform: rotate(90deg);
}
.discarded-body {
  margin-top: var(--theme-spacing-sm, 8px);
  padding-left: var(--theme-spacing-md, 12px);
  border-left: 2px solid var(--theme-card-border);
  opacity: 0.6;
  font-size: 0.875rem;
  line-height: 1.7;
}
.discarded-narrative + .discarded-narrative {
  margin-top: var(--theme-spacing-md, 12px);
}
@media (prefers-reduced-motion: reduce) {
  .discarded-chevron {
    transition: none;
  }
}

/* ===== 最新一回合的操作条（GAME-04）=====
   常显但压低（叙事优先）：悬停该回合 / 键盘聚焦进来时才提亮到正常对比度。 */
.turn-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--theme-spacing-xs, 4px);
  margin-top: var(--theme-spacing-sm, 8px);
  font-family: var(--theme-font-body, system-ui, sans-serif);
  font-size: 0.75rem;
  line-height: 1.4;
  opacity: 0.6;
  transition: opacity 150ms ease;
}
.turn-actions-player {
  justify-content: flex-start;
  padding: 0 var(--theme-spacing-sm, 8px);
}
.bubble-row:hover .turn-actions,
.turn-actions:hover,
.turn-actions:focus-within {
  opacity: 1;
}
.turn-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border: 1px solid transparent;
  border-radius: var(--theme-radius-sm, 4px);
  background: none;
  color: var(--theme-text-muted);
  font: inherit;
  cursor: pointer;
  transition:
    color 150ms ease,
    background 150ms ease,
    border-color 150ms ease;
}
.turn-action:hover:not(:disabled) {
  color: var(--theme-text-primary);
  background: var(--theme-surface-hover, var(--theme-card-bg));
  border-color: var(--theme-card-border);
}
.turn-action:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 1px;
  color: var(--theme-text-primary);
}
.turn-action:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.turn-action i {
  font-size: 0.6875rem;
  opacity: 0.85;
}
.turn-actions-note {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  color: var(--theme-text-muted);
}
.turn-actions-spinner {
  width: 0.75rem;
  height: 0.75rem;
  border: 2px solid color-mix(in srgb, var(--theme-primary) 25%, transparent);
  border-top-color: var(--theme-primary);
  border-radius: 50%;
  animation: thinking-spin 0.8s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .turn-actions,
  .turn-action {
    transition: none;
  }
  .turn-actions-spinner {
    animation: none;
  }
}

/* ===== 右键菜单 ===== */
.ctx-menu {
  position: fixed;
  z-index: 9999;
  min-width: 160px;
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  box-shadow: var(--theme-shadow-md, 0 4px 12px rgba(0, 0, 0, 0.25));
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: system-ui, sans-serif;
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: none;
  background: none;
  color: var(--theme-text-primary);
  font-size: 0.8125rem;
  font-family: inherit;
  cursor: pointer;
  border-radius: var(--theme-radius-sm, 4px);
  text-align: left;
}
.ctx-item:hover:not(:disabled),
.ctx-item:focus-visible {
  background: var(--theme-surface-hover, var(--theme-card-bg));
}
.ctx-item:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: -2px;
}
.ctx-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ctx-item i {
  width: 1rem;
  text-align: center;
  opacity: 0.8;
}

/* 限额确认弹窗正文 —— 一句话，不缩进（它不是叙事） */
.quota-msg {
  margin: 0;
  color: var(--theme-text-secondary);
  font-size: 0.875rem;
  line-height: 1.7;
  text-indent: 0;
}
</style>
