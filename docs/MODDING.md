# Frontier Planet Creator Content & Modding Guide (v0)

Frontier Planet includes a powerful, **fully data-driven Creator Content Layer (Modding support v0)**. This system allows you to add custom voxel types, procedural structure templates, placement rules, UI design presets, custom atmospheric/sky settings, and custom sound registrations without writing or compiling a single line of TypeScript/C++ code.

---

## 1. Folder Structure

All active mods reside inside the `public/mods/` directory. Each mod is contained in its own folder namespaced with your author tag:

```text
public/mods/
  ├── mod-list.json                        # Main directory of enabled mods
  └── example-ruins-pack/                  # Your mod identifier folder
      ├── mod.json                          # Core Manifest mapping mod contents
      ├── blocks/
      │   └── example_blocks.json           # Defines namespaced custom voxel properties
      ├── structures/
      │   └── example_shrine.fpstructure.json # Voxel-by-voxel structure layouts
      ├── placement/
      │   └── example_placement.json        # Procedurally spawns structures in biome coords
      ├── ui/
      │   └── theme.json                    # Custom UI layout design properties
      ├── sounds/
      │   └── sound_manifest.json           # Registry for place, mining, & ambient audio
      └── sky/
          └── sky.json                      # Per-biome day/night & fog overlays
```

---

## 2. Main Manifest File: `mod.json`

The root of every mod contains a `mod.json` manifest specifying descriptive metadata and relative pointers to each modding asset file:

```json
{
  "id": "example_ruins_pack",
  "name": "Example Ruins Pack",
  "version": "0.1.0",
  "author": "Frontier Planet",
  "description": "Example custom ruins and blocks.",
  "content": {
    "blocks": ["blocks/example_blocks.json"],
    "structures": ["structures/example_shrine.fpstructure.json"],
    "placement": ["placement/example_placement.json"],
    "uiThemes": ["ui/theme.json"],
    "sounds": ["sounds/sound_manifest.json"],
    "sky": ["sky/sky.json"]
  }
}
```

---

## 3. Creating Custom Voxel Blocks

Custom blocks are declared inside your blocks JSON. The engine assigns a virtual block ID starting at `10` or higher to prevent collisions with base blocks.

```json
[
  {
    "id": "example:ash_stone",
    "name": "Ash Stone",
    "materialName": "ash-stone",
    "color": [0.28, 0.24, 0.22],
    "solid": true,
    "opaque": true,
    "baseValue": 10,
    "description": "Seared pumice rubble formed from volcanic atmospheric drop-outs.",
    "tags": ["structure", "basalt"],
    "material": {
      "type": "standard",
      "diffuseTexture": "/mods/example-ruins-pack/textures/ash_stone_albedo.png",
      "normalTexture": "/mods/example-ruins-pack/textures/ash_stone_normal.png",
      "roughness": 0.9,
      "specularColor": [0.08, 0.06, 0.05]
    }
  }
]
```

- **id**: Namespaced string identifier (collison resistant!).
- **name**: Human-readable label displayed in current UI Scanner displays.
- **materialName**: The name of the material to register inside the 3D renderer.
- **color**: RGB values from `0.0` to `1.0`. For example, `[1.0, 1.0, 1.0]` is full white. Always required as the flat-color fallback.
- **solid**: True if the player collides with it.
- **opaque**: True if blocks behind are fully occluded.
- **tags**: Optional string array. Use `"light_source"` to mark a block as a light emitter (see §3.4).
- **material**: Optional extended material descriptor (see §3.1).
- **light**: Optional light profile (see §3.4).

### 3.1 Block Textures (diffuse / albedo)

A block can carry a full Babylon `StandardMaterial` via the `material` field.
The simplest texture block uses a diffuse (albedo) map:

```json
"material": {
  "type": "standard",
  "diffuseTexture": "/mods/your-pack/textures/my_block_albedo.png",
  "roughness": 0.85
}
```

