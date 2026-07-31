# Asset Management System — Design v1.0 (post-grill)

**Date:** 2026-07-29
**Status:** Design, pre-implementation. Point-in-time; supersede with a new dated file rather than silently rewriting.
**Scope:** Image/video asset library (avatars + portrait types) and one-click zip import covering both assets and audio.

**Source material:**

- `E:/Projects/RP Terminal/docs/asset-system-report-and-port-eval-2026-07-28{,.zh}.md` — RPT's asset system + port evaluation
- `E:/Projects/RP Terminal/docs/asset-storage-simulation-2026-07-28.zh.md` — storage strategy simulation (S1/S2/S2b/S3)

**Relationship to the source material:** this is **not** a port. The port evaluation assumed a broad multi-category
system (character/location/cg/misc, 8 types, 5000 assets) and recommended storage strategy **S3** (folder-link +
IndexedDB catalogue). Neither premise survives our scope. What we take from RPT is **behaviour and hard-won design
decisions** — the filename convention, right-to-left type anchoring, the fallback chain, fail-closed matching, the
alpha/mp4 rule — not its code, its layering, or its storage model. Every deviation below is deliberate and its
reason is recorded.

---

## 0. Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                  | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Keep RPT's `<name>_<type>[_<variant>].<ext>` convention; **type token optional, defaults to `头像`**                                                                                                                                                                                                      | The filename _is_ the zip format. A convention-less v1 makes every art pack ambiguous the moment 立绘 lands. Optional type keeps the common case zero-ceremony.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D2  | **Strict `===` name matching. No normalization.** Unmatched reported passively, never as a toast                                                                                                                                                                                                          | Names originate in a controlled pipeline; a mismatch is a prompt/lorebook defect, not something the asset layer should paper over.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D3  | Asset library is **fully decoupled** from saves and the `characters` table                                                                                                                                                                                                                                | No global character registry → no cross-save interference by construction. The library is a standalone global subsystem, exactly like audio.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D4  | Types in v1: **`头像`, `立绘`, `立绘bg`**. All three importable; ~~none rendered~~ — **the no-render half was reversed on 2026-07-29 (§15.9)**; five render sites are now wired                                                                                                                           | v1 delivered the _management system only_, so that types would exist and packs authored then would survive to v2. The type set is unchanged; only the "nothing renders" clause fell. Recorded rather than rewritten because two defects (§15.9) were structurally invisible _because of_ this clause.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D5  | **One storage tier: IndexedDB `Blob` rows.** No folder tier, no built-in `public/assets/` tier                                                                                                                                                                                                            | ~40–100 assets ≈ 3.6–50 MB. S3's entire case is a cold-start cost that does not exist at this scale. Built-in art is a licensing liability.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D6  | Blob resolution behind an **injected resolver seam**                                                                                                                                                                                                                                                      | The audio folder backend landed later with _engine zero changes_ via exactly this seam. Keeps S3 a cheap v2 migration rather than a rewrite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D7  | **mp4 allowed where alpha is not needed:** `头像`, `立绘bg`. **Never on `立绘`**                                                                                                                                                                                                                          | RPT's rule was right; its formulation was type-specific. A cut-out standee composites and needs alpha; a circle-clipped avatar does not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D8  | **`.webm` stays audio.** Animated alpha uses **animated WebP**                                                                                                                                                                                                                                            | `webm: 'audio/webm'` is already claimed in shipped code. Disambiguation buys compression for a type that does not render in v1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D9  | **One zip importer, routing by extension.** Surfaced in both 素材 and 音频 sections                                                                                                                                                                                                                       | Subsumes "one zip with both" and "separate packs" readings. One implementation, two entry points matching user intent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D10 | **Optional `manifest.json`** in the zip; may only _add_ metadata (`tags`, `credit`, `license`, and `framing` per D21), never rename or re-type                                                                                                                                                            | Filenames cannot carry attribution. Retrofitting credit onto a shipped library is materially harder than designing it in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D11 | **Never overwrite.** Collisions auto-number **into the variant slot**                                                                                                                                                                                                                                     | Appending to the name orphans the asset from its character under D2; the variant slot is precisely the "another one of these" slot the convention already has.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D12 | **Hash on import; skip byte-identical duplicates.** Assets scoped to `(name, type)`; audio scoped to normalized name                                                                                                                                                                                      | Global-by-hash would refuse the same placeholder image for the 2nd..Nth character. Audio must be covered too or re-importing an export clones every track (§5.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D13 | Assets excluded from `FullBackup`; **both omissions stated in 存档数据**                                                                                                                                                                                                                                  | `FullBackup` is JSON — blobs would force base64, which the simulation shows is strictly dominated. The zip export _is_ the migration path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D14 | **Full rename of `name` and `type` permitted** (deviates from RPT's variant-only lock)                                                                                                                                                                                                                    | RPT could lock them because its coverage meter surfaced errors instantly. With no verification loop (D3+D4), the escape hatch is worth more than the guard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D15 | **Plan/execute split:** pure `asset-import-plan.ts` + dumb store executor                                                                                                                                                                                                                                 | Puts routing, numbering, dedupe, and media rules under unit test as plain data, with no IndexedDB and no fflate in the loop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D16 | **Naming invariant: no segment of `name` or `variant` may equal a type token.** Enforced at import _and_ rename                                                                                                                                                                                           | Without it, `format()` → `parse()` is not bijective and the mandatory round-trip test (§5.4) is unsatisfiable. See §2.5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D17 | **Export carries only `source: 'blob'` audio.** `builtin` and `file` tracks excluded                                                                                                                                                                                                                      | Exporting the 57 built-in tracks (`license: PLACEHOLDER-PENDING-REVIEW`) into a shareable pack is exactly the redistribution mistake §4.2 avoids. `file` bytes aren't ours and may be unauthorized or `missing`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D18 | **Hashing happens in the UI layer, before planning.** Entries reach the planner pre-hashed                                                                                                                                                                                                                | `crypto.subtle.digest` is async; the planner is pure and synchronous. The seam has to be explicit or the signature lies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D19 | **A name must survive a round-trip through a zip entry name.** No `/`, no `\`, no leading `.` — rejected at the rename gate. Whitespace **is** allowed and must not be trimmed                                                                                                                            | Post-merge review (§15.6). A separator becomes a _path_ in the zip and flattens on re-import; a leading dot becomes a dotfile and is skipped as noise. Neither can round-trip, and both broke the D11 "never two bases" invariant through the allocator. Whitespace is representable, so trimming it would be the export side quietly enforcing a normalization D2 rejects.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D20 | **Two type-fallback chains, picked by slot _shape_.** `ASSET_TYPE_FALLBACK_CHAIN` (`立绘 → 立绘bg → 头像`) for standee-shaped slots, and still the default; `ASSET_TYPE_AVATAR_CHAIN` (`头像 → 立绘 → 立绘bg`) for face-shaped ones. A single `AssetType` still means exact match with **no** degradation | §15.9. One chain cannot serve both shapes: a full-body standee cropped into a 2.5rem circle shows a torso, not a face. Both chains end at an acceptable last resort, so neither shape leaves a hole in a half-finished pack — which is the entire value of having a chain in the first place. Exactness stays reachable because _writes_ (import, set-primary) address one specific cell; only **reads** degrade.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D21 | **The manifest also carries `framing`** — display metadata, clamped through `clampAssetFraming` on the way in. It still may never carry `name` or `type`                                                                                                                                                  | 2026-07-29. D10 protects **identity**: name and type come from the filename and nothing else. Framing is not identity — it is display metadata exactly like `credit`/`license`, and a filename cannot carry it. Without this, one export→import round-trip silently resets every frame the user hand-tuned. A non-object `framing` is **dropped**, not clamped: clamping it would translate `"framing": "centred"` into a default frame that reads as if the manifest had said something. Manifest framing lands only on **newly created** rows — a byte-identical duplicate is skipped before the manifest is read, so an existing row's framing is never overwritten.                                                                                                                                                                 |
| D22 | **`importPortraitPair` takes a three-state spec per type**: a rect (crop) / `'whole'` / `'skip'`. Both fields are **required** — omission is a compile error, not a default                                                                                                                               | 2026-07-29. The old `{ portrait?, avatar? }` read omission as "use the whole image", so **no** call could express "don't write this type" and every re-crop of a 立绘 minted another 头像 variant — the library grew by click count. A `null`-means-skip patch would fix behaviour but `undefined` and `null` are too easy to conflate in JS (`?.`, destructuring defaults, `JSON.parse`); string literals cannot be confused, and a typo is a type error. Two `'skip'` stays the `'no-crops'` programmer error.                                                                                                                                                                                                                                                                                                                        |
| D23 | **A write must target the type the reading slot will actually land on.** Concretely: the player portrait slot writes mp4 to **`立绘bg`**, not `头像` — and after any slot-targeted write, success is claimed only if **the slot's resolved row is the row just written**                                  | §15.11. D7 permits mp4 on both `头像` and `立绘bg`, so the original `头像` choice was legal and still wrong: **writes address one cell, reads walk a chain** (D20), and `头像` is _last_ on the standee chain. Any character with an existing 立绘 got a correct write, an unchanged picture, and a toast saying 「已设为画像」 — the worst combination, because the user's only recourse is to click again. `立绘bg` sits above `头像` on that chain, so the write is visible unless a真 `立绘` shadows it — and shadowing is **not** fixable by writing, since D11 forbids the import path from deleting the row on top. So the honest outcome is a warning naming _what_ shadows it and _where_ to change it. The general rule is the second half: a store returning `'ok'` says the bytes landed, never that the user can see them. |

---

## 1. What v1 delivers

A settings section that lets a user build and curate a media library:

- import a zip containing images, video, and audio in one click
- import individual files
- browse assets grouped by name, or as a flat library
- rename, re-type, re-variant, set-as-primary, delete (single and batch)
- see quota usage
- export the whole library back to a zip that round-trips through the importer

**What it did not do — ~~render anything in the game~~ — was reversed on 2026-07-29 (§15.9).**
As originally shipped, `AvatarPanel`, `ScenePanel`, `CharacterListPanel` and `StatusOverview` were untouched
and nothing an import produced was ever visible in-game. That clause no longer holds: five render sites are
wired, the right-hand status panel shows a large 立绘 with pan/zoom framing, and a crop editor turns one
source image into a 立绘 + 头像 pair (§15.9, §15.10, §15.11).

Left as struck-through rather than deleted, because the _scope_ it describes is what the rest of this section
was written against — and because two defects (§15.9) existed precisely **because** nothing rendered, which is
only legible if the original boundary is still visible. See §11 for what remains genuinely out of scope.

---

## 2. The naming convention (D1)

```
<name>[_<type>][_<variant>].<ext>
```

Parsing anchors on the **type token**, scanning underscore segments **right-to-left**, so names may themselves
contain underscores (`圣殿_内庭_头像.png` → name `圣殿_内庭`). Everything before the type is the name; everything
after is the variant.

**Deviation from RPT:** the type token is **optional and defaults to `头像`**.

- `苏婉.png` → name `苏婉`, type `头像` — the zero-ceremony path
- `苏婉_头像.png` → identical, explicit
- `苏婉_头像_微笑.png` → variant `微笑`
- `苏婉_立绘_微笑.png` → parses, stores, catalogued — **renders nowhere in v1** (D4)

**Consequence accepted:** RPT _drops_ anything that doesn't parse, which is what makes its drag-drop safe. With an
optional type token, everything parses — so `IMG_20240101.png` becomes an asset named `IMG_20240101`. Under D2 it
matches no character and is inert. It shows up in 全部素材 and can be renamed (D14) or deleted.

⚠️ **The likelier authoring error is subtler than junk names: omitting the type token while intending a variant.**
`苏婉_微笑.png` parses as name `苏婉_微笑`, type `头像` — a plausible-looking _phantom character group_ sitting
beside the real 苏婉, created silently, with no roster and no coverage meter to reveal it (§3.2).
Rendering (§15.9) gives an _indirect_ signal it did not have before: the user imported a picture of 苏婉 and
苏婉's slot still shows initials. That points at the symptom, not the cause — the phantom group itself is still
visible only in 全部素材, and nothing says the two are related — so the mitigation below still stands.
Mitigation is a soft heuristic in the import summary: if a parsed name's trailing segment matches a known variant
of an existing name (or, more cheaply, if the name contains an underscore at all), surface it as
`疑似漏写类型 n` — advisory, non-blocking, never auto-corrected. Recorded as a risk in §12.

### 2.1 Types and the variant slot

| Type     | Category  | Composites?                           | Media allowed                                              |
| -------- | --------- | ------------------------------------- | ---------------------------------------------------------- |
| `头像`   | character | no — circle clip, `object-fit: cover` | images + **mp4**                                           |
| `立绘`   | character | **yes — cut-out over a backdrop**     | images incl. animated WebP/APNG; **mp4 rejected at parse** |
| `立绘bg` | character | no — full frame                       | images + **mp4**                                           |

Category is **derived** from type (`categoryForType`), never stored (§4.1).

The variant slot is polymorphic by type — a _mood_ on all three types today — and additionally carries
auto-assigned collision numbers (D11).

