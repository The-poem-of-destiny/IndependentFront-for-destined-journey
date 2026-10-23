import type { AgentContext, LoreReadContext } from '../types/types';
import { resolveLocationHierarchy } from '../map/map-index';
import { getMapIndex } from '../map/map-runtime';

export const DEFAULT_LORE_HISTORY_MESSAGES = 6;

export function getLoreRecentMessages(ctx: Pick<AgentContext, 'history' | 'loreHistoryMessages'>) {
  const count = ctx.loreHistoryMessages ?? DEFAULT_LORE_HISTORY_MESSAGES;
  return count === 0
    ? []
    : ctx.history.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-count);
}

export function locationPathMatches(
  path: readonly string[],
  locations: readonly string[] = [],
): boolean {
  return locations.some((name) => name !== '' && path.some((segment) => segment.includes(name)));
}

/** Same bounded input for Story v2, legacy rendering, EJS reads and Delta signatures. */
export function loreRecentText(
  ctx: Pick<AgentContext, 'history' | 'userInput' | 'loreHistoryMessages'>,
): string {
  return [ctx.userInput, ...getLoreRecentMessages(ctx).map((m) => m.content)].join('\n');
}
export function createLoreReadContext(ctx: AgentContext): LoreReadContext {
  const location = ctx.characters.find((c) => c.type === 'player')?.location ?? '';
  return {
    location: resolveLocationHierarchy(getMapIndex(), location).reverse().join('-'),
    recentText: loreRecentText(ctx),
    gameTime: ctx.gameTime,
  };
}
