/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * VoxelLightManager — Minecraft-style per-cell voxel lighting.
 *
 * PERFORMANCE-FIRST design. References studied:
 *   - 0fps "Voxel lighting" (2018): BFS flood-fill, sky/block split, RGB block light.
 *   - 0fps "Ambient occlusion for Minecraft-like worlds" (2013): cheap neighbor AO.
 *   - dktapps/lighting-algorithm-spec: chunk-local + cross-chunk propagation.
 *   - LegendOfVirelia / Vektor Voxels: 0-15 levels, dual channels, baked into mesh.
 *
 * Model:
 *   - skyLight: 0-15 per cell (sky exposure, blocked by opaque blocks).
 *   - blockLight: RGB channels 0-15 each (colored lamp light, BFS falloff).
 *   - Light is BAKED into chunk mesh vertex colors via an ADDITIVE/tint model:
 *       newColor = max(base * ambientFloor, base * skyPart + blockPart)
 *     This ensures colored light on colored terrain ADDS its tint instead of
 *     multiplying to black (cyan torch on red dust = red dust + cyan tint).
 *   - NO per-frame recomputation. Relight only on chunk-gen / block place / destroy.
 *   - Real Babylon PointLights are NOT spawned here — they're a separate debug-only
 *     system (WorldLightManager, capped 0-3). Glow is emissive material, not light.
 *
 * Storage:
 *   - Per-chunk Uint8Array in chunk.userData: skyLight[4096] + blockLightR/G/B[4096×3].
 *   - A global relight queue for cross-chunk propagation, processed a few cells/tick.
 *   - A global voxelLightSources registry so cross-chunk neighbor light sources
 *     can seed into a chunk being recomputed (fixes incomplete cross-chunk propagation).
 *   - Per-chunk lightDataVersion + per-mesh meshLightVersion for staleness tracking.
 */

import type { BlockDefinition, VoxelPosition } from "../../types";
import * as BABYLON from "@babylonjs/core";

/** Chunk size (matches noa-engine + NoaEngineAdapter). */
const CHUNK_SIZE = 16;
/** Cells per chunk: 16³ = 4096. */
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;
/** Maximum BFS propagation radius for block light (voxels). Hard cap = perf. */
const MAX_LIGHT_RADIUS = 8;
/** Light level max (Minecraft-style 0-15). */
const MAX_LIGHT_LEVEL = 15;

/** Per-chunk light storage. Stored on chunk.userData. */
export interface ChunkLightData {
  /** skyLight level 0-15 per cell. */
  skyLight: Uint8Array;
  /** blockLight red 0-15 per cell. */
  blockLightR: Uint8Array;
  /** blockLight green 0-15 per cell. */
  blockLightG: Uint8Array;
  /** blockLight blue 0-15 per cell. */
  blockLightB: Uint8Array;
  /** True if light needs recompute before next mesh. */
  dirty: boolean;
  /** Monotonic version bumped after each recompute. Meshes track the version
   *  they were last recolored with (mesh.metadata.meshLightVersion) so we can
   *  detect stale meshes that need recoloring. */
  lightDataVersion: number;
}

/** Light source descriptor (from a block's LightProfile). */
export interface VoxelLightSource {
  x: number;
  y: number;
  z: number;
  level: number; // 0-15
  r: number; // 0-1
  g: number; // 0-1
  b: number; // 0-1
}

/** Result of a single cell in the 3×3 surface light test. */
export interface SurfaceTestCellResult {
  worldPos: [number, number, number];
  blockId: number;
  chunkKey: string;
  localCell: [number, number, number];
  hasLightData: boolean;
  brightnessBefore: [number, number, number];
  brightnessAfter: [number, number, number];
  brightnessAfterRemove: [number, number, number];
  deltaPlace: [number, number, number];
  deltaRemove: [number, number, number];
  brightenedOnPlace: boolean;
  dimmedOnRemove: boolean;
}

/** Result of the 3×3 surface light test. */
export interface SurfaceTestResult {
  centerPos: [number, number, number];
  cells: SurfaceTestCellResult[];
  cellsBrightened: number;
  cellsDimmed: number;
  cellsWithLightData: number;
  result: "PASS" | "FAIL" | "INCONCLUSIVE";
  reason: string;
}

export interface VoxelLightDebugInfo {
  lightingMode: "performance_voxel" | "debug_real_lights" | "experimental_pretty";
  skyLightEnabled: boolean;
  blockLightEnabled: boolean;
  chunksWithLightData: number;
  relightQueueSize: number;
  floodFillOpsLastUpdate: number;
  lastLightUpdateMs: number;
  meshRebuildCountLastSecond: number;
  skyLightAtPlayer: number;
  blockLightAtPlayer: [number, number, number];
  combinedBrightnessAtPlayer: number;
  glowingBlocksNearby: number;
  voxelLightSourcesNearby: number;
  minBrightness: number;
  skyLightBrightness: number;
  blockLightBrightness: number;
  // Recolor pipeline diagnostics.
  missingLightDataFallbackCount: number;
  recoloredMeshCountLastAction: number;
  outdoorMinBrightness: number;
  interiorMinBrightness: number;
  baseCacheRefreshCount: number;
  invalidColorWriteCount: number;
  skyLightTimeMultiplier: number;
  skyTimeMultFloor: number;
  // Transaction debug.
  lastTransactionReason: string;
  lastTransactionAffectedChunks: number;
  lastTransactionRecomputedChunks: number;
  lastTransactionRecoloredMeshes: number;
  lastTransactionDurationMs: number;
  transactionsThisSecond: number;
  // Versioning diagnostics.
  registeredVoxelSources: number;
  staleMeshCount: number;
}

/**
 * Resolve a block definition to whether it's opaque (blocks sky light) and
 * whether it emits voxel light (and what color/level).
 */
export interface BlockLightResolver {
  isOpaque(blockId: number): boolean;
  /** Returns the voxel light emission {level, r, g, b} or null if not a light source. */
  getEmission(blockId: number): { level: number; r: number; g: number; b: number } | null;
  /** Whether a block is air (transparent, no collision). */
  isAir(blockId: number): boolean;
}

/** Result of sampling light at a world cell. */
export interface SampledLight {
  sky: number;
  r: number;
  g: number;
  b: number;
  /** True if the chunk holding this cell has computed light data. False = missing
   *  data (chunk not loaded yet), which is distinct from valid darkness (all 0). */
  hasChunkData: boolean;
}

/** Additive light decomposition at a surface vertex. */
export interface AdditiveLighting {
  /** Sky contribution (white-ish, INCLUDES skyLightTimeMultiplier). Multiplies base. */
  skyR: number;
  skyG: number;
  skyB: number;
  /** Block contribution (colored, does NOT use time multiplier — torches work at midnight). Added to base. */
  blockR: number;
  blockG: number;
  blockB: number;
  /** Ambient floor scalar (outdoor/interior). Ensures unlit terrain still shows. */
  ambientFloor: number;
  /** True if any sampled cell had chunk data. */
  hasData: boolean;
  /** Debug: raw sky light level 0..1 before time multiplier. */
  rawSkyLevel?: number;
  /** Debug: applied time multiplier. */
  skyLightTimeMultiplier?: number;
  /** Debug: final visual sky after floor + time mult. */
  visualSky?: number;
  /** Debug: visual sky floor used. */
  visualSkyFloor?: number;
  /** Debug: block light intensity 0..1. */
  blockIntensity?: number;
  /** Debug: block tint strength multiplier. */
  blockTintStrength?: number;
}

/** Return type for relightAround — debug info for the adapter. */
export interface RelightResult {
  /** Chunk keys whose light data was recomputed. */
  recomputedChunks: string[];
  /** Chunk keys whose visible meshes were recolored. */
  recoloredChunks: string[];
  recoloredMeshCount: number;
  durationMs: number;
}

/** Return type for processRelightQueue — chunk coords that were processed. */
export interface RelightQueueResult {
  processedChunks: string[];
  count: number;
}

export class VoxelLightManager {
  /** chunk key "x,y,z" (world chunk coords) → light data. */
  private chunkLight: Map<string, ChunkLightData> = new Map();
  /** Global registry of voxel light sources (placed torches, lamps, beacons).
   *  Keyed by world-cell "x,y,z". Used to seed cross-chunk light propagation:
   *  when a chunk is recomputed, any source within MAX_LIGHT_RADIUS in a
   *  neighbor chunk contributes its seed so light correctly crosses edges. */
  private voxelLightSources: Map<string, VoxelLightSource> = new Map();
  /** Relight queue: positions that need a local flood-fill. Capped to prevent runaway. */
  private relightQueue: Array<{ x: number; y: number; z: number; radius: number }> = [];
  /** Set of chunk keys currently in the queue (dedup). */
  private relightQueueSet: Set<string> = new Set();
  /** Cross-chunk edge propagation queue. */
  private edgeQueue: Array<{ chunkKey: string; fromDir: number }> = [];
  /** Hard cap on the relight queue to prevent runaway cascades. */
  private readonly MAX_RELIGHT_QUEUE = 64;
  /** Block lookup helper. */
  private resolver: BlockLightResolver;
  /** World block lookup (proxied to WorldService). */
  private getBlockAt: (x: number, y: number, z: number) => number;
  /** Config. */
  private skyLightEnabled = true;
  private blockLightEnabled = true;
  private skyLightBrightness = 1.0;
  private blockLightBrightness = 1.0;
  private minBrightness = 0.06;
  /** Safe brightness floors — prevent pure black in normal gameplay. */
  private outdoorMinBrightness = 0.65;
  private interiorMinBrightness = 0.08;
  private fullDarkMinBrightness = 0.02;
  /** Time-of-day sky light multiplier (0 = night, 1 = noon). Set by adapter.
   *  CRITICAL: only skyLight uses this. blockLight MUST NOT — torches illuminate at midnight.
   *  FLOORED at 0.65 in performance_voxel mode: terrain vertex colors are BAKED
   *  and not recolored every time the time-of-day changes. If we let this go to
   *  0 at midnight, all baked terrain becomes black (because the sky contribution
   *  in the vertex color is 0). The floor keeps terrain readable at all times.
   *  Day/night atmosphere is communicated through sky color, fog, sun/moon
   *  visibility — NOT through darkening baked terrain to black. */
  private skyLightTimeMultiplier = 1.0;
  private readonly SKY_TIME_MULT_FLOOR = 0.65;
  /** Perf counters. */
  private floodFillOpsLastUpdate = 0;
  private lastLightUpdateMs = 0;
  private meshRebuildTimestamps: number[] = [];
  private missingLightDataFallbackCount = 0;
  private lastRecoloredMeshCount = 0;
  private baseCacheRefreshCount = 0;
  private invalidColorWriteCount = 0;
  // Transaction debug fields.
  private lastTransactionReason: string = "";
  private lastTransactionAffectedChunks: number = 0;
  private lastTransactionRecomputedChunks: number = 0;
  private lastTransactionRecoloredMeshes: number = 0;
  private lastTransactionDurationMs: number = 0;
  private transactionsThisSecond: number = 0;
  private lastAffectedChunkKeys: string[] = [];
  private lightingMode: "performance_voxel" | "debug_real_lights" | "experimental_pretty" =
    "performance_voxel";
  private disposed = false;

