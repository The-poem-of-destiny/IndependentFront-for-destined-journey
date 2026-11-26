/**
 * useStagedPlayback — ChatFlow 的「逐节演出」进度簿（交互式推进 T6）
 *
 * 纯状态机在 `lib/stage-playback.ts`；本文件只管「哪几条消息在演、进度存哪、草稿怎么交接」：
 *
 * - 只演**本次会话新到**的直出正文（`useFreshMessages` 的判定）；历史与设置关闭时一条记录都不建，
 *   ChatFlow 走原渲染。
 * - 流式草稿另有一份进度（`draft`）。草稿在提交之前就会被清空（流结束即清预览），
 *   所以草稿进度**不随 streamingText 清空而丢**，一直留到正式消息到来领走、或这一代生成结束。
 * - 交接：领走草稿的正式消息拿草稿的游标同步到自己的正文 —— 游标只并不退，已放出的文字不回退、
 *   不重放（`settledEnd` 记下交接时读者已看到哪，此前的节静默显示）。
 * - 重试会清预览并从头再流一遍：新正文不再以已放出的文字开头时，草稿进度作废重开（`draftEpoch` +1）。
 *
 * 记录是整体替换的 shallowRef：推进一次换一次 Map，草稿逐字变化只动 `draft`。
 */
