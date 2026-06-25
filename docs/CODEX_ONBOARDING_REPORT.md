# Codex Onboarding Report - FRONTIER PLANET

## 1. Executive Summary

FRONTIER PLANET is a compact but non-trivial TypeScript/Vite/React voxel prototype with a service-oriented game core, a React HUD/menu shell, `noa-engine` for voxel world/player/chunk behavior, Babylon.js rendering services, and Electron packaging configuration.

The repo appears healthy enough for small, scoped architecture/documentation passes, but this local checkout is not currently runtime-verifiable. `npm install`, `npm run build`, and `npm run dev` all failed in this environment before Vite could run. The failures point to local npm/PowerShell/dependency-state issues: PowerShell blocks `npm.ps1`, `npm.cmd install` hits an npm internal "Exit handler never called!" error, and existing `node_modules` is incomplete or corrupted enough that `vite` is not available via `node_modules/.bin`.

The most important engineering constraint is the lighting/rebase boundary. The project has explicit WORLD-coordinate vs BABYLON/render-local coordinate handling in the voxel lighting pipeline. Do not casually refactor lighting, mesh recoloring, source registries, or noa origin-rebase handling without browser walking/rebase acceptance tests.

## 2. Commands Run

| Command | Result | Important output / notes |
| --- | --- | --- |
| `Get-ChildItem -Force` | Success | Repo contains `src`, `docs`, `public`, `screenshots`, root config files, and no visible `node_modules` in the initial top-level listing because it is hidden/ignored from that listing context. |
| `rg --files` | Success | Source/docs/public structure mapped. |
| `git status --short` | Success | Clean before report creation. |
| `npm install` | Failed | PowerShell refused to load `C:\Program Files\nodejs\npm.ps1` because script execution is disabled. |
| `npm.cmd install` | Failed | `npm error Exit handler never called!`; npm suggested reporting an npm CLI issue. Logs were not written to `C:\Users\dell\AppData\Local\npm-cache\_logs`. |
| `npm.cmd install --cache C:\tmp\frontier-npm-cache` | Failed | Same npm internal `Exit handler never called!`; temp cache did not fix it. |
| `node --version` | Success | `v24.16.0`. |
| `npm.cmd --version` | Success | `11.13.0`. |
| `Test-Path node_modules` | Success | `True`; dependency folder exists. |
| `Test-Path node_modules\.bin` | Success | `False`; no local binary shims. |
| `Test-Path node_modules\vite` | Success | `True`, but folder has no `package.json` and no listed contents. |
| `npm run build` | Failed | Same PowerShell `npm.ps1` execution-policy block. |
| `npm.cmd run build` | Failed | Script started, then failed with `'vite' is not recognized as an internal or external command`. |
| `npm run dev` | Failed | Same PowerShell `npm.ps1` execution-policy block. |
| `npm.cmd run dev` | Failed | Script started, then failed with `'vite' is not recognized as an internal or external command`. Dev server did not start; no port was opened. |

## 3. Project Structure Map

- `package.json` - npm scripts, dependencies, and inline `electron-builder` config.
- `vite.config.ts` - Vite config with React, Tailwind v4 plugin, `base: './'` for Electron file loading, alias `@` to repo root, host `0.0.0.0`, and `allowedHosts: true`.
- `main-electron.cjs` - Electron main process. Loads `http://localhost:3000` only when `NODE_ENV === 'development'`; otherwise loads `dist/index.html`.
- `src/main.tsx` - React entry. Mounts `App` into `#root`.
- `src/App.tsx` - Main React shell: main menu, Play Game/Polygon routing, HUD, pause/help/debug overlays, runtime error display, mod bootstrap, and `NoaEngineAdapter` lifecycle.
- `src/game/` - `GameApp` orchestrator, shared `gameState`, and placeholder/early service modules for AI, economy, combat, save, network, vehicles, base, crafting, weapons, artifacts.
- `src/engine/noa-adapter.ts` - Main bridge between pure game services and `noa-engine`/Babylon. Owns noa startup, chunk data callbacks, input bridging, render-service initialization, debug hook, tick loop, survival integration, block place/break, and lighting sync orchestration.
- `src/engine/rendering/` - Rendering subsystems: `MaterialService`, `RenderPipelineService`, `SkyController`, `WorldLightManager`, `VoxelLightManager`, visual presets/tuning, graphics settings.
- `src/world/` - `WorldService` procedural play world and `PolygonWorldService` flat test lab.
- `src/blocks/` - `BlockService` merges core and mod block definitions.
- `src/player/` - player state, hotbar input, inventory, and survival/vitals.
- `src/missions/` - mission/extraction/artifact objective handling.
- `src/modding/` - mod loader/registry and mod content types.
- `src/data/` - data-driven definitions for blocks, biomes, factions, items, recipes, weapons, artifacts.
- `src/components/VisualTuningConsole.tsx` - F3 debug/tuning panel with lighting tests, Polygon station teleports, visual controls, and agent input pad.
- `public/mods/example-ruins-pack/` - example creator-content mod.
- `docs/` - existing architecture, roadmap, GDD, modding, and build/release docs.
- `screenshots/` - historical screenshots, including `lightinghell.png`.

