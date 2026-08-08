# Magic Circle Standalone - Design QA

## Evidence

- Reference: `tmp/magic-circle-qa/reference.png` (`1672 x 941`)
- Implementation: `tmp/magic-circle-qa/more-particles-glow-wide.png` (`1600 x 1000`)
- Responsive evidence: `tmp/magic-circle-qa/more-particles-glow-portrait.png` (`900 x 1200`)
- Control evidence: `tmp/magic-circle-qa/glow-dials-wide.png` (`1440 x 900`)
- Responsive control evidence: `tmp/magic-circle-qa/glow-dials-portrait.png` (`720 x 980`)
- Channel isolation evidence: `tmp/magic-circle-qa/glow-dials-extremes.png` (`1440 x 900`, runes 200%, rims 0%)
- Responsive glow evidence: `tmp/magic-circle-qa/glow-radius-final-wide.png` (`1440 x 900`) and `tmp/magic-circle-qa/glow-radius-final-narrow.png` (`720 x 980`)
- Random rune evidence: `tmp/magic-circle-qa/random-runes-wide-a.png` and `tmp/magic-circle-qa/random-runes-wide-b.png` (`1280 x 720`, two states 4.2 seconds apart)
- Premium rune evidence: `tmp/magic-circle-qa/premium-runes-wide-a.png` and `tmp/magic-circle-qa/premium-runes-wide-b.png` (`1280 x 720`, two traveling-highlight states 1.15 seconds apart)
- Runtime: `src/ui/components/home/MagicCircle.standalone.html`
- Open the file directly in a browser. Serving it through the project's Vite dev server fails
  with a 500: Vite rewrites the inline module and ignores the page's own importmap, so the
  `three` bare specifier does not resolve. The file is a standalone study, not a Vite entry.
- Captured state: autonomous animation after approximately 3 seconds with the glow controls at the then-current 100% neutral baseline and tested extremes

## Simplification outcome

- Composition: the full astrolabe occupies the same shallow oblique ellipse, uses a long-lens perspective, and keeps the aperture aligned with the supplied reference.
- Hierarchy: four broad engraved registers, a separate guardian filigree layer, cardinal sigils, black aperture, and sparse void atmosphere.
- Rim budget: five visible metallic rims total: one outer crown, three register rails, and one aperture rim.
- Finish: the annular slab and crystalline sidewall remain absent. Smoke-bronze and moon-silver rims now combine physical metal, emissive cores held below their former ceiling, a light that travels the full circumference and carries most of the rim's brightness, close additive halos, and restrained bloom. Rune spill, cardinal sigils, central filigree, aperture ticks, and rim halos compensate from the camera's projected pixels-per-world so their apparent radius stays stable as the composition refits.
- Motion: all four registers retain independent direction, speed, phase, height, and restrained vertical drift. Filigree, sigils, patina, aperture ticks, stars, and glints keep separate motion tracks. A single authored radial surge periodically travels through the particle field, tangent-aligned orbital streaks, rim veins, aperture light, and bloom. Each register charges one randomly selected rune at a time; the complete engraving eases into a bronze or silver radiance with a pale-metal edge, then fades without segment flashing.
- Constraint: no raster, SVG, model, video, or other visual asset is loaded at runtime. Geometry, CanvasTextures, particles, and shaders are generated in the standalone file.

## Iteration history

