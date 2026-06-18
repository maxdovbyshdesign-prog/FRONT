/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Core Geometry
export type VoxelPosition = [number, number, number];

export interface LightProfile {
  color: [number, number, number];
  intensity: number;
  range: number;
  kind: "point" | "spot" | "emissive_only";
  flicker?: boolean;
  pulse?: boolean;
  emissiveStrength?: number;
  /**
   * Higher priority lights win the active-dynamic-light budget when the
   * WorldLightManager must cull far lights for performance.
   * Default 0. Beacons / mission lights should use a higher value.
   */
  priority?: number;
}

/**
 * Data-driven material configuration for a voxel block.
 *
 * - type "color": flat-color fallback (always available, never crashes).
 * - type "standard": Babylon StandardMaterial with optional diffuse / normal /
 *   emissive textures. This is the recommended path for noa-engine blocks.
 * - type "pbr": Babylon PBRMaterial. Reserved for future use; not all noa
 *   block meshes support PBR cleanly yet, so MaterialService treats this as
 *   "standard with extra fields" until validated.
 *
 * All texture paths are resolved relative to the document base. Public assets
 * live under `/assets/textures/blocks/`. Mod assets use absolute mod paths.
 * Missing textures are logged and fall back to flat color — they never crash.
 */
export interface BlockMaterialConfig {
  type: "color" | "standard" | "pbr";
  color?: [number, number, number];
  albedoTexture?: string;
  diffuseTexture?: string;
  normalTexture?: string;
  bumpTexture?: string;
  emissiveTexture?: string;
  emissiveColor?: [number, number, number];
  emissiveStrength?: number;
  roughness?: number;
  metallic?: number;
  specularColor?: [number, number, number];
}

// Block Definitions
export interface BlockDefinition {
  id: number;
  name: string;
  materialName: string;
  color: [number, number, number]; // RGB values 0 to 1 (legacy flat color, still required for noa registration + fallback)
  solid?: boolean;
  opaque?: boolean;
  baseValue?: number;
  description: string;
  tags?: string[];
  artifactId?: string;
  light?: LightProfile;
  /**
   * Optional extended material descriptor. When absent, the block uses the
   * legacy flat-color path (color -> noa registerMaterial + emissiveColor for
   * light_source blocks). Backward compatible with all existing block defs.
   */
  material?: BlockMaterialConfig;
}

// Biome Definitions
export interface BiomeDefinition {
  id: string;
  name: string;
  description: string;
  groundBlockId: number;
  subBlockId: number;
  ruinBlockId: number;
}

// Factions definitions
export interface Faction {
  id: string;
  name: string;
  description: string;
  standing: number; // -100 to +100
}

export type FactionRelation = 'hostile' | 'neutral' | 'friendly';

export interface TerritoryControl {
  factionId: string;
  controlLevel: number; // 0 to 100
}

// Weapon & Attachments
export interface WeaponAttachmentSlot {
  id: string;
  type: string;
  allowedTypes: string[];
  currentAttachment?: WeaponAttachment;
}

export interface WeaponAttachment {
  id: string;
  name: string;
  statsModifier: Partial<WeaponStats>;
}

export interface WeaponStats {
  damage: number;
  fireRate: number;
  accuracy: number;
  range: number;
}

export interface WeaponDefinition {
  id: string;
  name: string;
  type: string;
  baseStats: WeaponStats;
  allowedAttachments: string[];
  description: string;
}

export interface WeaponInstance {
  id: string;
  definitionId: string;
  attachments: Record<string, WeaponAttachment>;
  currentAmmo: number;
}

// Artifact definitions
export interface ArtifactDefinition {
  id: string;
  name: string;
  rarity: 'common' | 'rare' | 'exotic' | 'ancient';
  risk: number; // 0 to 100
  baseValue: number;
  effects: string[];
  containmentRequirement?: string;
  description: string;
}

// Combat system types
export type DamageType = 'kinetic' | 'thermal' | 'energy' | 'bio-hazard' | 'radiation';

export interface DamageEvent {
  targetEntityId: string;
  sourceEntityId: string;
  amount: number;
  type: DamageType;
}

