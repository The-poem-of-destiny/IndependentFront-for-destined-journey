import type { ChatMessage } from '@engine/types/types';
import { isDiscardedAttempt } from './turn-recovery';

/**
 * Zero-based ST-compatible message depth. App-owned system events do not occupy
 * a conversational slot; user and assistant messages share the same sequence.
 *
 * 已废弃的尝试（`storyTurnStatus === 'failed'` 的 assistant 正文）同样**不占**槽位：
 * 界面上它们已折叠、提示词组装也不交给模型，按深度门控的美化规则应与玩家看到的一致。
 */
export function computeConversationalDepths(
  messages: readonly Pick<ChatMessage, 'id' | 'role' | 'storyTurnStatus'>[],
): Map<string, number> {
  const depths = new Map<string, number>();
  let depth = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (isDiscardedAttempt(message)) continue;
    depths.set(message.id, depth);
    depth += 1;
  }
  return depths;
}
