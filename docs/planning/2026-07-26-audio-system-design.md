# Audio System Design (Audio Manager) — v1.0 (post-grill)

> Date: 2026-07-26 · Status: **Design settled, awaiting go-ahead to implement**
> Scope: multi-channel audio engine / track library / playlists / user uploads / reserved AI hook
> Supersedes draft v0.1. Every open question from the draft is now closed; §13 records the rationale.

---

## 0. Decisions

| #   | Decision                                             | Consequence                                                                   |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | **Multi-channel**, not music-only                    | Music and SFX play concurrently                                               |
| 2   | **No remote/URL audio in v1**                        | `AudioSourceKind = 'blob' \| 'builtin'`; kills the CORS class of bug entirely |
| 3   | **Pure Web Audio**                                   | Follows from #2 — no CORS tainting risk left to avoid                         |
| 4   | **Two channel classes**: sequencer + voice pool      | No dead state; each class tests only what it does                             |
| 5   | SFX **infrastructure complete, no trigger wiring**   | Consumer side deferred, not the plumbing                                      |
| 6   | `kind: 'music' \| 'sfx'` on the track                | Plus a size guard behind it, because the field can be wrong                   |
| 7   | **No decode cache** — decode per play                | The one decision that is retrofittable with zero interface change             |
| 8   | **Master + per-channel volume, global**              | Audio levels are an environment property, not fiction state                   |
| 9   | **Single-element fade**, not crossfade               | Internal to MusicChannel; upgradeable later                                   |
| 10  | **Hand-roll engine and UI**                          | Desktop-only target; howler's main value is iOS quirks we don't need          |
| 11  | **Transitions broadcast, position polled on demand** | Zero cost when nothing renders a progress bar                                 |
| 12  | **No audio export/import in v1**                     | Audio tables simply absent from `FullBackup`                                  |
| 13  | **App-global singleton**                             | Playback survives navigation; title music possible                            |
| 14  | **Cap 8 voices, steal oldest**                       | Plus an in-flight decode cap of 4                                             |
| 15  | **Split tables**: metadata / blobs                   | Library listing stays cheap at any library size                               |
| 16  | **Built-in manifest ships empty**                    | Mechanism now, licensed music later, no schema change                         |
| 17  | **Mini player = floating card**                      | The one control worth touching while reading                                  |

---

## 1. Layered architecture

```
┌─ UI layer (Vue) ──────────────────────────────────────────┐
│ AudioSection.vue   Settings "🎵 Audio" — library/playlists │
│ MiniPlayer.vue     Floating card anchored to SideToolbar   │
│ audio-store.ts     Pinia thin shell — mirrors Manager state│
└──────────────────────┬────────────────────────────────────┘
                       │ public API only; never touches channels directly
┌─ Engine layer (framework-agnostic) ▼──────────────────────┐
│ audio-manager.ts   registry + master gain + unlock         │
│ audio-channels.ts  MusicChannel (sequencer)                │
│                    SfxChannel  (voice pool)                │
└──────────────────────┬────────────────────────────────────┘
                       │
┌─ Storage layer ──────▼────────────────────────────────────┐
│ database.ts  Dexie v11: audioTracks (meta) / audioBlobs    │
│              + audioPlaylists                              │
│ public/audio/manifest.json   built-in catalog (empty)      │
└───────────────────────────────────────────────────────────┘
```

The engine layer imports nothing from Vue. Under `vitest`'s `environment: 'node'` there is no
`Audio`, no `AudioContext`, and no `URL.createObjectURL` — so dependency injection at the engine
boundary is **mandatory for the suite to exist at all**, not a stylistic preference.

---

## 2. Data model (`types.ts`)

