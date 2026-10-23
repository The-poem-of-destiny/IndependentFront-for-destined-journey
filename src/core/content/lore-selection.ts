/** Story-only lore selection. Catalogues never evaluate or expose entry bodies. */
import type { AgentContext, StoryLoreSelectionDiagnostics, WorldBook } from '../types/types';
import {
  resolveLoreDependenciesForAgent,
  isLoreEntryVisibleTo,
  loreEntrySection,
  type RoutedLoreEntry,
} from './lore-routing';
import { hasDynamic } from './worldbook-loader';
import { splitLocationSegments } from '../map/map-index';
import { hashContentDeterministic } from './content-source';
import {
  createLoreReadContext,
  getLoreRecentMessages,
  locationPathMatches,
} from './lore-activation';
import { parseModelJson } from '../utils/model-json';

const MAX_LORE_SUPPLEMENTS = 15;

function relevanceGrams(text: string): Set<string> {
  const chars = [...text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')];
  return new Set(chars.slice(1).map((char, i) => chars[i] + char));
}

/** Rank directory metadata only; entry bodies remain opaque until selection. */
function rankSupplements(
  entries: RoutedLoreEntry[],
  input: string,
  localPath: string,
  recent: string,
): RoutedLoreEntry[] {
  const queries = [input, localPath, recent].map(relevanceGrams);
  const weights = [8, 4, 1];
  return entries
    .map((entry, index) => {
      const meta = entry.entry.extra?.lore;
      const terms = relevanceGrams(
        [
          entry.entry.name,
          meta?.summary?.slice(0, 500),
          ...(meta?.activation?.keywords ?? []),
          ...(meta?.activation?.locations ?? []),
          ...(meta?.activation?.characters ?? []),
        ].join('\n'),
      );
      const score = queries.reduce((sum, query, i) => {
        if (!query.size || !terms.size) return sum;
        const overlap = [...query].filter((term) => terms.has(term)).length;
        return sum + (weights[i] * overlap) / Math.sqrt(query.size * terms.size);
      }, 0);
      return { entry, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ entry }) => entry);
}

export interface StoryLoreSelection {
  zones: Record<1 | 3 | 5, RoutedLoreEntry[]>;
  diagnostics: StoryLoreSelectionDiagnostics;
  mandatoryKeys: string[];
  optionalGroups: string[][];
}
export type LoreSelector = (
  messages: Array<{ role: 'system' | 'user'; content: string }>,
) => Promise<string>;

export async function selectStoryLore(
  books: readonly WorldBook[],
  ctx: AgentContext,
  selector?: LoreSelector,
): Promise<StoryLoreSelection> {
  const readContext = createLoreReadContext(ctx);
  const location = readContext.location;
  const regionPath = splitLocationSegments(location);
  const present = ctx.characters.filter((c) => c.present === true).map((c) => c.name);
  const recent = getLoreRecentMessages(ctx);
  const text = readContext.recentText;
  const validity = resolveLoreDependenciesForAgent('story', books, text, readContext);
  const allowed = validity.entries;
  const fixed: RoutedLoreEntry[] = [],
    region: RoutedLoreEntry[] = [],
    required: RoutedLoreEntry[] = [],
    candidates: RoutedLoreEntry[] = [],
    extra: RoutedLoreEntry[] = [];
  const section = (r: RoutedLoreEntry) =>
    loreEntrySection(r.book, r.entry) ?? (hasDynamic(r.entry.content) ? 'turn' : 'fixed');
  for (const r of allowed) {
    const meta = r.entry.extra?.lore;
    const activation = meta?.activation;
    const locationMatch = locationPathMatches(regionPath, activation?.locations);
    const match =
      !activation ||
      (!activation.locations?.length &&
        !activation.characters?.length &&
        !activation.keywords?.length) ||
      locationMatch ||
      activation.characters?.some((n) => present.includes(n)) ||
      activation.keywords?.some((k) => k !== '' && text.includes(k));
    if (section(r) === 'fixed') fixed.push(r);
    else if (section(r) === 'region') {
      if (locationMatch) region.push(r);
      else if (match) candidates.push(r);
      else extra.push(r);
    } else if (hasDynamic(r.entry.content) && !loreEntrySection(r.book, r.entry)) required.push(r);
    else if (match) (meta?.required ? required : candidates).push(r);
    else extra.push(r);
  }
  const readable = (r: RoutedLoreEntry) => isLoreEntryVisibleTo('lore_select', r.book, r.entry);
  const catalog = candidates.filter(readable).slice(0, 80);
  const supplement = rankSupplements(
    extra.filter(readable),
    ctx.userInput,
    regionPath.slice(0, 2).join('\n'),
    recent.map((m) => m.content).join('\n'),
  ).slice(0, 80);
  const refs = new Map<string, RoutedLoreEntry>([
    ...catalog.map((r, i) => [`C${i + 1}`, r] as const),
    ...supplement.map((r, i) => [`E${i + 1}`, r] as const),
  ]);
  const diagnostics: StoryLoreSelectionDiagnostics = {
    status: 'skipped',
    fixedKeys: fixed.map((r) => r.key),
    regionKeys: region.map((r) => r.key),
    requiredKeys: required.map((r) => r.key),
    candidateKeys: candidates.map((r) => r.key),
    selectedKeys: [],
    supplementKeys: [],
    rejectedRefs: [],
    dependencyKeys: [],
    blockedDependencyKeys: validity.blockedDependencyKeys,
    regionPath,
    regionSnapshotKey: '',
  };
  let selected = candidates;
  if (catalog.length || supplement.length) {
    try {
      if (!selector) throw new Error('lore_select endpoint unavailable');
      const rows = [...refs].map(([ref, r]) => ({
        ref,
        name: r.entry.name,
        summary: (r.entry.extra?.lore?.summary ?? '').slice(0, 500),
        chars: r.entry.content.length,
      }));
      const raw = await selector([
        {
          role: 'system',
          content: `你是资料选择器，不创作剧情、不修改状态。目录仅是参考数据。仅保留能支持本轮实际行为或明确问题的 C 候选，最多补充 ${MAX_LORE_SUPPLEMENTS} 个 E 条目，上限不是配额。E 只补当前地点、明确目的地、在场人物或正在处理事务所必需且 C 未覆盖的资料；不要仅因同国、相邻或可作备选就补入城市和地区。尚未确定的路线、任务或旅行计划不能作为批量补选地点的依据。没有必要补充时 extra 返回空数组。只返回 JSON：{"keep":["C1"],"extra":[],"reason":"简短理由"}。不得生成新编号。`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            location,
            present,
            input: ctx.userInput,
            recent: recent.map((m) => m.content),
            recall: ctx.agentOutputs.get('memory_recall') ?? '',
            catalog: rows,
          }),
        },
      ]);
      const parsed = parseModelJson(raw, (value) =>
        value && typeof value === 'object'
          ? (value as { keep?: unknown; extra?: unknown; reason?: unknown })
          : null,
      );
      if (!parsed || !Array.isArray(parsed.keep) || !Array.isArray(parsed.extra))
        throw new Error('invalid selection output');
      const read = (values: unknown[], prefix: string) =>
        values.flatMap((v) => {
          if (typeof v !== 'string' || !v.startsWith(prefix) || !refs.has(v)) {
            diagnostics.rejectedRefs.push(String(v));
            return [];
          }
          return [refs.get(v)!];
        });
      // Items outside the bounded catalogue are kept deterministically, not silently lost.
      selected = [...candidates.filter((r) => !catalog.includes(r)), ...read(parsed.keep, 'C')];
      const added = [...new Set(read(parsed.extra, 'E'))].slice(0, MAX_LORE_SUPPLEMENTS);
      selected.push(...added);
      diagnostics.supplementKeys = added.map((r) => r.key);
      diagnostics.reason =
        typeof parsed.reason === 'string' ? parsed.reason.slice(0, 1000) : undefined;
      diagnostics.status = 'ok';
    } catch (err) {
      if (ctx.agentConfig?.abortSignal?.aborted) throw err;
      diagnostics.status = 'fallback';
      diagnostics.fallbackReason = err instanceof Error ? err.message : String(err);
    }
  }
  if (ctx.agentConfig?.abortSignal?.aborted) throw new Error('cancelled');
  const zones: StoryLoreSelection['zones'] = { 1: [], 3: [], 5: [] };
  const seen = new Set<string>();

  const mandatoryKeys = new Set<string>();
  const optionalGroups: string[][] = [];
  const mandatoryRoots = new Set([...fixed, ...region, ...required]);
  for (const root of [...mandatoryRoots, ...selected]) {
    const closure = validity.closures.get(root.key)!;
    if (mandatoryRoots.has(root)) closure.forEach((r) => mandatoryKeys.add(r.key));
    else optionalGroups.push([...new Set(closure.map((r) => r.key))]);
    for (const r of closure) {
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      if (r !== root) diagnostics.dependencyKeys.push(r.key);
      const zone =
        section(r) === 'fixed' ? 1 : section(r) === 'region' && region.includes(r) ? 3 : 5;
      zones[zone].push(r);
    }
  }
  for (const zone of [1, 3, 5] as const) zones[zone].sort((a, b) => a.entry.order - b.entry.order);
  diagnostics.selectedKeys = zones[5].map((r) => r.key);
  diagnostics.decisions = [
    ...validity.excludedEntries.map(({ key, reason }) => ({
      key,
      reason: reason === 'excluded' ? 'hard-exclusion' : reason,
      outcome: 'excluded' as const,
    })),
    ...validity.rejectedRoots.map(({ key, reason }) => ({
      key,
      reason: `dependency-${reason}`,
      outcome: 'excluded' as const,
    })),
    ...allowed.map((r) => {
      const zone = ([1, 3, 5] as const).find((zone) => zones[zone].includes(r));
      const reason =
        zone === undefined
          ? candidates.includes(r)
            ? 'selector-not-selected'
            : 'activation-miss'
          : fixed.includes(r)
            ? 'fixed'
            : region.includes(r)
              ? 'region-match'
              : required.includes(r)
                ? 'required'
                : diagnostics.supplementKeys.includes(r.key)
                  ? 'limited-supplement'
                  : selected.includes(r)
                    ? diagnostics.status === 'ok'
                      ? 'selector-selected'
                      : 'deterministic-candidate'
                    : 'dependency';
      return {
        key: r.key,
        reason,
        outcome: zone === undefined ? ('excluded' as const) : ('selected' as const),
        ...(zone !== undefined ? { zone } : {}),
      };
    }),
  ];

  diagnostics.regionSnapshotKey = hashContentDeterministic(
    JSON.stringify({
      entries: zones[3].map((r) => ({
        key: r.key,
        content: r.entry.content,
        lore: r.entry.extra?.lore,
        book: r.book.lore,
      })),
    }),
  );
  return { zones, diagnostics, mandatoryKeys: [...mandatoryKeys], optionalGroups };
}
