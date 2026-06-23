# alexjerpelea.com

A personal site with a **ditherpunk** landing page: a procedural 3D landscape of
thick, tall, rugged spire-cones that the camera slowly orbits, rendered entirely
in real time and pushed through a post-process shader that redraws every frame as
1-bit black & white built from a ramp of **symbols** (an ASCII-style glyph atlas
sorted by ink coverage), not just dots. The landscape is fixed in the background;
your name greets visitors, projects reveal as they scroll, and you can **drag to
rotate** the view (it keeps slowly auto-orbiting on its own).

No video, no image assets — it's all generated on the GPU each frame. (Dithered
*video* compresses terribly, which is exactly why this is done live.)

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production bundle in dist/
npm run preview  # serve the built bundle
```

## Structure

| File               | Role                                                            |
| ------------------ | --------------------------------------------------------------- |
| `index.html`       | Page content (hero, about, projects, contact).                  |
| `src/style.css`    | Layout + the retro type / panel styling + scroll-reveal.        |
| `src/landscape.js` | The 3D scene: sky dome, instanced spire-cones, rugged ground, fog, camera orbit + drag control. |
| `src/dither.js`    | The glyph-atlas (symbol) dither post-process shader.            |
| `src/main.js`      | Renderer setup, render loop, resize, drag-to-rotate, scroll-reveal. |

## Tuning the look

All knobs are constants near the top of their files:

**`src/landscape.js`** (`createLandscape`)
- `SPIKE_COUNT`, `FIELD_INNER`, `FIELD_OUTER` — how many spires and the clearing/field size.
- `ORBIT_RADIUS`, `ORBIT_SPEED`, `CAM_HEIGHT`, `LOOK_AT` — the camera move. The camera
  sits *inside* the clearing (`ORBIT_RADIUS` < `FIELD_INNER`) and looks out across the field.
- the three spike tiers in `buildSpikes` (hero / distant-sea / mid-grove) — each tier's
  `h` (height) and `ratio` (`radius / h`, so smaller = more slender) and where it's placed.
- the `profile` loop — the cone silhouette (mainly conic, with rugged convex/concave waviness).
- `HORIZON` / `ZENITH` and the sky-dome shader — sky gradient + cloud band.
- `scene.fog` near/far — how fast distance fades to sky.
- `SENS` / `PITCH_SENS` — drag-to-rotate sensitivity (horizontal spin / vertical tilt).

**`src/main.js`**
- `CELL_CSS` — glyph cell size in CSS px. Larger = chunkier symbols / more retro.

**`src/dither.js`**
- `uContrast` / `uBrightness` uniforms — how the grays map onto the symbol ramp.
- `uDither` — how much ordered jitter breaks up flat regions between glyph levels.
- the `candidates` array in `makeGlyphAtlas` — the symbol set (auto-sorted by ink coverage).

## Editing content

Everything visitor-facing is plain HTML in `index.html` — look for the
`<!-- EDIT ME -->` markers to replace the placeholder bio, project cards, and
links.
