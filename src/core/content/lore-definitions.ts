import type { FixedLoreSnapshot, LoreReadContext, WorldBook, WorldBookEntry } from '../types/types';
import { resolveLoreDependenciesForAgent } from './lore-routing';
import { parseSetvars, preprocessEntry, type SetvarMap } from '../prompts/preset-loader';
import { hashContentDeterministic } from './content-source';

export interface LoreDefinitionEnvironment {
  values: SetvarMap;
  sources: Record<string, string>;
  deferredKeys: string[];
}

/** Stable source order, independent of zones, selection and budget. Never evaluates EJS. */
export function buildLoreDefinitions(
  agentId: string,
  books: readonly WorldBook[],
  recentText = '',
  readContext?: LoreReadContext,
  rendered?: ReadonlyMap<WorldBookEntry, string>,
): LoreDefinitionEnvironment {
  const values: SetvarMap = Object.create(null);
  const sources: Record<string, string> = Object.create(null);
  const deferredKeys: string[] = [];
  const readable = resolveLoreDependenciesForAgent(agentId, books, recentText, readContext).entries;
  // Stable sort retains book order and original entry order for equal injection orders.
  for (const r of [...readable].sort((a, b) => a.entry.order - b.entry.order)) {
    const projection = r.entry.extra?.lore?.definitions;
    const text = rendered?.get(r.entry) ?? r.entry.content;
    if (!projection && text.includes('<%')) {
      if (text.includes('{{setvar::')) deferredKeys.push(r.key);
      continue;
    }
    const definitions = projection ?? parseSetvars(text).variables;
    for (const [name, value] of Object.entries(definitions)) {
      values[name] = value;
      sources[name] = r.key;
    }
  }
  return { values, sources, deferredKeys };
}

export function missingLoreDefinitions(content: string, definitions: SetvarMap): string[] {
  return [
    ...new Set(
      [...content.matchAll(/\{\{getvar::([^}:]+)(?:::)?\}\}/g)]
        .map((m) => m[1].trim())
        .filter((key) => !Object.prototype.hasOwnProperty.call(definitions, key)),
    ),
  ];
}

/** Opening results are facts, not a rebuildable prompt cache. Failure aborts creation. */
export function createFixedLoreSnapshot(
  books: readonly WorldBook[],
  opts?: { characterName?: string; userName?: string },
  readContext: LoreReadContext = { location: '', recentText: '' },
): FixedLoreSnapshot {
  const definitions = buildLoreDefinitions('story', books, readContext.recentText, readContext);
  const snapshot: FixedLoreSnapshot = Object.create(null);
  for (const r of resolveLoreDependenciesForAgent(
    'story',
    books,
    readContext.recentText,
    readContext,
  ).entries) {
    if (r.entry.extra?.lore?.evaluation !== 'onCreate') continue;
    if (
      r.entry.extra.lore.section !== 'fixed' ||
      r.entry.extra.lore.activation?.readWhen ||
      /<%|\{\{random/.test(r.entry.content)
    )
      throw new Error(`Opening lore requires fixed literal/ST content without readWhen: ${r.key}`);
    const missing = missingLoreDefinitions(r.entry.content, definitions.values);
    if (missing.length)
      throw new Error(`Opening lore ${r.key} missing definitions: ${missing.join(', ')}`);
    const text = preprocessEntry(r.entry.content, definitions.values, opts);
    if (!text.trim()) throw new Error(`Opening lore ${r.key} resolved to empty text`);
    snapshot[r.key] = {
      text,
      sourceHash: hashContentDeterministic(r.entry.content),
      definitionSources: { ...definitions.sources },
    };
  }
  return snapshot;
}
