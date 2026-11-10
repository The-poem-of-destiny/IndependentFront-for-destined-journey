import type { DirectGenerationInput } from '../agents/direct-main';
import type { AgentContext, CharacterState, ChatPreset, WorldBookEntry } from '../types/types';
import { buildAgentMessagesAsync } from './agent-templates';
import { resolveTemplateWithGlobals } from './template-resolver';
import { buildCharacterContext } from '../character/character-chronicle';
import type { DirectContextFrame } from './direct-context-session';
import { DIRECT_TEMPLATE } from './direct-prompt';
import {
  parseSetvars,
  resolveGetvars,
  resolveRandoms,
  preprocessPresetEntryContents,
} from './preset-loader';
import { isStoryZonePlaceholder, type PresetEntryLike } from './story-zone-placeholders';

/** Each group is an absolute value; changing HP never resends profiles or inventory. */
export function buildDirectCharacterSections(
  characters: readonly CharacterState[],
): Record<string, unknown> {
  const sections: Record<string, unknown> = {};
  const resources = [];
  for (const character of characters) {
    const {
      id: _id,
      saveId: _saveId,
      definition: _definition,
      introducedBy: _introducedBy,
      hp,
      maxHp,
      mp,
      maxMp,
      sp,
      maxSp,
      skills,
      inventory,
      statusEffects,
      ...profile
    } = character;
    const key = `character/${character.name}`;
    sections[`${key}/profile`] = profile;
    sections[`${key}/skills`] = skills;
    sections[`${key}/inventory`] = inventory;
    sections[`${key}/statusEffects`] = statusEffects;
    resources.push({ name: character.name, hp, maxHp, mp, maxMp, sp, maxSp });
  }
  return { ...sections, resources };
}

/** Move engine-owned changing inputs out of the prefix; custom dynamic instructions still rebase. */
export async function buildLegacyDirectCacheFrame(
  input: DirectGenerationInput,
  books: DirectGenerationInput['worldBooks'],
  history: string,
  fixedEntries: ReadonlySet<WorldBookEntry> = new Set(),
): Promise<DirectContextFrame> {
  const preset = input.presets.find((p) => p.id === input.config.presetId);
  const presetSettings = (preset as ChatPreset | undefined)?.settings;
  const rawPrompts = presetSettings?.prompts;
  const prompts: PresetEntryLike[] | undefined = Array.isArray(rawPrompts) ? rawPrompts : undefined;
  const marked = prompts?.some((p) => p.directCachePlacement === 'turn' && p.enabled !== false);
  const ordered = marked
    ? prompts!
        .filter((p) => p.enabled !== false && p.role !== 'assistant' && !isStoryZonePlaceholder(p))
        .sort((a, b) => Number(a.injection_order ?? 0) - Number(b.injection_order ?? 0))
    : [];
  const processed = preprocessPresetEntryContents(ordered);
  const dynamic = ordered.flatMap((p, i) =>
    p.directCachePlacement === 'turn' ? [processed[i]] : [],
  );
  const fixedPrompts: PresetEntryLike[] | undefined = marked
    ? ordered.flatMap((p, i) =>
        p.directCachePlacement === 'turn' ? [] : [{ ...p, content: processed[i] }],
      )
    : prompts;
  const fixedPreset =
    marked && preset
      ? { ...preset, settings: { ...presetSettings, prompts: fixedPrompts } }
      : preset;
  const presets = input.presets.map((p) => (p === preset ? fixedPreset! : p));
  const authored = Array.isArray(fixedPrompts)
    ? fixedPrompts
        .filter((p) => p.enabled !== false && p.directCachePlacement !== 'turn')
        .map((p) => p.content)
        .join('\n')
    : [preset?.fixedSystem, preset?.fixedExamples, input.config.systemPrompt].join('\n');
  const template = input.config.template?.replace(/\r\n/g, '\n').trim();
  // Authored macros and custom layouts retain their original positions. Their rendered
  // prefix participates in the signature, so changing input safely rebuilds the session.
  const authoredLayout = !!((template && template !== DIRECT_TEMPLATE) || /\{\{|<%/.test(authored));
  const moving = [
    'NARRATIVE',
    'USER_INPUT',
    'LORE_BOOK',
    'LORE_BOOK_STATIC',
    'LORE_BOOK_DYNAMIC',
    'CHARACTER_STATE',
    'GAME_TIME',
    'MAP_CONTEXT',
    'RANDOM_EVENTS',
    'MEMORY_ENTRIES',
    'AGENT.MEMORY_RECALL',
    'CHARACTER_CONTEXT',
  ];
  let rendered: AgentContext = input.context;
  let renderedEntries: ReadonlyMap<WorldBookEntry, string> = new Map();
  const prefix = await buildAgentMessagesAsync(
    'direct_main',
    input.context,
    input.configs,
    books,
    presets,
    authoredLayout ? { NARRATIVE: history } : Object.fromEntries(moving.map((k) => [k, ''])),
    (ctx, entries) => {
      rendered = ctx;
      renderedEntries = entries;
    },
  );
  if (!prefix) throw new Error('直出提示词未配置');
  const resolve = (text: string) =>
    resolveTemplateWithGlobals(
      text,
      'direct_main',
      rendered,
      input.config,
      books,
      input.configs,
      {},
    );
  const authoredTurn = dynamic.map(resolve).filter(Boolean).join('\n');
  if (authoredLayout)
    return {
      prefix: prefix.map((m) => ({ role: 'system', content: m.content })),
      history: [],
      sections: authoredTurn ? { authoredTurn } : {},
    };
  const fixed: string[] = [];
  const current: string[] = [];
  for (const [entry, text] of renderedEntries) {
    const content = resolveRandoms(
      resolveGetvars(parseSetvars(text).stripped, rendered.ejsPass?.stDefinitions ?? {}),
    );
    (fixedEntries.has(entry) ? fixed : current).push(content);
  }
  return {
    prefix: [
      ...prefix.map((m) => ({ role: 'system' as const, content: m.content })),
      ...(fixed.length ? [{ role: 'system' as const, content: fixed.join('\n\n') }] : []),
    ],
    history: history ? [{ role: 'system', content: history }] : [],
    sections: {
      currentLore: current.join('\n\n'),
      mapContext: resolve('{{MAP_CONTEXT}}'),
      randomEvents: resolve('{{RANDOM_EVENTS}}'),
      memoryEntries: resolve('{{MEMORY_ENTRIES}}'),
      characterContext: buildCharacterContext(input.context),
      ...(authoredTurn ? { authoredTurn } : {}),
    },
  };
}
