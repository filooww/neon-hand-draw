# J.A.R.V.I.S. · Air Draw

Draw in the air with your index finger in front of a webcam. Browser only, nothing to install, no special hardware.

![JARVIS HUD — deep navy, plasma cyan](.github/preview.png)

---

## Quick start

```bash
# any static server works — getUserMedia is blocked over file://
cd neon-air-draw
python3 -m http.server 8000
# open http://localhost:8000/
```

Or with Node:

```bash
npx serve neon-air-draw
```

Allow camera access when prompted. Once the feed appears and the FPS counter starts ticking — you're good.

**No server?** Double-click `neon-air-draw-standalone.html`. Same app, all modules inlined into one file by `build_standalone.py`.

**On a phone** — open the standalone file directly, or spin up a server and connect over your local network. Mobile browsers require `https://` for camera access; the only exception is `localhost` with USB debugging.

---

## Gestures

| Gesture | Action |
|---------|--------|
| ☝ index finger only | draw in the current colour |
| 🖐 open palm, inner side facing camera | eraser (radius set by the slider) |
| 🖐 hold open palm for 1 second | wipe the whole canvas |
| 🤝 three-finger pinch (thumb + index + middle) | grab the connected ink component under your fingers |
| 🤝 grab + open palm on the other hand | rotate the grabbed fragment |
| 🤝🤝 pinch with both hands | pan + zoom the whole drawing |
| 🗑 all five fingers pinched → sharp throw | crumple the drawing into a physics paper ball |
| 🤘 rock sign (index + pinky up) | next colour in the palette |
| `Ctrl / Cmd + H` | stream mode — hides the entire HUD for OBS capture |
| ⟳ button (mobile only) | switch front / rear camera |

### Recognition

After a ~0.7 s pause the app tries to figure out what you drew:

- **single stroke** → geometry check: LINE / CIRCLE / RECT. If it matches, the rough sketch is replaced by a clean neon shape.
- **multiple strokes** → Tesseract OCR (Russian + English). At confidence ≥ 55%, strokes are replaced by the recognised text in the same colour.
- **nothing recognised within 3.5 s** → strokes stay as-is.

---

## Layout

```
neon-air-draw/
├── index.html                       # modular version (needs a server)
├── neon-air-draw-standalone.html    # everything in one file (works via file://)
├── build_standalone.py              # bundles modules into the standalone HTML
├── css/
│   └── styles.css                   # JARVIS HUD theme
└── js/
    ├── main.js                      # DOM, state, main onResults loop
    ├── gestures.js                  # hand geometry and pose classifiers
    ├── recognition.js               # shape classifier (line / circle / rectangle)
    ├── stroke-draw.js               # smooth Catmull-Rom neon stroke
    ├── paper-ball.js                # procedural crumpled-paper ball with cache
    ├── one-euro.js                  # 1€ filter for landmarks (Casiez et al., 2012)
    └── hand-tracker.js              # MediaPipe Tasks Vision + getUserMedia + mobile detection
```

Two flavours of the same code. `index.html` loads modules separately — convenient for development, requires a server. The standalone inlines everything via `build_standalone.py`, so the browser's `file://` CORS restrictions don't apply.

---

## Mobile

Tested on Android Chrome and iOS Safari 16.4+. A few things work differently from desktop:

- **Camera resolution** drops to 640×360 (from 960×540) — roughly half the CPU/GPU load with no noticeable loss in detection quality.
- **Confidence thresholds** are slightly lower (0.50/0.45/0.35 vs 0.55/0.50/0.40) — mobile cameras handle poor lighting and shaky hands worse.
- **The ⟳ button** switches between front and rear cameras. Rear camera is useful when the phone is lying on a table and you want to draw above it.
- **The HUD scales down**: tighter padding, buttons bumped to the minimum 44px touch target, the gesture hint bar hidden (no room).

Two-hand zoom works on mobile but it's awkward — holding the phone and making a two-hand gesture at the same time is uncomfortable. Better to just draw at a comfortable scale.

---

## How it works

There are four canvas layers stacked on top of each other, which is not the obvious approach:

```
artCanvas      — committed strokes and shapes (permanent)
pendingCanvas  — strokes waiting for recognition
liveCanvas     — active strokes, redrawn from scratch every frame
─────────────────────────────────────────────────────────────
viewCanvas     — the visible element; cleared and composited every frame
```

Why three offscreen canvases? If you draw a stroke incrementally — appending each new segment to what's already there — `shadowBlur` accumulates at every joint and the line ends up looking like a string of beads. `liveCanvas` brute-forces this: it clears and redraws the entire stroke every frame, with Catmull-Rom building one `Path2D` through all the points. `pendingCanvas` keeps strokes separate from `artCanvas` while the recogniser is still thinking, so there's no chance of mixing a draft with the committed result.

Each stroke is three passes over the same path: a semi-transparent halo (lineWidth 10), the colour layer (4px), a thin white core (1.5px). No `shadowBlur`, no joints.

Gestures are classified by projecting fingertip positions onto the palm axis (wrist → middle-finger MCP). That makes every classifier invariant to hand rotation — a fist is a fist whether the hand is vertical or tilted sideways. Without this you'd be checking raw y-coordinates and the gestures would break at any angle.

MediaPipe landmarks jitter, especially when the hand is nearly still. The 1€ filter (Casiez et al., 2012) with `mincutoff=4.5` and `beta=0.85` kills the jitter when the hand is still and nearly switches off during fast movement. No lag.

When you switch cameras (⟳), the filters reset — otherwise they try to interpolate from the old coordinate space to the new one, producing a second-long positional drift.

---

## Dependencies (CDN, nothing to install)

| Library | Purpose |
|---------|---------|
| [`@mediapipe/tasks-vision`](https://developers.google.com/mediapipe) `0.10.14` | HandLandmarker, 21 landmarks per hand, WebGL delegate |
| [`tesseract.js`](https://github.com/naptha/tesseract.js) `5.x` | OCR for handwritten text (Russian + English) |

The hand model loads from `storage.googleapis.com` on first run (~1.5 MB). Requires an internet connection.

---

## Building the standalone

```bash
python3 build_standalone.py
```

Strips `export` / `import` lines from all JS modules, concatenates them into one `<script type="module">`, and inlines the CSS. The output is a single HTML file with no local file dependencies.

---

## Browser support

Chrome/Edge 113+ — full support. Firefox — works on the CPU delegate. Safari 17+ — works, though `filter: blur()` inside `destination-out` behaves differently on some versions.

The page must be served over `https://` or `localhost` — otherwise `getUserMedia` is blocked.

---

## Where to look in the code

If you want to understand or change something — `js/main.js`, the `onResults` function. Gesture priorities are marked with `===== PRIORITY N =====` comments and read like a flowchart.

All the gesture geometry is pure (zero DOM calls) in `js/gestures.js`. You can run it in Node and write tests.

The stroke renderer is `js/stroke-draw.js` — 44 lines total. The filter is `js/one-euro.js` — 24 lines. Both are worth reading if you want to understand how the drawing feels as smooth as it does.