1. Pass 1 exposed an exaggerated short-lens perspective, a reflective gray aperture, clipped near edge, broad white glare, sparse inscriptions, and flat repeated geometry.
2. The correction moved to a long-lens camera, matched the reference viewport, made the aperture truly black, replaced broad reflections with black-glass shaders, increased inscription density, and reconstructed the central wreath outside the aperture mask.
3. The finish pass added real annular sidewalls, a separate inner register with geometric ticks, irregular rune wear, crystal rim facets, procedural glints, and restrained bloom. Desktop and portrait renders show no cropping or non-uniform scaling.
4. The distillation pass consolidated fourteen narrow registers into four broad bands and removed inner rails, hairlines, stacked outer lips, full-circle texture strokes, filigree guide circles, and the second aperture rim.
5. The floating-light pass removed every solid annular support and the remaining sidewall while preserving the approved pattern geometry. Existing rims and rune textures gained controlled bronze and silver inner radiance without adding sparks or ornament.
6. The bounded polish loop added soft rune scatter, a transparent violet atmospheric underlight, and slowly orbiting warm/cool illumination. The final hierarchy grades energy inward so the aperture leads without changing the four registers or five-rim budget.
7. The glow-strength pass increased emissive energy, halo width, optical rune scatter, localized hot-vein intensity, and restrained bloom while reducing the already sparse glints. Engraving cores remain legible at both verified sizes.
8. The spectacle pass added one GPU particle draw call containing subdued orbital dust, brighter bronze/silver motes at the existing five radii, and a violet-silver stream rising around the aperture. Particles use real height and depth testing; the radial surge briefly intensifies them and the existing glow system without changing any approved pattern geometry.
9. The energy-density pass increased the structured particle field to 620 motes, added 72 instanced tangent-aligned streaks on the same five radii, strengthened rune scatter, and gave the cardinal sigils, central filigree, and aperture ticks independent additive halos. Wide and portrait renders preserve the approved geometry and show no clipping or runtime errors.
10. The tuning pass added two compact 0-200% radial controls. Runes scales letter, sigil, filigree, and aperture-tick halos; Rims independently scales emissive cores, additive rim halos, traveling veins, and the aperture light. Pointer, wheel, arrow, Home/End, and Reset paths share one value pipeline, while 100% remains the neutral calibration baseline.
11. The responsive-glow correction replaced viewport-relative object-space spread with projection-compensated texture blur and rim-halo geometry. A repeated screenshot falloff probe improved the outer glow from 18 px versus 6 px (3.0x) to 16 px versus 15 px (1.07x) at 1440x900 and 720x980; the remaining pixel is raster rounding.
12. The owner-set presentation defaults now start and reset Runes at 180% and Rims at 160%; Reset reads each control's declared default so the two channels retain their distinct values.
13. The random-rune pass added one glyph-only mask and one shader overlay per register. Deterministic per-glyph clocks asynchronously select sparse runes, give them a fast white-hot ignition and slow colored decay, and remain coupled to the Runes dial. The animation adds four draw calls without rebuilding canvases or creating per-rune scene objects each frame.
14. The premium-material correction removed the rejected flat-white, many-at-once pulse. Each mask now encodes an exact glyph ID so selection cannot fall between filtered symbols; every ring chooses one primary rune, occasionally favoring a larger major glyph. A radial highlight traverses the engraving in either direction, revealing a tempered bronze/silver charge behind it while edge sampling keeps the cut profile sharp. The Runes dial still scales the complete effect and 0% disables it.
15. The rune-flicker correction enabled mipmapped anisotropic sampling for the rotating glyph mask and removed the narrow radial hot front that made disconnected strokes pop as it crossed them. The selected rune now charges as one eased engraved-metal surface. A 70-frame on/off browser probe reduced the illuminated-layer frame-jump ratio from 1.78x to 1.39x against a 1.45x limit.

16. The rune-flicker root-cause pass replaced the sampled glyph index with an analytic one. The
    mask encoded the index in its red channel and the shader decoded it through linear,
    mipmapped, anisotropic filtering before a hard threshold: neighbouring indices blended into
    each other, minification averaged whole runs of them into noise, and the unpremultiply
    divide lost the index outright on antialiased edges. The index is now derived from the pixel
    angle, which is exact because every glyph is laid at `(glyphIndex / glyphCount) * TAU`, and
    the mask carries shape only. Two offscreen WebGL2 probes drove the shipping fragment shader
    for 70 frames while the register turned 0.2 px: selection toggling fell from 89.6% of lit
    pixels per frame to 2.3%, and mean frame-to-frame brightness change fell from 90.2% to 5.0%
    (worst frame 92.3% to 8.8%). Lit area rose from 62 to 79 arbitrary units, because the old
    decode was also dropping edge pixels of the very glyph it was charging. A centroid check
    confirmed the analytic index lands on the intended glyph: 33.02, 40.01 and 6.90 for targets
    33, 40 and 7.

