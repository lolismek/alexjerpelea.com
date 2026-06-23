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
  const HORIZON = 0.9; // lightest sky value, also the fog color
  const ZENITH = 0.66; // sky darkens a touch overhead
  const SPIKE_COUNT = 740;
  const FIELD_INNER = 24; // bare clearing the camera sits inside
  const FIELD_OUTER = 120;
  const ORBIT_RADIUS = 9; // camera orbits *inside* the clearing, looking out
  const ORBIT_SPEED = 0.045; // rad/s — a full turn ~140s
  const CAM_HEIGHT = 5.0;
  const LOOK_AT = new THREE.Vector3(0, 8, 0); // slight upward look across the field
  const CLUSTERS = 40;
  // -------------------------------------------------------------------------

  const fogColor = new THREE.Color(HORIZON, HORIZON, HORIZON);

  const scene = new THREE.Scene();
  scene.background = fogColor;
  scene.fog = new THREE.Fog(fogColor, 30, 260); // far spires fade into sky

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 600);

  // ---- lighting: hard one-sided key + low fill ----------------------------
  // low, raking key so vertical spires get a bright edge and a near-black face.
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(-1.0, 0.62, 0.42);
  scene.add(key);
  scene.add(new THREE.AmbientLight(0xffffff, 0.22));

  // deterministic RNG so the field is identical on every load
  const rnd = makeRng(1337);

  // ---- sky dome ------------------------------------------------------------
  const sky = makeSky(HORIZON, ZENITH);
  scene.add(sky);

  // ---- spike geometry ------------------------------------------------------
  scene.add(buildSpikes(SPIKE_COUNT, FIELD_INNER, FIELD_OUTER, CLUSTERS, rnd));

  // ---- ground --------------------------------------------------------------
  scene.add(buildGround());

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
    camera.position.set(
      Math.cos(a) * ORBIT_RADIUS,
      CAM_HEIGHT,
      Math.sin(a) * ORBIT_RADIUS
    );
    lookTarget.set(LOOK_AT.x, LOOK_AT.y + pitch, LOOK_AT.z);
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
function buildSpikes(count, inner, outer, clusterCount, rnd) {
  const group = new THREE.Group();

  // Profile: a flared foot (wide base / mound) that quickly necks down into a
  // long, thin shaft tapering to a sharp tip. r is in [0,1]; instance scale.x
  // sets the world radius at the foot.
  const profile = [];
  const SEG = 30;
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG; // 0 foot, 1 tip
    let r;
    if (t < 0.1) {
      const tt = t / 0.1; // 0..1 across the flared foot/mound
      r = 1.0 - 0.12 * tt; // flare 1.0 -> 0.88
    } else {
      const tt = (t - 0.1) / 0.9;
      // mainly CONIC (straight) taper: a thick, substantial cone, not a needle
      let rr = 0.88 * (1.0 - tt);
      // rugged: gentle convex bulges / concave pinches up the body, easing at tip
      rr += 0.06 * Math.sin(tt * Math.PI * 3.0) * (1.0 - tt * 0.7);
      r = Math.max(rr, 0.004);
    }
    profile.push(new THREE.Vector2(r, t));
  }
  const geo = new THREE.LatheGeometry(profile, 13); // facets, smooth-ish shading

  // roughen the silhouette so spires read striated/rugged, not glassy cones
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i); // 0..1 height
    const z = pos.getZ(i);
    const ang = Math.atan2(z, x);
    // vertical striations + lumpiness so silhouettes read rugged, not glassy
    const n =
      0.22 * (valNoise(ang * 2.5, y * 8.0) - 0.5) +
      0.11 * (valNoise(ang * 6.0, y * 20.0) - 0.5);
    const scale = 1.0 + n * (y < 0.06 ? 0.2 : 1.0); // keep the foot tidy
    pos.setX(i, x * scale);
    pos.setZ(i, z * scale);
  }
  geo.computeVertexNormals();

  const mat = new THREE.MeshLambertMaterial({
    color: new THREE.Color(0.14, 0.14, 0.14), // near-black; the key gives a bright edge
  });

  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const dummy = new THREE.Object3D();

  // cluster centers so the field forms groves with clearings between.
  // Biased outward (toward the horizon) so the foreground stays open.
  const clusters = [];
  for (let i = 0; i < clusterCount; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = inner + Math.pow(rnd(), 0.4) * (outer - inner);
    clusters.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }

  for (let i = 0; i < count; i++) {
    // Three tiers: rare bold foreground heroes, mid-distance groves, and a
    // dense low "sea" of small spires filling the far horizon.
    const roll = rnd();
    let x, z, h, ratio;
    if (roll < 0.018) {
      // hero — towering & slender, set back a bit so it doesn't go fat-triangle
      const a = rnd() * Math.PI * 2;
      const rr = inner + 8 + rnd() * 30; // 32..62
      x = Math.cos(a) * rr;
      z = Math.sin(a) * rr;
      h = 44 + rnd() * 26; // 44..70 — tall
      ratio = 0.055 + rnd() * 0.03; // thick & substantial (≈1:6–1:9)
    } else if (roll < 0.52) {
      // distant sea — many small spires across the horizon band
      const a = rnd() * Math.PI * 2;
      const rr = 52 + rnd() * (outer - 52); // 52..outer
      x = Math.cos(a) * rr;
      z = Math.sin(a) * rr;
      h = 2.5 + Math.pow(rnd(), 1.6) * 15; // 2.5..17.5, small
      ratio = 0.05 + rnd() * 0.035;
    } else {
      // mid groves — clustered, medium height, with open gaps between
      const c = clusters[(rnd() * clusters.length) | 0];
      const spread = 2.5 + rnd() * 6;
      x = c[0] + (rnd() - rnd()) * spread;
      z = c[1] + (rnd() - rnd()) * spread;
      h = 6 + Math.pow(rnd(), 1.8) * 30; // 6..36
      ratio = 0.05 + rnd() * 0.03; // thick conic body
    }
    const radius = h * ratio;

    // lean: most slightly off-vertical, a few markedly tilted
    const leanAmt = (rnd() < 0.15 ? 0.26 : 0.09) * rnd();
    const leanDir = rnd() * Math.PI * 2;

    dummy.position.set(x, -0.6, z); // sink the foot into the ground
    dummy.rotation.set(
      Math.cos(leanDir) * leanAmt,
      rnd() * Math.PI * 2,
      Math.sin(leanDir) * leanAmt
    );
    dummy.scale.set(radius, h, radius);
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
function buildGround() {
  const SIZE = 700;
  const SEG = 240;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i); // local Y -> world -Z after the rotation below

    // rolling undulation + finer rugged detail (local Z -> world height)
    const roll = (fbm(x * 0.018, y * 0.018) - 0.5) * 3.4;
    const rough = (fbm(x * 0.13, y * 0.13) - 0.5) * 1.1;
    const height = roll + rough;
    pos.setZ(i, height);

    // dark fissures: ridged noise carves narrow dark crack-lines
    const ridge = Math.abs(valNoise(x * 0.09, y * 0.09) * 2.0 - 1.0);
    const crack = Math.pow(1.0 - ridge, 10.0); // ~1 along thin ridge lines
    const ridge2 = Math.abs(valNoise(x * 0.31 + 9.0, y * 0.31 - 4.0) * 2.0 - 1.0);
    const crack2 = Math.pow(1.0 - ridge2, 14.0);

    let g = 0.24 + (fbm(x * 0.5, y * 0.5) - 0.5) * 0.16; // dark rugged base + grain
    g *= 1.0 - 0.6 * crack - 0.5 * crack2; // darken the fissures
    g = Math.max(0.03, g);
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
