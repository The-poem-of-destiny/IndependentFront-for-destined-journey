import type { AssetMetaRecord, CharacterState, WorldBook } from '../types/types';
import type { CharacterDefinition, CharacterPastEntry } from '../types/types-character';
import { ASSET_TYPES } from '../types/types';
import { getContentRegistry } from '../content/content-registry-runtime';
import { extractRemoteAssetDecls } from '../assets/remote-asset-catalogue';
import { isRecord, parseCharacterProfile, parseChronicleDraft } from './character-updates';

/** Content boundary: bad definitions are diagnosed independently, never evaluated as scripts. */
export function readCharacterDefinitions(raw: unknown): CharacterDefinition[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    console.warn('[characters] 原生角色定义必须为数组');
    return [];
  }
  const definitions: CharacterDefinition[] = [];
  for (const row of raw) {
    const profile = isRecord(row) ? parseCharacterProfile(row.profile ?? {}) : null;
    if (
      !isRecord(row) ||
      typeof row.id !== 'string' ||
      !row.id ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      !profile ||
      !Array.isArray(row.assets) ||
      !Array.isArray(row.past)
    ) {
      console.warn('[characters] 跳过无效的角色定义');
      continue;
    }
    const name = row.name.trim();
    if (definitions.some((d) => d.id === row.id || d.name === name)) {
      console.warn('[characters] 跳过重复的角色定义', row.id);
      continue;
    }
    const past = row.past.map(parseChronicleDraft);
    if (past.some((p) => !p || p.time.kind !== 'past')) {
      console.warn('[characters] 角色初始经历无效', row.id);
      continue;
    }
    const assets: CharacterDefinition['assets'] = [];
    for (const asset of row.assets) {
      if (
        !isRecord(asset) ||
        !(ASSET_TYPES as readonly unknown[]).includes(asset.type) ||
        (typeof asset.assetId !== 'string' && typeof asset.url !== 'string')
      ) {
        console.warn('[characters] 跳过无效素材关联', row.id);
        continue;
      }
      assets.push({
        type: asset.type as CharacterDefinition['assets'][number]['type'],
        ...(typeof asset.assetId === 'string' ? { assetId: asset.assetId } : {}),
        ...(typeof asset.url === 'string' && /^https?:\/\//i.test(asset.url)
          ? { url: asset.url }
          : {}),
        ...(typeof asset.variant === 'string' ? { variant: asset.variant } : {}),
      });
    }
    definitions.push({
      id: row.id,
      name: row.name.trim(),
      profile,
      assets,
      past: past as CharacterPastEntry[],
      ...(typeof row.lore === 'string' ? { lore: row.lore } : {}),
    });
  }
  return definitions;
}

/** Read-only compatibility conversion. Retain unrecognized/dynamic entries as lore. */
export function legacyCharacterDefinitions(books: readonly WorldBook[]): CharacterDefinition[] {
  const definitions: CharacterDefinition[] = [];
  for (const book of books) {
    if (book.partition !== 'character') continue;
    for (const entry of book.entries) {
      if (entry.enabled === false) continue;
      const declarations = extractRemoteAssetDecls(entry.content);
      const names = [...new Set(declarations.map((d) => d.name))];
      // Only migrate a positively identified, single-person profile. No guessed names.
      if (names.length !== 1) continue;
      const name = names[0];
      const lore = entry.content
        .replace(
          /<%#\s*char-info-ejs-builder:start(?::v\d+)?\s*%>[\s\S]*?<%#\s*char-info-ejs-builder:end(?::v\d+)?\s*%>/g,
          '',
        )
        .trim();
      if (!lore || /<%/.test(lore)) continue;
      definitions.push({
        id: `legacy:${book.id}:${entry.uid}`,
        name,
        profile: {},
        lore,
        past: [],
        assets: declarations.map(({ type, variant, url }) => ({ type, variant, url })),
        legacyEntry: { bookId: book.id, uid: entry.uid, token: `${book.partition}:${entry.uid}` },
      });
    }
  }
  return definitions;
}

export function availableCharacterDefinitions(books: readonly WorldBook[]): CharacterDefinition[] {
  const native = readCharacterDefinitions(getContentRegistry().characters);
  const legacy = legacyCharacterDefinitions(books);
  return [
    ...native.map((d) => ({
      ...d,
      legacyEntry: legacy.find((l) => l.name === d.name)?.legacyEntry,
    })),
    ...legacy.filter((d) => !native.some((n) => n.name === d.name)),
  ];
}

export function characterAssetRows(
  definition: CharacterDefinition | undefined,
  assets: readonly AssetMetaRecord[],
): AssetMetaRecord[] {
  return (definition?.assets ?? []).flatMap((ref) => {
    const asset = assets.find(
      (a) =>
        a.type === ref.type &&
        (ref.assetId
          ? a.id === ref.assetId
          : !!ref.url && a.remote?.url === ref.url && (a.variant ?? '') === (ref.variant ?? '')),
    );
    return asset ? [asset] : [];
  });
}

export function withoutCharacterLore(
  books: readonly WorldBook[],
  definitions: readonly CharacterDefinition[],
): WorldBook[] {
  return books.map((book) => ({
    ...book,
    entries: book.entries.filter(
      (entry) =>
        !definitions.some(
          (d) => d.legacyEntry?.bookId === book.id && d.legacyEntry.uid === entry.uid,
        ),
    ),
  }));
}

export function matchCharacterDefinition(
  definitions: readonly CharacterDefinition[],
  name: string,
): CharacterDefinition | undefined {
  return definitions.find((d) => d.name === name || d.profile.aliases?.includes(name));
}

/** Author defaults fill gaps; established save state always wins. */
export function attachCharacterDefinition(
  character: CharacterState,
  definition: CharacterDefinition,
): CharacterState {
  const merged = {
    ...structuredClone(definition.profile),
    ...character,
    definition: structuredClone(definition),
  };
  for (const key of [
    'appearance',
    'background',
    'personality',
    'gender',
    'outfit',
    'goals',
  ] as const) {
    if (!merged[key] && definition.profile[key]) merged[key] = definition.profile[key];
  }
  return merged;
}