- `diffuseTexture` and `albedoTexture` are aliases — either works.
- Paths are resolved relative to the document root. Mod assets should live
  under `/mods/<your-pack>/textures/` and be referenced with that absolute path.
- **Missing textures never crash the game.** If the PNG is absent,
  `MaterialService` logs one warning per path and falls back to the block's
  flat `color`. Ship your config first, drop in PNGs later.

### 3.2 Normal Maps (surface detail)

Add tangent-space normal maps for surface detail without extra geometry:

```json
"material": {
  "type": "standard",
  "diffuseTexture": "/mods/your-pack/textures/stone_albedo.png",
  "normalTexture": "/mods/your-pack/textures/stone_normal.png",
  "roughness": 0.8
}
```

- `normalTexture` and `bumpTexture` are aliases.
- Author normal maps in standard OpenGL tangent space. Babylon uses
  `invertZ = false` (configured automatically by `MaterialService`).
- 16×16 or 32×32 PNGs are plenty for voxel blocks.

### 3.3 Emissive Maps (glow)

Emissive maps define which pixels glow. Combined with the `GlowLayer`, this
makes lamps, crystals, and artifacts visibly shine at night:

```json
"material": {
  "type": "standard",
  "diffuseTexture": "/mods/your-pack/textures/lamp_albedo.png",
  "emissiveTexture": "/mods/your-pack/textures/lamp_emissive.png",
  "emissiveColor": [0.2, 1.0, 0.45],
  "emissiveStrength": 1.2,
  "roughness": 0.5
}
```

- `emissiveColor` tints the entire emissive map. Use `[r, g, b]` in 0..1 range.
- `emissiveStrength` scales the glow (1.0 = default, 1.5 = bright, 2.0+ = HDR bloom).
- Pure black pixels in the emissive map = no glow; bright pixels = full glow.
- Even if a block's dynamic point light is culled for performance, its
  emissive material keeps glowing through the `GlowLayer`. **Far lamps never
  look "dead".**

### 3.4 Light-Emitting Blocks

A block becomes a light source when EITHER:

- its `tags` array includes `"light_source"`, OR
- it has a non-null `light` profile.

The `light` profile controls the dynamic Babylon light cast into the world:

```json
{
  "id": "example:green_bunker_lamp",
  "name": "Green Bunker Lamp",
  "materialName": "example-green-bunker-lamp",
  "color": [0.2, 1.0, 0.45],
  "solid": true,
  "opaque": false,
  "baseValue": 22,
  "description": "Toxic-green emergency bunker fixture.",
  "tags": ["light_source", "utility"],
  "material": {
    "type": "standard",
    "diffuseTexture": "/mods/your-pack/textures/green_bunker_lamp_albedo.png",
    "emissiveTexture": "/mods/your-pack/textures/green_bunker_lamp_emissive.png",
    "emissiveColor": [0.2, 1.0, 0.45],
    "emissiveStrength": 1.0,
    "roughness": 0.5
  },
  "light": {
    "kind": "point",
    "color": [0.2, 1.0, 0.45],
    "intensity": 1.4,
    "range": 18,
    "priority": 5
  }
}
```

Light profile fields:

- **kind**: `"point"` (omni), `"spot"` (directional cone), or `"emissive_only"`
  (no dynamic light — pure visual glow, cheapest).
- **color**: RGB 0..1 tint of the cast light.
- **intensity**: ~1.0–2.5 typical. Scaled internally to Babylon's range.
- **range**: Voxel reach of the light. Clamped to 4–40 to protect perf.
- **flicker**: `true` for industrial flicker (random dips).
- **pulse**: `true` for smooth beacon pulse (sin wave).
- **emissiveStrength**: Scales the material emissive (separate from the cast light).
- **priority**: Higher wins the active-light budget when the scene has more
  lights than the quality preset allows (low=8, medium=16, high=24). Beacons
  and mission lights should use a higher value (5–10); decorative lamps use 0–3.

#### How lighting survives distance

The `WorldLightManager` keeps a **persistent registry** of every light ever
placed. When the player walks away, far lights' dynamic Babylon lights are
disposed for performance — but:

1. The registry entry stays, so walking back re-activates the light instantly.
2. The block's emissive material keeps glowing through the `GlowLayer`, so far
   lamps still look alive.

This fixes the old "lamp dies when you walk away" bug.

---

## 4. Building Custom Structures: `.fpstructure.json`

Custom structures are defined inside structural prefab files. They map localized offsets (relative to a starting corner) to a block ID:

```json
{
  "id": "example:small_shrine",
  "name": "Small Shrine",
  "size": [5, 4, 5],
  "anchor": "ground_center",
  "tags": ["ruin", "shrine", "artifact_site"],
  "blocks": [
    { "pos": [0, 0, 0], "block": "example:ash_stone" },
    { "pos": [2, 1, 2], "block": "example:glowing_crystal" }
  ]
}
```

- **size**: Bounding box array `[sizeX, sizeY, sizeZ]`. Keep it under `15, 15, 15` for clean grid snapping.
- **anchor**: Anchor coordinates layout logic. `"ground_center"` snaps the base center of the structure to the physical terrain surface.
- **blocks**: Array of coordinates offsets `{ pos: [offset_x, offset_y, offset_z], block: "namespaced_id_or_base_id" }`. Any coordinate within the size box not filled defaults to air (`0`), creating hollow interiors automatically!

---

## 5. Procedural Structure Placement

Telling the custom structure when and where to populate procedurally across the infinite planet is controlled via placement rules:

```json
{
  "placements": [
    {
      "structureId": "example:small_shrine",
      "biomes": ["red_wasteland"],
      "rarity": 0.12,
      "minDistanceFromSpawn": 45,
      "maxPerRegion": 2,
      "requiresFlatGround": true
    }
  ]
}
```

- **structureId**: The id of the structure to spawn.
- **biomes**: Array of biomes to spawn inside (`"red_wasteland"` or `"black_glass_canyon"`).
- **rarity**: Target spawn factor. `0.12` dictates a 12% probability of spawning in each procedural 64x64 sectors matrix.
- **minDistanceFromSpawn**: Distance in blocks/meters from the global coordinate origin `[0, y, 0]` before structures can begin generating, keeping safe zones flat and legible.

---

## 6. Custom Interface Themes

You can customize the game UI accents using the `uiThemes` overrides file:

```json
{
  "accentColor": "#00f2ff",
  "panelOpacity": 0.65,
  "fontScale": 1.05
}
```

---

## 7. Custom Atmosphere Sky & Audio Configs

Mod sky and sound manifests register details for future loading:

### Custom Sky Layout
```json
{
  "skyColor": "#150a1e",
  "dayColor": "#ff6600",
  "nightColor": "#05010a",
  "fogColor": "#d54b20",
  "fogStart": 50.0,
  "fogEnd": 120.0
}
```

### Custom Sound Layout
```json
{
  "sounds": [
    {
      "id": "block_place_custom",
      "path": "sounds/place.mp3",
      "category": "block"
    }
  ]
}
```

---

## 8. Voxel Assets Import Pipeline Roadmap

To capture future user workflows where creators draw assets inside independent visual models editors, we design the following import pipeline roadmap:

### Phase v0 (Current)
- Manual texturing/authoring of `.fpstructure.json` files and content registries.

### Phase v1 (Targeted Conversion)
- A command-line script parser that reads external MagicaVoxel `.vox` files (containing color indexes lists and locations matrices) and compiles them directly into a valid, optimized `.fpstructure.json` and block lists manifest!

### Phase v2 (Low-Poly Props & Skeletal Models)
- Integrates GLTF / GLB meshes compilation within Blockbench to load animated physical entities (e.g., alien drones, vehicles chassis) instead of raw grid-based block cubes.

### Phase v3 (In-Game Visual Prefab Modeller)
- A specialized developer/creator GUI inside the game allows you to build a structure box live on-screen, click "EXPORT TEMPLATE", and automatically write a compliant `.fpstructure.json` directly into your browser's clipboard or active download directories!
