import * as THREE from "three";

/**
 * Full-screen post pass that renders the scene as 1-bit black & white made of
 * ASCII-ish *symbols*, not just dots. The screen is split into cells; each cell
 * samples the scene's local darkness and stamps a glyph from a ramp sorted by
 * ink coverage (space . : - = + * / # @ ...). Light areas get sparse ticks,
 * mid-tones get strokes/hatching, dark areas get dense glyphs — giving the
 * engraved, textured look of the reference matte.
 *
 * Usage:
 *   const pass = new DitherPass({ cell: 8 });
 *   pass.setSize(bufferW, bufferH);
 *   // each frame, after rendering the scene into `rt`:
 *   pass.render(renderer, rt.texture);
 */
export class DitherPass {
  constructor({ cell = 8 } = {}) {
    this.cell = cell;
    const glyphs = makeGlyphAtlas(cell);
    const bayer = makeBayerTexture(3); // 8x8, used to jitter glyph selection

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tGlyph: { value: glyphs.texture },
        tBayer: { value: bayer },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uCell: { value: cell },
        uGlyphCount: { value: glyphs.count },
        uContrast: { value: 1.08 },
        uBrightness: { value: 0.0 },
        uLevels: { value: 5 }, // number of gray output bands (2 = pure B&W)
        uBlack: { value: 0.08 }, // darkest band isn't pure #000, just very dark
        uDither: { value: 1.15 / glyphs.count }, // ~one glyph step of jitter
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tScene;
        uniform sampler2D tGlyph;
        uniform sampler2D tBayer;
        uniform vec2  uResolution;
        uniform float uCell;
        uniform float uGlyphCount;
        uniform float uContrast;
        uniform float uBrightness;
        uniform float uLevels;
        uniform float uBlack;
        uniform float uDither;
        varying vec2 vUv;

        float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

        void main() {
          vec2 cell = floor(gl_FragCoord.xy / uCell);
          vec2 base = cell * uCell;
          vec2 inCell = (gl_FragCoord.xy - base) / uCell; // 0..1 within cell
          vec2 px = 1.0 / uResolution;

          // Sample several taps in the cell. Take the darkest so very thin
          // spires survive against the pale sky instead of aliasing away.
          vec2 ctr = base + uCell * 0.5;
          float lc = lum(texture2D(tScene, ctr * px).rgb);
          float lmin = lc;
          lmin = min(lmin, lum(texture2D(tScene, (base + uCell * vec2(0.22, 0.22)) * px).rgb));
          lmin = min(lmin, lum(texture2D(tScene, (base + uCell * vec2(0.78, 0.22)) * px).rgb));
          lmin = min(lmin, lum(texture2D(tScene, (base + uCell * vec2(0.22, 0.78)) * px).rgb));
          lmin = min(lmin, lum(texture2D(tScene, (base + uCell * vec2(0.78, 0.78)) * px).rgb));
          float l = mix(lc, lmin, 0.5);

          l = clamp((l - 0.5) * uContrast + 0.5 + uBrightness, 0.0, 1.0);

          // Quantize darkness into uLevels gray bands. Each cell sits between
          // two adjacent grays; the glyph stipples the transition between them,
          // so we get REAL grays (light sky / mid ground / dark spires read as
          // distinct tones) while keeping the engraved-symbol texture.
          float d = 1.0 - l;
          float t = d * (uLevels - 1.0);
          float lo = floor(t);
          float frac = t - lo; // 0 at the lighter band .. 1 toward the darker

          // ordered jitter so flat bands don't show a hard contour
          float b = texture2D(tBayer, (mod(cell, 8.0) + 0.5) / 8.0).r;
          float fr = clamp(frac + (b - 0.5) * uDither, 0.0, 1.0);

          // pick a glyph by how far we are toward the darker band (0 = empty)
          float gi = clamp(floor(fr * (uGlyphCount - 0.0001)), 0.0, uGlyphCount - 1.0);
          vec2 gUv = vec2((gi + inCell.x) / uGlyphCount, inCell.y);
          float ink = texture2D(tGlyph, gUv).r; // 1 where the glyph stroke is

          // inked pixels drop to the next-darker band; bare pixels stay lighter
          float level = clamp(lo + step(0.5, ink), 0.0, uLevels - 1.0);
          float shade = 1.0 - level / (uLevels - 1.0); // 1 light .. 0 darkest band
          float v = mix(uBlack, 1.0, shade); // lift the darkest band off pure black
          gl_FragColor = vec4(vec3(v), 1.0);
        }
      `,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  setSize(w, h) {
    this.material.uniforms.uResolution.value.set(w, h);
  }

  render(renderer, sceneTexture) {
    this.material.uniforms.tScene.value = sceneTexture;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }
}

/**
 * Build a horizontal glyph-atlas texture: a curated set of symbols rendered
 * into `tile`x`tile` cells, then *sorted by measured ink coverage* and
 * deduped, so the resulting ramp is monotonic light -> dark. Drawn white-on-
 * black, so texture .r = 1 exactly where a glyph stroke is.
 *
 * Returns { texture, count, tile }.
 */
function makeGlyphAtlas(tile) {
  // candidates span dots, dashes, hatching, slashes and dense blocks; order
  // doesn't matter, we sort by actual coverage below.
  const candidates = [
    " ", ".", "'", "`", ",", "^", ":", "~", ";", "-", "_", "=", "+",
    "<", ">", "/", "\\", "|", "i", "l", "*", "r", "c", "v", "x", "z",
    "s", "t", "o", "e", "a", "j", "n", "u", "w", "m", "%", "8", "#",
    "&", "@", "█",
  ];

