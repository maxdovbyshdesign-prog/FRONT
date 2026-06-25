# Precipitation Field Architecture

## 1. Purpose

`PrecipitationFieldRenderer` is a future reusable camera-relative 3D renderer for falling visual elements.

Its first job is not to make convincing weather. Its first job is to prove that FRONTIER PLANET can render a spatial, immersive field of simple falling shapes around the camera without leaking into menus, damaging performance, or touching protected voxel lighting and coordinate systems.

The first prototype should be an abstract test instrument: grey falling rectangles or streaks in Polygon only. If that renderer feels spatial, stable, cheap, and disposable, later passes can swap visuals and bind it to real weather states.

## 2. Non-Goals

This system is not:

- Weather presets.
- A snow, rain, dust, ash, or toxic storm implementation.
- A fog system.
- An audio system.
- A full-screen canvas overlay.
- DOM particles.
- A Babylon CPU `ParticleSystem` soup.
- A world-wide physical particle simulation.
- A gameplay hazard system yet.
- A replacement for sky, fog, lighting, visual presets, or biome atmosphere.
- A reason to touch `VoxelLightManager`, block light registries, terrain mesh recoloring, or noa origin-rebase logic.

## 3. First Prototype Scope

The future first implementation pass should build only this:

- Polygon only.
- Abstract grey rectangles or streaks only.
- Camera-relative 3D field, not a screen overlay.
- Visible depth and perspective.
- A simple wind vector test.
- A shelter or roof reduction test.
- Clean destroy when leaving Polygon, Play Game, or returning to the main menu.
- No precipitation visible in the main menu.
- No block lighting regressions.

The first prototype should not have named weather. Avoid words like rain, snow, dust, ash, storm, or precipitation preset in runtime UI. Treat it as "Abstract Precipitation Field" or "Field Renderer Test" until the renderer is validated.

## 4. Proposed Module Shape

Planning only. Do not create these files in this docs pass.

Suggested future locations:

- `src/engine/weather/precipitation-field-renderer.ts`
  - Owns Babylon visual objects for the field.
  - Allocates and reuses element meshes or thin instances.
  - Updates element positions each frame.
  - Handles wrapping/respawning inside the camera-relative volume.
  - Exposes `start`, `update`, `setEnabled`, and `dispose`.

- `src/engine/weather/precipitation-field-types.ts`
  - Defines the minimal prototype config shape.
  - Keeps the first pass independent from long-term weather presets.

- Future Polygon integration point
  - Owned by whatever code currently creates Polygon-only debug systems.
  - Creates the renderer only when `gameMode === "polygon"`.
  - Supplies camera/player position, delta time, and optional shelter query.
  - Destroys the renderer on exit.

Do not start by adding a general `WeatherService`. A broad service name invites scope creep. The first implementation should be a renderer integration, not a world simulation.

## 5. Coordinate-Space Rules

This system must respect the existing noa-engine coordinate boundary.

- Voxel data, block positions, changed blocks, chunk keys, and shelter checks are WORLD-space.
- Babylon visible objects are render-local because noa can rebase visible scene objects around the player.
- Precipitation visuals should be camera-relative/render-local.
- The field should follow the camera/player visually without pretending to be persistent world matter.
- Shelter tests may query WORLD-space blocks above or around the player.
- Any WORLD-space query result must be converted only at the narrow boundary where it influences render-local visuals.
- Do not mix mesh positions, camera positions, and voxel positions casually.
- Do not touch `VoxelLightManager`.
- Do not touch world/local coordinate helpers.
- Do not touch block light source registry.
- Do not touch terrain mesh recolor logic.
- Do not touch noa origin-rebase logic.

Recommended mental model:

```text
WORLD-space:
  blocks, shelter ray/check, logical player position, chunk data

RENDER-local / camera-relative:
  falling rectangles, field volume, visual wrapping, Babylon meshes
```

The field should be visually anchored around the camera, not registered as world blocks and not stored in chunk data.

## 6. Data Model Draft

Keep the first config small. Avoid long-term weather concepts until the renderer proves itself.

```ts
export interface PrecipitationFieldConfig {
  enabled: boolean;
  elementCount: number;
  fieldRadius: number;
  fieldHeight: number;
  baseVelocity: [number, number, number];
  wind: [number, number, number];
  elementSize: {
    width: number;
    height: number;
  };
  alpha: number;
  wrapMode: "cameraCylinder" | "cameraBox";
  respawnMode: "top" | "wrap";
  shelterMode: "off" | "playerRoofProbe";
  shelterReduction: number;
}
```

Prototype defaults should be conservative:

- Moderate `elementCount`, enough to see depth but not enough to stress the frame.
- Neutral grey material.
- Alpha below full opacity.
- Downward `baseVelocity`.
- Small horizontal `wind`.
- `shelterMode: "playerRoofProbe"` only after open-sky rendering works.

Do not add biome names, sound names, precipitation types, wetness, accumulation, damage, or visibility presets to the first model.

