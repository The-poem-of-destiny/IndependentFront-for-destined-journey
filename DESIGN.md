# POD UI Design Guide

This guide records owner-approved visual decisions for the IndependentFront game UI. Values here are first-iteration defaults, not immutable rules. Direct user feedback, theme identity, text clarity, and the rendered result always take priority.

## Decision workflow

- Read this guide before starting UI theme work.
- Use cross-theme defaults for the first implementation pass.
- Record a decision only after the user explicitly approves it or clearly asks to make it the new default.
- Mark decisions as cross-theme or theme-specific. Never promote a theme-specific treatment into a general rule.
- Record rejected directions only when they prevent a repeated failure.
- Update the relevant entry instead of appending contradictory rules.

## Cross-theme starting values

### Liquid glass transparency

Status: owner-approved starting standard
Scope: themes and elements that intentionally use liquid glass
Flexibility: tune per theme after browser review; do not enforce mechanically

Use 85% of the previous surface alpha when refining an existing liquid-glass treatment. For a new theme, begin with the Qinghua reference values below and adapt the surface color to the background it covers.

| Role                                  | Starting fill alpha | Starting active alpha |
| ------------------------------------- | ------------------: | --------------------: |
| Lightweight liquid-glass control      |               0.145 |                 0.238 |
| Dense or frosted control              |               0.247 |                 0.315 |
| Liquid-glass container or item ledger |               0.289 |                 0.476 |

Implementation notes:

- Borrow the hue and luminance of the immediate background.
- Treat these as fill values; borders and restrained specular edges may remain more visible to preserve shape and text clarity.
- Reduce decorative gradient alphas by the same 15% during the first pass.
- Accessibility fallbacks may use higher opacity and disable blur.
- Prefer a quieter result over adding more highlights, glow, or shadow.

### Responsive frame ownership

Status: owner-approved structural rule
Scope: every play-area theme at every desktop aspect ratio
Flexibility: materials and ornament may vary; frame ownership may not

- The live DOM region owns its border, inset, corner, divider, and junction. A
  full-viewport raster must never supply structural seams for responsive panels.
- Full-viewport artwork must be frame-free and use uniform `cover` scaling.
  Framed artwork may only be cropped inside the exact live region whose frame it
  depicts.
- Never scale a raster independently on both axes. Use `cover`, `contain`, or one
  constrained axis with the other left `auto`; absorb overflow with a matching
  surface color.
- Qinghua porcelain and Crimson rose window are the structural references: their
  ornament belongs to a live panel, while the responsive layout remains the
  single source of truth for geometry.
- Validate 1920 x 1080, 2560 x 1440, and 3840 x 2160, plus one taller and one
  wider stress viewport before handoff.

## Theme-specific decisions

### Qinghua porcelain

- Structural panels remain almost opaque while liquid-glass controls float above them.
- Current liquid-glass values use the cross-theme starting table above.
- Monochrome blue artwork remains anchored at natural aspect ratio with transparent backgrounds.
- Resource bars use 20% more HSL saturation than the previously muted palette, followed by a 10% relative HSL lightness increase: HP `#b07075`, MP `#4a7ba9`, SP `#6e967c`, and EXP `#b6914e`.

### Crimson rose window

- The established tab treatment uses a continuous stone base and one separate active cap.
- Blood glass is reserved for the chat text treatment unless the user explicitly expands its scope.
- Backpack and character modals use asset-free, gold-framed neutral liquid glass; fixed-size blood-control artwork must not be stretched across their panels or sub-elements.

### Remaining theme identities

Status: owner-approved directions; all eight themes implemented and reference-verified in the real game UI
Scope: the eight themes outside Qinghua porcelain and Crimson rose window
Flexibility: selected references are visual truth; responsive frame ownership remains mandatory

| Theme                         | Mode  | Structural palette                               | Primary accent          |
| ----------------------------- | ----- | ------------------------------------------------ | ----------------------- |
| Wayfarer's Atlas / 远行者舆图 | Light | parchment `#e5d8c2` · folio `#f1e7d5`            | old brass `#8d642f`     |
| Moonwhite Brocade / 月白云锦  | Light | moonwhite `#e9e6df` · silk `#f5f3ed`             | woven gold `#887142`    |
| Jade Conservatory / 翡翠温室  | Light | sage glass `#dce5d7` · botanical paper `#edf2e9` | verdigris `#4c755f`     |
| Aurora Frostglass / 极光霜晶  | Light | frost `#e6ebf2` · crystal `#f1f4f8`              | aurora violet `#725b9b` |
| Gilded Orrery / 玄金星盘      | Dark  | obsidian `#0e1015` · night slate `#090b10`       | antique gold `#c9a85f`  |
| Bronze Mechanism / 古铜机巧   | Dark  | leather `#1b1510` · hammered bronze `#2a2118`    | warm brass `#c48c4b`    |
| Nocturne Sakura / 夜樱漆匣    | Dark  | black lacquer `#120d12` · plum lacquer `#21151f` | pearl pink `#c67998`    |
| Abyssal Cathedral / 深海圣堂  | Dark  | abyss `#07131b` · submerged stone `#0d202b`      | sea glass `#55a7b7`     |

#### Locked implementation directions

| Theme                         | Decision                                  | Reference                                                                   |
| ----------------------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| Wayfarer's Atlas / 远行者舆图 | Full theme: brass navigator's instrument  | `artifacts/theme-looks/wayfarers-atlas/look-4.png`                          |
| Moonwhite Brocade / 月白云锦  | Minimal moonwhite brocade relief          | `artifacts/theme-looks/moonwhite-brocade/look-4.png`                        |
| Jade Conservatory / 翡翠温室  | Full theme: jade-framed herbarium cabinet | `artifacts/theme-looks/jade-conservatory/prototype-4-herbarium-archive.png` |
| Aurora Frostglass / 极光霜晶  | Full theme: boreal aurora wash            | `artifacts/theme-looks/aurora-frostglass/look-2.png`                        |
| Gilded Orrery / 玄金星盘      | Full theme: armillary brass mechanism     | `artifacts/theme-looks/gilded-orrery/look-2.png`                            |
| Bronze Mechanism / 古铜机巧   | Full theme: precision guild instrument    | `artifacts/theme-looks/bronze-mechanism/look-3.png`                         |
| Nocturne Sakura / 夜樱漆匣    | Full theme: moonlit falling petals        | `artifacts/theme-looks/nocturne-sakura/look-5.png`                          |
| Abyssal Cathedral / 深海圣堂  | Full theme: submerged Gothic nave         | `artifacts/theme-looks/abyssal-cathedral/look-2.png`                        |

The detailed visual contracts and rejection criteria are recorded in
`docs/planning/2026-08-08-selected-theme-directions.md`.

For Jade Conservatory, the center narrative surface is a bound parchment folio with jade edge rails and four antique-brass barrel hinges, one near each corner. Tabs and primary controls are polished-jade plaques with stable geometry across inactive, hover, focus, and active states. The composer retains its outer notebook border and parchment field without stretching decorative artwork behind the input. A flat paper-only treatment, open jewelry-like binding rings, repeated hinges down the full rails, and stretched panel rasters are explicitly rejected.
