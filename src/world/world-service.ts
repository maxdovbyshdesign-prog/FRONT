/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { VoxelPosition } from '../types';
import { gameState } from '../game/game-state';
import { ModRegistry } from '../modding/mod-registry';

interface StructureInstance {
  structureId: string;
  startX: number;
  startY: number;
  startZ: number;
  size: [number, number, number];
}

/**
 * WorldService - Integrates deterministic noise terrain, procedural biomes,
 * landmark silhouettes, safe-zone landing pads, and ancient ruin layouts.
 */
export class WorldService {
  // Center coordinates
  private extractionCenter: [number, number] = [0, 0];
  private extractionRadius: number = 8;
  
  private outpostMin: [number, number, number] = [12, 12, 12];
  private outpostMax: [number, number, number] = [18, 16, 18];

  private ruinMin: [number, number, number] = [-25, 12, -25];
  private ruinMax: [number, number, number] = [-15, 22, -15];
  private artifactPos: VoxelPosition = [-20, 14, -20];

  // Performance Optimization Caches
  private heightCache = new Map<string, number>();
  private biomeCache = new Map<string, boolean>();
  private structureCache = new Map<string, StructureInstance | null>();

  constructor() {
    console.log('[WorldService] Voxel matrices synced. Landscape noise equations active.');
  }

  /**
   * Sets/saves a block override when placed/destroyed by player.
   */
  public setBlockOverride(x: number, y: number, z: number, blockId: number): void {
    const key = `${x},${y},${z}`;
    gameState.changedBlocks.set(key, blockId);
  }

  /**
   * Dynamic check to see if we are in black glass patch area.
   */
  public isBlackGlassZone(x: number, z: number): boolean {
    const key = `${x},${z}`;
    if (this.biomeCache.has(key)) {
      return this.biomeCache.get(key)!;
    }
    if (this.biomeCache.size > 100000) {
      this.biomeCache.clear();
    }

    const distToSpawnSq = x * x + z * z;
    if (distToSpawnSq < 144) {
      this.biomeCache.set(key, false);
      return false;
    }
    const dxOut = x - 15;
    const dzOut = z - 15;
    const distToOutpostSq = dxOut * dxOut + dzOut * dzOut;
    if (distToOutpostSq < 64) {
      this.biomeCache.set(key, false);
      return false;
    }
    const dxRuin = x + 20;
    const dzRuin = z + 20;
    const distToRuinSq = dxRuin * dxRuin + dzRuin * dzRuin;
    if (distToRuinSq < 144) {
      this.biomeCache.set(key, false);
      return false;
    }

    // Use deterministic noise condition for organic glassy zones
    const result = this.noise2D(x / 14.0, z / 14.0) > 0.72;
    this.biomeCache.set(key, result);
    return result;
  }

  // 1D/2D Seeded noise functions
  private hash2D(x: number, z: number): number {
    const h = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453123;
    return h - Math.floor(h);
  }

  private noise2D(x: number, z: number): number {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;

    const a = this.hash2D(ix, iz);
    const b = this.hash2D(ix + 1, iz);
    const c = this.hash2D(ix, iz + 1);
    const d = this.hash2D(ix + 1, iz + 1);

    const ux = fx * fx * (3.0 - 2.0 * fx);
    const uz = fz * fz * (3.0 - 2.0 * fz);

    return a * (1 - ux) * (1 - uz) +
           b * ux * (1 - uz) +
           c * (1 - ux) * uz +
           d * ux * uz;
  }

