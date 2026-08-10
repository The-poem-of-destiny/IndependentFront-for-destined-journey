---
name: pod-independent-front-ui
description: Design, implement, reference-match, and visually verify the IndependentFront play-area UI as a polished role-playing game interface. Use for POD game-page themes, screenshot-driven iteration, panels, bound message surfaces, ledgers, tab geometry, buttons, material-layer audits, generated theme assets, responsive artwork, interaction states, and visual QA in src/ui. Treat the product as a decorated game application rather than a webpage or RP Terminal card; do not use rpt-card-ui.
---

# POD Independent Front UI

Build theme work from the live game surface outward. Preserve the shared play-area layout while giving each theme its own material, central motif, decoration, lighting, and interaction language.

## Non-negotiable principles

- Treat the interface as a game object assembled from designed materials, not a recolored webpage.
- Keep the layout identical across themes unless the user explicitly changes it.
- Give each theme one central visual element and a consistent surface language.
- Carry a restrained gold inlay through every theme as the seam of fate.
- Keep text clarity above decoration, transparency, lighting, and texture.
- Preserve every accepted decision. Do not reopen a settled panel, theme, or interaction without instruction.
- Read `docs/design.md` before writing UI code. Follow its typography, spacing, component, decoration, motion, and accessibility contracts.
- Read the repository-root `DESIGN.md` before theme work and use its accepted values as first-iteration defaults.
- Prefer the live browser, current code, the local design guide, and supplied references over stale design documents.
- Do not add decorative layers the user did not request.

## Work from evidence

Before editing:

1. Read `docs/design.md` and `DESIGN.md`; identify the shared UI rules, cross-theme defaults, and theme-specific decisions.
2. Open the current game state in the in-app browser.
3. Capture the full play area, a focused crop of the reported element, and any supplied reference at comparable scale.
4. Inspect the target element, its parent, pseudo-elements, computed background, border, overflow, and hover or active rules.
5. Identify which layer owns each visible surface:
   - page background;
   - structural panel;
   - decorative asset;
   - content ledger;
   - interaction state.
6. Record the user's locked decisions and the one element currently allowed to change.

Do not diagnose material quality from CSS alone. Inspect the rendered result.

## Run a controlled reference-matching loop

Keep each iteration attributable:

1. Fix the viewport, zoom, content state, expanded panels, selected tabs, and scroll origins.
2. Name one visible mismatch and the layer that owns it.
3. Change only that layer.
4. Wait for the live update, then inspect its computed material properties and `DOMRect`.
5. Capture both the full view and a focused crop; compare them with the same reference region.
6. Continue until the requested property matches or the evidence shows that the construction model must change.

Do not compare states with different scroll positions and call the resulting movement a tab-layout defect. When the user requests an exact match, prioritize silhouette, material hierarchy, landmark spacing, and scale before small decorative texture differences.

## Choose the correct level of change

Test a direction on one representative element before spreading it across the theme. Apply it globally only after the pilot is accepted.

Evaluate visual problems in this order:

1. palette and brightness;
2. composition and scale;
3. depth hierarchy;
4. material response;
5. borders, shadows, and highlights;
6. decoration.

Do not keep tuning shadows when the palette or composition is wrong.

## Maintain the local design guide

Treat `DESIGN.md` as the source of truth for owner-approved visual starting values.

- Record explicit user decisions and clearly accepted defaults after implementation.
- Label every entry as cross-theme or theme-specific.
- Include scope, starting values, flexibility, and any important exception.
- Keep values advisory. User-directed refinement and rendered quality override the guide.
- Do not record transient experiments or infer approval from silence.
- Update an existing decision when it changes instead of leaving conflicting instructions.
- Never generalize a theme-specific construction into a universal rule.

## Build a material stack

Define these properties before implementation:

- base palette and text contrast;
- central motif;
- structural material;
- interactive material;
- transparency range;
- lighting direction and softness;
- shadow depth;
- gold color and thickness;
- quiet or bold decoration budget.

Use one token for shared gold borders and inlays within a theme. Avoid several unrelated golds.

Treat compound controls as separate material owners. A composer, for example, may have an outer frame, a bar backing, a parchment field, and a compact action button. Even on one element, `background-color`, a decorative `background-image`, and `border-image` may serve different roles. Removing an inner asset means removing only that decorative image unless the user also rejects the neutral backing. Removing or changing one owner must not silently replace the others.

### Qinghua porcelain

- Use warm porcelain white and desaturated cobalt matching the existing panels.
- Keep panels almost opaque. Convey glaze with broad, soft transmitted light and restrained semi-transparency.
- Avoid thick bevels, hard inner shadows, stacked highlights, or glossy pills; they read as plastic.
- Use monochrome blue landscape, bird, flower, or branch art with generous quiet areas.
- Keep gold to a single deliberate kintsugi-like line where requested.

### Crimson rose window