```ts
/** Where the audio bytes come from. 'url' was cut from v1 — re-adding it is purely additive. */
export type AudioSourceKind = 'blob' | 'builtin';

/** What the track is for. Drives decode policy; the size guard (§4.4) is the rail when it's wrong. */
export type AudioTrackKind = 'music' | 'sfx';

/** Track metadata — cheap to list, holds no audio bytes (§3.2) */
export interface AudioTrack {
  id: string;
  name: string;
  kind: AudioTrackKind;
  source: AudioSourceKind;
  url?: string; // source='builtin': the manifest path
  mimeType?: string;
  size?: number; // compressed bytes
  duration?: number; // seconds, backfilled after first load
  tags: string[]; // scene tags — the AI hook's only addressing scheme (§8)
  builtin?: boolean; // cannot be deleted, only hidden
  createdAt: number;
  updatedAt: number;
}

/** Audio bytes, stored apart from metadata and read only at play time */
export interface AudioBlobRecord {
  id: string; // === AudioTrack.id
  blob: Blob;
}

/** Playlists are a sequencer concept — music tracks only (§4.3) */
export interface AudioPlaylist {
  id: string;
  name: string;
  trackIds: string[]; // ordered; dangling ids pruned on track delete
  createdAt: number;
  updatedAt: number;
}

export type AudioRepeatMode = 'off' | 'all' | 'one';

/**
 * Discrete playback state. Deliberately excludes position — that is a getter
 * sampled on demand, never broadcast (§6.3).
 */
export interface AudioPlaybackState {
  music: {
    status: 'idle' | 'playing' | 'paused';
    trackId: string | null;
    playlistId: string | null;
    index: number;
    durationSec: number;
    volume: number; // 0..1, channel gain
    muted: boolean;
    repeat: AudioRepeatMode;
    shuffle: boolean;
  };
  sfx: {
    volume: number;
    muted: boolean;
    liveVoices: number;
  };
  masterVolume: number;
  masterMuted: boolean;
  /** AudioContext resumed by a user gesture yet (§7) */
  unlocked: boolean;
}
```

`AudioTrack` never enters a StatePatch and is not save state, so it sits outside the "AI never
produces ids" rule — and consistent with it, since the AI addresses tracks only by **tag** (§8).
On approval, add an "Audio resources" chapter per template C in
`docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`.

---

## 3. Storage layer

### 3.1 Dexie v11

```ts
this.version(11).stores({
  ...(all v10 tables unchanged),
  audioTracks:    'id, name, kind, *tags, updatedAt',
  audioBlobs:     'id',
  audioPlaylists: 'id, name, updatedAt',
});
```

Purely additive; no upgrade callback.

### 3.2 Why blobs live in their own table

IndexedDB has **no column projection**. If bytes lived on the `audioTracks` row, then
`audioTracks.toArray()` — the query that draws the library list — would materialize every byte of
audio in the store, on every settings-page open. Fine at 5 tracks, ruinous at 50, and it degrades
silently as the library grows.

So: `audioTracks` is metadata only and stays kilobyte-scale at any size; `audioBlobs` is a bare
`id → blob` store read **only** at play time. Upload and delete are two-table writes inside one
transaction, with orphan cleanup on delete.

### 3.3 The library is global, not per-save

One library reused across saves; duplicating blobs per save would burn the quota for nothing.

### 3.4 Backup and teardown

Audio tables are **absent from `FullBackup`** entirely — no export, no import, in v1. Two
consequences worth stating in the UI:

- Importing a save backup **leaves the audio library untouched** rather than wiping it
- `clearAllData()` calls `db.delete()` on the whole database, so **"clear all data" does destroy
  the audio library** — this must be named in that confirmation dialog

### 3.5 Quota

The section header reuses `settingsStore.getStorageUsage()` to show audio usage against the browser
quota. Uploads over 20 MB get a soft confirm. No automatic cleanup — never delete the user's data
unprompted.

---

## 4. Engine

### 4.1 Graph

```
                    ┌──────────────┐
  MusicChannel ────►│ music gain   │──┐
  (MediaElementSource)             │  │   ┌─────────────┐
                    └──────────────┘  ├──►│ master gain │──► destination
                    ┌──────────────┐  │   └─────────────┘
  SfxChannel   ────►│ sfx gain     │──┘
  (AudioBufferSourceNode ×N)       │
                    └──────────────┘
```

