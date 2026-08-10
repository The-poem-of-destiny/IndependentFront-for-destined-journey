# Theme implementation design QA

## 2026-08-09 Jade Conservatory reference-match addendum

Date: 2026-08-09

final result: passed

### Target and state

- Selected source: `artifacts/theme-looks/jade-conservatory/prototype-4-herbarium-archive.png` (1672 x 941).
- Live implementation: the real Vue play area with the `测试旅者` save, toolbar expanded, scene `角色` tab active, status `装备` tab active, both ledgers expanded, and the status ledger scrolled to its top.
- Desktop comparison viewport: 1680 x 945 CSS pixels. The implementation capture is resized by less than 0.5% to the source dimensions only inside the combined comparison image.
- Responsive stress viewport: 1024 x 768 CSS pixels.

### Comparison evidence

- Final implementation: `artifacts/theme-looks/jade-conservatory/input-frame-removed-1680.png`.
- Composer detail: `artifacts/theme-looks/jade-conservatory/input-frame-removed-detail.png`.
- Source-left/live-right full comparison: `artifacts/theme-looks/jade-conservatory/input-frame-removed-comparison.jpg`.
- Responsive implementation: `artifacts/theme-looks/jade-conservatory/input-frame-removed-1024.png`.

The final live composition matches the reference's continuous paper-and-jade application frame, polished jade plaques, bound parchment narrative folio, four corner-anchored antique-brass barrel hinges, botanical medallion, status-ledger hierarchy, and brass tab connectors. The composer keeps the outer notebook border, parchment field, and compact jade send plaque while omitting the stretched decorative raster behind them. The right ledger's identity row, portrait, nameplate, attribute section, inventory header, and inventory tabs were measured and aligned independently rather than judged from a screenshot alone.

### Interaction and responsive evidence

- Exercised all four scene tabs and all four status tabs at both viewports. Every click selected the requested index; no tab changed its x, y, width, or height; neither tab row overflowed.
- Verified hover material brightening and keyboard `:focus-visible` outline without geometry changes.
- Collapsed and restored the tool rail, attribute ledger, and inventory ledger. No document or panel horizontal overflow appeared.
- At 1024 x 768, the document and game body remained horizontally contained. The status ledger intentionally retained 32 px of vertical scroll for its complete content.
- Browser console contained only the test save's expected unconfigured-Agent pipeline messages. No theme, asset, CSS, or interaction error was emitted.

### Comparison history

1. The initial live theme was a flat mint paper treatment and failed the source's material hierarchy.
2. Macro geometry was aligned to the source's toolbar, scene ledger, folio, and status ledger proportions.
3. Generated parchment, polished jade, botanical, brass, and medallion assets replaced flat CSS approximations.
4. The narrative surface became a bound notebook with live jade rails and four corner-anchored antique-brass barrel hinges; full-rail repetition was reduced and the open C-ring experiment was rejected as too jewelry-like.
5. Typography, rail scale, portrait scale, and panel spacing were calibrated at the source viewport.
6. The complete identity row and status hierarchy were restored and the right ledger's scroll origin was verified.
7. The right-ledger vertical landmarks were aligned to the reference, and scene/status tab connectors were placed on their source-specific edges.
8. The stretched polished-jade raster behind the composer was removed without changing its outer frame, parchment field, send button, or tab geometry.

### Findings

- P0: none.
- P1: none.
- P2: none.
- P3: generated paper fibers and botanical strokes do not reproduce the source's individual random marks pixel-for-pixel; their density, placement, contrast, and material role match and do not affect layout or interaction fidelity.

### Verification

- `npm.cmd run test -- --run tests/theme-surface-ownership.test.ts tests/theme-fonts-invariant.test.ts`: 29 passed.
- `npm.cmd run test -- --run`: 7,338 passed, 9 skipped.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run typecheck:vue`: passed.
- `npm.cmd run lint`: passed with zero warnings.
- `npm.cmd run build`: passed; existing chunk-size and mixed dynamic/static import warnings remain unchanged.

Date: 2026-08-08

final result: passed

## Comparison target

- Product surface: populated play area for save `测试冒险`, turn 0.
- Source truth: the eight selected theme looks listed below.
- Implementation: the real Vue game UI at `http://localhost:5173/` with settings
  closed, toolbar expanded, equipment tab active, and the same populated save.
- Exact comparison viewport: 1440 x 900 CSS pixels.
- Normalization: every source and implementation capture is 1440 x 900 pixels.
  The browser viewport override and screenshot output therefore compare at 1:1
  CSS-pixel density without browser chrome or resampling.