export interface HealthComponent {
  currentHealth: number;
  maxHealth: number;
}

// Mission system elements
export interface Objective {
  id: string;
  type: 'locate_artifact' | 'reach_extraction' | 'mine_blocks';
  targetId?: string;
  targetCount?: number;
  currentCount: number;
  targetPosition?: VoxelPosition;
  text: string;
  isCompleted: boolean;
}

export interface MissionDefinition {
  id: string;
  title: string;
  description: string;
  objectives: Objective[];
  baseReward: number;
}

export interface MissionProgress {
  missionId: string;
  objectivesState: Record<string, boolean>;
  isCompleted: boolean;
  isExtracted: boolean;
}

// Inventory details
export interface ItemStack {
  itemId: string;
  count: number;
  type: 'block' | 'item' | 'weapon' | 'artifact';
}

export interface InventorySlot {
  slotId: number;
  stack: ItemStack | null;
}

// AI system types
export interface AiAgent {
  entityId: string;
  state: string; // "patrol", "combat", "flee"
  goal: string;
  targetEntityId?: string;
}

// Saving structures
export interface SerializableGameState {
  player: {
    health: number;
    maxHealth: number;
    position: VoxelPosition;
    selectedBlockId: number;
    hotbar: number[];
    inventory: ItemStack[];
  };
  mission: {
    activeMissionId: string;
    objectivesProgress: Record<string, number>; // id to current count
    isArtifactRecovered: boolean;
    isExtracted: boolean;
  };
  world: {
    currentZoneName: string;
    seed: number;
  };
}

// Game Events
export enum GameEventType {
  BLOCK_DESTROYED = 'BLOCK_DESTROYED',
  BLOCK_PLACED = 'BLOCK_PLACED',
  PLAYER_POSITION_CHANGED = 'PLAYER_POSITION_CHANGED',
  PLAYER_ENTERED_EXTRACTION_ZONE = 'PLAYER_ENTERED_EXTRACTION_ZONE',
  ARTIFACT_RECOVERED = 'ARTIFACT_RECOVERED',
  MISSION_COMPLETED = 'MISSION_COMPLETED',
}

export interface BlockDestroyedEvent {
  type: GameEventType.BLOCK_DESTROYED;
  payload: {
    position: VoxelPosition;
    blockId: number;
    blockTags?: string[];
    artifactId?: string;
  };
  timestamp: number;
}

export interface BlockPlacedEvent {
  type: GameEventType.BLOCK_PLACED;
  payload: {
    position: VoxelPosition;
    blockId: number;
  };
  timestamp: number;
}

export interface PlayerPositionChangedEvent {
  type: GameEventType.PLAYER_POSITION_CHANGED;
  payload: {
    position: VoxelPosition;
  };
  timestamp: number;
}

export interface PlayerEnteredExtractionZoneEvent {
  type: GameEventType.PLAYER_ENTERED_EXTRACTION_ZONE;
  payload: {
    position: VoxelPosition;
    radius: number;
  };
  timestamp: number;
}

export interface ArtifactRecoveredEvent {
  type: GameEventType.ARTIFACT_RECOVERED;
  payload: {
    artifactId: string;
    blockId: number;
  };
  timestamp: number;
}

export interface MissionCompletedEvent {
  type: GameEventType.MISSION_COMPLETED;
  payload: {
    missionId: string;
  };
  timestamp: number;
}

export type GameEvent =
  | BlockDestroyedEvent
  | BlockPlacedEvent
  | PlayerPositionChangedEvent
  | PlayerEnteredExtractionZoneEvent
  | ArtifactRecoveredEvent
  | MissionCompletedEvent;

export interface MissionEventResult {
  alertText: string;
  alertType: 'info' | 'success' | 'warning';
}

// Base Building
export interface MachineDefinition {
  id: string;
  name: string;
  powerDraw: number; // positive for consumer, negative for producer
  productionRate?: number;
}

export interface PowerNetwork {
  networkId: string;
  totalGeneration: number;
  totalDemand: number;
}
