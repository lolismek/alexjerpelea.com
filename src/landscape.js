import * as THREE from "three";

/**
 * Procedural spire landscape, built to match the reference matte:
 *  - a pale gradient sky with a sweeping cloud band (sky dome shader)
 *  - rugged, cracked ground (displaced + ridged noise, dark fissures)
 *  - a dense, clustered field of very slender needle-spires that flare into
 *    little feet/mounds where they meet the ground, lean at varied angles,
 *    and have a roughened (striated) surface
 *  - strong one-sided key light so big spires read bright-edge / near-black-face
 *  - distance fog so far spires melt pale into the sky
 *
 * Everything is grayscale on purpose; the glyph-dither pass downstream turns it
 * into 1-bit symbols. Returns { scene, camera, update(t), resize(w, h) }.
 */
export function createLandscape() {
  // ---- tunables ------------------------------------------------------------
  const HORIZON = 0.82; // lightest sky value, also the fog color
  const ZENITH = 0.62; // sky darkens a touch overhead
  const SPIKE_COUNT = 740;
  const FIELD_INNER = 16; // bare clearing the camera sits inside
  const FIELD_OUTER = 120;
  const ORBIT_RADIUS = 10; // camera orbits inside the clearing, looking outward
  const ORBIT_SPEED = 0.045; // rad/s — a full turn ~140s
  const CAM_HEIGHT = 4.0;
  const LOOK_AT = new THREE.Vector3(0, 8, 0); // y = look height; x/z come from the outward gaze each frame
  const CLUSTERS = 40;
  // -------------------------------------------------------------------------

  const fogColor = new THREE.Color(HORIZON, HORIZON, HORIZON);

  const scene = new THREE.Scene();
  scene.background = fogColor;
  scene.fog = new THREE.Fog(fogColor, 45, 320); // pushed back so the mid-field ground keeps its texture

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 600);

  // ---- lighting: one fixed high-side sun + hemisphere fill ----------------
  // A single consistent key, high and to one side (like the reference), so a
  // spire keeps a lit flank and a dark flank no matter where the camera orbits.
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-0.9, 1.3, 0.5); // up and to the side; stays put
  scene.add(key);
  // sky/ground hemisphere fill: the shadow side fades naturally (lighter near
  // the top, darker toward the base) instead of crushing to a flat black void.
  scene.add(new THREE.HemisphereLight(0xcfcfcf, 0x161616, 0.4));

  // deterministic RNG so the field is identical on every load
  const rnd = makeRng(1337);

  // ---- sky dome ------------------------------------------------------------
  const sky = makeSky(HORIZON, ZENITH);
  scene.add(sky);

  // ---- spikes + ground -----------------------------------------------------
  // Placement is shared so the ground can grow mounds/roots from each spire
  // foot, and the placer can space feet so neighbouring mounds don't collide.
  const spikes = placeSpikes(SPIKE_COUNT, FIELD_INNER, FIELD_OUTER, CLUSTERS, rnd);
  scene.add(buildSpikes(spikes));
  scene.add(buildGround(spikes));

  // ---- camera orbit + user drag control ------------------------------------
  const skyMat = sky.material;

  let userAngle = 0; // manual rotation added on top of the slow auto-orbit
  let velocity = 0; // angular inertia after a flick
  let dragging = false;
  let pitch = 0; // small vertical tilt from vertical drag
  const SENS = 0.005; // rad per px dragged horizontally
  const PITCH_SENS = 0.03;
  const lookTarget = LOOK_AT.clone();

  function onDragStart() {
    dragging = true;
    velocity = 0;
  }
  function onDragMove(dx, dy) {
    userAngle -= dx * SENS;
    velocity = -dx * SENS; // remember last delta as throw velocity
    pitch = THREE.MathUtils.clamp(pitch - dy * PITCH_SENS, -5.5, 7);
  }
  function onDragEnd() {
    dragging = false;
  }

  function update(t) {
    if (!dragging) {
      userAngle += velocity;
      velocity *= 0.94; // ease the flick out
    }
    const a = t * ORBIT_SPEED + userAngle;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    camera.position.set(cx * ORBIT_RADIUS, CAM_HEIGHT, cz * ORBIT_RADIUS);
    // look OUTWARD into the field (not back across the empty clearing), so the
    // spires stand right ahead instead of a long way off on the far rim.
    lookTarget.set(cx * (ORBIT_RADIUS + 40), LOOK_AT.y + pitch, cz * (ORBIT_RADIUS + 40));
    camera.lookAt(lookTarget);
    if (skyMat) skyMat.uniforms.uTime.value = t;
  }

  function resize(w, h) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return { scene, camera, update, resize, onDragStart, onDragMove, onDragEnd };
}

