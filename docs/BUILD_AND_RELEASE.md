# FRONTIER PLANET - BUILD & RELEASE PIPELINE

This document provides a highly technical breakdown of the compiler and packaging infrastructure that converts our Vite, React, and `noa-engine` games into standalone, double-clickable, zero-config Windows desktop archives.

---

## 1. The Core Desktop Architecture

Web applications typically load assets over HTTP via standard domain schemas (e.g., `/assets/index.js`). 
However, a **standalone packager** (Electron) must serve all resources directly from the local disk filesystem (using the `file://` protocol) to eliminate the need for running an active server inside the user's machines.

To accommodate this, our pipeline enforces two core structural requirements:

### A. Relative Asset Path Compilation
In `/vite.config.ts`, we set `base: './'`. This commands Vite to compile index.html assets with dynamic relative links (e.g., `./assets/index.js`) instead of absolute root links (`/assets/index.js`).
This ensures that when Electron loads `dist/index.html` via `win.loadFile()`, the operating system successfully resolves all companion styling, mesh files, and scripts directly from the folder directory paths.

### B. Self-Contained Standalone Entry: `main-electron.cjs`
We maintain a native CommonJS bootstrap wrapper (`main-electron.cjs`) in the root. 
- In development mode, Electron can proxy lookups to `http://localhost:3000` for speedy debugging.
- In production, Electron loads the compiled folder directory `dist/index.html` directly into the chromic viewport.

---

## 2. Compilation and Release NPM Scripts

Our `package.json` defines the core pipeline stages:

- **`npm run build`**:
  Invokes Vite to bundle CSS, React, and `noa-engine` modules into robust client bundles inside the static folder `/dist`.
  
- **`npm run release:win`**:
  - Triggers `npm run build` to compile the frontend assets.
  - Invokes `electron-builder --win --x64` to wrap `/dist` and `/main-electron.cjs` inside a native execution shell.
  - Packages the results into a compact `.zip` file.

---

## 3. Package Configurations

`electron-builder` is configured directly inside the `build` parameter of `/package.json`:

```json
"build": {
  "appId": "com.frontierplanet.game",
  "productName": "FrontierPlanet",
  "directories": {
    "output": "release"
  },
  "files": [
    "dist/**/*",
    "main-electron.cjs"
  ],
  "win": {
    "target": "zip"
  }
}
```

- **Output Target**: Compiled binaries are deposited inside the directory:
  ```bash
  /release/FrontierPlanet-0.0.0-win.zip
  ```
- **Portability**: The zipped container packages all required node packages, assets, and Chromium DLL headers. The end user simply unzips the archive and hits `FrontierPlanet.exe` to run, with **no npm imports or command prompts required**.

---

## 4. Cross-Platform Compilation from Linux
Since our cloud development sandbox runs in an x64 Linux container, compiling a `.exe` setup package can sometimes fail because of wine compiler issues under Linux hosts.
To bypass this dependency, we target a portable **`zip`** layout for Windows. `electron-builder` can successfully extract the standard precompiled Windows Chromium shell and pack our static `dist` code directly on a Linux environment **without needing wine or any Windows OS instances**. This ensures compile success.

---

## 5. Troubleshooting Packaged Builds

### A. Blank Viewport on Startup
- **Reason**: The static index.html contains absolute paths (`/assets/...`) instead of relative paths (`./assets/...`).
- **Fix**: Check `vite.config.ts`. Confirm `base: './'` is defined, compile again, and repackage.

### B. Voxel Canvas Lag issues
- **Reason**: Desktop hardware accel is disabled inside Electron.
- **Fix**: Ensure standard GPU drivers are active. Electron automatically leverages full WebGL acceleration pipelines when available on host systems.