  constructor(
    resolver: BlockLightResolver,
    getBlockAt: (x: number, y: number, z: number) => number
  ) {
    this.resolver = resolver;
    this.getBlockAt = getBlockAt;
    console.log("[VoxelLightManager] Online. Performance voxel lighting mode (Minecraft-style, additive tint).");
  }

  // ---- Chunk light data lifecycle ------------------------------------------

  private chunkKey(cx: number, cy: number, cz: number): string {
    return `${cx},${cy},${cz}`;
  }

  private cellKey(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  /** Get or create light data for a chunk (by chunk coords). */
  public getOrCreateChunkLight(cx: number, cy: number, cz: number): ChunkLightData {
    const key = this.chunkKey(cx, cy, cz);
    let data = this.chunkLight.get(key);
    if (!data) {
      data = {
        skyLight: new Uint8Array(CELLS_PER_CHUNK),
        blockLightR: new Uint8Array(CELLS_PER_CHUNK),
        blockLightG: new Uint8Array(CELLS_PER_CHUNK),
        blockLightB: new Uint8Array(CELLS_PER_CHUNK),
        dirty: true,
        lightDataVersion: 1,
      };
      this.chunkLight.set(key, data);
    }
    return data;
  }

  public getChunkLight(cx: number, cy: number, cz: number): ChunkLightData | undefined {
    return this.chunkLight.get(this.chunkKey(cx, cy, cz));
  }

  // ---- Voxel light source registry (cross-chunk seeding) -------------------

  /**
   * Register a voxel light source at a world cell. Adds to the global registry
   * so that when ANY nearby chunk is recomputed, this source contributes its
   * seed (fixing incomplete cross-chunk propagation — previously neighbor
   * chunks only seeded their own internal sources, not boundary light from
   * adjacent chunks). Idempotent — re-registering refreshes the emission.
   *
   * The BlockDefinition's LightProfile (color + intensity + range) is
   * converted to the VoxelLightSource {level, r, g, b} shape using the same
   * mapping as the BlockLightResolver.getEmission in NoaEngineAdapter:
   *   level = round(intensity * 7) clamped to 1..15
   *   r,g,b = light.color || blockDef.color || [1,1,1]
   */
  public registerLight(
    x: number,
    y: number,
    z: number,
    blockDef: BlockDefinition | undefined
  ): void {
    if (!blockDef || !blockDef.light) return;
    const isLight =
      (blockDef.tags && blockDef.tags.includes("light_source")) ||
      !!blockDef.light;
    if (!isLight) return;
    const level = Math.max(1, Math.min(15, Math.round((blockDef.light.intensity ?? 1) * 7)));
    const col = blockDef.light.color || blockDef.color || [1, 1, 1];
    const r = col[0], g = col[1], b = col[2];
    this.voxelLightSources.set(this.cellKey(x, y, z), { x, y, z, level, r, g, b });
  }

  /** Unregister a voxel light source (block destroyed). */
  public unregisterLight(x: number, y: number, z: number): void {
    this.voxelLightSources.delete(this.cellKey(x, y, z));
  }

  /** Query all registered voxel sources within radius of a world cell. */
  private sourcesNearby(
    worldX: number,
    worldY: number,
    worldZ: number,
    radius: number
  ): VoxelLightSource[] {
    const out: VoxelLightSource[] = [];
    const r2 = radius * radius;
    for (const src of this.voxelLightSources.values()) {
      const dx = src.x - worldX;
      const dy = src.y - worldY;
      const dz = src.z - worldZ;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(src);
    }
    return out;
  }

  /**
   * Compute initial light data for a freshly-generated chunk. Called from the
   * noa worldDataNeeded handler after voxel IDs are filled. This does:
   *   1. skyLight: column scan — 15 above the topmost opaque block, 0 below.
   *   2. blockLight: seed each light-source cell in this chunk + seed any
   *      registered voxel source in neighbor chunks within MAX_LIGHT_RADIUS,
   *      then BFS-flood within the chunk.
   *
   * World coords (x,y,z) are the chunk origin. extent = CHUNK_SIZE.
   */
  public computeInitialLight(
    originX: number,
    originY: number,
    originZ: number,
    voxelIds: Uint16Array | Int16Array,
    allowCrossChunkQueue: boolean = true
  ): ChunkLightData {
    const cx = Math.floor(originX / CHUNK_SIZE);
    const cy = Math.floor(originY / CHUNK_SIZE);
    const cz = Math.floor(originZ / CHUNK_SIZE);
    const data = this.getOrCreateChunkLight(cx, cy, cz);
    const start = performance.now();

    // ---- skyLight: per-column top-down scan with cross-chunk propagation ----
    // FIX: Previously every chunk started each column at MAX_LIGHT_LEVEL,
    // ignoring whether the chunk above had solid blocks. Now we check the
    // chunk above (cx, cy+1, cz) and use its bottom-row skyLight as the
    // incoming level. This prevents underground chunks from incorrectly
    // getting sky=15 when there's solid terrain above them.
    const chunkAbove = this.getChunkLight(cx, cy + 1, cz);
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        let level: number;
        if (chunkAbove) {
          // Read the bottom row (ly=0) of the chunk above.
          const aboveIdx = 0 * CHUNK_SIZE * CHUNK_SIZE + lx * CHUNK_SIZE + lz;
          level = chunkAbove.skyLight[aboveIdx];
        } else {
          // No chunk above: this is the topmost chunk. Start at full sky.
          level = MAX_LIGHT_LEVEL;
        }
        for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) {
          const idx = ly * CHUNK_SIZE * CHUNK_SIZE + lx * CHUNK_SIZE + lz;
          const blockId = voxelIds[idx];
          if (level === MAX_LIGHT_LEVEL && this.resolver.isOpaque(blockId)) {
            level = 0; // first opaque block from the top blocks sky light below it
          }
          data.skyLight[idx] = level;
        }
      }
    }

    // ---- blockLight: seed + BFS per channel ----
    data.blockLightR.fill(0);
    data.blockLightG.fill(0);
    data.blockLightB.fill(0);
    const seeds: Array<{ idx: number; level: number; r: number; g: number; b: number }> = [];
    // 1. Internal sources: cells in THIS chunk that emit light.
    for (let i = 0; i < CELLS_PER_CHUNK; i++) {
      const blockId = voxelIds[i];
      const emit = this.resolver.getEmission(blockId);
      if (emit && emit.level > 0) {
        seeds.push({ idx: i, level: emit.level, r: emit.r, g: emit.g, b: emit.b });
      }
    }
    // 2. Cross-chunk neighbor sources: any registered voxel source within
    //    MAX_LIGHT_RADIUS of this chunk's cells. These seed the BFS from
    //    outside the chunk so light correctly propagates IN across edges.
    //    (Previously only internal sources seeded — neighbor chunks never
    //     received boundary light from adjacent torches.)
    const chunkMinX = originX - MAX_LIGHT_RADIUS;
    const chunkMaxX = originX + CHUNK_SIZE + MAX_LIGHT_RADIUS;
    const chunkMinY = originY - MAX_LIGHT_RADIUS;
    const chunkMaxY = originY + CHUNK_SIZE + MAX_LIGHT_RADIUS;
    const chunkMinZ = originZ - MAX_LIGHT_RADIUS;
    const chunkMaxZ = originZ + CHUNK_SIZE + MAX_LIGHT_RADIUS;
    for (const src of this.voxelLightSources.values()) {
      if (src.x < chunkMinX || src.x >= chunkMaxX) continue;
      if (src.y < chunkMinY || src.y >= chunkMaxY) continue;
      if (src.z < chunkMinZ || src.z >= chunkMaxZ) continue;
      // Skip sources that are INSIDE this chunk — already seeded above by
      // the internal scan (avoids double-seeding with possibly-stale registry).
      const inChunk =
        src.x >= originX && src.x < originX + CHUNK_SIZE &&
        src.y >= originY && src.y < originY + CHUNK_SIZE &&
        src.z >= originZ && src.z < originZ + CHUNK_SIZE;
      if (inChunk) continue;
      // Convert the source's world position to a virtual in-chunk index.
      // The BFS will propagate from this seed; if the source is outside the
      // chunk, the BFS will walk light IN across the boundary (the source
      // cell itself is clamped to chunk-bounds for indexing).
      const lx = Math.max(0, Math.min(CHUNK_SIZE - 1, src.x - originX));
      const ly = Math.max(0, Math.min(CHUNK_SIZE - 1, src.y - originY));
      const lz = Math.max(0, Math.min(CHUNK_SIZE - 1, src.z - originZ));
      const idx = ly * CHUNK_SIZE * CHUNK_SIZE + lx * CHUNK_SIZE + lz;
      // Attenuate the seed by distance from the true source position so a
      // source just outside the chunk edge seeds at near-full strength but
      // one MAX_LIGHT_RADIUS away seeds dimmer.
      const dx = src.x - (originX + lx);
      const dy = src.y - (originY + ly);
      const dz = src.z - (originZ + lz);
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const atten = Math.max(0, 1 - dist / MAX_LIGHT_RADIUS);
      const attenuatedLevel = Math.round(src.level * atten);
      if (attenuatedLevel > 0) {
        seeds.push({ idx, level: attenuatedLevel, r: src.r, g: src.g, b: src.b });
      }
    }
    // BFS flood-fill each color channel independently (max-level tracking).
    this.floodFillBlockLight(data, seeds, originX, originY, originZ, allowCrossChunkQueue);

    data.dirty = false;
    data.lightDataVersion++;
    this.lastLightUpdateMs = performance.now() - start;
    this.floodFillOpsLastUpdate = seeds.length;
    return data;
  }

  /**
   * BFS flood-fill block light into a chunk from seed positions. Propagates
   * through non-opaque cells, decreasing level by 1 per step, until 0.
   * Also crosses into neighbor chunks at edges (queued for later processing).
   *
   * This is the Minecraft torch-light algorithm: each cell's light = max of
   * (neighbor light - 1) for each channel, seeded by emitters.
   */
  private floodFillBlockLight(
    data: ChunkLightData,
    seeds: Array<{ idx: number; level: number; r: number; g: number; b: number }>,
    originX: number,
    originY: number,
    originZ: number,
    allowCrossChunkQueue: boolean = true
  ): void {
    // Per-channel BFS. The flat index layout is: idx = y*256 + x*16 + z
    // (matching worldDataNeeded: flatVoxels[j * shape[0] * shape[2] + i * shape[2] + k]
    //  where i=x, j=y, k=z, shape=[16,16,16]).
    type QueueItem = { idx: number; level: number };
    const queueR: QueueItem[] = [];
    const queueG: QueueItem[] = [];
    const queueB: QueueItem[] = [];

    // Seed: per-channel level = round(level * color_component). Only push a
    // channel queue if that channel's level > 0. This prevents yellow
    // [1.0, 0.7, 0.2] from seeding full blue (which made everything white).
    for (const s of seeds) {
      const cellIdx = s.idx; // already in y*256+x*16+z layout
      const levelR = Math.round(s.level * s.r);
      const levelG = Math.round(s.level * s.g);
      const levelB = Math.round(s.level * s.b);
      if (levelR > 0) {
        if (levelR > data.blockLightR[cellIdx]) data.blockLightR[cellIdx] = levelR;
        queueR.push({ idx: cellIdx, level: levelR });
      }
      if (levelG > 0) {
        if (levelG > data.blockLightG[cellIdx]) data.blockLightG[cellIdx] = levelG;
        queueG.push({ idx: cellIdx, level: levelG });
      }
      if (levelB > 0) {
        if (levelB > data.blockLightB[cellIdx]) data.blockLightB[cellIdx] = levelB;
        queueB.push({ idx: cellIdx, level: levelB });
      }
    }

    // BFS per channel. Decrease level by 1 per step. Stop at 0 or opaque block.
    // NOTE: no shared `visited` array — each channel BFS uses level-max logic
    // only (stronger light always replaces weaker light). The old `visited`
    // array was a hard blocker that prevented a stronger light from replacing
    // a weaker one already marked visited.
    this.bfsChannel(data.blockLightR, queueR, originX, originY, originZ, allowCrossChunkQueue);
    this.bfsChannel(data.blockLightG, queueG, originX, originY, originZ, allowCrossChunkQueue);
    this.bfsChannel(data.blockLightB, queueB, originX, originY, originZ, allowCrossChunkQueue);
  }

  /**
   * Run a single-channel BFS. Mutates `levels` in place. Crosses chunk edges
   * by enqueuing neighbor-chunk relight requests when an edge cell gets light.
   *
   * FIX: removed the `visited` array. The old code did `if (visited[nIdx] & 1)
   * continue;` which permanently blocked a cell from receiving a STRONGER
   * light after it had been touched by a weaker one. Now we only check the
   * level: `if (nextLevel > levels[nIdx])` — stronger light always wins.
   */
  private bfsChannel(
    levels: Uint8Array,
    queue: Array<{ idx: number; level: number }>,
    originX: number,
    originY: number,
    originZ: number,
    allowCrossChunkQueue: boolean = true
  ): void {
    let ops = 0;
    const cx = Math.floor(originX / CHUNK_SIZE);
    const cy = Math.floor(originY / CHUNK_SIZE);
    const cz = Math.floor(originZ / CHUNK_SIZE);
    while (queue.length > 0 && ops < 20000) {
      const { idx, level } = queue.shift()!;
      ops++;
      if (level <= 1) continue; // next step would be 0
      const ly = Math.floor(idx / (CHUNK_SIZE * CHUNK_SIZE));
      const lx = Math.floor((idx % (CHUNK_SIZE * CHUNK_SIZE)) / CHUNK_SIZE);
      const lz = idx % CHUNK_SIZE;
      const nextLevel = level - 1;
      // 6 neighbors
      const neighbors = [
        [lx + 1, ly, lz], [lx - 1, ly, lz],
        [lx, ly + 1, lz], [lx, ly - 1, lz],
        [lx, ly, lz + 1], [lx, ly, lz - 1],
      ];
      for (const [nx, ny, nz] of neighbors) {
        // In-bounds?
        if (nx < 0 || nx >= CHUNK_SIZE || ny < 0 || ny >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE) {
          // Cross-chunk edge. Only queue neighbor relight if allowed.
          // When allowCrossChunkQueue=false (source-centric sync), we simply
          // stop — cross-chunk light is handled by recomputing all affected
          // chunks in the source radius AABB, each of which seeds from the
          // global voxelLightSources registry.
          if (allowCrossChunkQueue) {
            let ncx = cx, ncz = cz, ncy = cy;
            if (nx < 0) ncx = cx - 1; else if (nx >= CHUNK_SIZE) ncx = cx + 1;
            if (nz < 0) ncz = cz - 1; else if (nz >= CHUNK_SIZE) ncz = cz + 1;
            if (ny < 0) ncy = cy - 1; else if (ny >= CHUNK_SIZE) ncy = cy + 1;
            this.queueChunkRelight(ncx, ncy, ncz, MAX_LIGHT_RADIUS);
          }
          continue;
        }
        const nIdx = ny * CHUNK_SIZE * CHUNK_SIZE + nx * CHUNK_SIZE + nz;
        // Opaque blocks block light (but the source cell itself keeps its level).
        const worldBlockId = this.getBlockAt(
          originX + nx,
          originY + ny,
          originZ + nz
        );
        if (this.resolver.isOpaque(worldBlockId)) continue;
        // FIX: no `visited` check. Stronger light always replaces weaker light.
        if (nextLevel > levels[nIdx]) {
          levels[nIdx] = nextLevel;
          queue.push({ idx: nIdx, level: nextLevel });
        }
      }
    }
  }

  /**
   * Queue a chunk for relight (recompute from scratch). Used for cross-chunk
   * edge propagation and forced rebuilds. Deduped + capped to prevent the
   * runaway cascade where every edge crossing enqueues neighbors, which enqueue
   * THEIR neighbors, etc.
   */
  public queueChunkRelight(cx: number, cy: number, cz: number, _radius: number): void {
    if (this.relightQueue.length >= this.MAX_RELIGHT_QUEUE) return; // hard cap
    const key = this.chunkKey(cx, cy, cz);
    if (this.relightQueueSet.has(key)) return; // already queued
    this.relightQueueSet.add(key);
    this.relightQueue.push({ x: cx, y: cy, z: cz, radius: _radius });
  }

  /**
   * Local relight around a position (block placed/destroyed). Re-reads voxel
   * data for the chunk containing pos + queues neighbors within radius, and
   * recomputes their block light. Sky light is recomputed for the single
   * affected column.
   *
   * CRITICAL FIX: after recomputing light DATA, this now ALSO recolors the
   * affected visible chunk meshes immediately. Previously relightAround only
   * updated the data and hoped noa's remesh would pick it up — but noa only
   * remeshes chunks whose voxel IDS changed, not whose LIGHT changed, so the
   * visible mesh stayed stale. Now we recolor directly.
   *
   * @param scene Babylon scene (required to find visible chunk meshes).
   * @returns debug info: recomputed chunks, recolored chunks, mesh count, duration.
   */
  /**
   * SYNCHRONOUS LOCAL TRANSACTION: recompute light data for ALL affected chunks
   * (home + all neighbors within MAX_LIGHT_RADIUS, including diagonals), then
   * recolor all visible affected meshes. No queue, no delayed "click-click-click"
   * chunk waves. For player-near edits, correctness > spreading tiny work.
   */
  public relightAround(
    scene: any,
    x: number,
    y: number,
    z: number
  ): RelightResult {
    const start = performance.now();
    // Use AABB-based chunk selection: all chunks overlapping the sphere of
    // radius MAX_LIGHT_RADIUS around (x,y,z).
    const minCx = Math.floor((x - MAX_LIGHT_RADIUS) / CHUNK_SIZE);
    const maxCx = Math.floor((x + MAX_LIGHT_RADIUS) / CHUNK_SIZE);
    const minCy = Math.floor((y - MAX_LIGHT_RADIUS) / CHUNK_SIZE);
    const maxCy = Math.floor((y + MAX_LIGHT_RADIUS) / CHUNK_SIZE);
    const minCz = Math.floor((z - MAX_LIGHT_RADIUS) / CHUNK_SIZE);
    const maxCz = Math.floor((z + MAX_LIGHT_RADIUS) / CHUNK_SIZE);
    const recomputed: string[] = [];
    const affectedChunks: string[] = [];
    // FIX: process chunks TOP-DOWN by Y (maxCy to minCy) so that skyLight
    // propagation from the chunk above works correctly. Previously this
    // iterated bottom-up, which meant lower chunks were computed before
    // upper chunks — so they couldn't read sky data from above.
    for (let acy = maxCy; acy >= minCy; acy--) {
      for (let acx = minCx; acx <= maxCx; acx++) {
        for (let acz = minCz; acz <= maxCz; acz++) {
          const key = this.chunkKey(acx, acy, acz);
          affectedChunks.push(key);
          this.recomputeChunkLightFromWorld(acx, acy, acz, false);
          recomputed.push(key);
        }
      }
    }
    this.lastLightUpdateMs = performance.now() - start;
    this.lastTransactionReason = `block edit at ${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
    this.lastTransactionAffectedChunks = affectedChunks.length;
    this.lastTransactionRecomputedChunks = recomputed.length;
    this.lastAffectedChunkKeys = affectedChunks;
    this.transactionsThisSecond++;
    const recoloredMeshCount = scene
      ? this.recolorAffectedMeshes(scene, affectedChunks)
      : 0;
    this.lastTransactionRecoloredMeshes = recoloredMeshCount;
    this.lastTransactionDurationMs = performance.now() - start;

    return {
      recomputedChunks: recomputed,
      recoloredChunks: affectedChunks,
      recoloredMeshCount,
      durationMs: performance.now() - start,
    };
  }

  /**
   * Recompute a chunk's light by reading its voxels from the world. Used when
   * a block changed and we need to refresh the chunk's stored light arrays.
   *
   * FIX: computeInitialLight now also seeds from the global voxelLightSources
   * registry, so cross-chunk neighbor light sources correctly propagate INTO
   * this chunk during recompute.
   */
  private recomputeChunkLightFromWorld(cx: number, cy: number, cz: number, allowCrossChunkQueue: boolean = true): void {
    const originX = cx * CHUNK_SIZE;
    const originY = cy * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;
    const voxelIds = new Uint16Array(CELLS_PER_CHUNK);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const idx = ly * CHUNK_SIZE * CHUNK_SIZE + lx * CHUNK_SIZE + lz;
          voxelIds[idx] = this.getBlockAt(originX + lx, originY + ly, originZ + lz);
        }
      }
    }
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const idx = ly * CHUNK_SIZE * CHUNK_SIZE + lx * CHUNK_SIZE + lz;
          const blockId = voxelIds[idx];
          if (blockId === 0) continue;
          const emit = this.resolver.getEmission(blockId);
          if (emit && emit.level > 0) {
            const wx = originX + lx, wy = originY + ly, wz = originZ + lz;
            const key = `${wx},${wy},${wz}`;
            if (!this.voxelLightSources.has(key)) {
              this.voxelLightSources.set(key, { x: wx, y: wy, z: wz, level: emit.level, r: emit.r, g: emit.g, b: emit.b });
            }
          }
        }
      }
    }
    this.computeInitialLight(originX, originY, originZ, voxelIds, allowCrossChunkQueue);
  }

  /** Public wrapper for source-centric recompute without cross-chunk queue. */
  public recomputeChunkNoQueue(cx: number, cy: number, cz: number): void {
    this.recomputeChunkLightFromWorld(cx, cy, cz, false);
  }

  /**
   * Scan a flat voxel array for light-emitting blocks and register them into
   * the global voxelLightSources registry. Called from the noa worldDataNeeded
   * handler right after computeInitialLight, so newly loaded chunks register
   * their static/procedural sources immediately. This is critical for
   * cross-chunk propagation: neighbor chunks that load later need to know
   * about light sources across their boundaries.
   */
  public registerSourcesFromVoxels(
    originX: number,
    originY: number,
    originZ: number,
    voxelIds: Uint16Array
  ): Array<{ x: number; y: number; z: number }> {
    const newSources: Array<{ x: number; y: number; z: number }> = [];
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const idx = ly * CHUNK_SIZE * CHUNK_SIZE + lx * CHUNK_SIZE + lz;
          const blockId = voxelIds[idx];
          if (blockId === 0) continue;
          const emit = this.resolver.getEmission(blockId);
          if (emit && emit.level > 0) {
            const wx = originX + lx, wy = originY + ly, wz = originZ + lz;
            const key = `${wx},${wy},${wz}`;
            if (!this.voxelLightSources.has(key)) {
              this.voxelLightSources.set(key, { x: wx, y: wy, z: wz, level: emit.level, r: emit.r, g: emit.g, b: emit.b });
              newSources.push({ x: wx, y: wy, z: wz });
            }
          }
        }
      }
    }
    return newSources;
  }

  /**
   * Process the relight queue. Called from the tick handler a few items per
   * tick to spread cost.
   *
   * FIX: returns the list of processed chunk COORDS (as "x,y,z" keys) so the
   * adapter can recolor the corresponding visible meshes immediately. The old
   * return was just a count — the adapter had no way to know WHICH chunks to
   * recolor, so processed chunks stayed visually stale.
   */
  public processRelightQueue(maxPerTick: number = 2): RelightQueueResult {
    const processedChunks: string[] = [];
    if (this.disposed || this.relightQueue.length === 0) {
      return { processedChunks, count: 0 };
    }
    let processed = 0;
    while (processed < maxPerTick && this.relightQueue.length > 0) {
      const item = this.relightQueue.shift()!;
      const key = this.chunkKey(item.x, item.y, item.z);
      this.relightQueueSet.delete(key);
      this.recomputeChunkLightFromWorld(item.x, item.y, item.z, false);
      processedChunks.push(key);
      processed++;
    }
    return { processedChunks, count: processed };
  }

  // ---- Brightness lookup (for mesh recoloring) -----------------------------

  /**
   * Sample light level at a world-space cell. Returns {sky, r, g, b, hasChunkData}
   * each 0-15. Handles cross-chunk lookups + negative coords.
   *
   * FIX: now returns hasChunkData so callers can distinguish missing data
   * (chunk not loaded — use safe fallback) from valid darkness (all 0 — real
   * underground/cave darkness).
   */
  private sampleLight(worldX: number, worldY: number, worldZ: number): SampledLight {
    const fx = Math.floor(worldX);
    const fy = Math.floor(worldY);
    const fz = Math.floor(worldZ);
    const cx = Math.floor(fx / CHUNK_SIZE);
    const cy = Math.floor(fy / CHUNK_SIZE);
    const cz = Math.floor(fz / CHUNK_SIZE);
    const data = this.getChunkLight(cx, cy, cz);
    if (!data) return { sky: 0, r: 0, g: 0, b: 0, hasChunkData: false };
    const lx = fx - cx * CHUNK_SIZE;
    const ly = fy - cy * CHUNK_SIZE;
    const lz = fz - cz * CHUNK_SIZE;
    const idx = ly * CHUNK_SIZE * CHUNK_SIZE + lx * CHUNK_SIZE + lz;
    return {
      sky: data.skyLight[idx],
      r: data.blockLightR[idx],
      g: data.blockLightG[idx],
      b: data.blockLightB[idx],
      hasChunkData: true,
    };
  }

  /**
   * Compute the additive light decomposition at a surface vertex. Samples the
   * cell + 6 neighbors, takes the MAX per channel (light data lives in AIR
   * cells; terrain mesh vertices are on SOLID faces, so we must sample the
   * adjacent air cells to receive the light).
   *
   * Returns the SKY part (white-ish, includes time multiplier — multiplies
   * the base color) and the BLOCK part (colored, NO time multiplier — torches
   * work at midnight) SEPARATELY so recolorMesh can do:
   *   newColor = max(base * ambientFloor, base * skyPart + blockPart)
   *
   * This is the additive/tint model that fixes "cyan × red = black" — colored
   * block light now ADDS its tint on top of the sky-lit base instead of
   * multiplying to near-black.
   */
  private computeAdditiveLighting(
    worldX: number,
    worldY: number,
    worldZ: number
  ): AdditiveLighting {
    // Sample the cell + 6 neighbors, take max per channel. This is the surface
    // sampling fix: light data lives in AIR cells, terrain mesh vertices are on
    // SOLID faces. Sampling only the solid cell returns skyLight=0 + blockLight=0.
    // By sampling 6 neighbors, a solid face adjacent to lit air receives light.
    let maxSky = 0, maxR = 0, maxG = 0, maxB = 0;
    let foundAnyData = false;
    const samples = [
      [worldX, worldY, worldZ],
      [worldX + 1, worldY, worldZ], [worldX - 1, worldY, worldZ],
      [worldX, worldY + 1, worldZ], [worldX, worldY - 1, worldZ],
      [worldX, worldY, worldZ + 1], [worldX, worldY, worldZ - 1],
    ];
    for (const [sx, sy, sz] of samples) {
      const s = this.sampleLight(sx, sy, sz);
      if (s.hasChunkData) foundAnyData = true;
      if (s.sky > maxSky) maxSky = s.sky;
      if (s.r > maxR) maxR = s.r;
      if (s.g > maxG) maxG = s.g;
      if (s.b > maxB) maxB = s.b;
    }

    // If no chunk data was found in any neighbor, return a SAFE fallback.
    if (!foundAnyData) {
      return {
        skyR: 1, skyG: 1, skyB: 1, // sky = 1 (let Babylon lights handle brightness)
        blockR: 0, blockG: 0, blockB: 0,
        ambientFloor: this.outdoorMinBrightness,
        hasData: false,
      };
    }

    // ---- CLASSIC VOXEL LIGHTING FORMULA ----
    // SkyLight: actual per-cell sky light (0-15) × time-of-day multiplier.
    //   This gives correct day/night: day = full sky, night = dark sky.
    //   Newly loaded surface chunks get skyLight=15 (open sky), so they're
    //   bright at day. Underground chunks get skyLight=0, so they're dark
    //   unless block lights illuminate them.
    // BlockLight: RGB per-cell, additive on top of sky. Colored tint.
    //
    // Formula: finalRGB = baseRGB * skyPart + blockTint
    //   skyPart = (skyLight / 15) * timeMult
    //   blockTint = normalizedBlockRGB * (maxBlockChan / 15) * blockTintStrength
    //
    // A minimum ambient floor prevents completely black terrain so the game
    // is always playable, but it's LOW (0.08) so night/underground is dark.

    const timeMult = this.skyLightEnabled ? this.skyLightTimeMultiplier : 1.0;
    const rawSkyLevel = maxSky / MAX_LIGHT_LEVEL; // 0..1
    const skyPart = rawSkyLevel * timeMult;

    // Ambient floor: a small minimum so terrain is never pure black.
    // Outdoor (sky>0) gets a slightly higher floor; underground gets lower.
    const ambientFloor = maxSky > 0 ? this.outdoorMinBrightness : this.interiorMinBrightness;

    const skyR = Math.max(ambientFloor, skyPart);
    const skyG = Math.max(ambientFloor, skyPart);
    const skyB = Math.max(ambientFloor, skyPart);

    // ---- BLOCK part (colored lamp light, ADDITIVE on top of sky) ----
    const maxChan = Math.max(maxR, maxG, maxB);
    let blockPartR = 0, blockPartG = 0, blockPartB = 0;
    if (maxChan > 0 && this.blockLightEnabled) {
      const bcR = maxR / maxChan;
      const bcG = maxG / maxChan;
      const bcB = maxB / maxChan;
      const blockIntensity = maxChan / MAX_LIGHT_LEVEL;
      const blockTintStrength = this.blockLightBrightness;
      const strength = blockIntensity * blockTintStrength;
      blockPartR = bcR * strength;
      blockPartG = bcG * strength;
      blockPartB = bcB * strength;
    }

    return {
      skyR, skyG, skyB,
      blockR: blockPartR, blockG: blockPartG, blockB: blockPartB,
      ambientFloor,
      hasData: true,
      // Debug values exposed for F3 panel
      rawSkyLevel: maxSky / MAX_LIGHT_LEVEL,
      skyLightTimeMultiplier: timeMult,
      visualSky: skyPart,
      visualSkyFloor: ambientFloor,
      blockIntensity: maxChan > 0 ? maxChan / MAX_LIGHT_LEVEL : 0,
      blockTintStrength: this.blockLightBrightness,
    };
  }

  /**
   * SURFACE brightness as a single RGB triplet (for debug / backward compat).
   *
   * Computes: final = max(ambientFloor, skyPart + blockPart), clamped 0..1.
   * NOTE: this does NOT include the per-vertex base color (matColor × AO) —
   * that is applied in recolorMesh via `base * skyPart + blockPart`. This
   * function returns the raw light contribution for debug display.
   */
  public brightnessAtSurface(worldX: number, worldY: number, worldZ: number): [number, number, number] {
    const add = this.computeAdditiveLighting(worldX, worldY, worldZ);
    // final = max(ambientFloor, skyPart + blockPart), clamped 0..1.
    const r = Math.max(add.ambientFloor, add.skyR + add.blockR);
    const g = Math.max(add.ambientFloor, add.skyG + add.blockG);
    const b = Math.max(add.ambientFloor, add.skyB + add.blockB);
    return [clamp01(r), clamp01(g), clamp01(b)];
  }

  /** Backward-compat alias. */
  public brightnessAt(worldX: number, worldY: number, worldZ: number): [number, number, number] {
    return this.brightnessAtSurface(worldX, worldY, worldZ);
  }

  /**
   * Recolor a chunk mesh's vertices based on light data. NON-DESTRUCTIVE:
   * caches the mesh's base vertex colors (matColor × AO from noa's mesher) on
   * first call, then ALWAYS computes from the cached base — never from the
   * already-lighted current colors. This prevents the exponential darkening
   * bug where repeated recolors (from walking/relight/placing lights) multiply
   * already-darkened colors again: 0.6 × 0.6 × 0.6 → black.
   *
   * ADDITIVE/TINT MODEL (FIX):
   *   newColor = max(base * ambientFloor, base * skyPart + blockPart)
   *
   * - skyPart (white-ish, includes time-of-day multiplier) MULTIPLIES the base
   *   color → sunlight correctly tints terrain dimmer at night.
   * - blockPart (colored, NO time multiplier) is ADDED on top → a cyan torch
   *   on red dust ADDS cyan tint (base*0 + cyan) instead of multiplying to
   *   black (red * cyan = 0).
   * - ambientFloor ensures even unlit terrain shows its base color dimly
   *   (base * 0.08) so caves aren't pure black.
   *
   * Also bumps mesh.metadata.meshLightVersion to match the chunk's current
   * lightDataVersion so getStaleLightMeshCount reports accurate staleness.
   *
   * Called from the `addingTerrainMesh` hook (first recolor) and from
   * recolorAffectedMeshes / recolorAllVisibleChunkMeshes (subsequent recolors
   * after relight).
   */
  public recolorMesh(
    mesh: any,
    chunkOriginX: number,
    chunkOriginY: number,
    chunkOriginZ: number
  ): void {
    try {
      const positions = mesh.getVerticesData ? mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind) : null;
      if (!positions) return;
      if (!mesh.metadata) mesh.metadata = {};

      const currentVertCount = positions.length / 3;
      const currentColors = mesh.getVerticesData ? mesh.getVerticesData(BABYLON.VertexBuffer.ColorKind) : null;
      if (!currentColors) return;
      const currentColorLen = currentColors.length;

      // ---- STALE BASE CACHE DETECTION ----
      // When noa remeshes a chunk (after block place/break), the mesh gets NEW
      // geometry + NEW base colors from the mesher. But mesh.metadata.fpBaseVertexColors
      // still points to the OLD color buffer. Using stale base colors on new
      // geometry causes index mismatches → undefined → NaN → black clusters.
      // Fix: validate cache against current geometry before using it.
      let baseColors: Float32Array | null = mesh.metadata.fpBaseVertexColors ?? null;
      const cachedVertCount = mesh.metadata.fpBaseVertexCount ?? 0;
      const cachedColorLen = mesh.metadata.fpBaseColorLength ?? 0;
      let cacheRefreshed = false;
      let cacheInvalidationReason = "";

      if (baseColors) {
        // Validate cache: vertex count + color length + mesh uniqueId must match.
        // uniqueId changes when noa creates a NEW mesh (after remesh). If the
        // same mesh object is reused with updated buffers, vertex count check
        // catches that. If a new mesh object replaces the old one, uniqueId
        // catches that.
        const cachedMeshId = mesh.metadata.fpBaseMeshUniqueId ?? -1;
        const currentMeshId = mesh.uniqueId ?? -2;
        if (cachedVertCount !== currentVertCount || cachedColorLen !== currentColorLen || cachedMeshId !== currentMeshId) {
          cacheInvalidationReason = `vertCount ${cachedVertCount}→${currentVertCount} colorLen ${cachedColorLen}→${currentColorLen} meshId ${cachedMeshId}→${currentMeshId}`;
          baseColors = null; // discard stale cache
        }
      }

      if (!baseColors) {
        // Capture FRESH base colors from current mesh color buffer.
        baseColors = new Float32Array(currentColors);
        mesh.metadata.fpBaseVertexColors = baseColors;
        mesh.metadata.fpBaseVertexCount = currentVertCount;
        mesh.metadata.fpBaseColorLength = currentColorLen;
        mesh.metadata.fpBaseMeshUniqueId = mesh.uniqueId ?? -1;
        if (cacheInvalidationReason) {
          this.baseCacheRefreshCount++;
          cacheRefreshed = true;
        }
      }

      const numVerts = Math.min(currentVertCount, baseColors.length / 4);
      const newColors = new Float32Array(baseColors.length);
      let missingDataFallback = false;
      let invalidColorWrite = false;
      let unchangedNoLightVertices = 0;
      let blockLitVertices = 0;
      let maxBlockTint = 0;

      for (let v = 0; v < numVerts; v++) {
        const wx = positions[v * 3] + chunkOriginX;
        const wy = positions[v * 3 + 1] + chunkOriginY;
        const wz = positions[v * 3 + 2] + chunkOriginZ;

        const baseR = baseColors[v * 4];
        const baseG = baseColors[v * 4 + 1];
        const baseB = baseColors[v * 4 + 2];

        // NaN validation: if any base color is invalid, use safe fallback.
        if (isNaN(baseR) || isNaN(baseG) || isNaN(baseB) || baseR === undefined || baseG === undefined || baseB === undefined) {
          newColors[v * 4] = 0.5;
          newColors[v * 4 + 1] = 0.0;
          newColors[v * 4 + 2] = 0.5; // magenta debug
          newColors[v * 4 + 3] = 1;
          invalidColorWrite = true;
          continue;
        }

        // ---- BLOCK-LIGHT-ONLY ADDITIVE TINT ----
        // The global lighting (sun/moon/ambient from SkyController + Babylon
        // scene lights) already works correctly via noa's material system.
        // VoxelLightManager must ONLY add local block-light tint on top of
        // the original base color. It must NOT darken, brighten, or otherwise
        // modify vertices that have no nearby block light.
        //
        // Formula: finalColor = clamp01(baseColor + blockTint)
        //   blockTint = normalizedBlockRGB * blockIntensity * blockTintStrength
        //
        // If blockLight = 0: finalColor = baseColor (unchanged).
        // If blockLight > 0: finalColor = baseColor + colored tint.

        let blockTintR = 0, blockTintG = 0, blockTintB = 0;
        try {
          const add = this.computeAdditiveLighting(wx, wy, wz);
          if (!add.hasData) missingDataFallback = true;
          blockTintR = add.blockR;
          blockTintG = add.blockG;
          blockTintB = add.blockB;
        } catch {
          missingDataFallback = true;
        }

        // If no block light, write base color unchanged.
        if (blockTintR === 0 && blockTintG === 0 && blockTintB === 0) {
          newColors[v * 4] = baseR;
          newColors[v * 4 + 1] = baseG;
          newColors[v * 4 + 2] = baseB;
          newColors[v * 4 + 3] = baseColors[v * 4 + 3] ?? 1;
          unchangedNoLightVertices++;
          continue;
        }

        // Additive block light tint on top of base color.
        let fr = clamp01(baseR + blockTintR);
        let fg = clamp01(baseG + blockTintG);
        let fb = clamp01(baseB + blockTintB);

        // Final NaN check on output.
        if (isNaN(fr)) fr = baseR;
        if (isNaN(fg)) fg = baseG;
        if (isNaN(fb)) fb = baseB;

        newColors[v * 4] = fr;
        newColors[v * 4 + 1] = fg;
        newColors[v * 4 + 2] = fb;
        newColors[v * 4 + 3] = baseColors[v * 4 + 3] ?? 1; // alpha
        blockLitVertices++;
        if (blockTintR > maxBlockTint) maxBlockTint = blockTintR;
        if (blockTintG > maxBlockTint) maxBlockTint = blockTintG;
        if (blockTintB > maxBlockTint) maxBlockTint = blockTintB;
      }

      mesh.setVerticesData(BABYLON.VertexBuffer.ColorKind, newColors, false, 4);
      mesh.metadata.fpLastRecolorTime = performance.now();
      mesh.metadata.fpCacheRefreshed = cacheRefreshed;
      mesh.metadata.fpCacheInvalidationReason = cacheInvalidationReason;
      mesh.metadata.fpUnchangedNoLightVertices = unchangedNoLightVertices;
      mesh.metadata.fpBlockLitVertices = blockLitVertices;
      mesh.metadata.fpMaxBlockTint = maxBlockTint;
      const cx = Math.floor(chunkOriginX / CHUNK_SIZE);
      const cy = Math.floor(chunkOriginY / CHUNK_SIZE);
      const cz = Math.floor(chunkOriginZ / CHUNK_SIZE);
      const chunkData = this.getChunkLight(cx, cy, cz);
      mesh.metadata.meshLightVersion = chunkData ? chunkData.lightDataVersion : 0;
      if (missingDataFallback) this.missingLightDataFallbackCount++;
      if (invalidColorWrite) this.invalidColorWriteCount++;
      this.meshRebuildTimestamps.push(performance.now());
      const oneSecondAgo = performance.now() - 1000;
      this.meshRebuildTimestamps = this.meshRebuildTimestamps.filter((t) => t > oneSecondAgo);
      this.lastRecoloredMeshCount++;
    } catch (e) {
      // Non-fatal — mesh may be mid-update.
    }
  }

  /**
   * Recolor ONLY the visible chunk meshes whose chunk coords match the given
   * list. Used by relightAround so we don't recolor the entire scene on every
   * block place/destroy — only the affected chunks.
   *
   * @param scene Babylon scene.
   * @param chunkKeys Array of "cx,cy,cz" chunk keys to recolor.
   * @returns number of meshes recolored.
   */
  public recolorAffectedMeshes(scene: any, chunkKeys: string[]): number {
    if (!scene || !scene.meshes || chunkKeys.length === 0) return 0;
    const wanted = new Set(chunkKeys);
    let count = 0;
    for (const mesh of scene.meshes) {
      if (!mesh.name || !mesh.name.startsWith || !mesh.name.startsWith("chunk_")) continue;
      if (!mesh.isEnabled()) continue;
      // FIX: use Math.round instead of Math.floor for negative coordinate safety.
      // noa sets mesh.position to the chunk's world-space origin (e.g. -16, -16),
      // but floating-point drift can make it -15.9999999. Math.floor(-15.9999) = -16
      // (correct), but Math.floor(-16.0000001) = -17 (wrong). Math.round handles
      // both cases correctly since chunk origins are always exact multiples of 16.
      const ox = mesh.position ? Math.round(mesh.position.x) : 0;
      const oy = mesh.position ? Math.round(mesh.position.y) : 0;
      const oz = mesh.position ? Math.round(mesh.position.z) : 0;
      const cx = Math.round(ox / CHUNK_SIZE);
      const cy = Math.round(oy / CHUNK_SIZE);
      const cz = Math.round(oz / CHUNK_SIZE);
      const key = `${cx},${cy},${cz}`;
      if (!wanted.has(key)) continue;
      this.recolorMesh(mesh, ox, oy, oz);
      count++;
    }
    this.lastRecoloredMeshCount = count;
    return count;
  }

  /**
   * Recolor ALL visible chunk meshes in the scene. Used after forceRelightAll()
   * and F3 test buttons so the lighting change is immediately visible without
   * waiting for noa to remesh. Iterates scene.meshes, filters chunk_ meshes,
   * and calls recolorMesh on each.
   */
  public recolorAllVisibleChunkMeshes(scene: any): number {
    let count = 0;
    if (!scene || !scene.meshes) return 0;
    for (const mesh of scene.meshes) {
      if (!mesh.name || !mesh.name.startsWith || !mesh.name.startsWith("chunk_")) continue;
      if (!mesh.isEnabled()) continue;
      const ox = mesh.position ? Math.round(mesh.position.x) : 0;
      const oy = mesh.position ? Math.round(mesh.position.y) : 0;
      const oz = mesh.position ? Math.round(mesh.position.z) : 0;
      this.recolorMesh(mesh, ox, oy, oz);
      count++;
    }
    this.lastRecoloredMeshCount = count;
    return count;
  }

  /**
   * Invalidate the base vertex color cache for all visible chunk meshes near
   * a world position. Called after noa.setBlock() remeshes a chunk — the
   * remeshed mesh gets NEW geometry + NEW base colors from noa's mesher, so
   * the OLD cached base colors are stale. This forces the next recolorMesh
   * call to capture fresh base colors.
   */
  public invalidateBaseCacheAround(scene: any, worldX: number, worldY: number, worldZ: number): number {
    if (!scene || !scene.meshes) return 0;
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cy = Math.floor(worldY / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    let count = 0;
    for (const mesh of scene.meshes) {
      if (!mesh.name || !mesh.name.startsWith || !mesh.name.startsWith("chunk_")) continue;
      if (!mesh.isEnabled()) continue;
      const mx = mesh.position ? Math.round(mesh.position.x / CHUNK_SIZE) : 0;
      const my = mesh.position ? Math.round(mesh.position.y / CHUNK_SIZE) : 0;
      const mz = mesh.position ? Math.round(mesh.position.z / CHUNK_SIZE) : 0;
      // Invalidate meshes in the home chunk + ±1 neighbors.
      if (Math.abs(mx - cx) <= 1 && Math.abs(my - cy) <= 1 && Math.abs(mz - cz) <= 1) {
        if (mesh.metadata && mesh.metadata.fpBaseVertexColors) {
          mesh.metadata.fpBaseVertexColors = null;
          mesh.metadata.fpBaseVertexCount = 0;
          mesh.metadata.fpBaseColorLength = 0;
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Count visible chunk meshes whose stored meshLightVersion is behind the
   * corresponding chunk's current lightDataVersion. Useful for the adapter to
   * know how many meshes need recoloring (e.g. after a global time-of-day
   * change or a relight pass).
   */
  public getStaleLightMeshCount(scene: any): number {
    if (!scene || !scene.meshes) return 0;
    let stale = 0;
    for (const mesh of scene.meshes) {
      if (!mesh.name || !mesh.name.startsWith || !mesh.name.startsWith("chunk_")) continue;
      if (!mesh.isEnabled()) continue;
      const ox = mesh.position ? Math.round(mesh.position.x) : 0;
      const oy = mesh.position ? Math.round(mesh.position.y) : 0;
      const oz = mesh.position ? Math.round(mesh.position.z) : 0;
      const cx = Math.floor(ox / CHUNK_SIZE);
      const cy = Math.floor(oy / CHUNK_SIZE);
      const cz = Math.floor(oz / CHUNK_SIZE);
      const chunkData = this.getChunkLight(cx, cy, cz);
      if (!chunkData) continue;
      const meshVersion = (mesh.metadata && mesh.metadata.meshLightVersion) ?? -1;
      if (chunkData.lightDataVersion > meshVersion) stale++;
    }
    return stale;
  }

  /**
   * RECOLOR STABILITY TEST: run recolorMesh 20 times on the same mesh and
   * verify the colors do NOT drift (non-destructive / idempotent). Catches the
   * exponential darkening bug. Returns before/after avg/min/max + pass/fail.
   */
  public recolorStabilityTest(scene: any): {
    meshName: string;
    vertexCount: number;
    hasVertexColors: boolean;
    hasCachedBaseColors: boolean;
    avgBefore: [number, number, number];
    avgAfter: [number, number, number];
    minBefore: [number, number, number];
    minAfter: [number, number, number];
    maxBefore: [number, number, number];
    maxAfter: [number, number, number];
    delta: number;
    pass: boolean;
  } {
    const empty: [number, number, number] = [0, 0, 0];
    const result = {
      meshName: "", vertexCount: 0, hasVertexColors: false, hasCachedBaseColors: false,
      avgBefore: [...empty] as [number, number, number],
      avgAfter: [...empty] as [number, number, number],
      minBefore: [...empty] as [number, number, number],
      minAfter: [...empty] as [number, number, number],
      maxBefore: [...empty] as [number, number, number],
      maxAfter: [...empty] as [number, number, number],
      delta: 0, pass: false,
    };
    if (!scene || !scene.meshes) return result;
    const mesh = scene.meshes.find((m: any) =>
      m.name && m.name.startsWith && m.name.startsWith("chunk_") && m.isEnabled() && m.getVerticesData
    );
    if (!mesh) return result;
    result.meshName = mesh.name;
    const stats = (cols: Float32Array | null) => {
      if (!cols) return { avg: [...empty] as [number, number, number], min: [1,1,1] as [number,number,number], max: [...empty] as [number, number, number] };
      const n = cols.length / 4;
      let sr=0,sg=0,sb=0, minR=1,minG=1,minB=1, maxR=0,maxG=0,maxB=0;
      for (let i = 0; i < n; i++) {
        const r = cols[i*4], g = cols[i*4+1], b = cols[i*4+2];
        sr+=r; sg+=g; sb+=b;
        if (r<minR)minR=r; if(g<minG)minG=g; if(b<minB)minB=b;
        if (r>maxR)maxR=r; if(g>maxG)maxG=g; if(b>maxB)maxB=b;
      }
      return {
        avg: [sr/n, sg/n, sb/n] as [number, number, number],
        min: [minR, minG, minB] as [number, number, number],
        max: [maxR, maxG, maxB] as [number, number, number],
      };
    };
    const posData = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    result.vertexCount = posData ? posData.length / 3 : 0;
    result.hasVertexColors = !!mesh.getVerticesData(BABYLON.VertexBuffer.ColorKind);
    result.hasCachedBaseColors = !!(mesh.metadata && mesh.metadata.fpBaseVertexColors);
    const ox = Math.round(mesh.position.x), oy = Math.round(mesh.position.y), oz = Math.round(mesh.position.z);
    // Run ONE recolor first to establish a baseline at current lighting conditions.
    // The "before" must be from a fresh recolor, not from stale prior-recolor colors
    // (which may have been set at a different time-of-day).
    this.recolorMesh(mesh, ox, oy, oz);
    const before = stats(mesh.getVerticesData(BABYLON.VertexBuffer.ColorKind));
    result.avgBefore = before.avg;
    result.minBefore = before.min;
    result.maxBefore = before.max;
    // Run 19 MORE recolors. If non-destructive (reads from cached base), result is identical.
    for (let i = 0; i < 19; i++) {
      this.recolorMesh(mesh, ox, oy, oz);
    }
    const after = stats(mesh.getVerticesData(BABYLON.VertexBuffer.ColorKind));
    result.avgAfter = after.avg;
    result.minAfter = after.min;
    result.maxAfter = after.max;
    result.delta = Math.abs(after.avg[0] - before.avg[0]) + Math.abs(after.avg[1] - before.avg[1]) + Math.abs(after.avg[2] - before.avg[2]);
    // Pass if delta is tiny (no darkening). Allow small float drift.
    result.pass = result.delta < 0.05;
    return result;
  }

  // ---- Config / tuning -----------------------------------------------------

  public setSkyLightEnabled(enabled: boolean): void {
    this.skyLightEnabled = enabled;
  }
  public setBlockLightEnabled(enabled: boolean): void {
    this.blockLightEnabled = enabled;
  }
  public setSkyLightBrightness(v: number): void {
    this.skyLightBrightness = Math.max(0, Math.min(2, v));
  }
  public setBlockLightBrightness(v: number): void {
    this.blockLightBrightness = Math.max(0, Math.min(2, v));
  }
  public setMinBrightness(v: number): void {
    this.minBrightness = Math.max(0, Math.min(0.5, v));
  }
  /** Time-of-day sky multiplier 0..1 (adapter calls this each frame).
   *  CRITICAL: only skyLight uses this. blockLight is independent so torches
   *  illuminate at midnight. */
  public setSkyLightTimeMultiplier(v: number): void {
    // FLOOR the multiplier so baked terrain never goes dark from time changes.
    // The floor keeps terrain readable at midnight. Day/night atmosphere is
    // communicated via sky color, fog, sun/moon — not via darkening terrain.
    this.skyLightTimeMultiplier = Math.max(this.SKY_TIME_MULT_FLOOR, Math.min(1, v));
  }
  public setLightingMode(mode: "performance_voxel" | "debug_real_lights" | "experimental_pretty"): void {
    this.lightingMode = mode;
  }

  /** Count light sources near a position (for debug). */
  public countLightSourcesNearby(worldX: number, worldY: number, worldZ: number, radius: number): {
    glowing: number;
    voxelSources: number;
  } {
    let glowing = 0;
    let voxelSources = 0;
    const r2 = radius * radius;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          const id = this.getBlockAt(worldX + dx, worldY + dy, worldZ + dz);
          const emit = this.resolver.getEmission(id);
          if (emit) {
            glowing++;
            if (emit.level > 0) voxelSources++;
          }
        }
      }
    }
    return { glowing, voxelSources };
  }

  /** Number of registered voxel light sources (global registry). */
  public getRegisteredSourceCount(): number {
    return this.voxelLightSources.size;
  }

  // ---- Debug ---------------------------------------------------------------

  public getDebugInfo(playerPos: VoxelPosition): VoxelLightDebugInfo {
    const [br, bg, bb] = this.brightnessAt(playerPos[0], playerPos[1], playerPos[2]);
    const sky = this.getChunkLight(
      Math.floor(playerPos[0] / CHUNK_SIZE),
      Math.floor(playerPos[1] / CHUNK_SIZE),
      Math.floor(playerPos[2] / CHUNK_SIZE)
    );
    let skyAtPlayer = 0;
    let blockAtPlayer: [number, number, number] = [0, 0, 0];
    if (sky) {
      const lx = Math.floor(playerPos[0]) - Math.floor(playerPos[0] / CHUNK_SIZE) * CHUNK_SIZE;
      const ly = Math.floor(playerPos[1]) - Math.floor(playerPos[1] / CHUNK_SIZE) * CHUNK_SIZE;
      const lz = Math.floor(playerPos[2]) - Math.floor(playerPos[2] / CHUNK_SIZE) * CHUNK_SIZE;
      const idx = ly * CHUNK_SIZE * CHUNK_SIZE + lx * CHUNK_SIZE + lz;
      skyAtPlayer = sky.skyLight[idx];
      blockAtPlayer = [sky.blockLightR[idx], sky.blockLightG[idx], sky.blockLightB[idx]];
    }
    const near = this.countLightSourcesNearby(playerPos[0], playerPos[1], playerPos[2], 16);
    return {
      lightingMode: this.lightingMode,
      skyLightEnabled: this.skyLightEnabled,
      blockLightEnabled: this.blockLightEnabled,
      chunksWithLightData: this.chunkLight.size,
      relightQueueSize: this.relightQueue.length,
      floodFillOpsLastUpdate: this.floodFillOpsLastUpdate,
      lastLightUpdateMs: Number(this.lastLightUpdateMs.toFixed(2)),
      meshRebuildCountLastSecond: this.meshRebuildTimestamps.length,
      skyLightAtPlayer: skyAtPlayer,
      blockLightAtPlayer: blockAtPlayer,
      combinedBrightnessAtPlayer: Number(((br + bg + bb) / 3).toFixed(3)),
      glowingBlocksNearby: near.glowing,
      voxelLightSourcesNearby: near.voxelSources,
      minBrightness: this.minBrightness,
      skyLightBrightness: this.skyLightBrightness,
      blockLightBrightness: this.blockLightBrightness,
      // Recolor pipeline diagnostics.
      missingLightDataFallbackCount: this.missingLightDataFallbackCount,
      recoloredMeshCountLastAction: this.lastRecoloredMeshCount,
      outdoorMinBrightness: this.outdoorMinBrightness,
      interiorMinBrightness: this.interiorMinBrightness,
      baseCacheRefreshCount: this.baseCacheRefreshCount,
      invalidColorWriteCount: this.invalidColorWriteCount,
      skyLightTimeMultiplier: Number(this.skyLightTimeMultiplier.toFixed(3)),
      skyTimeMultFloor: this.SKY_TIME_MULT_FLOOR,
      // Transaction debug.
      lastTransactionReason: this.lastTransactionReason,
      lastTransactionAffectedChunks: this.lastTransactionAffectedChunks,
      lastTransactionRecomputedChunks: this.lastTransactionRecomputedChunks,
      lastTransactionRecoloredMeshes: this.lastTransactionRecoloredMeshes,
      lastTransactionDurationMs: Number(this.lastTransactionDurationMs.toFixed(2)),
      transactionsThisSecond: this.transactionsThisSecond,
      // Versioning diagnostics.
      registeredVoxelSources: this.voxelLightSources.size,
      staleMeshCount: 0, // filled by adapter with scene-aware count
    };
  }

  /** Dispose all light data for a chunk (called on chunkBeingRemoved). */
  public disposeChunkLight(cx: number, cy: number, cz: number): void {
    this.chunkLight.delete(this.chunkKey(cx, cy, cz));
  }

  /**
   * Force a full relight of all known chunks (queues them — processed over
   * subsequent ticks via processRelightQueue). For an IMMEDIATE synchronous
   * relight + recolor, use forceRelightAllImmediate(scene) instead.
   */
  public forceRelightAll(): void {
    this.relightQueue = [];
    this.relightQueueSet.clear();
    for (const key of this.chunkLight.keys()) {
      const [cx, cy, cz] = key.split(",").map(Number);
      this.queueChunkRelight(cx, cy, cz, MAX_LIGHT_RADIUS);
    }
    console.log(`[VoxelLightManager] Force relight queued for ${this.chunkLight.size} chunks.`);
  }

  /**
   * Synchronous full relight: recompute ALL known chunk light data immediately
   * (not queued), THEN recolor all visible meshes. Used by debug buttons and
   * time-of-day jumps where waiting for the queue would leave the screen stale.
   *
   * @param scene Babylon scene (required for recoloring).
   * @returns debug info: recomputed chunk count, recolored mesh count, duration.
   */
  public forceRelightAllImmediate(scene: any): {
    recomputedChunks: number;
    recoloredMeshCount: number;
    durationMs: number;
  } {
    const start = performance.now();
    // Clear the queue — we're doing it all now.
    this.relightQueue = [];
    this.relightQueueSet.clear();
    let recomputed = 0;
    for (const key of this.chunkLight.keys()) {
      const [cx, cy, cz] = key.split(",").map(Number);
      this.recomputeChunkLightFromWorld(cx, cy, cz, false);
      recomputed++;
    }
    const recoloredMeshCount = scene ? this.recolorAllVisibleChunkMeshes(scene) : 0;
    const durationMs = performance.now() - start;
    console.log(
      `[VoxelLightManager] Force relight IMMEDIATE: recomputed ${recomputed} chunks, recolored ${recoloredMeshCount} meshes in ${durationMs.toFixed(1)}ms.`
    );
    return { recomputedChunks: recomputed, recoloredMeshCount, durationMs };
  }

  // ---- DEBUG TOOLS ----

  /**
   * Get the last affected chunk keys from the most recent relight transaction.
   */
  public getLastAffectedChunkKeys(): string[] {
    return this.lastAffectedChunkKeys;
  }

  /**
   * Get all chunk keys that currently have light data.
   */
  public getChunkKeysWithLightData(): string[] {
    return Array.from(this.chunkLight.keys());
  }

  /**
   * Get the relight queue chunk keys.
   */
  public getRelightQueueKeys(): string[] {
    return this.relightQueue.map(item => this.chunkKey(item.x, item.y, item.z));
  }

  /**
   * Inspect lighting state at a world position. Returns detailed debug info
   * about the voxel light at that position and its neighbors.
   */
  public inspectLightingAt(wx: number, wy: number, wz: number): any {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cy = Math.floor(wy / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const chunkKey = this.chunkKey(cx, cy, cz);
    const data = this.getChunkLight(cx, cy, cz);
    const lx = Math.floor(wx) - cx * CHUNK_SIZE;
    const ly = Math.floor(wy) - cy * CHUNK_SIZE;
    const lz = Math.floor(wz) - cz * CHUNK_SIZE;
    const idx = ly * CHUNK_SIZE * CHUNK_SIZE + lx * CHUNK_SIZE + lz;
    const neighbors: any[] = [];
    const offsets = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    for (const [dx,dy,dz] of offsets) {
      const nx = wx+dx, ny = wy+dy, nz = wz+dz;
      const ncx = Math.floor(nx/CHUNK_SIZE), ncy = Math.floor(ny/CHUNK_SIZE), ncz = Math.floor(nz/CHUNK_SIZE);
      const ndata = this.getChunkLight(ncx, ncy, ncz);
      const nlx = Math.floor(nx)-ncx*CHUNK_SIZE, nly = Math.floor(ny)-ncy*CHUNK_SIZE, nlz = Math.floor(nz)-ncz*CHUNK_SIZE;
      const nidx = nly*CHUNK_SIZE*CHUNK_SIZE+nlx*CHUNK_SIZE+nlz;
      neighbors.push({
        offset: [dx,dy,dz],
        worldPos: [nx,ny,nz],
        chunkKey: this.chunkKey(ncx,ncy,ncz),
        sky: ndata ? ndata.skyLight[nidx] : null,
        r: ndata ? ndata.blockLightR[nidx] : null,
        g: ndata ? ndata.blockLightG[nidx] : null,
        b: ndata ? ndata.blockLightB[nidx] : null,
        hasData: !!ndata,
      });
    }
    // Find nearest registered source
    let nearestSource: any = null;
    let nearestDist = Infinity;
    for (const src of this.voxelLightSources.values()) {
      const d = Math.sqrt((src.x-wx)**2 + (src.y-wy)**2 + (src.z-wz)**2);
      if (d < nearestDist) { nearestDist = d; nearestSource = src; }
    }
    const brightness = this.brightnessAtSurface(wx, wy, wz);
    return {
      worldPos: [wx, wy, wz],
      chunkKey,
      localCell: [lx, ly, lz],
      flatIndex: idx,
      hasLightData: !!data,
      skyLight: data ? data.skyLight[idx] : null,
      blockLightR: data ? data.blockLightR[idx] : null,
      blockLightG: data ? data.blockLightG[idx] : null,
      blockLightB: data ? data.blockLightB[idx] : null,
      neighbors,
      nearestSource: nearestSource ? { pos: [nearestSource.x, nearestSource.y, nearestSource.z], level: nearestSource.level, color: [nearestSource.r, nearestSource.g, nearestSource.b], distance: nearestDist } : null,
      brightnessAtSurface: brightness,
    };
  }

  /**
   * 3×3 Surface Light Test — the CORE acceptance test for voxel lighting.
   *
   * Evaluates the 9 cells (3×3 grid) around a light position, measuring their
   * brightness BEFORE placement, AFTER placement, and AFTER removal. A test
   * PASSES only if the SURROUNDING cells (not the source itself) become
   * measurably brighter after placement AND dimmer after removal.
   *
   * This is deliberately stricter than checking blockLightAtSource > 0 or
   * recoloredMeshCount > 0 — those can pass while the visible surface remains
   * dark. This test validates actual surface illumination.
   *
   * @param centerX  light source world X
   * @param centerY  light source world Y
   * @param centerZ  light source world Z
   * @param placeFn  callback to place the light block + register source
   * @param removeFn callback to remove the light block + unregister source
   * @returns SurfaceTestResult with per-cell deltas + PASS/FAIL/INCONCLUSIVE
   */
  public runSurface3x3Test(
    centerX: number,
    centerY: number,
    centerZ: number,
    placeFn: () => void,
    removeFn: () => void
  ): SurfaceTestResult {
    // The 9 cells: 3×3 grid on the Y plane just below the light (the floor
    // surface the light illuminates). We sample the cells at centerY-1 (the
    // floor) so we're measuring the surface the light hits, not the source
    // cell itself.
    const surfaceY = centerY - 1;
    const cells: Array<{ x: number; y: number; z: number }> = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        cells.push({ x: centerX + dx, y: surfaceY, z: centerZ + dz });
      }
    }

    // Also sample the 4 vertical neighbors (walls around the light at same Y).
    const wallOffsets = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]];
    for (const [dx, dy, dz] of wallOffsets) {
      cells.push({ x: centerX + dx, y: centerY, z: centerZ + dz });
    }

    const recordAll = (): Array<{
      worldPos: [number, number, number];
      blockId: number;
      chunkKey: string;
      localCell: [number, number, number];
      hasLightData: boolean;
      brightness: [number, number, number];
    }> => {
      return cells.map(c => {
        const cx = Math.floor(c.x / CHUNK_SIZE);
        const cy = Math.floor(c.y / CHUNK_SIZE);
        const cz = Math.floor(c.z / CHUNK_SIZE);
        const lx = Math.floor(c.x) - cx * CHUNK_SIZE;
        const ly = Math.floor(c.y) - cy * CHUNK_SIZE;
        const lz = Math.floor(c.z) - cz * CHUNK_SIZE;
        const data = this.getChunkLight(cx, cy, cz);
        const blockId = this.getBlockAt(c.x, c.y, c.z);
        const br = this.brightnessAtSurface(c.x, c.y, c.z);
        return {
          worldPos: [c.x, c.y, c.z] as [number, number, number],
          blockId,
          chunkKey: this.chunkKey(cx, cy, cz),
          localCell: [lx, ly, lz] as [number, number, number],
          hasLightData: !!data,
          brightness: [br[0], br[1], br[2]] as [number, number, number],
        };
      });
    };

    const before = recordAll();

    // Place the light
    placeFn();

    const after = recordAll();

    // Remove the light
    removeFn();

    const afterRemove = recordAll();

    // Compute deltas per cell
    const cellResults: SurfaceTestCellResult[] = before.map((b, i) => {
      const a = after[i];
      const ar = afterRemove[i];
      const dp: [number, number, number] = [
        a.brightness[0] - b.brightness[0],
        a.brightness[1] - b.brightness[1],
        a.brightness[2] - b.brightness[2],
      ];
      const dr: [number, number, number] = [
        ar.brightness[0] - a.brightness[0],
        ar.brightness[1] - a.brightness[1],
        ar.brightness[2] - a.brightness[2],
      ];
      const brightenedPlace = dp[0] > 0.01 || dp[1] > 0.01 || dp[2] > 0.01;
      const dimmedRemove = dr[0] < -0.01 || dr[1] < -0.01 || dr[2] < -0.01;
      return {
        worldPos: b.worldPos,
        blockId: b.blockId,
        chunkKey: b.chunkKey,
        localCell: b.localCell,
        hasLightData: b.hasLightData,
        brightnessBefore: b.brightness,
        brightnessAfter: a.brightness,
        brightnessAfterRemove: ar.brightness,
        deltaPlace: dp,
        deltaRemove: dr,
        brightenedOnPlace: brightenedPlace,
        dimmedOnRemove: dimmedRemove,
      };
    });

    // PASS criteria: at least 3 surrounding cells brightened on place AND
    // dimmed on remove. (3 out of 13 cells = the light must actually reach
    // the surface, not just the source.)
    const cellsBrightened = cellResults.filter(c => c.brightenedOnPlace).length;
    const cellsDimmed = cellResults.filter(c => c.dimmedOnRemove).length;
    const cellsWithLightData = cellResults.filter(c => c.hasLightData).length;

    let result: "PASS" | "FAIL" | "INCONCLUSIVE";
    let reason: string;

    if (cellsWithLightData < 3) {
      result = "INCONCLUSIVE";
      reason = `Only ${cellsWithLightData}/13 cells have light data (chunks not loaded)`;
    } else if (cellsBrightened >= 3 && cellsDimmed >= 3) {
      result = "PASS";
      reason = `${cellsBrightened} cells brightened on place, ${cellsDimmed} dimmed on remove`;
    } else if (cellsBrightened === 0) {
      result = "FAIL";
      reason = `No surrounding cells brightened (source may be bright but surface is dark). cellsWithLightData=${cellsWithLightData}`;
    } else if (cellsDimmed === 0) {
      result = "FAIL";
      reason = `No surrounding cells dimmed on removal (stale lighting). cellsBrightened=${cellsBrightened}`;
    } else {
      result = "FAIL";
      reason = `Insufficient surface response: ${cellsBrightened} brightened, ${cellsDimmed} dimmed (need ≥3 each)`;
    }

    return {
      centerPos: [centerX, centerY, centerZ],
      cells: cellResults,
      cellsBrightened,
      cellsDimmed,
      cellsWithLightData,
      result,
      reason,
    };
  }

  public dispose(): void {
    this.disposed = true;
    this.chunkLight.clear();
    this.voxelLightSources.clear();
    this.relightQueue = [];
    this.relightQueueSet.clear();
    this.edgeQueue = [];
    console.log("[VoxelLightManager] Disposed.");
  }
}

/** Clamp a value to 0..1. */
function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