17. The rune-uniformity pass replaced the engraving's edge measure. `interior` was an erosion of
    the mask by four taps at a fixed base-level texel offset, subtracted from a `glyphAlpha`
    that arrives through the mipmap and anisotropic chain; the two measured the mask at
    different scales, so their difference was largely filter noise. That noise drove the
    colour, the hot vein and the alpha together, so a charging rune read as a mottled, speckled
    outline rather than an evenly lit engraving. Core and rim are now both pure functions of
    the sampled coverage. Measured against the shipping shader in the real scene, on the outer
    register with the ignition layer isolated: local roughness inside the glyph body fell from
    3.50% to 1.94% at 1280x720 and from 3.25% to 2.03% at 1920x1080; solid interior pixels rose
    from 145 to 163 and from 477 to 525, the strokes having stopped reading as hollow outlines;
    and the red-to-blue ratio rose from 1.20 to 1.75, the charge holding bronze instead of
    washing toward white. A screen-space-derivative variant was built and rejected: `fwidth`
    quantises to the 2x2 shading quad and scattered visible dots through the glyph interior.

18. The far plane now follows the framing solve. `resize()` backs the camera off to fit the
    disc's width, so the distance grows without bound as the viewport narrows, but `camera.far`
    was fixed at 100 — chosen to clear the default landscape distance of 34.2 with the 48-unit
    nebula dome behind it, and never revisited. Three thresholds were measured against the live
    scene. Below about 1.13:1 the dome's back fell outside the frustum and the violet backdrop
    was replaced by black, which covers every portrait render in the evidence above, including
    the 900x1200 and 720x980 shots this document cites as passing. Below 0.60 the disc's own far
    edge was clipped. Below 0.585 the camera itself sat beyond the far plane and the frame was
    bare starfield. `camera.far` is now `distance + BACKDROP_RADIUS * 1.08`, and the dome is
    built from that same `BACKDROP_RADIUS`, so the two cannot drift apart again. Verified across
    aspects from 1.78 down to 0.55: nothing clipped at any of them, and 900x1200, 600x1000,
    560x1000 and 360x900 render the complete astrolabe over the full backdrop. The near plane
    was deliberately left at 0.08 — depth precision here is set by near, not far, so widening
    far costs nothing, and moving near would redistribute precision across layers that are
    currently stable.

19. The rim flow pass. The energy vein already described itself as travelling, but its pattern
    advanced one revolution per 159 seconds, roughly 1.5 degrees per second, which is below the
    threshold at which motion reads at all — the layer rendered as three stationary hot spots.
    It is now an asymmetric pulse: a hard front with an exponential wake, because a symmetric
    lobe reads as a bump swelling in place rather than as light moving through a tube. Every rim
    runs at the same linear speed, 3.99 world units per second, so the period grows with the
    radius — 8.00 s on the outer crown down to 1.50 s on the aperture rim — and the five rims
    read as one substance moving through the structure instead of five independent turntables.
    Each rim's direction is inherited from the register it rides, so the flow reinforces the
    alternation the composition already had rather than competing with it; the crown and the
    aperture rim, which ride nothing, open and close that alternation.

    The change that made it visible at all is the rebalance, not the shader. A chase at 4x gain
    over the untouched rim was indistinguishable from no chase: a highlight cannot be added to
    something already at its ceiling. The constant layers therefore step back — core to 0.62,
    halo to 0.68 — and the traveling light carries the difference at 3x. This also recovered
    something that was already broken and unnoticed: the scene's own authored surge, a roughly
    40-second event, was lifting the frame mean by 5.0%, which is imperceptible. Against the
    rebalanced base the same surge lifts it by 43.4%. The piece had been running with no
    headroom left for its own rhythm.

    Three candidates were rendered before choosing. The rejected strong variant (core 0.30,
    halo 0.45, 6 s) reads well but redefines the rims as dark tubes with light inside them,
    which is a different object from the one this document describes. The shipped values were
    verified from the file itself: linear speed identical across all five rims, directions
    alternating, no GL errors, and rest and surge means within 1% of the approved prototype.

20. The bloom modernization, from owner feedback that the glow read as period CGI.
    UnrealBloomPass was replaced with a custom mip-chain pass in the file: 13-tap downsample
    with a Karis average on the first level, 3x3 tent upsample accumulating through the
    pyramid, half-float targets, six levels at 1600x1000. The three properties of the old
    pass that produced the dated look are each addressed at the cause: the hard luminance
    threshold (highlights popping in and out of the halo) is gone entirely — everything
    scatters as in a real lens; the five fixed gaussian levels (visible banding rings) became
    a progressive pyramid; the additive composite (bright cores washing to flat white) became
    the energy-conserving mix(scene, bloom, strength), normalized by the pyramid's scalar sum
    so radius changes reshape the halo without changing its energy. animate() keeps driving
    `strength`/`radius`, but on new scales: rest scatter ~0.15 at the shipped dials. The
    duplicate CSS-pixel bloom.setSize in resize() was removed with the pass that needed it.

