import type { AssetMetaRecord, CharacterState, WorldBook } from '../types/types';
import type { CharacterDefinition, CharacterPastEntry } from '../types/types-character';
import { ASSET_TYPES } from '../types/types';
import { getContentRegistry } from '../content/content-registry-runtime';
import { extractRemoteAssetDecls } from '../assets/remote-asset-catalogue';
import { isRecord, parseCharacterProfile, parseChronicleDraft } from './character-updates';
import { extractLoreAge, parseAgeHint } from './character-age';
import { isNsfwFlagged, nsfwEnabled } from '../content/nsfw-filter';

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
    // 年龄线索写坏了只丢这一项（实例化时走兜底），不连累整份定义
    const ageHint = parseAgeHint(row);
    if (
      (row.age !== undefined && ageHint.age === undefined) ||
      (row.birthday !== undefined && !ageHint.birthday)
    )
      console.warn('[characters] 忽略无效的年龄/生日', row.id);
    definitions.push({
      id: row.id,
      name: row.name.trim(),
      profile,
      assets,
      past: past as CharacterPastEntry[],
      ...ageHint,
      ...(typeof row.lore === 'string' ? { lore: row.lore } : {}),
      ...(typeof row.loreEntry === 'string' && row.loreEntry.trim()
        ? { loreEntry: row.loreEntry.trim() }
        : {}),
      ...(row.nsfw === true ? { nsfw: true } : {}),
    });
  }
  return definitions;
}

/**
 * Read-only conversion of worldbook character entries into catalogue definitions.
 * The entry itself stays model-facing (linked via `loreEntry`); unrecognized/dynamic entries
 * are simply left as ordinary entries.
 */
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
      const age = extractLoreAge(lore);
      definitions.push({
        ...(age !== undefined ? { age } : {}),
        id: `legacy:${book.id}:${entry.uid}`,
        name,
        profile: {},
        lore,
        ...(isNsfwFlagged(entry.extra?.lore) ? { nsfw: true } : {}),
        past: [],
        assets: declarations.map(({ type, variant, url }) => ({ type, variant, url })),
        loreEntry: entry.uid,
        legacyEntry: { bookId: book.id, uid: entry.uid, token: entry.uid },
      });
    }
  }
  return definitions;
}

export function availableCharacterDefinitions(books: readonly WorldBook[]): CharacterDefinition[] {
  const all = allCharacterDefinitions(books);
  if (nsfwEnabled()) return all;
  // 露骨内容关：整条标记的角色、或链接到整条标记人设条目的角色，不进建档候选
  const nsfwEntries = new Set(
    books.flatMap((b) => b.entries.filter((e) => isNsfwFlagged(e.extra?.lore)).map((e) => e.uid)),
  );
  return all.filter((d) => !d.nsfw && !nsfwEntries.has(characterLoreEntryUid(d) ?? ''));
}

function allCharacterDefinitions(books: readonly WorldBook[]): CharacterDefinition[] {
  const native = readCharacterDefinitions(getContentRegistry().characters);
  const legacy = legacyCharacterDefinitions(books);
  const covers = (n: CharacterDefinition, l: CharacterDefinition) =>
    n.name === l.name || (!!n.loreEntry && n.loreEntry === l.legacyEntry?.uid);
  return [
    ...native.map((d) => ({
      ...d,
      legacyEntry: legacy.find((l) => covers(d, l))?.legacyEntry,
    })),
    ...legacy.filter((l) => !native.some((n) => covers(n, l))),
  ];
}

/** The worldbook entry a definition is linked to (explicit link, else the converted legacy entry). */
export function characterLoreEntryUid(definition: CharacterDefinition): string | undefined {
  return definition.loreEntry ?? definition.legacyEntry?.uid;
}

/**
 * Fill in each definition's model-facing entry link. Saves freeze definitions at creation, so
 * older frozen copies may lack `loreEntry`; they inherit it from the converted legacy entry or,
 * failing that, from the current registry definition with the same id. Pure; inputs untouched.
 */
export function linkCharacterDefinitions(
  definitions: readonly CharacterDefinition[],
  registry: readonly CharacterDefinition[] = readCharacterDefinitions(
    getContentRegistry().characters,
  ),
): CharacterDefinition[] {
  return definitions.map((definition) => {
    const uid =
      characterLoreEntryUid(definition) ?? registry.find((r) => r.id === definition.id)?.loreEntry;
    return uid && uid !== definition.loreEntry ? { ...definition, loreEntry: uid } : definition;
  });
}

/** Entry uids that selecting these definitions brings into the save's worldbook whitelist. */
export function characterLoreEntryUids(definitions: readonly CharacterDefinition[]): string[] {
  return [...new Set(definitions.flatMap((d) => characterLoreEntryUid(d) ?? []))];
}

/**
 * Keep `loreEntry` only where that entry is actually loaded; otherwise drop the link so the
 * definition's fallback `lore` is used instead of the character silently losing its profile.
 */
export function resolveCharacterLoreLinks(
  definitions: readonly CharacterDefinition[],
  books: readonly WorldBook[],
): CharacterDefinition[] {
  const loaded = new Set(books.flatMap((book) => book.entries.map((entry) => entry.uid)));
  return definitions.map((definition) => {
    if (!definition.loreEntry || loaded.has(definition.loreEntry)) return definition;
    const { loreEntry: _unloaded, ...rest } = definition;
    return rest;
  });
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