- Expected content difference: concept references use illustrative character and
  location names; the implementation uses the real save's dynamic content. This
  does not change the UI hierarchy or theme treatment.

## Full-view comparison evidence

Each image places the selected source on the left and the real implementation on
the right at the same pixel dimensions and play-area state.

| Theme             | Source visual truth                                  | Combined comparison                                                              |
| ----------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Wayfarer's Atlas  | `artifacts/theme-looks/wayfarers-atlas/look-4.png`   | `artifacts/theme-rework/reference-pairs/atlas-reference-left-live-right.png`     |
| Jade Conservatory | `artifacts/theme-looks/jade-conservatory/look-4.png` | `artifacts/theme-rework/reference-pairs/jade-reference-left-live-right.png`      |
| Moonwhite Brocade | `artifacts/theme-looks/moonwhite-brocade/look-4.png` | `artifacts/theme-rework/reference-pairs/moonwhite-reference-left-live-right.png` |
| Aurora Frostglass | `artifacts/theme-looks/aurora-frostglass/look-2.png` | `artifacts/theme-rework/reference-pairs/aurora-reference-left-live-right.png`    |
| Gilded Orrery     | `artifacts/theme-looks/gilded-orrery/look-2.png`     | `artifacts/theme-rework/reference-pairs/orrery-reference-left-live-right.png`    |
| Bronze Mechanism  | `artifacts/theme-looks/bronze-mechanism/look-3.png`  | `artifacts/theme-rework/reference-pairs/bronze-reference-left-live-right.png`    |
| Nocturne Sakura   | `artifacts/theme-looks/nocturne-sakura/look-5.png`   | `artifacts/theme-rework/reference-pairs/sakura-reference-left-live-right.png`    |
| Abyssal Cathedral | `artifacts/theme-looks/abyssal-cathedral/look-2.png` | `artifacts/theme-rework/reference-pairs/ocean-reference-left-live-right.png`     |

## Focused comparison evidence

Focused crops were required because the reported defects occur at panel
junctions and are too small to judge reliably in a full-view contact sheet.

- Jade frame ownership and uniform crop:
  `artifacts/theme-rework/focused-pairs/jade-live-frame-and-crop.png`
- Aurora translucent ledger and continuous scenery:
  `artifacts/theme-rework/focused-pairs/aurora-glass-and-scene.png`
- Orrery frame-free orbital field behind live seams:
  `artifacts/theme-rework/focused-pairs/orrery-field-and-seams.png`
- Ocean nave termination at the live narrative frame:
  `artifacts/theme-rework/focused-pairs/ocean-nave-and-seams.png`

The remaining four themes did not require separate detail crops: at original
size their full-view comparisons clearly expose every top, side, and input-frame
junction relevant to this issue.

## Responsive evidence

All eight themes were rendered from the real UI at six viewports. Each matrix
folder contains one full-resolution screenshot per theme and an `audit.json`
record of live element bounds, panel junctions, horizontal overflow, input
containment, and computed background sizing.

| Viewport    | Purpose                          | Contact sheet                                           | Geometry evidence                                    |
| ----------- | -------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| 1440 x 900  | exact concept-reference viewport | full-view pairs above                                   | `artifacts/theme-rework/matrix/1440x900/audit.json`  |
| 1920 x 1080 | primary 1080p use case           | `artifacts/theme-rework/contacts/contact-1920x1080.jpg` | `artifacts/theme-rework/matrix/1920x1080/audit.json` |
| 2560 x 1440 | primary 2K use case              | `artifacts/theme-rework/contacts/contact-2560x1440.jpg` | `artifacts/theme-rework/matrix/2560x1440/audit.json` |
| 3840 x 2160 | primary 4K use case              | `artifacts/theme-rework/contacts/contact-3840x2160.jpg` | `artifacts/theme-rework/matrix/3840x2160/audit.json` |
| 1680 x 1050 | taller 16:10 stress case         | `artifacts/theme-rework/contacts/contact-1680x1050.jpg` | `artifacts/theme-rework/matrix/1680x1050/audit.json` |
| 3440 x 1440 | ultrawide stress case            | `artifacts/theme-rework/contacts/contact-3440x1440.jpg` | `artifacts/theme-rework/matrix/3440x1440/audit.json` |

Every audit record reports an empty `errors` array. Bronze's deliberate 5-6 px
outer chassis gutter is contained inside the layout and does not overlap any
adjacent region.