import { computed, nextTick, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue';
import type { ChatMessage } from '@engine/types/types';
import { resolveStoryStage, type StoryStageEnter } from '@engine/story/story-beats';
import {
  createStagePlayback,
  deriveStagePlayback,
  stepStagePlayback,
  type StagePlaybackEvent,
  type StagePlaybackInput,
  type StagePlaybackState,
  type StagePlaybackView,
} from '../lib/stage-playback';
import { isDiscardedAttempt } from '../lib/turn-recovery';
import type { FreshMessages } from './useFreshMessages';
import { useMessageKeyedCache } from './useMessageKeyedCache';

/** 流式分节快照（与 game-pipeline 的 StreamingStoryStage 同形，这里只读） */
export interface StreamingStageSnapshot {
  readonly breaks: readonly number[];
  readonly enters: readonly StoryStageEnter[];
  readonly closed: boolean;
}

export interface PlaybackRecord {
  readonly state: StagePlaybackState;
  /** 本记录建立前读者已看过的正文末尾偏移（草稿交接带来）；起点在它之前的节静默显示 */
  readonly settledEnd: number;
  /** 登场账本（非响应式，由渲染期的查询填写，同 ChatFlow 的 mentionCache 手法）；草稿交接时随记录带走 */
  readonly entrances: EntranceBook;
}

/**
 * 登场账本 ——「演过就不再撤回」：
 * - `pinned`：已播出的登场卡，按播出时用的名字（含别名）钉住。此后名册回读、接纳状态、
 *   生成与否怎么变都保持显示；位置每次按当前的节重新定位（`section` 记上一次的位置兜底）。
 * - `evaluatedEnd`：上一次判定时读者已看到的正文末尾。还没演的名字每次重新判定，
 *   但只在它所在的节是这之后才放出的时候演 ——「已读过就不演」。
 */
interface EntranceBook {
  readonly pinned: Map<string, { readonly names: readonly string[]; section: number }>;
  evaluatedEnd: number;
}

function createEntranceBook(): EntranceBook {
  return { pinned: new Map(), evaluatedEnd: 0 };
}

export interface StagedPlaybackOptions {
  /** 演出开关 × 直出模式 */
  enabled: () => boolean;
  messages: () => readonly ChatMessage[] | undefined;
  isGenerating: () => boolean;
  streamingText: () => string | undefined;
  streamingStage: () => StreamingStageSnapshot | null | undefined;
  fresh: FreshMessages;
}

/** 演出的目标：草稿或某条正式消息 */
export type StageTarget = { kind: 'draft' } | { kind: 'message'; id: string };

export interface StagedPlayback {
  /** 这条消息有演出记录（且开关开着）→ ChatFlow 用 StagedNarrative 渲染 */
  recordFor: (msg: ChatMessage) => PlaybackRecord | null;
  viewFor: (msg: ChatMessage) => StagePlaybackView | null;
  draft: Readonly<Ref<PlaybackRecord | null>>;
  draftView: ComputedRef<StagePlaybackView | null>;
  /** 草稿进度重开的代数 —— 草稿 StagedNarrative 以它为 key，重试后整块重挂 */
  draftEpoch: Readonly<Ref<number>>;
  /** 键盘 / 点击 / 快进的目标：显示中的草稿，否则最后一条没放完的演出消息 */
  active: ComputedRef<{ target: StageTarget; view: StagePlaybackView } | null>;
  advance: () => boolean;
  skipAll: (target?: StageTarget) => void;
  /** 玩家发送新输入前：所有演出一律全部显示 */
  skipEverything: () => void;
  /** 最新一条正文还在演、或尚未被接纳 → 行动选项暂扣 */
  holdOptions: ComputedRef<boolean>;
}

/** 参与演出的正文：故事回合的正文（排除诊断通知、战斗摘要、已废弃尝试） */
function isStageCandidate(msg: ChatMessage): boolean {
  return (
    msg.role === 'assistant' &&
    msg.storyTurnStatus !== undefined &&
    !msg.diagnostic &&
    !isDiscardedAttempt(msg) &&
    msg.content.trim().length > 0
  );
}

export function useStagedPlayback(options: StagedPlaybackOptions): StagedPlayback {
  const records = shallowRef<ReadonlyMap<string, PlaybackRecord>>(new Map());
  const draft = shallowRef<PlaybackRecord | null>(null);
  const draftEpoch = ref(0);

  /**
   * 消息正文 → 演出输入；按 (content, stage) 引用记忆，避免每次渲染重新校验断点。
   * 消息被移除（回退 / 切档 / 整体换数组）时随之清掉，见 useMessageKeyedCache。
   */
  const inputCache = useMessageKeyedCache<{
    content: string;
    stage: unknown;
    input: StagePlaybackInput;
  }>(options.messages);
  function inputOf(msg: ChatMessage): StagePlaybackInput {
    const hit = inputCache.get(msg.id);
    if (hit && hit.content === msg.content && hit.stage === msg.stage) return hit.input;
    const resolved = resolveStoryStage(msg.content, msg.stage);
    const input: StagePlaybackInput = {
      content: msg.content,
      breaks: resolved.breaks,
      enters: resolved.enters,
      closed: true,
    };
    inputCache.set(msg.id, { content: msg.content, stage: msg.stage, input });
    return input;
  }

  /**
   * 记录的状态与消息当前正文对齐（润色会改正文）；纯函数读，不写回。
   * 🔴 已经读完的消息正文再变（润色变长、还原润色前）时保持全部显示，不重新折起来演 ——
   *    否则游标停在旧长度，后文重新收起、finished 变回 false，行动选项又被暂扣。
   */
  function syncedState(record: PlaybackRecord, msg: ChatMessage): StagePlaybackState {
    const input = inputOf(msg);
    if (record.state.input === input) return record.state;
    const synced = stepStagePlayback(record.state, { type: 'sync', input });
    return viewOf(record.state).finished ? stepStagePlayback(synced, { type: 'skipAll' }) : synced;
  }

  const viewCache = new WeakMap<StagePlaybackState, StagePlaybackView>();
  function viewOf(state: StagePlaybackState): StagePlaybackView {
    let view = viewCache.get(state);
    if (!view) {
      view = deriveStagePlayback(state);
      viewCache.set(state, view);
    }
    return view;
  }

  /** 同一份 synced state 在一次渲染里被问很多遍：按 (record.state, input) 记一份 */
  const syncCache = new WeakMap<StagePlaybackState, StagePlaybackState>();
  function stateFor(record: PlaybackRecord, msg: ChatMessage): StagePlaybackState {
    const cached = syncCache.get(record.state);
    if (cached && cached.input === inputOf(msg)) return cached;
    const state = syncedState(record, msg);
    syncCache.set(record.state, state);
    return state;
  }

  function recordFor(msg: ChatMessage): PlaybackRecord | null {
    // 后来被作废的尝试（重试后标 failed）不再演：它折进「已废弃的尝试」，看不见也推不动
    if (!options.enabled() || !isStageCandidate(msg)) return null;
    return records.value.get(msg.id) ?? null;
  }

  function viewFor(msg: ChatMessage): StagePlaybackView | null {
    const record = recordFor(msg);
    return record ? viewOf(stateFor(record, msg)) : null;
  }

  const draftView = computed(() => (draft.value ? viewOf(draft.value.state) : null));

  // ---- 草稿：跟着流式快照同步 ----
  function revealedText(state: StagePlaybackState): string {
    return state.input.content.slice(0, state.cursor);
  }

  watch(
    [options.streamingText, options.streamingStage],
    ([text, stage]) => {
      if (!options.enabled() || !options.isGenerating() || !stage) return;
      // 清预览（流结束 / 重试前）不清进度：草稿要留到正式消息领走
      if (!text) return;
      const input: StagePlaybackInput = {
        content: text,
        breaks: stage.breaks,
        enters: stage.enters,
        closed: stage.closed,
      };
      const current = draft.value;
      if (!current || !text.startsWith(revealedText(current.state))) {
        draft.value = {
          state: createStagePlayback(input),
          settledEnd: 0,
          entrances: createEntranceBook(),
        };
        draftEpoch.value += 1;
        return;
      }
      draft.value = {
        ...current,
        state: stepStagePlayback(current.state, { type: 'sync', input }),
      };
    },
    { flush: 'sync' },
  );

  watch(options.isGenerating, (generating, was) => {
    if (generating && !was) {
      draft.value = null;
      return;
    }
    // 生成结束与正式消息入列可能同拍：等这一拍的交接跑完再清
    if (!generating && was) {
      void nextTick(() => {
        if (!options.isGenerating()) draft.value = null;
      });
    }
  });

  // ---- 新消息登记 + 草稿交接（sync：赶在本拍渲染之前建好记录，免得先闪一帧整段） ----
  watch(
    () => options.fresh.fresh.value,
    (fresh) => {
      if (fresh.size === 0) {
        // 载入存档 / 快照回退：新鲜名单整体清空，演出记录随之作废
        if (records.value.size > 0) records.value = new Map();
        return;
      }
      if (!options.enabled()) return;
      let next: Map<string, PlaybackRecord> | null = null;
      for (const msg of options.messages() ?? []) {
        if (!fresh.has(msg.id) || records.value.has(msg.id) || !isStageCandidate(msg)) continue;
        const input = inputOf(msg);
        let record: PlaybackRecord;
        const handoff = options.fresh.wasStreamed(msg.id) ? draft.value : null;
        if (handoff) {
          record = {
            state: stepStagePlayback(handoff.state, { type: 'sync', input }),
            settledEnd: handoff.state.cursor,
            entrances: handoff.entrances,
          };
          draft.value = null;
        } else {
          record = {
            state: createStagePlayback(input),
            settledEnd: 0,
            entrances: createEntranceBook(),
          };
        }
        next ??= new Map(records.value);
        next.set(msg.id, record);
      }
      if (next) records.value = next;
    },
    { flush: 'sync' },
  );

  // ---- 目标与事件 ----
  const draftShown = () => options.enabled() && options.isGenerating() && draft.value !== null;

  const active = computed<{ target: StageTarget; view: StagePlaybackView } | null>(() => {
    if (!options.enabled()) return null;
    if (draftShown() && draftView.value)
      return { target: { kind: 'draft' }, view: draftView.value };
    const list = options.messages() ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i];
      // 只以看得见的演出为目标：已废弃 / failed 的尝试不吞 Space / Enter / 点击
      const record = recordFor(msg);
      if (!record) continue;
      const view = viewOf(stateFor(record, msg));
      if (!view.finished) return { target: { kind: 'message', id: msg.id }, view };
    }
    return null;
  });

  function apply(target: StageTarget, event: StagePlaybackEvent): void {
    if (target.kind === 'draft') {
      const current = draft.value;
      if (current) draft.value = { ...current, state: stepStagePlayback(current.state, event) };
      return;
    }
    const record = records.value.get(target.id);
    const msg = (options.messages() ?? []).find((m) => m.id === target.id);
    if (!record || !msg) return;
    const state = stepStagePlayback(syncedState(record, msg), event);
    records.value = new Map(records.value).set(target.id, { ...record, state });
  }

  function advance(): boolean {
    const current = active.value;
    if (!current?.view.canAdvance) return false;
    apply(current.target, { type: 'advance' });
    return true;
  }

  function skipAll(target?: StageTarget): void {
    const resolved = target ?? active.value?.target;
    if (resolved) apply(resolved, { type: 'skipAll' });
  }

  function skipEverything(): void {
    if (draft.value) apply({ kind: 'draft' }, { type: 'skipAll' });
    for (const id of records.value.keys()) apply({ kind: 'message', id }, { type: 'skipAll' });
  }

  const holdOptions = computed(() => {
    if (!options.enabled()) return false;
    const list = options.messages() ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i];
      if (msg.role !== 'assistant' || isDiscardedAttempt(msg) || msg.diagnostic) continue;
      const record = records.value.get(msg.id);
      if (!record) return false;
      return !viewOf(stateFor(record, msg)).finished || msg.storyTurnStatus !== 'accepted';
    }
    return false;
  });

  return {
    recordFor,
    viewFor,
    draft,
    draftView,
    draftEpoch,
    active,
    advance,
    skipAll,
    skipEverything,
    holdOptions,
  };
}
