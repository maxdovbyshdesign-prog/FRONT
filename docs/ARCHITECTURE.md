# FRONTIER PLANET - ARCHITECTURE SPECS

This document maps out the system architecture of **FRONTIER PLANET**, designed for maximum iteration safety and strict separation of presentation (rendering/voxel canvases) from pure gameplay mechanics and simulation states.

---

## 1. Architectural System Layout

Web-based game development frequently falls into the trap of embedding critical business logic (like quests, vitals, or inventories) directly inside rendering ticks, pointer locks, or WebGL coordinate meshes. 

In FRONTIER PLANET, we utilize a strictly **Service-Based Game Architecture**:

```
                 +-------------------------------------------------+
                 |                   React HUD                     |
                 |      (UI Telemetry, Alerts, Hotbar, Menus)      |
                 +-----------------------+-------------------------+
                                         | Reads State & Events
                                         v
+------------------+     +---------------+---------------+     +------------------+
| NoaEngineAdapter | <== |            GameApp            | ==> |    GameState     |
| (3D Canvas, Voxel|     | (Bootstrapper, Updates Loop) |     |  (Serializable)  |
| Meshing, Babylon)|     +---------------+---------------+     +------------------+
+------------------+                     |
                                         | Owns & Coordinates
                                         v
                 +-------------------------------------------------+
                 |                Autonomous Services             |
                 | - playerService       - worldService            |
                 | - blockService        - missionService          |
                 | - uiService           - inputService            |
                 | - [Extension Placeholders (Combat, Save, Save)]|
                 +-------------------------------------------------+
```

---

## 2. Decoupling Boundaries

### A. Voxel Engine Sandbox: `NoaEngineAdapter`
- Represents the **ONLY** place inside the entire codebase that imports or discusses `noa-engine` or `Babylon.js`.
- Handles low-level WebGL context initialization, block materials, chunk mesh loading, and canvas-level event mouse clicks.
- If the project ever replaces Noa with Three.js, native WebGPU, or custom shaders, the core gameplay services (`PlayerService`, `MissionService`, etc.) remain **100% untouched**.

### B. Core Loop Hub: `GameApp`
- Functions as the unified lifecycle administrator.
- Bootstraps all active services and establishes dependency injections.
- Schedules the central tick loops that trigger passive AI patterns.

### C. Pure Business Entities: `Services`
- Hold no rendering, WebGL context, or visual elements.
- Maintain states, increment counters, check limits, and return factual results.
- Broaden communication through standard event handler registries (`registerOnStateChange`).

---

## 3. Data-Driven Gameplay Blueprinting
Rather than hardcoding blocks, missions, or faction standing parameters inside loops, all game assets are defined inside `/src/data/` as static data schemas compliant with `/src/types.ts`.
- **`BLOCKS`**: Defines block IDs, visual colors (0-1 formats), solid boundaries, and description attributes.
- **`BIOMES`**: Controls procedural landscape layers (topsoils, baseplates).
- **`ARTIF_PRESETS`**: Restores base currency values and threat ratings.

---

## 4. Scalable Extension Registries
We have seeded explicit, fully documented placeholders for future development phases:
1. **Multiplayer ready (`NetworkService`)**: Restricts mutations to serializable `GameEvent` slots.
2. **Combat ready (`CombatService`)**: Structures target health and armor damage mitigation matrices.
3. **Save/Load ready (`SaveService`)**: Unveils local storage JSON codecs for raid stats preservation.
4. **Base building ready (`BaseService`)**: Pre-allocates generator loads and power consumers.
5. **Inventory ready (`InventoryService`)**: Preserves slot caches, stack parameters, and weight ratios.