### 2.2 The mp4/alpha rule (D7)

RPT restricts mp4 to five full-frame types and excludes `头像`, with a stated reason: _"MP4 has no compositing
alpha, so an animated 立绘 would render as a black box behind the character."_

That is a **立绘 problem**. `头像` is a filled circle clipped by `border-radius: 50%`; nothing composites and
nothing needs alpha. The rule generalizes correctly as **"mp4 is allowed exactly where alpha isn't needed."**
`苏婉_立绘.mp4` is rejected at parse time — the same behaviour as RPT, for a better-stated reason.

### 2.3 The naming invariant (D16) — required for round-trip

**Invariant: no underscore segment of `name`, and no underscore segment of `variant`, may equal a type token
(`头像`, `立绘`, `立绘bg`).**

Without this the convention is **not round-trippable**, which breaks the test §5.4 calls the best test of the whole
contract. The failure:

Parsing anchors on the **rightmost** type token. D14 permits renaming a variant to anything. So the row
`(name: 苏婉, type: 头像, variant: 立绘)` — legal under D14 with no invariant — formats to `苏婉_头像_立绘.png`,
which re-parses as `(name: 苏婉_头像, type: 立绘, variant: —)`. Export → import silently mutates the row. The
mirror case is a name whose last segment is a type token with no explicit type.

With the invariant, a formatted filename contains **exactly one** type token, so right-to-left and left-to-right
anchoring agree and `parse(format(row)) === row`. The proof is one line, which is the point.

**Enforcement is at both entry points, and it rejects rather than repairs:**

| Entry point                            | Behaviour                                                                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Import** (zip or individual)         | A basename that parses to a name or variant containing a type token is **rejected**, counted in the summary as `命名冲突 n`. Such a file is malformed under the convention, not merely unusual. |
| **Rename** (D14) and manifest metadata | Rejected inline with an explanation. The UI must not offer an invalid state.                                                                                                                    |

**Note the parser itself is unchanged from RPT** — right-to-left anchoring is preserved, because its purpose
(names containing underscores, `圣殿_内庭_头像.png` → name `圣殿_内庭`) still holds. Left-to-right anchoring would
also fix the round-trip, but only by diverging from RPT's parser to buy what one validation rule buys anyway.

**Round-trip is defined over logical rows, not byte-identical filenames.** `苏婉.png` exports as `苏婉_头像.png`
under D1's default — a different filename, the same row. The test asserts row equality.

### 2.4 Formats

| Kind             | Extensions                               |
| ---------------- | ---------------------------------------- |
| Image            | `png jpg jpeg jpe webp avif gif`         |
| Video            | `mp4`                                    |
| Audio (existing) | `mp3 ogg oga wav m4a aac flac opus webm` |

**`avif` added** — genuinely mainstream and small. **`svg` excluded** — a script-carrying document format and a
strange avatar choice; excluding it costs nothing.

### 2.5 Video alpha: the landscape (reference)

There is **no video format with alpha that works in every browser**:

| Format                       | Alpha       | Support                                                                        |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------ |
| WebM / VP9 or VP8 + alpha    | ✅ 8-bit    | Chromium ✅ · Firefox ✅ · **Safari ✗** (plays WebM since 14.1, ignores alpha) |
| HEVC + alpha in MP4 (`hvc1`) | ✅          | **Safari only** · Chromium ✗                                                   |
| MP4 / H.264                  | ❌          | universal                                                                      |
| AV1 + alpha                  | spec allows | not practical in browsers                                                      |
| **Animated WebP**            | ✅          | **all modern browsers**, plays in `<img>`                                      |
| APNG                         | ✅ lossless | all modern browsers; very large                                                |

Production practice is dual-encoding (VP9-alpha WebM + HEVC-alpha MP4, two `<source>` tags) — a real burden on
whoever makes the art.

**D8: `.webm` stays audio.** It is already claimed by `AUDIO_MIME_BY_EXTENSION`
([audio-names.ts:41](../../src/sillytavern/audio-names.ts)); reassigning it is a regression, and disambiguating
(header sniffing, or "only `.webm` with an explicit type token is an asset") buys VP9-alpha compression for a type
that does not render in v1. **Animated WebP** is the v1 answer for alpha animation. Revisit when the VN stage makes
animated standees real — the door is a one-line routing tiebreak.

> ⚠️ Browser alpha support is the kind of fact that moves. Re-verify before acting on this table.

---

## 3. Identity and matching (D2, D3)

**The asset key is the raw `name` string. Matching is `===`. No normalization — no trim, no casefold, no NFKC.**

This aligns with [state-manager.ts:1391](../../src/sillytavern/state-manager.ts)'s `findByName`, which is also raw
`===`, and deliberately **diverges** from
[audio-names.ts:62](../../src/sillytavern/audio-names.ts)'s `normalizeAudioName` (trim → strip extension → collapse
whitespace → casefold). Audio keeps its own normalization for its own lookups; assets do not adopt it.

Rationale: if the AI emits `苏婉 ` with a trailing space, that is a prompt/lorebook defect to fix at the source.
Forgiving match in the asset layer would let the asset layer match a character the state layer considers a
different character.

### 3.1 There is no roster (D3)

The manager reads **only `assetMeta`**. It does not query `characters`, does not enumerate saves, and has no
notion of a canonical character list.

Consequently these RPT features have **no input and are not built**:

- the coverage meter (`n/m`)
- `missing` / `notInWorld` badges
- any 未匹配角色 list, in the import summary or elsewhere

The 按角色 view is `assetMeta` **grouped by `name`** — a presentation of the library, not a comparison against
anything.

**What this buys:** zero coupling to saves. No save-lifecycle questions, no "what happens when a save is deleted",
no cross-save interference. The library is a standalone global subsystem exactly like audio.

### 3.2 ⚠️ Known deferred risk: names are only partly verifiable

Three decisions stacked in v1:

| Decision             | Effect                      | State after rendering landed (§15.9)                                           |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| D4 — nothing renders | no visual confirmation      | **Reversed.** Five sites render; an absent face is now the confirmation signal |
| D2 — strict, silent  | no error on mismatch        | Unchanged, and deliberately so                                                 |
| D3 — no roster       | nothing to validate against | Unchanged                                                                      |

**v1 therefore had no feedback loop for name correctness at all.** Rendering closed that unevenly, and the two
halves are worth separating:

- **The player slot is a closed loop by construction.** Its import path (`importForCharacter`) writes exactly
  `player.name` and its render path reads exactly `player.name`. The filename contributes only an extension.
  The two sides cannot disagree, so there is no name to get wrong.
- **NPC slots gained feedback but not diagnosis.** A wrong or missing name shows initials where a face should be
  — which is the confirmation that was missing. But it does not say _which_ of the three layers failed: a typo in
  the asset name, a typo in the character name, or an asset that was simply never imported all look identical.

Mitigations: autocomplete off existing asset names, which lives in the rename field (§15.6), and full rename as
the correction path (D14). A real diagnostic still needs something to validate against — see §3.3 and §12.

### 3.3 📌 Side note — the "lorebook scan" feature we are NOT building

**Ideally the manager would offer a lorebook scan**: read the character-partition world book entries and offer
their names as a pick-list, so a human never transcribes a name. This is **explicitly out of scope for v1** on
grounds of scope, and is recorded here so the idea is not lost.

It would be well-behaved architecturally — `data/worldbooks/character.json` is static content the app already
fetches, so it involves **no save data and no cross-save coupling** (D3 is not violated).

**Whoever implements it must handle this trap.** `entry.name` is an **editorial label, not the in-world
character name.** In the shipped roster of **29** entries it diverges for **8**:

| uid           | `entry.name` (label) | content leads with                             |
| ------------- | -------------------- | ---------------------------------------------- |
| 333           | 羡愚**酱**           | `羡愚:`                                        |
| 336           | 莱拉·阿尔-费伊       | `莱拉:`                                        |
| 338           | **诗灵-**仲夏夜之梦  | `仲夏夜之梦:`                                  |
| 339           | **诗灵-**套中人      | `套中人:`                                      |
| 341           | **龙娘**傲雪         | `傲雪:`                                        |
| 315, 327, 340 | —                    | content opens with an EJS template `<%_ { _%>` |

`key[]` is no better — it is scraped keyword noise (`基本信息`, `性别`, `女性`…), and uid 325 (`澪`) does not
contain its own name at all.

A naive implementation offering `entry.name` writes `诗灵-仲夏夜之梦_头像.png` while the runtime
`CharacterState.name` is `仲夏夜之梦` — and under D2 that silently never matches, for ~28% of the roster.

**Also recorded, separately:** `莉利亚・利桑德` (uid 335) uses `・` U+30FB (katakana middle dot) while five other
names use `·` U+00B7. All three occurrences for uid 335 — `name`, `key[0]`, and the content body — agree, so it
works today. **Normalizing only `entry.name` would break it.** Any cleanup must normalize all 32 U+30FB
occurrences across the 5 affected world book files (`character` 3, `event` 12, `faction` 6, `race` 1,
`world_setting` 10), or none.

---

## 4. Storage (D5, D6, D12, D13)

### 4.1 Dexie v13

```ts
assetMeta:  'id, name, type, [name+type], createdAt, updatedAt',
assetBlobs: 'id',
```

`id` is `crypto.randomUUID()`, falling back to a timestamp+counter string where `crypto.randomUUID` is
unavailable (it, unlike `crypto.subtle`, is available in insecure contexts on current Chromium — but the fallback
costs one line and removes the question).

**No standalone `hash` index.** Dedupe is `(name, type)`-scoped (§4.4), so the lookup goes through `[name+type]`
and compares hashes on the handful of returned rows in memory. An index with no query behind it is dead weight.

Row shape:

```ts
interface AssetMetaRecord {
  id: string;
  name: string; // raw, matched with === (D2)
  type: AssetType; // 头像 | 立绘 | 立绘bg
  variant?: string; // mood, and/or auto-assigned collision number
  ext: string;
  mime: string;
  bytes: number;
  hash?: string; // sha-256; absent when crypto.subtle unavailable
  credit?: string;
  license?: string;
  createdAt: number;
  updatedAt: number;
}
```

**Deliberate omissions, each with a reason:**

| Omitted                | Why                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assetHandles` table   | No folder tier in v1 (D5). Add in v14 as a pure-additive bump — exactly how v12 added `audioHandles` with no upgrade callback.                                                    |
| `category` column      | Derived from `type` via `categoryForType`. Storing it is a second truth source, against 铁律4（每类数据唯一真源）.                                                                |
| `*tags` index          | The port eval proposes one, but v1 has no tag-based asset lookup — matching is strict-by-name. A field with no consumer is a liability; the index is another additive bump later. |
| poster/thumbnail table | Withdrawn — see §11.2.                                                                                                                                                            |

Blobs live in their own table so `assetMeta.toArray()` never deserializes payloads — the same reason audio splits
`audioTracks` / `audioBlobs`.

📌 **Correction to an in-repo comment, verified empirically during implementation.** The comment above the v12 block
claims Dexie requires every version to restate the full schema and that omitting a table is a silent drop. **That is
false for Dexie 4.4.3**: `Version.stores()` _extends_ the cumulative spec, so a table omitted from a later version
block is inherited from the previous one. Deleting `audioPlaylists` from the v13 block left all data intact and the
suite green; only an explicit `tableName: null` drops a table (v9's `chats: null` is the proof). We still restate
every table in v13 — it is a worthwhile **convention** (the whole shape is visible at a glance, consistent with
v4–v12) — but it is not a data-safety requirement, and the version-bump regression test therefore guards the thing
that actually matters: that `db.tables` contains the full expected roster, which catches both an accidental `null`
and a new table never declared.

### 4.2 Why one tier, not S3 (D5)

The simulation recommends S3, and its evidence is sound _at its assumed scale_. Our scale is two orders of
magnitude smaller:

|                     | Simulation premise  | v1                             |
| ------------------- | ------------------- | ------------------------------ |
| Asset count         | 5,000 mixed         | ~40 avatars → ~100 with 立绘×2 |
| Per-asset size      | 383 KiB avg         | 头像 ≈ 90 KiB, 立绘 ≈ 850 KiB  |
| Total               | 1.87 GiB            | **~3.6 MB → ~50 MB**           |
| Cold start S1 vs S3 | 0.76–2.0 s vs 22 ms | ~6 ms vs ~1 ms                 |

The **entire** case for S3 is that cold-start column, and it evaporates below the simulation's smallest measured
scale (N=200: 30 ms vs 1.2 ms — both invisible). Meanwhile File System Access costs Chromium-only support and a
**permission gesture every session** to avoid copying 3.6 MB. And "one-click zip import" is fundamentally a
_copy-bytes-in_ gesture — the S2b shape, not the folder shape.

**Blobs, never base64.** The simulation's §7 is unambiguous: base64 is strictly dominated — +33% unrecoverable
(Snappy is pure LZ77, no entropy coder), slower reads, and main-thread deserialization of ~500 KB strings. Audio
already does this correctly.

**No built-in `public/assets/` tier.** 57 mp3s / 267 MB were removed from this repo on 2026-07-28 for exactly this
reason, and 命定之诗 art sits under the 二创授权协议. Shipping character art in-repo repeats a mistake fixed
yesterday.

**Forward risk, on the record:** when 立绘 volume grows ~50× the S3 argument becomes correct again. D6 is what makes
that a cheap migration.

### 4.3 The injection seam (D6)

Blob resolution goes behind an injected resolver, mirroring `audio-singleton.ts`'s `setBlobResolver` / `loadBlob`.
`assetMeta` is the index's source of truth regardless of which tier holds the bytes. Adding the folder tier in v2
then costs nothing in the engine — precisely how the 2026-07-27 audio folder addendum landed with **engine zero
changes**.

### 4.4 Dedupe and hashing (D12)

**Assets: scoped to `(name, type)`.** Skip an incoming file only when its hash matches an existing row _for the
same name and type_. Global-by-hash would succeed once and silently skip 29 times when reusing one placeholder
image across 30 characters.

**Audio: scoped to the normalized name** (`normalizeAudioName`, audio's own rule — assets do not adopt it, per D2).
Skip when the hash matches an existing track whose normalized name matches; otherwise fall through to
`uniqueAudioName` numbering as shipped.

**Audio dedupe is not optional.** Without it, importing the library's own export back into itself hash-skips every
asset and ` (2)`-clones every audio track — half-idempotent, which is worse than either extreme and would fail the
§5.4 round-trip test. This is the only change D12 makes to audio behaviour, and it is additive: `uniqueAudioName`
still governs every non-identical collision.

**`crypto.subtle` requires a secure context.** localhost is secure; a plain-`http://` LAN address is not, and
`crypto.subtle` is `undefined` there. On absence: **fall back to the numbering path** (D11) and say so in the
summary (`哈希不可用，已跳过去重`). No second hash space — honest degradation over a silent alternate algorithm.

