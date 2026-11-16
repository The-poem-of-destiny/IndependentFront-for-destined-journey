/**
 * useFreshMessages — 分辨「刚刚到来的消息」与「载入的历史」（动效 v1 · 特效层）
 *
 * 挂载时已在场的消息、以及整体换数组（载入存档 / 快照回退）带来的消息一律算历史；
 * 只有挂载之后**往同一个数组里 push** 进来的消息才算新鲜，并记下它是否经过流式草稿：
 *
 * - 流式过的：正文早已在草稿里逐词洇开，提交时只需静默换成正式消息（不重播入场）；
 * - 没流式过的：整条一次到达，可以整体墨迹浮现一次。
 *
 * 「是否流式」按代判定：`isGenerating` 每次从假变真开新一代；草稿文本非空过即「欠」一条流式提交。
 * 草稿在提交**之前**就会被清空，所以不能看 push 那一刻的草稿。
 * 🔴 这份「欠账」只由**第一条**随后进来的 assistant 消息领走，生成结束时也清掉 —— 同一代里
 *    流式提交之后再推进来的 assistant 行（状态写入失败通知、战斗摘要、craft 叙述）以及生成之外
 *    推进来的消息，草稿里根本没出现过，必须照常播放入场。
 *
 * 状态是一个整体替换的 shallowRef：只在消息增减时变化，不随草稿逐字变化。
 */
import { onMounted, shallowRef, watch, type Ref } from 'vue';
import type { ChatMessage } from '@engine/types/types';

interface FreshInfo {
  /** 到来之前这一代生成是否已经有过流式草稿 */
  streamed: boolean;
}

export interface FreshMessagesOptions {
  messages: () => readonly ChatMessage[] | undefined;
  isGenerating: () => boolean;
  streamingText: () => string | undefined;
}

export interface FreshMessages {
  fresh: Readonly<Ref<ReadonlyMap<string, FreshInfo>>>;
  isFresh: (id: string) => boolean;
  wasStreamed: (id: string) => boolean;
}

export function useFreshMessages(options: FreshMessagesOptions): FreshMessages {
  const fresh = shallowRef<ReadonlyMap<string, FreshInfo>>(new Map());
  let known = new Set<string>();
  let currentArray: readonly ChatMessage[] | undefined;
  let streamedThisGeneration = false;
  let mounted = false;

  function rebaseline(list: readonly ChatMessage[] | undefined): void {
    currentArray = list;
    known = new Set((list ?? []).map((message) => message.id));
    if (fresh.value.size > 0) fresh.value = new Map();
  }

  /** 把数组里还没见过的消息登记为新鲜；流式欠账由第一条 assistant 领走 */
  function collect(list: readonly ChatMessage[] | undefined): void {
    let next: Map<string, FreshInfo> | null = null;
    for (const message of list ?? []) {
      if (known.has(message.id)) continue;
      known.add(message.id);
      const streamed = message.role === 'assistant' && streamedThisGeneration;
      if (streamed) streamedThisGeneration = false;
      next ??= new Map(fresh.value);
      next.set(message.id, { streamed });
    }
    if (next) fresh.value = next;
  }

  watch([options.isGenerating, options.streamingText], ([generating, text], [wasGenerating]) => {
    if (generating !== wasGenerating && mounted) {
      // 换代前先把同一拍里推进来的消息按旧账登记（push 与 isGenerating 翻转可能同拍到达）
      const list = options.messages();
      if (list === currentArray) collect(list);
      streamedThisGeneration = false;
    }
    if (generating && text) streamedThisGeneration = true;
  });

  watch(
    () => {
      const list = options.messages();
      return [list, list?.length ?? 0] as const;
    },
    ([list]) => {
      if (!mounted) return;
      if (list !== currentArray) {
        rebaseline(list);
        return;
      }
      collect(list);
    },
  );

  onMounted(() => {
    mounted = true;
    rebaseline(options.messages());
  });

  return {
    fresh,
    isFresh: (id) => fresh.value.has(id),
    wasStreamed: (id) => fresh.value.get(id)?.streamed === true,
  };
}
