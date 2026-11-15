/**
 * 从**已持久化**的消息推导回合恢复状态（审查 GAME-09 / GAME-10，2026-11-14）。纯函数。
 *
 * - GAME-09：失败标记与「再次尝试」原本只活在内存里的回合活动记录上，去一趟设置页 /
 *   刷新 / 切存档回来就没了，玩家只看见自己的输入，下面空空如也。持久化的信号是
 *   玩家消息上的 `storyTurnStatus`（pending / accepted / failed，管线对每条新输入都写）；
 *   早于这个字段的旧消息没有它，那就退回「最新一条玩家输入后面没有正文」。
 * - GAME-10：重试时旧的那次输出被标成 `storyTurnStatus: 'failed'` 但仍留在列表里；
 *   渲染时要把它们折成一行「已废弃的尝试（N）」，并且不参与「最新一条正文」的判断。
 */
import type { ChatMessage } from '@engine/types/types';

/** 已废弃的尝试：被标为失败的 assistant 正文 */
export function isDiscardedAttempt(
  message: Pick<ChatMessage, 'role' | 'storyTurnStatus'>,
): boolean {
  return message.role === 'assistant' && message.storyTurnStatus === 'failed';
}

export interface UnfinishedTurn {
  /** 没完成的那条玩家输入 */
  userMessageId: string;
  /**
   * failed = 存档里记着这回合失败；interrupted = 记着 pending 但已没有回合在跑
   * （生成途中离开 / 刷新）；no-reply = 旧存档没有状态字段，只知道这句输入后面没有正文
   */
  reason: 'failed' | 'interrupted' | 'no-reply';
}

/**
 * 最新一条玩家输入是否停在一个没完成的回合上。
 * @param hasLiveRecord 这条输入在内存里还有回合活动记录吗 —— 有就交给那张卡片，不重复显示
 * @param isGenerating 正在生成时一律不算（那一回合还没结束）
 */
export function findUnfinishedTurn(
  messages: readonly ChatMessage[],
  options: { isGenerating: boolean; hasLiveRecord: (userMessageId: string) => boolean },
): UnfinishedTurn | null {
  if (options.isGenerating) return null;
  let userIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return null;
  const user = messages[userIndex];
  if (options.hasLiveRecord(user.id)) return null;

  if (user.storyTurnStatus === 'failed') return { userMessageId: user.id, reason: 'failed' };
  if (user.storyTurnStatus === 'pending') return { userMessageId: user.id, reason: 'interrupted' };
  if (user.storyTurnStatus === 'accepted') return null;

  // 旧消息没有状态：后面有一段没被废弃的正文就算完成
  const hasReply = messages
    .slice(userIndex + 1)
    .some((m) => m.role === 'assistant' && !m.diagnostic && !isDiscardedAttempt(m));
  return hasReply ? null : { userMessageId: user.id, reason: 'no-reply' };
}

/**
 * 把连续的已废弃尝试分组（中间只隔着系统卡片也算连续）。
 * 返回：组首消息 id → 整组消息；以及所有组员 id（组首之外的成员不单独渲染）。
 */
export function groupDiscardedAttempts(messages: readonly ChatMessage[]): {
  groups: Map<string, ChatMessage[]>;
  memberIds: Set<string>;
} {
  const groups = new Map<string, ChatMessage[]>();
  const memberIds = new Set<string>();
  let current: ChatMessage[] | null = null;
  for (const message of messages) {
    if (isDiscardedAttempt(message)) {
      if (current) current.push(message);
      else {
        current = [message];
        groups.set(message.id, current);
      }
      memberIds.add(message.id);
    } else if (message.role !== 'system') {
      current = null;
    }
  }
  return { groups, memberIds };
}
