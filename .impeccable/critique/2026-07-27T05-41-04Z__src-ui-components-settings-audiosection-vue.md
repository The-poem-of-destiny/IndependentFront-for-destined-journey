---
target: 设置页 音频分区 (AudioSection.vue)
total_score: 19
p0_count: 1
p1_count: 2
timestamp: 2026-07-27T05-41-04Z
slug: src-ui-components-settings-audiosection-vue
---
Method: dual-agent (A: a7459ef21de82580c · B: af64761147824adc1)

# Critique — 设置页 🎵 音频分区 (`src/ui/components/settings/AudioSection.vue`)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Upload, delete, and add-to-playlist produce no confirmation; duplicate add silently no-ops |
| 2 | Match System / Real World | 3 | 混音台/曲库 vocabulary is right; `sourceLabel` 「浏览器」 leaks storage-engine speak |
| 3 | User Control and Freedom | 2 | No undo on any destructive op; reorder is one-step ▲▼; scan can't be cancelled |
| 4 | Consistency and Standards | 1 | Native `window.prompt`/`confirm` ×6, emoji icons vs Font Awesome nav, bare checkbox, off-scale headings |
| 5 | Error Prevention | 1 | Delete never mentions playlist membership; `uploadFiles` has no catch — quota errors vanish |
| 6 | Recognition Rather Than Recall | 2 | Track kind encoded only as an 8px color dot; playlist rows omit the 「文件已移除」 badge |
| 7 | Flexibility and Efficiency | 1 | No drag reorder, no multi-select, no keyboard shortcuts, unfiltered add-track `<select>` |
| 8 | Aesthetic and Minimalist Design | 2 | Bands read cleanly, but the toolbar wraps 6 controls and the transport duplicates MiniPlayer |
| 9 | Error Recovery | 2 | Four well-worded folder toasts; upload/delete/audition/seek have none |
| 10 | Help and Documentation | 3 | Best dimension — quota note, folder copy, non-destructive explanations |
| **Total** | | **19/40** | **Poor — top of band; caused by workflow gaps, not broken visuals** |

## Anti-Patterns Verdict

**Does this look AI-generated? Mild-to-moderate — hand-built with real thought, undermined by three loud tells.**

**LLM assessment.** Genuine craft is present and visible: the folder strip's five permission branches each carry hand-written explanatory copy, the empty states are in the project's voice (「书页尚空，尚未建立播放列表…」/「正在翻检曲库…」), and the progress fill uses `transform: scaleX()` with a comment citing the ban it's avoiding. Someone read `docs/design.md`.

The three tells:

1. **Emoji as the icon system** — 🔇🔊⏮⏸▶⏭🔁🔀✎🗑👁🚫. The settings nav one level up uses Font Awesome. Multicolor OS-rendered emoji at inconsistent metrics inside a monochrome warm-gold dark theme is the single strongest "AI made this" signal in the file. 🚫 for "hide builtin track" is also semantically wrong — it reads as *forbidden*, not *hidden*.
2. **Six native `window.prompt`/`window.confirm` calls** in an app that ships `AppModal.vue` and a toast system. A Chrome-grey OS dialog on a `#191512` ink page is the exact moment a Linear/Raycast-fluent user stops trusting the surface.
3. **Local re-declaration of section chrome** — `h3` at 1.4rem and a local `.section-desc` duplicate `SettingsPage.vue`'s global rule, so this heading is visibly larger than every sibling section. `.band-title` at 0.95rem is likewise off the documented 0.875rem block scale.

Product-register verdict: the failure mode here is **inconsistency**, not slop. No decoration-without-purpose, no gradient theatre.

**Deterministic scan.** `detect.mjs --json` returned `[]`, exit 0 — **zero findings**, on the file and on the whole `settings` directory. Assessment B verified this is a real pass rather than a parse failure by seeding a synthetic `.vue` with `border-left:4px` / `font-family:Inter` / `transition: width`; the detector caught all three. Coverage caveat: the detector runs in regex mode and never parses the template, so a clean exit is evidence about CSS anti-patterns only.

Grep-level confirmation against `docs/design.md`'s own prohibitions — all clean:

| Check | Result |
|---|---|
| `border-left/right` > 1px | 0 |
| `background-clip: text` | 0 |
| `transition` on a layout property | 0 (all 6 animate transform/background/color/border-color) |
| Hardcoded hex in `<style>` | 0 |
| Orphan `--theme-*` tokens | 0 (22 referenced, 22 defined) |
| Icon-only controls without `aria-label` | 0 |
| `@click` on non-button elements | 0 |
| `tabindex` hacks | 0 |

Two findings the detector *couldn't* see:
- **`@media (prefers-reduced-motion)` is absent from this file.** Mitigated but not resolved: there are 0 `@keyframes` and 0 `animation:` declarations here, and the global stylesheet carries the reduce query — so what's ungated is 6 short transitions. Low severity, but the checklist item in `docs/design.md` is unmet.
- **Neither `input[type=range]` carries `aria-valuetext`.** Volume announces bare `70`; the seek bar announces raw seconds instead of mm:ss.

**Visual overlays.** Not available. A dev server was already listening on 5173, but the browser pane resolved the tab title (`命定之诗与黄昏之歌`) while reporting a **0×0 viewport** and returning `(empty page)` before and after a resize. No injection, no overlay, no screenshots. Consequence: **all contrast figures below are computed, not measured.**

## Overall Impression

This is a well-built component in the wrong room. The CSS discipline is genuinely better than the peer section it was modelled on (`BeautifierSection.vue` uses `transition: all`; this file never does), the permission-state modelling is senior-level, and the copy is careful about telling users what won't be destroyed. Then it loses 21 points on Nielsen because it's trying to be three products at once — a mixer, a playlist editor, and an asset manager — inside a preferences pane, and because the destructive paths don't say what they'll destroy.

**The single biggest opportunity:** stop treating this as one section. The mixer and the folder binding are preferences and belong here. The library and playlists are a workspace and don't.

## What's Working

1. **The five-state folder strip.** Unsupported browser / no folder / permission prompt / granted / scanning — each state names the folder, explains the cause, and offers exactly one primary action. The `prompt` state's 「浏览器每次启动后需要重新确认一次访问权限」 pre-empts the "why is it broken again" reaction that would otherwise read as a bug. This is the best thing in the file.
2. **Non-destructive-by-default, surfaced in copy.** 取消关联 explains it doesn't touch the files; the file-source delete says 「磁盘上的文件不会被删除」. Telling the user the blast radius *before* they act is rare discipline — which makes issue P0 below more frustrating, not less.
3. **Token hygiene.** Zero hex, zero phantom tokens, zero layout-property transitions, `scaleX` fills, every icon button labelled. It passes its own house rules more completely than the section it copied.

## Priority Issues

**[P0] Destructive delete hides its blast radius, and quota failure is silent.**
- **Why it matters:** `removeTrack` says 「此操作不可撤销」 but never mentions that the store prunes the track from every playlist containing it. The user loses hand-ordered curation with no undo and no warning. Separately, `await audio.uploadFiles(...)` has no `try/catch` — a `QuotaExceededError`, the single most likely production failure on the IndexedDB path, rejects into nothing. The 20MB soft-confirm has the best copy in the section, immediately followed by dead silence at the moment of actual failure.
- **Fix:** Compute membership and put it in the confirm — 「该曲目在 3 个播放列表中，删除后将一并移出」. Wrap the upload in try/catch → `ui.toast('存储空间不足…', 'error')`, and refresh `storageInfo` before deciding whether to proceed.
- **Command:** `/impeccable harden`

**[P1] Six native `window.prompt` / `window.confirm` calls break the product surface.**
- **Why it matters:** Unstyleable OS chrome inside a themed dark app; `prompt` blocks the renderer and can't be themed, translated, or keyboard-styled. It is the clearest "this is a prototype" signal a user gets.
- **Fix:** Route all six through `AppModal`, following the existing `RuleEditorModal.vue` pattern.
- **Command:** `/impeccable polish`

**[P1] The seek slider fights the user and misannounces.**
- **Why it matters:** `@input="onSeek"` seeks on every drag tick while the 4 Hz position poll rewrites `:value` underneath — the thumb fights the hand. There's no visible thumb at all, so sighted keyboard users can't see what they're moving. And the focus rule `.slider-input:focus-visible + .slider-track` **never matches**: `.slider-track` is the *preceding* sibling, so `+` cannot select it. Only the `:focus-within` fallback fires, and that also triggers on mouse-down — keyboard focus is visually indistinguishable from a click.
- **Fix:** Seek on `@change`, suppress poll writes while dragging, render a real thumb, correct the sibling selector to `:has()` or reorder the DOM, and add `aria-valuetext` ("1:23 / 4:07" for seek, percent for volume).
- **Command:** `/impeccable audit`