Master and channel gains are independent and separately mutable, all persisted globally via
`settings-store` (`audioMasterVolume`, `audioMasterMuted`, `audioMusicVolume`, `audioMusicMuted`,
`audioSfxVolume`, `audioSfxMuted`, `audioRepeat`, `audioShuffle`, `audioLastPlaylistId`).

### 4.2 Two channel classes

They share only a narrow interface — `gain`, `muted`, `stop()`, `dispose()` — because they have
almost nothing else in common.

**`MusicChannel` — a sequencer**

- One `HTMLAudioElement` through a `MediaElementSource`. Music **streams**; it is never decoded to
  a buffer (5 min of stereo float32 ≈ 105 MB).
- Owns `queue: string[]`, `index`, `repeat`, `shuffle`.
- `playTrack` → queue of one, `playlistId = null`. `playPlaylist` → the playlist's ids, shuffled on
  a **copy** so stored order is never mutated.
- `ended` drives advancement:

  | repeat | shuffle | Behavior                    |
  | ------ | ------- | --------------------------- |
  | `one`  | —       | replay current              |
  | `all`  | off     | wrap to index 0             |
  | `all`  | on      | reshuffle, restart from top |
  | `off`  | —       | end of queue → `idle`       |

- Track change: ramp gain to 0 (~300 ms), swap `src`, ramp back. A beat of silence at the seam
  reads as a scene transition. Upgrading to true two-element crossfade later is internal to this
  class — no interface change.

**`SfxChannel` — a voice pool**

- No queue, no index, no repeat. Each shot: `blob.arrayBuffer()` → `decodeAudioData` →
  `AudioBufferSourceNode` → `start()`. Nodes are one-shot and GC'd after `ended`; nothing to pool.
- **Cap 8 live voices**; past the cap, stop the longest-running voice to free a slot — the newest
  sound is the most relevant to what just happened.
- **Cap 4 in-flight decodes** so a burst cannot pile up decode work faster than it drains.

### 4.3 Playlists are music-only

A playlist is a sequencer concept; the voice pool has no queue to feed. The playlist editor filters
the library to `kind === 'music'`.

### 4.4 Decode policy and its two consequences

No cache: every shot decodes fresh. This is the only decision in the design that is retrofittable
with **zero interface change** — an LRU cache is a pure internal optimization behind `playSfx()`.

Two things it forces, which the implementation must handle explicitly:

- `decodeAudioData` **detaches** the ArrayBuffer it consumes, so each play needs its own
  `blob.arrayBuffer()` read; a shared buffer cannot be reused
- decode is async, so two rapid calls can resolve **out of order** — the pool must tolerate that
  rather than assume start order matches call order

Guard: `SfxChannel` refuses to decode anything past a threshold (~30 s or ~5 MB) and rejects with a
clear error rather than eating memory. This rail exists independently of `kind`, because `kind` can
be wrong.

### 4.5 Public API

```ts
export class AudioManager {
  constructor(opts?: AudioManagerOptions);

  // Library — fed from the DB by the store; the Manager never touches Dexie
  setTracks(tracks: AudioTrack[]): void;
  setPlaylists(lists: AudioPlaylist[]): void;
  getTrack(id: string): AudioTrack | undefined;

  // Music (delegates to MusicChannel)
  playTrack(trackId: string): Promise<void>;
  playPlaylist(playlistId: string, startIndex?: number): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  toggle(): Promise<void>;
  stop(): void;
  next(): Promise<void>;
  prev(): Promise<void>;
  seek(sec: number): void;
  setRepeat(mode: AudioRepeatMode): void;
  setShuffle(on: boolean): void;

  // SFX (delegates to SfxChannel)
  playSfx(trackId: string): Promise<boolean>; // false if capped or guard-rejected
  stopAllSfx(): void;

  // Mixing
  setMasterVolume(v: number): void;
  setMasterMuted(m: boolean): void;
  setChannelVolume(ch: 'music' | 'sfx', v: number): void;
  setChannelMuted(ch: 'music' | 'sfx', m: boolean): void;

  // Unlock (§7)
  unlock(): Promise<void>;

  // 🔮 AI hook — implemented and tested, nothing calls it (§8)
  playByTag(tag: string, opts?: { fallback?: 'keep' | 'stop' }): Promise<boolean>;

  // Observation
  get state(): Readonly<AudioPlaybackState>; // discrete only
  get positionSec(): number; // sampled on demand, never broadcast
  subscribe(fn: (s: AudioPlaybackState) => void): () => void;
  dispose(): void;
}
```

