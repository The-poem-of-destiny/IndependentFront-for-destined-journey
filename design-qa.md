# Crimson Reliquary Material Design QA

## Visual truth

- Left-panel source: `C:\Users\wnc74\AppData\Local\Temp\codex-clipboard-5bcf75d9-0a93-4162-baa0-7d637c2f2007.png`
- Full implementation: `artifacts/crimson-tab-shared-ledger-full.png`
- Left-panel focus: `artifacts/crimson-tab-left-shared-focus.png`
- Right-panel focus: `artifacts/crimson-tab-right-no-cuts-focus.png`
- Full-theme material pass: `artifacts/audit-crimson/04-material-pass.png`
- Liquid-glass ledger correction: `artifacts/audit-crimson/08-liquid-glass-ledgers.png`
- Clear glass with gold frame: `artifacts/audit-crimson/09-clear-gold-glass.png`
- Browser viewport: `1594x1066` CSS px at `devicePixelRatio 1.75`

## Comparison evidence

- Source/left/right comparison: `artifacts/crimson-tab-shared-ledger-comparison.png`
- Full reference/material comparison: `artifacts/audit-crimson/05-reference-material-comparison.png`

## Findings

- No actionable P0, P1, or P2 differences remain for this correction.
- The base ledger contains no pre-cut lines, quarter seams, or inactive-cell borders.
- The left scene tabs and right inventory tabs now share one continuous background asset and one symmetric selected overlay.
- Both components preserve four equal live hit areas without exposing those divisions visually.
- The fixed tab geometry now exposes the source asset's carved stone texture, aged-metal rim, and deep-wine selected surface at runtime.
- NPC ledgers, system notifications, status plaques, inventory rows, command controls, and the avatar reliquary now use the same material hierarchy.
- Quest and expanded inventory ledgers use clear, lightly blurred glass with an aged-gold frame; blood tint appears only on active states.

## Fidelity surfaces

- Geometry: one uninterrupted chamfered slab sits beneath each four-tab group.
- Selection: only the active tab gains the deep-wine symmetric overlay; inactive labels remain on the continuous stone surface.
- Material: matte charcoal stone, deep-wine selected stone, blackened metal, and restrained aged bronze remain consistent across both panels.
- Typography: live CJK labels and the left-panel badge remain centered, legible, and above the selected overlay.
- Asset quality: the continuous strip and selected cap are high-resolution alpha PNG assets rather than CSS-drawn geometry.

## Interaction and runtime checks

- Clicked all four left-panel tabs and all four right-panel tabs.
- Left buttons remained approximately `76.054x38` CSS px at fixed coordinates in every state.
- Right buttons remained `87.143x36` CSS px at fixed coordinates in every state.
- Computed transforms remained `none` for all eight controls.
- Rechecked the left and right tab strips after the material pass; their dimensions and transforms remained unchanged.
- Quest content now has approximately `20.57px` of left and right safe area and is clipped by the ledger rather than escaping it.
- Expanded inventory row and detail widths are both contained by their shared `325.71px` parent ledger, with detail overflow set to `hidden`.
- The shared strip asset is an exact pixel mirror across the horizontal and vertical axes.
- Browser console contained no errors after the final style pass.
- `npm.cmd run typecheck` passed.
- `npm.cmd run build` passed.
- `GamePage.test.ts` passed `7/7` tests.

## Comparison history

### Pass 1

- P1: the inventory base exposed three pre-cut seams even when no tab was selected.
- Fix: regenerated the base as one uninterrupted symmetric stone slab with only a shared outer frame.

### Pass 2

- P1: the left scene tabs still used a flat crimson rectangle and underline, so the two panels had unrelated tab languages.
- Fix: moved the left scene tabs onto the same continuous ledger and symmetric selected-cap system used by inventory.
- Evidence: `artifacts/crimson-tab-shared-ledger-comparison.png`.

final result: passed