**[P2] The upload-kind select is camouflaged as a filter.**
- **Why it matters:** It sits in `.lib-toolbar` beside the two filter selects in identical `.mini-select` styling. Three visually identical dropdowns, one of which is an *input mode* and two of which are *view filters*. Users will set it thinking they're filtering, then upload a music file tagged as sfx.
- **Fix:** Move it out of the toolbar into an upload group — or drop it entirely and let the edit panel's existing `editKind` handle re-classification.
- **Command:** `/impeccable layout`

**[P2] No focus-visible styling, and track kind is color-only.**
- **Why it matters:** `.icon-btn`, `.chip-btn`, and `.picker-item` define `:hover` and nothing else — keyboard users navigate blind through the densest control area in the section. `.kind-dot` encodes music vs sfx purely as gold vs green, failing WCAG 1.4.1 (use of color).
- **Fix:** One shared `:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 40%, transparent) }`. Give the dot a text equivalent or a `title` + accessible name.
- **Command:** `/impeccable audit`

## Cognitive Load

**6 of 8 checklist items FAIL — high load, critical.**

| Item | Verdict |
|---|---|
| Single focus | ❌ Three unrelated jobs: live transport, list curation, asset management |
| Chunking ≤4 | ❌ `.lib-toolbar` = 6 controls; a track row = 8–10 flex children plus N tag chips |
| Visual grouping | ❌ Upload-mode select is visually identical to the two filter selects, in the same row |
| Visual hierarchy | ✅ Band titles + `::after` rules do their job |
| One thing at a time | ❌ Mixer and transport share one card |
| Minimal choices ≤4 | ❌ Transport row = 5, library toolbar = 6, mixer card = 10 interactive elements |
| Working memory | ❌ Deciding whether to delete a track requires recalling its playlist membership from a different band |
| Progressive disclosure | ✅ Inline edit panel and hidden-builtins reveal are correct |

## Emotional Journey

**Peak:** the granted folder strip — 「已收录 N 首本地曲目」 with 重新扫描 / 取消关联. A confident, complete, self-explaining state.

**Valley 1 — deleting a track that lives in playlists.** The sharpest betrayal in the section: silent loss of ordered curation, no undo, and the warning text stops one sentence short of the truth.

**Valley 2 — quota.** Excellent copy at 20MB, then nothing at all at the moment of real failure.

**Valley 3 — audition does nothing.** With `unlocked` false, ▶ plays silence and returns. The autoplay-lock hint lives two cards away in the mixer, not next to the button just pressed.

**End state: flat.** Uploading files ends with no acknowledgement whatsoever — the row simply appears.

## Persona Red Flags

**Alex (impatient power user)** — hits a wall almost immediately:
- Reordering a 30-track playlist means clicking ▲ up to 29 times. No drag, no "move to top", no shift-click range.
- No bulk delete or bulk tag. Deleting 12 uploads = 12 rows × 12 native OS confirms.
- 「加入曲目…」 is an unfiltered `<select>` over every music track — unusable past ~40 items, and it adds one at a time behind a second click.
- No keyboard shortcuts anywhere: Space doesn't play/pause, Enter doesn't save an edit, Esc doesn't cancel one, Enter in the add-track select doesn't add.
- Adding an already-present track appears to do nothing (the store returns silently). Alex will click three more times.
- Entering edit mode doesn't focus the name input — the flow is mouse-mandatory.

