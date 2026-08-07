# Magic Circle Standalone - Design QA

## Evidence

- Reference: `tmp/magic-circle-qa/reference.png` (`1672 x 941`)
- Implementation: `tmp/magic-circle-qa/stronger-glow-wide.png` (`1672 x 941`)
- Responsive evidence: `tmp/magic-circle-qa/stronger-glow-portrait.png` (`800 x 1000`)
- Runtime: `src/ui/components/home/MagicCircle.standalone.html`
- Captured state: autonomous animation after approximately 3 seconds; no interaction state exists

## Simplification outcome

- Composition: the full astrolabe occupies the same shallow oblique ellipse, uses a long-lens perspective, and keeps the aperture aligned with the supplied reference.
- Hierarchy: four broad engraved registers, a separate guardian filigree layer, cardinal sigils, black aperture, and sparse void atmosphere.
- Rim budget: five visible metallic rims total: one outer crown, three register rails, and one aperture rim.
- Finish: the annular slab and crystalline sidewall remain absent. Smoke-bronze and moon-silver rims now combine physical metal, bright emissive cores, localized traveling energy veins, close additive halos, and restrained bloom. Rune spill comes from a separate optically blurred texture rather than a sharp duplicate.
- Motion: all four registers retain independent direction, speed, phase, height, and restrained vertical drift. Filigree, sigils, patina, aperture ticks, stars, and glints keep separate motion tracks.
- Constraint: no raster, SVG, model, video, or other visual asset is loaded at runtime. Geometry, CanvasTextures, particles, and shaders are generated in the standalone file.

## Iteration history

1. Pass 1 exposed an exaggerated short-lens perspective, a reflective gray aperture, clipped near edge, broad white glare, sparse inscriptions, and flat repeated geometry.
2. The correction moved to a long-lens camera, matched the reference viewport, made the aperture truly black, replaced broad reflections with black-glass shaders, increased inscription density, and reconstructed the central wreath outside the aperture mask.
3. The finish pass added real annular sidewalls, a separate inner register with geometric ticks, irregular rune wear, crystal rim facets, procedural glints, and restrained bloom. Desktop and portrait renders show no cropping or non-uniform scaling.
4. The distillation pass consolidated fourteen narrow registers into four broad bands and removed inner rails, hairlines, stacked outer lips, full-circle texture strokes, filigree guide circles, and the second aperture rim.
5. The floating-light pass removed every solid annular support and the remaining sidewall while preserving the approved pattern geometry. Existing rims and rune textures gained controlled bronze and silver inner radiance without adding sparks or ornament.
6. The bounded polish loop added soft rune scatter, a transparent violet atmospheric underlight, and slowly orbiting warm/cool illumination. The final hierarchy grades energy inward so the aperture leads without changing the four registers or five-rim budget.
7. The glow-strength pass increased emissive energy, halo width, optical rune scatter, localized hot-vein intensity, and restrained bloom while reducing the already sparse glints. Engraving cores remain legible at both verified sizes.

## Findings

- P0: none.
- P1: none.
- P2: none.
- Browser console after final desktop and portrait reloads: no errors or warnings.
- Reduced motion freezes the scene at a deterministic authored frame.

final result: passed