## 4. Runtime / Build Status

The app was not successfully built or started in this environment.

Observed blockers:

1. Plain `npm` commands in PowerShell fail before npm runs because `npm.ps1` is blocked by the Windows execution policy.
2. `npm.cmd install` bypasses the PowerShell shim but fails inside npm 11.13.0 with `Exit handler never called!`.
3. Existing `node_modules` appears incomplete/corrupted: `node_modules/.bin` is absent, and `node_modules/vite` exists as an empty directory without `package.json`.
4. `npm.cmd run build` and `npm.cmd run dev` reach package scripts, but both fail because `vite` is not recognized.

Package scripts:

- `dev`: `vite --port=3000 --host=0.0.0.0`. Intended browser dev server on port 3000.
- `build`: `vite build`. Intended production web bundle into `dist`.
- `preview`: `vite preview`. Intended local preview of production build.
- `clean`: `rm -rf dist release`. Unix-style clean command; likely not portable to default Windows PowerShell.
- `lint`: `tsc --noEmit`. This is actually TypeScript type checking, not ESLint.
- `package:win`: `electron-builder --win --x64`. Builds Windows package from `dist` and Electron main file.
- `release:win`: `npm run build && npm run package:win && echo ...`. Full build/package pipeline.

Tests/typecheck/lint:

- No test runner found in `package.json`.
- No dedicated `typecheck` script.
- No ESLint config/script observed.
- `lint` runs TypeScript only via `tsc --noEmit`, but it could not be run because dependency installation/build tooling is broken in this checkout.

## 5. Architecture Notes

React app shell:

- `src/main.tsx` mounts `src/App.tsx`.
- `App.tsx` starts in `gameMode = 'menu'`.
- Main menu has `Play Game`, `Polygon (Test Mode)`, disabled Creator Mode, and Quit.
- When entering `play` or `polygon`, `App.tsx` starts `GameApp`, creates `NoaEngineAdapter`, and registers React state sync listeners for player, mission, and UI alerts.
- `F1` toggles help, `F3` toggles debug console, and `Escape` toggles/release-lock pause behavior.

Game/service core:

- `GameApp` constructs services once: player, world, blocks, missions, UI, input, survival, plus many placeholder future services.
- `GameApp.start()` starts hotbar input and a requestAnimationFrame service heartbeat.
- `gameState` is a mutable shared snapshot for player position, yaw, selected block, targeted block text, mission state, changed blocks, and survival vitals.

noa/Babylon integration:

- `NoaEngineAdapter` is the integration hub. It instantiates `new Engine(opts)` from `noa-engine`, registers blocks/materials through `MaterialService`, handles `worldDataNeeded`, bridges click/fire input, and owns the main noa tick hook.
- Chunk data is generated by calling `worldService.getBlockAt(x+i, y+j, z+k)` in WORLD coordinates.
- Babylon rendering services are initialized after noa: glow/post-processing, sky/celestial bodies, dynamic-light registry, voxel-light baking, visual presets, and debug hooks.

World/blocks:

- `WorldService` provides procedural terrain, spawn landing pad, outpost, ancient ruin, artifact, generated/static lights, custom mod structure placement, and biome detection.
- `PolygonWorldService` provides a deterministic flatworld with chunk-border markers and fixed light stations.
- `BlockService` merges core `BLOCKS` from `src/data/blocks-data.ts` with custom mod blocks from `ModRegistry`.
- Light-emitting blocks are data-driven through `tags: ["light_source"]` and/or `light: LightProfile`.

Input/interaction:

- `InputService` only maps number keys to hotbar slots.
- `NoaEngineAdapter` handles Shift sprint.
- Left mouse (`fire`) destroys targeted blocks; right mouse (`alt-fire`) places selected blocks at the adjacent cell.
- `E` is not bound in the observed input code. I found no implemented Use/Interact action. Based on this audit, `E` is effectively free/reserved, but the repo does not yet enforce a formal Use/Interact binding.

HUD/UI:

- `App.tsx` renders the tactical HUD, compass, mission tracker, alerts, vitals, targeted block scanner, GPS, and hotbar.
- `VisualTuningConsole` provides live visual controls, debug status, lighting tests, and Polygon agent controls.

Survival/vitals:

- `SurvivalService` tracks stamina, oxygen, hydration, radiation, and status flags.
- The adapter feeds it tick context: `dtMs`, sprinting state, sky light at player, night factor, artifact proximity, time of day, and polygon mode.
- Oxygen explicitly depends on WORLD-space voxel sky light, so it is coupled to the protected coordinate/lighting fix.

## 6. Protected Systems

Do not casually touch these without targeted tests:

- `src/engine/rendering/voxel-light-manager.ts`
  - Primary protected file. Owns WORLD-space `chunkLight`, WORLD-space `voxelLightSources`, `registerLight`, `unregisterLight`, sky/block light data, mesh recoloring, relight queue, `localToWorld`, `worldToLocal`, `meshLocalOriginToWorld`, and `terrainMeshToWorldChunkKey`.
  - Comments explicitly document the noa origin-rebase fix: logical light data is WORLD-space; only render mesh matching converts render-local mesh positions back to WORLD via `worldOriginOffset`.
- `src/engine/noa-adapter.ts`
  - Owns noa setup, `worldDataNeeded`, `addingTerrainMesh`, block place/break, light registration/unregistration order, relight/recolor sync, origin offset syncing, debug tests, and survival sky-light sampling.
  - Critical sections include chunk lighting before `setChunkData`, static light seeding, relight queue processing, and `setWorldOriginOffset`.
- `src/engine/rendering/world-light-manager.ts`
  - Persistent data-driven real Babylon light registry. Debug/performance dynamic lights are secondary to voxel lighting, but registry behavior affects placed/generated light lifecycle.
- `src/engine/rendering/material-service.ts`
  - Terrain material policy is tied to baked vertex colors. It sets material behavior so VoxelLightManager recolored vertex colors remain visible.
- `src/world/world-service.ts`
  - `getBlockAt` is the WORLD-coordinate procedural block source. `getStaticLightSources` must stay in sync with generated light blocks.
- `src/world/polygon-world-service.ts`
  - Test lab world used for lighting boundary/station testing. Keep deterministic.
- `src/data/blocks-data.ts` and `src/types.ts`
  - Define `LightProfile` and block light/emissive data consumed by both voxel and debug real-light systems.

Why this is dangerous:

- `noa-engine` rebases render-local mesh/camera positions while voxel/world data remains WORLD-space.
- Mesh recoloring must match Babylon chunk meshes back to WORLD chunk keys after rebase.
- Light source registration/removal order matters: unregister before destroying blocks, register before placing blocks.
- Terrain vertex recoloring must use cached base colors; repeated recolors must not multiply already-lit colors.
- Static/generated light sources must seed both the world-light registry and voxel source registry.

## 7. Polygon / Test Lab Status

Polygon exists.

Entry path:

- From main menu, click `Polygon (Test Mode)`.
- `App.tsx` creates a `PolygonWorldService` instead of the normal `WorldService`, then passes `gameMode = 'polygon'` into `NoaEngineAdapter`.

What it tests:

- Deterministic flat terrain at `GROUND_Y = 8`.
- Chunk-border marker blocks at local chunk edges.
- Static light stations:
  - center
  - X border
  - Z border
  - 4-chunk corner
  - negative coordinates
  - wall/floor/tunnel/fog test areas as station metadata
- The F3 `VisualTuningConsole` has Polygon station teleport buttons and agent movement controls.
- Lighting debug harnesses include surface 3x3 tests, walking monitor, far/spawn tests, place/remove stress tests, crosshair lighting inspection, and user-light repro helpers.

Important caveat:

- Debug teleport is labeled "not walking acceptance" in the UI/source. Claims about the origin-rebase lighting fix still require walking/rebase tests, not only station teleport tests.

## 8. Existing Weather / VFX Code

I found no implemented weather system, precipitation manager, rain/snow/dust simulation, or weather presets.

Existing atmosphere/VFX-adjacent code:

- `SkyController` - sun/moon/stars/cloud discs, day/night, sky-root following player.
- `VisualPresets` / `VisualTuning` - fog, sky color, glow/bloom/exposure, atmosphere biome mode, clouds visibility.
- `RenderPipelineService` - GlowLayer and post-processing controls.
- `AudioService` - synthesized ambient planetary wind loop.
- `ModLoader` / mod sky JSON - loads optional sky/fog overlay config.
- `PolygonWorldService` includes a `fog` station only.

Weather-related words in docs/data are mostly thematic: "weathered" stone/suits, "dust" as a block/material, "carbon storms" in biome flavor, "atmospheric" mod sky/fog. These do not look like old active weather experiments.

Risk note:

- Fog/sky/cloud/ambient systems are stable atmosphere controls, not precipitation. Do not revive them into weather. A future precipitation prototype should stay Polygon-only and separate.

## 9. Risks / Technical Debt

1. Local setup is currently broken: npm install fails internally, build/dev cannot find Vite, and `node_modules` appears corrupted.
2. Node 24.16.0 + npm 11.13.0 may be outside the intended support envelope; README says Node 18+, but current npm behavior blocks setup.
3. No automated test suite is configured; only a `lint` script using `tsc --noEmit` exists.
4. Lighting/rebase pipeline is large, highly stateful, and fragile. It has in-code acceptance helpers but no automated browser harness in package scripts.
5. `src/engine/noa-adapter.ts` is still very large and owns many responsibilities despite comments describing it as a thin bridge.
6. React UI, debug tooling, and runtime boot logic are concentrated in `src/App.tsx`, which is also large.
7. `clean` uses `rm -rf`, which is not portable to default Windows PowerShell.
8. README/docs contain mojibake in headings/symbols, suggesting encoding issues in some documentation.
9. Mod loading is dynamic/fetch-based and forgiving, but there is no schema validation beyond minimal manual checks.
10. `E` Use/Interact is not implemented or enforced; future interaction work needs a clear input contract before adding bindings.

## 10. Suggested Next Pass

Recommended next safe pass:

**Pass 1 - Toolchain Recovery / Verification Only**

Scope:

- Establish the supported Node/npm version for this repo.
- Repair dependency installation without package upgrades.
- Confirm `npm install`, `npm run build`, `npm run lint`, and `npm run dev` run from a clean dependency state.
- Document the exact working Windows command path, including whether users should call `npm.cmd` or adjust execution policy.
- Do not touch game systems, lighting, coordinate helpers, weather, visual presets, or gameplay features.

Reason:

Until build/dev can run, any implementation pass would be flying without instrument panels. The codebase has enough fragile rendering/lighting state that runtime verification is not optional.

## 11. Questions for Max / Tech Director

1. What Node/npm version should be considered canonical for this project? Node 24/npm 11 failed setup in this audit.
2. Is it acceptable in the next pass to remove/recreate ignored dependency folders (`node_modules` and npm cache only) to recover a clean install?
3. Should `E` be formally reserved for future Use/Interact now, even though no binding exists yet?
4. What is the minimum lighting acceptance checklist before anyone can claim the rebase lighting fix remains safe: Polygon walking monitor, 3x3 surface test, far-from-spawn test, Play Game walking test, or all of these?

## 12. Files Changed

- `docs/CODEX_ONBOARDING_REPORT.md`

## 13. Pass 1 Follow-up - Toolchain Recovery

Pass 1 recovered the local toolchain using Node.js 22 LTS instead of the previously failing Node 24/npm 11 environment.

Verified runtime:

- Node.js `v22.23.1`
- npm `10.9.8`
- Vite `v6.4.3`

Verified commands:

- `npm.cmd ci --cache E:\WORK\FRONT\local\FRONT\.frontier-npm-cache-temp --no-audit --no-fund` succeeded and added 393 packages.
- `npm.cmd run build` succeeded. Vite built 3208 modules in 39.85s and emitted only a large chunk-size warning.
- `npm.cmd run lint` succeeded. The script runs `tsc --noEmit`.
- `npm.cmd run dev` started Vite and reported `http://localhost:3000/`.

PowerShell still blocks plain `npm` through `npm.ps1` on this machine. Use `npm.cmd` on Windows unless execution policy is intentionally changed.

Manual browser smoke was not completed during Pass 1 because the available shell could verify Vite startup in the foreground, but background dev-server processes did not survive after their launching shell exited and no browser-control connector was available in the session.
