# Selected Theme Directions and Implementation Contracts

Date: 2026-08-08

## Scope

This document locks the owner-selected visual direction for the eight themes outside Qinghua porcelain and Crimson rose window. Six themes receive full material, ornament, interaction, and responsive implementations. Moonwhite Brocade and Abyssal Cathedral deliberately remain minimal token-only fallbacks and are out of implementation scope.

The selected 1440 x 900 concepts are visual source of truth. They preserve the existing game topology: fixed top bar; left tool rail and scene ledger; central narrative and command surface; right status ledger. Implementation may correct generated-text defects and use existing iconography, but it must not reinterpret the material world, simplify the dominant motif away, or change product behavior.

## Cross-theme invariants

- Preserve the current 25/50/25 play-area topology and every existing interaction.
- The narrative field remains the quietest and largest visual region.
- Use one restrained gold or metal seam per theme. Metal is structural; it is not a glow applied indiscriminately to every edge.
- Retain semantic HP, MP, SP, EXP, quality, affection, and status colors.
- Theme-specific treatments belong under the owning `data-theme` selector and must not leak into the two minimal fallbacks, Qinghua porcelain, or Crimson rose window.
- Full themes must cover the top bar, rail, left ledger, central narrative/input, right status ledger, tabs, resource tracks, list rows, hover, keyboard focus, active, expanded, and reduced-transparency states.
- Decoration must sit behind content, ignore pointer input, survive 1440 x 900 and narrow desktop widths, and never clip persistent controls.
- Production assets must be purpose-built for their container, have quiet text zones, and be anchored without two-axis stretching.

## 1. Wayfarer's Atlas / 远行者舆图

Theme ID: `parchment`

Selected reference: `artifacts/theme-looks/wayfarers-atlas/look-4.png`

### Visual thesis

The play area is a precision navigator's instrument laid over a warm vellum chart. It is not merely brown parchment. The identity comes from the union of a large, ghosted circular bearing scale in the narrative field and a rigid old-brass chassis that locks the three ledgers together.

### Material and depth model

- Base field: aged vellum with low-frequency mottling, warm center illumination, and slightly darker handled edges.
- Structure: antique brass, darkened in recesses and brighter only on exposed ridges. Frames use a narrow dark keyline, a fine brass ridge, and a soft inner vellum shadow.
- Central motif: a broad compass/azimuth disc, larger than the visible narrative field, with degree ticks, radial lines, and a pointer arm. It remains faint enough for long Chinese narrative text.
- Controls: inset brass plates rather than glossy pills. The input is a vellum strip seated in a mechanical frame; the send control is a square compass-arrow plate.
- Corners: sparse fasteners and circular instrument joints. Avoid covering all corners with identical filigree.

### Component mapping

- Top bar: continuous measuring rail with restrained tick marks and a centered conversation plate.
- Tool rail: separate brass key plates with recessed icon wells; selected/hover states brighten the inner plate, not the outer chassis.
- Left and right ledgers: vellum sheets inside brass frames. Tabs are shallow instrument selectors with one active inset state.
- Status: resource tracks read as enamel gauges set into vellum; attribute values use small framed cells.
- Narrative: the bearing disc belongs to the background layer and must not move with message content.

### Interaction language

Hover adds a local warm reflection and increases ridge contrast. Active controls depress by shadow inversion without layout movement. Keyboard focus uses a visible brass/ink outline. Expanded ledgers connect through the same inset frame rather than opening a visually unrelated card.

### Acceptance and rejection criteria

Accept only if the central disc is immediately recognizable at first glance, brass reads as aged metal rather than orange borders, and the vellum remains quiet enough for reading. Reject flat beige recolors, loud steampunk gears, repeating corner ornaments, yellow glow, modern rounded cards, or a map motif tiled across every panel.

## 2. Moonwhite Brocade / 月白云锦

Theme ID: `ivory`

Decision: retain the current minimal token-only implementation as a fallback. No new decoration, assets, or interaction language will be added in this phase.

## 3. Jade Conservatory / 翡翠温室

Theme ID: `forest`