  private fbm2D(x: number, z: number, octaves = 3): number {
    let value = 0.0;
    let amplitude = 1.0;
    let frequency = 1.0;
    let maxValue = 0.0;
    for (let i = 0; i < octaves; i++) {
      value += this.noise2D(x * frequency, z * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= 0.5;
      frequency *= 2.0;
    }
    return value / maxValue;
  }

  /**
   * Returns the block ID at any specific global voxel coordinate.
   * 0 = Air, 1 = Red Dust, 2 = Black Glass, 3 = Metal Floor, 4 = Ancient Stone, 5 = Glowing Artifact
   */
  public getBlockAt(x: number, y: number, z: number): number {
    // Check central cache first
    const key = `${x},${y},${z}`;
    if (gameState.changedBlocks.has(key)) {
      return gameState.changedBlocks.get(key)!;
    }

    // --- CUSTOM STRUCT PROCEDURAL PLACEMENT ---
    const customBlock = this.getCustomStructureBlockAt(x, y, z);
    if (customBlock !== undefined) {
      return customBlock;
    }

    // --- PROCEDURAL ATMOS LIGHT FIXTURES (Priority 3, 5 & 9) ---
    // 1. Landing pad lighting near spawn
    if (y === 13) {
      if (x === 3 && z === 0) return 7;   // Standing Halogen Work Light
      if (x === -3 && z === 0) return 8;  // Planetary Beacon near extraction
    }

    // 2. Outpost industrial wall lamp inside room ceiling
    if (x === 15 && z === 15 && y === 15) {
      return 6; // Industrial Wall Lamp
    }

    // 3. Ancient ruins atmospheric pillars lamps
    if (y === 16) {
      if (x === -20 && z === -17) return 6; // Wall lamp near core
      if (x === -17 && z === -20) return 6; // Wall lamp near core
    }

    // --- PROCEDURAL LANDMARKS SILHOUETTES & VISUAL ORIENTATION ---

    // 1. Ancient monument towering obelisks at the corners (for visual navigation landmarks)
    const isObeliskCorner = 
      (x === -24 && z === -24) ||
      (x === -16 && z === -24) ||
      (x === -24 && z === -16) ||
      (x === -16 && z === -16);
    if (isObeliskCorner && y > 12 && y <= 35) {
      if (y === 35) return 5; // Glowing beacon tips
      return 4; // Ancient Stone
    }

    // 2. Outpost communication satellite antenna pylon
    if (x === 15 && z === 15 && y >= 16 && y <= 32) {
      if (y === 32) return 5; // Glowing emitter tip
      return 3; // Metal Floor (treated as antenna structural bars)
    }

    // --- PROCEDURAL NOISE TERRAIN GENERATION (Priority 5) ---
    // Use cached optimized surface height calculation which includes flatFactor and craters
    const finalHeight = this.getSurfaceHeight(x, z);
    const baseHeight = Math.floor(finalHeight);

    // --- DECORATIVE BUILDINGS & STRUCTURES OVERRIDES ---

    // Outpost Base Building Structure
    if (x >= this.outpostMin[0] && x <= this.outpostMax[0] &&
        z >= this.outpostMin[2] && z <= this.outpostMax[2]) {
      if (y === 12) return 3; // Metal Floor
      if (y === this.outpostMax[1]) return 3; // Roof plate
      
      if (y > 12 && y < this.outpostMax[1]) {
        const isWall = x === this.outpostMin[0] || x === this.outpostMax[0] ||
                       z === this.outpostMin[2] || z === this.outpostMax[2];
        const isDoorway = x === this.outpostMin[0] && z === Math.floor((this.outpostMin[2] + this.outpostMax[2]) / 2) && y < 15;
        if (isWall && !isDoorway) {
          return 4; // Ancient Stone
        }
      }
    }

    // Ancient Ruin Monument structure
    if (x >= this.ruinMin[0] && x <= this.ruinMax[0] &&
        z >= this.ruinMin[2] && z <= this.ruinMax[2]) {
      
      // Foundational Core Block
      if (x === this.artifactPos[0] && y === this.artifactPos[1] && z === this.artifactPos[2]) {
        return 5; // Glowing Artifact Block
      }

      // Base Floor
      if (y === 12) return 4; // Ancient Stone

      // monument structures, walls and columns
      if (y > 12 && y < this.ruinMax[1]) {
        const xDist = Math.abs(x - this.artifactPos[0]);
        const zDist = Math.abs(z - this.artifactPos[2]);
        if (xDist === 4 || zDist === 4) {
          const isEntrance = (xDist === 4 && zDist < 2 && y < 16) || (zDist === 4 && xDist < 2 && y < 16);
          if (!isEntrance) return 4; // Ancient Stone
        }
        if (xDist === 1 && zDist === 1 && y < 18) {
          return 4; // Pillars
        }
      }

      if (y === this.ruinMax[1] - 1 || y === this.ruinMax[1]) {
        return 4; // Ceiling caps
      }
    }

    // Safe extraction / landing pad near spawn
    // Check using squared bounds to avoid Math.sqrt
    const distToSpawnSq = x * x + z * z;
    if (distToSpawnSq <= 16) {
      if (y === 12) return 3; // Metal floor plate
    }

    // --- STANDARD LAYER FILL ---
    if (y < baseHeight - 3) {
      return 2; // Deep Black Glass
    } else if (y <= baseHeight) {
      // surface layers
      if (y === baseHeight && this.isBlackGlassZone(x, z)) {
        return 2; // Procedural Black Glass patch
      }
      return 1; // Red Desert Dust
    }

    return 0; // Air
  }

  public getExtractionBounds() {
    return {
      center: this.extractionCenter,
      radius: this.extractionRadius
    };
  }

  public getRuinCenter(): VoxelPosition {
    return this.artifactPos;
  }

  /**
   * Returns every static / procedurally-placed light-source block position in
   * the world. Consumed by WorldLightManager to pre-seed the persistent light
   * registry so lamps illuminate correctly from frame one (and survive the
   * player walking away and returning).
   *
   * This list MUST stay in sync with the block IDs returned by getBlockAt().
   * If you add a new light fixture to the world generator, add it here too.
   */
  public getStaticLightSources(): { pos: VoxelPosition; blockId: number }[] {
    return [
      // Landing pad lighting near spawn.
      { pos: [3, 13, 0], blockId: 7 },     // Halogen Work Light
      { pos: [-3, 13, 0], blockId: 8 },   // Planetary Beacon
      // Outpost interior.
      { pos: [15, 15, 15], blockId: 6 },  // Industrial Wall Lamp
      // Ancient ruins atmospheric pillar lamps.
      { pos: [-20, 16, -17], blockId: 6 },
      { pos: [-17, 16, -20], blockId: 6 },
      // Obelisk corner tips (glowing artifact blocks).
      { pos: [-24, 35, -24], blockId: 5 },
      { pos: [-16, 35, -24], blockId: 5 },
      { pos: [-24, 35, -16], blockId: 5 },
      { pos: [-16, 35, -16], blockId: 5 },
      // Outpost antenna emitter tip.
      { pos: [15, 32, 15], blockId: 5 },
      // Central ruin artifact core.
      { pos: [this.artifactPos[0], this.artifactPos[1], this.artifactPos[2]], blockId: 5 },
    ];
  }

  /**
   * Safe retrieval of surface height before structure placement with Map caching
   */
  private getSurfaceHeight(x: number, z: number): number {
    const key = `${x},${z}`;
    if (this.heightCache.has(key)) {
      return this.heightCache.get(key)!;
    }
    if (this.heightCache.size > 100000) {
      this.heightCache.clear();
    }

    const dunesVal = this.fbm2D(x / 45.0, z / 45.0, 3);
    const ridgesVal = Math.max(0, this.noise2D(x / 25.0, z / 25.0) - 0.65) * 16.0;
    let terrainHeight = 11.5 + dunesVal * 8.5 + ridgesVal;

    const craters = [
      { cx: 35, cz: -35, r: 14, depth: 6 },
      { cx: -45, cz: 40, r: 18, depth: 8 }
    ];
    for (const cr of craters) {
      const dx = x - cr.cx;
      const dz = z - cr.cz;
      const dSq = dx * dx + dz * dz;
      const rSq = cr.r * cr.r;
      if (dSq < rSq) {
        const d = Math.sqrt(dSq);
        const ratio = d / cr.r;
        const bowl = (1.0 - ratio * ratio) * -cr.depth;
        terrainHeight += bowl;
      }
    }

    const distToSpawnSq = x * x + z * z;
    const spawnFlat = distToSpawnSq < 100 ? Math.sqrt(distToSpawnSq) / 10.0 : 1.0;

    const dxOut = x - 15;
    const dzOut = z - 15;
    const distToOutpostSq = dxOut * dxOut + dzOut * dzOut;
    const outpostFlat = distToOutpostSq < 49 ? Math.sqrt(distToOutpostSq) / 7.0 : 1.0;

    const dxRuin = x + 20;
    const dzRuin = z + 20;
    const distToRuinSq = dxRuin * dxRuin + dzRuin * dzRuin;
    const ruinFlat = distToRuinSq < 144 ? Math.sqrt(distToRuinSq) / 12.0 : 1.0;

    const flatFactor = Math.min(spawnFlat, outpostFlat, ruinFlat);

    const result = 12 + (terrainHeight - 12) * flatFactor;
    this.heightCache.set(key, result);
    return result;
  }

  /**
   * Precompute candidate structures once per region and cache them.
   */
  private createStructureInstanceForGrid(gridX: number, gridZ: number): StructureInstance | null {
    const rules = ModRegistry.getInstance().getPlacementRules();
    if (rules.length === 0) return null;

    const gridSize = 64;
    const h = this.hash2D(gridX, gridZ);

    for (const rule of rules) {
      // Determine center coords
      const hX = this.hash2D(gridX + 11.2, gridZ - 13.9);
      const hZ = this.hash2D(gridX - 23.4, gridZ + 41.5);
      const sx = gridX * gridSize + 16 + Math.floor(hX * 32);
      const sz = gridZ * gridSize + 16 + Math.floor(hZ * 32);

      // Biome match at structure's center
      const isBlackZone = this.isBlackGlassZone(sx, sz);
      const activeBiome = isBlackZone ? 'black_glass_canyon' : 'red_wasteland';
      if (!rule.biomes.includes(activeBiome)) continue;

      // Seed filter
      if (h > rule.rarity) continue;

      // Dist from spawn
      const dSpawnSq = sx * sx + sz * sz;
      const minDist = rule.minDistanceFromSpawn ?? 30;
      if (dSpawnSq < minDist * minDist) continue;

      // Avoid Outpost
      const dxOut = sx - 15;
      const dzOut = sz - 15;
      if (dxOut * dxOut + dzOut * dzOut < 18 * 18) continue;

      // Avoid Monument
      const dxMon = sx + 20;
      const dzMon = sz + 20;
      if (dxMon * dxMon + dzMon * dzMon < 20 * 20) continue;

      const struct = ModRegistry.getInstance().getStructure(rule.structureId);
      if (!struct) continue;

      const sy = Math.floor(this.getSurfaceHeight(sx, sz));

      return {
        structureId: rule.structureId,
        startX: sx - Math.floor(struct.size[0] / 2),
        startY: sy,
        startZ: sz - Math.floor(struct.size[2] / 2),
        size: struct.size
      };
    }

    return null;
  }

  /**
   * Deterministic placement of modded custom structures (Cached, O(1) inside structures)
   */
  private getCustomStructureBlockAt(x: number, y: number, z: number): number | undefined {
    const rules = ModRegistry.getInstance().getPlacementRules();
    if (rules.length === 0) return undefined;

    const gridSize = 64;
    const gridX = Math.floor(x / gridSize);
    const gridZ = Math.floor(z / gridSize);
    const cacheKey = `${gridX},${gridZ}`;

    let inst = this.structureCache.get(cacheKey);
    if (inst === undefined) {
      if (this.structureCache.size > 1000) {
        this.structureCache.clear();
      }
      inst = this.createStructureInstanceForGrid(gridX, gridZ);
      this.structureCache.set(cacheKey, inst);
    }

    if (!inst) return undefined;

    const ox = x - inst.startX;
    const oy = y - inst.startY;
    const oz = z - inst.startZ;

    if (ox >= 0 && ox < inst.size[0] && oy >= 0 && oy < inst.size[1] && oz >= 0 && oz < inst.size[2]) {
      const blockNamespace = ModRegistry.getInstance().getStructureBlock(inst.structureId, ox, oy, oz);
      if (blockNamespace) {
        const blockId = ModRegistry.getInstance().getNumericIdByNamespace(blockNamespace);
        if (blockId !== undefined) {
          return blockId;
        }
      }
      // Hollow interior inside the structure's bounding box
      return 0;
    }

    return undefined;
  }
}
