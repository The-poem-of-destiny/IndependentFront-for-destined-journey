<script setup lang="ts">
import { isDirectMode } from '@engine/story/generation-mode';

import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import InputBar from './InputBar.vue';
import type { AgentActivityRun, ChatMessage, SystemEvent } from '@engine/types/types';
import { escapeHtml } from '@engine/story/beautifier';
import { splitSceneImageSegments } from '@engine/image/image-segments';
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
    rating: s.imageMaxRating,
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
  // 进存档时消息早已就位，两个 watcher 都不会触发 —— 必须显式滚一次。
  // 后续插画字节异步装载会触发 resize（pinnedToBottom 初值 true），自动保持钉底。
  scrollToBottom();
});
onUnmounted(() => {
  window.removeEventListener('click', handleGlobalClick);
  window.removeEventListener('keydown', handleEsc);
  window.removeEventListener('scroll', handleScrollClose, true);
});

/**
 * 游戏页要读这一层：Esc 是分层的，游戏菜单在最底下 —— 右键菜单开着时菜单必须让路，
 * 否则一次 Esc 会同时关掉右键菜单并把游戏菜单弹出来。
 */
defineExpose({ ctxMenuOpen: computed(() => ctxMenu.value !== null) });
</script>

<template>
  <div class="chat-flow">
    <div ref="container" class="chat-messages" tabindex="0" @scroll="handleChatScroll">
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
          @contextmenu="onContextMenu($event, msg)"
        >
          <div class="bubble bubble-narrative-full">
            <BeautifiedNarrative
              :action-panels="isDirectMode(game.generationMode)"
              class="narrative-body"
              :text="msg.content"
              :depth="messageDepth(msg.id)"
              :forward-context-menu="canOpenMenu(msg)"
              :message-id="msg.id"
              :turn="msg.turn ?? 0"
              :image-mode="s.imageGenMode"
              :image-max-rating="s.imageMaxRating"
              :image-blur-by-default="s.imageBlurByDefault"
              :image-dialect-id="s.imageDialectId"
              @resize="handleNarrativeResize"
            />
            <span v-if="msg.timestamp" class="bubble-time">{{ formatTime(msg.timestamp) }}</span>

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
        v-if="isGenerating && !streamingText"
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
      <div v-if="isGenerating && streamingText" class="bubble-row bubble-row-narrative">
        <div class="bubble bubble-narrative-full">
          <BeautifiedNarrative
            :action-panels="isDirectMode(game.generationMode)"
            class="narrative-body streaming-content"
            :text="streamingText"
            streaming
            @resize="handleNarrativeResize"
          />
        </div>
      </div>
    </div>

    <!-- 润色进行中锁住发送（GAME-07）：润色结果会写回最新正文，期间开新回合会两头打架 -->
    <InputBar
      :disabled="isGenerating"
      :stopping="game.currentAgentActivityRun?.status === 'stopping'"
      :locked-reason="game.isRewriting ? '正在润色正文，完成后再继续…' : undefined"
      @send="(c) => emit('send', c)"
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
.chat-flow {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px 20px 32px;
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
/* 对话卡片内的段落不缩进（对话格式不需要首行缩进） */
.narrative-body :deep(.dialogue-body p) {
  text-indent: 0;
}

/* ===== 对话卡片 ===== */
.narrative-body :deep(.dialogue-card) {
  margin: 10px 0;
  padding: 10px 14px;
  border-radius: var(--theme-radius-md, 8px);
  background: color-mix(in srgb, var(--theme-surface-muted) 80%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 22%, var(--theme-card-border));
}
.narrative-body :deep(.dialogue-header) {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.narrative-body :deep(.dialogue-avatar) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--theme-primary);
  color: #fff;
  font-size: 0.7rem;
  font-weight: 700;
  font-family: system-ui, sans-serif;
  overflow: hidden;
  white-space: nowrap;
}
.narrative-body :deep(.dialogue-name) {
  font-weight: 700;
  font-size: 0.82rem;
  color: var(--theme-accent, var(--theme-primary));
  font-family: system-ui, sans-serif;
}
.narrative-body :deep(.dialogue-body) {
  font-size: 0.9rem;
  color: var(--theme-text-primary);
  line-height: 1.6;
  padding-left: 36px;
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
