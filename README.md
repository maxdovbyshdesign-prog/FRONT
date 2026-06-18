# FRONTIER PLANET

FRONTIER PLANET is a voxel sci-fi extraction survival RPG vertical slice, combining voxel sandbox building, first-person exploration, and S.T.A.L.K.E.R.-style extraction contract loops.

The game is built with **TypeScript**, **React**, **Vite**, **noa-engine** (voxel mechanics), **Babylon.js** (3D rendering), and wrapped as a standalone desktop application via **Electron**.

---

## 🎮 Game Concept
You are a PMC contractor dropped onto the desolate, high-value wasteland of **Frontier Planet**.
- **The Territory**: Dust dunes of iron silt, volcanic spires of crystallized black glass, and abandoned corporate outposts built from alloy cladding.
- **The Contract**: Navigate to the half-buried ancient alien coordinate, recover the hum/glow of the quantum artifact core, and return safely to the extraction landing site around spawn coordinates `(0, 0)`.
- **The Danger**: Hostile defense grids, PMC rival syndicates, and anomalous gravity-field spikes.

---

## 🛠️ Development & Playback Guide

### 1. Prerequisite Installations
Ensure Node.js (18 or newer) is active. To trigger dependencies compilation, run:
```bash
npm install
```

### 2. Launch Local Dev Mode
Runs the playable vertical slice in your browser with hot reloading:
```bash
npm run dev
```
Open your browser and navigate to `http://localhost:3000`.

### 3. Build Web Bundle
Runs the Vite compiler to produce a standalone production bundle of static bundles inside `/dist`:
```bash
npm run build
```

### 4. Package Desktop Executable (Windows)
To bundle the Vite static dist folders into a Windows-ready standalone `.exe` package wrap, run:
```bash
npm run release:win
```
This produces the downloadable zip file containing the portable execution folders.

---

## 📦 Release Artifact Structure

- When you compile via `npm run release:win`, the compiler gathers files, downloads the precompiled Windows Electron host shell, and packages the resources.
- The compressed output is located at:
  ```bash
  /release/FrontierPlanet-0.0.0-win.zip
  ```
- **How to play on Windows**:
  1. Download the generated ZIP file.
  2. Extract the archive contents into any workspace.
  3. Double-click `FrontierPlanet.exe` to boot. 100% standalone, zero dev server, zero network connections, and no npm installs needed for game deployment.

---

## 🧬 Architectural Directories

- `src/engine`: Contains `noa-adapter.ts` wrapping Noa voxel engines and Babylon.js canvases.
- `src/game`: houses the global coordinate manager state and `GameApp` orchestrator.
- `src/world`: houses landscape procedurals and structural grids.
- `src/blocks`: handles voxel maps and block registries.
- `src/player`: controls tactical HUD, movement telemetry, and hotkeys.
- `src/ui`: implements general overlays, warning feeds, and alert syncs.
- `src/missions`: outlines contract quest vectors.
- `src/data`: holds data-driven block definitions, biomes, weapons, and factions.
- `docs`: holds system definitions and game blueprints.
