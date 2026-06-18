/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BlockDefinition } from '../types';

/**
 * Texture convention:
 *   Public block assets live under  /assets/textures/blocks/
 *   File names follow  <block_materialName>_<slot>.png
 *
 * If a texture file is missing, MaterialService logs a warning and falls back
 * to the block's flat `color`. The game never crashes on a missing asset.
 *
 * Slot suffixes:
 *   _albedo  — diffuse color map
 *   _normal  — tangent-space normal map
 *   _emissive— emissive mask (the pixels that should glow)
 */

/**
 * Helper to build a standard-material config with optional texture paths.
 * Keeps the block table below readable.
 */
function stdMaterial(opts: {
  albedo?: string;
  normal?: string;
  emissive?: string;
  emissiveColor?: [number, number, number];
  emissiveStrength?: number;
  roughness?: number;
  metallic?: number;
  specularColor?: [number, number, number];
}): BlockDefinition['material'] {
  return {
    type: 'standard',
    diffuseTexture: opts.albedo,
    normalTexture: opts.normal,
    emissiveTexture: opts.emissive,
    emissiveColor: opts.emissiveColor,
    emissiveStrength: opts.emissiveStrength,
    roughness: opts.roughness,
    metallic: opts.metallic,
    specularColor: opts.specularColor,
  };
}

const TEX = '/assets/textures/blocks';

export const BLOCKS: BlockDefinition[] = [
  {
    id: 1,
    name: 'Red Dust',
    materialName: 'red-dust',
    color: [0.75, 0.25, 0.15],
    solid: true,
    opaque: true,
    baseValue: 1,
    description: 'Highly oxygenated alien silt. Hard to breathe, easy to excavate.',
    material: stdMaterial({
      albedo: `${TEX}/red_dust_albedo.png`,
      normal: `${TEX}/red_dust_normal.png`,
      roughness: 0.95,
      specularColor: [0.05, 0.03, 0.02],
    }),
  },
  {
    id: 2,
    name: 'Black Glass',
    materialName: 'black-glass',
    color: [0.12, 0.12, 0.16],
    solid: true,
    opaque: true,
    baseValue: 5,
    description: ' Obsidian-like volcanic crystal cooled in zero-gravity. Brittle but extremely sharp.',
    material: stdMaterial({
      albedo: `${TEX}/black_glass_albedo.png`,
      normal: `${TEX}/black_glass_normal.png`,
      roughness: 0.18,
      metallic: 0.0,
      specularColor: [0.6, 0.6, 0.7],
    }),
  },
  {
    id: 3,
    name: 'Metal Floor',
    materialName: 'metal-floor',
    color: [0.45, 0.45, 0.5],
    solid: true,
    opaque: true,
    baseValue: 12,
    description: 'Graphite alloy armor plating from a decommissioned corporate mining rig.',
    material: stdMaterial({
      albedo: `${TEX}/metal_floor_albedo.png`,
      normal: `${TEX}/metal_floor_normal.png`,
      roughness: 0.45,
      metallic: 0.7,
      specularColor: [0.7, 0.7, 0.75],
    }),
  },
  {
    id: 4,
    name: 'Ancient Stone',
    materialName: 'ancient-stone',
    color: [0.35, 0.3, 0.35],
    solid: true,
    opaque: true,
    baseValue: 15,
    description: 'Eroded masonry encoded with incomprehensible geometric anomalies.',
    material: stdMaterial({
      albedo: `${TEX}/ancient_stone_albedo.png`,
      normal: `${TEX}/ancient_stone_normal.png`,
      roughness: 0.85,
      specularColor: [0.1, 0.08, 0.1],
    }),
  },
  {
    id: 5,
    name: 'Glowing Artifact Block',
    materialName: 'glowing-artifact',
    color: [0.05, 0.85, 0.95],
    solid: true,
    opaque: true,
    baseValue: 500,
    description: 'Super-dense crystalline lattice humming with quantum field fluctuations.',
    tags: ["artifact", "mission_target", "light_source"],
    artifactId: "epsilon_glowing_core",
    material: stdMaterial({
      albedo: `${TEX}/pulse_core_albedo.png`,
      normal: `${TEX}/pulse_core_normal.png`,
      emissive: `${TEX}/pulse_core_emissive.png`,
      emissiveColor: [0.05, 0.85, 0.95],
      emissiveStrength: 1.4,
      roughness: 0.3,
      metallic: 0.2,
    }),
    light: {
      kind: "point",
      color: [0.05, 0.85, 0.95],
      intensity: 1.5,
      range: 12,
      emissiveStrength: 1.0,
      priority: 10, // mission-critical light — always wins the active budget
    },
  },
  {
    id: 6,
    name: 'Industrial Wall Lamp',
    materialName: 'wall-lamp',
    color: [0.1, 0.8, 0.95],
    solid: true,
    opaque: false,
    baseValue: 20,
    description: 'Wall-mounted cybernetic light emitting a steady cyan glow, vital for subterranean tunnels.',
    tags: ["light_source", "utility"],
    material: stdMaterial({
      albedo: `${TEX}/wall_lamp_albedo.png`,
      emissive: `${TEX}/wall_lamp_emissive.png`,
      emissiveColor: [0.1, 0.85, 1.0],
      emissiveStrength: 1.2,
      roughness: 0.5,
    }),
    light: {
      kind: "point",
      color: [0.1, 0.85, 1.0],
      intensity: 1.8,
      range: 18,
      emissiveStrength: 1.0,
      flicker: false,
      priority: 5,
    },
  },
  {
    id: 7,
    name: 'Halogen Work Light',
    materialName: 'halogen-light',
    color: [0.95, 0.7, 0.15],
    solid: true,
    opaque: false,
    baseValue: 25,
    description: 'Freestanding high-intensity halogen fixture projecting warm amber rays across desolate workspaces.',
    tags: ["light_source", "utility"],
    material: stdMaterial({
      albedo: `${TEX}/halogen_light_albedo.png`,
      emissive: `${TEX}/halogen_light_emissive.png`,
      emissiveColor: [1.0, 0.7, 0.2],
      emissiveStrength: 1.3,
      roughness: 0.4,
    }),
    light: {
      kind: "point",
      color: [1.0, 0.7, 0.2],
      intensity: 2.2,
      range: 24,
      emissiveStrength: 1.0,
      flicker: false,
      priority: 5,
    },
  },
  {
    id: 8,
    name: 'Planetary Beacon',
    materialName: 'planetary-beacon',
    color: [0.8, 0.1, 0.9],
    solid: true,
    opaque: false,
    baseValue: 40,
    description: 'Pulsing quantum beacon to guide ships, surveyors, and lost engineers safely back to base.',
    tags: ["light_source", "utility", "beacon"],
    material: stdMaterial({
      albedo: `${TEX}/planetary_beacon_albedo.png`,
      emissive: `${TEX}/planetary_beacon_emissive.png`,
      emissiveColor: [0.9, 0.1, 1.0],
      emissiveStrength: 1.5,
      roughness: 0.35,
      metallic: 0.3,
    }),
    light: {
      kind: "point",
      color: [0.9, 0.1, 1.0],
      intensity: 2.0,
      range: 20,
      emissiveStrength: 1.0,
      pulse: true,
      priority: 8, // beacons outrank ordinary lamps
    },
  },
];

export function getBlockById(id: number): BlockDefinition | undefined {
  return BLOCKS.find(b => b.id === id);
}
