import type { ChatMessage } from '@engine/types';

/**
 * Zero-based ST-compatible message depth. App-owned system events do not occupy
 * a conversational slot; user and assistant messages share the same sequence.
 */
export function computeConversationalDepths(
  messages: readonly Pick<ChatMessage, 'id' | 'role'>[],
): Map<string, number> {
  const depths = new Map<string, number>();
  let depth = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    depths.set(message.id, depth);
    depth += 1;
  }
  return depths;
}