**Hashing runs in the UI layer, before planning (D18).** `crypto.subtle.digest` is async and the planner is pure
and synchronous, so `asset-zip.ts` hashes each decoded entry and the planner receives `hash?: string` already
computed. Stating this is not pedantry — a planner signature that implies it can hash is a signature that will be
made async by the first implementer who tries.

_Deferred alternative:_ content-addressed blobs (hash as blob primary key, refcounted) would store shared bytes
once. Real quota savings, but refcount-on-delete leaks blobs the first time a code path forgets. Not v1.

### 4.5 Backup, teardown, quota (D13)

- **Assets are excluded from `FullBackup`.** Stronger than consistency with audio: `FullBackup` is a **JSON** object
  of 13 arrays ([database.ts:349](../../src/sillytavern/database.ts)). Blobs cannot enter JSON without base64 —
  strictly dominated per §4.2 — and every asset would be deserialized on the main thread. **The zip export is the
  migration path, and it is better than a backup field would be.**
- **「清除全部数据」 must destroy `assetMeta` + `assetBlobs`**, matching audio.
- **存档数据 must state both omissions out loud** — that "export save data" carries neither audio nor assets, and
  that each has its own export. Two silent omissions is one too many to leave for the user to discover.
- **Request `navigator.storage.persist()` on first asset import** (not at boot). Chromium's default is
  best-effort storage, evictable wholesale under disk pressure, and **nothing in the codebase requests persistence
  today** — an eviction currently takes out saves _and_ audio. It can be denied; surface the result in the quota
  strip rather than blocking. `navigator.storage.estimate()` is already used at
  [settings-store.ts:368](../../src/ui/stores/settings-store.ts).

---

## 5. The zip contract (D9, D10, D11)

### 5.1 One importer, routing by extension