- Build depth with distinct stone, gold, blood gem, rose, and glass layers.
- Keep the scene lighter and more legible than near-black mockups.
- Use clear glass for shared information surfaces and deep red blood glass only where requested.
- Keep outer stone frames visually stationary; let the inner gem or light respond.
- Use roses and petals as dimensional objects, not merely a wallpaper.
- For the established crimson tab treatment only, preserve its continuous stone base with inactive labels integrated into the strip and one symmetric active cap separated by light and depth.

### Frosted or liquid glass

- Borrow the hue and luminance of the surface behind the glass.
- Use low blur, low-contrast refraction, one restrained specular edge, and a quiet shadow.
- Avoid white gradients, multiple glow rings, hard top shines, and excessive translucency.
- Apply glass only to the named layer. Do not spread a successful control treatment to entire panels without approval.

## Design tab strips from the theme

Do not prescribe one tab construction across themes. Derive the strip material, silhouette, separation, and selected state from the current theme's accepted visual language and reference.

- Keep dimensions stable across selection states unless movement is an explicit part of that theme.
- Give base, inactive, hover, and selected states clear layer ownership.
- Use consistent tab anatomy within one theme without copying it into other themes.
- Avoid accidental layout shifts, text overflow, or state-dependent frame loss.
- Verify every selectable position rather than judging only the first active tab.
- At wide and narrow viewports, click every tab and compare x, y, width, and height against a baseline taken at the same scroll origin. Also check row overflow.
- For stationary tabs, keep margin, padding, border width, dimensions, and transform out of active-state rules. Change paint, text weight, light, or a separately owned connector instead.

## Make assets production-aware

Before generating an asset, specify:

- its actual container aspect ratio;
- camera angle;
- anchoring corner;
- quiet zones reserved for text;
- whether it is fixed, tiled, or stretchable;
- transparent background requirement;
- the exact palette of its neighboring panel.

Treat the intended asset role as a contract. Button-scale plaques stay on button-scale controls; fasteners stay near structural seams; a full-width panel needs a tile, clean stretch zone, live CSS center, or nine-slice frame designed for that width. Audit every `background-size: 100% 100%` against the source aspect ratio and intended role.

After generation:

1. Inspect the asset at native dimensions.
2. Verify alpha at corners and remove white matte contamination.
3. Reject baked text, baked shadows outside the intended bounds, asymmetry, and repeating edge ornaments.
4. Embed only the chosen production asset, while keeping explorations outside runtime imports.

For responsive decoration, anchor artwork to the appropriate parent and preserve its natural aspect ratio. Use `background-position` with `background-size: auto 100%`, `contain`, or a fixed material scale instead of stretching both axes.

Treat decoration count and placement as composition, not polish. Put hinges, clasps, and fasteners where the represented object would carry load, usually near corners or seams. If the user says a motif is excessive, reduce instances and retain the strongest anchors; do not merely shrink, fade, or replace them with an unapproved motif.

For stretchable ornate panels, decompose the visual:

- fixed left cap;
- repeatable or CSS-built center;
- fixed right cap;
- optional tileable gem fill;
- independent gold line.

Use nine-slice or `border-image` only when the source was designed with clean, non-repeating stretch zones. Never stretch a fully rendered ornate panel.

## Prevent layer and interaction bugs

- Avoid `background:` shorthand in hover rules when the base uses background images; it silently removes them.
- Keep hover treatment on the inner interactive layer, not the outer stone frame.
- Check for leftover pseudo-elements, tinted rectangles, glass overlays, borders, and dividers after changing direction.
- When a stretched or unnecessary inner layer is rejected, remove that exact decorative image or pseudo-element. Preserve an accepted neutral backing color, outer `border-image`, content texture, and adjacent control unless the user rejects those too.
- Ensure an expanded ledger and its dropdown read as one connected element.
- Keep badges clear of dividers and decorative lines.
- Verify frame brightness on normal, hover, active, expanded, and collapsed states.
- Preserve status-bar semantic colors while adjusting saturation and luminance to the theme.
- Add focused source-level regression tests for fragile visual contracts: stable active-tab geometry, decoration count and positions, material-token ownership, and forbidden use of a button asset as a panel background.

## Failure brake

If the user rejects the same visual property twice:

1. Stop adding CSS tweaks.
2. Capture the current element and the reference at the same zoom.
3. List concrete mismatches in palette, silhouette, depth, scale, material, and interaction.
4. Remove the failed layer instead of stacking another effect over it.
5. Change the underlying construction model before trying again.

Treat "cheap," "plastic," or "nothing like the reference" as evidence that the material model is wrong, not as a request for more glow or shadow.

## Verification matrix

Before declaring completion, inspect:

- wide and narrow application widths;
- full-view and focused reference comparisons at fixed state and scale;
- expanded and collapsed side panels;
- each tab selected;
- hover and keyboard-focus states;
- collapsed and expanded ledgers;
- long Chinese text and badges;
- scrolling and panel edges;
- normal and reduced-transparency modes;
- asset anchoring without stretching;
- browser console warnings and errors.

Run the focused tests, typechecks, lint, and production build after visual verification. For load-bearing visual decisions, record the evidence paths and update `DESIGN.md` or the existing design-QA record. Report only what was actually inspected and passed.
