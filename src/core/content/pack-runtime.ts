import type { ContentPack } from '../types/types-content';
import type { ChatPreset, WorldBook } from '../types/types';

let payload: ContentPack | undefined;
let protectedInstalled = false;
let worldBooks: WorldBook[] = [];
let presets: ChatPreset[] = [];
let revision = 0;
const listeners = new Set<() => void>();
let ownedBookIds = new Set<string>();
let ownedPresetIds = new Set<string>();
export function isProtectedPackBookId(id: string): boolean {
  return protectedInstalled && ownedBookIds.has(id);
}
export function isProtectedPackPresetId(id: string): boolean {
  return protectedInstalled && ownedPresetIds.has(id);
}

/** No persistence here: the only decrypted content source, shared by UI and engine readers. */
export function getActivePackPayload(packId?: string): ContentPack | undefined {
  return !packId || payload?.packId === packId ? payload : undefined;
}

export function isProtectedContentInstalled(): boolean {
  return protectedInstalled;
}
export function getPackRuntimeRevision(): number {
  return revision;
}
export function getRuntimePackBooks(): WorldBook[] {
  return worldBooks;
}
export function getRuntimePackPresets(): ChatPreset[] {
  return presets;
}

function notify(): void {
  revision++;
  for (const listener of listeners) listener();
}

export function subscribePackRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function installRuntimePack(
  pack: ContentPack | undefined,
  protectedPack: boolean,
  ownership?: { bookIds?: string[]; presetIds?: string[] },
): void {
  payload = pack;
  protectedInstalled = protectedPack;
  worldBooks = protectedPack
    ? (pack?.worldBooks ?? []).map((book) => ({ ...book, builtIn: true }))
    : [];
  const embedded = Object.values(pack?.agentDefaults?.agents ?? {})
    .map((entry) => entry.preset)
    .filter((preset): preset is ChatPreset => !!preset);
  const byId = new Map(embedded.map((preset) => [preset.id, preset]));
  for (const preset of pack?.presets ?? []) byId.set(preset.id, preset);
  presets = protectedPack ? [...byId.values()] : [];
  ownedBookIds = protectedPack
    ? new Set([
        ...(ownership?.bookIds ?? (pack ? [] : ownedBookIds)),
        ...(pack?.worldBooks ?? []).map((book) => book.id),
      ])
    : new Set();
  ownedPresetIds = protectedPack
    ? new Set([...(ownership?.presetIds ?? (pack ? [] : ownedPresetIds)), ...byId.keys()])
    : new Set();
  notify();
}

export function setRuntimePackBooks(books: WorldBook[]): void {
  if (protectedInstalled && !payload) throw new Error('内容包已锁定，无法编辑世界书');
  worldBooks = books;
  notify();
}
export function setRuntimePackPresets(rows: ChatPreset[]): void {
  if (protectedInstalled && !payload) throw new Error('内容包已锁定，无法编辑预设');
  presets = rows;
  notify();
}

export function overlayRows<T extends { id: string }>(
  disk: readonly T[],
  overlay: readonly T[],
): T[] {
  const rows = new Map(disk.map((row) => [row.id, row]));
  for (const row of overlay) rows.set(row.id, row);
  return [...rows.values()];
}
