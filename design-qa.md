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
- Captured state: autonomous animation after approximately 3 seconds with the glow controls at the then-current 100% neutral baseline and tested extremes

## Simplification outcome

- Composition: the full astrolabe occupies the same shallow oblique ellipse, uses a long-lens perspective, and keeps the aperture aligned with the supplied reference.
- Hierarchy: four broad engraved registers, a separate guardian filigree layer, cardinal sigils, black aperture, and sparse void atmosphere.
- Rim budget: five visible metallic rims total: one outer crown, three register rails, and one aperture rim.
- Finish: the annular slab and crystalline sidewall remain absent. Smoke-bronze and moon-silver rims now combine physical metal, bright emissive cores, localized traveling energy veins, close additive halos, and restrained bloom. Rune spill, cardinal sigils, central filigree, aperture ticks, and rim halos compensate from the camera's projected pixels-per-world so their apparent radius stays stable as the composition refits.
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

## Findings

- P0: none.
- P1: none.
- P2: none.
- Browser console after final desktop and portrait reloads: no errors or warnings.
- Reduced motion freezes the scene at a deterministic authored frame.

final result: passed