## 7. Lifecycle

Create/start:

- Construct only after the Babylon scene and camera are available.
- Construct only in Polygon for the first implementation pass.
- Allocate reusable geometry/materials once.
- Start disabled or behind an explicit Polygon debug/test control.

Update/tick:

- Accept `dtMs` or seconds delta.
- Read current camera/player render position.
- Move elements by `baseVelocity + wind`.
- Wrap or respawn elements inside the camera-relative volume.
- Apply shelter reduction after the basic open-sky field is stable.

Pause/disable:

- Hide or skip updates without disposing allocations.
- Do not leak updates while the main menu is active.
- Do not keep falling elements active when the engine is paused or destroyed.

Dispose/destroy:

- Dispose meshes, materials, buffers, and any event handlers owned by the renderer.
- Clear references to scene/camera.
- Must be safe to call more than once.

Menu transition cleanup:

- Returning to the main menu must dispose the renderer.
- Re-entering Polygon must create a fresh renderer.
- Main menu must show zero precipitation objects.

Play Game vs Polygon behavior:

- First implementation: Polygon only.
- Play Game should launch unchanged.
- If Play Game creates no field, that is correct for the first pass.
- Do not wire real game weather state yet.

## 8. Polygon Test Plan

The future Polygon test area should include:

- Start/stop control for the abstract field.
- Open sky area.
- Roof or shelter box.
- Wind test area or wind toggle.
- Looking up test.
- Walking test.
- FPS observation in the existing debug style.
- No teleport-only acceptance.

Acceptance movement should include walking under the field and across the shelter edge. Teleports are useful for setup but do not prove the camera-relative field behaves during movement.

Suggested manual checks:

1. Enter Polygon from the main menu.
2. Start the abstract field.
3. Stand in open sky and look forward.
4. Look up and confirm depth/columns are visible.
5. Walk forward, backward, and sideways.
6. Toggle or change wind and confirm motion changes.
7. Move under the shelter box and confirm reduction or hiding.
8. Return to menu and confirm all field visuals disappear.
9. Re-enter Polygon and confirm the renderer creates cleanly again.
10. Enter Play Game and confirm it still launches without field leakage.

## 9. Acceptance Criteria For Future Implementation

1. Starts from stable main, not failed weather branch.
2. Polygon has Abstract Precipitation test zone.
3. Player can activate/deactivate field.
4. Grey falling elements show depth/perspective.
5. Looking up reveals field/columns.
6. Walking does not make field visibly lag behind.
7. It does not look like a small blob/stain around the player.
8. Under roof: precipitation reduced/hidden.
9. Wind vector visibly affects motion.
10. FPS remains usable.
11. No precipitation appears in main menu.
12. E remains Use/Interact only.
13. Block lighting unchanged.
14. Play Game still launches.
15. Polygon still launches.

## 10. Risks

- Performance: too many independent meshes or CPU-updated objects can drop FPS.
- Menu leaks: renderer objects can survive after the game canvas is destroyed.
- World/local coordinate confusion: shelter checks and render visuals live in different spaces.
- Shelter test cost: naive per-element block probing could become expensive.
- Rebuilding weather too early: broad presets and effect names can swallow the renderer validation pass.
- Touching protected lighting code: this system must not require lighting changes.
- Visual blob effect: if the volume is too small or too camera-stuck, it will look like a stain around the player instead of a field.
- Agent scope creep: adding rain, snow, dust, audio, fog, hazards, or biome binding in the first pass would repeat the failed-weather pattern.

## 11. Future Ladder

The correct ladder is:

1. Abstract grey falling field.
2. Wind vector.
3. Shelter/roof test.
4. Texture swap.
5. First real effect: snow.
6. Rain.
7. Ash/embers/dust/toxic effects.
8. Biome/weather state binding.
9. Gameplay hazards.

Do not skip to named weather until the renderer has passed Polygon tests.

## 12. Prompt For Next Implementation Pass

Draft prompt outline:

```text
Pass 3 - Abstract Precipitation Field Prototype

Implement only the first abstract prototype of PrecipitationFieldRenderer.

Scope:
- Polygon only.
- Grey falling rectangles/streaks only.
- Camera-relative 3D field with visible depth.
- Basic wind vector.
- Basic shelter/roof reduction test.
- Clean lifecycle and disposal on menu/game transitions.

Do not implement:
- Weather presets.
- Rain, snow, dust, ash, storms, or named effects.
- Audio.
- Fog integration.
- Gameplay hazards.
- DOM overlays.

Do not touch:
- VoxelLightManager.
- noa origin-rebase logic.
- world/local coordinate helpers except narrow read-only use required for integration.
- block light registry.
- terrain mesh recolor logic.
- lighting systems.

Verification:
- Run npm.cmd run build.
- Run npm.cmd run lint.
- Start dev server.
- Manually test Polygon start/stop, open sky, looking up, walking, wind, shelter, menu cleanup, Play Game launch, and Polygon launch.
- Report exact files changed and test results.
```

