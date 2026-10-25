import type {
  AgentContext,
  LoreActivation,
  LoreAnnualWindow,
  LoreReadContext,
} from '../types/types';
import { resolveLocationHierarchy, splitLocationSegments } from '../map/map-index';
import { getMapIndex } from '../map/map-runtime';
import { toEpochMinutes } from '../time/time-system';

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

function inAnnualWindow(window: LoreAnnualWindow, time: LoreReadContext['gameTime']): boolean {
  if (!time) return false;
  const now = toEpochMinutes(time);
  // Anchor to the celebration year, not the expanded window's year.
  return [time.year - 1, time.year, time.year + 1].some((year) => {
    const start = toEpochMinutes({ ...time, year, ...window.start, hour: 0, minute: 0 });
    const crossesYear =
      window.end.month * 30 + window.end.day < window.start.month * 30 + window.start.day;
    const end = toEpochMinutes({
      ...time,
      year: year + Number(crossesYear),
      ...window.end,
      hour: 0,
      minute: 0,
    });
    return now >= start - window.beforeDays * 1440 && now < end + (window.afterDays + 1) * 1440;
  });
}

/** Only explicit v2 contexts opt in; legacy relevance and read semantics stay unchanged. */
export function passesLoreReadWhen(
  activation: LoreActivation | undefined,
  ctx?: LoreReadContext,
): boolean {
  if (!ctx || !activation?.readWhen) return true;
  const path = splitLocationSegments(ctx.location);
  return activation.readWhen.any.some(
    (branch) =>
      (branch.locations === undefined || locationPathMatches(path, branch.locations)) &&
      (branch.keywords === undefined ||
        branch.keywords.some((word) => word !== '' && ctx.recentText.includes(word))) &&
      (branch.annualWindow === undefined || inAnnualWindow(branch.annualWindow, ctx.gameTime)),
  );
}
