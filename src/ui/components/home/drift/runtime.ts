/* eslint-disable */
// @ts-nocheck -- The shader study is intentionally kept source-identical to the approved prototype.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { THEME_LIST } from '../../../stores/theme-store';
import { bindPointerParallax } from './pointer-parallax';

export interface AstralDriftScene {
  applyTheme(themeId: string): void;
  pause(): void;
  resume(): void;
  resize(): void;
  dispose(): void;
}

export interface AstralDriftSceneOptions {
  themeId: string;
}

/**
 * Production wrapper for AstralDriftHomeParticles.standalone.html.
 *
 * The scene body below stays deliberately close to the reviewed prototype: shaders,
 * particle laws, composition values and the adaptive render-scale governor are copied
 * intact. This wrapper owns only app integration concerns (theme tokens, lifecycle,
 * visibility and disposal).
 */
export function createAstralDriftScene(
  canvas: HTMLCanvasElement,
  stage: HTMLElement,
  options: AstralDriftSceneOptions,
): AstralDriftScene {
  const TAU = Math.PI * 2;
  const reducedMotion = false;

  const dials = { bloom: 2, galaxy: 0.69, arc: 2, veils: 2, runes: 2, circle: 2 };

  // ----------------------------------------------------------------------------------
  // Palette.
  //
  // Read the galaxy row top to bottom as a single exposure curve, not as four colours:
  // white-hot core, gold shoulder, violet mid, cyan rim, near-black outskirts. The hue
  // travel is what sells depth in a particle disc — a one-hue galaxy reads as a smudge.
  // The veils are deliberately DARKER than they look here; they are drawn at ~0.05 alpha
  // and exist to make the black field have air in it, not to be seen as clouds.
  // ----------------------------------------------------------------------------------
  const PALETTE = {
    field: 0x01020a,

    coreHot: new THREE.Color(0xfff8ea),
    coreGold: new THREE.Color(0xffc271),
    armViolet: new THREE.Color(0xb46bff),
    armCyan: new THREE.Color(0x4fb4ff),
    armEdge: new THREE.Color(0x14356e),

    veilBlue: new THREE.Color(0x14406f),
    veilViolet: new THREE.Color(0x3a1d63),
    veilTeal: new THREE.Color(0x0e4a52),

    arcTint: new THREE.Color(0x8fd0ff),
    starCool: new THREE.Color(0xcfe2ff),
    starWarm: new THREE.Color(0xffd9a8),
    meteor: new THREE.Color(0xdff0ff),
  };

  // ----------------------------------------------------------------------------------
  // Renderer. antialias:false on purpose — the composer renders into its own target, so
  // MSAA on the default framebuffer would only antialias a full-screen quad.
  // ----------------------------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    stencil: false,
    depth: false,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.98;
  renderer.setClearColor(PALETTE.field, 1);
  renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  // Nothing in this scene is depth-tested and everything is additive, so per-object
  // sorting is pure CPU cost with no visual consequence.
  scene.matrixWorldAutoUpdate = true;
  scene.sortObjects = false;

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
  const CAMERA_BASE = new THREE.Vector3(0, 0.35, 20.5);
  const CAMERA_TARGET = new THREE.Vector3(0, 0.15, 0);

  // ==================================================================================
  // Mip-chain bloom. Ported unchanged from v2, where it was already tuned and measured at
  // ~0.3 ms at 3 Mpix: 13-tap downsample / 3x3 tent upsample (Jimenez 2014), Karis
  // average on level 0 so single-pixel stars blur instead of strobing, and an
  // energy-conserving mix(scene, bloom, strength) composite so raising strength trades
  // sharpness for halation rather than blowing the frame to white.
  //
  // On this piece bloom is not a garnish — it IS the look. Every luminous element is
  // authored small and hot and allowed to bleed, which is how the reference pens get
  // their soft neon core without painting a soft neon core.
  // ==================================================================================
  class MipBloomPass extends Pass {
    constructor() {
      super();
      this.strength = 0.2;
      this.radius = 0.85;
      this.mips = [];
      this.quad = new FullScreenQuad(null);

      const vertexShader = /* glsl */ `
      varying vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

      this.downMaterial = new THREE.ShaderMaterial({
        uniforms: {
          tInput: { value: null },
          uTexel: { value: new THREE.Vector2(1, 1) },
          uKaris: { value: 0 },
        },
        vertexShader,
        fragmentShader: /* glsl */ `
        uniform sampler2D tInput;
        uniform vec2 uTexel;
        uniform float uKaris;
        varying vec2 vUv;

        float karisWeight(vec3 colorSample) {
          return 1.0 / (1.0 + max(colorSample.r, max(colorSample.g, colorSample.b)));
        }

        void main() {
          vec2 texel = uTexel;
          vec3 a = texture2D(tInput, vUv + texel * vec2(-2.0, 2.0)).rgb;
          vec3 b = texture2D(tInput, vUv + texel * vec2(0.0, 2.0)).rgb;
          vec3 c = texture2D(tInput, vUv + texel * vec2(2.0, 2.0)).rgb;
          vec3 d = texture2D(tInput, vUv + texel * vec2(-2.0, 0.0)).rgb;
          vec3 e = texture2D(tInput, vUv).rgb;
          vec3 f = texture2D(tInput, vUv + texel * vec2(2.0, 0.0)).rgb;
          vec3 g = texture2D(tInput, vUv + texel * vec2(-2.0, -2.0)).rgb;
          vec3 h = texture2D(tInput, vUv + texel * vec2(0.0, -2.0)).rgb;
          vec3 i = texture2D(tInput, vUv + texel * vec2(2.0, -2.0)).rgb;
          vec3 j = texture2D(tInput, vUv + texel * vec2(-1.0, 1.0)).rgb;
          vec3 k = texture2D(tInput, vUv + texel * vec2(1.0, 1.0)).rgb;
          vec3 l = texture2D(tInput, vUv + texel * vec2(-1.0, -1.0)).rgb;
          vec3 m = texture2D(tInput, vUv + texel * vec2(1.0, -1.0)).rgb;

          if (uKaris > 0.5) {
            vec3 box0 = (a + b + d + e) * 0.25;
            vec3 box1 = (b + c + e + f) * 0.25;
            vec3 box2 = (d + e + g + h) * 0.25;
            vec3 box3 = (e + f + h + i) * 0.25;
            vec3 box4 = (j + k + l + m) * 0.25;
            float w0 = karisWeight(box0);
            float w1 = karisWeight(box1);
            float w2 = karisWeight(box2);
            float w3 = karisWeight(box3);
            float w4 = karisWeight(box4);
            vec3 result = box4 * (0.5 * w4) + (box0 * w0 + box1 * w1 + box2 * w2 + box3 * w3) * 0.125;
            float norm = 0.5 * w4 + (w0 + w1 + w2 + w3) * 0.125;
            gl_FragColor = vec4(result / max(norm, 1e-4), 1.0);
          } else {
            vec3 result = e * 0.125;
            result += (a + c + g + i) * 0.03125;
            result += (b + d + f + h) * 0.0625;
            result += (j + k + l + m) * 0.125;
            gl_FragColor = vec4(result, 1.0);
          }
        }
      `,
        depthTest: false,
        depthWrite: false,
      });

      this.upMaterial = new THREE.ShaderMaterial({
        uniforms: {
          tInput: { value: null },
          uTexel: { value: new THREE.Vector2(1, 1) },
          uScale: { value: 1 },
        },
        vertexShader,
        fragmentShader: /* glsl */ `
        uniform sampler2D tInput;
        uniform vec2 uTexel;
        uniform float uScale;
        varying vec2 vUv;

        void main() {
          vec2 texel = uTexel;
          vec3 result = texture2D(tInput, vUv + texel * vec2(-1.0, 1.0)).rgb;
          result += texture2D(tInput, vUv + texel * vec2(0.0, 1.0)).rgb * 2.0;
          result += texture2D(tInput, vUv + texel * vec2(1.0, 1.0)).rgb;
          result += texture2D(tInput, vUv + texel * vec2(-1.0, 0.0)).rgb * 2.0;
          result += texture2D(tInput, vUv).rgb * 4.0;
          result += texture2D(tInput, vUv + texel * vec2(1.0, 0.0)).rgb * 2.0;
          result += texture2D(tInput, vUv + texel * vec2(-1.0, -1.0)).rgb;
          result += texture2D(tInput, vUv + texel * vec2(0.0, -1.0)).rgb * 2.0;
          result += texture2D(tInput, vUv + texel * vec2(1.0, -1.0)).rgb;
          gl_FragColor = vec4(result * (uScale / 16.0), 1.0);
        }
      `,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        transparent: true,
      });

      this.compositeMaterial = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          tBloom: { value: null },
          uStrength: { value: this.strength },
          uNorm: { value: 1 },
        },
        vertexShader,
        fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tBloom;
        uniform float uStrength;
        uniform float uNorm;
        varying vec2 vUv;

        void main() {
          vec3 sceneColor = texture2D(tDiffuse, vUv).rgb;
          vec3 bloomColor = texture2D(tBloom, vUv).rgb / uNorm;
          gl_FragColor = vec4(mix(sceneColor, bloomColor, uStrength), 1.0);
        }
      `,
        depthTest: false,
        depthWrite: false,
      });
    }

    setSize(width, height) {
      for (const mip of this.mips) mip.target.dispose();
      this.mips = [];
      let mipWidth = Math.max(1, Math.floor(width / 2));
      let mipHeight = Math.max(1, Math.floor(height / 2));
      while (Math.min(mipWidth, mipHeight) >= 16 && this.mips.length < 8) {
        this.mips.push({
          target: new THREE.WebGLRenderTarget(mipWidth, mipHeight, {
            type: THREE.HalfFloatType,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: false,
          }),
          texelSize: new THREE.Vector2(1 / mipWidth, 1 / mipHeight),
        });
        mipWidth = Math.max(1, Math.floor(mipWidth / 2));
        mipHeight = Math.max(1, Math.floor(mipHeight / 2));
      }
    }

    render(renderer, writeBuffer, readBuffer) {
      if (this.mips.length === 0) return;
      const previousAutoClear = renderer.autoClear;
      renderer.autoClear = false;

      let sourceTexture = readBuffer.texture;
      let sourceTexel = new THREE.Vector2(1 / readBuffer.width, 1 / readBuffer.height);
      this.quad.material = this.downMaterial;
      for (let level = 0; level < this.mips.length; level += 1) {
        const mip = this.mips[level];
        this.downMaterial.uniforms.tInput.value = sourceTexture;
        this.downMaterial.uniforms.uTexel.value.copy(sourceTexel);
        this.downMaterial.uniforms.uKaris.value = level === 0 ? 1 : 0;
        renderer.setRenderTarget(mip.target);
        renderer.clear();
        this.quad.render(renderer);
        sourceTexture = mip.target.texture;
        sourceTexel = mip.texelSize;
      }

      this.quad.material = this.upMaterial;
      this.upMaterial.uniforms.uScale.value = this.radius;
      for (let level = this.mips.length - 2; level >= 0; level -= 1) {
        const smaller = this.mips[level + 1];
        this.upMaterial.uniforms.tInput.value = smaller.target.texture;
        this.upMaterial.uniforms.uTexel.value.copy(smaller.texelSize);
        renderer.setRenderTarget(this.mips[level].target);
        this.quad.render(renderer);
      }

      let norm = 0;
      for (let level = 0; level < this.mips.length; level += 1) {
        norm += Math.pow(this.radius, level);
      }
      this.quad.material = this.compositeMaterial;
      this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
      this.compositeMaterial.uniforms.tBloom.value = this.mips[0].target.texture;
      this.compositeMaterial.uniforms.uStrength.value = this.strength;
      this.compositeMaterial.uniforms.uNorm.value = norm;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      if (!this.renderToScreen) renderer.clear();
      this.quad.render(renderer);

      renderer.autoClear = previousAutoClear;
    }
  }

  const composerTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    samples: 0,
  });
  const composer = new EffectComposer(renderer, composerTarget);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new MipBloomPass();
  composer.addPass(bloom);

  // ----------------------------------------------------------------------------------
  // Grade. The aberration term here is radial and grows with distance from centre, the
  // way a real lens misbehaves — a constant offset reads as a printing misregistration
  // instead. It is small: the arc carries its own, much larger, authored fringe, and two
  // strong splits stacked on each other just looks broken.
  // ----------------------------------------------------------------------------------
  const gradePass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      // Theme surface. See the header note: one branch here replaces ten palettes,
      // because the meshes clone their colours out of PALETTE at build time.
      uInk: { value: 0 }, // 0 = astral (dark themes), 1 = chart (light themes)
      uThemeMix: { value: 0.45 },
      uInkGain: { value: 2.6 },
      uAccent: { value: new THREE.Color(0x7aa2d0) },
      uField: { value: new THREE.Color(0x02030b) },
      uPaper: { value: new THREE.Color(0xe5d8c2) },
      uInkColor: { value: new THREE.Color(0x2b2418) },
    },
    vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
    fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uInk;
    uniform float uThemeMix;
    uniform float uInkGain;
    uniform vec3 uAccent;
    uniform vec3 uField;
    uniform vec3 uPaper;
    uniform vec3 uInkColor;
    varying vec2 vUv;

    float hash21(vec2 point) {
      point = fract(point * vec2(123.34, 345.45));
      point += dot(point, point + 34.345);
      return fract(point.x * point.y);
    }

    void main() {
      vec2 centered = vUv - 0.5;
      float radial = dot(centered, centered);
      vec2 aberration = centered * (0.0007 + radial * 0.0052);

      vec3 color;
      color.r = texture2D(tDiffuse, vUv + aberration).r;
      color.g = texture2D(tDiffuse, vUv).g;
      color.b = texture2D(tDiffuse, vUv - aberration).b;

      // Lift the deepest shadows a hair off pure black and cool them. Absolute zero in
      // the corners is what makes a dark frame read as a flat card; a faint blue floor
      // tells the eye there is air out there.
      color += vec3(0.0022, 0.0038, 0.0082) * (1.0 - smoothstep(0.0, 0.6, radial));

      color = (color - 0.5) * 1.05 + 0.5;
      // Split tone: shadows cool, highlights warm. Half a percent each way; any more
      // and the galaxy's own hue travel stops being the thing carrying the colour.
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color *= mix(vec3(0.975, 0.995, 1.03), vec3(1.02, 1.0, 0.985), smoothstep(0.15, 0.85, luma));

      // ---- theme surface -------------------------------------------------------
      // NO BACKTICKS IN THIS BLOCK. It is a JS template literal, so one backtick in
      // a GLSL comment ends the string and the whole module fails to parse.
      //
      // Recomputed rather than reusing the luma above: the split tone has already
      // moved the channels, and grading a ramp off a stale luminance puts the
      // accent band in the wrong place by a visible amount at low uThemeMix.
      float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));

      // Astral: tritone field -> accent -> hot. Mixed OVER the original, never
      // replacing it, so the galaxy's own violet/cyan travel survives the theme.
      vec3 ramp = mix(uField, uAccent, smoothstep(0.0, 0.40, lum));
      ramp = mix(ramp, vec3(1.0), smoothstep(0.58, 1.0, lum));
      vec3 astral = mix(color, ramp, uThemeMix);

      // Chart: the scene is additive light on black, so its luminance IS an ink
      // density map already. Subtracting it from paper engraves the same geometry
      // with no change to a single mesh.
      //
      // TONE MAP FIRST. The composer target is half-float and the galaxy core lands
      // far above 1.0, where chroma is enormous; subtracting it there flipped the
      // hottest pixel in the frame to its complement and the core came out as a
      // saturated blue blob — a photo negative, which is the one thing this mode
      // must not look like. Reinhard first, so density and chroma are both bounded.
      vec3 sdr = color / (1.0 + color);
      float density = dot(sdr, vec3(0.2126, 0.7152, 0.0722));
      vec3 chroma = sdr - vec3(density);
      float ink = pow(clamp(density * uInkGain, 0.0, 1.0), 0.55);
      // Chroma also has to FADE OUT as ink approaches full, or the densest marks
      // keep drifting toward a complementary colour instead of settling on ink.
      // What survives is coloured washes in the mid densities, which reads as plate
      // registration on a printed chart — that part was the point.
      vec3 chart = uPaper - ink * (uPaper - uInkColor) - chroma * 0.35 * (1.0 - ink);

      color = mix(astral, chart, uInk);

      float grain = hash21(vUv * uResolution + fract(uTime * 0.061) * 79.0) - 0.5;
      color += grain * 0.0055;
      // Paper does not vignette like a lens; it darkens at the edge a little from
      // age. Same term, a quarter of the strength.
      color *= 1.0 - smoothstep(0.12, 0.74, radial) * mix(0.3, 0.08, uInk);

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
  });
  composer.addPass(gradePass);
  composer.addPass(new OutputPass());

  const fxaaPass = new ShaderPass(FXAAShader);
  composer.addPass(fxaaPass);

  // ==================================================================================
  // Shared uniforms.
  //
  // uProjScale converts a world-space radius into pixels for gl_PointSize. Every point
  // system in the scene reads the same object, so a resize fixes all of them at once.
  // ==================================================================================
  const uTime = { value: 0 };
  const uProjScale = { value: 1000 };

  const POINT_HEAD = /* glsl */ `
  // Round soft sprite with a hot core, computed rather than sampled: a 32x32 alpha
  // texture would cost a fetch per fragment for a shape that is two instructions.
  float sprite(vec2 coord) {
    float d = length(coord - 0.5) * 2.0;
    float halo = smoothstep(1.0, 0.0, d);
    return halo * halo * (0.55 + 0.45 * pow(max(0.0, 1.0 - d), 6.0) * 3.0);
  }
`;

  // ==================================================================================
  // Baked volume texture for the veils.
  //
  // Five octaves of value noise over 256x256, once, at startup: ~330k hash evaluations
  // total. v1 paid that PER PIXEL PER FRAME for the same visual result. RGB carries the
  // structure (sampled at a scrolling uv so the volume churns) and A carries a static
  // radial envelope (sampled at the quad's own uv so the billboard has no visible edge).
  // Sampling both from one texture keeps it to two fetches and one texture unit.
  // ==================================================================================
  function bakeVeilTexture(size = 256) {
    // PERIODIC noise, and this is not a nicety.
    //
    // The first bake used freq *= 2.03 and an unbounded hash lattice, i.e. it did not
    // tile. On the veils that was invisible, because a radial alpha envelope hides the
    // quad edge. On the full-frame storm layer it was catastrophic and instantly
    // legible: the seams show up as HARD AXIS-ALIGNED RECTANGLES across the sky, at
    // exactly vUv = 1/1.3, 1/2.9, 1/5.7 — the scroll scales. It reads as a broken
    // texture, not as a cloud.
    //
    // Fix: lattice coordinates wrap at a period, octave frequencies are exact powers of
    // two so every octave wraps on the same boundary, and u in [0,1] maps to exactly one
    // period. Then any repeat scale in any shader tiles seamlessly.
    const PERIOD = 8;
    const wrap = (value, period) => ((value % period) + period) % period;
    const hash = (x, y) => {
      const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
      return n - Math.floor(n);
    };
    const noise = (x, y, period) => {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const xf = x - xi;
      const yf = y - yi;
      const u = xf * xf * (3 - 2 * xf);
      const v = yf * yf * (3 - 2 * yf);
      const x0 = wrap(xi, period);
      const y0 = wrap(yi, period);
      const x1 = wrap(xi + 1, period);
      const y1 = wrap(yi + 1, period);
      const a = hash(x0, y0);
      const b = hash(x1, y0);
      const c = hash(x0, y1);
      const d = hash(x1, y1);
      return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
    };
    const fbm = (x, y) => {
      let sum = 0;
      let amp = 0.5;
      for (let octave = 0; octave < 5; octave += 1) {
        const freq = 1 << octave;
        sum += noise(x * freq, y * freq, PERIOD * freq) * amp;
        amp *= 0.5;
      }
      return sum;
    };

    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const u = x / size;
        const v = y / size;
        // Ridged fbm: the |2n-1| fold puts filaments where the noise crosses its mean,
        // which is what makes a cloud look like it has structure rather than lumps.
        // u,v span exactly one period, which is what makes the result tileable.
        const raw = fbm(u * PERIOD, v * PERIOD);
        const ridged = 1.0 - Math.abs(raw * 2.0 - 1.0);
        const structure = Math.pow(Math.max(0, ridged), 1.8);

        const dx = u - 0.5;
        const dy = v - 0.5;
        const dist = Math.sqrt(dx * dx + dy * dy) * 2.0;
        const envelope = Math.pow(Math.max(0, 1.0 - dist), 2.2);

        const index = (y * size + x) * 4;
        const level = Math.round(THREE.MathUtils.clamp(structure, 0, 1) * 255);
        data[index] = level;
        data[index + 1] = level;
        data[index + 2] = level;
        data[index + 3] = Math.round(THREE.MathUtils.clamp(envelope, 0, 1) * 255);
      }
    }

    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  }

  const veilTexture = bakeVeilTexture();

  // ==================================================================================
  // Layer 1 — star shells.
  //
  // Three shells at different distances so pointer parallax separates them. Twinkle is
  // per-star and incommensurate (two sines at unrelated rates) so the field never
  // pulses as one object, which is the tell that gives away a cheap starfield.
  // ==================================================================================
  function buildStars() {
    const SHELLS = [
      { count: 900, near: 42, far: 62, size: 0.055, gain: 0.9 },
      { count: 760, near: 66, far: 96, size: 0.075, gain: 0.68 },
      { count: 620, near: 100, far: 150, size: 0.1, gain: 0.5 },
    ];

    const total = SHELLS.reduce((sum, shell) => sum + shell.count, 0);
    const positions = new Float32Array(total * 3);
    const colors = new Float32Array(total * 3);
    const scalars = new Float32Array(total * 3); // size, seed, gain

    const color = new THREE.Color();
    let cursor = 0;
    for (const shell of SHELLS) {
      for (let index = 0; index < shell.count; index += 1) {
        // Cosine-distributed elevation keeps the density even on the sphere; naive
        // uniform latitude clumps every shell at its poles.
        const theta = Math.random() * TAU;
        const phi = Math.acos(2 * Math.random() - 1);
        const radius = THREE.MathUtils.lerp(shell.near, shell.far, Math.random());
        positions[cursor * 3] = Math.sin(phi) * Math.cos(theta) * radius;
        positions[cursor * 3 + 1] = Math.cos(phi) * radius * 0.72;
        positions[cursor * 3 + 2] = Math.sin(phi) * Math.sin(theta) * radius;

        const warmth = Math.pow(Math.random(), 2.6);
        color.copy(PALETTE.starCool).lerp(PALETTE.starWarm, warmth);
        const brightness = 0.35 + Math.pow(Math.random(), 2.2) * 1.3;
        colors[cursor * 3] = color.r * brightness;
        colors[cursor * 3 + 1] = color.g * brightness;
        colors[cursor * 3 + 2] = color.b * brightness;

        scalars[cursor * 3] = shell.size * (0.6 + Math.random() * 0.9);
        scalars[cursor * 3 + 1] = Math.random() * TAU;
        scalars[cursor * 3 + 2] = shell.gain;
        cursor += 1;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aScalar', new THREE.BufferAttribute(scalars, 3));

    const material = new THREE.ShaderMaterial({
      uniforms: { uTime, uProjScale },
      vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute vec3 aScalar;
      uniform float uTime;
      uniform float uProjScale;
      varying vec3 vColor;

      void main() {
        float seed = aScalar.y;
        float twinkle = 0.72
          + 0.28 * sin(uTime * 0.9 + seed)
          + 0.16 * sin(uTime * 1.63 + seed * 2.7);
        vColor = aColor * aScalar.z * max(0.05, twinkle);

        vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPos;
        gl_PointSize = clamp(aScalar.x * uProjScale / -viewPos.z, 1.0, 9.0);
      }
    `,
      fragmentShader: /* glsl */ `
      ${POINT_HEAD}
      varying vec3 vColor;

      void main() {
        gl_FragColor = vec4(vColor * sprite(gl_PointCoord), 1.0);
      }
    `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);
    return { points, material };
  }

  // ==================================================================================
  // Layer 2 — volume veils.
  //
  // Seven large quads, each with its own drift rate and tint. They are the only thing in
  // the frame with a soft large-area gradient, and they are what keeps the black from
  // reading as an empty background colour.
  // ==================================================================================
  function buildVeils() {
    const SPECS = [
      {
        pos: [-7.5, 2.4, -14],
        size: 21,
        tint: PALETTE.veilBlue,
        alpha: 0.26,
        spin: 0.012,
        drift: 0.0075,
      },
      {
        pos: [8.2, -1.4, -17],
        size: 25,
        tint: PALETTE.veilViolet,
        alpha: 0.22,
        spin: -0.009,
        drift: -0.0058,
      },
      {
        pos: [0.5, -5.2, -10],
        size: 19,
        tint: PALETTE.veilTeal,
        alpha: 0.17,
        spin: 0.016,
        drift: 0.0092,
      },
      {
        pos: [-11, -4.5, -22],
        size: 30,
        tint: PALETTE.veilBlue,
        alpha: 0.15,
        spin: -0.006,
        drift: 0.0041,
      },
      {
        pos: [12, 5.5, -24],
        size: 28,
        tint: PALETTE.veilViolet,
        alpha: 0.13,
        spin: 0.008,
        drift: -0.0067,
      },
      {
        pos: [-2, 6.5, -19],
        size: 22,
        tint: PALETTE.veilTeal,
        alpha: 0.11,
        spin: -0.013,
        drift: 0.0053,
      },
      {
        pos: [3.5, 0.5, -7],
        size: 15,
        tint: PALETTE.veilBlue,
        alpha: 0.1,
        spin: 0.02,
        drift: -0.011,
      },
    ];

    const geometry = new THREE.PlaneGeometry(1, 1);
    const group = new THREE.Group();
    const materials = [];

    for (const spec of SPECS) {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uTime,
          tVeil: { value: veilTexture },
          uTint: { value: spec.tint.clone() },
          uAlpha: { value: spec.alpha },
          uDial: { value: 1 },
          uDrift: { value: spec.drift },
          uSeed: { value: Math.random() * 10 },
        },
        vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
        fragmentShader: /* glsl */ `
        uniform sampler2D tVeil;
        uniform vec3 uTint;
        uniform float uAlpha;
        uniform float uDial;
        uniform float uDrift;
        uniform float uSeed;
        uniform float uTime;
        varying vec2 vUv;

        void main() {
          // Envelope from the quad's own uv (static, so the billboard edge never
          // shows); structure from a scrolling, differently-scaled uv (so the volume
          // churns). Two fetches, one texture.
          float envelope = texture2D(tVeil, vUv).a;
          vec2 flow = vUv * 1.9 + vec2(uTime * uDrift, uTime * uDrift * 0.6) + uSeed;
          float structure = texture2D(tVeil, flow).r;
          vec2 flow2 = vUv * 0.9 - vec2(uTime * uDrift * 0.55, 0.0) + uSeed * 0.37;
          structure = mix(structure, texture2D(tVeil, flow2).r, 0.45);

          float density = envelope * (0.25 + 0.75 * structure);
          gl_FragColor = vec4(uTint * density * uAlpha * uDial, 1.0);
        }
      `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
      mesh.scale.setScalar(spec.size);
      mesh.rotation.z = Math.random() * TAU;
      mesh.userData.spin = spec.spin;
      mesh.frustumCulled = false;
      group.add(mesh);
      materials.push(material);
    }

    scene.add(group);
    return { group, materials };
  }

  // ==================================================================================
  // Layer 1b — the storm.
  //
  // From the Storm and Snowfall references, and it is the single biggest thing the first
  // draft of this piece was missing. Both of those pens fill the ENTIRE frame with
  // churning volume; there is no object and no empty space, and that is why they read as
  // atmosphere rather than as a picture of something. My first draft was one galaxy in a
  // black rectangle: correct, tasteful, and inert.
  //
  // A full-screen fragment pass is the most expensive real estate in the frame, and v1's
  // dome does ~200 hash evaluations per pixel on exactly this footprint. This is three
  // texture fetches of noise baked once at startup, scrolling at three unrelated rates:
  // same churn, roughly two orders of magnitude less arithmetic. (On a 4090 that saving
  // does not clear the noise floor — see the correction in the file header. ALU is where
  // laptop GPUs are weakest, so this is insurance, not a measured win.)
  // ==================================================================================
  function buildStorm() {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uDial: { value: 1 },
        tVeil: { value: veilTexture },
        uDeep: { value: new THREE.Color(0x0a1a4a) },
        uLit: { value: new THREE.Color(0x2b5fa8) },
        uWarm: { value: new THREE.Color(0x4a2f6b) },
      },
      vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
      fragmentShader: /* glsl */ `
      uniform sampler2D tVeil;
      uniform float uTime;
      uniform float uDial;
      uniform vec3 uDeep;
      uniform vec3 uLit;
      uniform vec3 uWarm;
      varying vec2 vUv;

      void main() {
        // Three octaves, three directions, three speeds. Sharing one direction is what
        // makes cheap cloud layers look like a sliding wallpaper.
        float a = texture2D(tVeil, vUv * 1.3 + vec2(uTime * 0.0032, uTime * 0.0018)).r;
        float b = texture2D(tVeil, vUv * 2.9 - vec2(uTime * 0.0051, uTime * -0.0026)).r;
        float c = texture2D(tVeil, vUv * 5.7 + vec2(uTime * -0.0044, uTime * 0.0061)).r;

        float body = a * 0.55 + b * 0.3 + c * 0.15;
        // Sharpen into billows. Without the curve it is fog; with it there are edges,
        // and edges are what let the eye read depth in a cloud.
        body = pow(clamp(body * 1.35, 0.0, 1.0), 2.3);

        // Darker at the top of the frame, where page copy lives.
        float sky = smoothstep(0.15, 0.95, vUv.y);
        float lit = smoothstep(0.35, 0.85, a);

        vec3 color = mix(uDeep, uLit, lit);
        color = mix(color, uWarm, smoothstep(0.5, 0.95, c) * 0.55);
        // 0.14, not the 0.5 of the first pass. A full-frame additive layer touches
        // every pixel in the picture, so its gain is effectively a global exposure
        // control: at 0.5 it lifted the entire field to mid blue and there was no
        // black left anywhere for the galaxy to be bright against.
        gl_FragColor = vec4(color * body * (0.28 + 0.72 * sky) * 0.14 * uDial, 1.0);
      }
    `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.position.set(0, 0, -70);
    mesh.scale.set(200, 130, 1);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { mesh, material };
  }

  // ==================================================================================
  // Layer 1c — bokeh.
  //
  // From the Snowfall and Starfall references: both are full of large, soft, defocused
  // discs sitting among the sharp specks. Real defocused points are not gaussian blobs —
  // an out-of-focus point light images the APERTURE, so it has a flat interior and a
  // brighter rim. That rim is the entire tell, and it costs two smoothsteps.
  // ==================================================================================
  function buildBokeh() {
    const COUNT = 74;
    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    const scalars = new Float32Array(COUNT * 3); // size, seed, brightness

    const tints = [
      new THREE.Color(0xbcd8ff),
      new THREE.Color(0xffd7a0),
      new THREE.Color(0xc3a6ff),
      new THREE.Color(0x9fe8ff),
    ];

    for (let index = 0; index < COUNT; index += 1) {
      positions[index * 3] = (Math.random() - 0.5) * 34;
      positions[index * 3 + 1] = (Math.random() - 0.5) * 22;
      positions[index * 3 + 2] = 1 + Math.random() * 15;

      const tint = tints[Math.floor(Math.random() * tints.length)];
      colors[index * 3] = tint.r;
      colors[index * 3 + 1] = tint.g;
      colors[index * 3 + 2] = tint.b;

      // Kept small and dim on purpose. Big bright bokeh reads as dirt on the lens rather
      // than as depth; in the reference pens the discs are numerous and quiet.
      scalars[index * 3] = 0.14 + Math.pow(Math.random(), 1.8) * 0.4;
      scalars[index * 3 + 1] = Math.random() * TAU;
      scalars[index * 3 + 2] = 0.02 + Math.pow(Math.random(), 2.4) * 0.045;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aScalar', new THREE.BufferAttribute(scalars, 3));

    const material = new THREE.ShaderMaterial({
      uniforms: { uTime, uProjScale, uDial: { value: 1 } },
      vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute vec3 aScalar;
      uniform float uTime;
      uniform float uProjScale;
      varying vec3 vColor;

      void main() {
        float seed = aScalar.y;
        vec3 p = position;
        p.x += sin(uTime * 0.041 + seed) * 1.4;
        p.y += cos(uTime * 0.033 + seed * 1.9) * 0.9 - uTime * 0.06;
        p.y = mod(p.y + 11.0, 22.0) - 11.0;

        vColor = aColor * aScalar.z * (0.7 + 0.3 * sin(uTime * 0.29 + seed * 2.1));

        vec4 viewPos = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * viewPos;
        gl_PointSize = clamp(aScalar.x * uProjScale / -viewPos.z, 2.0, 150.0);
      }
    `,
      fragmentShader: /* glsl */ `
      uniform float uDial;
      varying vec3 vColor;

      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        // Flat interior, bright rim: the image of an aperture, not a gaussian.
        float disc = 1.0 - smoothstep(0.72, 1.0, d);
        float rim = smoothstep(0.5, 0.86, d) * (1.0 - smoothstep(0.9, 1.02, d));
        gl_FragColor = vec4(vColor * (disc * 0.45 + rim * 0.85) * uDial, 1.0);
      }
    `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);
    return { points, material };
  }

  // ==================================================================================
  // Layer 3 — the galaxy. The one element carried over from v2 by request.
  //
  // Built in the XY plane and tilted as a group, so "flat" is the default and the tilt
  // is one number to tune. The arms are a log spiral: angle grows linearly with radius,
  // which is the only winding rule that keeps arm WIDTH constant as the disc grows —
  // a fixed angular offset per ring gives you a pinwheel, not a galaxy.
  //
  // Differential rotation happens in the VERTEX SHADER from a per-point radius, so the
  // arms wind up over time with zero CPU work and zero buffer uploads.
  // ==================================================================================
  function buildGalaxy() {
    // 120k points, and the count is doing a specific job: at 58k every sprite was a
    // separate dot and the arms read as spray-paint. Particles only stop looking like
    // particles when they OVERLAP, so density and sprite size have to rise together and
    // per-point brightness has to fall to match. Points are vertex-bound and these are
    // 2-3 px, so the whole disc is well under half a screen of fill.
    const COUNT = 120000;
    const RADIUS = 5.0;
    const ARMS = 3;
    // Logarithmic winding, not linear. theta = ln(1 + kr) winds hard near the centre and
    // relaxes outward, which is what a real spiral does; a linear theta = SPIN*r leaves
    // the arms straight near the middle and they converge into a visible polygon — the
    // previous draft had a distinct violet triangle sitting over the bulge.
    const WIND_K = 2.2;
    const WIND_GAIN = 2.6;
    // Rigid pattern speed, radians per second. One turn every ~4.5 minutes: fast enough
    // that a returning visitor sees a different frame, slow enough to be unreadable as
    // motion. The haze reads the same constant, so the two never separate.
    const PATTERN_SPEED = 0.0235;
    // Fraction of the population that ignores the arms entirely. Without it the disc is
    // three ribbons on black and reads as a pinwheel decal; with it the arms sit inside
    // a body. Draft one had ARMS=4 at spread 0.66 rad against an arm spacing of 1.57 rad,
    // i.e. the arms overlapped each other and the whole disc came out as one smooth blob.
    const HALO_SHARE = 0.26;

    const positions = new Float32Array(COUNT * 3);
    const scalars = new Float32Array(COUNT * 3); // radius01, seed, size

    // Box-Muller: real gaussian scatter. Sum-of-uniforms fakes it badly at the tails,
    // and the tails are exactly the stars that read as an arm having a soft edge.
    const gaussian = () => {
      let u = 0;
      let v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
    };

    for (let index = 0; index < COUNT; index += 1) {
      // Concentrating on r^0.62 puts roughly half the population inside 30% of the
      // radius, which is what gives the disc a bulge without modelling one.
      const t = Math.pow(Math.random(), 0.78);
      const radius = t * RADIUS;

      // Inside the bulge the arms are forced off: a real bulge is a smooth spheroid, and
      // leaving the arm term switched on all the way to r=0 is what draws the polygon.
      const inHalo = Math.random() < HALO_SHARE || t < 0.17;
      const arm = Math.floor(Math.random() * ARMS);
      const armAngle = (arm / ARMS) * TAU;
      // Arm spread must stay well under the arm spacing (TAU/ARMS) or the arms merge.
      const spread = inHalo ? 1.2 : 0.05 + t * 0.19;
      const angle = armAngle + Math.log(1 + radius * WIND_K) * WIND_GAIN + gaussian() * spread;

      // A little extra radial jitter breaks the "drawn with a compass" look at the rim.
      const jitter = gaussian() * (0.02 + t * 0.11);
      const finalRadius = Math.max(0.02, radius + jitter);

      positions[index * 3] = Math.cos(angle) * finalRadius;
      positions[index * 3 + 1] = Math.sin(angle) * finalRadius;
      // The disc is thick at the core and thin at the rim, like a real one.
      positions[index * 3 + 2] = gaussian() * (0.42 * Math.exp(-t * 2.6) + 0.03);

      scalars[index * 3] = finalRadius / RADIUS;
      scalars[index * 3 + 1] = Math.random() * TAU;
      scalars[index * 3 + 2] = 0.022 + Math.pow(Math.random(), 3.0) * 0.055;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aScalar', new THREE.BufferAttribute(scalars, 3));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uProjScale,
        uDial: { value: 1 },
        uPattern: { value: PATTERN_SPEED },
        uCoreHot: { value: PALETTE.coreHot.clone() },
        uCoreGold: { value: PALETTE.coreGold.clone() },
        uArmViolet: { value: PALETTE.armViolet.clone() },
        uArmCyan: { value: PALETTE.armCyan.clone() },
        uArmEdge: { value: PALETTE.armEdge.clone() },
      },
      vertexShader: /* glsl */ `
      attribute vec3 aScalar;
      uniform float uTime;
      uniform float uProjScale;
      uniform float uDial;
      uniform float uPattern;
      uniform vec3 uCoreHot;
      uniform vec3 uCoreGold;
      uniform vec3 uArmViolet;
      uniform vec3 uArmCyan;
      uniform vec3 uArmEdge;
      varying vec3 vColor;

      void main() {
        float q = aScalar.x;
        float seed = aScalar.y;

        // THE WINDING PROBLEM, and why this is not a differential rotation.
        //
        // The obvious thing — omega = k/(a + q) so inner material sweeps faster — is
        // what a real disc does, and it is what the previous draft did. Rendered, it
        // is wrong: shear accumulates without bound, and by t = 170 s the three arms
        // had wrapped far enough to close into concentric rings. A bullseye. Real
        // galaxies have the same problem and resolve it the same way this does: the
        // ARMS ARE NOT MATERIAL. They are a pattern that turns rigidly, while
        // individual stars move through it.
        //
        // So the pattern rotates at one speed for every radius (no shear, ever), and
        // the stars get a bounded epicyclic wobble on top, which reads as motion
        // WITHIN the arms without ever pulling them apart.
        float r = length(position.xy);
        float baseAngle = atan(position.y, position.x);

        // Epicyclic frequency rises toward the centre, as it does in a real disc.
        float kappa = 0.55 + 0.85 / (0.25 + q * 1.6);
        float epi = uTime * kappa * 0.35 + seed * 6.2831853;
        float wobbleR = r * (1.0 + sin(epi) * 0.045);
        float wobbleA = baseAngle + uTime * uPattern + cos(epi) * 0.05;

        vec3 spun = vec3(cos(wobbleA) * wobbleR, sin(wobbleA) * wobbleR, position.z);

        // One exposure curve, four stops. Ordering is the whole look.
        vec3 tint = mix(uCoreHot, uCoreGold, smoothstep(0.0, 0.19, q));
        tint = mix(tint, uArmViolet, smoothstep(0.15, 0.46, q));
        tint = mix(tint, uArmCyan, smoothstep(0.40, 0.78, q));
        tint = mix(tint, uArmEdge, smoothstep(0.74, 1.0, q));

        // Gentle falloff. Draft two dropped to 0.5 by q=0.34 and left a dead annulus
        // between the gold bulge and the cyan rim — the disc read as a ring, not a
        // spiral. The mid radii are where the arms actually are, so they get the light.
        float brightness = mix(3.0, 1.05, smoothstep(0.0, 0.46, q));
        brightness *= 1.0 - smoothstep(0.78, 1.04, q) * 0.7;
        float flicker = 0.85 + 0.15 * sin(uTime * 1.7 + seed * 3.1);
        vColor = tint * brightness * flicker * uDial;

        vec4 viewPos = modelViewMatrix * vec4(spun, 1.0);
        gl_Position = projectionMatrix * viewPos;
        // Core stars are drawn smaller, not bigger: they are already the brightest
        // thing in the frame, and letting them also be the largest turns the bulge
        // into one white blob the moment bloom touches it.
        float size = aScalar.z * (0.55 + q * 0.85);
        gl_PointSize = clamp(size * uProjScale / -viewPos.z, 1.0, 7.0);
      }
    `,
      fragmentShader: /* glsl */ `
      ${POINT_HEAD}
      varying vec3 vColor;

      void main() {
        gl_FragColor = vec4(vColor * sprite(gl_PointCoord) * 0.3, 1.0);
      }
    `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;

    const group = new THREE.Group();
    group.add(points);
    // -1.0 rad. The magnitude is a framing choice: cos(0.62) squashes the disc by only
    // 19%, which the eye reads as a flat circle seen head-on, where 1.0 gives 54% and the
    // thing is unmistakably a disc lying in space.
    //
    // The SIGN is not a taste call, it is a bug fix. A disc built in the XY plane has its
    // front-face normal at +Z; rotating it by +1.0 about X sends that normal to
    // (0, -0.841, 0.540), which points DOWNWARD — so the camera, sitting on the positive
    // side of it, was looking at the disc FROM BELOW. Nothing gave that away while the
    // scene was only particles and rings, because those are symmetric front-to-back. Put
    // lettering on it and it is immediately obvious: an annulus seen from behind shows
    // its texture mirrored, so the runes read as engraved on the underside of a glass
    // table while the galaxy still read as seen from above. Negating it puts the normal
    // at (0, +0.841, 0.540) and the camera above the plane, which is one consistent
    // reading for everything in the group.
    group.rotation.x = -1.0;
    group.rotation.z = -0.24;
    scene.add(group);
    return {
      group,
      points,
      material,
      radius: RADIUS,
      arms: ARMS,
      windK: WIND_K,
      windGain: WIND_GAIN,
      patternSpeed: PATTERN_SPEED,
    };
  }

  // ==================================================================================
  // Layer 3b — the disc haze.
  //
  // One quad lying in the galaxy's own plane, carrying an ANALYTIC version of exactly the
  // same spiral the points are sampled from. This is the difference between "a particle
  // system" and "a galaxy": however many points you scatter, the gaps between them stay
  // visible, and gaps read as spray-paint. The haze fills them with continuous light, so
  // the points become stars sitting inside a luminous body instead of being the body.
  //
  // It has to track the points exactly or the two desynchronise into a double image, so
  // it re-uses the same three numbers — ARMS, WIND_K, WIND_GAIN — and the same
  // differential rotation law omega(q). Change one and you must change the other.
  // ==================================================================================
  function buildDiscHaze(spec) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uDial: { value: 1 },
        tVeil: { value: veilTexture },
        uArms: { value: spec.arms },
        uWindK: { value: spec.windK },
        uWindGain: { value: spec.windGain },
        uPattern: { value: spec.patternSpeed },
        uCoreHot: { value: PALETTE.coreHot.clone() },
        uCoreGold: { value: PALETTE.coreGold.clone() },
        uArmViolet: { value: PALETTE.armViolet.clone() },
        uArmCyan: { value: PALETTE.armCyan.clone() },
        uArmEdge: { value: PALETTE.armEdge.clone() },
      },
      vertexShader: /* glsl */ `
      varying vec2 vPos;
      void main() {
        // Quad spans -1..1 in the disc plane; the fragment shader works in disc radii.
        vPos = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
      fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uDial;
      uniform sampler2D tVeil;
      uniform float uArms;
      uniform float uWindK;
      uniform float uWindGain;
      uniform float uPattern;
      uniform vec3 uCoreHot;
      uniform vec3 uCoreGold;
      uniform vec3 uArmViolet;
      uniform vec3 uArmCyan;
      uniform vec3 uArmEdge;
      varying vec2 vPos;

      void main() {
        float q = length(vPos);
        if (q > 1.0) discard;

        float radius = q * 5.0;
        // Points are rotated BY +uPattern*t, so the pattern this shader draws has to
        // be read at -uPattern*t to land in the same place. Same constant, no shear.
        float angle = atan(vPos.y, vPos.x) - uTime * uPattern;

        float wound = angle - log(1.0 + radius * uWindK) * uWindGain;
        float arms = cos(uArms * wound) * 0.5 + 0.5;
        arms = pow(arms, 2.0);

        // Break the perfectly analytic arms with the same baked noise the veils use,
        // sampled in polar so the grain travels with the arm rather than across it.
        vec2 grainUv = vec2(wound * 0.16, q * 1.3 + uTime * 0.004);
        float grain = texture2D(tVeil, grainUv).r;
        arms *= 0.55 + 0.9 * grain;

        // Exponential body with a bulge floor, so the haze does not stop at the last arm.
        float body = exp(-q * 3.1) * 0.9 + exp(-q * 8.0) * 1.6;
        float density = body * (0.3 + 0.7 * arms);
        density *= 1.0 - smoothstep(0.72, 1.0, q);

        vec3 tint = mix(uCoreHot, uCoreGold, smoothstep(0.0, 0.17, q));
        tint = mix(tint, uArmViolet, smoothstep(0.14, 0.44, q));
        tint = mix(tint, uArmCyan, smoothstep(0.38, 0.76, q));
        tint = mix(tint, uArmEdge, smoothstep(0.72, 1.0, q));

        gl_FragColor = vec4(tint * density * 0.5 * uDial, 1.0);
      }
    `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.scale.setScalar(spec.radius * 2);
    mesh.frustumCulled = false;
    return { mesh, material };
  }

  const RING_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

  const HASH_HEAD = /* glsl */ `
  float hash11(float n) {
    return fract(sin(n * 127.1) * 43758.5453123);
  }
`;

  // ==================================================================================
  // Glyph atlas.
  //
  // Every rune in the piece lives in ONE 32x3 atlas baked at startup, and a whole
  // register samples it by angle — 32 runes, one draw call, one texture unit. The
  // alternative (the original magic-circle study's approach) is a textured plane per
  // glyph, which is how that file ended up 34 alpha layers deep.
  //
  // The runes are generated from a stroke grammar rather than a font: a stem, one to
  // three branches off it, sometimes a crossing diagonal or a lozenge. That is the
  // Elder-Futhark silhouette without shipping a typeface or claiming to spell anything.
  // The RNG is seeded, so the atlas is identical on every load — a piece that reshuffles
  // its own iconography between visits reads as unstable, not as varied.
  // ==================================================================================
  function bakeGlyphAtlas({ cols = 32, rows = 3, cell = 64 } = {}) {
    const atlas = document.createElement('canvas');
    atlas.width = cols * cell;
    atlas.height = rows * cell;
    const ctx = atlas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, atlas.width, atlas.height);
    ctx.strokeStyle = '#fff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let state = 0x9e3779b9;
    const rnd = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return ((state >>> 0) % 1000000) / 1000000;
    };

    const clamp01 = (value) => Math.min(0.98, Math.max(0.02, value));

    for (let row = 0; row < rows; row += 1) {
      // Later rows are lighter: they are the outer registers, and an outer register at
      // the same stroke weight as an inner one flattens the whole figure.
      ctx.lineWidth = Math.max(1.5, cell * (0.1 - row * 0.018));
      for (let col = 0; col < cols; col += 1) {
        // Glyphs occupy the middle 60% of the cell. The margin is what stops mipmap
        // minification from bleeding a neighbouring rune into this one.
        const pad = cell * 0.2;
        const originX = col * cell + pad;
        const originY = row * cell + pad;
        const span = cell - pad * 2;
        const at = (u, v) => [originX + clamp01(u) * span, originY + clamp01(v) * span];

        ctx.beginPath();
        const stems = rnd() < 0.24 ? 2 : 1;
        const stemAt = [];
        for (let index = 0; index < stems; index += 1) {
          const u = stems === 1 ? 0.5 : index === 0 ? 0.3 : 0.7;
          stemAt.push(u);
          ctx.moveTo(...at(u, 0.04));
          ctx.lineTo(...at(u, 0.96));
        }

        const branches = 1 + Math.floor(rnd() * 3);
        for (let index = 0; index < branches; index += 1) {
          const from = stemAt[Math.floor(rnd() * stemAt.length)];
          const height = 0.1 + rnd() * 0.78;
          const dirX = rnd() < 0.5 ? -1 : 1;
          const dirY = rnd() < 0.5 ? 1 : -1;
          const length = 0.2 + rnd() * 0.24;
          ctx.moveTo(...at(from, height));
          ctx.lineTo(...at(from + dirX * length, height + dirY * length * 0.95));
        }

        if (rnd() < 0.3) {
          const flip = rnd() < 0.5;
          ctx.moveTo(...at(flip ? 0.14 : 0.86, 0.12));
          ctx.lineTo(...at(flip ? 0.86 : 0.14, 0.88));
        }

        if (rnd() < 0.24) {
          const centre = 0.24 + rnd() * 0.52;
          const r = 0.13;
          ctx.moveTo(...at(0.5, centre - r));
          ctx.lineTo(...at(0.5 + r, centre));
          ctx.lineTo(...at(0.5, centre + r));
          ctx.lineTo(...at(0.5 - r, centre));
          ctx.closePath();
        }

        ctx.stroke();
      }
    }

    const texture = new THREE.CanvasTexture(atlas);
    // Repeat in u because a register wraps the full circle; clamp in v so a row can
    // never sample into its neighbour.
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.colorSpace = THREE.NoColorSpace; // it is a mask, not a colour
    texture.needsUpdate = true;
    return { texture, cols, rows };
  }

  const glyphAtlas = bakeGlyphAtlas();

  // ==================================================================================
  // Rune atlas for the magic-circle registers (2026-08-19).
  //
  // Same stroke grammar as bakeGlyphAtlas — Elder-Futhark silhouettes generated from a
  // seeded grammar rather than a typeface — but with a DIFFERENT seed and shape so the
  // circle's registers do not reuse the galaxy's glyphs verbatim. cols=35 fits one
  // register round the circle exactly (uRepeat stays an integer 1); row 0 is the outer
  // ring's 35 runes, row 1 the inner ring's 23 (the last 12 cells are empty — the inner
  // register only fills part of its lap, which is what a gap in a seal reads as).
  // Outer row is drawn lighter, like the galaxy atlas, so an outer register at the same
  // stroke weight as an inner one flattens the whole figure.
  // ==================================================================================
  function bakeRuneAtlas({ cols = 35, rows = 2, cellW = 96, cellH = 128 } = {}) {
    const atlas = document.createElement('canvas');
    atlas.width = cols * cellW;
    atlas.height = rows * cellH;
    const ctx = atlas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, atlas.width, atlas.height);
    ctx.strokeStyle = '#fff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let state = 0x41c64e6d; // different seed than the galaxy atlas
    const rnd = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return ((state >>> 0) % 1000000) / 1000000;
    };

    const clamp01 = (value) => Math.min(0.98, Math.max(0.02, value));

    // Row 1's glyphs also stop at 23 cells; the remaining cells stay black so the inner
    // register's lap ends in a gap rather than a stray stroke.
    const occupied = (row) => (row === 0 ? cols : 23);

    for (let row = 0; row < rows; row += 1) {
      // Stroke weight scales with the TALL dimension, where the glyph actually lives.
      ctx.lineWidth = Math.max(1.5, cellH * (0.09 - row * 0.02));
      for (let col = 0; col < occupied(row); col += 1) {
        // The glyph is TALL and NARROW, matching how the SVG's runes read (font-size 64
        // against ~30px width). A cell is one arc-length of the register: with 35 cells
        // round a lap that arc is ~5x the band depth, so the glyph fills ~10% of the
        // cell WIDTH (keeps its aspect) but ~90% of the cell HEIGHT (fills the band).
        const padX = cellW * 0.45;
        const padY = cellH * 0.05;
        const originX = col * cellW + padX;
        const originY = row * cellH + padY;
        const spanX = cellW - padX * 2;
        const spanY = cellH - padY * 2;
        const at = (u, v) => [originX + clamp01(u) * spanX, originY + clamp01(v) * spanY];

        ctx.beginPath();
        const stems = rnd() < 0.24 ? 2 : 1;
        const stemAt = [];
        for (let index = 0; index < stems; index += 1) {
          const u = stems === 1 ? 0.5 : index === 0 ? 0.3 : 0.7;
          stemAt.push(u);
          ctx.moveTo(...at(u, 0.04));
          ctx.lineTo(...at(u, 0.96));
        }

        const branches = 1 + Math.floor(rnd() * 3);
        for (let index = 0; index < branches; index += 1) {
          const from = stemAt[Math.floor(rnd() * stemAt.length)];
          const height = 0.1 + rnd() * 0.78;
          const dirX = rnd() < 0.5 ? -1 : 1;
          const dirY = rnd() < 0.5 ? 1 : -1;
          const length = 0.2 + rnd() * 0.24;
          ctx.moveTo(...at(from, height));
          ctx.lineTo(...at(from + dirX * length, height + dirY * length * 0.95));
        }

        if (rnd() < 0.3) {
          const flip = rnd() < 0.5;
          ctx.moveTo(...at(flip ? 0.14 : 0.86, 0.12));
          ctx.lineTo(...at(flip ? 0.86 : 0.14, 0.88));
        }

        if (rnd() < 0.24) {
          const centre = 0.24 + rnd() * 0.52;
          const r = 0.13;
          ctx.moveTo(...at(0.5, centre - r));
          ctx.lineTo(...at(0.5 + r, centre));
          ctx.lineTo(...at(0.5, centre + r));
          ctx.lineTo(...at(0.5 - r, centre));
          ctx.closePath();
        }

        ctx.stroke();
      }
    }

    const texture = new THREE.CanvasTexture(atlas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.colorSpace = THREE.NoColorSpace; // it is a mask, not a colour
    texture.needsUpdate = true;
    return { texture, cols, rows };
  }

  const runeAtlas = bakeRuneAtlas();
  const MAGIC_CIRCLE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="4096" height="4096" viewBox="0 0 4096 4096"><rect width="4096" height="4096" fill="#000000"/><defs><style>.font-reggae-one { font-family: "Reggae One", cursive; }\n</style></defs><g stroke="#ffffff" stroke-width="4" fill="none"><line x1="2048" y1="1228.8" x2="2688.47635043781" y2="1537.2371543173256"/><line x1="2048" y1="1228.8" x2="2846.66094565935" y2="2230.289149097013"/><line x1="2048" y1="1228.8" x2="2403.4375590851037" y2="2786.0736965856618"/><line x1="2048" y1="1228.8" x2="1692.5624409148961" y2="2786.0736965856618"/><line x1="2048" y1="1228.8" x2="1249.33905434065" y2="2230.289149097013"/><line x1="2048" y1="1228.8" x2="1407.5236495621898" y2="1537.2371543173256"/><line x1="2688.47635043781" y1="1537.2371543173256" x2="2846.66094565935" y2="2230.289149097013"/><line x1="2688.47635043781" y1="1537.2371543173256" x2="2403.4375590851037" y2="2786.0736965856618"/><line x1="2688.47635043781" y1="1537.2371543173256" x2="1692.5624409148961" y2="2786.0736965856618"/><line x1="2688.47635043781" y1="1537.2371543173256" x2="1249.33905434065" y2="2230.289149097013"/><line x1="2688.47635043781" y1="1537.2371543173256" x2="1407.5236495621898" y2="1537.2371543173256"/><line x1="2846.66094565935" y1="2230.289149097013" x2="2403.4375590851037" y2="2786.0736965856618"/><line x1="2846.66094565935" y1="2230.289149097013" x2="1692.5624409148961" y2="2786.0736965856618"/><line x1="2846.66094565935" y1="2230.289149097013" x2="1249.33905434065" y2="2230.289149097013"/><line x1="2846.66094565935" y1="2230.289149097013" x2="1407.5236495621898" y2="1537.2371543173256"/><line x1="2403.4375590851037" y1="2786.0736965856618" x2="1692.5624409148961" y2="2786.0736965856618"/><line x1="2403.4375590851037" y1="2786.0736965856618" x2="1249.33905434065" y2="2230.289149097013"/><line x1="2403.4375590851037" y1="2786.0736965856618" x2="1407.5236495621898" y2="1537.2371543173256"/><line x1="1692.5624409148961" y1="2786.0736965856618" x2="1249.33905434065" y2="2230.289149097013"/><line x1="1692.5624409148961" y1="2786.0736965856618" x2="1407.5236495621898" y2="1537.2371543173256"/><line x1="1249.33905434065" y1="2230.289149097013" x2="1407.5236495621898" y2="1537.2371543173256"/></g><g fill="#ffffff"><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1494.871109498628, 2759.3829382918325) rotate(217.86650415503348)">ᚹ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1317.652348928071, 2575.834787574404) rotate(234.1437142439773)">ᛞ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1198.9828517788426, 2349.972078885471) rotate(250.42092433292117)">ᛟ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1148.3759116700421, 2099.9013881942665) rotate(266.698134421865)">ᛗ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1169.8884993648785, 1845.6699556360081) rotate(282.97534451080884)">ᛒ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1261.7960304658113, 1607.658572595441) rotate(299.25255459975267)">ᚨ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1416.7306189518, 1404.9477292233373) rotate(315.52976468869656)">ᚦ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1622.2717332841626, 1253.7880022820552) rotate(331.8069747776404)">ᚢ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1861.9419043708901, 1166.2973066555433) rotate(348.0841848665842)">ᚠ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2116.5276631735105, 1149.4894470402821) rotate(364.36139495552806)">ᚨ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2365.6198132859327, 1204.7118472264601) rotate(380.6386050444719)">ᚹ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2589.249560543199, 1327.5375321282906) rotate(396.9158151334158)">ᛞ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2769.4893372153447, 1508.1200219636194) rotate(413.19302522235955)">ᛟ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2891.889988645832, 1731.9826880322269) rotate(429.47023531130344)">ᛗ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2946.6391084100933, 1981.1792903665903) rotate(445.7474454002473)">ᛒ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2929.347662559078, 2235.7326612543743) rotate(462.0246554891911)">ᚨ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2841.4018421985984, 2475.236200708543) rotate(478.301865578135)">ᚦ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2689.8519376876825, 2680.4897979308184) rotate(494.57907566707877)">ᚢ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2486.84714299945, 2835.039033009939) rotate(510.85628575602266)">ᚠ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2248.6615998834513, 2926.4942667611517) rotate(527.1334958449665)">ᚨ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1994.3897602580053, 2947.5238721650503) rotate(543.4107059339103)">ᚹ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1744.415654792623, 2896.4419837237006) rotate(559.6879160228542)">ᛞ</text><text x="0" y="0" font-size="64" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1518.778780743062, 2777.343647047261) rotate(575.965126111798)">ᛟ</text></g><circle cx="2048" cy="2048" r="962.56" fill="none" stroke="#ffffff" stroke-width="4"/><g fill="#ffffff" stroke="none" stroke-width="4"><polygon points="2023.8174152217155,839.6800000000001 2048,819.2 2072.1825847782843,839.6800000000001 2048,860.1600000000001"/><polygon points="2806.168189846781,1106.8289126248012 2837.85741478282,1106.6845882954 2843.218059226098,1137.9174443561521 2811.528834290059,1138.0617686855533"/><polygon points="3233.763642341686,1814.3622369839652 3258.1317669014015,1834.621119282876 3242.1621658977365,1861.9926309390241 3217.794041338021,1841.7337486401134"/><polygon points="3106.5271082899553,2631.2172672528345 3112.1720161703183,2662.3999999999996 3082.3445235116706,2673.102732747165 3076.6996156313076,2641.92"/><polygon points="2483.9939760509556,3175.1784564361747 2468.2743521185816,3202.6942924217237 2438.545583115588,3191.720318659882 2454.265207047962,3164.204482674333"/><polygon points="1657.4544168844116,3191.7203186598827 1627.7256478814184,3202.694292421724 1612.0060239490447,3175.178456436175 1641.7347929520379,3164.2044826743336"/><polygon points="1013.6554764883293,2673.102732747165 983.8279838296818,2662.3999999999996 989.4728917100448,2631.2172672528345 1019.3003843686923,2641.92"/><polygon points="853.8378341022637,1861.9926309390241 837.8682330985989,1834.621119282876 862.2363576583141,1814.3622369839652 878.2059586619789,1841.7337486401134"/><polygon points="1252.781940773902,1137.9174443561521 1258.1425852171803,1106.6845882954 1289.831810153219,1106.8289126248012 1284.4711657099408,1138.0617686855533"/></g><g stroke="#ffffff" stroke-width="4" fill="none"><polygon points="2669.427385685788,509.91324733624765 3575.007091295184,1399.8239455717135 3586.086752663752,2669.427385685788 2696.176054428287,3575.007091295184 1426.5726143142117,3586.086752663752 520.992908704816,2696.176054428287 509.91324733624765,1426.572614314212 1399.8239455717135,520.9929087048158" fill="none"/></g><g stroke="#ffffff" stroke-width="4" fill="none"><polygon points="2048,389.1199999999999 3221.00529717474,874.99470282526 3706.88,2048 3221.00529717474,3221.00529717474 2048,3706.88 874.99470282526,3221.00529717474 389.1199999999999,2048 874.9947028252598,874.99470282526" fill="none"/></g><g stroke="#ffffff" stroke-width="4" fill="none"><path d="M 2048 682.5094669867049 L 3392.7456635762655 1810.885057320796 L 2515.025267811051 3331.1413776256104 L 865.4505097833326 2730.7452665066476 L 1170.2796042347854 1001.973565053594 L 2925.7203957652146 1001.9735650535938 L 3230.5494902166674 2730.7452665066476 L 1580.974732188949 3331.1413776256104 L 703.2543364237345 1810.8850573207958 Z"/></g><g fill="#ffffff"><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(555.7025693511309, 1957.4849179485334) rotate(273.4710146472304)">ᚹ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(596.7094368290552, 1688.9731168130136) rotate(283.8951183685746)">ᛞ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(685.6221248682039, 1432.3124762094233) rotate(294.3192220899187)">ᛟ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(819.505704111969, 1195.9751373518668) rotate(304.7433258112629)">ᛗ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(993.940795777005, 987.7623872014415) rotate(315.16742953260706)">ᛒ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1203.1694514462654, 814.5471448691703) rotate(325.59153325395124)">ᚨ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1440.285217864201, 682.0470926222827) rotate(336.01563697529537)">ᚦ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1697.461112862998, 594.635940239077) rotate(346.43974069663955)">ᚢ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1966.2079871357369, 555.1990527094335) rotate(356.8638444179837)">ᚠ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2237.6547435623675, 565.038206883167) rotate(367.2879481393279)">ᚨ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2502.841164295894, 623.8286209651751) rotate(377.7120518606721)">ᚹ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2753.0136796450925, 729.6296752758399) rotate(388.1361555820163)">ᛞ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2979.9143156839937, 878.9489703938352) rotate(398.56025930336045)">ᛟ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(3176.053282682582, 1066.8576081785832) rotate(408.98436302470463)">ᛗ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(3334.956206455189, 1287.152890347562) rotate(419.4084667460488)">ᛒ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(3451.37784173799, 1532.5630640720242) rotate(429.83257046739294)">ᚨ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(3521.475213105641, 1794.9873561197282) rotate(440.2566741887371)">ᚦ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(3542.9344681982006, 2065.7633722294745) rotate(450.6807779100813)">ᚢ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(3515.0472559452983, 2335.95303510012) rotate(461.1048816314254)">ᚠ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(3438.734108609763, 2596.63762243343) rotate(471.5289853527696)">ᚨ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(3316.5140558301073, 2839.212166085337) rotate(481.9530890741138)">ᚹ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(3152.421473675484, 3055.6694944695273) rotate(492.377192795458)">ᛞ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2951.872913452443, 3238.8645422242585) rotate(502.80129651680215)">ᛟ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2721.4883061270243, 3382.750202513621) rotate(513.2254002381463)">ᛗ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2468.8724442464118, 3482.576936686928) rotate(523.6495039594905)">ᛒ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(2202.3639544490434, 3535.0495523575714) rotate(534.0736076808347)">ᚨ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1930.7600467590655, 3538.435974795316) rotate(544.4977114021789)">ᚦ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1663.0261264479725, 3492.6244211843946) rotate(554.9218151235231)">ᚢ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1407.9998539195853, 3399.1270904755957) rotate(565.3459188448672)">ᚠ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(1174.09942134037, 3261.0302470335864) rotate(575.7700225662113)">ᚨ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(969.0456755460125, 3082.892345774206) rotate(586.1941262875555)">ᚹ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(799.6072597019293, 2870.5935615910653) rotate(596.6182300088997)">ᛞ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(671.3771863664501, 2631.141689972213) rotate(607.0423337302439)">ᛟ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(588.588217082752, 2372.4408258562707) rotate(617.466437451588)">ᛗ</text><text x="0" y="0" font-size="68" class="font-reggae-one" text-anchor="middle" dominant-baseline="middle" transform="translate(553.973142656203, 2103.030456434754) rotate(627.8905411729322)">ᛒ</text></g><circle cx="2048" cy="2048" r="1454.08" fill="none" stroke="#ffffff" stroke-width="4"/><circle cx="2048" cy="2048" r="1658.88" fill="none" stroke="#ffffff" stroke-width="8"/></svg>';
  // ==================================================================================
  // Magic-circle SVG → two spinning layers (2026-08-19).
  //
  // The owner's magic-circle.svg is loaded verbatim (shape 100% preserved — nothing is
  // re-drawn as SDF) and split into TWO textures along the middle circle r=1454:
  //   outer (r > 1454): the heavy outer ring, the {8/1} octagon, the {8/3} star, the
  //                      middle circle and the 35-rune register  → spins CLOCKWISE
  //   inner (r <= 1454): the inner circle, the 8-spike star, the 8 diamonds, the hub
  //                      lines and the 23-rune register            → spins COUNTER-CW
  // Each half is one quad whose shader rotates the SAMPLE point by uSpin*uTime, exactly
  // like the old SDF build, so the two halves turn independently in one draw call each.
  // The texture is drawn with a 1.111 scale-up so the SVG's 1659px outer ring lands on
  // quad radius 0.9 — keeping the mesh.scale /0.9 contract the tuning rows rely on.
  // ==================================================================================
  function splitMagicCircleSvg(svgText) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const root = doc.documentElement;
    const mk = (id) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const attr of ['width', 'height', 'viewBox']) {
        const value = root.getAttribute(attr);
        if (value) el.setAttribute(attr, value);
      }
      el.setAttribute('id', id);
      return el;
    };
    const outer = mk('outer');
    const innerStatic = mk('innerStatic');
    const innerSpin = mk('innerSpin');
    for (const el of root.children) {
      if (el.tagName === 'defs' || el.tagName === 'style') {
        outer.appendChild(el.cloneNode(true));
        innerStatic.appendChild(el.cloneNode(true));
        innerSpin.appendChild(el.cloneNode(true));
      }
    }
    const CENTRE = 2048;
    const radiusOf = (el) => {
      if (el.tagName === 'circle') return parseFloat(el.getAttribute('r') || '0');
      if (el.tagName === 'polygon' || el.tagName === 'polyline') {
        const pts = (el.getAttribute('points') || '').trim().split(/\s+/);
        let max = 0;
        for (const pair of pts) {
          const [x, y] = pair.split(',').map(Number);
          max = Math.max(max, Math.hypot(x - CENTRE, y - CENTRE));
        }
        return max;
      }
      if (el.tagName === 'line') {
        const x1 = +el.getAttribute('x1'),
          y1 = +el.getAttribute('y1');
        const x2 = +el.getAttribute('x2'),
          y2 = +el.getAttribute('y2');
        return Math.max(Math.hypot(x1 - CENTRE, y1 - CENTRE), Math.hypot(x2 - CENTRE, y2 - CENTRE));
      }
      if (el.tagName === 'path') {
        let max = 0;
        for (const m of (el.getAttribute('d') || '').matchAll(
          /(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)/g,
        )) {
          max = Math.max(max, Math.hypot(+m[1] - CENTRE, +m[2] - CENTRE));
        }
        return max;
      }
      if (el.tagName === 'text') {
        const m = (el.getAttribute('transform') || '').match(/translate\(([\d.]+),\s*([\d.]+)\)/);
        return m ? Math.hypot(+m[1] - CENTRE, +m[2] - CENTRE) : 0;
      }
      return 0;
    };
    // Create a <g> wrapper per layer so the cloned elements inherit the same stroke,
    // stroke-width and fill that the original SVG's <g> provided — without it the split
    // layers would draw nothing (no stroke on the individual elements).
    const NS = 'http://www.w3.org/2000/svg';
    const mkG = () => {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('stroke', '#ffffff');
      g.setAttribute('stroke-width', '4');
      g.setAttribute('fill', 'none');
      return g;
    };
    const outerG = mkG();
    const staticG = mkG();
    const spinG = mkG();
    outer.appendChild(outerG);
    innerStatic.appendChild(staticG);
    innerSpin.appendChild(spinG);
    // Walk every leaf element (not the container <g>), clone it, and place it in the
    // correct layer — the <g> wrapper above restores the presentation attributes.
    //
    // Three rotation groups (owner 2026-08-19):
    //   r >= 1454  -> OUTER half-ring, spins CLOCKWISE   (outer ring + octagon + star +
    //                                                      middle circle + outer runes)
    //   1209..1454 -> INNER STATIC band, holds still     (the 8 diamonds + the 8-spike
    //                                                      star the owner wants fixed)
    //   r < 1209   -> INNER SPIN band, spins COUNTER-CW  (inner circle + inner runes +
    //                                                      the hub)
    for (const el of root.querySelectorAll('circle, polygon, polyline, path, line, text')) {
      const r = radiusOf(el);
      const target = r >= 1454 ? outerG : r >= 1209 ? staticG : spinG;
      target.appendChild(el.cloneNode(true));
    }
    const serialize = (node) => new XMLSerializer().serializeToString(node);
    return {
      outer: serialize(outer),
      innerStatic: serialize(innerStatic),
      innerSpin: serialize(innerSpin),
    };
  }

  // Rasterise an SVG string to a canvas texture. SVG → Image (data URI) → canvas, so the
  // standalone file needs no server and the shape is bit-for-bit the owner's artwork.
  function makeSvgTexture(svgText) {
    const SIZE = 2048;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.NoColorSpace; // it is a mask, not a colour
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const img = new Image();
    img.onload = () => {
      // Full-viewBox map: viewBox 4096 → canvas SIZE. The SVG's 1659px outer ring lands
      // on quad radius 1659/2048 ≈ 0.81 — the mesh.scale contract that lands the figure
      // on spec.radius uses the same 0.81 (see buildMagicCircle / applyCircleRadius).
      // Do NOT crop a centred window here: that silently trims every element beyond the
      // window's edge (the bug that showed only the inner ring).
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      texture.needsUpdate = true;
    };
    img.onerror = () => console.warn('magic-circle svg layer failed to load');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
    return texture;
  }

  // A quad material that samples an SVG mask and rotates the SAMPLE point by uSpin*uTime,
  // tinted gold with a charge bead on the rim (comet trail compatibility).
  function buildSpinningLayer(tex, spec) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uDial: { value: 1 },
        uTint: { value: spec.tint.clone() },
        uHot: { value: spec.hot.clone() },
        uSpin: { value: spec.spin },
        uRunRate: { value: spec.runRate },
        uIntensity: { value: spec.intensity },
        tSvg: { value: tex },
      },
      vertexShader: /* glsl */ `
      varying vec2 vPos;
      void main() {
        vPos = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
      fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uDial;
      uniform vec3 uTint;
      uniform vec3 uHot;
      uniform float uSpin;
      uniform float uRunRate;
      uniform float uIntensity;
      uniform sampler2D tSvg;
      varying vec2 vPos;
      void main() {
        float a = uTime * uSpin;
        float ca = cos(a);
        float sa = sin(a);
        vec2 q = mat2(ca, sa, -sa, ca) * vPos;
        vec2 uv = q * 0.5 + 0.5;
        float mask = texture2D(tSvg, uv).r;
        if (mask < 0.02) discard;
        // One charge bead on the rim, driven by the UNROTATED coordinate so the motes
        // that ride it never slide off their own head.
        float head = fract(uTime * uRunRate);
        float angle01 = atan(vPos.y, vPos.x) / 6.28318530718;
        float around = abs(fract(angle01 - head + 0.5) - 0.5);
        float travel = pow(max(0.0, 1.0 - around * 8.0), 3.0);
        float glow = exp(-abs(length(vPos) - 0.81) * 22.0) * 0.15;
        vec3 color = uTint * (mask + glow) + uHot * travel * mask * 1.6;
        gl_FragColor = vec4(color * uIntensity * uDial, 1.0);
      }
    `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.frustumCulled = false;
    return { mesh, material };
  }

  // ==================================================================================
  // Annulus. uv.x is angle (0..1 round the circle), uv.y is radial (0 inner, 1 outer).
  // Three's own RingGeometry maps uv over the bounding box instead, which is useless for
  // anything that wants to be addressed in polar coordinates.
  // ==================================================================================
  function buildAnnulus(inner, outer, segments = 640) {
    const vertexCount = (segments + 1) * 2;
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices = [];

    for (let index = 0; index <= segments; index += 1) {
      const t = index / segments;
      const angle = t * TAU;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      const innerVertex = index * 2;
      const outerVertex = innerVertex + 1;
      positions[innerVertex * 3] = cos * inner;
      positions[innerVertex * 3 + 1] = sin * inner;
      positions[outerVertex * 3] = cos * outer;
      positions[outerVertex * 3 + 1] = sin * outer;
      uvs[innerVertex * 2] = t;
      uvs[innerVertex * 2 + 1] = 0;
      uvs[outerVertex * 2] = t;
      uvs[outerVertex * 2 + 1] = 1;

      if (index < segments) {
        indices.push(innerVertex, outerVertex, innerVertex + 2);
        indices.push(outerVertex, outerVertex + 2, innerVertex + 2);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    return geometry;
  }

  // ==================================================================================
  // Rune register.
  //
  // Each rune keeps its own brightness and its own breath rate, so the register never
  // pulses as one object — a ring of identically-lit glyphs reads as printed type rather
  // than as something charged. On top of that there is ONE charge running round the
  // ring: the beat that says something is operating this.
  //
  // These live in the galaxy's own plane, so they tilt and drift with the disc and read
  // as belonging to it. A ring pasted flat across the frame would read as UI.
  // ==================================================================================
  function buildRuneRegister(spec) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uDial: { value: 1 },
        tGlyphs: { value: glyphAtlas.texture },
        uRow: { value: spec.row },
        uRows: { value: glyphAtlas.rows },
        uCols: { value: glyphAtlas.cols },
        uSpin: { value: spec.spin },
        uRepeat: { value: spec.repeat },
        uRunRate: { value: spec.runRate },
        uIntensity: { value: spec.intensity },
        uShift: { value: spec.shift },
        uChroma: { value: spec.chroma },
        uTint: { value: spec.tint.clone() },
        uHot: { value: spec.hot.clone() },
      },
      vertexShader: RING_VERTEX,
      fragmentShader: /* glsl */ `
      ${HASH_HEAD}
      uniform sampler2D tGlyphs;
      uniform float uTime;
      uniform float uDial;
      uniform float uRow;
      uniform float uRows;
      uniform float uCols;
      uniform float uSpin;
      uniform float uRepeat;
      uniform float uRunRate;
      uniform float uIntensity;
      uniform float uShift;
      uniform float uChroma;
      uniform vec3 uTint;
      uniform vec3 uHot;
      varying vec2 vUv;

      // Map a band coordinate into this register's row of the atlas. The clamp is what
      // stops a chromatic offset near the band edge from sampling the NEXT row's runes.
      float rowV(float t) {
        return (uRow + clamp(t, 0.0, 1.0)) / uRows;
      }

      void main() {
        // uRepeat lays the 32-glyph atlas round the ring more than once. Without it the
        // cell width is circumference/32, which at this radius is nearly a world unit —
        // the first build put runes the size of billboards round the disc. Keep it an
        // integer or the seam at vUv.x = 1 tears a glyph in half.
        float turn = vUv.x + uSpin * uTime;
        float u = fract(turn * uRepeat);

        // Authored chromatic aberration: the glyph mask is sampled three times, one per
        // channel, offset ACROSS the band. This is what a lens does to a bright thin
        // source, and doing it here rather than in the post chain means it can run at
        // full strength on the runes without smearing the whole frame to match.
        float mr = texture2D(tGlyphs, vec2(u, rowV(vUv.y + uShift))).r;
        float mg = texture2D(tGlyphs, vec2(u, rowV(vUv.y))).r;
        float mb = texture2D(tGlyphs, vec2(u, rowV(vUv.y - uShift))).r;
        float mask = mg;
        if (max(mr, max(mg, mb)) < 0.004) discard;

        // Only where the channels DISAGREE — i.e. at a stroke edge. The interior, where
        // all three sample the same solid stroke, stays exactly the register's own
        // colour, so this reads as a fringe rather than as a rainbow rune.
        vec3 fringe = max(vec3(mr, mg, mb) - mg, 0.0) * uChroma;

        // Seed off the GLOBAL cell index, not the within-atlas one, so the repeats do
        // not light identically and the repetition stops being legible.
        float cell = floor(turn * uRepeat * uCols);
        float seed = hash11(cell + uRow * 31.7);
        float breath = 0.5 + 0.5 * sin(uTime * (0.28 + seed * 0.85) + seed * 24.0);
        float bright = (0.3 + pow(seed, 1.7) * 1.5) * (0.45 + 0.55 * breath);

        // One charge, running the ring ONCE per lap — driven by vUv.x, not by the
        // repeated coordinate, or there would be one charge per repetition.
        float head = fract(uTime * uRunRate);
        float around = abs(fract(vUv.x - head + 0.5) - 0.5);
        float travel = pow(max(0.0, 1.0 - around * 9.0), 3.0);

        // Soft radial edges so the band resolves into the field rather than ending.
        float edge = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.88, 1.0, vUv.y));

        vec3 color = (uTint * mask + fringe) * bright + uHot * travel * 2.2 * mask;
        gl_FragColor = vec4(color * edge * uIntensity * uDial, 1.0);
      }
    `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(buildAnnulus(spec.inner, spec.outer), material);
    mesh.frustumCulled = false;
    return { mesh, material };
  }

  // ==================================================================================
  // Rail — a thin bright ring with an authored chromatic fringe, same construction as
  // the arcs: the cross-section profile is evaluated three times at three slightly
  // different offsets, which is what a lens does to a bright thin source. It survives at
  // full strength where a global RGB shift would have to smear the whole frame to get
  // the same edge.
  // ==================================================================================
  function buildRail(spec) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uDial: { value: 1 },
        uTint: { value: spec.tint.clone() },
        uIntensity: { value: spec.intensity },
        uShift: { value: spec.shift },
        uSoft: { value: spec.soft },
        uRunRate: { value: spec.runRate || 0 },
      },
      vertexShader: RING_VERTEX,
      fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uDial;
      uniform vec3 uTint;
      uniform float uIntensity;
      uniform float uShift;
      uniform float uSoft;
      uniform float uRunRate;
      varying vec2 vUv;

      float profile(float v, float k) {
        return pow(max(0.0, 1.0 - abs(v)), k);
      }

      void main() {
        float v = vUv.y * 2.0 - 1.0;
        float r = profile(v + uShift, uSoft);
        float g = profile(v, uSoft);
        float b = profile(v - uShift, uSoft);
        float core = profile(v, uSoft * 7.0);

        float travel = 1.0;
        if (uRunRate > 0.0) {
          float head = fract(uTime * uRunRate);
          float around = abs(fract(vUv.x - head + 0.5) - 0.5);
          travel = 1.0 + pow(max(0.0, 1.0 - around * 6.0), 3.0) * 2.2;
        }

        vec3 color = vec3(r, g, b) * uTint + vec3(1.0) * core * 1.2;
        gl_FragColor = vec4(color * uIntensity * travel * uDial, 1.0);
      }
    `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(
      buildAnnulus(spec.radius - spec.width, spec.radius + spec.width),
      material,
    );
    mesh.frustumCulled = false;
    return { mesh, material };
  }

  // ==================================================================================
  // Magic circle — the seal. (2026-08-19: rebuilt from the owner's magic-circle.svg.)
  //
  // Where v2 had "one circle with a pentagram inscribed in it", this is now a two-layer
  // instrument in ONE quad and ONE distance field, split on the radius of the SVG's
  // middle circle (r=1454/1659 = 0.877 of the outer ring):
  //
  //   OUTER half-ring (r > SPLIT, spinning CLOCKWISE via +uSpin): the heavy outer
  //     circle, the {8/1} octagon and the {8/3} star that share its rim, the middle
  //     circle, and the outer rune register (35 runes).
  //   INNER half-ring (r <= SPLIT, spinning COUNTER-CLOCKWISE via uSpinInner): the inner
  //     circle, an {8/3} star, eight diamonds on a ring, the hub (hexagon + spokes), and
  //     the inner rune register (23 runes — a broken seal, not a closed one).
  //
  // The spin split keys off the UNROTATED sample radius and is applied to the sample
  // point, so each half turns independently while still being one draw call. The rune
  // registers are sampled from `runeAtlas` in the same shader — row 0 (35 cols) for the
  // outer ring, row 1 for the inner — so the figure and its inscription can never
  // separate. All radii below are QUAD units with the outer ring at 0.9 (matching the
  // old build, so `mesh.scale` still lands the figure on spec.radius).
  //
  // One charge still runs the outer ring (driven by UNROTATED vPos so the comet trail
  // does not slide off its own head), and the outer and inner halves breathe at
  // unrelated rates so the instrument reads as a mechanism rather than one flat decal.
  // ==================================================================================
  function buildMagicCircle(spec) {
    const { outer, innerStatic, innerSpin } = splitMagicCircleSvg(MAGIC_CIRCLE_SVG);
    const outerLayer = buildSpinningLayer(makeSvgTexture(outer), {
      tint: PALETTE.coreGold,
      hot: PALETTE.coreHot,
      spin: spec.spin,
      runRate: spec.runRate,
      intensity: spec.intensity,
    });
    // The static band holds still (spin 0): the owner wants the diamonds + 8-spike star
    // fixed while the inner seal and the outer ring both turn against it. All three
    // layers stay in the gold family (owner 2026-08-19) — depth comes from the z sliders
    // and from the intensity falloff, not from changing the colour.
    const staticLayer = buildSpinningLayer(makeSvgTexture(innerStatic), {
      tint: PALETTE.coreGold,
      hot: PALETTE.coreHot,
      spin: 0,
      runRate: 0,
      intensity: spec.intensity * 0.8,
    });
    const spinLayer = buildSpinningLayer(makeSvgTexture(innerSpin), {
      tint: PALETTE.coreGold,
      hot: PALETTE.coreHot,
      spin: spec.spinInner,
      runRate: spec.runRate,
      intensity: spec.intensity * 0.72,
    });
    // Both inner bands are CHILDREN of the outer mesh: they inherit its position/scale/
    // tilt for free, and only their own spins differ (0 = static). The z-offsets keep
    // additive blending from smearing the three layers into one.
    // Startup values only: setupTuning() sync()s every row before the first frame, so
    // TUNING_DEFAULTS and the slider markup are what actually decide these. Kept in step
    // with them so the build call is not a lie about where the layers sit.
    staticLayer.mesh.position.z = -0.06;
    spinLayer.mesh.position.z = -0.08;
    outerLayer.mesh.add(staticLayer.mesh);
    outerLayer.mesh.add(spinLayer.mesh);
    const mesh = outerLayer.mesh;
    // Quad space puts the SVG's 1659px outer ring at quad radius 1659/2048 (≈0.81), so
    // this is what lands it on spec.radius world units rather than on the quad's edge.
    mesh.scale.setScalar((spec.radius * 2.0) / (1659 / 2048));
    mesh.frustumCulled = false;
    return {
      mesh,
      material: outerLayer.material,
      staticMesh: staticLayer.mesh,
      staticMaterial: staticLayer.material,
      innerMesh: spinLayer.mesh,
      innerMaterial: spinLayer.material,
    };
  }

  // ==================================================================================
  // Layer 3c — the orbit rings.
  //
  // This is what turns an astronomical picture into a magical one, and it is the cue
  // taken from the Zooming Spiral reference: many thin concentric strokes converging on
  // a centre. A photograph of a galaxy is beautiful and inert; a galaxy with a ring
  // system drawn around it in light is an INSTRUMENT, and an instrument implies someone
  // operating it. That is the whole difference between "looks good" and "looks magical".
  //
  // Forty-odd rings in ONE draw call: they are a fract() pattern over radius, so the
  // count is a uniform rather than forty pieces of geometry. Width is resolved with
  // fwidth so they antialias themselves at any distance and never alias into moire — the
  // failure that ate v2's outer bands whenever the camera tilted low.
  // ==================================================================================
  function buildRingField(spec) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uDial: { value: 1 },
        uInner: { value: spec.inner },
        uCount: { value: spec.count },
        uGold: { value: PALETTE.coreGold.clone() },
        uCyan: { value: PALETTE.armCyan.clone() },
        uHot: { value: PALETTE.coreHot.clone() },
      },
      vertexShader: /* glsl */ `
      varying vec2 vPos;
      void main() {
        vPos = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
      fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uDial;
      uniform float uInner;
      uniform float uCount;
      uniform vec3 uGold;
      uniform vec3 uCyan;
      uniform vec3 uHot;
      varying vec2 vPos;

      float hash11(float n) {
        return fract(sin(n * 127.1) * 43758.5453123);
      }

      void main() {
        float r = length(vPos);
        if (r > 1.0 || r < uInner) discard;

        // pow() spaces the rings unevenly — evenly spaced rings read as a machined
        // grating, uneven ones read as something that was drawn.
        float phase = pow(r, 0.82) * uCount;
        float id = floor(phase);
        float f = fract(phase);

        // Screen-space-correct line width: fwidth is the whole reason this can carry
        // forty rings to the horizon without turning into interference fringes.
        float aa = max(fwidth(phase), 1e-5);
        float dist = min(f, 1.0 - f);
        float seed = hash11(id);
        float weight = 0.16 + seed * 0.5;
        float line = 1.0 - smoothstep(0.0, aa * (1.2 + weight * 2.2), dist);

        // Each ring keeps its own brightness and its own slow breath, so the set never
        // pulses as one object.
        float breath = 0.45 + 0.55 * sin(uTime * (0.18 + seed * 0.5) + seed * 20.0);
        // Skewed hard, not spread evenly: with a linear ramp every ring lands at a
        // similar value and the set reads as a contour map. pow(seed, 2.4) keeps most
        // of them near-invisible and lets three or four carry the whole figure.
        float bright = (0.1 + pow(seed, 2.4) * 1.55) * (0.5 + 0.5 * breath);
        bright *= 1.0 - smoothstep(0.25, 0.95, r) * 0.6;

        // One charge travelling outward through the whole system. This is the "someone
        // is operating it" beat; without it the rings are just decoration.
        float pulseFront = fract(uTime * 0.045);
        float travel = pow(max(0.0, 1.0 - abs(r - pulseFront * 1.25) * 7.0), 3.0);

        // Angular gaps: a broken arc reads as drawn, a closed circle reads as printed.
        float angle = atan(vPos.y, vPos.x);
        float gate = smoothstep(0.15, 0.5, abs(sin(angle * (1.0 + floor(seed * 4.0)) + seed * 9.0)));
        gate = mix(1.0, gate, step(0.55, seed));

        float fade = smoothstep(uInner, uInner + 0.12, r) * (1.0 - smoothstep(0.72, 1.0, r));

        vec3 tint = mix(uCyan, uGold, step(0.5, hash11(id + 7.3)));
        // The travelling charge is deliberately quieter here than in the un-runed
        // build: with rune registers outside them, orbit arcs that flare to white read
        // as hard CG ellipses laid over the disc rather than as light moving through a
        // system. There is more in the frame now, so each element gets less of it.
        vec3 color = tint * bright + uHot * travel * 0.85;
        gl_FragColor = vec4(color * line * gate * fade * (0.5 + travel * 1.1) * 0.5 * uDial, 1.0);
      }
    `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.scale.setScalar(spec.outer * 2);
    mesh.frustumCulled = false;
    return { mesh, material };
  }

  // ==================================================================================
  // Layer 4 — the core.
  //
  // A camera-facing quad with an analytic falloff, plus a wide anamorphic streak. The
  // streak is the single cheapest thing that reads as "expensive render" — real
  // spherical optics do it, so its absence is what makes CG glows look like decals.
  // ==================================================================================
  function buildCore() {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uDial: { value: 1 },
        uHot: { value: PALETTE.coreHot.clone() },
        uGold: { value: PALETTE.coreGold.clone() },
      },
      vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
      fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uDial;
      uniform vec3 uHot;
      uniform vec3 uGold;
      varying vec2 vUv;

      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        float d = length(p);

        // Three nested falloffs: a broad halo, a tight core, and a pinpoint. Summing
        // powers of the same distance is what gives a glow a shoulder instead of a
        // linear ramp, and the shoulder is the part the eye reads as brightness.
        float halo = pow(max(0.0, 1.0 - d), 3.0) * 0.34;
        float core = pow(max(0.0, 1.0 - d), 9.0) * 0.8;
        float pin = pow(max(0.0, 1.0 - d), 40.0) * 1.7;

        // Anamorphic streak: wide in x, razor thin in y. Kept quiet — draft one had it
        // at 0.55 and the piece read as a lens flare with a galaxy behind it.
        float streak = pow(max(0.0, 1.0 - abs(p.y) * 16.0), 3.0)
                     * pow(max(0.0, 1.0 - abs(p.x) * 1.05), 2.4) * 0.3;

        float breathe = 0.9 + 0.1 * sin(uTime * 0.42);
        vec3 color = uGold * (halo + streak * 0.55) + uHot * (core + pin + streak * 0.45);
        gl_FragColor = vec4(color * breathe * uDial, 1.0);
      }
    `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.scale.set(5.0, 5.0, 1);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { mesh, material };
  }

  // ==================================================================================
  // Layer 5 — the arc.
  //
  // This is the "Chromatic Aberration WebGL Sine Wave" reference, rebuilt rather than
  // copied: a wide shallow smile low in the frame, white at the centreline with red
  // riding one edge and blue the other.
  //
  // The fringe is NOT the post-process aberration. It comes from evaluating the arc's
  // own cross-section profile three times at three slightly different offsets, which is
  // what a lens actually does to a bright thin source, and it survives at full strength
  // where a global RGB shift would smear the entire frame to get the same edge.
  //
  // Geometry is a static ribbon; the undulation is a vertex displacement that depends
  // only on position ALONG the arc, so both edge vertices of a rib move together and
  // the ribbon waves without changing width.
  // ==================================================================================
  function buildArc(spec) {
    const SEGMENTS = 300;
    const positions = new Float32Array((SEGMENTS + 1) * 2 * 3);
    const params = new Float32Array((SEGMENTS + 1) * 2 * 2); // t, v
    const indices = [];

    for (let i = 0; i <= SEGMENTS; i += 1) {
      const t = i / SEGMENTS;
      const x = (t - 0.5) * 2 * spec.span;
      const norm = x / spec.span;
      // Quadratic smile plus a long slow tilt, so it is not a symmetric bowl.
      const y = spec.y + spec.sag * norm * norm + spec.tilt * norm;
      const z = spec.z - spec.depth * norm * norm;
      // Taper the ends to nothing: a ribbon that runs off-frame at full width reads as
      // a mistake in a composition this empty.
      //
      // taperFloor is why v2's ribbons end bluntly: at 0.25 the tip is still a quarter
      // of full width when the geometry runs out. Off-frame that is invisible; for an
      // arc that resolves inside the picture it has to reach 0 or it reads as a cut.
      const taperFloor = spec.taperFloor === undefined ? 0.25 : spec.taperFloor;
      const taperPow = spec.taperPow === undefined ? 0.55 : spec.taperPow;
      const taper = Math.pow(Math.max(0, 1 - Math.abs(norm)), taperPow);
      const width = spec.width * (taperFloor + (1 - taperFloor) * taper);

      for (let side = 0; side < 2; side += 1) {
        const v = side === 0 ? -1 : 1;
        const base = (i * 2 + side) * 3;
        positions[base] = x;
        positions[base + 1] = y + v * width;
        positions[base + 2] = z;
        params[(i * 2 + side) * 2] = t;
        params[(i * 2 + side) * 2 + 1] = v;
      }

      if (i < SEGMENTS) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aParam', new THREE.BufferAttribute(params, 2));
    geometry.setIndex(indices);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uDial: { value: 1 },
        uTint: { value: spec.tint.clone() },
        uIntensity: { value: spec.intensity },
        uShift: { value: spec.shift },
        uSoft: { value: spec.soft },
        uAmp: { value: spec.amp },
        uPhase: { value: spec.phase },
        uFade: { value: spec.fade === undefined ? 0.16 : spec.fade },
      },
      vertexShader: /* glsl */ `
      attribute vec2 aParam;
      uniform float uTime;
      uniform float uAmp;
      uniform float uPhase;
      varying float vT;
      varying float vV;

      void main() {
        vT = aParam.x;
        vV = aParam.y;

        // Depends on t only, never on v, so the two vertices of a rib move as one.
        float wave = sin(vT * 7.3 + uTime * 0.42 + uPhase) * 0.62
                   + sin(vT * 3.1 - uTime * 0.27 + uPhase * 1.7) * 1.0
                   + sin(vT * 13.7 + uTime * 0.61) * 0.18;

        vec3 p = position;
        p.y += wave * uAmp;
        p.z += cos(vT * 5.1 + uTime * 0.23 + uPhase) * uAmp * 1.4;

        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
      fragmentShader: /* glsl */ `
      uniform vec3 uTint;
      uniform float uIntensity;
      uniform float uShift;
      uniform float uSoft;
      uniform float uDial;
      uniform float uTime;
      uniform float uFade;
      varying float vT;
      varying float vV;

      float profile(float v, float k) {
        return pow(max(0.0, 1.0 - abs(v)), k);
      }

      void main() {
        // Three samples of the same cross-section, offset per channel. Red rides the
        // -v edge, blue the +v edge, and where all three overlap you get white.
        float r = profile(vV + uShift, uSoft);
        float g = profile(vV, uSoft);
        float b = profile(vV - uShift, uSoft);
        vec3 split = vec3(r, g, b);

        float core = profile(vV, uSoft * 7.0);

        // Fade the ends so the ribbon resolves into the field instead of stopping.
        // Raised to a power as well as widened: a plain smoothstep still leaves a
        // visible shoulder where the fade begins, which on a long thin ribbon looks
        // like the line changing weight rather than dying away.
        float ends = smoothstep(0.0, uFade, vT) * (1.0 - smoothstep(1.0 - uFade, 1.0, vT));
        ends = pow(ends, 1.6);

        // One slow bright travelling along it, so the arc is alive without moving.
        float travel = pow(max(0.0, sin(vT * 3.14159 - uTime * 0.17)), 5.0);

        vec3 color = split * uTint * (0.85 + travel * 0.9);
        color += vec3(1.0) * core * (1.1 + travel * 1.4);

        gl_FragColor = vec4(color * uIntensity * ends * uDial, 1.0);
      }
    `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    // Stood up here rather than baked into the vertex loop so the wave, which runs
    // along local X, still travels ALONG the ribbon after it is vertical.
    mesh.rotation.z = spec.rot || 0;
    scene.add(mesh);
    return { mesh, material, spec };
  }

  // ==================================================================================
  // Layer 6 — starfall.
  //
  // Quads, not GL lines: line width is locked to 1px on every WebGL implementation, and
  // a 1px streak against bloom is a dotted artefact rather than a meteor. Each meteor is
  // one quad whose head and tail positions are solved in the vertex shader from a
  // per-meteor seed, so the buffer is static and nothing is uploaded per frame.
  // ==================================================================================
  function buildMeteors() {
    const COUNT = 11;
    const vertexCount = COUNT * 4;
    const start = new Float32Array(vertexCount * 3);
    const dir = new Float32Array(vertexCount * 3);
    const perp = new Float32Array(vertexCount * 3);
    const params = new Float32Array(vertexCount * 4); // u, v, seed, rate
    const shape = new Float32Array(vertexCount * 2); // travel, width
    const indices = [];

    const forward = new THREE.Vector3(0, 0, 1);
    const direction = new THREE.Vector3();
    const sideways = new THREE.Vector3();

    for (let meteor = 0; meteor < COUNT; meteor += 1) {
      // Enter high and to one side, exit low and across. Mixed handedness, or they read
      // as rain.
      const handed = Math.random() < 0.5 ? -1 : 1;
      const originX = handed * (7 + Math.random() * 13);
      const originY = 5 + Math.random() * 9;
      const originZ = -6 - Math.random() * 22;
      direction
        .set(-handed * (0.55 + Math.random() * 0.5), -(0.72 + Math.random() * 0.4), 0.06)
        .normalize();
      sideways.crossVectors(direction, forward).normalize();

      const seed = Math.random();
      const rate = 0.028 + Math.random() * 0.03;
      const travel = 22 + Math.random() * 16;
      const width = 0.035 + Math.random() * 0.05;

      for (let corner = 0; corner < 4; corner += 1) {
        const vertex = meteor * 4 + corner;
        const u = corner < 2 ? 0 : 1; // 0 tail, 1 head
        const v = corner % 2 === 0 ? -1 : 1;

        start[vertex * 3] = originX;
        start[vertex * 3 + 1] = originY;
        start[vertex * 3 + 2] = originZ;
        dir[vertex * 3] = direction.x;
        dir[vertex * 3 + 1] = direction.y;
        dir[vertex * 3 + 2] = direction.z;
        perp[vertex * 3] = sideways.x;
        perp[vertex * 3 + 1] = sideways.y;
        perp[vertex * 3 + 2] = sideways.z;

        params[vertex * 4] = u;
        params[vertex * 4 + 1] = v;
        params[vertex * 4 + 2] = seed;
        params[vertex * 4 + 3] = rate;
        shape[vertex * 2] = travel;
        shape[vertex * 2 + 1] = width;
      }

      const base = meteor * 4;
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }

    const geometry = new THREE.BufferGeometry();
    // `position` is required by three's shader plumbing even though every coordinate is
    // solved in the vertex shader; the start attribute is the real anchor.
    geometry.setAttribute('position', new THREE.BufferAttribute(start, 3));
    geometry.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    geometry.setAttribute('aPerp', new THREE.BufferAttribute(perp, 3));
    geometry.setAttribute('aParam', new THREE.BufferAttribute(params, 4));
    geometry.setAttribute('aShape', new THREE.BufferAttribute(shape, 2));
    geometry.setIndex(indices);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uDial: { value: 1 },
        uTint: { value: PALETTE.meteor.clone() },
        uWarm: { value: PALETTE.starWarm.clone() },
        uTail: { value: 4.2 },
      },
      vertexShader: /* glsl */ `
      attribute vec3 aDir;
      attribute vec3 aPerp;
      attribute vec4 aParam;
      attribute vec2 aShape;
      uniform float uTime;
      uniform float uTail;
      varying float vU;
      varying float vV;
      varying float vAlpha;

      void main() {
        float u = aParam.x;
        float seed = aParam.z;
        float rate = aParam.w;
        float travel = aShape.x;
        float width = aShape.y;

        float cycle = fract(uTime * rate + seed);
        float head = cycle * travel;
        // Clamping the tail at 0 makes the streak GROW out of nothing at launch
        // instead of appearing full length, which is both correct and prettier.
        float tail = max(0.0, head - uTail);
        float along = mix(tail, head, u);

        // The streak is a wedge: wide at the head, pinched at the tail.
        vec3 p = position + aDir * along + aPerp * aParam.y * width * (0.18 + 0.82 * u);

        // Visible for the first fifth of the cycle only; the rest is the wait. With 11
        // meteors that averages about two on screen, which is an event rather than
        // weather.
        vAlpha = smoothstep(0.0, 0.015, cycle) * (1.0 - smoothstep(0.10, 0.20, cycle));
        vU = u;
        vV = aParam.y;

        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
      fragmentShader: /* glsl */ `
      uniform vec3 uTint;
      uniform vec3 uWarm;
      uniform float uDial;
      varying float vU;
      varying float vV;
      varying float vAlpha;

      void main() {
        float across = pow(max(0.0, 1.0 - abs(vV)), 2.0);
        float along = pow(vU, 2.6);
        vec3 color = mix(uTint, uWarm, pow(vU, 6.0) * 0.55);
        float core = pow(vU, 22.0);
        gl_FragColor = vec4((color * along + vec3(1.0) * core) * across * vAlpha * 2.4 * uDial, 1.0);
      }
    `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { mesh, material };
  }

  // ==================================================================================
  // Layer 7 — foreground dust.
  //
  // Close to the camera, large, dim and soft: these never read as objects, they read as
  // the lens having something in front of it. This is the layer that does most of the
  // work in the pointer parallax, because it moves furthest per degree.
  // ==================================================================================
  function buildDust() {
    const COUNT = 620;
    const positions = new Float32Array(COUNT * 3);
    const scalars = new Float32Array(COUNT * 3); // size, seed, brightness

    for (let index = 0; index < COUNT; index += 1) {
      positions[index * 3] = (Math.random() - 0.5) * 26;
      positions[index * 3 + 1] = (Math.random() - 0.5) * 18;
      positions[index * 3 + 2] = 2 + Math.random() * 13;
      scalars[index * 3] = 0.02 + Math.pow(Math.random(), 2.0) * 0.09;
      scalars[index * 3 + 1] = Math.random() * TAU;
      scalars[index * 3 + 2] = 0.1 + Math.pow(Math.random(), 2.4) * 0.55;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aScalar', new THREE.BufferAttribute(scalars, 3));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uProjScale,
        uTint: { value: PALETTE.starCool.clone() },
      },
      vertexShader: /* glsl */ `
      attribute vec3 aScalar;
      uniform float uTime;
      uniform float uProjScale;
      varying float vBright;

      void main() {
        float seed = aScalar.y;
        vec3 p = position;
        // Slow lissajous drift. Two unrelated rates per axis so nothing in the field
        // ever moves in step with anything else.
        p.x += sin(uTime * 0.07 + seed) * 0.9 + sin(uTime * 0.031 + seed * 2.3) * 0.5;
        p.y += cos(uTime * 0.055 + seed * 1.7) * 0.7 - uTime * 0.045;
        p.y = mod(p.y + 9.0, 18.0) - 9.0;

        vBright = aScalar.z * (0.55 + 0.45 * sin(uTime * 0.5 + seed * 3.7));

        vec4 viewPos = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * viewPos;
        gl_PointSize = clamp(aScalar.x * uProjScale / -viewPos.z, 1.0, 26.0);
      }
    `,
      fragmentShader: /* glsl */ `
      ${POINT_HEAD}
      uniform vec3 uTint;
      varying float vBright;

      void main() {
        gl_FragColor = vec4(uTint * sprite(gl_PointCoord) * vBright * 0.3, 1.0);
      }
    `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);
    return { points, material };
  }

  // ==================================================================================
  // Layer 3f — rune sparkles. (Particle pass; header note 5a.)
  //
  // Glints shed from the two rune registers. The load-bearing idea is that a spark is
  // NOT decoration scattered near a band — it belongs to ONE GLYPH CELL and inherits
  // that cell's brightness, its breath rate and its share of the travelling charge, by
  // re-deriving them from the register's own formulas. That is what makes the band read
  // as burning rather than as printed: the sparks arrive where the runes are bright and
  // flare in step with the charge sweeping past.
  //
  // Everything about a spark is computed in the vertex shader from three numbers baked
  // once into `position` (see below) plus uTime, so respawn costs nothing and there is
  // never a buffer upload. Only the BAND GEOMETRY comes in as uniforms — refreshed from
  // `tuning` every frame by sync(), so the sparks follow the R and z sliders live.
  //
  // `position` is a carrier, not a location. The vertex shader never uses it as one:
  //   x = base band-uv (0..1 round the ring)   y = lifetime phase   z = per-spark seed
  // It has to be called `position` because that is the attribute three reads to decide
  // how many points to draw.
  // ==================================================================================
  function buildRuneSparks(registers) {
    // BUFFED after looking at the first pass at 1280x720 (2026-08-10). It was correct
    // and it was invisible, for a measurable reason: sparks were authored at ~0.016
    // world radius in a scene whose galaxy points are 0.022-0.077 and whose dust is
    // allowed 26 px. At this camera uProjScale/-z is about 52 px per world unit, so
    // 0.016 resolved to 0.8 px — i.e. every spark was clamped to the 1 px floor and the
    // whole layer was grey dust. Three changes, in the order they mattered: an IGNITION
    // FLARE (a momentary event is what the eye catches; steady drift of small dots is
    // exactly what peripheral vision is built to discard), bigger off-plane travel so a
    // spark separates from the glyph it came off instead of sitting on it, and size —
    // which then had to be walked back to the galaxy's own scale, with the light it was
    // carrying moved into peak brightness instead. See gl_PointSize below.
    const PER_BAND = 1200;
    const COUNT = PER_BAND * 2; // two bands; `band` is used as a mix() factor below
    const LIFE = 6.0; // seconds, before phase offset — shorter, so ignitions are frequent

    const carrier = new Float32Array(COUNT * 3);
    const params = new Float32Array(COUNT * 2);
    for (let index = 0; index < COUNT; index += 1) {
      const band = index < PER_BAND ? 0 : 1;
      carrier[index * 3] = Math.random();
      // Phase is uniform over the whole life, which is what stops the field pulsing as
      // one sheet — the failure a shared spawn time always produces.
      carrier[index * 3 + 1] = Math.random();
      carrier[index * 3 + 2] = Math.random() * 97.3 + 0.13;
      params[index * 2] = Math.random();
      params[index * 2 + 1] = band;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(carrier, 3));
    geometry.setAttribute('aSpark', new THREE.BufferAttribute(params, 2));

    // Read straight off the live registers rather than repeating their literals. These
    // four are build-time constants over there (no slider touches them), so reading them
    // once is enough — and it makes it impossible for the sparks to disagree with the
    // band they come off.
    const a = registers[0].material.uniforms;
    const b = registers[1].material.uniforms;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uProjScale,
        uDial: { value: 1 },
        uLife: { value: LIFE },
        // Startup values only, matching TUNING_DEFAULTS — sync() overwrites all three
        // on the first frame. Kept in step so this is not a lie about where they sit.
        uBandR: { value: new THREE.Vector2(galaxy.radius * 1.5, galaxy.radius * 1.17) },
        uBandZ: { value: new THREE.Vector2(6.0, 0.4) },
        uBandDepth: { value: galaxy.radius * 0.09 },
        uSpin: { value: new THREE.Vector2(a.uSpin.value, b.uSpin.value) },
        uRunRate: { value: new THREE.Vector2(a.uRunRate.value, b.uRunRate.value) },
        uRepeat: { value: new THREE.Vector2(a.uRepeat.value, b.uRepeat.value) },
        uCols: { value: glyphAtlas.cols },
        uTintA: { value: a.uTint.value.clone() },
        uTintB: { value: b.uTint.value.clone() },
        uHot: { value: PALETTE.coreHot.clone() },
      },
      vertexShader: /* glsl */ `
      ${HASH_HEAD}
      attribute vec2 aSpark; // x: size random 0..1, y: band index (0 or 1)
      uniform float uTime;
      uniform float uProjScale;
      uniform float uDial;
      uniform float uLife;
      uniform vec2 uBandR;
      uniform vec2 uBandZ;
      uniform float uBandDepth;
      uniform vec2 uSpin;
      uniform vec2 uRunRate;
      uniform vec2 uRepeat;
      uniform float uCols;
      uniform vec3 uTintA;
      uniform vec3 uTintB;
      uniform vec3 uHot;
      varying vec3 vColor;

      const float TAU_F = 6.28318530718;

      void main() {
        float base = position.x;
        float phase = position.y;
        float seed = position.z;
        float band = aSpark.y;

        float radius0 = mix(uBandR.x, uBandR.y, band);
        float zBase = mix(uBandZ.x, uBandZ.y, band);
        float spin = mix(uSpin.x, uSpin.y, band);
        float run = mix(uRunRate.x, uRunRate.y, band);
        float repeat = mix(uRepeat.x, uRepeat.y, band);

        float life = fract(uTime / uLife + phase);

        // WHICH RUNE THIS SPARK CAME OFF, and why the cell index is a constant.
        //
        // The register samples its atlas at turn = vUv.x + uSpin*uTime, so a glyph
        // fixed in atlas space DRIFTS to vUv.x = base - uSpin*t. A spark that stays
        // on its glyph has to drift the same way — and once it does, the register's
        // own cell index, floor(turn_register * repeat * cols), comes out constant
        // for the whole life. One spark, one rune. Drop the drift and the spark
        // would slide across the register's glyphs and inherit a different
        // brightness every few seconds, which reads as flickering noise.
        float turn = base - spin * uTime;
        float cell = floor(base * repeat * uCols);
        float cellSeed = hash11(cell + band * 31.7);

        // The register's brightness law, copied verbatim so a spark is as bright as
        // the rune that threw it. Retune one and this has to be retuned with it.
        float breath = 0.5 + 0.5 * sin(uTime * (0.28 + cellSeed * 0.85) + cellSeed * 24.0);
        float bright = (0.3 + pow(cellSeed, 1.7) * 1.5) * (0.45 + 0.55 * breath);

        // ...and the register's travelling charge, on the spark's CURRENT band-uv.
        // This is the beat: the charge sweeps the ring and the band throws sparks.
        float head = fract(uTime * run);
        float around = abs(fract(turn - head + 0.5) - 0.5);
        float travel = pow(max(0.0, 1.0 - around * 9.0), 3.0);

        // Scatter across the band, then creep radially and lift off the plane. All
        // three are in band-depth / world units, so they stay proportionate when the
        // R sliders move the register somewhere else.
        float across = (hash11(seed * 7.3) - 0.5) * uBandDepth * 0.85;
        float creep = (hash11(seed * 3.1) - 0.32) * uBandDepth * 2.6;
        float radius = radius0 + across + creep * life;

        // Drift is mostly toward the camera side. The registers already sit in FRONT
        // of the disc (positive z in the group), so sparks falling backward would
        // just disappear into the galaxy; a fifth of them go that way anyway, and
        // less far, so the shower has a back edge instead of a floor.
        //
        // Roughly 3x the first pass's travel. At the old amplitude a spark never got
        // more than a band-depth away from the glyph that threw it, so the shower sat
        // INSIDE the register's own bloom and read as the band being slightly fuzzy.
        // pow(life, 0.72) rather than a linear ramp: an ejection is fast at the start
        // and coasts, and the fast part is what registers as being thrown.
        float lift = 0.85 + hash11(seed * 11.7) * 2.4;
        lift *= hash11(seed * 5.9) < 0.2 ? -0.45 : 1.0;
        float wobble = sin(uTime * (0.7 + cellSeed * 1.3) + seed * 17.0) * 0.06;

        // An ARC, not a spine: the spark also slides along the ring as it leaves.
        // Tiny in absolute terms — a hundredth of a lap over a whole life — but
        // without it every spark stands radially off the band and the register grows
        // a hedgehog.
        float sweep = (hash11(seed * 15.1) - 0.45) * 0.012;
        float angle = (turn + sweep * life) * TAU_F;
        vec3 pos = vec3(
          cos(angle) * radius,
          sin(angle) * radius,
          zBase + lift * pow(life, 0.72) + wobble
        );

        // Fast ignition, long decay: nothing in an additive frame may pop out of
        // existence, because there is no depth buffer to hide the discontinuity.
        // The ramp is deliberately SHORT (0.02 of a life, ~4 frames at the 30 fps cap)
        // so it does not eat the flare below — with the old 0.09 ramp the envelope was
        // still climbing while the flare was already decaying, and the two cancelled
        // into nothing. That cancellation is the trap here: both curves look right in
        // isolation and their product is a shrug.
        float env = smoothstep(0.0, 0.02, life) * (1.0 - smoothstep(0.16, 1.0, life));
        // IGNITION FLARE — the single change that took this layer from "faint dust"
        // to legible. A spark is briefly hot and briefly large as it comes off the
        // rune, then settles. Momentary events survive peripheral vision; a steady
        // drift of small dots is precisely what peripheral vision throws away.
        float flare = pow(1.0 - smoothstep(0.0, 0.12, life), 2.0);
        // Peaked twinkle rather than a raw sine: pow() spends most of the cycle dim
        // and a short part of it bright, which reads as GLINTING. A sine reads as
        // breathing, which the registers already do — two breathing layers on top of
        // each other is just one softer layer.
        float twinkle = pow(0.5 + 0.5 * sin(uTime * (1.9 + seed * 4.2) + seed * 41.0), 2.4);

        // Brightness is where the size cut is paid back. A sprite at 0.022 covers a
        // fifth of the area it did at 0.05, so holding the same peak VALUE would be a
        // fifth of the light; these multipliers are up by roughly that factor. In an
        // additive frame with a bloom chain that is the better trade anyway — a small
        // hot point blooms into a glint, where a large dim one only ever looks like a
        // smudge. This is the "compensate with brightness, not size" rule made real.
        vec3 tint = mix(uTintA, uTintB, band);
        vColor = (
            tint * bright * (0.5 + 2.6 * twinkle)
          + uHot * travel * 5.0
          + uHot * flare * 5.5
        ) * env * uDial;

        vec4 viewPos = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * viewPos;
        // Real projection uniform, not the 300.0/-z idiom: at this camera that idiom
        // yields sub-pixel sprites and the system renders as nothing at all.
        //
        // SIZED OFF THE GALAXY, not off a guess. buildGalaxy authors
        //   aScalar.z = 0.022 + pow(rand, 3) * 0.055   ->  0.0220 / 0.0289 / 0.0770
        //                                                  (p10 / median / max)
        //   world size = aScalar.z * (0.55 + q * 0.85)  ->  0.0121 min, ~0.0282
        //                                                   typical, 0.1078 max
        // so a disc star is 0.012-0.108 world units and is clamped at 7 px.
        //
        // This crowd therefore sits at 0.022 — the galaxy's own dense band — and the
        // pow(x, 3) hero tail tops out at 0.048, under 2x a typical star. The middle
        // round of this file overshot to 0.05/0.39 and put 20 px blobs in a frame
        // whose largest star is 5 px; the sprites stopped being sparks and became
        // objects. Heavy-tailing is still worth keeping at this scale: it is what
        // lets the crowd read as one substance rather than as a uniform stipple.
        //
        // The flare is now a BRIGHTNESS event with only a small size bump (peak
        // factor ~1.45). Size was the wrong currency for it — a pop that doubles the
        // radius quadruples the area and reads as something arriving, where a pop
        // that raises the peak value reads as something igniting, which is the thing.
        float size = (0.022 + pow(aSpark.x, 3.0) * 0.026) * (0.6 + env * 0.4 + flare * 0.45);
        // 9 rather than the galaxy's 7 only so a hero mid-flare is not clipped at
        // dpr 2, where uProjScale doubles. Steady-state never approaches it.
        gl_PointSize = clamp(size * uProjScale / -viewPos.z, 1.0, 9.0);
      }
    `,
      fragmentShader: /* glsl */ `
      ${POINT_HEAD}
      varying vec3 vColor;

      void main() {
        gl_FragColor = vec4(vColor * sprite(gl_PointCoord) * 2.0, 1.0);
      }
    `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;

    // Live-follow the tuner. Read every frame rather than snapshotted at build: the
    // whole point of this file's sliders is dragging a register and watching what moves
    // with it, and sparks left behind at the old radius would read as a bug.
    const sync = () => {
      material.uniforms.uBandR.value.set(
        galaxy.radius * tuning.rune1R,
        galaxy.radius * tuning.rune2R,
      );
      material.uniforms.uBandZ.value.set(tuning.rune1Z, tuning.rune2Z);
      material.uniforms.uBandDepth.value = galaxy.radius * TUNE_BAND_DEPTH;
    };

    return { points, material, sync, count: COUNT };
  }

  // ==================================================================================
  // Layer 3g — magic circle charge motes. (Particle pass; header note 5b.)
  //
  // Two populations in ONE buffer, told apart by an `aKind` attribute:
  //
  //   kind 0, THE COMET TRAIL — motes riding the circle's existing travelling charge.
  //     Each one holds a fixed lag behind the head, so the trail is rigid and the whole
  //     thing sweeps the ring once per lap with the charge it belongs to. It reads as
  //     the head having mass.
  //   kind 1, EMBERS — slow drift off the five points where the pentagram's chords
  //     cross. Those five points are where the figure's lines actually MEET, so light
  //     collecting and coming off there reads as the drawing carrying current, where
  //     embers scattered anywhere on the quad would read as dust.
  //
  // One system because they share a palette, a lifetime model and a dial; two would be
  // two draw calls to say one thing.
  //
  // TWO SIGNS ARE LOAD-BEARING AND NEITHER IS OBVIOUS:
  //   - The circle's charge is driven by the UNROTATED quad coordinate (the shader
  //     reads vPos, not the spun ps), so the comet trail must NOT be spun or it would
  //     slide off its own head as the pentagram turns.
  //   - The star IS spun, but the drawn figure turns the OTHER WAY from uSpin: the
  //     shader rotates the sample point by +uSpin*t, which rotates the shape by -uSpin*t.
  //     Get this backwards and the embers counter-rotate against the vertices they are
  //     supposed to be leaving.
  // ==================================================================================
  function buildCircleMotes(circle) {
    // BUFFED alongside the sparks (2026-08-10), and this layer had it worse: it sits on
    // top of the circle's own bloom, so anything dimmer than the stroke it rides simply
    // gets absorbed by the halo. A much longer and wider tail, a near-white bead at the
    // head, and an ignition flash on each ember. Sprite size stays on the galaxy's
    // ruler (see gl_PointSize below) — the brightness multipliers carry it instead.
    const COMETS = 1500;
    const EMBERS = 1100;
    const COUNT = COMETS + EMBERS;
    // Trail length as a fraction of a lap. 0.075 was about 27 degrees of arc — short
    // enough that at this radius it read as a slightly thicker bit of ring rather than
    // as something travelling. 0.16 is a 58-degree comet with a visible head and end.
    const TAIL_TURNS = 0.16;
    const EMBER_LIFE = 7.0;

    const carrier = new Float32Array(COUNT * 3);
    const params = new Float32Array(COUNT * 2);
    for (let index = 0; index < COUNT; index += 1) {
      const isEmber = index >= COMETS;
      // Comets: lag behind the head, biased toward the head so the trail tapers by
      // DENSITY as well as by brightness. A uniform lag gives an even bar of light.
      // Embers: which of the five intersections this one belongs to.
      carrier[index * 3] = isEmber ? Math.random() : Math.pow(Math.random(), 1.6);
      carrier[index * 3 + 1] = Math.random();
      carrier[index * 3 + 2] = Math.random() * 97.3 + 0.13;
      params[index * 2] = Math.random();
      params[index * 2 + 1] = isEmber ? 1 : 0;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(carrier, 3));
    geometry.setAttribute('aMote', new THREE.BufferAttribute(params, 2));

    const circleUniforms = circle.material.uniforms;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uProjScale,
        uDial: { value: 1 },
        // Startup value only; sync() overwrites from `tuning` on the first frame.
        uRadius: { value: galaxy.radius * 1.1 },
        uSpin: { value: circleUniforms.uSpin.value },
        // The inner layer is a separate material on the circle's child mesh, and its
        // spin lives in ITS `uSpin` uniform (buildSpinningLayer names every layer's
        // rotation uSpin; buildMagicCircle passes spinInner through as that value).
        uSpinInner: {
          value: circle.innerMaterial ? circle.innerMaterial.uniforms.uSpin.value : 0,
        },
        uRunRate: { value: circleUniforms.uRunRate.value },
        uTail: { value: TAIL_TURNS },
        uEmberLife: { value: EMBER_LIFE },
        uTint: { value: PALETTE.coreGold.clone() },
        uHot: { value: PALETTE.coreHot.clone() },
      },
      vertexShader: /* glsl */ `
      ${HASH_HEAD}
      attribute vec2 aMote; // x: size random 0..1, y: kind (0 comet, 1 ember)
      uniform float uTime;
      uniform float uProjScale;
      uniform float uDial;
      uniform float uRadius;
      uniform float uSpin;
      uniform float uSpinInner;
      uniform float uRunRate;
      uniform float uTail;
      uniform float uEmberLife;
      uniform vec3 uTint;
      uniform vec3 uHot;
      varying vec3 vColor;

      const float TAU_F = 6.28318530718;
      // The inner {8/3} star's vertices sit at 0.741 of the quad radius, which is
      // 0.823 of the circle's 0.9 — where the embers collect and come off. Both are
      // properties of the figure the circle shader draws, not free parameters.
      const float INNER = 0.823;

      void main() {
        float param = position.x;
        float phase = position.y;
        float seed = position.z;
        float kind = aMote.y;

        // ---- kind 0: comet trail on the running charge -------------------------
        float head = fract(uTime * uRunRate);
        float lag = param;
        float cAngle = (head - lag * uTail) * TAU_F;
        // The tail frays as it ages: spread grows with lag, so the head is a tight
        // bead and the end dissolves into the ring instead of stopping.
        float fray = lag * lag * uRadius * 0.13;
        float cRadius =
          uRadius
          + (hash11(seed * 4.1) - 0.5) * fray * 2.0
          + (hash11(seed * 2.7) - 0.5) * uRadius * 0.012;
        vec3 cPos = vec3(
          cos(cAngle) * cRadius,
          sin(cAngle) * cRadius,
          (hash11(seed * 9.3) - 0.5) * fray
        );
        // The bead: the leading few percent of the trail, near-white and fat. A comet
        // without a hard head is a smear, and a smear on an already-glowing ring is
        // invisible. pow 9 keeps it to a genuine point rather than a bright half.
        float bead = pow(1.0 - lag, 9.0);
        // Falloff softened from pow 2.4 so the tail actually carries its new length
        // instead of dying in the first third of it.
        float cEnv =
          pow(1.0 - lag, 1.5)
          * (0.6 + 0.6 * sin(uTime * (2.4 + seed * 3.1) + seed * 29.0));

        // ---- kind 1: embers off the inner {8/3} star's eight vertices -------------
        float k = floor(param * 8.0);
        float a0 = k * (TAU_F / 8.0) + 1.57079632679;
        float spun = a0 - uSpinInner * uTime + (hash11(seed * 6.1) - 0.5) * 0.05;
        float life = fract(uTime / uEmberLife + phase);
        vec2 root = vec2(cos(spun), sin(spun)) * (uRadius * INNER);
        vec2 outward = normalize(root);
        vec2 tangent = vec2(-outward.y, outward.x);
        // Travel roughly tripled. The vertices sit at 0.82 of the circle's radius, so
        // at the old amplitude an ember never left the star's own line weight; now it
        // climbs a good way toward the ring and the gap between the two is what reads
        // as the figure venting.
        float rise = life * uRadius * (0.16 + hash11(seed * 8.3) * 0.4);
        float sway = sin(life * 3.1 + seed * 13.0) * uRadius * 0.06;
        vec3 ePos = vec3(
          root + outward * rise + tangent * sway,
          life * uRadius * (0.05 + hash11(seed * 12.7) * 0.16)
        );
        // The star's own breath, copied from the circle shader, so the embers swell
        // and fade with the figure they come off rather than on their own schedule.
        float starBreath = 0.78 + 0.22 * sin(uTime * 0.34 + 1.7);
        // Same ignition flash the sparks got, and for the same reason: the eye finds
        // the moment something LIGHTS, not the minute it spends drifting.
        float eFlare = pow(1.0 - smoothstep(0.0, 0.14, life), 2.0);
        float eEnv =
          smoothstep(0.0, 0.03, life)
          * (1.0 - smoothstep(0.25, 1.0, life))
          * starBreath
          * (0.45 + 0.9 * pow(0.5 + 0.5 * sin(uTime * (1.3 + seed * 2.2) + seed * 23.0), 2.0));

        vec3 pos = mix(cPos, ePos, kind);
        float env = mix(cEnv, eEnv, kind);

        // Head near-white cooling into the figure's own gold down the trail; embers
        // ignite hot and cool as they leave. Same exposure logic as the galaxy: hue
        // travel is what stops a single-colour system reading as a smudge.
        // Raised to pay for the size cut below, same trade as the sparks: this layer
        // has to out-read the circle's own bloom, and it now has to do it on a
        // galaxy-star-sized sprite. Peak value, not area.
        vec3 cColor = mix(uHot, uTint, smoothstep(0.0, 0.4, lag)) * 3.6 + uHot * bead * 5.5;
        vec3 eColor = mix(uHot, uTint, smoothstep(0.0, 0.25, life)) * 2.4
                    + uHot * eFlare * 4.0;
        vColor = mix(cColor, eColor, kind) * env * uDial;

        vec4 viewPos = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * viewPos;
        // Matched to the galaxy's own stars (0.012-0.108 world units, typical 0.028,
        // clamped at 7 px) exactly as the sparks are: crowd at 0.024, pow(x, 3) hero
        // tail to 0.054. The comet HEAD is the one thing allowed to run a little
        // larger — it is a single focal point rather than a population, and a comet
        // whose head is the same size as its tail is a smear.
        float size =
          (0.024 + pow(aMote.x, 3.0) * 0.03)
          * mix(0.55 + pow(1.0 - lag, 2.0) * 0.75, 0.6 + eEnv * 0.4 + eFlare * 0.5, kind);
        gl_PointSize = clamp(size * uProjScale / -viewPos.z, 1.0, 9.0);
      }
    `,
      fragmentShader: /* glsl */ `
      ${POINT_HEAD}
      varying vec3 vColor;

      void main() {
        gl_FragColor = vec4(vColor * sprite(gl_PointCoord) * 2.0, 1.0);
      }
    `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;

    // The motes live in their own group, NOT parented to the circle mesh, and this is
    // the one deliberate deviation from "parent the points to the circle mesh".
    //
    // That mesh is a unit quad blown up by (radius*2)/0.9 — roughly 17x. Inheriting it
    // would multiply every world-unit number inside the shader (drift, lift, fray, the
    // point-size world radius) by that scale, so the tuning would silently depend on
    // the circle's radius. Copying position and rotation only gives the same placement
    // and the same tilt in undistorted world units, with the radius arriving as a
    // uniform where it can be reasoned about.
    const group = new THREE.Group();
    group.add(points);

    const sync = () => {
      group.position.copy(circle.mesh.position);
      group.rotation.copy(circle.mesh.rotation);
      material.uniforms.uRadius.value = galaxy.radius * tuning.circleR;
      // uSpin/uRunRate are build-time constants on the circle, but reading them back
      // each frame costs nothing and means the two can never drift apart by hand.
      material.uniforms.uSpin.value = circleUniforms.uSpin.value;
      material.uniforms.uSpinInner.value = circle.innerMaterial
        ? circle.innerMaterial.uniforms.uSpin.value
        : circleUniforms.uSpin.value;
      material.uniforms.uRunRate.value = circleUniforms.uRunRate.value;
    };

    return { group, points, material, sync, count: COUNT, comets: COMETS, embers: EMBERS };
  }

  const storm = buildStorm();
  const stars = buildStars();
  const veils = buildVeils();
  const bokeh = buildBokeh();
  const galaxy = buildGalaxy();
  const haze = buildDiscHaze(galaxy);
  galaxy.group.add(haze.mesh);
  // Rings live in the galaxy's own plane, so they tilt with it and read as orbits rather
  // than as a flat overlay pasted on the frame.
  //
  const rings = buildRingField({ inner: 0.3, outer: galaxy.radius * 1.72, count: 24 });
  galaxy.group.add(rings.mesh);

  // The figure the registers are engraved on. Everything here is additive, so draw
  // order cannot put it "under" anything — the plane offset is what separates it from
  // the disc, and the tilt plus parallax are what read that separation as depth. In v2
  // the offset was NEGATIVE and the figure sat under the galaxy like a platform; the
  // hand-tune (2026-08-09) brought it out in FRONT instead, so the disc is now seen
  // through the drawing. Same mechanism, opposite sign — the sign is a composition
  // choice, not a correctness one.
  //
  // spin is RADIANS PER SCENE SECOND (the shader does `uTime * uSpin` and rotates the
  // pentagram by it). v2's -0.004 is a lap every ~26 minutes, i.e. static to anyone
  // actually looking at the page; -0.084 is a lap every ~75 s, which reads as turning
  // without becoming the fastest thing in the frame.
  // Spin is RADIANS PER SCENE SECOND. The shader rotates the SAMPLE point by uSpin*uTime,
  // which rotates the drawn figure the other way, so a NEGATIVE outer spin turns the outer
  // half-ring CLOCKWISE and a POSITIVE inner spin turns the inner half-ring
  // COUNTER-CLOCKWISE — two rings drifting the same way would read as one ring.
  const magicCircle = buildMagicCircle({
    radius: galaxy.radius * 1.1,
    spin: -0.05, // outer half-ring: clockwise, ~2 min per lap
    spinInner: 0.12, // inner half-ring: counter-clockwise, ~52 s per lap
    runRate: 0.022,
    intensity: 0.85,
  });
  // Startup value only: setupTuning() sync()s every row before the first frame, so
  // TUNING_DEFAULTS and the slider markup are what actually decide this. Kept in step
  // with them so the build call is not a lie about where the figure sits.
  magicCircle.mesh.position.z = 2.7;
  galaxy.group.add(magicCircle.mesh);

  // Runes, outward, interleaved with the orbit arcs the way registers and rails
  // interleave on a real instrument. Gold inner turning one way, pale outer turning the
  // other — two rings drifting the same way read as one ring.
  //
  // Band depth and `repeat` have to be chosen together: a glyph cell is
  // circumference / (32 * repeat) wide, and it wants to be about as wide as the band is
  // deep or the runes come out stretched.
  const runeRegisters = [
    buildRuneRegister({
      inner: galaxy.radius * 1.455,
      outer: galaxy.radius * 1.545,
      row: 0,
      repeat: 3, // 96 glyphs round a ~47-unit circumference -> ~0.49 per cell
      spin: 0.0092,
      runRate: 0.048,
      intensity: 1.15,
      // shift is in band-depth units, and it has to stay WELL under the stroke width or
      // this stops being a lens fringe and becomes an anaglyph. A stroke is ~0.1 of a
      // cell; at 0.055 the three channel samples barely overlapped, so outside the
      // stroke there were pixels where only red or only blue was lit — saturated
      // red/blue edges with no white anywhere, i.e. 3D-glasses. At 0.018 the images
      // overlap almost everywhere and the disagreement is a ~1 px rim, which is what a
      // real lens does.
      shift: 0.018,
      chroma: 0.9,
      tint: PALETTE.coreGold,
      hot: PALETTE.coreHot,
    }),
    buildRuneRegister({
      // Pulled inside row 0 by the hand-tune (2026-08-09), so the two registers no
      // longer read outward in atlas order. `repeat` is left at 4 because that is the
      // ring the composition was approved with, but the cell is now narrower than the
      // band is deep and the glyphs are correspondingly tall — re-pick `repeat` here if
      // this radius is ever taken as final.
      inner: galaxy.radius * 1.125,
      outer: galaxy.radius * 1.215,
      row: 1,
      repeat: 4, // 128 glyphs round a ~37-unit circumference -> ~0.29 per cell
      spin: -0.0058,
      runRate: -0.031,
      intensity: 0.6,
      shift: 0.022,
      chroma: 0.75,
      tint: PALETTE.starCool,
      hot: PALETTE.coreHot,
    }),
  ];
  const runeRails = [
    buildRail({
      radius: galaxy.radius * 1.89,
      width: 0.028,
      tint: PALETTE.coreGold,
      intensity: 0.62,
      shift: 0.2,
      soft: 2.2,
      runRate: 0.026,
    }),
  ];
  for (const register of runeRegisters) galaxy.group.add(register.mesh);
  for (const rail of runeRails) galaxy.group.add(rail.mesh);

  // The particle pass. Both go into the galaxy group, so they inherit the disc's tilt
  // and the layout offset for free and can never separate from the engraved work they
  // come off. Built here, AFTER the registers and the circle, because each one reads
  // its source's uniforms rather than repeating that source's literals.
  //
  // Neither is sync()ed at build time: sync() reads `tuning`, which is declared much
  // further down, and touching it up here would be a temporal-dead-zone throw. The
  // frame loop calls both before the first render, so nothing is ever drawn stale.
  const runeSparks = buildRuneSparks(runeRegisters);
  galaxy.group.add(runeSparks.points);
  const circleMotes = buildCircleMotes(magicCircle);
  galaxy.group.add(circleMotes.group);

  const core = buildCore();
  // The two arcs, re-authored as the UI column's flanks (see header note 3). They are
  // built at the origin running along local X and then stood up by `rot`; placeLayout()
  // owns where they end up, because that depends on the aspect.
  //
  // sag is what makes them BOW AROUND the column rather than run past it: positive sag
  // on the left flank and negative on the right pushes each one's belly outward, so the
  // gap between them is widest at the buttons. Setting both the same way was draft one
  // and it looked like a slash through the frame.
  const arcs = [
    buildArc({
      // Span pulled in from 13. At 13 the ribbon ran the full height of the frame and
      // its taper never resolved before the edge, so it read as a slash across the
      // picture instead of as a bracket around the column.
      span: 9.6,
      y: 0,
      sag: -1.15,
      tilt: 0.25,
      z: -4.0,
      depth: 1.4,
      width: 0.4,
      amp: 0.26,
      phase: 0,
      // Dimmed from 1.25. This one sits nearest the frame edge with nothing behind it,
      // so at the old intensity it was the brightest object in the composition and
      // pulled the eye off both the title and the disc.
      intensity: 0.82,
      // shift is measured in half-widths. Draft one used 0.5 — half the ribbon — and the
      // arc came out a flat rainbow band instead of a white line with a lens's fringe on
      // it. The reference has the split confined to the outer rim; that is this number.
      shift: 0.2,
      soft: 2.6,
      fade: 0.4,
      taperFloor: 0,
      taperPow: 1.25,
      rot: Math.PI * 0.5 + 0.1,
      tint: PALETTE.arcTint.clone(),
    }),
    buildArc({
      // The inner flank is the one that was colliding with the disc: it has to die out
      // before it reaches the rune registers, so it is both shorter and softer-tapered
      // than its partner rather than a mirror of it.
      span: 8.4,
      y: 0,
      sag: 1.15,
      tilt: -0.35,
      z: -2.2,
      depth: 1.0,
      width: 0.26,
      amp: 0.2,
      phase: 2.4,
      intensity: 0.3,
      shift: 0.26,
      soft: 3.6,
      fade: 0.44,
      taperFloor: 0,
      taperPow: 1.35,
      rot: Math.PI * 0.5 - 0.13,
      tint: PALETTE.armViolet.clone(),
    }),
  ];
  const meteors = buildMeteors();
  const dust = buildDust();

  // ==================================================================================
  // Home layout.
  //
  // The one rule: every placement here is authored as a SCREEN FRACTION and converted
  // to world units at the depth the thing actually sits at. A world-space offset that
  // clears the UI column at 16:10 slides straight back under it at 21:9, and on a
  // narrow window the disc ends up centred again with the buttons on top of the core —
  // which is exactly the failure this whole study exists to avoid.
  // ==================================================================================
  // Composition defaults, hand-tuned on the real thing (2026-08-09) rather than
  // reasoned out. They are NOT v2's numbers: the disc is nearly level (rot z 6 instead
  // of -24) and swung hard on Y instead, which is the change that stopped it reading as
  // a diagram; the arcs are pushed to their widest so they clear the column entirely.
  //
  // These values must agree with the slider `value` attributes above. setupDials()
  // calls sync() on every dial at startup, so the HTML is what actually wins after the
  // first frame — this literal only covers the single placeLayout() that resize() runs
  // before the dials exist. Change one, change both, or the frame moves on load.
  const layout = {
    offset: 0.61, // disc centre X, as a fraction of frame width
    height: -0.01, // disc centre Y, as a fraction of frame height (+ is up)
    rotX: THREE.MathUtils.degToRad(-31),
    rotY: THREE.MathUtils.degToRad(-31),
    rotZ: THREE.MathUtils.degToRad(17),
    flank: 1, // 0 = arcs hug the column, 1 = arcs pushed wide
    portrait: false,
  };

  // Visible extent in world units at a given depth, for this camera.
  //
  // CAMERA_BASE.z, NOT camera.position.z, and both reasons matter:
  //
  //   1. It is a bug otherwise. placeLayout() is called from resize(), which runs once
  //      at startup BEFORE animate() has ever positioned the camera — so the live value
  //      is still 0, every distance comes out about 5x too small, and the flank arcs
  //      land across the middle of the frame instead of beside the column. It only
  //      looked correct when something happened to fire a second resize later, which
  //      is exactly the kind of order dependence that hides until it does not.
  //   2. Even fixed, the live value is the wrong one to read: the camera dollies +-0.85
  //      every frame, so placements derived from it would breathe against the DOM
  //      column they are supposed to bracket.
  function viewSize(z) {
    const dist = Math.max(0.1, CAMERA_BASE.z - z);
    const height = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    return { height, width: height * camera.aspect };
  }

  function worldX(fraction, z) {
    return (fraction - 0.5) * viewSize(z).width;
  }

  function placeLayout() {
    const discZ = 0;
    const offset = layout.portrait ? 0.5 : layout.offset;
    const x = worldX(offset, discZ);
    galaxy.group.position.x = x;
    // The core billboard is a scene child, not a group child — it does not inherit the
    // offset and will sit alone in the empty half if you forget it. It cannot simply be
    // reparented: it copies the camera quaternion every frame, which a rotated parent
    // would then compose with.
    core.mesh.position.x = x;
    // Portrait pushes the disc down instead of sideways, to clear the top band.
    const y = viewSize(discZ).height * (layout.portrait ? -0.16 : layout.height);
    galaxy.group.position.y = y;
    core.mesh.position.y = y;

    // Flanks bracket the UI column. Measured, not guessed: at 1440 wide the .ui
    // padding resolves to 100.8px and .ui-column clamps to 348px, so the column spans
    // 0.070..0.312 of the frame and is centred on 0.191. The old 0.21 centre with a
    // 0.165 spread put the inner flank at 0.375 — past the column and into the disc's
    // outer runes, which is what made that side read as clutter.
    const homeLayout = getComputedStyle(stage.parentElement ?? stage);
    const centre = Number.parseFloat(homeLayout.getPropertyValue('--drift-column-center')) || 0.191;
    const columnWidth =
      Number.parseFloat(homeLayout.getPropertyValue('--drift-column-width')) || 0.242;
    const spread = Math.max(0.075, columnWidth / 2 + layout.flank * 0.044);
    for (let i = 0; i < arcs.length; i += 1) {
      const arc = arcs[i];
      const side = i === 0 ? -1 : 1;
      const z = arc.spec.z;
      arc.mesh.position.x = worldX(centre + side * spread, z);
      arc.mesh.visible = !layout.portrait;
    }
  }

  // ==================================================================================
  // Resolution governor.
  //
  // The honest fix for "it cooks my laptop" is not a fixed pixel-ratio guess — v1's
  // clamp of 1.5 was a guess and it was wrong for an M4 Pro. This measures the actual
  // median frame cost and moves the render scale until the frame fits the budget, so the
  // piece is as sharp as the machine can afford and never sharper. It starts at 1 and
  // has to earn its way up, so a weak GPU never pays for a resolution it cannot hold
  // even for the first second.
  // ==================================================================================
  //
  // ----------------------------------------------------------------------------------
  // STARTUP FLICKER (reported 2026-08-10: "blinks 8-10 times at about twice a second,
  // then completely normal"). Diagnosed, fixed here, and worth reading before touching
  // any of this, because the governor was only half of it.
  //
  // MECHANISM. The scale starts at 1 and can only climb in 7% steps, one step per 900 ms
  // window, so a machine at devicePixelRatio 2 takes ELEVEN steps to reach its own
  // ratio, and one at 1.5 takes six. Every step calls applyScale(), and applyScale()
  // calls renderer.setSize(), which writes canvas.width/height — and writing those
  // attributes REALLOCATES AND CLEARS THE DRAWING BUFFER. In the old ordering that
  // happened AFTER composer.render() had already run for the frame, so the cleared
  // buffer was what the compositor had to show until the next 30 fps tick ~33 ms later.
  // One black frame per step. Eleven steps, then the scale is pinned at governor.max,
  // Math.abs(next - scale) > 0.01 stops being true, applyScale() is never called again —
  // which is exactly the reported "then completely normal, with no further blinking".
  //
  // That last detail is what rules out the obvious suspect. Warmup spikes (lazy shader
  // compilation, first uploads) would predict flicker that SETTLES; a monotone ratchet
  // into a hard ceiling predicts a burst that stops dead. It stops dead.
  //
  // THREE FIXES, and only the first one is about the flash:
  //   1. The governor now decides BEFORE composer.render() instead of after, so a resize
  //      is always followed by a draw in the same frame and an empty buffer is never
  //      presented. This alone would fix the symptom.
  //   2. The pipeline is warmed (renderer.compile + two throwaway composer frames) and
  //      the governor ignores the first second, so its first decisions are not
  //      measurements of the shader compiler.
  //   3. Steps up must be EARNED TWICE and are bigger when they come, which cuts a
  //      dpr-2 climb from eleven reallocations to four. Steps DOWN are unchanged and
  //      still immediate: dropping frames is a visible failure and the measurement that
  //      says so is unambiguous, where a fast window is only ever an invitation.
  //
  // Steady-state behaviour is deliberately untouched — same budget, same 0.86 down-step,
  // same clamp, same measurement.
  //
  // PROVENANCE. This was diagnosed here and ported to every other file in this directory
  // that carries the same governor: AstralDriftHome, AstralDriftHomeTuner, AstralDriftV2,
  // AstralDriftV2Tuner, AstralDrift, ObsidianAstrolabeV2 and MagicCircle — eight files in
  // total, all fixed. Seven of them were byte-identical in the three regions this touches,
  // so that port is a copy rather than an adaptation; MagicCircle is the same three fixes
  // in different vocabulary (`renderScale.value`, `considerRenderScale`,
  // `applyRenderScale`) because it predates the AstralDrift line. Keep them in step:
  // change one, change all.
  // ==================================================================================
  const FRAME_INTERVAL_MS = 1000 / 30;
  // 1.5 s, not 1 s: the warmup renders below make the first frames cheap on a fast
  // machine, but on a slow one shader compilation can still spill past a second, and a
  // spike that lands just outside the grace buys a pointless down-step.
  const GOVERNOR_GRACE_MS = 1500;
  const governor = {
    scale: 1,
    min: 0.5,
    max: Math.min(devicePixelRatio, 2),
    samples: [],
    // "Last window consumed", not "last change applied". Every evaluation that clears
    // the 900 ms gate takes the window, whether or not it moves the scale — see the
    // note in considerScale for why that distinction is load-bearing.
    lastWindow: 0,
    // Stamped just before the loop starts, AFTER the warmup renders — not here at build
    // time, which would spend the whole grace window on module loading and glyph baking
    // and leave nothing of it for the frames that actually matter. performance.now() and
    // the rAF timestamps this gets compared against share a time origin, so they are
    // directly comparable; the 0 that the first manual animate() call carries reads as
    // "long before the start" and is skipped, which is what we want anyway.
    started: 0,
    // Consecutive 900 ms windows that have asked to go up. Reset by anything else.
    upStreak: 0,
  };
  governor.scale = Math.min(1, governor.max);

  let viewportWidth = 1;
  let viewportHeight = 1;

  function applyScale() {
    const pixelRatio = governor.scale;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(viewportWidth, viewportHeight, false);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(viewportWidth, viewportHeight);
    gradePass.uniforms.uResolution.value.set(
      viewportWidth * pixelRatio,
      viewportHeight * pixelRatio,
    );
    // FXAA reads neighbours by texel offset, so it needs DEVICE pixels. Feeding it CSS
    // pixels makes it sample 1/pixelRatio of a texel away — a no-op that still costs a
    // full pass, which is the quiet way this pass ends up doing nothing on hiDPI.
    fxaaPass.material.uniforms.resolution.value.set(
      1 / (viewportWidth * pixelRatio),
      1 / (viewportHeight * pixelRatio),
    );
    uProjScale.value =
      (viewportHeight * pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }

  function resize() {
    const bounds = stage.getBoundingClientRect();
    viewportWidth = Math.max(1, Math.round(bounds.width));
    viewportHeight = Math.max(1, Math.round(bounds.height));
    camera.aspect = viewportWidth / viewportHeight;
    camera.updateProjectionMatrix();
    applyScale();
    // 1.15 rather than 1.0: at a hair over square there is no left third worth having,
    // and the column would sit half on the disc.
    layout.portrait = camera.aspect < 1.15;
    stage.classList.toggle('is-portrait', layout.portrait);
    placeLayout();
  }

  function considerScale(medianMs, now) {
    // Startup grace. The first second of a fresh page is its least trustworthy
    // measurement — shader programs are still being compiled on first use, buffers and
    // textures are still uploading, and the tab is still competing with its own load —
    // and it is also the second in which a wrong decision is most visible. Measuring is
    // free; acting on it this early is guessing.
    if (now - governor.started < GOVERNOR_GRACE_MS) return;
    if (now - governor.lastWindow < 900) return;
    // EVERY evaluation that gets this far consumes the window, pass or no pass.
    //
    // The first draft only stamped this when the scale actually moved, and that quietly
    // destroyed the "earn it twice" rule below: a window that raised the streak to 1
    // without stepping left the gate open, so the very next frame 33 ms later raised it
    // to 2 and stepped. Two consecutive FRAMES is not two consecutive windows, and the
    // result was the same one-step-per-900ms ratchet the rule exists to prevent. Caught
    // by replaying this function against hand-made timings; reading it proves nothing,
    // because the bug is in what the code does NOT write.
    governor.lastWindow = now;
    const budget = FRAME_INTERVAL_MS * 0.72; // leave headroom for the compositor
    let next = governor.scale;
    if (medianMs > budget) {
      // Down is urgent and unconditional. Unchanged from the original.
      governor.upStreak = 0;
      next = governor.scale * 0.86;
    } else if (medianMs < budget * 0.55) {
      // Up has to be earned twice. A single fast window is not evidence a machine can
      // hold a higher resolution — it is evidence that one window was cheap — and the
      // old code treated the two as the same thing, which is what turned an honest
      // measurement into an eleven-step ratchet.
      governor.upStreak += 1;
      // Bigger step, taken less often: the same climb in four reallocations instead of
      // eleven. Each one is a render-target rebuild, so fewer is better even now that
      // none of them is visible.
      if (governor.upStreak >= 2) next = governor.scale * 1.22;
    } else {
      governor.upStreak = 0;
    }
    next = THREE.MathUtils.clamp(next, governor.min, governor.max);
    if (Math.abs(next - governor.scale) > 0.01) {
      governor.scale = next;
      applyScale();
      // Every step is re-earned from scratch, so a run of cheap windows cannot bank
      // credit and fire several steps back to back.
      governor.upStreak = 0;
    }
  }

  // ==================================================================================
  // Pointer parallax.
  //
  // The camera moves, not the scene, so every layer separates by its real distance for
  // free. Targets are damped rather than followed: an undamped camera tracks the mouse
  // exactly and immediately looks like a cheap mousemove handler.
  // ==================================================================================
  // The canvas layer is deliberately non-interactive, so listen on its hit-testable home
  // container while continuing to normalise coordinates against the rendered stage.
  const pointerBinding = bindPointerParallax(stage);
  const pointer = pointerBinding.state;

  // Copied out of src/ui/themes/*.css by the generator, so the accent the shader grades
  // toward is the same hex the CSS uses. `kind` decides astral vs chart — it is the
  // `type` field from THEME_LIST in theme-store.ts, not a guess from the background.
  const THEMES = THEME_LIST.map((entry) => ({
    id: entry.id,
    label: entry.nameZh,
    kind: entry.type,
  }));

  function applyTheme(themeId) {
    const theme = THEMES.find((entry) => entry.id === themeId) || THEMES[1];
    const tokens = getComputedStyle(document.documentElement);
    const primary = tokens.getPropertyValue('--theme-primary').trim() || '#c9a85f';
    const background = tokens.getPropertyValue('--theme-window-bg').trim() || '#090b10';
    stage.dataset.astralTheme = theme.id;
    const light = theme.kind === 'light';
    gradePass.uniforms.uInk.value = light ? 1 : 0;
    gradePass.uniforms.uAccent.value.set(primary);
    if (light) {
      // Paper is the theme's own window background; ink is its accent taken most of the
      // way to black. Using the accent raw gives a washed-out chart with no contrast at
      // the density end — the deepest part of the disc has to approach ink, not accent.
      gradePass.uniforms.uPaper.value.set(background);
      gradePass.uniforms.uInkColor.value.set(primary).multiplyScalar(0.32);
    } else {
      gradePass.uniforms.uField.value.set(background).multiplyScalar(0.6);
    }
  }

  function setupDials() {
    for (const key of ['bloom', 'galaxy', 'arc', 'veils', 'runes', 'circle']) {
      const input = document.querySelector('#dial-' + key);
      const label = document.querySelector('#val-' + key);
      const sync = () => {
        dials[key] = Number(input.value) / 100;
        label.textContent = dials[key].toFixed(2);
      };
      input.addEventListener('input', sync);
      sync();
    }

    // Layout dials re-place rather than re-build: placeLayout() is pure placement and
    // the rotations are read fresh every frame, so dragging these is free.
    //
    // Each entry reads its slider in the unit PRINTED NEXT TO IT — percent for the two
    // placement axes, degrees for the three rotations. Sliders carry step=0.5 and
    // min/max in those same units, so the arrow keys step half a unit and the readout
    // never needs mental arithmetic. The earlier single dial normalised everything to
    // 0..1, which is why nudging it was guesswork.
    const layoutDials = [
      ['offset', (v) => (layout.offset = v / 100), (v) => v.toFixed(1) + '%'],
      ['height', (v) => (layout.height = v / 100), (v) => v.toFixed(1) + '%'],
      ['rotx', (v) => (layout.rotX = THREE.MathUtils.degToRad(v)), (v) => v.toFixed(1) + '°'],
      ['roty', (v) => (layout.rotY = THREE.MathUtils.degToRad(v)), (v) => v.toFixed(1) + '°'],
      ['rotz', (v) => (layout.rotZ = THREE.MathUtils.degToRad(v)), (v) => v.toFixed(1) + '°'],
      ['flank', (v) => (layout.flank = v / 100), (v) => (v / 100).toFixed(2)],
    ];
    for (const [key, apply, format] of layoutDials) {
      const input = document.querySelector('#dial-' + key);
      const label = document.querySelector('#val-' + key);
      const sync = () => {
        const value = Number(input.value);
        apply(value);
        label.textContent = format(value);
        placeLayout();
      };
      input.addEventListener('input', sync);
      sync();
    }

    const tintInput = document.querySelector('#dial-tint');
    const tintLabel = document.querySelector('#val-tint');
    const syncTint = () => {
      const value = Number(tintInput.value) / 100;
      // One dial, two modes: how far astral pulls toward the accent, and how hard
      // chart bites into the paper. They are never both visible, so sharing the
      // slider costs nothing and keeps the panel short.
      gradePass.uniforms.uThemeMix.value = value;
      gradePass.uniforms.uInkGain.value = 0.8 + value * 4.0;
      tintLabel.textContent = value.toFixed(2);
    };
    tintInput.addEventListener('input', syncTint);
    syncTint();

    const themeSelect = document.querySelector('#dial-theme');
    for (const theme of THEMES) {
      const option = document.createElement('option');
      option.value = theme.id;
      option.textContent = theme.label + ' · ' + theme.kind;
      themeSelect.appendChild(option);
    }
    themeSelect.value = 'obsidian';
    themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));
    applyTheme(themeSelect.value);

    // Whole-panel collapse. Separate class from `tune-collapsed` and never written
    // together, so the tuning section's own state survives a collapse/expand round
    // trip — the panel comes back exactly as it was left.
    //
    // Not the same control as the H key: that hides the panel outright (nothing left to
    // click), which is for screenshots. This leaves the chip behind, which is for
    // looking at the scene and then carrying on tuning.
    const hudPanel = document.querySelector('#hud');
    const panelButton = document.querySelector('#hud-collapse');
    panelButton.addEventListener('click', () => {
      const collapsed = hudPanel.classList.toggle('hud-collapsed');
      panelButton.textContent = collapsed ? 'show panel' : 'hide panel';
    });

    addEventListener('keydown', (event) => {
      if (event.key === 'h' || event.key === 'H') {
        document.querySelector('#hud').classList.toggle('hidden');
      }
      if (event.key === 't' || event.key === 'T') {
        document.querySelector('#ui').classList.toggle('hidden');
      }
    });
  }

  // ==================================================================================
  // Tuning. Where the engraved work sits relative to the disc, dragged rather than
  // guessed — this is the half of the composition placeLayout() does NOT own.
  //
  // Every radius here is in GALAXY RADII, so a number read off a slider can be pasted
  // straight back into the build calls above as `galaxy.radius * n`. Band depth and the
  // rail's half-width are held FIXED while a centre is dragged: they are coupled to
  // `repeat` (a glyph cell is circumference / (32 * repeat) wide and wants to be about
  // as wide as the band is deep), and `repeat` has to stay an integer or the seam at
  // uv.x = 1 tears a glyph in half. Stretched glyphs at the extremes of the R sliders
  // are therefore expected; when a radius is settled on, re-pick `repeat` by hand.
  // ==================================================================================
  const TUNE_BAND_DEPTH = 0.09; // register depth, in galaxy radii — held fixed
  const TUNE_RAIL_HALF_WIDTH = 0.028; // world units, as the rail is built

  // Tilts are stored in DEGREES to match this file's rotation dials; only the two
  // apply() bodies convert, so nothing else has to know which unit the panel speaks.
  //
  // ONE literal, used both to seed `tuning` and to drive reset. Written twice it would
  // eventually be edited once, and the failure is silent: reset would quietly restore a
  // composition that never shipped. The slider `value` attributes still have to agree
  // with this — bindTuner sync()s on startup, so the markup is what wins on load.
  const TUNING_DEFAULTS = {
    circleR: 0.94,
    circleZ: 1.75,
    circleStaticZ: -0.06,
    circleSpinZ: -0.08,
    circleTiltX: 0,
    circleTiltY: 0,
    rune1R: 1.735,
    // Sits exactly on the slider's max. Deliberate — the hand-tune wanted the inner
    // register right out at the front of the sweep, and widening the range to give it
    // headroom would change what every other z slider's travel feels like.
    rune1Z: 6.0,
    rune2R: 1.245,
    rune2Z: 1.05,
    railR: 1.89,
    railZ: 1.95,
  };

  const tuning = { ...TUNING_DEFAULTS };
  const tuningSync = {};

  // Dispose before replacing: the old attribute buffers live on the GPU and nothing else
  // holds a reference, so skipping this leaks a set of VBOs per slider tick — and a
  // slider tick is cheap to produce by the hundred.
  function retuneAnnulus(mesh, inner, outer) {
    mesh.geometry.dispose();
    mesh.geometry = buildAnnulus(inner, outer);
  }

  function applyCircleRadius() {
    // Radius is carried entirely by mesh scale — the SVG's outer ring sits at quad
    // radius 1659/2048, so there is no geometry to rebuild here at all.
    magicCircle.mesh.scale.setScalar((galaxy.radius * tuning.circleR * 2.0) / (1659 / 2048));
  }

  function applyRegisterRadius(index) {
    const center = index === 0 ? tuning.rune1R : tuning.rune2R;
    const half = TUNE_BAND_DEPTH * 0.5;
    retuneAnnulus(
      runeRegisters[index].mesh,
      galaxy.radius * (center - half),
      galaxy.radius * (center + half),
    );
  }

  function applyRailRadius() {
    const radius = galaxy.radius * tuning.railR;
    retuneAnnulus(runeRails[0].mesh, radius - TUNE_RAIL_HALF_WIDTH, radius + TUNE_RAIL_HALF_WIDTH);
  }

  // One binder for all ten rows. Range/step live in the input attributes, so the only
  // things that vary per row are how the readout is printed and what to do with the
  // value — same shape as the layout dials above.
  function bindTuner(key, format, apply) {
    const input = document.querySelector('#tune-' + key);
    const label = document.querySelector('#tval-' + key);
    const sync = () => {
      tuning[key] = Number(input.value);
      label.textContent = format(tuning[key]);
      apply();
    };
    tuningSync[key] = sync;
    input.addEventListener('input', sync);
    sync();
  }

  const tuneRadius = (value) => value.toFixed(3);
  const tuneDepth = (value) => value.toFixed(2);
  const tuneAngle = (value) => value.toFixed(1) + '°';

  // Programmatic entry point for the probe harness. It goes through the slider so the
  // control, the readout and the scene can never disagree.
  function setTuning(key, value) {
    const input = document.querySelector('#tune-' + key);
    if (!input || !tuningSync[key]) return false;
    input.value = String(value);
    tuningSync[key]();
    return true;
  }

  function setupTuning() {
    bindTuner('circleR', tuneRadius, applyCircleRadius);
    bindTuner('circleZ', tuneDepth, () => {
      magicCircle.mesh.position.z = tuning.circleZ;
    });
    bindTuner('circleStaticZ', tuneDepth, () => {
      magicCircle.staticMesh.position.z = tuning.circleStaticZ;
    });
    bindTuner('circleSpinZ', tuneDepth, () => {
      magicCircle.innerMesh.position.z = tuning.circleSpinZ;
    });
    bindTuner('circleTiltX', tuneAngle, () => {
      magicCircle.mesh.rotation.x = THREE.MathUtils.degToRad(tuning.circleTiltX);
    });
    bindTuner('circleTiltY', tuneAngle, () => {
      magicCircle.mesh.rotation.y = THREE.MathUtils.degToRad(tuning.circleTiltY);
    });
    bindTuner('rune1R', tuneRadius, () => applyRegisterRadius(0));
    bindTuner('rune1Z', tuneDepth, () => {
      runeRegisters[0].mesh.position.z = tuning.rune1Z;
    });
    bindTuner('rune2R', tuneRadius, () => applyRegisterRadius(1));
    bindTuner('rune2Z', tuneDepth, () => {
      runeRegisters[1].mesh.position.z = tuning.rune2Z;
    });
    bindTuner('railR', tuneRadius, applyRailRadius);
    bindTuner('railZ', tuneDepth, () => {
      runeRails[0].mesh.position.z = tuning.railZ;
    });

    // Reset goes through setTuning, not through `tuning`, for the same reason the probe
    // harness does: writing the object moves the scene and leaves the slider and the
    // readout showing the old value, which is worse than not resetting at all.
    document.querySelector('#tune-reset').addEventListener('click', () => {
      for (const [key, value] of Object.entries(TUNING_DEFAULTS)) setTuning(key, value);
    });

    // Collapse. Default expanded, and the head row never hides — a collapsed section
    // with no visible handle is a section you cannot get back.
    const hud = document.querySelector('#hud');
    const collapseButton = document.querySelector('#tune-collapse');
    collapseButton.addEventListener('click', () => {
      const collapsed = hud.classList.toggle('tune-collapsed');
      collapseButton.textContent = collapsed ? 'show' : 'hide';
    });
  }

  const statFps = document.querySelector('#stat-fps');
  const statMs = document.querySelector('#stat-ms');
  const statCalls = document.querySelector('#stat-calls');
  const statScale = document.querySelector('#stat-scale');

  // ==================================================================================
  // Frame loop. 30 fps cap: this is a slow ambient piece and nothing in it benefits from
  // 60, let alone the 120 a ProMotion panel would otherwise drive. Scene time comes from
  // the wall clock, so the cap changes smoothness only, never tempo.
  // ==================================================================================
  const clock = new THREE.Clock();
  const REDUCED_MOTION_TIME = 26.0;
  let lastFrameStamp = -Infinity;
  let fpsWindowStart = 0;
  let fpsWindowFrames = 0;
  let animationFrameId = 0;
  let running = true;
  let disposed = false;

  function animate(frameStamp = 0) {
    if (!running || disposed) return;
    animationFrameId = requestAnimationFrame(animate);
    if (frameStamp - lastFrameStamp < FRAME_INTERVAL_MS - 1) return;
    lastFrameStamp = frameStamp;

    const frameStart = performance.now();
    const time = reducedMotion ? REDUCED_MOTION_TIME : clock.getElapsedTime();
    uTime.value = time;

    pointer.x += (pointer.targetX - pointer.x) * 0.045;
    pointer.y += (pointer.targetY - pointer.y) * 0.045;

    // Autonomous drift so the piece lives without a pointer, plus a very slow dolly.
    // The dolly is the "zooming spiral" cue: it never arrives anywhere, it just keeps
    // the parallax from settling.
    const driftX = Math.sin(time * 0.043) * 0.55 + Math.sin(time * 0.017) * 0.3;
    const driftY = Math.cos(time * 0.037) * 0.32;
    const dolly = Math.sin(time * 0.021) * 0.85;

    camera.position.set(
      CAMERA_BASE.x + driftX - pointer.x * 1.15,
      CAMERA_BASE.y + driftY + pointer.y * 0.7,
      CAMERA_BASE.z + dolly,
    );
    camera.lookAt(CAMERA_TARGET);
    // Barely-there roll. At this amplitude it is not seen, it is only felt.
    camera.rotation.z += Math.sin(time * 0.029) * 0.012;

    galaxy.group.rotation.x = layout.rotX;
    galaxy.group.rotation.y = layout.rotY;
    // Breathing stays on Z only. On X it reads as the disc nodding, which is a
    // different and much more noticeable motion than the roll v2 intended.
    galaxy.group.rotation.z = layout.rotZ + Math.sin(time * 0.02) * 0.03;
    core.mesh.quaternion.copy(camera.quaternion);
    for (const child of veils.group.children) child.rotation.z += child.userData.spin * 0.016;

    galaxy.material.uniforms.uDial.value = dials.galaxy;
    haze.material.uniforms.uDial.value = dials.galaxy;
    rings.material.uniforms.uDial.value = dials.galaxy;
    for (const register of runeRegisters) register.material.uniforms.uDial.value = dials.runes;
    for (const rail of runeRails) rail.material.uniforms.uDial.value = dials.runes;
    magicCircle.material.uniforms.uDial.value = dials.circle;
    magicCircle.staticMaterial.uniforms.uDial.value = dials.circle;
    magicCircle.innerMaterial.uniforms.uDial.value = dials.circle;
    // The particle pass rides the dials of the layer it is shed from — one control per
    // idea, not one per object. Both shaders multiply their FINAL colour by uDial, so a
    // dial at 0 emits pure black into an additive blend: off, not merely dim.
    runeSparks.material.uniforms.uDial.value = dials.runes;
    circleMotes.material.uniforms.uDial.value = dials.circle;
    // ...and pick up wherever the tuner has dragged the bands and the figure to. Ordered
    // AFTER the group rotations above and before render, so a slider moved mid-frame is
    // never one frame out of step with the geometry it belongs to.
    runeSparks.sync();
    circleMotes.sync();
    core.material.uniforms.uDial.value = dials.galaxy;
    for (const arc of arcs) arc.material.uniforms.uDial.value = dials.arc;
    for (const material of veils.materials) material.uniforms.uDial.value = dials.veils;
    storm.material.uniforms.uDial.value = dials.veils;
    bokeh.material.uniforms.uDial.value = dials.veils;

    bloom.strength = 0.28 * dials.bloom;
    bloom.radius = 0.86;
    gradePass.uniforms.uTime.value = time;

    // THE GOVERNOR DECIDES BEFORE THE RENDER, NOT AFTER IT.
    //
    // This is the ordering fix for the startup flicker (see the long note on the
    // governor). applyScale() writes canvas.width/height, which reallocates and clears
    // the drawing buffer; run after composer.render() that cleared buffer is what gets
    // composited, and the next draw is a 30 fps tick away, so every scale step showed as
    // one black frame. Deciding first means a resize is always followed immediately by
    // the draw that refills it.
    //
    // The median is one frame stale as a result. That is a non-issue for a median of 24
    // and worth naming so nobody "fixes" it back: the sample this frame would have added
    // cannot move a 24-sample median enough to change any decision.
    if (governor.samples.length === 24) {
      const sorted = [...governor.samples].sort((a, b) => a - b);
      considerScale(sorted[12], frameStamp);
    }

    composer.render();

    // ---- governor sampling + readout
    //
    // A frame in which applyScale() ran carries the render-target rebuild in its cost.
    // That is honest — the rebuild really did happen — and one inflated sample in
    // twenty-four cannot move the median, so it is left in rather than special-cased.
    const cost = performance.now() - frameStart;
    governor.samples.push(cost);
    if (governor.samples.length > 24) governor.samples.shift();
    fpsWindowFrames += 1;
    if (frameStamp - fpsWindowStart > 500) {
      const fps = (fpsWindowFrames * 1000) / (frameStamp - fpsWindowStart);
      if (statFps && statMs && statCalls && statScale) {
        statFps.textContent = fps.toFixed(0);
        statMs.textContent = cost.toFixed(1);
        statCalls.textContent = renderer.info.render.calls;
        statScale.textContent = governor.scale.toFixed(2);
      }
      fpsWindowStart = frameStamp;
      fpsWindowFrames = 0;
    }
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  resize();
  applyTheme(options.themeId);

  // Warm the pipeline before the loop is allowed to measure anything.
  //
  // three compiles a shader program the first time a material is actually rendered, and
  // this scene carries seventeen of them (two more since the particle pass), plus first
  // uploads for a 120k-point disc, the glyph atlas and the baked veil volume. Whichever
  // frames pay that are tens of milliseconds, and under the old ordering those were the
  // first frames the governor sampled — so its opening decisions were a measurement of
  // the shader compiler rather than of the frame.
  //
  // renderer.compile() covers the scene's own materials; it does NOT cover the composer
  // passes, which are full-screen quads that live outside the scene graph. Hence the two
  // throwaway composer frames: the first compiles the bloom/grade/FXAA/output chain, the
  // second runs it with everything already resident. They draw the same t=0 picture the
  // first real frame would, so there is nothing to see.
  renderer.compile(scene, camera);
  composer.render();
  composer.render();

  // The grace window is measured from HERE, so it covers the first real frames rather
  // than being eaten by module loading.
  governor.started = performance.now();
  animate();

  return {
    applyTheme,
    pause() {
      if (disposed || !running) return;
      running = false;
      cancelAnimationFrame(animationFrameId);
      clock.stop();
    },
    resume() {
      if (disposed || running) return;
      running = true;
      clock.start();
      animationFrameId = requestAnimationFrame(animate);
    },
    resize,
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      pointerBinding.dispose();

      const textures = new Set();
      scene.traverse((object) => {
        object.geometry?.dispose?.();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (!material) continue;
          for (const uniform of Object.values(material.uniforms ?? {})) {
            const value = uniform?.value;
            if (value?.isTexture) textures.add(value);
          }
          material.dispose?.();
        }
      });
      for (const texture of textures) texture.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
