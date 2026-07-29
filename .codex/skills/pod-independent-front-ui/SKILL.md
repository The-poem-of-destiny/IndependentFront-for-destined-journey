---
name: pod-independent-front-ui
description: Design, implement, and visually verify the IndependentFront play-area UI as a polished role-playing game interface. Use for POD game-page themes, panels, ledgers, tabs, buttons, material treatments, generated theme assets, responsive artwork, hover or expanded states, and visual QA in src/ui. Treat the product as a decorated game application rather than a webpage or RP Terminal card; do not use rpt-card-ui.
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
- Prefer the live browser, current code, and supplied references over stale design documents.
- Do not add decorative layers the user did not request.

## Work from evidence

Before editing:

1. Open the current game state in the in-app browser.
2. Capture the full play area and any supplied reference at comparable scale.
3. Inspect the target element, its parent, pseudo-elements, computed background, border, overflow, and hover or active rules.
4. Identify which layer owns each visible surface:
   - page background;
   - structural panel;
   - decorative asset;
   - content ledger;
   - interaction state.
5. Record the user's locked decisions and the one element currently allowed to change.

Do not diagnose material quality from CSS alone. Inspect the rendered result.

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

### Frosted or liquid glass

- Borrow the hue and luminance of the surface behind the glass.
- Use low blur, low-contrast refraction, one restrained specular edge, and a quiet shadow.
- Avoid white gradients, multiple glow rings, hard top shines, and excessive translucency.
- Apply glass only to the named layer. Do not spread a successful control treatment to entire panels without approval.

## Construct tab strips as one object

Treat a tab strip as one continuous stone ledger:

- render one uninterrupted base frame;
- place all inactive labels directly on that base;
- render one separate, horizontally symmetric active cap above the selected slot;
- keep slot widths stable;
- change selection without translating, scaling, or reshaping the strip;
- let the active cap separate visually through material, light, and depth;
- do not draw pre-cut seams between inactive tabs;
- do not give every tab the active cap shape.

Use separate base-strip and active-cap assets when texture is required. Never bake every possible selected state into a stretched strip.

## Make assets production-aware

Before generating an asset, specify:

- its actual container aspect ratio;
- camera angle;
- anchoring corner;
- quiet zones reserved for text;
- whether it is fixed, tiled, or stretchable;
- transparent background requirement;
- the exact palette of its neighboring panel.

After generation:

1. Inspect the asset at native dimensions.
2. Verify alpha at corners and remove white matte contamination.
3. Reject baked text, baked shadows outside the intended bounds, asymmetry, and repeating edge ornaments.
4. Embed only the chosen production asset, while keeping explorations outside runtime imports.

For responsive decoration, anchor artwork to the appropriate parent and preserve its natural aspect ratio. Use `background-position` with `background-size: auto 100%`, `contain`, or a fixed material scale instead of stretching both axes.

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
- Ensure an expanded ledger and its dropdown read as one connected element.
- Keep badges clear of dividers and decorative lines.
- Verify frame brightness on normal, hover, active, expanded, and collapsed states.
- Preserve status-bar semantic colors while adjusting saturation and luminance to the theme.

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
- expanded and collapsed side panels;
- each tab selected;
- hover and keyboard-focus states;
- collapsed and expanded ledgers;
- long Chinese text and badges;
- scrolling and panel edges;
- normal and reduced-transparency modes;
- asset anchoring without stretching;
- browser console warnings and errors.

Run the production build after visual verification. Report only what was actually inspected and passed.