| Extension                            | Destination                                        |
| ------------------------------------ | -------------------------------------------------- |
| `png jpg jpeg jpe webp avif gif`     | asset (image)                                      |
| `mp4`                                | asset (video)                                      |
| `mp3 ogg oga wav m4a aac flac opus`  | audio                                              |
| `webm`                               | **audio** (D8)                                     |
| anything else, `__MACOSX/`, dotfiles | skipped silently as benign noise (RPT's behaviour) |

**Folder structure is ignored — entries are flattened** and judged by basename alone. A zip made by dragging 40
files and a zip with `assets/`+`audio/` subfolders behave identically.

**No zip-slip defence is needed** — there is no filesystem to write to, so nested paths need flattening, not
rejection.

**Zip bombs are real**, and the caps belong **in `asset-zip.ts`, not in the planner.** Cap total decompressed bytes
(2 GB) and per-entry (10 MB), enforced against fflate's streaming callbacks so decompression **aborts mid-flight**.
The planner receives already-decoded entries and cannot abort decompression that has already completed — putting
the cap there would mean the bomb has already filled memory before anything checks. Tests live with `asset-zip`
accordingly (§9).

⚠️ **Filename encoding.** Zips produced by Windows tooling may store non-ASCII filenames in the system codepage
(CP936/GBK for Simplified Chinese) **without** setting the UTF-8 general-purpose flag. fflate decodes unflagged
names as latin1, yielding mojibake — and under this convention **every identity is a Chinese filename**, so the
failure hits the core case rather than an edge. Required: honour the UTF-8 flag when set; when unset and the decoded
name contains latin1 high-byte runs characteristic of misdecoded GBK, surface
`文件名编码可疑，建议用支持 UTF-8 的压缩工具重新打包` in the summary and **still import** under the decoded name so
the user can rename (D14). Do not silently transcode — guessing a codepage is how you get a _second_ wrong name.
Recorded as a risk in §12.

**Dependency: `fflate`** (~8 KB, zero deps) over `jszip` (~100 KB). The project currently has 5 runtime deps
(`dexie`, `openseadragon`, `pinia`, `vue`, `vue-router`); keep it lean.

### 5.2 Optional `manifest.json` (D10)

At the zip root. The **filename remains the sole identity**; the manifest may only _add_ metadata a filename
cannot carry:

```jsonc
{
  "assets": {
    "苏婉_头像.png": {
      "credit": "…",
      "license": "…",
      "framing": { "x": 20, "y": 80, "scale": 1.75 },
    },
  },
  "audio": {
    "战斗主题.mp3": { "tags": ["情境:战斗", "情绪:紧张"], "credit": "Aoo", "license": "…" },
  },
}
```

It can **never** rename or re-type an entry. Absent manifest = everything imports with empty metadata. A manifest
referencing absent files, and files absent from the manifest, are both tolerated silently.

This is what lets a shareable pack carry attribution — which the port eval §12 argues for and which
`public/audio/manifest.json` already models with per-track `credit` / `license`.

**`framing` (D21).** The line D10 draws is around **identity**, not around the field list: name and type come from
the filename and nothing else, and no manifest key can touch them. Framing is display metadata in the same class as
`credit`/`license` — a filename cannot carry it, and without it a single export→import round-trip resets every frame
the user hand-tuned. Three rules make it safe:

- **Clamped at the door.** `clampAssetFraming` runs in `asset-zip.ts`'s `sanitizeMeta` _and_ in the planner's
  `readManifestMeta`, so no NaN or out-of-range value can reach a row.
- **Non-objects are dropped, not clamped.** `"framing": "centred"` would otherwise become a default frame, which
  reads as if the manifest had said something.
- **Newly created rows only.** A byte-identical duplicate is skipped before the manifest is consulted, so manifest
  framing can never overwrite a frame the user set themselves.

Export omits framing when it equals the default — a 200-image pack should not carry 200 no-op entries.

### 5.3 Collisions: never overwrite, number into the variant slot (D11)

Naively appending a number **breaks the parse**: `苏婉_头像 (2).png` splits into `苏婉` + `头像 (2)`, and
`头像 (2)` is not a valid type token, so the file falls out of its own category.

| Form                  | Parses as                                 | Verdict                                                  |
| --------------------- | ----------------------------------------- | -------------------------------------------------------- |
| `苏婉 (2)_头像.png`   | name `苏婉 (2)`, type `头像`              | ❌ orphaned — under D2 matches no character, ever        |
| **`苏婉_头像_2.png`** | name `苏婉`, type `头像`, **variant `2`** | ✅ stays bound; uses the slot the convention already has |

- **The number goes in the variant slot.** A numeric variant is a legitimate "second avatar for this character".
- **A file that already has a variant appends inside it:** `苏婉_头像_微笑.png` → `苏婉_头像_微笑 2.png`.

**Allocation rules — fully specified, because every one of these was a guess an implementer would have had to make:**

| Situation                       | Rule                                                                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base taken, allocating a number | `max(existing numeric suffixes for this (name, type)) + 1`. **Not first-free.** Deterministic, monotonic, and stable when a middle row is deleted — first-free would recycle `_2` onto a slot a user may remember as something else. |
| `微笑` taken                    | `微笑 2`                                                                                                                                                                                                                             |
| `微笑 2` also taken             | `微笑 3` — **换号, never nest.** No `微笑 2 2`. Mirrors `uniqueAudioName`'s documented "already has ` (n)` → 换号" behaviour, so one rule covers both halves of the importer.                                                        |
| Suffix separator                | A single space then the integer: `微笑 2`. Base rows use the bare integer as the whole variant: `2`.                                                                                                                                 |
| Numeric-looking user variant    | A user-authored variant of `2` is indistinguishable from an allocated one, and that is accepted — both mean "an alternate", and `max+1` keeps allocation correct either way.                                                         |

- **Audio keeps `uniqueAudioName` exactly as shipped** — ` (n)` on the name, with the existing "already has ` (n)`
  → 换号, don't nest" behaviour. No type/variant slots exist there.
- **Lookup semantics: base wins.** With no variant requested, `resolve` returns the no-variant file — so the first
  import is the active one and `_2`, `_3` are alternates. Deterministic, and a re-imported pack never changes what
  displays. Which is why **设为主图** exists (§7.4).

**Consequence:** nothing is ever destroyed, so the import needs **no destructive-preview guard** — it is genuinely
one click, with a summary afterwards.

### 5.4 Export (D17)

One button emits a zip in exactly the format the importer accepts, with a generated `manifest.json`.
**Round-tripping export → import is the single best test of the whole contract** and is a required test (§9).

**Export scope is deliberately narrower than "everything in the library":**

| Content                             | Exported? | Why                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All `assetMeta` + `assetBlobs` rows | ✅        | User-owned bytes, imported by the user.                                                                                                                                                                                                                                                                                                                                               |
| Audio `source: 'blob'`              | ✅        | Same.                                                                                                                                                                                                                                                                                                                                                                                 |
| Audio `source: 'builtin'`           | ❌        | The 57 built-in tracks carry `license: PLACEHOLDER-PENDING-REVIEW` and `credit: Aoo`. Packing them into a shareable zip **redistributes placeholder-licensed material** — precisely the mistake §4.2 credits itself for avoiding, and the reason those files left the repo on 2026-07-28. They also ship with the build, so exporting them is redundant even setting licensing aside. |
| Audio `source: 'file'`              | ❌        | The bytes live in the user's own folder and are not the app's to package. Reading them needs a live permission grant, they may be `missing`, and a folder-linked library is already the user's filesystem backup.                                                                                                                                                                     |

**The export summary states what was excluded** — `已导出 素材 40 · 音频 12 · 已跳过 内置 57 · 本地文件 8` —
rather than silently producing a smaller zip than the library the user is looking at. Silent omission here would
read as data loss.

**Consequence for the round-trip test:** it is defined over the _exportable_ set. A library containing builtin or
file-source audio does not round-trip to an identical library, and that is correct rather than a defect.

---

## 6. Engine / UI split (D15)

Engine layer rules, per project convention: pure — 无 I/O、无 Dexie、无 Vue — importable under
`vitest environment:'node'`, browser globals referenced lazily inside function bodies, and **never** imports
`src/ui/`.

```
src/sillytavern/                    ← pure, node-importable
  types.ts              ★ DATA-MODEL TYPES ONLY, under an
                        `// Asset System (Dexie v13)` banner:
                        AssetType / AssetCategory / ASSET_TYPES /
                        AssetMetaRecord / AssetBlobRecord
  asset-types.ts        LOGIC + TABLES ONLY (no data-model types):
                        categoryForType, allowsVideo, isMediaAllowed,
                        isAssetTypeToken (whole-segment, never substring),
                        ASSET_MIME_BY_EXTENSION  ← single source
  asset-filename.ts     parse / format / violatesNamingInvariant;
                        right-to-left anchoring; optional type → 头像;
                        owns `ParsedAssetName` locally
  asset-index.ts        buildAssetIndex from rows (never a directory);
                        owns `AssetIndex` locally
  asset-resolve.ts      index lookup + 立绘 → 立绘bg → 头像 fallback chain
  asset-import-plan.ts  ★ (entries, existingRows, manifest?) → ImportPlan;
                        owns `DecodedEntry` and `ImportPlan` locally
database.ts             v13 tables + asset readers/writers (where audio's live)

src/ui/lib/
  asset-zip.ts          fflate wrapper: File → [{ path, bytes }]
  asset-url.ts          object-URL LRU + revoke-on-evict
src/ui/stores/
  asset-store.ts        Pinia; executes an ImportPlan against Dexie
src/ui/components/settings/
  AssetSection.vue      shell
  assets/AssetImportStrip.vue      one-click zip import + summary
  assets/AssetLibrary.vue          grid, search, type filter, multi-select
  assets/AssetCharacterDrawer.vue  per-name variants, 设为主图, rename, delete
  assets/AssetDialogs.vue          confirms
```

**Type placement follows the audio precedent, not intuition.** `field-enums.ts` holds _only_ AI-nominated game-data
enums, each paired with a `normalize*()` — 铁律5 is about taming model output, and `AssetType` is picked by a user in
a UI control, never nominated by a model. `AudioSourceKind` / `AudioTrackKind` / `AudioTrack` all live in `types.ts`,
while `types-audio.ts` is reserved for injection-seam interfaces and state/options shapes. So asset data-model types
go in `types.ts` — **not** `field-enums.ts`, and **not** a new `types-asset.ts`. Derived and transient shapes
(`ParsedAssetName`, `AssetIndex`, `DecodedEntry`, `ImportPlan`) stay local to their own modules, the way
`audio-scene.ts` / `audio-tags.ts` own their return shapes.

⚠️ **`DecodedEntry` must be declared engine-side**, in `asset-import-plan.ts`, and **reverse-imported** by
`src/ui/lib/asset-zip.ts` — not the other way round. The engine may not import `src/ui/`, so a `DecodedEntry` owned
by the zip layer would be unreachable from the planner that consumes it. The producer imports the consumer's
contract, exactly as `asset-zip.ts` already reverse-imports `ASSET_MIME_BY_EXTENSION`.

### 6.1 `asset-import-plan.ts` is the load-bearing module

A **pure, synchronous function** taking decoded and **pre-hashed** entries (D18) plus existing rows, returning a
plan. It touches no bytes-storage, no Dexie, no fflate, no `crypto`.

```ts
interface DecodedEntry {
  path: string; // original zip path; flattened to basename by the planner
  bytes: Uint8Array;
  hash?: string; // sha-256, computed upstream; absent → dedupe skipped (§4.4)
}

interface ExistingRows {
  assets: Pick<AssetMetaRecord, 'id' | 'name' | 'type' | 'variant' | 'hash'>[];
  audio: (Pick<AudioTrack, 'id' | 'name' | 'source'> & { hash?: string })[];
}
```

> `AudioTrack` has no `hash` field today. Adding one is a **non-indexed property**, so it needs no Dexie version
> bump — only new writes carry it, and rows without it fall through to `uniqueAudioName` exactly as before. Existing
> tracks are never rewritten.

```ts
type PlannedAsset = {
  kind: 'asset';
  entry: DecodedEntry;
  name: string;
  type: AssetType;
  variant?: string; // post-numbering, final
  ext: string;
  mime: string;
  credit?: string;
  license?: string; // merged from manifest
  renumberedFrom?: string; // variant before allocation, for the summary
};

type PlannedAudio = {
  kind: 'audio';
  entry: DecodedEntry;
  name: string; // post-uniqueAudioName, final
  mime: string;
  tags: string[];
  credit?: string;
  license?: string;
  renamedFrom?: string;
};

type PlannedSkip = {
  kind: 'skip';
  path: string;
  reason:
    | 'duplicate' // hash match in scope (§4.4)
    | 'unknown-extension' // not in any routing table (§5.1)
    | 'noise' // __MACOSX, dotfile
    | 'mp4-on-立绘' // media rule (D7)
    | 'naming-invariant' // type token in name or variant (D16)
    | 'oversize'; // per-entry cap, if not already caught in asset-zip
};

interface ImportPlan {
  assets: PlannedAsset[];
  audio: PlannedAudio[];
  skips: PlannedSkip[];
  warnings: ('hash-unavailable' | 'suspect-filename-encoding' | 'suspect-missing-type')[];
  summary: {
    assetsAdded: number;
    audioAdded: number;
    duplicatesSkipped: number;
    renumbered: number;
    namingConflicts: number;
    noise: number;
  };
}

function planImport(
  entries: DecodedEntry[],
  existing: ExistingRows,
  manifest?: ImportManifest,
): ImportPlan;
```

Two properties worth stating because they are easy to lose: **numbering must be allocated across the batch, not
per-entry** (two colliding entries in one zip get `_2` and `_3`, not both `_2`), and **the plan is fully ordered and
deterministic** for a given input — which is what makes it assertable as data.

Every decision in this document then becomes a unit test over plain data:

- extension routing, including `.webm` → audio
- mp4 rejected on `立绘`, accepted on `头像` / `立绘bg`
- variant-slot numbering, including append-inside-existing-variant
- dedupe scoped to `(name, type)`, and the no-hash fallback path
- manifest metadata merge, and its inability to rename or re-type
- optional-type-token defaulting

The store then does something dumb and obvious: iterate the plan, write rows.

### 6.2 One extension table

`ASSET_MIME_BY_EXTENSION` lives in the engine as the single source and is **reverse-imported** by UI code —
exactly the discipline [audio-names.ts:28-31](../../src/sillytavern/audio-names.ts) documents for
`AUDIO_MIME_BY_EXTENSION` ("引擎层禁止 import `src/ui/`，所以只能反向共享"). Two extension tables in two layers is
how routing silently drifts.

### 6.3 Reuse, don't clone

`settings/audio/format.ts` (byte formatting) is reused rather than duplicated — hoisted to a neutral home if
needed. `AudioBatchResult`'s shape is reused for batch asset operations rather than inventing a second batch-result
type.

---

## 7. UI

> **`docs/design.md` is mandatory reading before writing any of this.** CLAUDE.md requires it before any frontend
> UI code, and it governs every choice this section leaves open: type scale and weights, `--theme-spacing-*` token
> usage, the shared shell rules for buttons / cards / tabs / panels / modals, section-title rules, empty-state
> treatment, quality-colour usage, transition durations, and the `prefers-reduced-motion` checklist. Nothing below
> overrides it — where this section and `docs/design.md` disagree, `docs/design.md` wins.

### 7.1 A new 「素材」 settings section

Inserted **between 音频 and 存档数据** in [SettingsPage.vue:32](../../src/ui/components/settings/SettingsPage.vue)
(currently 11 sections), icon `fa-solid fa-image`. Media sections adjacent, data operations after.

_Rejected:_ merging audio and assets into one 「媒体」 section. `AudioSection.vue` was just refactored from 1,502
lines into a shell + 5 subcomponents; merging rebuilds the problem that refactor solved.

### 7.2 The import button appears in both sections

One implementation, two entry points (D9). A user thinking "add my music pack" goes to 音频; "add avatars" goes to
素材. The summary always reports both halves regardless of entry point:

```
素材 12 新增 · 音频 5 新增 · 跳过 4 重复 · 编号 2
```

_Rejected:_ putting it in 存档数据 as a canonical data-import home — a media pack is content, not save data, and
burying it two sections from the library it fills is worse than one duplicated button.

### 7.3 Two views, one data source

- **按角色** — `assetMeta` grouped by `name`; click a group to open the drawer. Shows per-group variant counts so
  accumulated duplicates are visible rather than hidden (D11's cost).
- **全部素材** — flat library, including entries whose names match nothing.

Both derive from `assetMeta` alone (D3). Individual-file add uses **plain text entry with autocomplete off existing
asset names** — RPT's approach. It doesn't help the first file for a name, but it prevents drift on every
subsequent one.

_Not built:_ RPT's category rail (3 types, not 8) and its naming wizard (with an optional type token, everything
parses).

### 7.4 Mutations

| Action                                 | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rename `name` / `type` / `variant`** | **Fully permitted (D14)**, subject to the D16 naming invariant — a rename producing a type token in `name` or `variant` is rejected inline (§2.3). Renaming into an occupied `(name, type, variant)` slot auto-numbers by the §5.3 allocator. One collision rule, two entry points.                                                                                                                                                                                                                                                                                                                                   |
| **设为主图**                           | Two-step swap, in this order: (1) the current base is demoted to a variant via the §5.3 allocator — `max+1`, **not** hardcoded `_2`, which may be occupied; (2) the chosen row's variant is cleared. Doing it in this order means the base slot is never occupied by two rows, even transiently, so a failure between steps leaves the group base-less (a state §8 already renders) rather than duplicated. Wrap both writes in one Dexie transaction. Kept in v1 even though nothing renders — it is the only control over what v2 will display, and adding it later means packs imported now can't be pre-arranged. |
| **Delete base**                        | **No auto-promotion.** The group is left base-less and shown as 无主图; 设为主图 is the explicit fix. Auto-promotion silently rewrites a filename the user didn't touch and guesses at intent.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Batch delete**                       | Confirm dialog; mirrors audio's `deleteTracks` / `AudioBatchResult` shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

**D14 deviates from RPT deliberately.** RPT locks `name`+`type` to prevent accidental re-parenting — affordable
_because_ its coverage meter surfaced errors immediately. Under §3.2 a typo'd name is both undiscoverable and, with
variant-only rename, uncorrectable except by delete-and-reimport (and the source zip may be gone). The escape hatch
is worth more than the guard.

### 7.5 Object-URL lifecycle

This is the port eval's Blocker 1 (§16), and the manager grid is the one place v1 hits it.

- **LRU keyed by asset id, cap ~64, revoking on evict**, plus revoke-all on section unmount. Audio gets away with
  revoke-per-track-change because its live cap is effectively 1; a grid holds dozens at once.
  **Amended 2026-07-29 (§15.9):** the cache is now **reference-counted** — `release()` revokes only at zero, and
  eviction **skips held entries**, tolerating over-capacity rather than revoking a URL that is on screen. Required
  once one asset can have two simultaneous holders (an NPC in both `ScenePanel` and `CharacterListPanel`).
- **mp4 previews share the same LRU** — `<video muted>` needs an object URL exactly like `<img>`.
- **Never persist an object URL.** Store the logical key (`name`/`type`/`variant`) and resolve at render. Forced in
  v1 by having no render surfaces; now load-bearing, and restated in `useAssetImage`'s header for the same reason.
- Escalation if the library grows: `IntersectionObserver` so URLs are minted only for visible rows. Not worth it at
  ~40–100 assets; recorded so it isn't rediscovered.

### 7.6 Progress, cancel, errors

- **Progress + cancel on zip import.** A 50 MB pack is seconds of decode-and-write; an uncancellable spinner is how
  users force-reload mid-write.
- **Error handling copies audio's shipped pattern verbatim: 单条失败不中断 · 结束后一条汇总 · 如实呈现部分成功.**
  That pattern was a _post-review fix_ in the audio system (items ③⑧⑬ of the 2026-07-27 review) — reusing it is
  free; reinventing it repeats the review.
- **Quota strip** reusing `navigator.storage.estimate()`, plus the `persist()` request from §4.5.

---

## 8. Empty states

| State                       | Shown                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| Library empty               | Points at the import button; explains the filename convention in one line with an example. |
| 按角色 empty                | Same — it is empty _because_ the library is (D3 removed the fresh-install ambiguity).      |
| Group with no base          | 无主图 + 设为主图 affordance.                                                              |
| `crypto.subtle` unavailable | Summary line `哈希不可用，已跳过去重`.                                                     |
| `persist()` denied          | Stated in the quota strip; not blocking.                                                   |

---

## 9. Test plan

Engine modules are pure, so their tests need neither IndexedDB nor fflate.

| Module                 | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asset-filename`       | **`parse(format(row)) === row` as a property test over generated rows** (D16's whole justification); right-to-left anchoring with underscored names; optional type → `头像`; variant capture; mp4 on `立绘` rejected at parse                                                                                                                                                                                                                  |
| `asset-filename` (D16) | type token as a `name` segment → rejected; as a `variant` segment → rejected; **the specific regression `(苏婉, 头像, 立绘)` must not survive a format→parse cycle** (§2.3)                                                                                                                                                                                                                                                                    |
| `asset-types`          | `categoryForType`; media rules per type; extension→MIME completeness                                                                                                                                                                                                                                                                                                                                                                           |
| `asset-resolve`        | exact hit; `立绘 → 立绘bg → 头像` fallback chain; variant request vs base; miss → `null`                                                                                                                                                                                                                                                                                                                                                       |
| `asset-index`          | build from rows; base vs variant grouping                                                                                                                                                                                                                                                                                                                                                                                                      |
| `asset-import-plan`    | **the bulk** — routing table incl. `.webm`→audio; variant allocation (`max+1` not first-free; 换号 not nesting; **batch-wide allocation so two colliding entries get `_2` and `_3`**); asset dedupe scoped to `(name,type)`; **audio dedupe by normalized name**; no-hash fallback; manifest merge and its inability to rename or re-type; D16 rejection counted as `namingConflicts`; `__MACOSX`/dotfile skips; determinism for a fixed input |
| `asset-zip`            | **decompressed-size caps abort mid-stream** (moved here from the planner — the planner receives decoded entries and cannot abort past decompression, §5.1); UTF-8 flag honoured; unflagged CP936 name → `suspect-filename-encoding` warning **and still imported**, never transcoded                                                                                                                                                           |
| `asset-store`          | `fake-indexeddb`: plan execution, batch delete, rename incl. collision-renumber and D16 rejection, **设为主图 demote-then-clear in one transaction with `_2` already occupied**, delete-base leaves group base-less                                                                                                                                                                                                                            |
| `asset-url`            | LRU eviction revokes; unmount revokes all; injected `createObjectURL`/`revokeObjectURL` seams                                                                                                                                                                                                                                                                                                                                                  |
| **round-trip**         | **export → import produces an identical library**, over the _exportable_ set (D17) — assets + `blob` audio only. Must be idempotent on **both** halves: re-importing an export must neither duplicate assets nor ` (2)`-clone audio (§4.4).                                                                                                                                                                                                    |

Test seams follow the audio precedent: injected `createObjectURL` / `revokeObjectURL`, injected hash function,
injected clock for `createdAt`.

---

## 10. Deliverables

| #   | Item                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 5 engine modules + `*.test.ts` each                                                                                                                                                                                                             |
| 2   | Dexie v13 (`assetMeta`, `assetBlobs`) + readers/writers. **No teardown work needed** — `clearAllData()` ([database.ts:343](../../src/sillytavern/database.ts)) calls `db.delete()` on the whole database, so new tables are destroyed for free. |
| 3   | `fflate` dependency; `src/ui/lib/asset-zip.ts` incl. streaming size caps, UTF-8-flag handling, and per-entry hashing (D18)                                                                                                                      |
| 4   | `src/ui/lib/asset-url.ts` (LRU)                                                                                                                                                                                                                 |
| 5   | `src/ui/stores/asset-store.ts`                                                                                                                                                                                                                  |
| 6   | `AssetSection.vue` + 4 subcomponents, **built against `docs/design.md`** (§7); nav entry between 音频 and 存档数据                                                                                                                              |
| 7   | Import button surfaced in 音频 as well, calling the same action                                                                                                                                                                                 |
| 8   | 存档数据 copy stating both backup omissions (D13)                                                                                                                                                                                               |
| 9   | `navigator.storage.persist()` request on first import                                                                                                                                                                                           |
| 10  | Doc updates: `CLAUDE.md` (architecture + progress + settings-section count 11→12), this file                                                                                                                                                    |

---

## 11. Explicitly out of scope for v1

> **Three rows left this table on 2026-07-29 (§15.9): in-game rendering, unifying the 5 avatar render sites, and
> the `<video>` branch in `AvatarPanel`. All three are built.** What follows is what is still genuinely not built.

| Item                                                       | Why, and what unblocks it                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Poster / thumbnail frames**                              | Still withdrawn. The original justification (`ScenePanel` decoding 15 videos at once) now _could_ exist — but the five sites that landed each mount at most one media element per character and reuse one refcounted object URL per asset (§7.5), so the decode count is bounded by visible characters, not by library size. Revisit if the VN stage puts many `立绘` on screen at once; also closes the port eval's §11.3 "no thumbnails" gap. |
| **The VN-style stage**                                     | The real home for `立绘`. Its own design problem (positioning, layering, entry/exit, mood switching, backdrop resolution) and it drags `背景`/`全景` into scope. The `立绘 → 立绘bg → 头像` chain (D20) means art authored now still works when it lands — and that chain is now exercised in production by `ScenePanel`, so it will not rot again the way §15.9 (1) describes.                                                                 |
| **`背景` / `全景` / `CG` / `misc` types**                  | Not defined in v1. `asset-scene.ts` (scene resolution over `location-db`'s `parentId` tree) belongs with them.                                                                                                                                                                                                                                                                                                                                  |
| **Name diagnostics for NPCs**                              | Rendering closed the _player_ half of §3.2 by construction and gave the NPC half visual feedback, but a silently-wrong NPC name still produces nothing beyond an absent face. See the revised §3.2 / §12 row.                                                                                                                                                                                                                                   |
| **Lorebook scan**                                          | See §3.3 — recorded with its trap, deliberately not built.                                                                                                                                                                                                                                                                                                                                                                                      |
| **Folder-linked tier (FS Access)**                         | D5. The D6 seam makes it a cheap v2 addition.                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Built-in `public/assets/` library**                      | Licensing (§4.2).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Content-addressed / refcounted blobs**                   | §4.4. Not to be confused with §15.9's object-URL refcount — that counts _live holders of a URL_, not shared ownership of stored bytes.                                                                                                                                                                                                                                                                                                          |
| **Remote-declaration layer, custom protocols, `fs.watch`** | No browser analogue; port eval §18 already says skip.                                                                                                                                                                                                                                                                                                                                                                                           |
| **WebM/VP9-alpha assets**                                  | D8. One-line routing tiebreak when animated standees become real.                                                                                                                                                                                                                                                                                                                                                                               |
| **i18n**                                                   | RPT routes every string through `t()`; this project is Chinese-only.                                                                                                                                                                                                                                                                                                                                                                            |

---

## 12. Risks

| Risk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Severity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Mitigation                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wrong NPC names are still undiagnosable** (§3.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **Medium** — downgraded from High on 2026-07-29, _not_ closed. Rendering (§15.9) changed the picture unevenly: the **player slot is now a closed loop by construction** — the import path writes exactly `player.name` and the render path reads exactly `player.name`, so the two sides cannot disagree about identity no matter what the user types. **NPC slots now give visual feedback**: a wrong or missing name shows initials where a face should be, which is precisely the confirmation that was absent before. But a _silently wrong_ NPC name still produces **no diagnostic beyond "no face appeared"** — the user cannot tell a typo from an asset that was never imported, and with D2 strict + D3 no-roster there is nothing to compare against. | Player slot needs no mitigation. For NPCs: autocomplete in the rename field (§15.6); full rename (D14); lorebook scan still recorded but not built (§3.3)                                                                          |
| **Zip filename encoding (CP936/GBK without the UTF-8 flag)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **High** — every identity under this convention _is_ a Chinese filename, so mojibake hits the core case, not an edge. Likely the first real-world bug report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Honour the UTF-8 flag; detect suspect unflagged names and warn; import anyway under the decoded name so D14 can fix it; never transcode on a guess (§5.1). Covered by `asset-zip` tests (§9).                                      |
| **Omitted type token creates a phantom character group** — `苏婉_微笑.png` → name `苏婉_微笑`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Medium-High — silent, plausible-looking, and invisible without a roster or rendering                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Advisory `疑似漏写类型 n` heuristic in the import summary (§2); D14 rename as the fix. Cannot be auto-corrected — an underscore in a name is legal (`圣殿_内庭`).                                                                  |
| Duplicates accumulate invisibly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Hash-skip (D12) now covering **both** halves (§4.4); per-group variant counts in the grid (§7.3)                                                                                                                                   |
| Export omits builtin/file audio and reads as data loss                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Low                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Export summary states every exclusion explicitly (§5.4)                                                                                                                                                                            |
| **`.vue` templates are not type-checked at all** — `npm run typecheck` is plain `tsc`, and `vue-tsc` is not installed. **32** pre-existing SFC type errors exist repo-wide (measured 2026-07-29 with a one-off pinned `vue-tsc`; 18 of them in `SettingsPage.vue`, see the row above).                                                                                                                                                                                                                                                                                                               | **Medium**, project-wide (not asset-specific)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The asset SFCs were verified with a one-off `vue-tsc` run at 0 errors, and the audio precedent's store/lib tests are the real guard. Adding `vue-tsc` to `typecheck` would surface ~40 existing errors and is a separate decision. |
| **`compareRows` sorts variants as strings — `_10` sorts before `_2`** (`asset-store.ts`). **NOT fixed.** `AssetCharacterDrawer` carries a _local_ comparator with `{ numeric: true }` and a comment that says exactly why. A local patch layered over a shared comparator is the standard way the two drift: every other consumer of `compareRows` (the flat 全部素材 table, `groups`' per-group ordering, anything added later) still gets the wrong order, and the next reader has two orderings to reconcile. The fix is one option object on the shared comparator, then deleting the local one. | Low impact, **Medium** as debt — only visible past 10 variants of one `(name, type)`, which auto-numbering reaches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Recorded 2026-07-29; not fixed to keep that round mechanical (§15.10)                                                                                                                                                              |
| **`SettingsPage.vue` accounts for 18 of the repo's 32 `vue-tsc` errors** — `PresetItem.settings` / `PresetItem.template` do not exist on the type. **NOT fixed.** This is real type drift, not template noise, and it is _structurally invisible_ to `npm run typecheck`, which is plain `tsc` and does not parse `.vue` (the row below). It is the concrete cost of that gap: 18 errors accumulated in one file with nothing failing.                                                                                                                                                               | **Medium**, not asset-specific                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Recorded 2026-07-29. Fixing it means deciding what `PresetItem` should actually declare, which is a preset-system change, not an asset one                                                                                         |
| IndexedDB eviction loses the library                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `persist()` (§4.5); zip export as the user-controlled backup (§5.4)                                                                                                                                                                |
| `crypto.subtle` absent over LAN http                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Low                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Documented fallback to numbering + summary line (§4.4)                                                                                                                                                                             |
| Volume growth invalidates D5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Low now, rises with 立绘                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | D6 seam; §4.2 records the threshold                                                                                                                                                                                                |
| Two extension tables drift                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Low                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Single engine-side source, reverse-imported (§6.2)                                                                                                                                                                                 |
| `fflate` is a new runtime dep                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Low                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ~8 KB, zero deps; chosen over jszip's ~100 KB                                                                                                                                                                                      |

---

## 13. Rationale for the sharper reversals

Recorded so a future reader doesn't "fix" them back.

1. **Optional type token (D1)** reverses RPT's drop-what-doesn't-parse safety. RPT can afford strictness because a
   wizard catches the remainder; we trade that for a zero-ceremony common case and rely on rename (D14) to clean up
   junk names.
2. **Strict `===` (D2)** rejects the forgiving match the source docs' `mood.ts` and `sceneResolve.ts` culture would
   suggest. Chosen because a mismatch is a defect _upstream_, and forgiving match here would let the asset layer
   disagree with the state layer about character identity.
3. **No roster (D3)** reverses the coverage meter — RPT's most-cited player-facing feature. Chosen to keep the
   subsystem free of save coupling. The cost is §3.2 and it is real.
4. **One tier, not S3 (D5)** contradicts the simulation's headline recommendation. The recommendation is
   scale-conditional and the scale isn't there; §4.2 records the threshold at which it flips back.
5. **mp4 on `头像` (D7)** contradicts RPT's explicit type restriction. RPT's _reason_ is alpha compositing, which
   a circle-clipped avatar doesn't do. The rule was right; its formulation was over-broad.
6. **Never overwrite (D11)** reverses the idempotent-pack semantics that would keep playlists stable across
   re-imports. Chosen so nothing is ever destroyed — which in turn removes the need for a destructive-preview
   guard and makes the import genuinely one click.
7. **Full rename (D14)** reverses RPT's variant-only lock. RPT's guard depended on the coverage meter D3 removed.
8. **The naming invariant (D16)** is a constraint RPT does not have and does not need — because RPT never lets a
   user author a variant freely (variant-only rename is still _validated_ against its own type table, and its
   import wizard constrains the rest). Once D14 opened `variant` to arbitrary text, the convention stopped being
   round-trippable and needed the invariant to get it back. **D16 exists because of D14** — remove one and the
   other becomes unnecessary; remove D16 alone and §5.4's test cannot pass.
9. **Audio hash-dedupe (D12, extended)** touches shipped audio behaviour, which this design otherwise avoids on
   principle. Justified narrowly: without it the unified importer is _half_-idempotent, which is worse than either
   consistent extreme. It is strictly additive — `uniqueAudioName` still governs every non-identical collision.

---

## 14. Review history

| Date       | Event                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-29 | Design written from a 16-question design interview against the two RPT source documents.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-07-29 | Adversarial review (Fable agent). Verified all codebase citations, counts, and line references as accurate. Found 9 defects; **all 9 applied**: the D16 round-trip hole (§2.3), audio dedupe gap (§4.4), export licensing scope (D17/§5.4), `ImportPlan` + numbering under-specification (§5.3/§6.1), size-cap layering error (§5.1/§9), missing `docs/design.md` binding (§7), zip filename encoding risk (§5.1/§12), phantom-character-group risk (§2/§12), and three nits (dead `hash` index, no-op teardown deliverable, line reference). |
| 2026-07-29 | Implemented in 6 phases via delegated agents. All acceptance criteria met; see §15 for the decisions implementation forced and the two design corrections it produced.                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-07-29 | **In-game rendering built — D4's "nothing renders" clause reversed.** Five render sites wired; two latent defects surfaced the moment anything actually rendered. New D20 (two fallback chains). §11 lost three rows, §12's High risk downgraded to Medium. See §15.9.                                                                                                                                                                                                                                                                        |
| 2026-07-29 | **Large portrait + framing dial + crop editor.** New D21 (manifest carries `framing`) and D22 (three-state crop spec). Two real defects found in passing and **recorded, not fixed** (`compareRows` string-sorts variants; `SettingsPage.vue` holds 18 of 32 `vue-tsc` errors) — see §12. **Main path verified on real hardware**; zip framing round-trip, mp4, skip mode, library re-edit and all four NPC render sites are not. See §15.10.                                                                                                 |

---

## 15. Implementation notes

Recorded because each item was a gap or a wrong assumption in the sections above — a future reader should not
have to rediscover them.

### 15.1 Under-specifications resolved during implementation

| Gap                                                                                                                        | Resolution                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §5.3 pinned `max+1, not first-free` only for the **base** slot; the `微笑 2` / `微笑 3` rows gave results without a policy | **`max+1` applied uniformly** to named variants too. Two allocator policies is exactly the drift §5.3 exists to prevent.                                                 |
| `renumberedFrom` when a **base** row is evicted — there is no prior variant                                                | `''` means "had no variant"; `undefined` means "not renumbered".                                                                                                         |
| `summary.renumbered` scope was undefined for audio                                                                         | Counts **asset renumbers + audio renames**, since §7.2 shows a single unified `编号 n` line for one importer.                                                            |
| `suspect-missing-type` appears in the `warnings` union but §2's heuristic was loose                                        | Implemented the **precise** variant — trailing segment strips to a known existing name — as an order-independent post-pass, not the cheap "contains an underscore" test. |
| Audio track naming on import was unstated                                                                                  | `stripExt(basename)` → `uniqueAudioName`, matching the shipped `audio-store` upload path. This is also what makes export → import idempotent.                            |
| `oversize` / `suspect-filename-encoding` are in the planner's warning union but the planner never emits them               | Correct by design — they are raised in `asset-zip.ts` (§5.1). Pinned by a test so nobody "fixes" it.                                                                     |
| `ExistingRows.audio` is built from `getAudioTracks()`, so **builtin names don't participate in `uniqueAudioName`**         | Accepted: an imported track may legally share a builtin's name. Builtins are excluded from export anyway (D17).                                                          |

### 15.2 Two corrections to prior belief

**(a) The Dexie restate-all-tables rule is a convention, not a data-safety requirement** — see the boxed
correction in §4.1. The in-repo comment above the v12 block is wrong for Dexie 4.4.3.

**(b) `AudioTrack` had no `credit` / `license` columns at all.** This was a _pre-existing_ gap, not a deliberate
omission: even the built-in library's `credit: "Aoo"` / `license: "PLACEHOLDER-PENDING-REVIEW"` lived only in
`public/audio/manifest.json` and never reached a Dexie row. Since D10's entire purpose is carrying attribution,
dropping it for imported audio would have hollowed out the manifest. Both fields were added as **non-indexed
properties requiring no version bump**, following the `hash?` precedent — only new writes carry them, existing
rows are untouched.

### 15.3 Behaviour worth knowing

- **Unknown-extension entries are never inflated.** Routing is decided in fflate's `onfile`, before any data
  flows, so noise costs nothing and — critically — **cannot trip the size caps**. An oversized `notes.psd` beside a
  valid PNG no longer fails the whole import, which is what §5.1's "skipped silently as benign noise" actually
  requires. `readAssetZip` returns `skippedNoise: string[]` so the planner still reports `unknown-extension`
  without ever holding the bytes.
- **Zip progress `total` is not knowable up front and grows.** A zip's entry count lives in the central directory
  at the _end_ of the file, while streaming reads local headers front-to-back. Scraping the EOCD backwards was
  deliberately rejected: it counts noise and directory entries, so the bar could never reach 100%. Consequence for
  any UI: **never render a percentage that can decrease** — treat decode as indeterminate, or use byte-based
  progress (`source.length` _is_ known up front).
- **Cancellation** is `signal?: AbortSignal` on `readAssetZip` plus `cancelImport()` on the store, with a distinct
  `'aborted'` error code so a deliberate cancel reads as 已取消 rather than an error. **Rows written before the
  cancel stay written** — reported honestly rather than rolled back.
- **A zip missing only its central directory reads back successfully**, since streaming needs only local headers.
  Asserted deliberately: recovering exact bytes beats failing on a technicality.
- **`setPrimary` is genuinely atomic** — both writes sit inside one `db.transaction`, proven by a test that makes
  the second `put` throw and asserts the demote rolls back and the group still has exactly one base.
- **Hashing is shared, because the audio _upload_ path needed it too.** Verification found that audio uploaded via
  音频→上传 was written with no `hash`. Since such a track is `source: 'blob'` it **is** exported, and re-importing
  it fell through to `uniqueAudioName` and produced a ` (2)` clone — the exact half-idempotency D12 forbids. The
  round-trip test passed only because it exercised zip-imported audio. `media-hash.ts` is now the single SHA-256
  implementation with the single `crypto.subtle` feature-detect, used by both `asset-zip.ts` and the upload path.
  Hashing can never fail an upload: every failure mode returns `undefined`.
- **`thumbs.ts` does not revoke URLs it abandons, and that is deliberate.** It never mints them — the LRU does — so
  an abandoned generation's URLs stay tracked by the LRU and remain subject to eviction and `revokeAll()`. There is
  no untracked leak to fix. For the same reason it does **not** release on drop-out: the drawer lists the same rows
  as the grid, `release()` has no refcount, and closing the drawer would revoke URLs the grid is still displaying —
  a screenful of dead images. Both decisions are pinned by mutation tests: adding release-on-drop-out fails exactly
  the two tests that encode the shared-LRU design.

### 15.4 Pre-existing test failures (not asset-related — do not mistake for regressions)

- `src/ui/stores/game-store.test.ts` › 「loadSave 应并行回读最新大纲与事件树」 — **flaky (~50%)**. Root cause
  found: `savePlotOutline` unconditionally sets `updatedAt = Date.now()`, clobbering the test's deliberate
  `Date.now() - 1000`; when both rows land in the same millisecond, `sortBy('updatedAt')` ties and order is
  arbitrary.
- `src/ui/components/create/SelectableCard.test.ts` › 「稀有度边框色正确」 — **stable failure**, predates this
  work; asserts an `rgb()` value but receives a CSS variable under jsdom.

Both are tracked separately and neither is caused by this work. The suite baseline is therefore
**4041 passed / 2 failed**, not 4043/0.

### 15.5 A pre-existing bug this work uncovered and fixed

`SettingsPage.vue` destructured **`deleteDatabase`** from `@engine/database` — a name the engine has never
exported. 「清除所有数据」 therefore threw `TypeError` _before_ closing the modal or showing a toast: nothing was
deleted and the user got no feedback. It was almost certainly broken since it shipped.

This mattered here because D13/§4.5 promises that save export excludes assets **but 「清除全部数据」 destroys
them** — a guarantee the app did not honour. The call site now uses the real `clearAllData()` (which does
`db.delete()` on the whole database and nulls the singleton, so `assetMeta`/`assetBlobs` go with it), and a guard
test asserts every engine name `SettingsPage.vue` imports actually exists. The guard was mutation-verified:
reintroducing `deleteDatabase` turns it red and names the offender.

One rough edge reported and deliberately not fixed: for the 1.5 s between deletion and `location.reload()`, the
in-memory stores still list rows that no longer exist. Cosmetic, self-heals on reload.

### 15.6 Post-merge review round (commit `97e5900` reviewed, fixes follow-on)

An adversarial review of the merged commit found six defects. All six are closed. Fixing them surfaced **four
more** that the review never saw — each caught by an agent while working on something adjacent.

| #   | Defect                                                                                                                                                                                                                                                                                                                                             | Resolution                                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`allocateSlot` was lossy.** It round-tripped through `formatAssetFilename` → `planImport`, whose `basenameOf` flattens at the last separator — so a name containing `/` ran the slot check against the **wrong `(name,type)` group** and could produce **two base rows**, breaking D11. Leading-`.` names read as noise and reported `'failed'`. | The planner now exports `allocateVariantSlot(name, type, desiredVariant, existingRows)` sharing the same private core as its own numbering path. The single-policy property survives; the filename encoding is gone.                                                                                                                                  |
| 2   | **Export trimmed names, import didn't** (`writeAssetZip` did `basenameOf(name).trim()`), so `" 苏婉"` silently became `苏婉` on round-trip — the export side quietly enforcing a normalization D2 rejects.                                                                                                                                         | Trim removed. Separator flattening kept but made **loud** via `onSeparatorInName` (falling back to `console.warn`) — silent flattening is exactly how this stayed invisible.                                                                                                                                                                          |
| 3   | **Prototype pollution** in `buildAssetIndex`: `byName[row.name] ??= {}` with an importable row named `__proto__` writes an own key onto `Object.prototype`.                                                                                                                                                                                        | `Object.create(null)` at every level keyed by user input. Latent in v1 (no production caller) but this is the shipped v2 contract.                                                                                                                                                                                                                    |
| 4   | **Single-file import was never built**, despite §1, §2.3 and §7.3 promising it.                                                                                                                                                                                                                                                                    | `importFiles(files: File[])` reusing the whole pipeline, plus picker/drop support. **The §7.3 naming form was deliberately _not_ built** — see below.                                                                                                                                                                                                 |
| 5   | **In-batch audio dedupe** recorded the planned hash under the _post_-`uniqueAudioName` key, so two byte-identical files landed as `(2)` and `(3)`.                                                                                                                                                                                                 | Recorded under **both** desired and final keys — both load-bearing, covering the mirror case too. Asset side checked and confirmed correct.                                                                                                                                                                                                           |
| 6   | **Toast copy promised** re-import dedupe unconditionally — false under `hash-unavailable`.                                                                                                                                                                                                                                                         | Conditioned on hashing having worked.                                                                                                                                                                                                                                                                                                                 |
| 7   | **A mixed drop fired two toasts** (zip half + loose half), against §7.2's "exactly one summary per import". Found while building (4).                                                                                                                                                                                                              | New store action **`importAny(files: File[])`** — the UI hands over the whole drop and does **no routing**; the store splits, runs both halves through the shared `executeImport`, merges, emits one toast. `isZipFile` moved into the store with its Windows MIME nuance (`.zip` reports as `x-zip-compressed` or empty type) and four pinned cases. |

**Five defects found while fixing the above, none of which the review saw:**

- **Trailing-space extensions dropped legal files.** The zip routing gate looked up the _literal_ extension, so `"苏婉_头像.png "` had extension `"png "`, missed the table, and was discarded as noise. The UI gate had drifted **stricter** than the engine's `isAssetExtension`, which trims internally. Now normalized for the routing decision only, name kept verbatim, and the engine predicate is called directly so the two cannot diverge again.
- **A second `.trim()` in the store** was silently rewriting names on rename — same D2 violation as (2), different file.
- **`return executeImport(...)` inside `try/finally`** released the import mutex and reset progress _before_ the work ran. Now `return await`.
- **The progress bar could still move backwards.** The UI's own "denominator changed → reset the high-water mark"
  rule produced 66% → indeterminate → 25%: a decrease laundered through one spinner frame. Deleting the rule fixed
  it, because the high-water comparison already subsumed it. **"Rendered ratio never decreases" is now
  unconditional**, and the logic moved to a tested pure module (`settings/assets/progress.ts`). Found only because
  the brief said _confirm, don't assume_ — inspection would not have caught it.

**On reporting honesty, two upgrades beyond the literal fix.** `readErrors: string[]` replaced a boolean
"read failed" flag, so one corrupt zip among good images now reports the **real counts and names the failing
file** in the same notification instead of collapsing into a misleading blanket message; and `nothingChanged`
suppresses itself when `readErrors` is non-empty, so a failed read can never render as 全部跳过.

> **The through-line worth remembering: removing one wrong normalization made three other bugs visible.** The
> export-side trim was masking them. That is the strongest available argument that D2's "no normalization" is
> structural rather than fussy — and an argument for fixing root causes, since a rename-gate patch on (1) would
> have left (2) and the extension drop buried.

**Why the §7.3 naming form was not built** (a deliberate deviation from the design, recorded here rather than
silently dropped): a pre-import naming form is a **second naming entry point**, and it would have to re-implement
the D16 invariant, the D19 gate, and the §5.3 collision allocator. That is precisely the duplication this design
keeps legislating against — a form validating differently from rename is how `(苏婉, 头像, 立绘)` gets back in.
With D1's optional type token every filename already parses, so a dropped `photo.png` lands as name `photo` and
D14's rename — already built, already carrying both gates — is the natural correction point. **The autocomplete
§7.3 asks for therefore lives in the rename field** (native `<datalist>` over existing names), which is the one
moment a user is actually weighing a name. It remains the only mitigation for §3.2's unverified-names risk.

### 15.7 Rebased onto `ui-test` — the v2 render sites moved

This work was rebased onto `ui-test` (8 commits, 91 files, +4,273) after the review round. The rebase was clean
and the suite is unchanged at **4041 passed / 2 failed** (both pre-existing). No asset code needed changes — the
subsystem's decoupling (D3) meant a substantial UI overhaul touched none of it.

But `ui-test` **rewrote the very surfaces §11 names as the v2 integration work**, so the render-site inventory is
restated here as the current truth:

| Site                                                                              | State after rebase                                                                                                                          |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [StatusOverview.vue:199](../../src/ui/components/game/StatusOverview.vue)         | `<AvatarPanel>` — **moved from :79, and the props changed**: now `size="xl" shape="square"`                                                 |
| [CreateStepConfirm.vue:18](../../src/ui/components/create/CreateStepConfirm.vue)  | `<AvatarPanel size="lg">` — unchanged                                                                                                       |
| [CharacterListPanel.vue:94](../../src/ui/components/game/CharacterListPanel.vue)  | hand-rolled `.npc-avatar`, `name[0]` — unchanged                                                                                            |
| [CharacterListPanel.vue:113](../../src/ui/components/game/CharacterListPanel.vue) | hand-rolled `.d-avatar`, `name[0]` — unchanged                                                                                              |
| [ScenePanel.vue:295](../../src/ui/components/game/ScenePanel.vue)                 | **moved from :196 and renamed** — now `.npc-portrait` driving a `--npc-avatar-color` custom property from `nameColorVar`, with `initialsOf` |

Two consequences for whoever does the v2 render work:

- **`AvatarPanel` grew an API.** It now takes `shape` (at least `square`) and an `xl` size. The planned `<video>`
  branch for mp4 avatars must handle both — a square `object-fit: cover` video is fine, but the circle-clip
  reasoning in §2.2 that justified allowing mp4 on `头像` was written for a circle. It still holds (a square crop
  composites no more than a circle does), but check it against whatever shapes exist by then rather than assuming.
- **`ScenePanel`'s fallback is now a CSS custom property**, not an inline background. Preserving the
  `nameColorVar` fallback when art is absent means feeding `--npc-avatar-color`, not restyling a `<span>`.

### 15.8 Two environment facts worth knowing

- **`@types/node` is not installed**, so any Node builtin referenced from `src/**` is an automatic TS2307/TS2304.
  The engine-import guard test therefore reads sources via Vite's `?raw` through the project aliases rather than
  `fs`/`path` — no path arithmetic, and it survives the file being moved.
- **Verify against a quiescent tree.** During implementation the suite was twice run while agents were mid-edit,
  once catching a half-written import and once catching a deliberately-removed guard from a mutation test. Both
  produced alarming-looking failures that did not exist. Test counts climbing between runs is the tell.

### 15.9 Rendering landed — D4 reversed, and the two defects that were invisible until it did

**Unverified on real hardware.** Suite: **4123 passed / 1 failed** (`SelectableCard 稀有度边框色正确`, the known
pre-existing baseline failure of §15.4, unrelated to assets — the other known-flaky `game-store` test passed this
run). `npm run typecheck`: **0 errors** (with §12's standing caveat that plain `tsc` does not check `.vue`
templates). **15 files modified, 8 new.**

#### What was built

| Piece                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/composables/useAssetImage.ts` (new)       | The single render seam: `(name, type?) → { url, isVideo }`. Strict `===` (D2) — an empty or unmatched name yields `null` silently, never a toast. Owns the object-URL lifecycle, a generation guard on the async `assetUrl()` (an out-of-order resolution renders _another character's face_, so this is not hygiene), and release on scope dispose. `isVideo` is decided from the **matched row**, never sniffed off the URL — object URLs carry no extension.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/ui/components/shared/AssetMedia.vue` (new)   | Fills its container when an asset resolves; hands the slot back untouched when none does. A component rather than a few computeds because each list item needs **its own** resolution scope, and letting Vue build and tear those down makes the URL release free. Size, shape and cropping all come from the _outer_ container, so one component fills a 2.5rem circle and a 46×58 standee slot alike. Used by the two hand-rolled sites (§15.7's inventory).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `AvatarPanel.vue`                                 | Gained an optional `video` prop → `<video muted playsinline loop autoplay>`. Omitted means `false`, so **no existing caller changes behaviour**. This is the row §11 used to carry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Five render sites                                 | `StatusOverview` (player, 1:1 square), `CreateStepConfirm` (96px circle), `CharacterListPanel` ×2 (2.5rem and 3.5rem circles), `ScenePanel` (46×58 NPC portrait). **Every one keeps its original initials / first-character fallback.** `ScenePanel` keeps `.npc-portrait` on the **outer** element because that class is the hover-popup `anchorSelector` — the asset goes _inside_ it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `asset-store.init()` hoisted to `App.vue`         | It had only ever run in `AssetSection`'s `onMounted`. A session that never opened the settings page saw an empty library, which reads as "the avatar I imported doesn't show up". Same reasoning and same location as the audio library's `init()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Import affordance on the **player portrait only** | Click / Enter / Space opens a file picker → new store action `importForCharacter(file, name, type)`. This is the roster-driven import routed **through the naming convention**: the picked filename supplies _only its extension_; `name` and `type` come from the slot, so `IMG_1234.png` cannot grow a phantom character group (§2's risk, structurally absent on this path). It reuses the same mutex, the same three gates, the same hash dedupe and the same collision allocator — never overwrites (D11), conflicts go to a variant slot — and **always ends in `setPrimary`**, including when the bytes were already present by hash. Without that last step a user clicks import on a slot, an identical _variant_ already exists, and nothing visibly changes. D16/D19-violating names are refused with their **own** outcome and their own sentence, because on this path the filename is irrelevant and telling the user "import failed" would send them renaming a perfectly good file. |
| `src/ui/lib/asset-url.ts`                         | Reference counting — see defect (2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

#### Defect 1 — the fallback chain was dead code, and D20 is the fix

`resolveAsset` walked `ASSET_TYPE_FALLBACK_CHAIN` **only when `type` was `undefined`**. Any explicit type took an
exact-match path with no degradation. Every real caller names a type. So the chain that its own file header calls
「整个移植里最值钱的一行」 — the one whose entire purpose is that a character with only a `头像` still fills a
standee slot — stopped working the instant it acquired a caller.

**v1 shipped it with no production caller at all, which is exactly why nobody noticed.** The unit tests passed
because they tested the `undefined` branch, which is the branch nothing uses.

The fix is **D20's two chains**, not one chain reached more often. A face-shaped slot and a standee-shaped slot
want _opposite_ priorities: `头像 → 立绘 → 立绘bg` for the former, `立绘 → 立绘bg → 头像` for the latter. Sharing
one chain would mean a full-body standee cropped into a 2.5rem circle, which shows a torso. The `type` parameter
now accepts a single `AssetType` (exact, unchanged — writes depend on it) **or** an array walked in order. The
index-outer / chain-inner nesting is preserved, so source priority still beats chain priority and the "add a
built-in tier by unshifting an index" property of §4.3 is intact.

#### Defect 2 — `release()` had no refcount

`asset-url.ts`'s `release()` unconditionally revoked. Harmless while nothing rendered — there was only ever one
holder. The moment two components can show the same asset (an NPC visible in **both** `ScenePanel` and
`CharacterListPanel`), the first to unmount revoked the URL out from under the second, which became a broken
image. Now: `get()` retains on every successful take (including callers that join an in-flight load — a bare
`return pending` would record one count for two holders, the concurrent form of the same bug), `release()`
decrements and revokes only at zero, and **capacity eviction skips held entries** rather than revoking a URL that
is on screen. Over-capacity is the accepted cost; a dead image that only appears "sometimes" is not.

A test in `assets/thumbs.test.ts` had pinned the _old_ behaviour — capacity 2 evicting and revoking two entries —
and was rewritten. **It was asserting the bug.** `thumbs.ts` deliberately never releases, so under the old rule
every thumbnail scrolled past 64 could revoke a URL another surface was still displaying.

#### The lesson worth keeping

Both defects were **structurally invisible in a no-render v1**, and neither was a coding slip: each was a correct
implementation of a contract that only one side of had been built. A fallback chain with no caller cannot be
observed to not fall back; a refcount is indistinguishable from no refcount while there is only ever one holder.
This is the same shape as §15.6's prototype-pollution finding ("latent in v1, no production caller") — and it is
the concrete cost of D4's original no-render scoping, which §13 should be read alongside. **When a subsystem ships
its contract before its only consumer, the tests pin the contract as written, not as used.**

---

### 15.10 The large portrait, the framing dial, and the crop editor

> 🔴 **This section describes the UI as of commit `e818b61`. The framing _dial_ it walks through no longer
> exists** — `ad612d5` stripped every control off the portrait and moved them into `PortraitSettingsDialog`
> (§15.11). The section is kept as written, and corrected here rather than rewritten, because the _reasoning_
> below (why a lone 头像 gets no large portrait; why framing is display metadata; why the crop editor has no
> name field) survived the change intact — only the control's location moved. Read the verification claim
> below with both caveats attached.

**✅ Verified on real hardware — but on `e818b61`, and with two discounts.** Walked end-to-end in a live browser
(Chromium, dev server, 2026-07-29) against save 「测试冒险」/亚瑟: clicking the player portrait opened the editor
titled 裁剪 · 亚瑟 with **no name field** (§7.3 holding in practice, not just in tests); the 立绘 rect defaulted to the
whole 1200×1600 source and the 头像 rect to `533 × 533 自 (334, 0)` — horizontally centred, pinned to the top, and
landing **on the head**, which the circular preview confirmed; confirming wrote exactly **two rows under one name**
(`亚瑟/头像`, `亚瑟/立绘`) from one source file named `IMG_9999.png`, proving the filename contributed nothing but its
extension; the large portrait then appeared top-aligned without a reload; the dial opened with the correct defaults
(水平 50%, 垂直 0%, 缩放 1.00×), moved the image live (`object-position: 50% 70%` + `matrix(2,0,0,2,0,0)`), persisted
`{x:50,y:70,scale:2}` to the **立绘 row only** after the debounce, and 复位 restored `{x:50,y:0,scale:1}` and persisted
that too.

**🔴 Discount 1 — the last four clauses vouch for deleted code.** Everything from "the dial opened" onward describes
the on-image dial that `ad612d5` removed. The _behaviour_ was re-hosted rather than rewritten — `PortraitSettingsDialog`
calls the same `clampAssetFraming` and the same debounced `setAssetFraming`, and has its own unit tests — but
**nobody has walked the dialog on real hardware.** The checkmark does not transfer. Treat the shipped framing UI as
test-only until someone repeats this walk against it, and note that the dialog added a genuinely new failure mode the
dial never had (the debt-with-id ledger of §15.11, whose whole job is that closing or switching characters mid-drag
does not write one character's framing onto another's row).

**🔴 Discount 2 — the session ran on top of a live database-wiping bug.** The walk was performed inside the 「测试冒险」
save, and at that time the 🧪 快速测试 button called `clearAllData()`, which is `db.delete()` — it destroyed the
**entire** IndexedDB including the deliberately-global asset and audio libraries (found and fixed later; `96b87ce`,
§15.11). The steps above remain trustworthy **because the assets were imported after entering the save**, so nothing
they assert depended on pre-existing rows surviving. But **any same-session observation of the form "the stuff I
imported earlier is still there" is worthless from this session**, and this walk must never be cited as evidence that
the library survives across sessions. That property is still unverified on hardware.

**🔴 Still unverified on real hardware**, and the list matters more than the pass above: no zip carrying `framing`
has been round-tripped through a real file; the mp4 path has never been exercised (neither the bypass-the-editor
branch nor video in a portrait frame); the library's 裁剪 re-edit entry has not been opened; the 不生成 skip mode has
not been run end-to-end; crop rects have not been adjusted by keyboard; and **no NPC portrait has ever been rendered
from an asset** — only the player slot was exercised, so the four non-player render sites remain test-only.
The verified path is pinned by tests running against injected seams (decoder, canvas, `createObjectURL`) — which is exactly the
`environment: 'node'` posture the audio system shipped under, and §15.9's lesson says the tests pin the contract as
written, not as used. Suite: **4259 passed / 1 failed** (the `SelectableCard` baseline of §15.4). `npm run
typecheck`: **0 errors**, with the standing `.vue` caveat of §12.

#### The large portrait, and why a lone 头像 never gets one

`StatusOverview`'s right-hand slot now renders a **top-aligned large portrait** filling the column width, via the
new `shared/CharacterPortrait.vue`. But it only does so when the type the fallback chain actually landed on is
`立绘` or `立绘bg` — a character whose only asset is a `头像` keeps the original 1:1 square.

The branch predicate is **the matched row's type, not "is there an image"**. That distinction is the whole point.
`立绘`/`立绘bg` are authored as full-height or full-frame compositions; filling the column is what they are _for_.
A `头像` is a face crop, typically a few hundred pixels square. Blown up to column width it is soft, badly framed,
and reads to the user as a rendering bug rather than a feature — the failure is indistinguishable from "the app
scaled my image wrong". So D20's read-side degradation still runs (a lone `头像` **does** fill the standee slot, as
it must — that chain is the reason half-finished packs stay usable), but the _presentation_ does not degrade with
it. Falling back on the source is right; falling back on the layout is not.

`CharacterPortrait` and `AvatarPanel` therefore split on **presentation shape**, not on data source. Both consume
the same `useAssetImage` result; the caller picks. `useAssetImage` gained a `row` ref for precisely this — the
consumer needs to know _which cell answered_, and sniffing it off the object URL is impossible (they carry no
extension, the same reason `isVideo` has always come from the row).

#### Framing is display metadata, which is what keeps D21 consistent with D10

A large portrait immediately raises a question a small circle never did: the character's face is a third of the way
down a 2:3 standee, and the slot is 3:4. Something has to decide what is visible. That is `AssetFraming` — a focal
point plus a scale, stored on the asset row, adjusted with a dial that opens off the portrait. _(The dial moved into
`PortraitSettingsDialog` in `ad612d5`; everything below is unaffected — where the control lives changed, what it
writes did not.)_

The control writes through `setAssetFraming` (debounced), and every read passes `clampAssetFraming` first. The clamp
is not defensive hygiene: a single `NaN` makes the browser discard the whole `object-position` / `transform`
declaration, so the symptom is "this picture is _sometimes_ misaligned" — the worst class of style bug to trace.
Legacy rows have no `framing` at all, an older build could have written an out-of-range scale, and a drag divided
by a not-yet-measured container width produces `NaN` on its own. All of those paths converge on one clamp.

**Why this does not reopen D10.** D10's line is around **identity**: `name` and `type` come from the filename and
from nothing else, so no manifest key may set them. Framing sets neither. It is display metadata in the same class
as `credit` and `license` — the two fields D10 has always permitted — and like them it _cannot_ be expressed in a
filename, which is the entire reason the manifest exists. D21 adds it to that class and to no other. The three
guards in §5.2 (clamped at both doors, non-objects dropped rather than clamped, applied to newly created rows only)
exist so the addition cannot become an identity channel by accident: a manifest can never overwrite a frame the
user tuned, because a byte-identical duplicate is skipped before the manifest is consulted.

Without D21, one export → import round-trip silently resets every frame the user hand-tuned. That is data loss
wearing the costume of a no-op.

#### The crop editor — and why it is not a naming form

`shared/AssetCropEditor.vue` turns **one source image into a 立绘 + 头像 pair**, in one action, from one file the
user already has. Two rects over one stage, two live previews, and per type a **three-state** switch — 裁剪 /
整图 / 不生成 — mapping one-to-one onto `PortraitCropSpec` (`CropRect` / `'whole'` / `'skip'`, D22, both fields
required so omission is a compile error rather than a silent default).

`'skip'` is the state that keeps the library from growing by click count. The editor is also the **re-crop** entry
point, and re-cropping a 立绘 almost never means "and mint me another 头像"; without the third state every re-crop
left behind an avatar variant nobody asked for. `'whole'` matters for the opposite reason: it stores the **original
bytes** untouched rather than passing them through a canvas, which would flatten an animated WebP to frame one and
re-encode a JPEG lossily. Only the true-crop halves are capped — 2048 for 立绘, 768 for 头像, chosen as roughly 3×
the largest size either is ever rendered at (~384px and ~180px at a 16px root), which covers 3× density displays
with headroom. Above that the bytes grow with the square of the edge, the quota is shared, and not one pixel of it
can reach a screen. `fitWithinMaxEdge` never upscales, so a 300px source stays 300px.

**It has no name field, and must never grow one.** §7.3 refused a pre-import naming form because it would be a
**second naming entry point**, obliged to re-implement the D16 invariant, the D19 gate and the §5.3 collision
allocator — and duplication of exactly those three is the drift this design has spent its whole length preventing.
That refusal still stands, and the crop editor is the case that tests it hardest, because it is the one surface
where the user is staring at an image and could plausibly be asked what to call it.

The name is a **prop**, supplied by whoever opened the editor, and always from context:

- the player portrait slot passes `player.name` — the same string the render path reads, so the two sides cannot
  disagree about identity no matter what the user types (this is why §12 calls the player slot a closed loop);
- the library drawer passes the existing asset's name — a group that already exists cannot be renamed by cropping it.

**Cropping decides pixels, never names.** Renaming stays in the library, where the user is actually deliberating
about the name and where the autocomplete belongs (§15.6). The editor's own header comment says this in red, the
test file has a case whose stated job is enforcing it, and both should stay.

A consequence worth stating: the editor lives in `shared/`, not `settings/assets/`. It has two consumers — the
library drawer and the game page's portrait slot — and couples to neither page; leaving it under `settings/` made
the game page depend on a settings directory, which is a layering inversion. Its geometry moved to
`lib/crop-rects.ts`, alongside `lib/image-crop.ts` whose source-pixel coordinate system it shares.

---

### 15.11 Furniture off the portrait, the identity strip, and the review round that followed

**Not verified on real hardware. None of it.** Everything in this section is pinned by unit tests running against
injected seams, which §15.9's lesson says pin the contract as written rather than as used. Suite: **4315 passed /
2 failed** — both the pre-existing baselines of §15.4 (`SelectableCard 稀有度边框色正确`, stable; `game-store
loadSave 应并行回读最新大纲与事件树`, flaky — a re-run scored 4316/1 with the flaky one passing, so read "2 failed"
as the pessimistic end of a range, not a new regression). `npm run typecheck`: **0 errors**, with §12's standing
caveat that plain `tsc` does not check `.vue` templates.

#### What shipped

| Commit                                           | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ad612d5`                                        | **All furniture off the portrait.** The framing dial and the camera badge are gone; `CharacterPortrait.vue` is now a pure presentational component taking `framing` as a prop and touching neither the store nor any control. Everything moved into the new `shared/PortraitSettingsDialog.vue`. Click routing forks on **what there is to adjust**: a large portrait (`立绘`/`立绘bg`) opens the dialog; anything else goes straight to the file picker. |
| `a2411f3`                                        | **Identity strip** (种族·身份·职业·生命层级·冒险者等级) overlaid on the top of the large portrait.                                                                                                                                                                                                                                                                                                                                                        |
| `1875d1c`                                        | Crop editor's two columns brought together (stage column shrink-wraps, modal `xl`→`lg`); `dev.bat` IPv6 fix.                                                                                                                                                                                                                                                                                                                                              |
| `96b87ce`, `a12926b`                             | 🧪 快速测试 was calling `clearAllData()` — a full `db.delete()`. A second button 「快速测试（保留数据）」 was added; the original keeps its clean-slate semantics.                                                                                                                                                                                                                                                                                        |
| _(review round, uncommitted at time of writing)_ | Seven fixes — see below.                                                                                                                                                                                                                                                                                                                                                                                                                                  |

#### Why the dial had to leave the image

The previous version put two small controls **on** the picture, and the dial then opened a popover that **covered the
picture it was adjusting**. The user was tuning a frame they could not see. That is the whole reason for the move; it
is not tidiness.

Two properties of the replacement are worth protecting:

- **The dialog's preview _is_ `CharacterPortrait` itself**, not a second element styled to look like it. A copied
  preview drifts from the real thing sooner or later, and a WYSIWYG control that lies is worse than no preview. This
  is only possible _because_ `CharacterPortrait` became pure — a component that reads the store cannot be handed an
  unsaved draft, so purity is what buys the live preview for free.
- **Persistence is debounced, and the debt records the `id` alongside the value.** Recording only "dirty" and reading
  `props.assetId` at flush time is a real trap: the flush that lands at the moment the user switches character or
  swaps the image writes the _previous_ portrait's framing onto the _new_ row. Closing and unmounting must both settle
  the debt, or the last 300 ms of adjustment vanishes.

`PortraitSettingsDialog` deliberately does **not** implement 更换图片 itself; it emits `replace`. The byte routing
(images to the crop editor, mp4 straight through) already exists on the caller, which has the same path for
"portrait with no asset yet". Two implementations of one rule is the drift this document has spent its whole length
preventing.

#### The identity strip is content, not a control

It renders **inside** the portrait slot, so clicks bubble to the slot exactly as they do from bare image pixels and
the truncation fallback (`title` on hover) keeps working. `pointer-events: none` would have broken the second while
"fixing" a problem that does not exist. There are no buttons, badges, or hover popovers on it.

🔴 **The scrim is a fixed black gradient and the ink a fixed light `#f0ebe1` — deliberately not theme variables.**
Underneath is an image the _user_ imported, of unknown luminance. Theme-derived colours would hand a light theme a
light scrim, which is exactly no scrim at all on a white image. A gradient rather than a solid bar, because a solid
bar covers the composition the user just cropped.

The same data renders in **two places in the DOM** (overlaid when there is a large portrait, its own row otherwise).
Merging them is tempting and wrong: **where it sits decides whether clicking works.** The overlaid copy must be a
descendant of the slot to bubble; the standalone copy must be outside it, or a line of identity text becomes the
content of a button that opens a file dialog.

#### The review round — seven findings, all closed

| #   | Finding                                                                                                                                                                                                                                                                           | Fix                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `dev.bat`'s trailing-space port match **did nothing**. Without `/C:`, `findstr` splits its argument into a space-separated pattern _list_, the trailing space is dropped, and the bare `:5173` also matches `:51730`–`:51799` — next to a live `taskkill /F`.                     | `findstr /C:":%%P "`.                                                                                                                                                                                                                                                               |
| 2   | UTF-8 Chinese inside `::` comments desyncs cmd's byte-offset batch parser, and **comment fragments were executing as commands** — one was really running `findstr`. stderr 940 B → 0 B.                                                                                           | All comments to ASCII; rationale moved to the new `docs/reference/dev-bat-notes.md`. New `.gitattributes` pins `*.bat` to CRLF (an LF-only `.bat` does not fail loudly, it just stops working).                                                                                     |
| 3   | `test-save.ts`'s preserve-then-reset left the DB **cleared but unseeded** (`clearAllData()` deletes what `initializeDatabase()` seeded, and `initialized` stayed `true`), and swallowed a failed clear entirely.                                                                  | `initialized` resets to `false` after a successful clear; `clearedThisLoad` is set **only** on success, so a failure retries instead of counting as done; a failed clear now warns that this run is building on an **uncleared** DB, because the button's label promised otherwise. |
| 4   | The portrait slot wrote mp4 to `头像` — legal under D7, invisible under D20.                                                                                                                                                                                                      | Writes `立绘bg`, and success is claimed only when the slot's **resolved** asset actually changed; an existing `立绘` that shadows it produces an honest warning naming the shadowing type and where to change it. **New D23.**                                                      |
| 5   | `importForCharacter` derived type from the filename extension only, while its own caller used `blob.type` first — so a file with no extension but `type: 'video/mp4'` was routed as video and then rejected as "unsupported format".                                              | Both use the shared `resolveSourceMime`; `ext` is looked up back from the MIME so it can never be empty.                                                                                                                                                                            |
| 6   | `useAssetImage` tracked a single `heldId`, but one `id` can be taken **twice** (a name flapping A→B→A within one Dexie read); the stale round deliberately does not release, so one count was never repaid and the URL was pinned forever (capacity eviction skips held entries). | An owed-**count** map. Invariant: total releases === total successful takes, and the row currently displayed always keeps at least one count.                                                                                                                                       |
| 7   | `asset-url.ts` could hand out an already-revoked URL when `revokeAll()` landed between minting and settling — a dead `<img>`, plus a release owed against a _future_ URL for the same id.                                                                                         | A shared `liveOnly` gate on both return paths (originator and in-flight joiner); if the URL is no longer the live one, return `null`, which the contract already defines as "owe nothing".                                                                                          |

Plus one found while fixing: `importPortraitPair` recorded the mime/ext **predicted before cropping**. Canvas does
not promise to honour the requested type — Firefox cannot encode webp and per spec silently returns PNG — so the
library grew rows saying `mime: image/webp` over PNG bytes. Invisible in-app (browsers sniff), but the export
filename, the re-import routing, and the "ext is authoritative" contract were all lying, and it only detonates once
the user carries the pack to another machine. Now the row records what the produced Blob **says it is**, falling back
to PNG (the spec's own default for an unsupported type) rather than to the prediction, which would just restate the
lie.

**One finding was a false positive, recorded so nobody re-opens it:** `.npc-portrait` in `ScenePanel.vue` was flagged
as missing `overflow: hidden` for the circular clip. It already has it. Nothing was changed there, and the file is
untouched in this round.

#### The two lessons worth transferring

**(i) A fix whose comment confidently asserts the wrong mechanism is worse than no fix.** The `dev.bat` trailing space
had a comment explaining, in detail and in bold, why it was load-bearing — and it did nothing, because `findstr`
without `/C:` never saw it. The comment was doing real damage: it converted an open question into a settled one, so
the next reader (and the review before this one) skipped past it. A missing guard gets found eventually; a guard that
is confidently documented and inert is invisible until it fails. When a comment claims a mechanism, the claim needs
the same evidence the code does — here, one run with a process actually listening on `:51730`.

**(ii) A test can pin a bug, and two did here.** `useAssetImage.test.ts` asserted `released` equalled exactly
`['b1']` — the leak, written down as the expectation. `StatusOverview.assets.test.ts` asserted
`importForCharacter` was **called with** `'头像'` — which was true, and useless, because the defect was that calling
it changed nothing the user could see. Both tests were green throughout. This is the third instance in this document
(after §15.6's `thumbs.test.ts` and §15.9's refcount test), and the pattern is now clear enough to name: **a test
that asserts "the function was called with X" cannot detect a defect in what X _does_.** The replacements assert the
observable end state — the release ledger balances; the slot's rendered `src` changed — which is the only form that
could have gone red. Where a test and the code were written by the same person in the same sitting, the test
records the intent, not the behaviour; only an assertion phrased in terms the _user_ would notice escapes that.
