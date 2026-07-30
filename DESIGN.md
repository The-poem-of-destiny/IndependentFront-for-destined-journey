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

| Role | Starting fill alpha | Starting active alpha |
| --- | ---: | ---: |
| Lightweight liquid-glass control | 0.145 | 0.238 |
| Dense or frosted control | 0.247 | 0.315 |
| Liquid-glass container or item ledger | 0.289 | 0.476 |

Implementation notes:

- Borrow the hue and luminance of the immediate background.
- Treat these as fill values; borders and restrained specular edges may remain more visible to preserve shape and text clarity.
- Reduce decorative gradient alphas by the same 15% during the first pass.
- Accessibility fallbacks may use higher opacity and disable blur.
- Prefer a quieter result over adding more highlights, glow, or shadow.

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
