# Audio System — Implementation Plan (lean delegation)

> Date: 2026-07-27 · Branch: `audio-system`
> Design: `docs/planning/2026-07-26-audio-system-design.md` (v1.0, post-grill)
> Method: main session architects and reviews; Opus/medium subagents implement.

---

## Architectural decisions pinned before delegation

These are settled here so no agent has to invent them, and so two agents can't invent them
differently.

**A1 — The singleton lives in the UI layer.** `audio-manager.ts` and `audio-channels.ts` export
**classes only**. A module-scope instance in the engine would construct an `AudioContext` at import
time, breaking every engine test under `environment: 'node'`. The app-global instance (design §0
#13) is created in `src/ui/lib/audio-singleton.ts`, wired with the real browser factories and
`loadBlob` → `database.getAudioBlob`.

**A2 — `types.ts` has exactly one writer.** It is the shared dependency of every later task, so it
lands alone in Wave 1. No other agent edits it; later agents are told the type names are already
final per design §2.

**A3 — Test fakes are shared.** `src/sillytavern/audio-fakes.ts` exports `FakeAudioContext`,
`FakeAudioElement`, and a fake `loadBlob`, used by both engine test files. Precedent:
`src/ui/lib/test-fixtures.ts`. Avoids two agents writing two divergent fake graphs.

**A4 — Interface placement.** `AudioContextLike` / `AudioElementLike` are declared in
`audio-channels.ts` and re-exported from `audio-manager.ts`, so the UI imports seams from one place.

**A5 — Settings keys** (design §4.1), fixed now so the store and the section agent agree:
`audioMasterVolume`, `audioMasterMuted`, `audioMusicVolume`, `audioMusicMuted`, `audioSfxVolume`,
`audioSfxMuted`, `audioRepeat`, `audioShuffle`, `audioLastPlaylistId`.

---

## Wave plan

Nine agents, all **Opus at medium reasoning effort**, none spawning subagents.

| Wave | Agent       | Deliverables                                                                                   | Parallel?      |
| ---- | ----------- | ---------------------------------------------------------------------------------------------- | -------------- |
| 0    | Scout       | Conventions map — Dexie CRUD idiom, settings-section component shape, test setup, theme tokens | —              |
| 1    | Data layer  | `types.ts` (+6 types), `database.ts` (Dexie v11, 3 tables, CRUD), DB tests                     | —              |
| 2    | Channels    | `audio-channels.ts`, `audio-fakes.ts`, `audio-channels.test.ts`                                | —              |
| 3    | Manager     | `audio-manager.ts`, `audio-manager.test.ts`                                                    | —              |
| 4    | Store       | `audio-store.ts`, `audio-singleton.ts`                                                         | —              |
| 5a   | Settings UI | `AudioSection.vue` + `SettingsPage.vue` wiring                                                 | ✅ with 5b, 5c |
| 5b   | Game UI     | `MiniPlayer.vue` + `SideToolbar.vue` + `GamePage.vue`                                          | ✅             |
| 5c   | Assets/docs | `public/audio/manifest.json` + `README.md`, `CLAUDE.md`, data dictionary chapter               | ✅             |
| 6    | Verifier    | Full suite + typecheck + diff review against acceptance criteria                               | —              |

Waves 1→4 are strictly sequential: each consumes the previous one's exports. Wave 5 fans out because
its three agents touch disjoint files and share only the store's API, which is fixed by Wave 4.

---

## Per-wave briefs

### Wave 0 — Scout

Map only, no contents. Needs to answer: the exact CRUD idiom in `database.ts` (naming, transaction
style, error handling); how `BeautifierSection.vue` is structured and mounted from
`SettingsPage.vue`; what `src/test-setup.ts` does; which `--theme-*` tokens exist in
`variables.css` for sliders/progress elements; and whether any Vue component tests exist to pattern
off. **≤30 lines, file paths and signatures only.**

### Wave 1 — Data layer

Types per design §2 verbatim; Dexie v11 per §3.1. Two hazards to call out in the brief:

- Dexie requires the **full schema restated** at each version — all v10 tables must be reproduced
  exactly, or they are dropped
- Audio tables are **deliberately absent** from `FullBackup` / `exportAllData` / `importAllData`
  (design §12). Adding them is a scope violation, not an oversight to fix

CRUD surface: `getAudioTracks`, `saveAudioTrack` (2-table transactional write, metadata + blob),
`deleteAudioTrack` (2-table, with orphan cleanup), `getAudioBlob`, `getAudioPlaylists`,
`saveAudioPlaylist`, `deleteAudioPlaylist`.
Verify: `npm run typecheck` + `npx vitest --run src/sillytavern/database.test.ts`.

### Wave 2 — Channels

`MusicChannel` (sequencer: queue/index/repeat/shuffle, single element, fade-out→swap→fade-in) and
`SfxChannel` (voice pool: cap 8 steal-oldest, 4 in-flight decodes, size guard) per design §4.2–4.4.
Hazards for the brief:

- No `new Audio()` / `new AudioContext()` anywhere — everything through injected factories (§4.6)
- `decodeAudioData` **detaches** its ArrayBuffer: fresh `blob.arrayBuffer()` per shot
- Decode is async and may resolve **out of order**; the pool must tolerate it
- Shuffle operates on a **copy**; stored playlist order is never mutated

Verify: `npx vitest --run src/sillytavern/audio-channels.test.ts` + typecheck.

### Wave 3 — Manager

Registry, master gain, unlock/`pendingTrackId`, `playByTag`, discrete-only `subscribe()`, and
`positionSec` as an on-demand getter. Hazard: **`positionSec` must never be broadcast** — putting it
in the subscribed state re-introduces the 60fps fan-out the design exists to avoid (§6.3).
Verify: `npx vitest --run src/sillytavern/audio-manager.test.ts` + typecheck.

### Wave 4 — Store + singleton

Pinia shell mirroring Manager state; loads library from Dexie; upload handler (`File` → blob record,
`kind` chosen at upload); manifest fetch (silent on failure, matching `loadBuiltInWorldBooks`);
settings persistence per A5. Plus `audio-singleton.ts` per A1, including the first-gesture
`unlock()` listener.
Verify: `npm run typecheck`.

### Wave 5a — Settings UI

Three bands per design §6.1. Brief must carry `docs/design.md`'s hard prohibitions explicitly:
no colored edge bars >1px, no `background-clip: text`, no transitions on layout properties
(progress and volume bars use `transform: scaleX()`), no hardcoded hex, no non-existent tokens,
`--paper-stack` shadows, `::after` gradient rules on section headings, italic empty states with the
`—` ornament, `prefers-reduced-motion` honored, touch targets ≥36px.
Also: add audio to the **"clear all data" confirmation text** (design §3.4) — that dialog lives in
the data section and currently doesn't mention it.

### Wave 5b — Game UI

Floating card anchored to `SideToolbar`, **not** an `AppModal` (design §6.2) — so it does not route
through `game.showModal()` and owns its own outside-click/Esc dismissal. Same design.md fence.
Toolbar icon breathes while playing; static under reduced-motion.

### Wave 5c — Assets and docs

`public/audio/manifest.json` as `[]` plus a README documenting the entry format. `CLAUDE.md`:
architecture tree gains the audio modules, settings-page section count 9→10, progress table gains a
row. Data dictionary gains an "Audio resources" chapter per template C.

### Wave 6 — Verifier

Fresh agent: run `npm test -- --run` and `npm run typecheck`; review `git diff master...audio-system`
against the acceptance criteria below. **≤10 lines.**

---

## Acceptance criteria

1. `npm test -- --run` fully green — existing 2787 tests plus ≥60 new audio cases
2. `npm run typecheck` clean
3. No `new Audio()` / `new AudioContext()` is reachable at **import time** anywhere, and no
   production code path constructs one outside `audio-singleton.ts`. `audio-manager.ts` may carry
   lazily-referenced browser-real defaults for its injection seams (design §4.6 requires the class
   to be usable standalone); the singleton always injects, so those defaults are unreachable in the
   app. An earlier draft of this criterion forbade the defaults outright, contradicting the Wave 3
   brief — this is the corrected wording.
4. `positionSec` absent from `AudioPlaybackState` and from anything `subscribe()` emits
5. Audio tables absent from `FullBackup`
6. Blob bytes never read by any library-listing query
7. No design.md prohibition violated in either new component
8. Nothing from design §12 (out of scope) implemented

---

## Report contract (in every brief, verbatim)

```
Report back in at most 15 lines:
- What you changed: file paths with one-line summaries (no code, no diffs, no file contents)
- Verification: exact command run and result (pass/fail; if fail, just the failing test names and one-line reason)
- Blockers or unrelated issues noticed: one line each
If you cannot finish, say so plainly and report what you learned so the next attempt starts warm.
```

Plus, in every brief: _"Do the work yourself with direct tool use; do not spawn subagents. Do not
refactor beyond this task; list unrelated issues in your report instead of fixing them."_

---

## Cost shape

The main session reads: one 30-line scout map, eight ≤15-line reports, one ≤10-line verdict — under
200 lines total for the whole implementation. No source file enters the main context. Wave 5's three
agents run concurrently in one message.