/* ------------------------------------------------------------------------- */
/* sky                                                                       */
/* ------------------------------------------------------------------------- */
function makeSky(horizon, zenith) {
  const geo = new THREE.SphereGeometry(320, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uHorizon: { value: new THREE.Color(horizon, horizon, horizon) },
      uZenith: { value: new THREE.Color(zenith, zenith, zenith) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uHorizon;
      uniform vec3 uZenith;
      uniform float uTime;

      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i), b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float fbm(vec2 p){
        float s = 0.0, amp = 0.5;
        for (int i = 0; i < 5; i++) { s += amp * noise(p); p *= 2.0; amp *= 0.5; }
        return s;
      }

      void main() {
        float up = clamp(vDir.y * 1.25, 0.0, 1.0);
        vec3 base = mix(uHorizon, uZenith, pow(up, 0.85));

        // big soft cloud band, biased to a high diagonal sweep, slow drift
        float ang = atan(vDir.z, vDir.x);
        vec2 sp = vec2(ang * 1.7, vDir.y * 2.6 + uTime * 0.015);
        float cloud = fbm(sp * 1.4 + 3.0);
        float band = smoothstep(0.08, 0.7, vDir.y + 0.28 * sin(ang * 1.3));
        float c = clamp((cloud - 0.42) * 1.9, 0.0, 1.0) * band;

        vec3 col = mix(base, base * 0.72, c); // darker streaks
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

/* ------------------------------------------------------------------------- */
/* spikes                                                                    */
/* ------------------------------------------------------------------------- */
function placeSpikes(count, inner, outer, clusterCount, rnd) {
  // cluster centers so the field forms groves with clearings between, biased
  // outward (toward the horizon) so the foreground stays open.
  const clusters = [];
  for (let i = 0; i < clusterCount; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = inner + Math.pow(rnd(), 0.4) * (outer - inner);
    clusters.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }

  // The ground reuses this grid to grow mounds/roots; the placer uses it to
  // reject a spire whose foot would crowd a neighbour's mound.
  const grid = makeGrid(24);
  const list = [];
  const maxAttempts = count * 6;
  for (let attempt = 0; list.length < count && attempt < maxAttempts; attempt++) {
    // Three tiers: rare bold foreground heroes, mid-distance groves, and a
    // dense low "sea" of small spires filling the far horizon.
    const roll = rnd();
    let x, z, h, ratio;
    if (roll < 0.018) {
      const a = rnd() * Math.PI * 2;
      const rr = inner + 8 + rnd() * 30; // 32..62
      x = Math.cos(a) * rr;
      z = Math.sin(a) * rr;
      h = 44 + rnd() * 26; // tall
      ratio = 0.055 + rnd() * 0.03;
    } else if (roll < 0.52) {
      const a = rnd() * Math.PI * 2;
      const rr = 52 + rnd() * (outer - 52);
      x = Math.cos(a) * rr;
      z = Math.sin(a) * rr;
      h = 2.5 + Math.pow(rnd(), 1.6) * 15; // small
      ratio = 0.05 + rnd() * 0.035;
    } else {
      const c = clusters[(rnd() * clusters.length) | 0];
      const spread = 3.5 + rnd() * 8; // wider groves so mounds don't pile up
      x = c[0] + (rnd() - rnd()) * spread;
      z = c[1] + (rnd() - rnd()) * spread;
      h = 6 + Math.pow(rnd(), 1.8) * 30; // 6..36
      ratio = 0.05 + rnd() * 0.03;
    }
    // keep the camera's clearing clear: nothing spawns inside FIELD_INNER
    if (x * x + z * z < inner * inner) continue;
    const radius = h * ratio;
    const footR = radius * 1.7; // mound footprint radius

    // spacing: skip this spire if its foot would crowd an already-placed one
    let ok = true;
    for (const p of grid.near(x, z)) {
      const dx = p.x - x;
      const dz = p.z - z;
      const gap = (p.footR + footR) * 0.8;
      if (dx * dx + dz * dz < gap * gap) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const p = {
      x,
      z,
      h,
      radius,
      footR,
      leanAmt: (rnd() < 0.15 ? 0.26 : 0.09) * rnd(),
      leanDir: rnd() * Math.PI * 2,
      rotY: rnd() * Math.PI * 2,
      rootCount: 3 + ((rnd() * 3) | 0), // 3..5 roots
      rootPhase: rnd() * Math.PI * 2,
    };
    list.push(p);
    grid.insert(p);
  }
  return { list, grid };
}

function buildSpikes({ list }) {
  const group = new THREE.Group();

  // Profile: a swollen basal mound necking down into a long conic shaft. r is
  // in [0,1]; instance scale.x sets the world radius at the foot.
  const profile = [];
  const SEG = 36;
  const MOUND_H = 0.15; // bottom fraction of height that swells into the mound
  const MOUND_FLARE = 0.6; // extra base radius (× shaft); the ground adds the rest
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG; // 0 foot, 1 tip
    let r;
    if (t < MOUND_H) {
      const tt = t / MOUND_H; // 0 base .. 1 where the mound meets the shaft
      r = 0.86 + MOUND_FLARE * Math.pow(1.0 - tt, 1.7);
    } else {
      const tt = (t - MOUND_H) / (1.0 - MOUND_H);
      // mainly CONIC (straight) taper: a thick, substantial cone, not a needle
      let rr = 0.86 * (1.0 - tt);
      rr += 0.05 * Math.sin(tt * Math.PI * 3.0) * (1.0 - tt * 0.7);
      r = Math.max(rr, 0.004);
    }
    profile.push(new THREE.Vector2(r, t));
  }
  const geo = new THREE.LatheGeometry(profile, 18);

  // roughen: vertical striations up the body, plus heavy lumpiness at the foot
  // so the mound reads gnarled where it meets the ground, not a clean cone.
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i); // 0..1 height
    const z = pos.getZ(i);
    const ang = Math.atan2(z, x);
    const n =
      0.22 * (valNoise(ang * 2.5, y * 8.0) - 0.5) +
      0.11 * (valNoise(ang * 6.0, y * 20.0) - 0.5);
    const baseRug = Math.max(0, 1.0 - y / 0.22); // 1 at foot -> 0 above the mound
    const lump =
      baseRug *
      (0.3 * (valNoise(ang * 3.5 + 11.0, y * 5.0) - 0.5) +
        0.18 * (valNoise(ang * 7.0 + 3.0, y * 11.0) - 0.5));
    const scale = 1.0 + n + lump;
    pos.setX(i, x * scale);
    pos.setZ(i, z * scale);
  }
  geo.computeVertexNormals();

  const mat = new THREE.MeshLambertMaterial({
    color: new THREE.Color(0.2, 0.2, 0.2), // near-black; the key gives a bright edge
  });

  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    dummy.position.set(p.x, -0.6, p.z); // sink the foot into the ground
    dummy.rotation.set(
      Math.cos(p.leanDir) * p.leanAmt,
      p.rotY,
      Math.sin(p.leanDir) * p.leanAmt
    );
    dummy.scale.set(p.radius, p.h, p.radius);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false; // big leaning instances; never pop out

  group.add(mesh);
  return group;
}

/* ------------------------------------------------------------------------- */
/* ground                                                                    */
/* ------------------------------------------------------------------------- */
function buildGround({ grid }) {
  const SIZE = 700;
  const SEG = 320; // finer mesh so roots/cracks actually resolve
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i); // local Y -> world -Z after the rotation below
    const wx = x; // world X of this vertex
    const wz = -y; // world Z (matches the coords spikes were placed in)

    // rolling undulation + finer rugged detail (local Z -> world height)
    const roll = (fbm(x * 0.018, y * 0.018) - 0.5) * 3.4;
    const rough = (fbm(x * 0.13, y * 0.13) - 0.5) * 1.9;
    const fine = (fbm(x * 0.55, y * 0.55) - 0.5) * 0.6;

    // ridged cracks carved into the surface so even spire-free ground reads as
    // a broken, rugged plain (and lines up with the dark fissure colour below).
    const pr = Math.abs(valNoise(x * 0.06 + 3.0, y * 0.06 - 2.0) * 2.0 - 1.0);
    const crackRelief = -Math.pow(1.0 - pr, 8.0) * 0.9;

    // mounds + roots grown from nearby spire feet
    let bump = 0;
    for (const p of grid.near(wx, wz)) {
      const dx = wx - p.x;
      const dz = wz - p.z;
      const d = Math.sqrt(dx * dx + dz * dz) + 1e-4;
      const fr = p.footR;
      // smooth mound that blends the spire base up out of the ground
      bump += p.h * 0.045 * Math.exp(-(d * d) / (fr * fr * 2.2));
      // roots: raised gnarled ridges radiating out — only the larger spires
      if (p.h > 14.0 && d < fr * 5.0) {
        const phi = Math.atan2(dz, dx);
        let ridge = 0;
        for (let k = 0; k < p.rootCount; k++) {
          const ra = p.rootPhase + (k / p.rootCount) * Math.PI * 2.0;
          ridge = Math.max(ridge, Math.pow(Math.max(0, Math.cos(phi - ra)), 6.0));
        }
        const radial = Math.max(0, 1.0 - d / (fr * 5.0));
        const gnarl = 0.7 + 0.6 * valNoise(d * 0.4, phi * 2.0);
        bump += p.h * 0.035 * ridge * radial * radial * gnarl;
      }
    }

    const height = roll + rough + fine + crackRelief + bump;
    pos.setZ(i, height);

    // dark fissures: ridged noise carves narrow dark crack-lines
    const ridge = Math.abs(valNoise(x * 0.09, y * 0.09) * 2.0 - 1.0);
    const crack = Math.pow(1.0 - ridge, 10.0); // ~1 along thin ridge lines
    const ridge2 = Math.abs(valNoise(x * 0.31 + 9.0, y * 0.31 - 4.0) * 2.0 - 1.0);
    const crack2 = Math.pow(1.0 - ridge2, 14.0);
    const carve = Math.pow(1.0 - pr, 8.0); // same noise as the carved crackRelief

    // The ground is flat-lit (uniform sun on an up-facing plane), so only the
    // albedo carries tone. Keep it a true MID-gray with a wide tonal spread so
    // it straddles several quantizer bands instead of sitting bright in one and
    // flattening to a single gray. Relief tints it (crests light, hollows/
    // mounds/roots dark), broad mottling + grain break it up, cracks cut dark.
    const mottle = (fbm(x * 0.22 + 17.0, y * 0.22 - 5.0) - 0.5) * 0.18;
    const reliefTint = (rough + fine * 1.5 + bump * 0.4) * 0.1;
    let g = 0.34 + reliefTint + mottle + (fbm(x * 0.5, y * 0.5) - 0.5) * 0.2;
    g *= 1.0 - 0.85 * carve; // carved fractures read as dark lines
    g *= 1.0 - 0.6 * crack - 0.5 * crack2; // extra fine fissures
    g = THREE.MathUtils.clamp(g, 0.04, 0.85);
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = g;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/* ------------------------------------------------------------------------- */
/* noise helpers (deterministic value noise + fbm)                           */
/* ------------------------------------------------------------------------- */
/* spatial hash of spire feet so the ground can look up only nearby spires */
function makeGrid(cell) {
  const map = new Map();
  const key = (cx, cz) => cx + "," + cz;
  return {
    insert(p) {
      const k = key(Math.floor(p.x / cell), Math.floor(p.z / cell));
      const arr = map.get(k);
      if (arr) arr.push(p);
      else map.set(k, [p]);
    },
    near(x, z) {
      const cx = Math.floor(x / cell);
      const cz = Math.floor(z / cell);
      const out = [];
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const arr = map.get(key(cx + dx, cz + dz));
          if (arr) for (let j = 0; j < arr.length; j++) out.push(arr[j]);
        }
      }
      return out;
    },
  };
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hash2(ix, iz) {
  let h = (ix | 0) * 374761393 + (iz | 0) * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h >>> 0) / 4294967296;
}

function valNoise(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function fbm(x, z) {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < 5; i++) {
    s += amp * valNoise(x * f, z * f);
    f *= 2;
    amp *= 0.5;
  }
  return s;
}