Selected reference: `artifacts/theme-looks/jade-conservatory/prototype-4-herbarium-archive.png`

### Visual thesis

The interface is a jade-framed herbarium cabinet inside a quiet conservatory. Warm specimen paper carries the reading surfaces while slim jade rails, tiny brass clips, and sparse pressed-botanical linework provide the structure. The selected direction is archival and tactile rather than scenic or ornate; it must feel like a fantasy botanist's working cabinet, not a mint-colored webpage.

### Material and depth model

- Base: warm cotton specimen paper with almost imperceptible fiber variation and high text contrast.
- Structure: slim celadon-jade label rails and panel seams. Controls use polished, translucent jade with restrained highlights; the outer application shell remains quiet.
- Central motif: a connected botanical archive cabinet built around a bound parchment notebook. Jade edge rails and four antique-brass barrel hinges, one near each corner, frame the narrative center while sparse line-drawn sprigs occupy only quiet margins.
- Metal seam: one aged-brass tone appears as hairline joins, label clips, and selected-state accents.
- Controls: shallow jade specimen labels holding paper inserts. Corners stay nearly square and never become pills.

### Component mapping

- Top bar: a continuous paper-and-jade archive beam with a centered conversation label and one thin brass seam.
- Tool rail: a half-width stack of compact icon-and-text specimen plaques with quiet jade borders. Slimmer frame insets keep every two-character label visible, while the expand/collapse control is omitted. Smaller viewports retain the text-safe rail width. A quiet live-color rail backs the independently framed parchment buttons; no button-scale plaque raster repeats behind the column.
- Scene/status ledgers: warm botanical-paper inserts separated by live jade rails. The default avatar uses a circular herbarium-medallion frame; imported large portraits remain rectangular.
- Tabs: separated polished-jade specimen labels joined by tiny brass clips. Inactive, hover, focus, and active states keep identical geometry; selection changes only luminance, saturation, text weight, and the brass connector.
- Composer: an outer notebook border frames one parchment input field; no decorative panel raster is stretched across the bar. The send control remains a compact polished-jade plaque.
- Resource/attribute blocks: muted inset jade tracks and compact archival cells, preserving semantic bar colors.

### Interaction language

Hover lifts only the inner paper label through a quiet highlight; no control translates or changes size. Active states use a warmer sheet, deeper verdigris stroke, and restrained brass underline. Focus rings remain clearly visible on pale surfaces. Reduced-transparency mode preserves the same paper-and-jade hierarchy without relying on blur.

### Acceptance and rejection criteria

Accept only if the interface reads as one archival cabinet, the paper remains warm and readable, the main message box reads as a bound notebook, the composer keeps a clean parchment field inside its outer frame, the polished jade rails and buttons stay structural, the compact tool rail remains fixed at half width without a collapse control, and every tab position keeps a stable frame. Reject a flat paper-only reskin, mint monochrome, translucent glass everywhere, leafy wallpaper, scrapbook clutter, soft neumorphic blobs, heavy gold, floating modern cards, open jewelry-like binding rings, repeated hinges down the full rails, stretched panel artwork behind the input, repeated or stretched button artwork behind the tool rail, or tabs whose selected state shifts or breaks the brass joins.

## 4. Aurora Frostglass / 极光霜晶

Theme ID: `misty-lilac`

Selected reference: `artifacts/theme-looks/aurora-frostglass/look-2.png`

### Visual thesis

The UI is a frostglass observation window looking onto a boreal mountain valley. A luminous aurora is the singular atmospheric event; the ledgers are quiet translucent ice panes borrowing its blue-violet light. This direction is scenic and expansive, not an all-over white crystal skin.

### Material and depth model

- Scene asset: one wide aurora landscape with a bright upper sky, low mountain horizon, and ample quiet center. It anchors to the narrative field and scales by cover/contain rules without stretching.
- Structural glass: pale blue frostglass with low blur, low-contrast refraction, one fine specular edge, and a restrained cool shadow.
- Aurora color: cyan, lavender, and soft green occur as atmospheric ribbons, never as gradient text or glowing borders around every component.
- Gold seam: an extremely thin warm glint at a few frame joints prevents the palette from becoming sterile.

