# Block Texture Assets

Drop block texture PNGs in this directory. The MaterialService loads them
automatically based on the `material.diffuseTexture` / `normalTexture` /
`emissiveTexture` paths declared in each `BlockDefinition`.

## Naming convention

```
<block_materialName>_albedo.png     — diffuse color map (sRGB)
<block_materialName>_normal.png      — tangent-space normal map (linear)
<block_materialName>_emissive.png    — emissive mask (the pixels that glow)
```

## Expected files (referenced by src/data/blocks-data.ts)

```
red_dust_albedo.png            red_dust_normal.png
black_glass_albedo.png         black_glass_normal.png
metal_floor_albedo.png         metal_floor_normal.png
ancient_stone_albedo.png       ancient_stone_normal.png
pulse_core_albedo.png          pulse_core_normal.png          pulse_core_emissive.png
wall_lamp_albedo.png                                          wall_lamp_emissive.png
halogen_light_albedo.png                                      halogen_light_emissive.png
planetary_beacon_albedo.png                                   planetary_beacon_emissive.png
```

## Fallback behavior

If a file is MISSING, MaterialService logs a single warning per path and falls
back to the block's flat `color`. **The game never crashes on a missing
texture.** This lets artists iterate: ship the config first, drop in PNGs later.

## Authoring tips

- Use 16×16 or 32×32 PNGs for crisp voxel look. 64×64 max for hero blocks.
- Normal maps: standard OpenGL tangent-space (Babylon uses `invertZ = false`).
- Emissive maps: pure black = no glow, bright color = full glow. The
  `emissiveColor` field tints the whole map; `emissiveStrength` scales it.
- Keep PNGs reasonably compressed; Babylon decodes them once at load.
