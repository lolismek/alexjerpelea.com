import * as THREE from "three";
import { createLandscape } from "./landscape.js";
import { DitherPass } from "./dither.js";
import "./style.css";

// Keep material colors as raw linear values so the dither thresholds are
// predictable instead of being reshaped by sRGB color management.
THREE.ColorManagement.enabled = false;

// Glyph cell size in CSS px. Bigger = chunkier symbols / more retro.
const CELL_CSS = 6;

const canvas = document.getElementById("bg");

function fail(msg) {
  const el = document.getElementById("errlog");
  if (el) {
    el.style.display = "block";
    el.textContent = "⚠ landscape did not render:\n\n" + msg;
  }
  // eslint-disable-next-line no-console
  console.error(msg);
}

// Preflight: is WebGL even available in this browser/session?
const probe = document.createElement("canvas");
const test = probe.getContext("webgl2") || probe.getContext("webgl");
if (!test) {
  fail(
    "This browser/session has no WebGL context.\n" +
      "Most likely hardware acceleration is OFF.\n" +
      "Chrome → Settings → System → enable 'Use graphics acceleration when available', relaunch.\n" +
      "Or check chrome://gpu (WebGL / WebGL2 should say 'Hardware accelerated')."
  );
  throw new Error("WebGL unavailable");
}

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
} catch (e) {
  fail("Could not create the WebGL renderer.\n" + (e && e.message ? e.message : e));
  throw e;
}
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

const dpr = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(dpr);

// glyph cell in device px, baked into a matching atlas tile so symbols stay crisp
const cellDevice = Math.max(5, Math.min(16, Math.round(CELL_CSS * dpr)));

const { scene, camera, update, resize, onDragStart, onDragMove, onDragEnd } =
  createLandscape();
const dither = new DitherPass({ cell: cellDevice });

let rt = null;

function setSize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);

  const r = renderer.getPixelRatio();
  const bw = Math.max(1, Math.floor(w * r));
  const bh = Math.max(1, Math.floor(h * r));

  if (rt) rt.dispose();
  // No MSAA: Safari's multisample-resolve-to-texture fails silently, and crisp
  // aliased edges suit the 1-bit symbol look anyway.
  rt = new THREE.WebGLRenderTarget(bw, bh, {
    type: THREE.UnsignedByteType,
    depthBuffer: true,
  });

  dither.setSize(bw, bh);
  resize(w, h);
}

setSize();
window.addEventListener("resize", setSize);

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  update(clock.getElapsedTime());

  // 1) render the grayscale scene into the offscreen target
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);

  // 2) dither it to 1-bit symbols on screen
  dither.render(renderer, rt.texture);
}
animate();

// ---- drag to rotate the view ----------------------------------------------
// Pointer events unify mouse + touch. We listen on the window (the canvas is
// pointer-events:none so content stays clickable) and only "engage" once a
// gesture is clearly a horizontal drag, so taps, link clicks and vertical
// touch-scrolling all keep working.
let dragging = false;
let engaged = false;
let downX = 0;
let downY = 0;
let lastX = 0;
let lastY = 0;
const DRAG_THRESHOLD = 4; // px before a gesture counts as a drag

function isInteractive(el) {
  return el && el.closest && el.closest("a, button, input, textarea, select");
}

function onPointerDown(e) {
  if (e.button !== undefined && e.button !== 0) return; // left button only
  if (isInteractive(e.target)) return;
  dragging = true;
  engaged = false;
  downX = lastX = e.clientX;
  downY = lastY = e.clientY;
}

function onPointerMove(e) {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;

  if (!engaged) {
    const totX = Math.abs(e.clientX - downX);
    const totY = Math.abs(e.clientY - downY);
    if (totX < DRAG_THRESHOLD && totY < DRAG_THRESHOLD) return;
    // mostly-vertical gesture: let the page scroll (touch) / select normally
    if (totY > totX * 1.3) {
      dragging = false;
      return;
    }
    engaged = true;
    onDragStart();
    document.body.classList.add("grabbing");
  }

  onDragMove(dx, dy);
  if (e.cancelable) e.preventDefault();
}

function onPointerUp() {
  if (engaged) onDragEnd();
  dragging = false;
  engaged = false;
  document.body.classList.remove("grabbing");
}

window.addEventListener("pointerdown", onPointerDown);
window.addEventListener("pointermove", onPointerMove, { passive: false });
window.addEventListener("pointerup", onPointerUp);
window.addEventListener("pointercancel", onPointerUp);

// ---- scroll reveal ---------------------------------------------------------
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    }
  },
  { threshold: 0.15 }
);
document.querySelectorAll("[data-reveal]").forEach((el) => observer.observe(el));