  // measure coverage of each glyph
  const mc = document.createElement("canvas");
  mc.width = mc.height = tile;
  const mctx = mc.getContext("2d", { willReadFrequently: true });
  mctx.imageSmoothingEnabled = false;
  const font = `${tile}px ui-monospace, "SF Mono", Menlo, monospace`;

  const items = [];
  for (const ch of candidates) {
    mctx.fillStyle = "#000";
    mctx.fillRect(0, 0, tile, tile);
    mctx.fillStyle = "#fff";
    mctx.font = font;
    mctx.textAlign = "center";
    mctx.textBaseline = "middle";
    mctx.fillText(ch, tile / 2, tile / 2 + 0.5);
    const data = mctx.getImageData(0, 0, tile, tile).data;
    let ink = 0;
    for (let i = 0; i < tile * tile; i++) if (data[i * 4] > 127) ink++;
    items.push({ ch, ink });
  }

  // Sort by coverage, then RESAMPLE to a ramp that is ~uniform in ink
  // coverage. Font glyph sets are lopsided — lots of near-empty punctuation,
  // few dense symbols — so naively keeping every distinct level packs most of
  // the ramp into the lights. Indexing that linearly makes mid-tones land on
  // near-empty glyphs, so everything reads too white. Picking the glyph whose
  // measured coverage is closest to each evenly spaced target makes glyph index
  // ~linear in density, so a 50%-dark cell actually gets ~50% ink.
  items.sort((a, b) => a.ink - b.ink);
  const maxInk = items[items.length - 1].ink || 1;
  const STEPS = 16;
  const ramp = [];
  for (let k = 0; k < STEPS; k++) {
    const target = (k / (STEPS - 1)) * maxInk;
    let best = items[0];
    for (const it of items) {
      if (Math.abs(it.ink - target) < Math.abs(best.ink - target)) best = it;
    }
    if (ramp[ramp.length - 1] !== best.ch) ramp.push(best.ch); // dedupe runs
  }

  // compose the atlas strip
  const n = ramp.length;
  const atlas = document.createElement("canvas");
  atlas.width = tile * n;
  atlas.height = tile;
  const ctx = atlas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, atlas.width, atlas.height);
  ctx.fillStyle = "#fff";
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < n; i++) {
    ctx.fillText(ramp[i], i * tile + tile / 2, tile / 2 + 0.5);
  }

  const tex = new THREE.CanvasTexture(atlas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.flipY = false; // keep atlas pixel rows aligned with inCell.y
  tex.needsUpdate = true;
  return { texture: tex, count: n, tile };
}

/**
 * Normalized NxN Bayer matrix (recursive construction) packed into an RGBA
 * nearest-filtered repeating texture. RGBA (not single-channel) for Safari
 * compatibility. nPow = 3 -> 8x8.
 */
function makeBayerTexture(nPow) {
  let m = [[0]];
  for (let k = 0; k < nPow; k++) {
    const s = m.length;
    const ns = s * 2;
    const next = Array.from({ length: ns }, () => new Array(ns));
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const v = m[y][x];
        next[y][x] = 4 * v;
        next[y][x + s] = 4 * v + 2;
        next[y + s][x] = 4 * v + 3;
        next[y + s][x + s] = 4 * v + 1;
      }
    }
    m = next;
  }

  const n = m.length;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = Math.round(((m[y][x] + 0.5) / (n * n)) * 255);
      const idx = (y * n + x) * 4;
      data[idx] = data[idx + 1] = data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