The Manager **never touches the database**: CRUD belongs to `database.ts`, the Manager consumes
in-memory arrays and is handed blobs to play. Tests need no `fake-indexeddb`, and swapping storage
would not touch playback logic.

### 4.6 Injection seams

```ts
interface AudioManagerOptions {
  createContext?: () => AudioContextLike; // no AudioContext under environment:'node'
  createElement?: () => AudioElementLike; // no Audio either
  createObjectURL?: (b: Blob) => string;
  revokeObjectURL?: (u: string) => void;
  random?: () => number; // shuffle determinism
  fadeMs?: number; // 0 in tests, 300 in the UI
  loadBlob?: (trackId: string) => Promise<Blob | undefined>; // storage seam
}
```

---

## 5. Built-in library `public/audio/`

```
public/audio/
├── manifest.json    # [] in v1
└── README.md        # entry format: { id, name, kind, file, tags, credit, license }
```

Fetched at startup, silent on failure (matching `loadBuiltInWorldBooks`). Ships **empty**: the repo
is bound by the 《命定之诗》derivative-content license, so bundled audio needs its own clearance
(CC0, or CC-BY with attribution). Keeping the mechanism means dropping in cleared music later is a
data change, not a code change.

---

## 6. UI

### 6.1 Settings section "🎵 Audio" (`AudioSection.vue`)

Inserted between `beautifier` and `data`, icon `fa-solid fa-music`. Three bands, mirroring
`BeautifierSection`:

```
① Mixer         master volume/mute · music volume/mute · sfx volume/mute
                transport: title / progress / ⏮ ⏯ ⏭ / repeat / shuffle
② Playlists     left: picker (new/rename/delete)   right: tracks (reorder/remove)
③ Library       Upload (multi-select, pick kind) · search · filter by kind and tag
                row: kind dot · name · tag chips · duration · size · audition ▶ · ✎ · 🗑
                header: audio usage vs quota
```

Per `docs/design.md`: `--paper-stack` shadows, `::after` gradient rules on section headings, italic
empty states with the `—` ornament, no colored edge bars, spacing via `--theme-spacing-*`,
`prefers-reduced-motion` honored. Progress and volume bars animate with `transform: scaleX()`,
never `width` (spec prohibition §1).

### 6.2 Mini player (`MiniPlayer.vue`)

`SideToolbar` gains `{ id: 'audio', label: '音乐', icon: 'fa-solid fa-music' }`. It does **not**
route through `game.showModal()` — it opens a floating card anchored beside the toolbar, dismissed
on outside click or Esc:

```
♪ Track title (serif, marquee on overflow)
⏮  ⏯  ⏭        🔁 🔀
━━━━━━━●━━━━━  volume
[Playlist ▾]
```

This deliberately breaks the page's Modal pattern for one control, because adjusting volume or
skipping a track is the one interaction you'd want _while reading_ — a Modal would blank the
narrative every time. Cost: it owns its own dismissal and focus handling rather than inheriting
`AppModal`'s. While playing, the toolbar icon breathes at low amplitude; static under
reduced-motion.

### 6.3 Observation

