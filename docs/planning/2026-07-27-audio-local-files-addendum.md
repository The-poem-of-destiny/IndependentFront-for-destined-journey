# Audio System — Addendum: local file storage (File System Access)

> Date: 2026-07-27 · Branch: `audio-system`
> Amends `docs/planning/2026-07-26-audio-system-design.md` (v1.0) and the shipped implementation
> in commit `ea0c792`. Everything not restated here is unchanged.

---

## Why this amendment

v1 stored uploaded audio as Blobs in IndexedDB. That works, but it copies the user's music into the
browser's quota — quota shared with saves — and the files stop being files the user can manage.

This amendment adds a **library folder**: the user points the app at a directory once, the files stay
where they are, and the database stores only the catalogue.

**The engine does not change.** `AudioManager` already takes a `loadBlob(trackId) => Promise<Blob |
undefined>` seam, so the byte source is entirely a store-layer concern. `audio-channels.ts`,
`audio-manager.ts`, and all 112 engine tests are untouched. This is the seam paying for itself.

---

## Model: one library folder, not per-file handles

The user picks **one directory** via `showDirectoryPicker()`. Tracks inside it are discovered by
scanning. Adding music means dropping a file in that folder and rescanning — not re-entering the app's
upload flow.

Rejected alternative: per-file handles via `showOpenFilePicker`. It allows scattered files but costs a
permission grant per file and a handle row per track, for a case the folder model already covers.

**Two storage backends coexist behind one seam:**

| `source`    | Bytes live in             | When used                                                       |
| ----------- | ------------------------- | --------------------------------------------------------------- |
| `'file'`    | The user's folder on disk | File System Access available (Chromium)                         |
| `'blob'`    | IndexedDB `audioBlobs`    | Fallback for browsers without FSA; existing tracks keep working |
| `'builtin'` | `public/audio/`           | Shipped manifest entries (unchanged)                            |

Existing `'blob'` tracks are never migrated or deleted. Both paths remain live indefinitely.

---

## Data model changes (`types.ts`)

```ts
export type AudioSourceKind = 'blob' | 'builtin' | 'file';

export interface AudioTrack {
  // ...existing fields unchanged...
  /** source='file': filename within the library folder. The folder handle is stored separately. */
  relativePath?: string;
  /** source='file': the file was gone at last scan. Row is kept so tags/playlist slots survive. */
  missing?: boolean;
}
```

New record for the persisted handle — handles are structured-cloneable, so IndexedDB stores them
directly. They cannot go in `localStorage`; they are not JSON.

```ts
export interface AudioHandleRecord {
  id: string; // 'library-root' — one row today
  handle: FileSystemDirectoryHandle;
  addedAt: number;
}
```

---

## Storage (`database.ts`) — Dexie v12

```ts
this.version(12).stores({
  ...(all v11 tables restated verbatim),
  audioHandles: 'id',
});
```

Purely additive, no upgrade callback. Same rule as v11: **every prior table must be restated** or it
is dropped.

CRUD: `getAudioHandle(id)`, `saveAudioHandle(record)`, `deleteAudioHandle(id)`.

---

## `src/ui/lib/audio-folder.ts` (new)

All File System Access contact is isolated here so the store never touches the API directly and can
be tested without it.

```ts
isFolderSupported(): boolean                    // 'showDirectoryPicker' in globalThis
pickLibraryFolder(): Promise<FileSystemDirectoryHandle | null>   // needs user gesture
getStoredFolder(): Promise<FileSystemDirectoryHandle | null>
checkPermission(handle): Promise<'granted' | 'prompt' | 'denied'>
requestPermission(handle): Promise<boolean>     // needs user gesture
scanFolder(handle): Promise<ScannedFile[]>      // { name, size, mimeType }, audio extensions only
resolveFile(handle, relativePath): Promise<File | null>   // null if gone
```

### Permission lifecycle — the part that will surprise users

Permission **does not survive a browser restart**. On startup `queryPermission()` typically returns
`'prompt'`, and `requestPermission()` requires user activation — so it cannot be called from
`onMounted`.

Therefore the store exposes `folderPermission: 'unsupported' | 'none' | 'prompt' | 'granted' |
'denied'`, and the UI shows an explicit **"授权访问音乐文件夹"** button when the state is `'prompt'`.
One click per session, covering the whole folder. Do not attempt a silent re-grant; it will fail
without activation and look like a bug.

### Scan reconciliation

`rescanFolder()` diffs the folder against catalogued `'file'` tracks:

- **New filename** → new `AudioTrack` (`source:'file'`, `kind` defaulting to `'music'`, name = filename
  minus extension, empty tags)
- **Catalogued file still present** → clear `missing`
- **Catalogued file gone** → set `missing: true`. **Never delete the row** — tags, `kind`, and playlist
  membership are the user's curation work and must survive a file being temporarily moved or a drive
  being unplugged.

---

## Store changes (`audio-store.ts`)

`loadBlob(trackId)` dispatches on `source`:

- `'file'` → `resolveFile(folderHandle, relativePath)`; on `null`, mark `missing` and return undefined
- `'blob'` → `getAudioBlob(id)` (unchanged)
- `'builtin'` → unchanged; the music channel uses `track.url` directly

New actions: `pickFolder`, `grantFolderPermission`, `rescanFolder`, `forgetFolder`.
New refs: `folderPermission`, `folderName`, `scanning`.

`uploadFiles()` stays exactly as-is — it is the fallback path and the only path on non-Chromium
browsers.

---

## UI changes (`AudioSection.vue`)

Band ③ 曲库 gains a folder strip above the track list:

- **Unsupported browser** → the strip explains that the browser lacks File System Access and that
  uploads go to browser storage instead. Upload flow unchanged and fully functional.
- **No folder chosen** → 「选择音乐文件夹」 button.
- **Permission `'prompt'`** → 「授权访问音乐文件夹」 button, with a one-line note that browsers require
  this once per session.
- **`'granted'`** → folder name, track count, 「重新扫描」 and 「取消关联」 buttons.

`missing` tracks render greyed with a 「文件已移除」 badge and are unplayable but still editable and
still hold their playlist slots.

---

## Out of scope for this amendment

- Migrating existing `'blob'` tracks into the folder (or vice versa)
- Per-file handles / multiple library folders
- Recursive subdirectory scanning — top level only
- Watching the folder for external changes (rescan is manual)
- OPFS