### Component mapping

- Central narrative: most scenic and least framed region; text sits on a legibility veil that does not erase the landscape.
- Side ledgers: denser frosted panes with consistent borrowed sky hue and enough opacity for AA text.
- Top/rail/input: light glass plates with restrained violet active edges.
- Avatar: an aurora/frost pane rather than an unrelated portrait card.
- Resource tracks: semitransparent channels with clear semantic fills and low glow.

### Interaction language

Hover produces a brief local refraction/specular lift, not a white gradient. Active tabs add a narrow violet/cyan edge and a slightly denser pane. Motion may drift the aurora very slowly when motion is allowed; reduced-motion presents a static scene. Reduced-transparency replaces blur with an opaque sampled-sky fill.

### Acceptance and rejection criteria

Accept only if the aurora landscape owns the first view, side content stays legible, and glass inherits scene color. Reject washed-out white panels, generic purple gradients, glow rings, hard top shines, snowflake wallpaper, stretched mountain imagery, or blur applied to the entire page.

## 5. Gilded Orrery / 玄金星盘

Theme ID: `obsidian`

Selected reference: `artifacts/theme-looks/gilded-orrery/look-2.png`

### Visual thesis

The game surface is an enormous black-stone armillary instrument. Its memorable element is scale: partial brass orbital arcs enter from outside the viewport and imply a mechanism larger than the interface. The look is austere, celestial, and exact, not the existing generic dark-and-gold palette.

### Material and depth model

- Base: cool black obsidian/night slate with subtle mineral variation, never featureless RGB black.
- Structure: narrow antique-gold inlay and aged brass rails. Large orbital arcs are sparse and partially cropped.
- Central motif: faint armillary circles and engraved celestial geometry behind the narrative field. The center remains dark and calm.
- Controls: black enamel/stone plates inside brass frames. White text is avoided; warm parchment text carries hierarchy.
- Depth: a limited three-step hierarchy: base stone, recessed content well, raised brass control.

### Component mapping

- Top bar: thin black beam crossed by one or two oversized orbital arcs; centered conversation label remains primary.
- Tool rail: instrument keys with small gold glyphs and one strong selected plate.
- Left/right ledgers: deeply recessed slate panels with precise brass perimeter lines.
- Status: a celestial chart behind the avatar and clean horizontal gauges; equipment rows stay sparse.
- Input: black writing well with a fine brass housing and compact arrow plate.

### Interaction language

Hover reveals a passing brass reflection along the inner edge. Active state increases inlay brightness and depth but does not add glow. Focus uses a clear dual-tone gold/pale outline. Optional orbit motion must be extremely slow and cease under reduced motion.

### Acceptance and rejection criteria

Accept only if oversized orbital geometry establishes scale, text is comfortably readable, and metal feels physical. Reject generic dark mode with gold 1px borders, dense starfield wallpaper, neon gold, excessive gears, brown leather, or every component receiving the same framed-card treatment.

## 6. Bronze Mechanism / 古铜机巧

Theme ID: `bronze`

Selected reference: `artifacts/theme-looks/bronze-mechanism/look-3.png`

### Visual thesis

The interface is a precision guild instrument built from dark tooled leather, warm brass rails, and measured mechanical fittings. Compared with Gilded Orrery, it is workshop-made, tactile, compact, and warmer. Its identity is disciplined panel engineering rather than decorative gears.

### Material and depth model

- Base: near-black brown leather with fine grain and subtle wear at contact edges.
- Structure: machined warm brass with narrow ridges, recessed dark channels, screws only at credible joints, and no orange glow.
- Central motif: one understated precision dial/reticle in the narrative well.
- Controls: inset leather plates and brass housings with rounded-square mechanical corners.
- Depth: panels feel screwed into one chassis. Seams align across top bar, ledgers, input, and status.

### Component mapping