`subscribe()` fires only on discrete changes — play, pause, track change, volume, mute. Position is
sampled from `manager.positionSec` at ~4 Hz by an interval that starts on mount of a **visible**
progress bar and stops on unmount (faster while a seek is being dragged). A collapsed mini player
and a closed settings page cost exactly zero. The alternative — pushing position into reactive state
at rAF rate — would fan 60 invalidations per second out to every subscriber for the whole duration
of playback, competing with AI text streaming into `ChatFlow` for frame budget.

---

## 7. Autoplay unlock

Target is desktop, so none of the iOS silent-buffer trickery is needed — but **Chrome desktop still
blocks autoplay without a user gesture**. The `AudioContext` is created suspended at module load;
the first user gesture anywhere in the app calls `resume()`.

A play request while `unlocked === false` does not throw: it is recorded as `pendingTrackId`, the UI
shows "click anywhere to start the music", and the next gesture redeems it.

---

## 8. 🔮 Reserved for AI-driven playback

Reserved surface is exactly two things: `AudioTrack.tags` and `playByTag(tag)`. Both are implemented
and unit-tested in v1; nothing calls them. The wiring path, out of scope now:

```
story Agent emits <bgm scene="combat"/>
  → marker-protocol.ts gains scanBgmMarkers()
  → GamePipeline callback onBgmRequest → audioStore.playByTag('combat')
  → no match → fallback:'keep' holds the current track (never cut to silence mid-scene)
```

No schema change will be needed — only marker parsing and a systemPrompt section.

**SFX triggers are the same story**: `playSfx()` is complete, but nothing fires it. When the
consumer side is built, the bridge subscribes to the per-save `EventBus` (11 event types today) with
subscribe-on-load / unsubscribe-on-unload discipline — the zombie-subscription trap that
`subscription-manager.ts` already solves for scripts. The 8-voice cap and decode limit exist
precisely so that a combat round's burst of events cannot machine-gun once that bridge lands.

---

## 9. Test plan

`audio-manager.test.ts` + `audio-channels.test.ts`, all seams injected.

| Group           | Cases                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------- |
| Sequencer queue | playTrack single-track queue / playPlaylist order / startIndex / empty playlist doesn't throw |
| Advance         | ended × repeat(off/all/one) × shuffle / next at end / prev at start / reshuffle on wrap       |
| Fade            | gain ramps to 0 before src swap, back after / fadeMs=0 is synchronous                         |
| Voice pool      | 8 concurrent OK / 9th steals oldest / decode cap queues / out-of-order decode resolution      |
| Guard           | oversize track rejected with reason, nothing decoded / wrong `kind` still caught by size      |
| Mixing          | master × channel composition / mute leaves volume value intact / clamp (<0, >1)               |
| Sources         | blob objectURL created and revoked on track change / builtin path used directly               |
| Library sync    | setTracks deleting current track → stop / deleting a queued track → queue shrinks             |
| AI hook         | playByTag hit / multi-hit uses injected random / miss with fallback keep vs stop              |
| Unlock          | play while locked stores pending; unlock() redeems it / no throw while locked                 |
| Observation     | subscribe fires on discrete changes only / never on position / unsubscribe / dispose          |

Target ≥ 60 cases. `npm test` fully green before delivery (project rule: every module ships tests).

---

## 10. Deliverables

| #   | File                                          | Action                                                           |
| --- | --------------------------------------------- | ---------------------------------------------------------------- |
| 1   | `src/sillytavern/types.ts`                    | +6 types (§2)                                                    |
| 2   | `src/sillytavern/database.ts`                 | Dexie v11, 3 tables + CRUD (2-table transactional upload/delete) |
| 3   | `src/sillytavern/audio-channels.ts`           | 🆕 MusicChannel + SfxChannel                                     |
| 4   | `src/sillytavern/audio-manager.ts`            | 🆕 registry, master gain, unlock, AI hook                        |
| 5   | `src/sillytavern/audio-channels.test.ts`      | 🆕                                                               |
| 6   | `src/sillytavern/audio-manager.test.ts`       | 🆕                                                               |
| 7   | `src/ui/stores/audio-store.ts`                | 🆕 Pinia shell over the module-level singleton                   |
| 8   | `src/ui/components/settings/AudioSection.vue` | 🆕                                                               |
| 9   | `src/ui/components/settings/SettingsPage.vue` | +nav entry + mount                                               |
| 10  | `src/ui/components/game/MiniPlayer.vue`       | 🆕 floating card                                                 |
| 11  | `src/ui/components/game/SideToolbar.vue`      | +music button                                                    |
| 12  | `src/ui/components/game/GamePage.vue`         | mount the overlay                                                |
| 13  | `public/audio/manifest.json` + `README.md`    | 🆕 empty skeleton                                                |
| 14  | `CLAUDE.md` / data dictionary                 | architecture table, settings sections 9→10, audio entity chapter |