21. The atmosphere pass. The dome was a single violet FBM and the grade vignette took 48% off
    the corners, so the frame read as a disc floating in vacuum. A slow large-scale hue field
    now drifts parts of the cloud toward teal and pockets toward ember; dim aurora curtains
    with their own faster clock sit just above the horizon; the stars scintillate ±22% on
    deterministic per-star phases derived from position; the vignette eased to 40% starting
    further out. All accents were kept below the violet's level so the astrolabe keeps the
    colour lead.

22. The ignition-presence pass, from owner feedback that the charging runes went unseen. Three
    additions, none touching the analytic-index or coverage-function invariants of passes 16
    and 17: a short white-hot pop at the moment the charge lands (the eased envelope alone
    started too gently for the eye to catch); a surge-coupled chain — while the authored surge
    passes, an arc of about two glyph cells sweeps each register, direction and phase seeded
    per layer so the four registers hand the wave around rather than firing in lockstep, and
    the term is exactly zero outside the surge; and a cadence tightened from 5.1+0.83i to
    4.2+0.66i seconds per event. The no-threshold bloom of pass 20 also gives every lit rune
    the soft halo the old thresholded pass denied it.

23. The interaction pass, all three owner-requested. (a) A 30fps render cap: the piece is a
    slow ambient animation and the uncapped loop ran laptop GPUs hot for no visible gain;
    scene time still reads the wall clock so the cap changes smoothness only, never tempo.
    Verified with a draw-call probe in the live page: exactly 60 rendered frames per 240
    display ticks on a 120Hz screen. (b) Three new dials on the existing 0-200% pipeline —
    Bloom (scatter strength), Particles (motes, streaks, glints), Sky (nebula, aurora,
    stars; the base floor stays so 0% reads as clear night, not a hole). Verified live: Sky
    0% extinguishes the backdrop, Bloom 200% visibly widens halation, Reset returns all five
    dials to their declared defaults. (c) An experimental drag orbit: elevation only, azimuth
    and distance fixed, so dragging never zooms. The ceiling is viewport-dependent — the
    framing solve fits the disc's width, and the projected height grows with sin(elevation),
    so a wide aspect caps the climb lower; the walk-down predicate mirrors the solve and the
    shipped default always stays reachable. The screen-space glow compensation reruns on
    every pose change, or halo radii would drift with elevation.

## Findings

- P0: none.
- P1: one escaped defect, reported by the owner after pass 15 and fixed in pass 16 — the runes
  flickered while charging. Pass 15 measured the symptom and answered it by tightening the
  filtering, which lowered the measured frame-jump ratio while making the underlying decode
  worse. 1.39x against a 1.45x limit was a symptom squeezed under a threshold, not a cause
  removed. A discrete index must never be read through a filter built for continuous data.
- P1: a second escaped defect from the same family, reported by the owner and fixed in pass 17 —
  the charge was mottled and dotted. Both P1s are one mistake made twice: reading the mask at a
  scale the sampler is not using. Pass 14 did it with the glyph index, the original engraving
  shading did it with the edge taps.
- P2: the fixed far plane truncated the framing solve at every aspect narrower than about
  1.13:1, including every portrait render in the evidence above. Fixed in pass 18.
- Browser console after final desktop and portrait reloads: no errors or warnings.
- Reduced motion freezes the scene at a deterministic authored frame.

final result: passed. Passes 16 and 17 were verified from real rendered frames of this scene —
the file loaded, its own shaders compiled, and frames stepped one at a time with the ignition
layer isolated so its pixels could be read directly. What has not happened is watching it
animate: the harness drives frames by hand because `requestAnimationFrame` does not fire in it,
so motion over time is inferred from stepped frames rather than observed.

Passes 20-22 were verified differently: the file ran live in a real browser with
`requestAnimationFrame` firing, sampled by screenshot at rest, mid-surge (chain wave observed
travelling the outer register) and after the surge (single-rune cadence restored), at 800x681
and 420x800. Console clean at both aspects; the portrait far-plane fix of pass 18 held. No
per-pixel numeric probes were run this round — the judgements are visual, from live frames.