- Top bar: compact brass-rimmed plaques with a central title plate.
- Tool rail: vertically stacked mechanical key housings and a distinctive round instrument cap at the end.
- Scene/status: leather panels framed by machined brass; internal section dividers read as functional rails.
- Tabs: small instrument selectors with a recessed active state and an amber indicator line.
- Resources: enamel gauges seated inside leather; attribute cells resemble labeled instrument readouts.

### Interaction language

Hover adds a warm moving reflection to the inner metal ridge and slightly lifts the leather plate. Active reverses the bevel and intensifies the amber indicator. Focus stays explicit and rectangular. No interaction changes outer chassis dimensions.

### Acceptance and rejection criteria

Accept only if leather grain, machined brass, aligned chassis seams, and precision-dial identity are all visible. Reject steampunk clutter, loose gear wallpaper, generic brown cards, overly ornate Victorian filigree, bright copper-orange edges, or visual convergence with the black/celestial Gilded Orrery.

## 7. Nocturne Sakura / 夜樱漆匣

Theme ID: `sakura`

Selected reference: `artifacts/theme-looks/nocturne-sakura/refinement-2026-08-10/hybrid-makie-raden-polished-final.png`

### Visual thesis

The UI is a black-lacquer writing casket under moonlight. Pearl-pink blossom inlay and a restrained fall of petals soften the structure while a cool indigo light pool opens the narrative center. It is elegant and nocturnal, not a pink reskin.

### Material and depth model

- Base: deep black/plum lacquer with controlled satin-to-gloss response and faint violet undertone.
- Central light: a subtle moonlit indigo vignette from the upper center, creating a reading pool without becoming a gradient decoration on every surface.
- Ornament: sparse mother-of-pearl raden blossom inlay, concentrated in one asymmetric lower-left branch, two short narrative-frame corner caps, and one upper-right portrait flourish. Empty black space is essential.
- Structure: smoky lacquer frame lines with muted rose inner edges. Maki-e gold powder appears only at a few authored junctions inside the raster accents; it never becomes a continuous border.
- Controls: lacquer plates with pearl-pink type/indicator details; active elements may use mother-of-pearl color shift without glow.

### Component mapping

- Top bar: nearly black lacquer with a centered raden seal and quiet smoke-metal rules; no gold band.
- Tool rail: muted plum plates; the adjacent left ledger owns the strongest lower-left raden branch cluster.
- Central narrative: a clean, matte indigo-black field. Message copy has no tinted card fill, petals, wallpaper, or decorative art behind it; small shell caps belong only to the outer frame corners.
- Right status: plum avatar panel with one upper-right raden flourish and pink-accented resource housing.
- Input: connected lacquer writing tray with a pearl-pink send control.

### Interaction language

Hover reveals a narrow lacquer reflection and gently brightens the pearl accent. Active tabs use a precise pink underline/inlay, never a filled pink rectangle. The approved direction has no drifting petals in the message field. Focus uses a pale pearl outline visible on black.

### Acceptance and rejection criteria

Accept only if lacquer depth, a clean moonlit message field, negative space, frame-owned mother-of-pearl inlay, and rare maki-e powder junctions are unmistakable. Reject magenta UI chrome, blossom wallpaper, petals or decorative art behind message copy, generic sakura clip-art, pink glow, over-bright text, branches crossing interactive content, continuous gold bands, repeated gold borders, glitter fields, or ornament dense enough to resemble the bronze themes.

## 8. Abyssal Cathedral / 深海圣堂

Theme ID: `ocean`

Decision: retain the current minimal token-only implementation as a fallback. No new decoration, assets, or interaction language will be added in this phase.

## Review protocol

Each full theme follows the same acceptance loop:

1. Implement the complete selected material system in the owning theme stylesheet and asset directory.
2. Render the real game UI at 1440 x 900 in the same play state as the concept.
3. Compare source and implementation at equal dimensions, including focused crops for top/rail, narrative/input, and status ledger.
4. Root reviewer returns either `accepted` or `rework`, with concrete discrepancies in palette, composition, depth, material, border language, decoration scale, interaction states, and responsiveness.
5. Rejected themes return to the owning implementation agent. Acceptance requires no remaining P0/P1/P2 fidelity findings.
