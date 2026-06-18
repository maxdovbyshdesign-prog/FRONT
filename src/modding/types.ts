/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ModUiTheme {
  accentColor?: string;
  panelOpacity?: number;
  fontScale?: number;
}

export interface ModBlockDefinition {
  id: string; // namespaced e.g. "example:ash_stone"
  name: string;
  materialName: string;
  color: [number, number, number];
  solid?: boolean;
  opaque?: boolean;
  baseValue?: number;
  description: string;
  tags?: string[];
  artifactId?: string;
  /**
   * Optional light profile. A block is treated as a light source when either
   * `light` is present OR `tags` includes "light_source".
   */
  light?: import('../types').LightProfile;
  /**
   * Optional extended material descriptor (textures / normal maps / emissive
   * maps). Mirrors BlockDefinition.material so modded blocks look identical to
   * core blocks once registered.
   */
  material?: import('../types').BlockMaterialConfig;
}

export interface ModStructureBlock {
  pos: [number, number, number];
  block: string; // namespaced ID of block (or raw id like "1")
}

export interface ModStructureDefinition {
  id: string; // namespaced e.g. "example:small_shrine"
  name: string;
  size: [number, number, number];
  anchor: "ground_center" | "anywhere";
  tags?: string[];
  blocks: ModStructureBlock[];
}

export interface ModPlacementRule {
  structureId: string;
  biomes: string[];
  rarity: number; // 0 to 1
  minDistanceFromSpawn?: number;
  maxPerRegion?: number;
  requiresFlatGround?: boolean;
}

export interface ModSoundManifest {
  sounds?: {
    id: string;
    path: string;
    category?: 'ambient' | 'ui' | 'block' | 'footstep';
  }[];
}

export interface ModSkyConfig {
  skyColor?: string;
  dayColor?: string;
  nightColor?: string;
  fogColor?: string;
  fogStart?: number;
  fogEnd?: number;
}

export interface ModManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  content: {
    blocks?: string[];
    structures?: string[];
    placement?: string[];
    uiThemes?: string[];
    sounds?: string[];
    sky?: string[];
  };
}
