/**
 * snapshot-turn-context.ts — 快照面板的「这一档是哪一回合」辨认信息（纯函数，SNP-01）
 *
 * 快照行原先只有回合号 / 原因 / 主角 HP / 日期 / 现实时间，恢复又不可逆，玩家只能猜。
 * 这里从**当前已载入的消息列表**里找出该快照那一回合的玩家输入与正文首句，供面板显示。
 *
 * 🔴 不读快照载荷（v22 拆表的硬约束：列表只读 `SnapshotMeta`），也不改快照结构 ——
 *    数据全部来自 game store 里已经在内存的 `messages`。
 *
 * 映射口径（与 game-store `rollbackOneTurn` 同一约定）：
 * - 快照 `turn` = 已完成回合数；玩家第 N 次输入的消息 `turn === N`，其后的正文同 `turn`。
 * - 额外要求消息 `timestamp <= snapshot.createdAt`：恢复到较早回合后重新打出的同号回合
 *   比旧的「向前」快照晚，不能把新输入安到旧快照上。
 * - 找不到（消息被裁剪 / 恢复后已不在当前分支）→ 返回 null，面板什么都不多显示。
 */
import type { ChatMessage, SnapshotMeta } from '@engine/types/types';

export interface SnapshotTurnContext {
  /** 玩家那一回合的完整输入（去首尾空白） */
  input: string;
  /** 截断后的输入摘录 */
  inputExcerpt: string;
  /** 正文首句（已去标签、截断）；没有正文时为空串 */
  narrativeLead: string;
}

/** 输入摘录长度上限（字符） */
export const SNAPSHOT_INPUT_EXCERPT_MAX = 40;
/** 正文首句长度上限（字符） */
const SNAPSHOT_NARRATIVE_LEAD_MAX = 60;

/** 按字符截断，超长补省略号 */
export function truncateText(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join('')}…`;
}

/** 正文首句：去掉 XML 式标签（`<maintext>`、插画标记等），压缩空白，取第一个句末标点为止 */
export function firstSentenceOf(content: string): string {
  const plain = content
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain === '') return '';
  const match = plain.match(/^.*?[。！？!?…]+[」』”"]?/u);
  const sentence = match ? match[0] : plain;
  return truncateText(sentence.trim(), SNAPSHOT_NARRATIVE_LEAD_MAX);
}

function isStoryMessage(m: ChatMessage): boolean {
  return m.diagnostic !== true && m.storyTurnStatus !== 'failed' && m.storyTurnStatus !== 'pending';
}

/**
 * 找出快照那一回合的玩家输入与正文首句。找不到玩家输入时返回 null。
 */
export function findSnapshotTurnContext(
  snap: Pick<SnapshotMeta, 'turn' | 'createdAt'>,
  messages: readonly ChatMessage[],
): SnapshotTurnContext | null {
  let userIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (
      m.role === 'user' &&
      m.turn === snap.turn &&
      m.timestamp <= snap.createdAt &&
      isStoryMessage(m) &&
      m.content.trim() !== ''
    ) {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return null;

  const input = messages[userIndex].content.trim();
  let narrativeLead = '';
  for (let i = userIndex + 1; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role === 'user') break;
    if (
      m.role === 'assistant' &&
      m.turn === snap.turn &&
      m.timestamp <= snap.createdAt &&
      isStoryMessage(m)
    ) {
      narrativeLead = firstSentenceOf(m.content);
      if (narrativeLead !== '') break;
    }
  }

  return {
    input,
    inputExcerpt: truncateText(input.replace(/\s+/g, ' '), SNAPSHOT_INPUT_EXCERPT_MAX),
    narrativeLead,
  };
}
