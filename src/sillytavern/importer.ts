/**
 * SillyTavern Import/Export Adapter
 */

import type { Lorebook, LorebookEntry, ChatPreset, SillyTavernLorebookExport } from './types';

const POSITION_MAP: Record<number, LorebookEntry['position']> = {
  0: 'before_char',
  1: 'after_char',
  2: 'before_example',
  3: 'after_example',
  4: 'at_depth',
  5: 'example_msg_top',
  6: 'example_msg_bottom',
  7: 'outlet',
};

const REVERSE_POSITION_MAP: Record<LorebookEntry['position'], number> = {
  before_char: 0,
  after_char: 1,
  before_example: 2,
  after_example: 3,
  at_depth: 4,
  example_msg_top: 5,
  example_msg_bottom: 6,
  outlet: 7,
};

const LOGIC_MAP: Record<number, LorebookEntry['selectiveLogic']> = {
  0: 'and_any',
  1: 'not_all',
  2: 'not_any',
  3: 'and_all',
};

const REVERSE_LOGIC_MAP: Record<LorebookEntry['selectiveLogic'], number> = {
  and_any: 0,
  not_all: 1,
  not_any: 2,
  and_all: 3,
};

export function importLorebook(
  data: SillyTavernLorebookExport,
): Omit<Lorebook, 'id' | 'createdAt' | 'updatedAt'> {
  const rawEntries = Object.values(data.entries || {});
  const entries: LorebookEntry[] = rawEntries
    .filter((e) => !e.disable && !e.excluded)
    .map((e) => ({
      id: crypto.randomUUID(),
      keys: e.key || [],
      secondaryKeys: e.keysecondary || [],
      content: e.content || '',
      comment: e.comment,
      order: e.order ?? 100,
      position: POSITION_MAP[e.position ?? 1] ?? 'after_char',
      depth: e.depth,
      role: e.role,
      selective: e.selective ?? false,
      selectiveLogic: LOGIC_MAP[e.selectiveLogic ?? 1] ?? 'not_all',
      constant: e.constant ?? false,
      probability: e.useProbability ? (e.probability ?? 100) : 100,
      useProbability: e.useProbability ?? false,
      addMemo: e.addMemo ?? false,
      sticky: e.sticky,
      cooldown: e.cooldown,
      delay: e.delay,
      weight: e.weight,
      scanDepth: e.scanDepth,
      caseSensitive: e.caseSensitive,
      matchWholeWords: e.matchWholeWords,
      excludeRecursion: e.excludeRecursion,
      preventRecursion: e.preventRecursion,
      useGroupScoring: e.useGroupScoring,
      matchPersonaDescription: e.matchPersonaDescription,
      matchCharacterDescription: e.matchCharacterDescription,
      matchCharacterPersonality: e.matchCharacterPersonality,
      matchCharacterDepthPrompt: e.matchCharacterDepthPrompt,
      matchScenario: e.matchScenario,
      matchCreatorNotes: e.matchCreatorNotes,
      group: e.group,
      decorators: e.decorators,
      characterFilter: e.characterFilter,
    }));

  return {
    name: data.name || '导入的世界书',
    description: data.description,
    entries,
    recursiveScanning: data.settings?.recursive_scanning ?? false,
    caseSensitive: data.settings?.case_sensitive ?? false,
    matchWholeWords: data.settings?.match_whole_words ?? false,
  };
}

export function exportLorebook(lorebook: Lorebook): SillyTavernLorebookExport {
  const entries: SillyTavernLorebookExport['entries'] = {};
  lorebook.entries.forEach((e, index) => {
    entries[String(index)] = {
      uid: index,
      key: e.keys,
      keysecondary: e.secondaryKeys || [],
      comment: e.comment || e.content.slice(0, 50),
      content: e.content,
      constant: e.constant,
      selective: e.selective,
      selectiveLogic: (REVERSE_LOGIC_MAP[e.selectiveLogic] ?? 1) as 0 | 1 | 2 | 3,
      addMemo: e.addMemo,
      order: e.order,
      position: REVERSE_POSITION_MAP[e.position] as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
      role: e.role ?? 0,
      disable: false,
      probability: e.probability,
      depth: e.depth ?? 4,
      group: e.group ?? '',
      useProbability: e.useProbability ?? e.probability < 100,
      excluded: false,
      sticky: e.sticky ?? 0,
      cooldown: e.cooldown ?? 0,
      delay: e.delay ?? 0,
      weight: e.weight ?? 100,
      scanDepth: e.scanDepth ?? 0,
      caseSensitive: e.caseSensitive ?? false,
      matchWholeWords: e.matchWholeWords ?? false,
      excludeRecursion: e.excludeRecursion ?? false,
      preventRecursion: e.preventRecursion ?? false,
      useGroupScoring: e.useGroupScoring ?? false,
      matchPersonaDescription: e.matchPersonaDescription ?? false,
      matchCharacterDescription: e.matchCharacterDescription ?? false,
      matchCharacterPersonality: e.matchCharacterPersonality ?? false,
      matchCharacterDepthPrompt: e.matchCharacterDepthPrompt ?? false,
      matchScenario: e.matchScenario ?? false,
      matchCreatorNotes: e.matchCreatorNotes ?? false,
      decorators: e.decorators ?? [],
      characterFilter: e.characterFilter ?? { isExclude: false, names: [], tags: [] },
    };
  });

  return {
    name: lorebook.name,
    description: lorebook.description,
    entries,
    settings: {
      recursive_scanning: lorebook.recursiveScanning,
      case_sensitive: lorebook.caseSensitive,
      match_whole_words: lorebook.matchWholeWords,
    },
  };
}

export function importPreset(
  data: Record<string, any>,
): Omit<ChatPreset, 'id' | 'createdAt' | 'updatedAt'> {
  const name = data.preset || data.name || '导入的预设';
  return {
    name,
    description: data.description,
    settings: data,
  };
}

export function exportPreset(preset: ChatPreset): Record<string, any> {
  return {
    ...preset.settings,
    name: preset.name,
    description: preset.description,
  };
}

export async function importJsonFile<T>(): Promise<T | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        const text = await file.text();
        resolve(JSON.parse(text) as T);
      } catch {
        resolve(null);
      }
    };
    input.click();
  });
}

export function exportToJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export interface MultiImportInput {
  fileName: string;
  json: SillyTavernLorebookExport;
}

export interface MultiImportResults {
  successes: Array<{ fileName: string; lorebook: ReturnType<typeof importLorebook> }>;
  failures: Array<{ fileName: string; error: string }>;
}

export function importMultipleLorebooks(inputs: MultiImportInput[]): MultiImportResults {
  const successes: MultiImportResults['successes'] = [];
  const failures: MultiImportResults['failures'] = [];
  for (const input of inputs) {
    try {
      if (!input.json || typeof input.json !== 'object' || Array.isArray(input.json)) {
        throw new Error('Invalid lorebook JSON: expected an object');
      }
      const lb = importLorebook(input.json);
      successes.push({ fileName: input.fileName, lorebook: lb });
    } catch (e) {
      failures.push({ fileName: input.fileName, error: String((e as Error).message ?? e) });
    }
  }
  return { successes, failures };
}

export function renameLorebook(lb: Lorebook, newName: string): Lorebook {
  return { ...lb, name: newName, updatedAt: Date.now() };
}