Order: **1-6 (engine green) → 7-9 (settings usable) → 10-12 (game page) → 13-14 (docs)**.

---

## 11. Risks

| Risk                                                  | Handling                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| Audio fills the IndexedDB quota, taking saves with it | Soft prompt on upload + always-visible usage; no auto-cleanup                   |
| "Clear all data" silently destroys the library        | Name audio explicitly in the confirmation dialog (§3.4)                         |
| Decode-per-play latency once SFX are wired            | Accepted; LRU cache is a zero-interface-change retrofit (§4.4)                  |
| Oversize file sent to the SFX channel                 | Size guard rejects before decode, independent of `kind` (§4.4)                  |
| Autoplay blocked                                      | Gesture unlock + pending redemption (§7)                                        |
| Two browser tabs = doubled playback                   | Ignored for a desktop single-window target; `BroadcastChannel` if it ever bites |
| Built-in library licensing                            | Ships empty; mechanism only (§5)                                                |
| Mini player stealing attention                        | Floating card, low-amplitude animation, reduced-motion aware (§6.2)             |

---

## 12. Explicitly out of scope for v1

Named so they don't get quietly re-litigated during implementation:

- Remote/URL audio sources
- Any SFX **trigger** — event bindings, UI chrome sounds, combat hooks
- AI-driven track selection (the hook exists; no caller)
- Audio export/import in save backups
- Decoded-buffer caching
- True crossfade between tracks
- Ducking music under SFX
- Waveform visualization
- Multi-tab playback coordination
- iOS/mobile audio support

---

## 13. Rationale for the sharper reversals

Kept because these are the decisions most likely to look arbitrary in six months.

**Remote URLs cut (#2).** Routing a cross-origin stream through `MediaElementSource` yields
_silence_, not an error, unless the server sends permissive CORS headers — and it would never
reproduce in dev, where everything is same-origin localhost. Cutting the feature removed an entire
class of silent, environment-dependent failure and made pure Web Audio unambiguously correct.

**Blobs split into their own table (#15).** IndexedDB has no projection, so metadata and bytes in
one row means the library list pulls the whole library into memory. The failure curve is the bad
kind: invisible at 5 tracks, ruinous at 50, degrading silently as the user's library grows.

**Two channel classes rather than one (#4).** A sequencer and a voice pool share a gain node and
nothing else. Modeling them uniformly leaves `queue`/`index`/`repeat` permanently dead on the SFX
side — and every test then has to assert the dead paths stay dead, which is the kind of assertion
that quietly rots.

**SFX infrastructure without triggers (#5).** Deferring a consumer is not the same as deferring the
plumbing. The channel, guard, cap, and API are built and tested now so that wiring events later is
an addition, not a rewrite of the core.

**Hand-rolled over howler.js (#10).** howler is ~2500 lines solving cross-browser problems, of which
a desktop-only target needs approximately one (unlock). Its global-singleton shape also fights the
injectable seams the project's `environment: 'node'` test setup requires. Ready-made Vue player
components were rejected on a different ground: each owns its own playback engine and scopes its own
CSS, so it could neither participate in the channel design nor inherit the `--theme-*` tokens that
keep the other settings sections coherent.