## Interaction evidence

- Aurora focused input:
  `artifacts/theme-rework/interactions/aurora-focus-1920x1080.png`
- Aurora collapsed toolbar:
  `artifacts/theme-rework/interactions/aurora-collapsed-1920x1080.png`
- Atlas expanded equipment row:
  `artifacts/theme-rework/interactions/atlas-expanded-item-1920x1080.png`
- Ocean expanded equipment row:
  `artifacts/theme-rework/interactions/ocean-expanded-item-1920x1080.png`

The status tabs were exercised in the live UI, the active state updated, and the
status ledger remained horizontally and vertically contained. Browser console
errors and warnings after these interactions: none.

## Required fidelity surfaces

### Fonts and typography

- All theme work preserves the application's Qinghua/Crimson font contract;
  themes do not override the user-selected body or display font.
- Real Chinese labels retain the established weight, line height, hierarchy,
  wrapping, and truncation behavior at every tested viewport.
- Small labels become physically smaller in 2K/4K screenshots because the CSS
  viewport grows while font tokens stay stable; this is expected desktop
  behavior, not raster scaling.

### Spacing and layout rhythm

- The live DOM is the single geometry source. Top bar, toolbar, scene ledger,
  narrative well, status ledger, and input each own their border and inset.
- No bitmap supplies a responsive inter-panel seam. Panel junctions have no
  overlap, clipping, unexpected gap, or horizontal overflow across the matrix.
- Inputs, expanded item detail, active tabs, and collapsed-toolbar states remain
  inside their owning live region.

### Colors and visual tokens

- Each theme retains its selected palette and material hierarchy. Borders,
  controls, active tabs, gauges, focus rings, and expanded rows use the same
  material family as their containing ledger.
- Aurora side ledgers use translucent frost fills with backdrop blur; the aurora
  and mountain field remains visible through both sides.
- Contrast remains sufficient for real content, including muted metadata and
  resource values in the light themes.

### Image quality and asset fidelity

- Scenic rasters use uniform `cover` or a single constrained axis with the other
  axis left `auto`; no visible bitmap is stretched independently in X and Y.
- Jade, Atlas, and Ocean framed art is clipped to the exact live narrative well.
  Matching surface colors absorb cropped overflow without exposing a second
  frame.
- Orrery uses a frame-free orbital field behind translucent live regions. Its
  brass mechanisms remain continuous while every actual seam stays DOM-owned.
- Native WebP assets remain sharp at 1080p, 2K, and 4K with no transparency halo,
  watermark, or browser/device frame.

### Copy, icons, states, and accessibility

- App-specific text is real save data rather than placeholder copy.
- Existing Font Awesome controls retain the product's icon family and alignment;
  decorative raster art does not replace semantic controls.
- Focus remains visible, reduced-motion/transparency fallbacks remain intact,
  and the tested controls are keyboard-focusable semantic buttons/inputs.

## Findings

- P0: none.
- P1: none after the frame-ownership correction.
- P2: none after the Orrery ornament re-layering.
- P3: Moonwhite intentionally keeps a quieter brocade relief than its concept
  source so long-form text remains dominant. This does not affect frame
  integration, responsiveness, or material consistency.

## Comparison history

1. Owner evidence exposed a universal P1 structural defect: fixed 16:9 chassis
   rails and responsive DOM borders were both visible, producing mismatched
   frames, clipping, and apparent stretching. The correction removed viewport
   artwork from structural ownership, assigned every seam to its live DOM
   region, and uniformly cropped framed art only inside its owning region.
   Post-fix evidence is the complete reference-pair and responsive matrix above.
2. The first post-fix comparison found one P2 fidelity issue in Orrery: geometry
   was correct, but removing the chassis also made the mechanisms too faint. A
   frame-free orbital field was restored behind translucent live regions. The
   revised `orrery-reference-left-live-right.png`, plus the six Orrery matrix
   captures, shows the ornament restored without any fixed rail or geometry
   regression.

## Verification

- `npm.cmd run test -- --run tests/theme-surface-ownership.test.ts`
- `npm.cmd run test -- --run tests/theme-fonts-invariant.test.ts`
- `npm.cmd run typecheck`
- `npm.cmd run typecheck:vue`
- `npm.cmd run lint`
- `npm.cmd run build`
- Prettier, encoding scan, and `git diff --check` on the changed integration and
  QA files.

No actionable P0, P1, or P2 design mismatch remains in the requested theme
scope.
