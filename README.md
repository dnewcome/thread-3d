# thread-3d

A real-time 3D LED visualizer for a custom spiral LED installation, controlled via the Art-Net lighting protocol over UDP. Built with Electron and Three.js.

## Overview

The physical installation consists of 12 strands of RGB LEDs arranged along spiral curves on a 3D form. This app loads a CAD model of the form, extracts the positions of each individual LED chip from the geometry, and renders them as an interactive 3D view. LED colors are driven live by Art-Net DMX data received over UDP, allowing any standard lighting controller or software (e.g. MadMapper, TouchDesigner, QLC+, a custom sender) to control the visualization in real time.

Because Art-Net requires receiving UDP packets — which browsers cannot do — the app runs as an Electron desktop application rather than a plain web page.

## Running

```bash
npm install
npm start
```

On Linux, `--no-sandbox` is passed automatically in the start script to work around a common Electron sandbox setup requirement.

## Controls

| Input | Action |
|-------|--------|
| Left-drag | Orbit camera |
| Right-drag / two-finger drag | Pan |
| Scroll wheel | Zoom |

The status indicator in the bottom-left corner shows `Art-Net: waiting…` until the first DMX packet is received, then switches to `Art-Net: live`.

---

## Architecture

The app is split across three Electron layers following standard Electron security practice:

```
┌─────────────────────────────────────────┐
│  Main process  (main.js)                │
│  - Creates BrowserWindow                │
│  - Binds UDP socket on port 6454        │
│  - Parses Art-Net packets               │
│  - Builds full LED color array          │
│  - Sends colors to renderer via IPC     │
│  - Serves STL file to renderer via IPC  │
└────────────────┬────────────────────────┘
                 │ IPC (contextBridge)
┌────────────────▼────────────────────────┐
│  Preload  (preload.js)                  │
│  - Exposes window.artnet.readModelFile()│
│  - Exposes window.artnet.onLEDUpdate()  │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│  Renderer process  (renderer.js)        │
│  - Parses STL binary                    │
│  - Extracts 12×600 LED positions        │
│  - Renders model + LED InstancedMesh    │
│  - Updates LED colors on IPC events     │
└─────────────────────────────────────────┘
```

`contextIsolation: true` and `nodeIntegration: false` are enforced; the renderer has no direct Node.js access.

The STL file is served to the renderer via IPC rather than `fetch()` because Electron's `file://` security policy can block cross-file fetches depending on platform.

---

## Art-Net Addressing

### Universe layout

The installation has **7,200 LEDs** total:

- 12 strands × 600 LEDs per strand
- Each strand is split into two physical strips of 300 LEDs each
- 4 Art-Net universes per strand → 48 universes total (universes 0–47)
- Each universe carries **150 LEDs = 450 DMX channels** (RGB, 3 channels each)

```
Universe  Strand  UnivInStrand  LEDs covered
────────  ──────  ────────────  ────────────
0         0       0             0–149
1         0       1             150–299
2         0       2             300–449
3         0       3             450–599
4         1       0             (reversed, see below)
5         1       1
...
44        11      0
45        11      1
46        11      2
47        11      3
```

### Reversed strands

The LED strands are wired in a serpentine pattern: adjacent strands are connected end-to-end, so half of them run in the opposite direction relative to the Art-Net universe numbering. **Odd-numbered strands (1, 3, 5, 7, 9, 11) are reversed.**

For a reversed strand, the mapping from Art-Net channel position to physical LED position is:

```
ledInStrand = 599 − (univInStrand × 150 + ledIndexWithinUniverse)
```

For a forward strand:

```
ledInStrand = univInStrand × 150 + ledIndexWithinUniverse
```

This reversal is resolved entirely in the main process (`buildLEDColors()` in `main.js`) before the color data is sent to the renderer. The renderer receives a simple flat array indexed by global LED number and has no knowledge of the reversal.

### Global LED index

```
globalLED = strand × 600 + ledInStrand       (0–7199)
```

The renderer's `InstancedMesh` assigns instances in the same strand/LED order, so `globalLED` maps directly to an instance index offset by strand.

---

## 3D Model and LED Extraction

The model is stored as a binary STL file (`model-cleaned.stl`, ~4.2 MB, ~87,120 triangles). It was exported from Rhino and contains only the LED chip geometry — no separate structural mesh.

### Key observation

When the STL was exported from Rhino, the triangles were written out in object order: all triangles belonging to strand 0 first, then strand 1, and so on. Within each strand, all triangles for LED chip 0 come before LED chip 1, etc. This ordering is exploited to avoid any complex mesh segmentation.

### Strand detection

The renderer scans consecutive triangle centroids and detects large positional jumps (> 0.5 mm by default, `STRAND_JUMP_THRESHOLD`). Each jump indicates the transition between one strand and the next. This reliably finds all 12 strand boundaries.

### LED position extraction

Within each strand's triangle block, the triangles are divided into exactly 600 equal groups using integer-rounded linear interpolation. The centroid of each group's triangle centroids becomes the position of that LED in 3D space. This approach is robust regardless of the exact number of triangles per LED chip (which varies slightly across the mesh).

```
triStart = strandTriangleOffset + round(led × strandTriCount / 600)
triEnd   = strandTriangleOffset + round((led+1) × strandTriCount / 600)
ledPosition = average of centroids[triStart..triEnd]
```

### Rendering

All 7,200 LED positions are rendered as a single `THREE.InstancedMesh` using `BoxGeometry`. The box size is auto-calculated as 70% of the measured spacing between the first two LEDs of the first strand. Instance colors are set via `setColorAt()`, which Three.js maps to the `instanceColor` buffer attribute used by the GPU instancing shader.

The same STL geometry is also rendered as a semi-transparent dark background mesh (`MeshStandardMaterial`, opacity 0.25) to show the physical form.

---

## File Reference

| File | Purpose |
|------|---------|
| `main.js` | Electron main process: window creation, UDP Art-Net receiver, LED color mapping, IPC handlers |
| `preload.js` | Electron preload: exposes `window.artnet` API to renderer via `contextBridge` |
| `index.html` | HTML shell; sets up Three.js ES module importmap |
| `renderer.js` | Renderer process: STL parsing, LED extraction, Three.js scene, color updates |
| `model-cleaned.stl` | Binary STL of the LED chip geometry, exported from Rhino |
| `package.json` | npm metadata; `electron` and `three` as dependencies |

---

## Tuning

If the LED extraction or addressing doesn't look correct after connecting a controller, two constants at the top of their respective files can be adjusted:

**`renderer.js`**
- `STRAND_JUMP_THRESHOLD` (default `0.5` mm) — increase if strands aren't being separated correctly; decrease if a single strand is being split in two.

**`main.js`**
- The reversed-strand logic assumes odd strands are reversed. If your wiring starts on the other end, change `(strand % 2) === 1` to `(strand % 2) === 0`.