**Sam (accessibility-dependent)** — better than expected structurally, several hard failures in practice:
- The hand-rolled sliders keep a real `input[type=range]` with `aria-label`, so role and value announce. But `aria-valuetext` is absent (master volume reads "70"; the seek bar reads raw seconds), the focus-visible selector never matches, there is no visible thumb, and `.slider { height: 24px }` is under the ≥36px target rule.
- **No `aria-live` region anywhere.** Play↔pause, 扫描中, 正在翻检曲库, and upload completion are all unannounced. Sam presses play and learns nothing about whether it worked.
- `.src-text` puts `aria-label` + `title` on a non-interactive `<span>` — `aria-label` on a generic span isn't reliably exposed and `title` is unreachable by keyboard, so the 磁盘/内置/浏览器 distinction is effectively hidden.
- **Contrast:** `--theme-text-muted` on `--theme-card-bg` computes to roughly 5.2:1 and passes. But `.track-muted { opacity: 0.55 }` applies to the *whole row* for missing and hidden tracks, dropping the meta text and the 「文件已移除」 warning badge to roughly **2:1 — a clear 4.5:1 failure on exactly the rows that most need to be read**. Compounding: a disabled `.icon-btn` at `opacity: 0.4` nested inside lands near 0.22 effective. *(Computed, not measured — the browser pane never yielded a viewport.)*
- `aria-pressed` coverage is uneven: mute and shuffle carry it, the 3-state repeat cycle doesn't (defensible), but shuffle's static `aria-label` suppresses its visible label so the on/off meaning rides entirely on `aria-pressed`.

## Minor Observations

- Inline `style="margin-top: 16px"` etc. in four places hardcodes px where `--theme-spacing-*` exists. Matches the peer section's habit; still off-spec.
- `:key="t.id + '_' + i"` forces DOM teardown on every reorder. The store dedupes, so `t.id` alone is correct and keeps rows stable.
- Neither the playlist picker nor the library list has a `max-height` or scroll container — 60 playlists or 300 tracks render as one unbounded column.
- `storageInfo` is fetched on mount and after upload/delete, but never after a folder rescan; the quota percentage never changes color at 80% or 95%.
- `audition` discards `playSfx`'s boolean return — a failed SFX is indistinguishable from a silent file.
- `.track-row` is `flex-wrap` with variable tag chips, so duration and size columns never align across rows. A grid with fixed trailing columns would read as a table instead of a bag.
- `repeatLabel`'s `?? '列表循环'` fallback can display a mode the engine isn't actually in.
- `sourceHint` duplicates `sourceLabel`'s branch logic — one map would do.
- Band ③ stacks three headers (library head, quota note, folder strip) before the first control, so the strip reads as toolbar furniture rather than the storage-backend chooser it actually is.

## IA Judgement

**The three-band structure is wrong in two ways: band ① is in the wrong building, and band ③ is too big for this room.**

The transport is a straight duplicate of `MiniPlayer.vue`, and the tell is in the code: position polling runs *only while this section is mounted*. The progress bar exists because the panel is open, not because the user needs it here. Settings should own **configuration** — the three faders, repeat/shuffle defaults, the folder binding. Transport is **operation** and belongs to MiniPlayer, on the surface where music actually matters. Keep at most a one-line non-interactive 「正在播放：曲名」 for orientation.

Bands ② and ③ are asset management — upload, tag, filter, quota, filesystem binding, ordered curation. That's a workspace, not a preference. This is already by far the heaviest section in the settings page (1031 lines against BeautifierSection's ~560), and the strain shows in the 6-control toolbar and the 10-cell wrapping rows. Natural shape: 设置 → 音频 keeps the mixer and the folder binding; the library and playlists move to their own route alongside `/workshop`, where a two-pane layout, a real table, drag reorder, and multi-select all become affordable.

## Questions to Consider

1. If a track's bytes can vanish (`missing`) while its row, tags, and playlist slot survive — why is the missing state visible only in the library and not in the playlist that depends on it?
2. Playlists are hand-ordered lists. The engine's actual AI hook is `playByTag`. If the AI selects by **tag**, are ordered playlists the right primitive at all, or should this be a tag-curation surface with playlists as a saved query?
3. What does "playlist" even mean in a game whose music is driven by scene state? Should band ② be a 场景 → 标签 mapping (战斗/城镇/夜晚) instead of DJ-style sequencing?
4. `builtin` tracks can only be hidden, `file` tracks can only be forgotten, `blob` tracks can be deleted — three near-identical rows with three destruction semantics behind three icons. Could one 移除 action branch internally and explain itself, instead of making the user learn the taxonomy?
5. The soft limit is 20MB and the quota is shared with saves. Should the folder backend be the *recommended default* on Chromium — lead with "point at your music folder" — and relegate upload to the fallback it actually is?
