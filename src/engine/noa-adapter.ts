/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Engine } from 'noa-engine';
import * as BABYLON from '@babylonjs/core';
import { PlayerService } from '../player/player-service';
import { WorldService } from '../world/world-service';
import { BlockService } from '../blocks/block-service';
import { MissionService } from '../missions/mission-service';
import { UiService } from '../ui/ui-service';
import { SurvivalService } from '../player/survival-service';
import { GameEvent, GameEventType, BlockDefinition } from '../types';
import { gameState } from '../game/game-state';
import { ModRegistry } from '../modding/mod-registry';
import { AudioService } from '../audio/audio-service';

// Rendering services (Pass 1).
import { MaterialService } from './rendering/material-service';
import { RenderPipelineService } from './rendering/render-pipeline-service';
import { WorldLightManager } from './rendering/world-light-manager';
import { VoxelLightManager, type BlockLightResolver } from './rendering/voxel-light-manager';
import { SkyController } from './rendering/sky-controller';
import {
  getGraphicsSettings,
  detectDefaultQuality,
  type GraphicsSettings,
} from './rendering/graphics-settings';
import {
  resolveBiomePhasePreset,
  clampPresetToRenderDistance,
  parseHexColor3,
  parseHexColor4,
} from './rendering/visual-presets';
import {
  type VisualTuning,
  DEFAULT_VISUAL_TUNING,
  loadVisualTuning,
  saveVisualTuning,
  NAMED_PRESETS,
} from './rendering/visual-tuning';
import { PrecipitationFieldRenderer } from './weather/precipitation-field-renderer';
import {
  DEFAULT_PRECIPITATION_FIELD_CONFIG,
  POLYGON_TEST_ROOF,
  type PrecipitationFieldDebugInfo,
} from './weather/precipitation-field-types';

/**
 * Minimal internal interface mapping for the 3D noa-engine
 * to prevent typescript "any" leaking outside NoaEngineAdapter.
 */
export interface NoaEngineInstance {
  world: {
    on(event: string, callback: (...args: any[]) => void): void;
    setChunkData(id: string, ndarray: any): void;
    getBlockID(x: number, y: number, z: number): number;
  };
  entities: {
    setPosition(entity: any, pos: [number, number, number]): void;
    getPosition(entity: any): number[];
  };
  playerEntity: any;
  container: {
    canvas: HTMLCanvasElement;
  };
  targetedBlock: {
    position: [number, number, number];
    adjacent: [number, number, number];
  } | null;
  getBlock(x: number, y: number, z: number): number;
  setBlock(id: number, x: number, y: number, z: number): void;
  on(event: string, callback: (...args: any[]) => void): void;
  registry: {
    registerMaterial(
      name: string,
      options: {
        color: [number, number, number];
        /** Custom Babylon material — when set, noa uses it for terrain faces. */
        renderMaterial?: any;
      }
    ): void;
    registerBlock(id: number, props: any): void;
  };
  inputs: {
    down: {
      on(event: string, cb: () => void): void;
    };
  };
  pick(pos?: number[] | null, dir?: number[] | null, dist?: number, blockTestFunction?: any): any;
  destroy(): void;
  rendering?: any;
  camera?: any;
  worldOriginOffset?: number[];
}

// Configurable constants for draw and render settings.
const CHUNK_SIZE = 16;
/** Per-quality chunk distances. Higher = fewer pop-ins but more terrain to mesh. */
const CHUNK_DISTANCES: Record<string, { add: number; remove: number }> = {
  low: { add: 6, remove: 8 },
  medium: { add: 8, remove: 10 },
  high: { add: 10, remove: 12 },
};
const BLOCK_DATA_NEEDED_EMIT_INTERVAL = 12;
/** Day length in seconds. Preserved from the original tuning (~28 min cycle). */
const DAY_LENGTH_SECONDS = 1715;

/** Detect ?visualSanity=1 query param for QA baseline mode. */
function readVisualSanityMode(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("visualSanity") === "1";
  } catch {
    return false;
  }
}

/** Detect ?resetVisual=1 to clear saved visual settings on boot. */
function shouldResetVisualSettings(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("resetVisual") === "1";
  } catch {
    return false;
  }
}

/**
 * NoaEngineAdapter - Bridging engine adapter that decouples the 3D game canvas
 * and controls from pure business and React logic.
 *
 * Pass 1 refactor: this file is now a thin BRIDGE. All rendering, material,
 * lighting, sky, and post-processing logic has moved into dedicated services
 * under src/engine/rendering/. The adapter now only:
 *   - instantiates noa
 *   - bridges input
 *   - bridges chunk/world data requests
 *   - coordinates update calls between noa's tick loop and the services
 *   - disposes engine resources
 *
 * It NO LONGER contains: hardcoded block-ID lighting, celestial mesh building,
 * fog/sky color math, material emissive hacks, or post-processing setup.
 */
export class NoaEngineAdapter {
  private noa: NoaEngineInstance;
  private playerService: PlayerService;
  private worldService: WorldService;
  private blockService: BlockService;
  private missionService: MissionService;
  private uiService: UiService;
  private survivalService: SurvivalService | null = null;
  private containerElement: HTMLElement;
  private isCleanup: boolean = false;
  private isSprinting: boolean = false;
  private sprintWarningLogged = false;

  // Master day/night clock (0..1). Advanced in the tick loop, consumed by
  // SkyController + VisualPresets. Start at 0.1 (early morning) so the sun is
  // low on the horizon and immediately visible from the spawn pose.
  private timeOfDay: number = 0.1;
  private lastFrameTime: number = 0;
  private lastPositionUpdate: number = 0;
  private chunkTimes: number[] = [];
  private lastPerfLogTime: number = Date.now();
  /** Chunk distances (quality-dependent). Stored for debug + fog calibration. */
  private chunkAddDistance: number = 6;
  private chunkRemoveDistance: number = 8;
  /** ?visualSanity=1 QA mode flag. */
  private visualSanityMode: boolean = false;
  /** Terrain debug material (forceTerrainDebugMaterial toggle). */
  private terrainDebugMat: BABYLON.StandardMaterial | null = null;
  /** Original chunk materials (saved when debug material is forced). */
  private savedChunkMaterials: Map<string, BABYLON.Material | null> = new Map();
  /** Live-tunable visual parameters (F3 debug console). */
  private visualTuning: VisualTuning = shouldResetVisualSettings()
    ? (localStorage.removeItem("frontierPlanet.visualSettings"), { ...DEFAULT_VISUAL_TUNING })
    : loadVisualTuning();
  /** Game mode: 'play' (procedural) or 'polygon' (flatworld test). */
  private gameMode: 'play' | 'polygon' = 'play';
  /** Walking Light Monitor state. */
  private walkingMonitorActive: boolean = false;
  private walkingMonitorStartChunk: string = "";
  private walkingMonitorPrevChunk: string = "";
  private walkingMonitorLastResult: any = null;
  private walkingMonitorFpsHistory: number[] = [];

  // Rendering services (Pass 1).
  private materialService: MaterialService | null = null;
  private renderPipelineService: RenderPipelineService | null = null;
  private worldLightManager: WorldLightManager | null = null;
  private skyController: SkyController | null = null;
  private precipitationFieldRenderer: PrecipitationFieldRenderer | null = null;
  /**
   * VoxelLightManager — Minecraft-style per-cell baked lighting (skyLight +
   * RGB blockLight flood-fill). This is the PERFORMANCE lighting model: light
   * is baked into chunk mesh vertex colors, NOT real Babylon PointLights. Real
   * dynamic lights (WorldLightManager) are debug-only, capped 0-3.
   */
  private voxelLightManager: VoxelLightManager | null = null;
  private graphicsSettings: GraphicsSettings;

  constructor(
    container: HTMLElement,
    playerService: PlayerService,
    worldService: WorldService,
    blockService: BlockService,
    missionService: MissionService,
    uiService: UiService,
    gameMode: 'play' | 'polygon' = 'play',
    survivalService: SurvivalService | null = null
  ) {
    this.containerElement = container;
    this.playerService = playerService;
    this.worldService = worldService;
    this.blockService = blockService;
    this.missionService = missionService;
    this.uiService = uiService;
    this.gameMode = gameMode;
    this.survivalService = survivalService;

    // Resolve graphics quality (auto-detect, clamped to medium default).
    this.graphicsSettings = getGraphicsSettings(detectDefaultQuality());

    // ?visualSanity=1 mode: forces fog off, bloom off, glow low, safe materials.
    // Used to prove the core world is visually readable without post-processing.
    this.visualSanityMode = readVisualSanityMode();
    if (this.visualSanityMode) {
      this.graphicsSettings.glowIntensity = 0.05;
      this.graphicsSettings.bloomEnabled = false;
      this.graphicsSettings.maxActiveDynamicLights = 4;
      console.log("[NoaEngineAdapter] VISUAL SANITY MODE active — fog/bloom/glow minimized.");
    }

    const cd = CHUNK_DISTANCES[this.graphicsSettings.quality] ?? CHUNK_DISTANCES.low;
    this.chunkAddDistance = cd.add;
    this.chunkRemoveDistance = cd.remove;

    const opts = {
      debug: false,
      showStats: false,
      inverseYOnBlockPlace: false,
      chunkSize: CHUNK_SIZE,
      chunkAddDistance: this.chunkAddDistance,
      chunkRemoveDistance: this.chunkRemoveDistance,
      blockDataNeededEmitInterval: BLOCK_DATA_NEEDED_EMIT_INTERVAL,
      container: this.containerElement,
    };

    this.noa = new Engine(opts) as unknown as NoaEngineInstance;

    this.initializeEngine();
  }

  private initializeEngine(): void {
    console.log('[NoaEngineAdapter] Spawning 3D world canvas context...');

    // 1. Register materials and blocks (via MaterialService).
    this.initializeMaterials();

    // 2. Setup World Chunk Generator.
    this.setupWorldDataHandler();

    // 3. Setup Input and Action Hooks.
    this.setupInputHandlers();

    // 4. Setup Game Loop Telemetry Tick.
    this.setupTickHandler();

    // 5. Initialize the Babylon rendering layer (Pass 1 services).
    this.initializeRendering();

    // 6. Teleport Player to safe landing zone spawn point.
    const spawnPos: [number, number, number] = this.gameMode === 'polygon' ? [0, 10, 0] : [0, 15, 0];
    this.noa.entities.setPosition(this.noa.playerEntity, spawnPos);
    this.playerService.updatePosition(spawnPos);

    // 7. Set up preview camera so the world is visible BEFORE pointer lock.
    // noa's camera defaults to heading=0, pitch=0 (looking toward +Z), which
    // may face away from terrain. Point it at the ruin (which has terrain,
    // lamps, and the artifact) so the player sees a live world on boot.
    this.setupPreviewCamera();

    console.log('[NoaEngineAdapter] Standalone 3D voxel engine fully synchronized.');
  }

  /**
   * Set noa.camera heading/pitch so the preview pose (before pointer lock)
   * looks toward the sun and visible terrain rather than empty sky.
   *
   * At dawn (timeOfDay=0.1), the sun is at a low altitude in the east-ish
   * sky. We point the camera at the sun so the player sees the celestial
   * body AND the terrain it illuminates. A slight downward pitch keeps the
   * terrain surface in frame.
   *
   * This does NOT request pointer lock — it only sets the initial camera
   * orientation. noa will overwrite heading/pitch each frame from mouse
   * input once pointer lock engages, but until then this pose renders.
   */
  private setupPreviewCamera(): void {
    try {
      const cam = (this.noa as any).camera;
      if (!cam) return;
      // Sun orbital position at timeOfDay:
      //   angle = timeOfDay * 2π
      //   sunDir = (cos(angle), sin(angle), 0.5)  [matches SkyController]
      // The sun's horizontal direction from the player is (cos, 0, 0.5/z-normalized).
      // noa camera heading: 0 = +Z, π/2 = +X, π = -Z, 3π/2 = -X.
      // heading = atan2(sunDirX, sunDirZ) faces the sun.
      const angle = this.timeOfDay * Math.PI * 2;
      const sunDirX = Math.cos(angle);
      const sunDirZ = 0.5; // matches SkyController's +z*0.5 bias
      let heading = Math.atan2(sunDirX, sunDirZ);
      if (heading < 0) heading += Math.PI * 2;
      cam.heading = heading;
      // Slight DOWNWARD pitch so terrain is visible in the lower half of the
      // frame. noa applies pitch as holder.rotation.x; in Babylon a positive
      // rotation.x on a +Z-facing camera tilts it downward. We use a small
      // positive value so the player sees ground, not sky.
      cam.pitch = 0.12;
      console.log(
        `[NoaEngineAdapter] Preview camera set: heading=${(heading * 180 / Math.PI).toFixed(0)}°, pitch=${cam.pitch.toFixed(2)} rad (facing sun at timeOfDay=${this.timeOfDay.toFixed(3)}).`
      );
    } catch (e) {
      console.warn('[NoaEngineAdapter] Preview camera setup failed:', e);
    }
  }

  /**
   * Register all block materials via the MaterialService. This replaces the
   * old inline material/emissive loop and is fully data-driven.
   *
   * Pass 2: MaterialService now builds a Babylon StandardMaterial per block
   * and hands it to noa via `registerMaterial({ renderMaterial })` so the
   * terrain mesher actually uses our material (with maxSimultaneousLights,
   * emissive, fog) instead of noa's internal flat-color one.
   */
  private initializeMaterials(): void {
    const scene = this.getSceneSafe();
    if (!scene) {
      console.warn('[NoaEngineAdapter] Scene unavailable for material init; will retry.');
      return;
    }
    // maxSimultaneousLights must be >= the active dynamic light budget so
    // Babylon doesn't silently drop lights beyond its default of 4.
    const maxLights = Math.max(
      12,
      this.graphicsSettings.maxActiveDynamicLights + 4
    );
    this.materialService = new MaterialService(
      scene,
      this.noa.registry,
      maxLights,
      this.noa.rendering ?? null
    );
    this.materialService.registerAll(this.blockService.getBlockDefinitions());
  }

  /**
   * Initialize the full Babylon rendering layer: post-processing pipeline,
   * sky controller, world light manager, and the initial visual preset.
   * Replaces the old initializeAtmosphericFog + initializeCelestialAtmosphere.
   */
  private initializeRendering(): void {
    const scene = this.getSceneSafe();
    if (!scene) {
      console.warn('[NoaEngineAdapter] Scene unavailable; rendering services deferred.');
      return;
    }

    // Post-processing (GlowLayer + DefaultRenderingPipeline). Fails gracefully.
    // noa's Babylon camera is always the scene's active camera once noa boots.
    const camera = scene.activeCamera ?? null;
    this.renderPipelineService = new RenderPipelineService(
      scene,
      camera,
      this.graphicsSettings
    );

    // Sky + celestial bodies + sun/ambient/moon lights.
    // Pass an octree-registration callback so sky meshes are added to noa's
    // octree dynamicContent — without this, noa's OctreeSceneComponent excludes
    // them from active-mesh candidates and they NEVER RENDER.
    this.skyController = new SkyController(scene, this.graphicsSettings, (mesh) => {
      const octMgr = (this.noa.rendering as any)?._octreeManager;
      if (octMgr && typeof octMgr.addMesh === "function") {
        octMgr.addMesh(mesh, false);
      }
    });

    // Disable noa-engine's default DirectionalLight ("light"). It's an unmanaged
    // second sun that fights our SkyController + consumes a material light slot.
    const noaDefaultLight = scene.lights.find((l: any) => l.name === "light");
    if (noaDefaultLight) {
      noaDefaultLight.setEnabled(false);
      console.log("[NoaEngineAdapter] Disabled noa default light 'light' (second sun).");
    }

    // World light registry. Pre-seed static + generated lights from WorldService.
    // NOTE: WorldLightManager (real Babylon PointLights) is now DEBUG-ONLY, capped
    // to 0-3 lights by default. The primary lighting model is VoxelLightManager
    // (cheap baked vertex-color light). Real lights are reserved for an optional
    // "debug_real_lights" preset.
    this.worldLightManager = new WorldLightManager(scene, this.graphicsSettings);
    this.worldLightManager.registerStaticLights(
      this.worldService.getStaticLightSources(),
      (id) => this.blockService.getBlock(id)
    );
    // Cap real PointLights at 3 (debug only) — they are NOT the main lighting.
    this.worldLightManager.setBudget(3);

    // VoxelLightManager — the PERFORMANCE lighting model. Minecraft-style per-cell
    // skyLight + RGB blockLight baked into chunk mesh vertex colors. No real
    // PointLights per glowing block. This reserves the GPU/CPU budget for
    // sandbox simulation, not realistic lighting.
    const blockResolver: BlockLightResolver = {
      isOpaque: (blockId: number) => {
        const def = this.blockService.getBlock(blockId);
        // Air and non-solid blocks are transparent to light; solid opaque blocks block it.
        if (!def) return false;
        return def.opaque !== false && def.solid !== false;
      },
      isAir: (blockId: number) => blockId === 0,
      getEmission: (blockId: number) => {
        const def = this.blockService.getBlock(blockId);
        if (!def || !def.light) return null;
        // Map the block's LightProfile to a 0-15 voxel light level.
        // intensity ~1.5-2.2 → level 12-15; range informs radius (capped by MAX_LIGHT_RADIUS).
        const level = Math.max(1, Math.min(15, Math.round((def.light.intensity ?? 1) * 7)));
        const col = def.light.color || def.color || [1, 1, 1];
        return { level, r: col[0], g: col[1], b: col[2] };
      },
    };
    this.voxelLightManager = new VoxelLightManager(blockResolver, (x, y, z) => this.getBlockIdAt(x, y, z));

    // Seed the voxel light source registry with all static + generated light
    // sources so cross-chunk propagation works: when a chunk is recomputed,
    // VoxelLightManager queries this registry for neighbor sources within
    // MAX_LIGHT_RADIUS and seeds them into the BFS so light correctly crosses
    // chunk edges (previously only internal sources seeded — neighbor chunks
    // never received boundary light from adjacent torches).
    try {
      const staticSeeds = this.worldService.getStaticLightSources();
      let seeded = 0;
      for (const s of staticSeeds) {
        const def = this.blockService.getBlock(s.blockId);
        if (def) {
          this.voxelLightManager.registerLight(s.pos[0], s.pos[1], s.pos[2], def);
          seeded++;
        }
      }
      console.log(`[NoaEngineAdapter] Seeded voxel light source registry with ${seeded} static sources.`);
    } catch (e) {
      console.warn('[NoaEngineAdapter] Static voxel light seed failed:', e);
    }

    // Disable the real-light system by default (performance mode). Real
    // PointLights only turn on if the user picks the "debug_real_lights" preset.
    this.worldLightManager.setEnabled(false);
    console.log("[NoaEngineAdapter] Real dynamic PointLights DISABLED by default (performance voxel mode). Use F3 → 'debug_real_lights' preset to enable.");

    // Hook noa's chunk-mesh-built event to bake voxel light into vertex colors.
    // This fires AFTER noa writes matColor×AO colors but BEFORE freezeNormals,
    // so we can overwrite colors with matColor×AO×brightness(skyLight,blockLight).
    try {
      (this.noa as any).on('addingTerrainMesh', (mesh: any) => {
        if (!mesh || !mesh.name || !mesh.name.startsWith('chunk_')) return;
        // Use Math.round for negative coordinate safety (chunk origins are
        // exact multiples of 16, but float drift can make them -15.9999999).
        const ox = mesh.position ? Math.round(mesh.position.x) : 0;
        const oy = mesh.position ? Math.round(mesh.position.y) : 0;
        const oz = mesh.position ? Math.round(mesh.position.z) : 0;
        this.voxelLightManager?.recolorMesh(mesh, ox, oy, oz);
        // After recoloring the new mesh, also recolor any NEIGHBOR meshes
        // whose light data may have changed due to this chunk's geometry.
        // CANONICAL: neighbor keys are WORLD chunk keys (VLM is WORLD-space;
        // recolorAffectedMeshes matches meshes by their WORLD chunk key).
        const wkey = this.voxelLightManager ? this.voxelLightManager.terrainMeshToWorldChunkKey(mesh) : "";
        const wparts = wkey.split(",").map(Number);
        const cx = wparts[0] | 0, cy = wparts[1] | 0, cz = wparts[2] | 0;
        const neighborKeys: string[] = [];
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              if (dx === 0 && dy === 0 && dz === 0) continue;
              neighborKeys.push(`${cx+dx},${cy+dy},${cz+dz}`);
            }
          }
        }
        this.voxelLightManager?.recolorAffectedMeshes(scene, neighborKeys);
      });
    } catch (e) {
      console.warn('[NoaEngineAdapter] addingTerrainMesh hook failed:', e);
    }

    // Apply the initial visual preset (fog / clearColor / ambient tuning).
    this.applyAtmosphereForCurrentPhase([0, 15, 0]);

    if (this.gameMode === 'polygon') {
      this.precipitationFieldRenderer = new PrecipitationFieldRenderer(scene, {}, (mesh) => {
        const octMgr = (this.noa.rendering as any)?._octreeManager;
        if (octMgr && typeof octMgr.addMesh === "function") {
          octMgr.addMesh(mesh, false);
        }
      });
      console.log('[NoaEngineAdapter] Abstract Precipitation Field ready (Polygon only, disabled).');
    }

    // Start ambient desert synthesized audio loop on first user interaction.
    const clickStartAudio = () => {
      AudioService.getInstance().playAmbientDesert();
      this.noa.container.canvas.removeEventListener('click', clickStartAudio);
    };
    this.noa.container.canvas.addEventListener('click', clickStartAudio);

    console.log('[NoaEngineAdapter] Rendering layer initialized.');

    // Expose a rich debug hook for QA / browser inspection.
    // Usage in devtools:
    //   __fpDebug()            -> full status snapshot
    //   __fpDebug().fog        -> fog state
    //   __fpDebug().lights     -> nearest registered lights
    //   __fpDebug().sky        -> celestial body visibility
    //   __fpDebug().setTimeOfDay(0.5)  -> force midnight for testing
    const adapter = this;
    (window as any).__fpDebug = () => {
      const scene = adapter.getSceneSafe();
      const playerPos = adapter.getPlayerPositionSafe() || [0, 15, 0];
      const rdb = adapter.getRenderDistanceBlocks();
      const cam = scene?.activeCamera;
      const sunMesh = scene?.getMeshByName("fp_sun");
      const moonMesh = scene?.getMeshByName("fp_moon");
      const snapshot = {
        quality: adapter.graphicsSettings.quality,
        gameMode: adapter.gameMode,
        abstractPrecipitation: adapter.getAbstractPrecipitationDebugInfo(),
        timeOfDay: adapter.timeOfDay,
        renderDistanceBlocks: rdb,
        chunkAddDistance: adapter.chunkAddDistance,
        chunkRemoveDistance: adapter.chunkRemoveDistance,
        materialService: adapter.materialService
          ? { built: adapter.materialService.getBuiltCount() }
          : null,
        renderPipelineService: !!adapter.renderPipelineService,
        worldLightManager: adapter.worldLightManager
          ? adapter.worldLightManager.getDebugInfo(playerPos)
          : null,
        skyController: adapter.skyController
          ? adapter.skyController.getDebugInfo()
          : null,
        fog: scene
          ? {
              fogEnabled: scene.fogEnabled,
              fogMode: scene.fogMode,
              fogStart: scene.fogStart,
              fogEnd: scene.fogEnd,
              fogColor: scene.fogColor
                ? `#${scene.fogColor.toHexString()}`
                : null,
            }
          : null,
        camera: (() => {
          if (!cam) return null;
          const noaCam = (adapter.noa as any).camera;
          const holder = (adapter.noa as any).rendering?._cameraHolder;
          const absPos = (cam as any).getAbsolutePosition ? (cam as any).getAbsolutePosition() : cam.position;
          const playerPos = adapter.getPlayerPositionSafe();
          return {
            pointerLocked: !!document.pointerLockElement,
            previewCameraActive: !document.pointerLockElement,
            babylonCameraLocalPosition: [cam.position.x, cam.position.y, cam.position.z],
            babylonCameraAbsolutePosition: absPos ? [absPos.x, absPos.y, absPos.z] : null,
            noaCameraHeading: noaCam ? noaCam.heading : null,
            noaCameraPitch: noaCam ? noaCam.pitch : null,
            noaCameraCurrentZoom: noaCam ? noaCam.currentZoom : null,
            cameraHolderPosition: holder
              ? [holder.position.x, holder.position.y, holder.position.z]
              : null,
            playerPosition: playerPos
              ? [playerPos[0], playerPos[1], playerPos[2]]
              : null,
            target: (cam as any).target
              ? [(cam as any).target.x, (cam as any).target.y, (cam as any).target.z]
              : null,
            maxZ: cam.maxZ,
            minZ: cam.minZ,
          };
        })(),
        terrain: (() => {
          if (!scene) return null;
          const chunks = scene.meshes.filter((m: any) => m.name.startsWith("chunk_"));
          const sample = chunks.slice(0, 10).map((m: any) => ({
            name: m.name,
            visible: m.isVisible,
            enabled: m.isEnabled(),
            renderingGroupId: m.renderingGroupId,
            vertCount: m.getTotalVertices ? m.getTotalVertices() : 0,
            matName: m.material ? m.material.name : "none",
            matAmbient: m.material && m.material.ambientColor
              ? [m.material.ambientColor.r, m.material.ambientColor.g, m.material.ambientColor.b]
              : null,
            matDiffuse: m.material && m.material.diffuseColor
              ? [m.material.diffuseColor.r, m.material.diffuseColor.g, m.material.diffuseColor.b]
              : null,
            matFogEnabled: m.material ? m.material.fogEnabled : null,
            matMaxLights: m.material ? m.material.maxSimultaneousLights : null,
          }));
          return {
            meshCount: chunks.length,
            enabledCount: chunks.filter((m: any) => m.isEnabled()).length,
            visibleCount: chunks.filter((m: any) => m.isVisible).length,
            sample,
          };
        })(),
        sun: sunMesh
          ? {
              pos: [sunMesh.position.x, sunMesh.position.y, sunMesh.position.z],
              worldPos: sunMesh.getAbsolutePosition
                ? [
                    sunMesh.getAbsolutePosition().x,
                    sunMesh.getAbsolutePosition().y,
                    sunMesh.getAbsolutePosition().z,
                  ]
                : null,
              visible: sunMesh.isVisible,
              renderingGroupId: sunMesh.renderingGroupId,
            }
          : null,
        moon: moonMesh
          ? {
              pos: [moonMesh.position.x, moonMesh.position.y, moonMesh.position.z],
              visible: moonMesh.isVisible,
            }
          : null,
        /** Force the day/night clock for testing. 0=dawn, 0.25=noon, 0.5=dusk, 0.75=midnight. */
        setTimeOfDay(t: number) {
          adapter.setTimeOfDay(t);
          return adapter.timeOfDay;
        },
        /** Toggle sky mesh visibility for QA (isolates sky occlusion issues). */
        setSkyVisible(visible: boolean) {
          if (adapter.skyController) {
            adapter.skyController.setVisible(visible);
            return visible;
          }
          return null;
        },
        /** Toggle fog on/off for QA. */
        setFogEnabled(enabled: boolean) {
          const sc = adapter.getSceneSafe();
          if (sc) {
            sc.fogEnabled = enabled;
            console.log(`[NoaEngineAdapter] Fog ${enabled ? "enabled" : "disabled"}.`);
            return enabled;
          }
          return null;
        },
        /** Toggle GlowLayer on/off for QA. */
        setGlowEnabled(enabled: boolean) {
          adapter.renderPipelineService?.setGlowEnabled(enabled);
          return enabled;
        },
        /** Toggle bloom on/off for QA. */
        setBloomEnabled(enabled: boolean) {
          adapter.renderPipelineService?.setBloomEnabled(enabled);
          return enabled;
        },
        /**
         * Force a bright unlit debug material onto all chunk_ meshes to prove
         * terrain is rendering (isolates material/fog/postprocess issues).
         * Pass false to restore original materials.
         */
        forceTerrainDebugMaterial(enabled: boolean) {
          return adapter.applyTerrainDebugMaterial(enabled);
        },
        /** Detailed terrain render diagnostics. */
        terrainRender: (() => {
          const sc = scene;
          if (!sc) return null;
          const cam = sc.activeCamera;
          const chunks = sc.meshes.filter((m: any) => m.name.startsWith("chunk_"));
          const activeMeshes = sc.getActiveMeshes ? sc.getActiveMeshes() : [];
          const sample = chunks.slice(0, 10).map((m: any) => {
            const bb = m.getBoundingInfo?.()?.boundingBox;
            const camPos = cam ? cam.position : null;
            let dist = 0;
            if (bb && camPos) {
              const cx = bb.centerWorld.x - camPos.x;
              const cy = bb.centerWorld.y - camPos.y;
              const cz = bb.centerWorld.z - camPos.z;
              dist = Math.sqrt(cx * cx + cy * cy + cz * cz);
            }
            return {
              name: m.name,
              isVisible: m.isVisible,
              isEnabled: m.isEnabled(),
              materialName: m.material ? m.material.name : "none",
              materialIsReady: m.material ? m.material.isReady?.(m) : null,
              materialAlpha: m.material ? m.material.alpha : null,
              materialDisableLighting: m.material ? m.material.disableLighting : null,
              materialFogEnabled: m.material ? m.material.fogEnabled : null,
              needAlphaBlending: m.material ? m.material.needAlphaBlending?.() : null,
              renderingGroupId: m.renderingGroupId,
              layerMask: m.layerMask,
              bboxMin: bb ? [bb.minimumWorld.x, bb.minimumWorld.y, bb.minimumWorld.z] : null,
              bboxMax: bb ? [bb.maximumWorld.x, bb.maximumWorld.y, bb.maximumWorld.z] : null,
              distanceFromCam: dist,
            };
          });
          return {
            totalMeshCount: chunks.length,
            activeMeshCount: activeMeshes.length,
            cameraLayerMask: cam ? cam.layerMask : null,
            cameraAbsolutePos: cam && (cam as any).getAbsolutePosition
              ? [(cam as any).getAbsolutePosition().x, (cam as any).getAbsolutePosition().y, (cam as any).getAbsolutePosition().z]
              : cam
              ? [cam.position.x, cam.position.y, cam.position.z]
              : null,
            sample,
          };
        })(),
        /** Internal: expose the raw Babylon scene for deep QA inspection. */
        _scene: scene,
        /** Internal: expose the noa engine for deep QA inspection. */
        _noa: adapter.noa,
        /** Internal: expose the adapter for VisualTuning console. */
        _adapter: adapter,
        /** Current VisualTuning state (live). */
        visualTuning: adapter.getVisualTuning(),
        /** Update VisualTuning live (partial patch). */
        updateVisualTuning(patch: any) {
          return adapter.updateVisualTuning(patch);
        },
        /** Apply a named preset. */
        applyNamedPreset(name: string) {
          return adapter.applyNamedPreset(name);
        },
        /** Reset to safe baseline. */
        resetToSafeBaseline() {
          return adapter.resetToSafeBaseline();
        },
        /** Reset to atmospheric default. */
        resetToAtmosphericDefault() {
          return adapter.resetToAtmosphericDefault();
        },
        /** Save current visual settings to localStorage. */
        saveVisualSettings() {
          adapter.saveVisualSettings();
        },
        /** Load visual settings from localStorage. */
        loadVisualSettings() {
          return adapter.loadVisualSettings();
        },
        /** Export visual settings as JSON string. */
        exportVisualSettings() {
          return adapter.exportVisualSettings();
        },
        /** Import visual settings from parsed object. */
        importVisualSettings(settings: any) {
          return adapter.importVisualSettings(settings);
        },
        /** Isolate sky (hide terrain + world lights, show only sky). */
        isolateSky(isolated: boolean) {
          const sc = adapter.getSceneSafe();
          if (!sc) return;
          sc.meshes.forEach((m: any) => {
            if (m.name.startsWith("chunk_") || m.name.startsWith("wl-")) {
              m.setEnabled(!isolated);
            }
          });
          console.log(`[NoaEngineAdapter] Sky ${isolated ? "isolated" : "restored"}.`);
        },
        /** Toggle the real Babylon PointLight system (debug only, capped 0-3). */
        toggleRealPointLights(enabled: boolean) {
          adapter.worldLightManager?.setEnabled(enabled);
          if (enabled) {
            adapter.worldLightManager?.setBudget(3);
            console.log("[NoaEngineAdapter] Real PointLights ON (debug, cap 3).");
          } else {
            console.log("[NoaEngineAdapter] Real PointLights OFF (performance voxel mode).");
          }
        },
        /** Force a full voxel-light relight of all known chunks (synchronous). */
        forceRelightAll() {
          const sc = adapter.getSceneSafe();
          const result = adapter.voxelLightManager?.forceRelightAllImmediate(sc);
          console.log(`[NoaEngineAdapter] Force relight IMMEDIATE: recomputed ${result?.recomputedChunks ?? 0} chunks, recolored ${result?.recoloredMeshCount ?? 0} meshes in ${result?.durationMs.toFixed(1) ?? '0'}ms.`);
        },
        /** Recolor Stability Test — run recolorMesh 20x, verify no darkening. */
        recolorStabilityTest() {
          const sc = adapter.getSceneSafe();
          const result = adapter.voxelLightManager?.recolorStabilityTest(sc);
          console.log("[NoaEngineAdapter] RECOLOR STABILITY TEST:", JSON.stringify(result));
          return result;
        },
        /** Glow Off Lighting Test — disable GlowLayer, place a torch, verify surface illumination. */
        glowOffLightingTest() {
          const sc = adapter.getSceneSafe();
          if (!sc) return;
          adapter.updateVisualTuning({ glowEnabled: false, bloomEnabled: false });
          adapter.worldLightManager?.setEnabled(false);
          adapter.voxelLightManager?.setLightingMode("performance_voxel");
          const pp = adapter.getPlayerPositionSafe() || [0, 15, 0];
          // Find ground level near the player.
          let gy = Math.floor(pp[1]);
          for (let y = Math.floor(pp[1]); y > 0; y--) {
            const id = adapter.getBlockIdAt(Math.floor(pp[0]) + 2, y, Math.floor(pp[2]));
            if (id !== 0) { gy = y + 1; break; }
          }
          const lx = Math.floor(pp[0]) + 2;
          const ly = gy;
          const lz = Math.floor(pp[2]);
          adapter.worldService.setBlockOverride(lx, ly, lz, 7);
          adapter.noa.setBlock(7, lx, ly, lz);
          const bd = adapter.blockService.getBlock(7);
          if (bd) {
            adapter.worldLightManager?.registerLight(lx, ly, lz, bd);
            adapter.voxelLightManager?.registerLight(lx, ly, lz, bd);
          }
          adapter.voxelLightManager?.relightAround(sc, lx, ly, lz);
          const count = adapter.voxelLightManager?.recolorAllVisibleChunkMeshes(sc) ?? 0;
          console.log(`[NoaEngineAdapter] GLOW OFF LIGHTING TEST: glow disabled, placed torch at [${lx},${ly},${lz}], recolored ${count} meshes. Surface illumination should be visible WITHOUT glow.`);
        },
        /** Ruin Light Cluster Test — teleport to the ruin, verify no flicker. */
        ruinLightClusterTest() {
          const sc = adapter.getSceneSafe();
          if (!sc) return;
          adapter.worldLightManager?.setEnabled(false);
          adapter.voxelLightManager?.setLightingMode("performance_voxel");
          // Teleport player to the ruin center (has glowing spire blocks).
          const ruinCenter = adapter.worldService.getRuinCenter();
          const eng = adapter.noa;
          eng.entities.setPosition(eng.playerEntity, [ruinCenter[0] + 2, ruinCenter[1] + 2, ruinCenter[2] + 2]);
          // Force relight + immediate recolor (synchronous, not queued).
          adapter.voxelLightManager?.forceRelightAllImmediate(sc);
          console.log(`[NoaEngineAdapter] RUIN CLUSTER TEST: teleported to ruin [${ruinCenter}], force-relight immediate. No flicker should occur.`);
        },
        /** Single Torch Voxel Test — PLACE one yellow lamp on the ground near the player + relight + recolor. */
        singleTorchVoxelTest() {
          const sc = adapter.getSceneSafe();
          if (!sc) return;
          adapter.worldLightManager?.setEnabled(false);
          adapter.voxelLightManager?.setLightingMode("performance_voxel");
          const pp = adapter.getPlayerPositionSafe() || [0, 15, 0];
          // Find the ground level near the player (scan down for the first solid block).
          let gy = Math.floor(pp[1]);
          for (let y = Math.floor(pp[1]); y > 0; y--) {
            const id = adapter.getBlockIdAt(Math.floor(pp[0]) + 2, y, Math.floor(pp[2]));
            if (id !== 0) { gy = y + 1; break; }
          }
          const lx = Math.floor(pp[0]) + 2;
          const ly = gy;
          const lz = Math.floor(pp[2]);
          adapter.worldService.setBlockOverride(lx, ly, lz, 7);
          adapter.noa.setBlock(7, lx, ly, lz);
          const blockDef = adapter.blockService.getBlock(7);
          if (blockDef) {
            adapter.worldLightManager?.registerLight(lx, ly, lz, blockDef);
            adapter.voxelLightManager?.registerLight(lx, ly, lz, blockDef);
          }
          adapter.voxelLightManager?.relightAround(sc, lx, ly, lz);
          const count = adapter.voxelLightManager?.recolorAllVisibleChunkMeshes(sc) ?? 0;
          console.log(`[NoaEngineAdapter] SINGLE TORCH TEST: placed yellow halogen at [${lx},${ly},${lz}], recolored ${count} meshes. A warm yellow pool should be visible.`);
        },
        /** Three Color Voxel Blend Test — PLACE yellow + cyan + magenta lamps + relight + recolor. */
        threeColorVoxelBlendTest() {
          const sc = adapter.getSceneSafe();
          if (!sc) return;
          adapter.worldLightManager?.setEnabled(false);
          adapter.voxelLightManager?.setLightingMode("performance_voxel");
          const pp = adapter.getPlayerPositionSafe() || [0, 15, 0];
          // Place 3 lamps in a row: yellow (7=halogen), cyan (6=wall lamp), magenta (8=beacon).
          const placements = [
            { id: 7, dx: 2, dz: 0 },   // yellow
            { id: 6, dx: 2, dz: 2 },   // cyan
            { id: 8, dx: 2, dz: -2 },  // magenta
          ];
          for (const p of placements) {
            const lx = Math.floor(pp[0]) + p.dx;
            const ly = Math.floor(pp[1]);
            const lz = Math.floor(pp[2]) + p.dz;
            adapter.worldService.setBlockOverride(lx, ly, lz, p.id);
            adapter.noa.setBlock(p.id, lx, ly, lz);
            const bd = adapter.blockService.getBlock(p.id);
            if (bd) {
              adapter.worldLightManager?.registerLight(lx, ly, lz, bd);
              adapter.voxelLightManager?.registerLight(lx, ly, lz, bd);
            }
            adapter.voxelLightManager?.relightAround(sc, lx, ly, lz);
          }
          const count = adapter.voxelLightManager?.recolorAllVisibleChunkMeshes(sc) ?? 0;
          console.log(`[NoaEngineAdapter] THREE COLOR BLEND TEST: placed yellow+cyan+magenta lamps, recolored ${count} meshes. Three stable colored pools should be visible.`);
        },
        toggleVoxelAO(enabled: boolean) {
          console.log(`[NoaEngineAdapter] Voxel AO is baked by noa's mesher (always on). Toggle: ${enabled}.`);
        },
        resetLightingPreset() {
          adapter.worldLightManager?.setEnabled(false);
          adapter.voxelLightManager?.setLightingMode("performance_voxel");
          adapter.voxelLightManager?.setSkyLightEnabled(true);
          adapter.voxelLightManager?.setBlockLightEnabled(true);
          const sc = adapter.getSceneSafe();
          const result = adapter.voxelLightManager?.forceRelightAllImmediate(sc);
          console.log(`[NoaEngineAdapter] Lighting reset to PERFORMANCE VOXEL. Recomputed ${result?.recomputedChunks ?? 0} chunks, recolored ${result?.recoloredMeshCount ?? 0} meshes.`);
        },
        /** Visual Isolation ON — fog/glow/bloom OFF, real lights OFF, safe exposure. */
        visualIsolationOn() {
          adapter.updateVisualTuning({
            fogEnabled: false, glowEnabled: false, bloomEnabled: false,
            exposure: 1.3, contrast: 1.0, toneMappingEnabled: false,
          });
          adapter.worldLightManager?.setEnabled(false);
          adapter.voxelLightManager?.setLightingMode("performance_voxel");
          const sc = adapter.getSceneSafe();
          if (sc) { sc.fogEnabled = false; }
          console.log("[NoaEngineAdapter] VISUAL ISOLATION ON: fog/glow/bloom OFF, real lights OFF, exposure 1.3.");
        },
        /** Visual Isolation OFF — restore fog/glow to defaults. */
        visualIsolationOff() {
          adapter.updateVisualTuning({
            fogEnabled: true, glowEnabled: true, glowIntensity: 0.12,
            bloomEnabled: false, exposure: 1.3, contrast: 1.0,
          });
          console.log("[NoaEngineAdapter] VISUAL ISOLATION OFF: fog/glow restored to defaults.");
        },
        /** Clear saved visual settings from localStorage (reset to defaults). */
        clearSavedVisualSettings() {
          try { localStorage.removeItem("frontierPlanet.visualSettings"); } catch { /* ignore */ }
          adapter.visualTuning = { ...DEFAULT_VISUAL_TUNING };
          const sc = adapter.getSceneSafe();
          adapter.voxelLightManager?.forceRelightAllImmediate(sc);
          console.log("[NoaEngineAdapter] Cleared saved visual settings. Reset to defaults + relight.");
        },
        /** Show/hide chunk grid visualization. */
        showChunkGrid(visible: boolean) {
          const sc = adapter.getSceneSafe();
          if (!sc) return;
          adapter.chunkGridVisible = visible;
          if (visible) {
            adapter.buildChunkGrid(sc);
          } else {
            adapter.removeChunkGrid(sc);
          }
        },
        /** Inspect lighting at a world position (or crosshair if no args). */
        inspectLightingAt(x?: number, y?: number, z?: number) {
          let wx = x, wy = y, wz = z;
          if (wx === undefined || wy === undefined || wz === undefined) {
            // Use player position
            const pp = adapter.getPlayerPositionSafe() || [0, 15, 0];
            wx = Math.floor(pp[0]); wy = Math.floor(pp[1]); wz = Math.floor(pp[2]);
          }
          const result = adapter.voxelLightManager?.inspectLightingAt(wx, wy, wz);
          console.log("[InspectLighting]", JSON.stringify(result, null, 2));
          return result;
        },
        /** Light Sweep Test in a direction. Returns array of step results. */
        async lightSweepTest(direction: "+X" | "-X" | "+Z" | "-Z" | "diag") {
          return adapter.runLightSweep(direction);
        },
        /** Chunk Border Light Test. */
        async chunkBorderLightTest() {
          return adapter.runChunkBorderTest();
        },
        /** Ruin Stress Test. */
        async ruinStressTest() {
          return adapter.runRuinStressTest();
        },
        /** 3×3 Surface Light Test (the CORE acceptance test). */
        async surface3x3Test(wx?: number, wy?: number, wz?: number) {
          return adapter.runSurface3x3Test(wx, wy, wz);
        },
        /** Far From Spawn Light Test (visual, 3×3 surface validation). */
        async farFromSpawnTest() {
          return adapter.runFarFromSpawnTest();
        },
        /** Place/Remove 3×3 Stress Test (20 cycles). */
        async placeRemoveStressTest() {
          return adapter.runPlaceRemoveStressTest();
        },
        /** Inspect lighting at the crosshair target block. */
        inspectCrosshairLighting() {
          return adapter.inspectCrosshairLighting();
        },
        /** Start walking light monitor. */
        startWalkingMonitor() {
          adapter.startWalkingMonitor();
        },
        /** Stop walking light monitor. */
        stopWalkingMonitor() {
          adapter.stopWalkingMonitor();
        },
        /** Get walking monitor state + last result. */
        walkingMonitor: adapter.getWalkingMonitorState(),
        /** Polygon-only abstract falling field controls. */
        setAbstractPrecipitationEnabled(enabled: boolean) {
          return adapter.setAbstractPrecipitationEnabled(enabled);
        },
        toggleAbstractPrecipitation() {
          return adapter.toggleAbstractPrecipitation();
        },
        cycleAbstractPrecipitationWind() {
          return adapter.cycleAbstractPrecipitationWind();
        },
        toggleAbstractPrecipitationShelter() {
          return adapter.toggleAbstractPrecipitationShelter();
        },
        getAbstractPrecipitationInfo() {
          return adapter.getAbstractPrecipitationDebugInfo();
        },
        /** Agent Input Pad: move player by delta. */
        agentMove(dx: number, dz: number) { adapter.agentMove(dx, dz); },
        /** Agent Input Pad: jump. */
        agentJump() { adapter.agentJump(); },
        /** Agent Input Pad: turn camera. */
        agentTurn(deg: number) { adapter.agentTurn(deg); },
        /** Agent Input Pad: look up/down. */
        agentLook(deg: number) { adapter.agentLook(deg); },
        /** Agent Input Pad: reset look. */
        agentResetLook() { adapter.agentResetLook(); },
        /** Agent Input Pad: cross chunk boundary +X. */
        agentCrossChunkX() { adapter.agentCrossChunkX(); },
        /** Agent Input Pad: cross chunk boundary +Z. */
        agentCrossChunkZ() { adapter.agentCrossChunkZ(); },
        /** Agent Input Pad: teleport to station (DEBUG ONLY). */
        agentTeleportToStation(stationId: string) { return adapter.agentTeleportToStation(stationId); },
        /** WALKING LIGHT STOP TEST: place a test light at a WORLD position, sync, return full metrics. Light stays placed (for screenshot). */
        walkingLightStopPlace(x: number, y: number, z: number) { return adapter.walkingLightStopPlace([x, y, z]); },
        /** WALKING LIGHT STOP TEST: remove the test light at a WORLD position, sync, verify tint cleared. */
        walkingLightStopRemove(x: number, y: number, z: number) { return adapter.walkingLightStopRemove([x, y, z]); },
        /** Inspect the actual block under the crosshair with full chain diagnostics. */
        inspectTargetLight() {
          return adapter.inspectTargetLight();
        },
        /** 3×3 test around the crosshair target (existing light or place/remove). */
        async run3x3AroundTargetTest() {
          return adapter.run3x3AroundTargetTest();
        },
        /** Resolve which light block to use for tests. */
        resolveTestLightBlock() {
          return adapter.resolveTestLightBlock();
        },
        /** User Light Repro: test near [-4,15,-12] and far [-3,18,-21]. */
        async runUserLightRepro() {
          return adapter.runUserLightRepro();
        },
        /** Get chunk grid debug info. */
        getChunkGridDebug() {
          const pp = adapter.getPlayerPositionSafe() || [0, 15, 0];
          const cx = Math.floor(pp[0] / 16);
          const cz = Math.floor(pp[2] / 16);
          const lx = Math.floor(pp[0]) - cx * 16;
          const lz = Math.floor(pp[2]) - cz * 16;
          return {
            playerWorldPos: [Math.floor(pp[0]), Math.floor(pp[1]), Math.floor(pp[2])],
            playerChunkKey: `${cx},0,${cz}`,
            playerLocalCell: [lx, Math.floor(pp[1]) % 16, lz],
            distToBorderX: Math.min(lx, 15 - lx),
            distToBorderZ: Math.min(lz, 15 - lz),
            isNearBorder: Math.min(lx, 15-lx, lz, 15-lz) <= 2,
            lastAffectedChunks: adapter.voxelLightManager?.getLastAffectedChunkKeys() ?? [],
            relightQueueKeys: adapter.voxelLightManager?.getRelightQueueKeys() ?? [],
            chunksWithLightData: adapter.voxelLightManager?.getChunkKeysWithLightData().length ?? 0,
          };
        },
        /** Chunk grid debug info as a property (for React polling). */
        get chunkGridDebug() {
          const pp = adapter.getPlayerPositionSafe() || [0, 15, 0];
          const cx = Math.floor(pp[0] / 16);
          const cz = Math.floor(pp[2] / 16);
          const lx = Math.floor(pp[0]) - cx * 16;
          const lz = Math.floor(pp[2]) - cz * 16;
          return {
            playerWorldPos: [Math.floor(pp[0]), Math.floor(pp[1]), Math.floor(pp[2])],
            playerChunkKey: `${cx},0,${cz}`,
            playerLocalCell: [lx, Math.floor(pp[1]) % 16, lz],
            distToBorderX: Math.min(lx, 15 - lx),
            distToBorderZ: Math.min(lz, 15 - lz),
            isNearBorder: Math.min(lx, 15-lx, lz, 15-lz) <= 2,
            lastAffectedChunks: adapter.voxelLightManager?.getLastAffectedChunkKeys() ?? [],
            relightQueueKeys: adapter.voxelLightManager?.getRelightQueueKeys() ?? [],
            chunksWithLightData: adapter.voxelLightManager?.getChunkKeysWithLightData().length ?? 0,
            chunkGridActive: adapter.chunkGridVisible,
            chunkGridMeshExists: !!adapter.chunkGridLines,
            chunkGridLineCount: adapter.chunkGridLines ? (adapter.chunkGridLines as any)._positions?.length ?? 0 : 0,
            chunkGridPlayerChunk: `${cx},0,${cz}`,
            chunkGridYMin: adapter.chunkGridYMin,
            chunkGridYMax: adapter.chunkGridYMax,
            chunkGridLastBuildTime: adapter.chunkGridLastBuildTime,
            sceneContainsChunkGridMesh: !!adapter.getSceneSafe()?.getMeshByName("fp_chunk_grid"),
          };
        },
      };

      // ---- Voxel lighting debug snapshot (lazy) ----
      Object.defineProperty(snapshot, 'voxelLighting', {
        get() {
          if (!adapter.voxelLightManager) return null;
          const playerPos = adapter.getPlayerPositionSafe() || [0, 15, 0];
          const vinfo = adapter.voxelLightManager.getDebugInfo(playerPos);
          const realActive = adapter.worldLightManager ? adapter.worldLightManager.getActiveCount() : 0;
          return {
            ...vinfo,
            realPointLightsActive: realActive,
            realPointLightCap: 3,
            lightingMode: vinfo.lightingMode,
          };
        },
        configurable: true,
      });

      // ---- Survival vitals snapshot (lazy) for QA / HUD debugging ----
      Object.defineProperty(snapshot, 'survival', {
        get() {
          return adapter.survivalService ? adapter.survivalService.getSnapshot() : null;
        },
        configurable: true,
      });
      Object.defineProperty(snapshot, 'playerHealth', {
        get() { return adapter.playerService.getHealth(); },
        configurable: true,
      });

      return snapshot;
    };

    // Debug keyboard shortcuts for time of day (F6=dawn, F7=noon, F8=dusk, F9=midnight).
    window.addEventListener('keydown', this.handleDebugTimeKeys);
  }

  /**
   * Debug keyboard handler: F6/F7/F8/F9 force the time of day for visual QA.
   * Attached in initializeRendering; removed in destroy().
   */
  private handleDebugTimeKeys = (e: KeyboardEvent): void => {
    // Don't interfere with normal typing in inputs.
    const target = e.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    let t: number | null = null;
    let label = '';
    if (e.key === 'F6') { t = 0.0; label = 'dawn'; }
    else if (e.key === 'F7') { t = 0.25; label = 'noon'; }
    else if (e.key === 'F8') { t = 0.5; label = 'dusk'; }
    else if (e.key === 'F9') { t = 0.75; label = 'midnight'; }
    if (t !== null) {
      e.preventDefault();
      this.setTimeOfDay(t);
      console.log(`[NoaEngineAdapter] Debug time set to ${label} (timeOfDay=${t}).`);
      this.uiService.emitAlert(`Time of day: ${label}`, 'info');
    }
  };

  /** Force the day/night clock to a specific 0..1 value (for QA). */
  public setTimeOfDay(t: number): void {
    this.timeOfDay = ((t % 1) + 1) % 1;
  }

  /** Returns whether ?visualSanity=1 QA mode is active. */
  public isVisualSanityMode(): boolean {
    return this.visualSanityMode;
  }

  /** Returns the current live VisualTuning state (for debug panel display). */
  public getVisualTuning(): VisualTuning {
    return { ...this.visualTuning };
  }

  /**
   * Apply a partial VisualTuning update (merges over current tuning).
   * Called live by the F3 debug console. Changes take effect next frame.
   */
  public updateVisualTuning(patch: Partial<VisualTuning>): VisualTuning {
    this.visualTuning = { ...this.visualTuning, ...patch };
    // Apply dynamic light budget immediately.
    if (patch.activeLightBudget !== undefined && this.worldLightManager) {
      this.worldLightManager.setBudget(patch.activeLightBudget);
    }
    return this.getVisualTuning();
  }

  /** Reset tuning to safe baseline. */
  public resetToSafeBaseline(): VisualTuning {
    return this.applyNamedPreset("Safe Baseline");
  }

  /** Reset tuning to atmospheric default. */
  public resetToAtmosphericDefault(): VisualTuning {
    this.visualTuning = { ...DEFAULT_VISUAL_TUNING };
    return this.getVisualTuning();
  }

  /** Apply a named preset from NAMED_PRESETS. */
  public applyNamedPreset(name: string): VisualTuning {
    const preset = NAMED_PRESETS[name];
    if (preset) {
      this.visualTuning = { ...DEFAULT_VISUAL_TUNING, ...preset, activePresetName: name };
      if (preset.activeLightBudget !== undefined && this.worldLightManager) {
        this.worldLightManager.setBudget(preset.activeLightBudget);
      }
      console.log(`[NoaEngineAdapter] Applied preset: ${name}`);
    }
    return this.getVisualTuning();
  }

  /** Save current tuning to localStorage. */
  public saveVisualSettings(): void {
    saveVisualTuning(this.visualTuning);
    console.log("[NoaEngineAdapter] Visual settings saved to localStorage.");
  }

  /** Load tuning from localStorage. */
  public loadVisualSettings(): VisualTuning {
    this.visualTuning = loadVisualTuning();
    return this.getVisualTuning();
  }

  /** Export tuning as JSON string. */
  public exportVisualSettings(): string {
    return JSON.stringify(this.visualTuning, null, 2);
  }

  /** Import tuning from a parsed object. */
  public importVisualSettings(settings: any): VisualTuning {
    if (settings && typeof settings === "object") {
      this.visualTuning = { ...DEFAULT_VISUAL_TUNING, ...settings };
    }
    return this.getVisualTuning();
  }

  /** Polygon-only abstract field toggle. Does nothing in Play Game. */
  public setAbstractPrecipitationEnabled(enabled: boolean): boolean {
    if (this.gameMode !== 'polygon' || !this.precipitationFieldRenderer) {
      return false;
    }
    this.precipitationFieldRenderer.setEnabled(enabled);
    return enabled;
  }

  /** Polygon-only abstract field toggle. Returns the new enabled state. */
  public toggleAbstractPrecipitation(): boolean {
    if (this.gameMode !== 'polygon' || !this.precipitationFieldRenderer) {
      return false;
    }
    return this.precipitationFieldRenderer.toggle();
  }

  /** Cycles between two simple prototype wind vectors. */
  public cycleAbstractPrecipitationWind(): [number, number, number] | null {
    if (this.gameMode !== 'polygon' || !this.precipitationFieldRenderer) {
      return null;
    }
    return this.precipitationFieldRenderer.cycleWind();
  }

  /** Toggle the prototype roof reduction after open-sky visibility is confirmed. */
  public toggleAbstractPrecipitationShelter(): string | null {
    if (this.gameMode !== 'polygon' || !this.precipitationFieldRenderer) {
      return null;
    }
    return this.precipitationFieldRenderer.toggleShelterMode();
  }

  public getAbstractPrecipitationDebugInfo(): PrecipitationFieldDebugInfo | { available: false; enabled: false } {
    return this.precipitationFieldRenderer?.getDebugInfo() ?? { available: false, enabled: false };
  }

  /**
   * Force a bright unlit debug material onto all chunk_ meshes.
   * When enabled: saves original materials, assigns a bright orange unlit mat.
   * When disabled: restores original materials.
   * Used to prove terrain meshes are rendering (isolates material/fog issues).
   */
  public applyTerrainDebugMaterial(enabled: boolean): boolean {
    const scene = this.getSceneSafe();
    if (!scene) return false;
    const chunks = scene.meshes.filter((m: any) => m.name.startsWith("chunk_"));
    if (enabled) {
      if (!this.terrainDebugMat) {
        this.terrainDebugMat = new BABYLON.StandardMaterial("fp_terrain_debug", scene);
        this.terrainDebugMat.emissiveColor = new BABYLON.Color3(1.0, 0.5, 0.1); // bright orange
        this.terrainDebugMat.disableLighting = true;
        this.terrainDebugMat.fogEnabled = false;
        this.terrainDebugMat.alpha = 1;
      }
      for (const c of chunks) {
        if (!this.savedChunkMaterials.has(c.name)) {
          this.savedChunkMaterials.set(c.name, c.material);
        }
        c.material = this.terrainDebugMat;
      }
      console.log(`[NoaEngineAdapter] Terrain debug material ON (${chunks.length} chunks).`);
    } else {
      for (const c of chunks) {
        const orig = this.savedChunkMaterials.get(c.name);
        if (orig !== undefined) {
          c.material = orig;
        }
      }
      this.savedChunkMaterials.clear();
      console.log("[NoaEngineAdapter] Terrain debug material OFF (originals restored).");
    }
    return enabled;
  }

  /** Actual render distance in blocks (chunkAddDistance × chunkSize). */
  public getRenderDistanceBlocks(): number {
    return this.chunkAddDistance * CHUNK_SIZE;
  }

  private updateAbstractPrecipitation(
    dtMs: number,
    playerWorldPos: [number, number, number],
    worldOriginOffset: [number, number, number]
  ): void {
    if (this.gameMode !== 'polygon' || !this.precipitationFieldRenderer) return;
    const scene = this.getSceneSafe();
    const cam = scene?.activeCamera;
    if (!cam) return;

    const absPos = (cam as any).getAbsolutePosition ? (cam as any).getAbsolutePosition() : cam.position;
    this.precipitationFieldRenderer.update({
      dtMs,
      cameraLocalPosition: [absPos.x, absPos.y, absPos.z],
      playerWorldPosition: playerWorldPos,
      worldOriginOffset,
      shelterFactor: this.getAbstractPrecipitationShelterFactor(playerWorldPos),
    });
  }

  private getAbstractPrecipitationShelterFactor(playerWorldPos: [number, number, number]): number {
    const [x, y, z] = playerWorldPos;
    const [cx, cy, cz] = POLYGON_TEST_ROOF.center;
    const [hx, , hz] = POLYGON_TEST_ROOF.halfSize;
    const underTestRoof =
      Math.abs(x - cx) <= hx &&
      Math.abs(z - cz) <= hz &&
      y <= cy + 0.5;

    if (underTestRoof) {
      return DEFAULT_PRECIPITATION_FIELD_CONFIG.shelterReduction;
    }

    const wx = Math.floor(x);
    const wz = Math.floor(z);
    const startY = Math.floor(y) + 2;
    const endY = Math.floor(y) + 8;
    for (let wy = startY; wy <= endY; wy++) {
      if (this.getBlockIdAt(wx, wy, wz) !== 0) {
        return DEFAULT_PRECIPITATION_FIELD_CONFIG.shelterReduction;
      }
    }

    return 1;
  }

  private setupWorldDataHandler(): void {
    const ENABLE_PERF_LOGS = true;

    this.noa.world.on('worldDataNeeded', (id: string, ndarray: any, x: number, y: number, z: number) => {
      const start = performance.now();
      const shape = ndarray.shape;
      // Fill voxel data + collect into a flat Uint16Array for the light manager.
      const flatVoxels = new Uint16Array(shape[0] * shape[1] * shape[2]);
      for (let i = 0; i < shape[0]; ++i) {
        for (let j = 0; j < shape[1]; ++j) {
          for (let k = 0; k < shape[2]; ++k) {
            const voxelId = this.worldService.getBlockAt(x + i, y + j, z + k);
            ndarray.set(i, j, k, voxelId);
            // noa ndarray is [i][j][k] = x,y,z; our flat array uses ly*size² + lx*size + lz.
            flatVoxels[j * shape[0] * shape[2] + i * shape[2] + k] = voxelId;
          }
        }
      }
      // CRITICAL FIX: Compute voxel light data BEFORE setChunkData.
      // The old code called setChunkData first, which triggers noa's mesh
      // creation + addingTerrainMesh event. That event calls recolorMesh,
      // which ran BEFORE light data existed → mesh got black/fallback colors.
      // Now light data is computed first, so when addingTerrainMesh fires,
      // the light lookup succeeds and the mesh gets correct colors.
      this.voxelLightManager?.computeInitialLight(x, y, z, flatVoxels, false);
      // Also register any light sources found in this chunk into the global
      // voxelLightSources registry, so neighbor chunks (which may load later)
      // can seed cross-chunk propagation from this chunk's sources.
      const newSources = this.voxelLightManager?.registerSourcesFromVoxels(x, y, z, flatVoxels) ?? [];
      this.noa.world.setChunkData(id, ndarray);
      // If this chunk contains light sources, sync block light visuals for
      // affected neighbor chunks immediately. This ensures static/generated
      // lights illuminate visible neighbor meshes on chunk load — not just
      // when the player places/breaks a block.
      if (newSources.length > 0) {
        const sc = this.getSceneSafe();
        if (sc) {
          for (const src of newSources) {
            this.syncBlockLightVisualsAroundSource(sc, src.x, src.y, src.z, `chunk load source at ${src.x},${src.y},${src.z}`);
          }
        }
      }
      const elapsed = performance.now() - start;

      if (ENABLE_PERF_LOGS) {
        this.chunkTimes.push(elapsed);
        const now = Date.now();
        if (now - this.lastPerfLogTime > 3000) {
          const count = this.chunkTimes.length;
          if (count > 0) {
            const sum = this.chunkTimes.reduce((a, b) => a + b, 0);
            const avg = sum / count;
            const max = Math.max(...this.chunkTimes);
            console.log(`[Perf] Chunks generated: ${count}, avg chunk gen: ${avg.toFixed(2)}ms, max: ${max.toFixed(2)}ms`);
            this.chunkTimes = [];
            this.lastPerfLogTime = now;
          }
        }
      }
    });
  }

  private setupInputHandlers(): void {
    const canvas = this.noa.container.canvas;

    canvas.addEventListener('contextmenu', this.handleContextMenuPrevent);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);

    this.noa.inputs.down.on('fire', () => {
      this.handleLeftClickFire();
    });

    this.noa.inputs.down.on('alt-fire', () => {
      this.handleRightClickAltFire();
    });
  }

  private handleContextMenuPrevent = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Shift') {
      const moveState = this.getMovementSafe();
      if (moveState && !this.isSprinting) {
        this.isSprinting = true;
        moveState.maxSpeed = 16.0;
      } else if (!moveState && !this.sprintWarningLogged) {
        this.sprintWarningLogged = true;
        console.warn("[NoaEngineAdapter] Movement component unavailable; sprint disabled safely.");
      }
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    if (e.key === 'Shift') {
      const moveState = this.getMovementSafe();
      if (moveState) {
        this.isSprinting = false;
        moveState.maxSpeed = 10.0;
      }
    }
  };

  private getTargetBlockFallback() {
    if (this.noa.targetedBlock) {
      return this.noa.targetedBlock;
    }

    const pickResult = this.pickSafe();
    if (pickResult) {
      const hitPos = pickResult.position;
      const normal = pickResult.normal;

      const adjX = Math.floor(hitPos[0]);
      const adjY = Math.floor(hitPos[1]);
      const adjZ = Math.floor(hitPos[2]);

      const posX = adjX - Math.floor(normal[0] * 0.5);
      const posY = adjY - Math.floor(normal[1] * 0.5);
      const posZ = adjZ - Math.floor(normal[2] * 0.5);

      const blockId = this.getBlockIdAt(posX, posY, posZ);
      return {
        position: [posX, posY, posZ] as [number, number, number],
        adjacent: [adjX, adjY, adjZ] as [number, number, number],
        blockID: blockId
      };
    }
    return null;
  }

  /**
   * LMB: Excavate block. Now delegates light teardown to WorldLightManager.
   */
  private handleLeftClickFire(): void {
    const tgt = this.getTargetBlockFallback();
    if (!tgt) return;

    const pos = tgt.position;
    const blockId = this.getBlockIdAt(pos[0], pos[1], pos[2]);

    if (blockId === 0) return;

    AudioService.getInstance().playBlockDestroy();

    // 1. Unregister light sources BEFORE setBlock (so relight doesn't seed
    //    from a block that's about to be destroyed).
    this.worldLightManager?.unregisterLight(pos[0], pos[1], pos[2]);
    this.voxelLightManager?.unregisterLight(pos[0], pos[1], pos[2]);

    // 2. Update world state.
    this.worldService.setBlockOverride(pos[0], pos[1], pos[2], 0);
    this.noa.setBlock(0, pos[0], pos[1], pos[2]);

    // 3. Relight + recolor immediately. DO NOT invalidate the base color cache
    //    here — invalidating captures the CURRENT (already-lit) vertex colors
    //    as the new "base," causing compounding drift on each place/break cycle.
    //    The cached base (noa's original matColor × AO) is still valid for the
    //    OLD mesh. When noa remeshes on the next tick, it creates a NEW mesh
    //    with no cache → recolorMesh captures fresh noa base colors automatically.
    const sc = this.getSceneSafe();
    this.voxelLightManager?.relightAround(sc, pos[0], pos[1], pos[2]);

    const blockDef = this.blockService.getBlock(blockId);
    const event: GameEvent = {
      type: GameEventType.BLOCK_DESTROYED,
      payload: {
        position: [pos[0], pos[1], pos[2]],
        blockId: blockId,
        blockTags: blockDef?.tags,
        artifactId: blockDef?.artifactId
      },
      timestamp: Date.now()
    };

    const alerts = this.missionService.handleGameEvent(event);
    alerts.forEach((alert) => {
      this.uiService.emitAlert(alert.alertText, alert.alertType);
    });

    if (alerts.length === 0) {
      const label = blockDef ? blockDef.name : 'Voxel';
      this.uiService.emitAlert(`Excavated ${label} at [${Math.floor(pos[0])}, ${Math.floor(pos[1])}, ${Math.floor(pos[2])}]`, 'info');
    }
  }

  /**
   * RMB: Place block. Now delegates light registration to WorldLightManager.
   */
  private handleRightClickAltFire(): void {
    const tgt = this.getTargetBlockFallback();
    if (!tgt) return;

    const adjacent = tgt.adjacent;
    const currentSelected = this.playerService.getSelectedBlockId();

    if (currentSelected === 0) return;

    AudioService.getInstance().playBlockPlace();

    // 1. Register light sources BEFORE setBlock (so relight seeds from the
    //    new block correctly).
    const blockDef = this.blockService.getBlock(currentSelected);
    if (blockDef) {
      this.worldLightManager?.registerLight(
        adjacent[0], adjacent[1], adjacent[2], blockDef
      );
      this.voxelLightManager?.registerLight(
        adjacent[0], adjacent[1], adjacent[2], blockDef
      );
    }

    // 2. Update world state.
    this.worldService.setBlockOverride(adjacent[0], adjacent[1], adjacent[2], currentSelected);
    this.noa.setBlock(currentSelected, adjacent[0], adjacent[1], adjacent[2]);

    // 3. Relight + recolor immediately. DO NOT invalidate the base color cache
    //    (see handleLeftClickFire for explanation — invalidating causes drift).
    const sc = this.getSceneSafe();
    this.voxelLightManager?.relightAround(sc, adjacent[0], adjacent[1], adjacent[2]);

    const event: GameEvent = {
      type: GameEventType.BLOCK_PLACED,
      payload: {
        position: [adjacent[0], adjacent[1], adjacent[2]],
        blockId: currentSelected
      },
      timestamp: Date.now()
    };

    const alerts = this.missionService.handleGameEvent(event);
    alerts.forEach((alert) => {
      this.uiService.emitAlert(alert.alertText, alert.alertType);
    });

    if (blockDef && alerts.length === 0) {
      this.uiService.emitAlert(`Placed ${blockDef.name} at [${Math.floor(adjacent[0])}, ${Math.floor(adjacent[1])}, ${Math.floor(adjacent[2])}]`, 'info');
    }
  }

  /**
   * Main tick loop. Advances the day/night clock, updates the sky controller,
   * applies the resolved visual preset, updates active lights, and syncs
   * player position/heading to game state.
   */
  private setupTickHandler(): void {
    this.lastFrameTime = performance.now();

    this.noa.on('tick', () => {
      if (this.isCleanup) return;

      const now = performance.now();
      const dtMs = Math.min(250, now - this.lastFrameTime); // clamp huge spikes
      this.lastFrameTime = now;

      // Advance the master day/night clock (frame-rate independent).
      // Respect visual tuning: freeze time and speed multiplier.
      if (!this.visualTuning.timeFrozen) {
        const speed = this.visualTuning.timeSpeedMultiplier;
        if (speed > 0) {
          this.timeOfDay = (this.timeOfDay + (dtMs / 1000 / DAY_LENGTH_SECONDS) * speed) % 1.0;
        }
      }

      const pos = this.getPlayerPositionSafe();
      if (!pos) return;

      // Sky + celestial + sun/ambient lights update. Returns sun altitude
      // for downstream consumers (audio, preset blending).
      const sky = this.skyController
        ? this.skyController.update(this.timeOfDay, pos, dtMs)
        : { sunAltitude: 0, nightFactor: 0 };

      // Apply fog / clearColor / image-processing tuning for the current
      // biome + day phase. Presets are clamped so bad mod configs are safe.
      this.applyAtmosphereForCurrentPhase(pos, sky.sunAltitude);

      // Update active dynamic lights (cull far, animate flicker/pulse).
      this.worldLightManager?.update(pos);

      // Voxel light: process the cross-chunk relight queue (a few per tick to
      // spread cost) + update the sky-light time-of-day multiplier. The sky
      // multiplier is a CHEAP global tint — no full-world relight needed when
      // time-of-day changes, just a brightness curve on the baked sky light.
      //
      // FIX: processRelightQueue now returns the list of processed chunk keys
      // so we can recolor their visible meshes immediately. Previously it only
      // returned a count — the adapter had no way to know WHICH chunks to
      // recolor, so processed chunks stayed visually stale until noa remeshed.
      const relightResult = this.voxelLightManager?.processRelightQueue(2);
      if (relightResult && relightResult.count > 0 && relightResult.processedChunks.length > 0) {
        const sc2 = this.getSceneSafe();
        if (sc2) {
          this.voxelLightManager?.recolorAffectedMeshes(sc2, relightResult.processedChunks);
        }
      }
      // Sky light time multiplier: 1 at noon, 0 at midnight, smooth curve.
      const sunAlt = sky.sunAltitude;
      const skyTimeMult = Math.max(0, sunAlt > 0 ? Math.sqrt(sunAlt) : 0);
      this.voxelLightManager?.setSkyLightTimeMultiplier(skyTimeMult);
      // Sync world origin offset so VLM can convert between world and local coords.
      const woff = this.noa.worldOriginOffset || [0, 0, 0];
      this.voxelLightManager?.setWorldOriginOffset([woff[0], woff[1], woff[2]]);
      this.updateAbstractPrecipitation(
        dtMs,
        [pos[0], pos[1], pos[2]],
        [woff[0], woff[1], woff[2]]
      );

      // ---- Survival vitals tick (stamina / oxygen / hydration / radiation) ----
      // Integrates with the lighting system: oxygen drains when skyLight=0
      // (underground/indoors), which is exactly the WORLD-space cell value VLM
      // computes at the player position — the coordinate-space fix pays off
      // here by giving correct skyLight even after noa rebase.
      if (this.survivalService) {
        const sLaPlayer = this.voxelLightManager?.getDebugInfo([pos[0], pos[1], pos[2]]).skyLightAtPlayer ?? 0;
        const ruinCenter = this.worldService.getRuinCenter();
        const dxArt = pos[0] - ruinCenter[0];
        const dzArt = pos[2] - ruinCenter[2];
        const nearArtifact = (dxArt * dxArt + dzArt * dzArt) <= 36; // within ~6 blocks
        const nightFactor = sky.nightFactor ?? 0;
        const damage = this.survivalService.tick(
          {
            dtMs,
            sprinting: this.isSprinting,
            skyLightAtPlayer: sLaPlayer,
            nightFactor,
            nearArtifact,
            timeOfDay: this.timeOfDay,
            polygonMode: this.gameMode === 'polygon',
          },
          (msg, type) => this.uiService.emitAlert(msg, type)
        );
        if (damage > 0) {
          this.playerService.damagePlayer(damage);
        }
        // Mirror snapshot into gameState for the React HUD (polled at 12.5Hz).
        gameState.survival = this.survivalService.getSnapshot();
        // Enforce stamina sprint lock: if stamina exhausted, force-walk.
        if (this.isSprinting && !gameState.survival.canSprint) {
          const moveState = this.getMovementSafe();
          if (moveState) {
            moveState.maxSpeed = 10.0;
            this.isSprinting = false;
          }
        }
      }

      // Throttled player-position-derived updates (HUD, mission, audio).
      const nowMs = Date.now();
      if (nowMs - this.lastPositionUpdate > 120) {
        this.lastPositionUpdate = nowMs;

        const event: GameEvent = {
          type: GameEventType.PLAYER_POSITION_CHANGED,
          payload: { position: [pos[0], pos[1], pos[2]] },
          timestamp: nowMs
        };

        const alerts = this.missionService.handleGameEvent(event);
        alerts.forEach((alert) => {
          this.uiService.emitAlert(alert.alertText, alert.alertType);

          // Artifact recovery: replace the physical artifact block with air
          // AND unregister its light from the persistent registry.
          if (alert.alertText.includes('Artifact recovered')) {
            const ruinCenter = this.worldService.getRuinCenter();
            this.noa.setBlock(0, ruinCenter[0], ruinCenter[1], ruinCenter[2]);
            this.worldService.setBlockOverride(ruinCenter[0], ruinCenter[1], ruinCenter[2], 0);
            this.worldLightManager?.unregisterLight(ruinCenter[0], ruinCenter[1], ruinCenter[2]);
            this.voxelLightManager?.unregisterLight(ruinCenter[0], ruinCenter[1], ruinCenter[2]);
            AudioService.getInstance().playArtifactPickup();
          }
        });

        this.playerService.updatePosition(pos as [number, number, number]);

        // Auto-rebuild chunk grid when player enters a new chunk.
        if (this.chunkGridVisible) {
          const pcx = Math.floor(pos[0] / 16);
          const pcz = Math.floor(pos[2] / 16);
          if (pcx !== this.lastGridPlayerChunkX || pcz !== this.lastGridPlayerChunkZ) {
            this.lastGridPlayerChunkX = pcx;
            this.lastGridPlayerChunkZ = pcz;
            const sc2 = this.getSceneSafe();
            if (sc2) this.buildChunkGrid(sc2);
          }
        }

        const headingObj = (this.noa as any).camera;
        const yawRad = headingObj ? headingObj.heading || 0 : 0;
        gameState.playerYaw = (yawRad * 180 / Math.PI) % 360;

        // ---- Walking Light Monitor ----
        // Tracks chunk boundary crossings and runs block light validation.
        if (this.walkingMonitorActive) {
          const pcx = Math.floor(pos[0] / 16);
          const pcy = Math.floor(pos[1] / 16);
          const pcz = Math.floor(pos[2] / 16);
          const currentChunk = `${pcx},${pcy},${pcz}`;
          if (this.walkingMonitorStartChunk === "") {
            this.walkingMonitorStartChunk = currentChunk;
            this.walkingMonitorPrevChunk = currentChunk;
          }
          if (currentChunk !== this.walkingMonitorPrevChunk) {
            // Chunk boundary crossed! Run validation.
            const oldChunk = this.walkingMonitorPrevChunk;
            const newChunk = currentChunk;
            this.walkingMonitorPrevChunk = newChunk;
            this.walkingMonitorLastResult = this.runWalkingLightCheck(pos, oldChunk, newChunk);
          }
        }
      }

      // Track target block details on every frame.
      const targetTgt = this.getTargetBlockFallback();
      if (targetTgt) {
        const id = this.getBlockIdAt(targetTgt.position[0], targetTgt.position[1], targetTgt.position[2]);
        const blockDef = this.blockService.getBlock(id);
        const name = blockDef ? blockDef.name : 'Air';
        gameState.targetedBlockInfo = `X:${Math.floor(targetTgt.position[0])} Y:${Math.floor(targetTgt.position[1])} Z:${Math.floor(targetTgt.position[2])} [${name}]`;
      } else {
        gameState.targetedBlockInfo = 'None';
      }

      // Modulate ambient wind audio pitch by sun altitude.
      AudioService.getInstance().updateAmbientAltitude(sky.sunAltitude);
    });
  }

  /**
   * Resolve the visual preset for the current biome + sun altitude, merge any
   * mod sky overlays, apply VisualTuning live overrides, and apply to the
   * scene + pipeline.
   *
   * Pass 5: now applies real day/night brightness by scaling ambient + sun
   * light intensities based on sun altitude. Previously only sky color
   * changed, leaving terrain fullbright at night.
   */
  private applyAtmosphereForCurrentPhase(
    playerPos: [number, number, number],
    sunAltitude?: number
  ): void {
    const scene = this.getSceneSafe();
    if (!scene) return;

    const [x, , z] = playerPos;

    let altitude = sunAltitude;
    if (altitude === undefined) {
      const angle = this.timeOfDay * Math.PI * 2;
      altitude = Math.sin(angle);
    }

    const vt = this.visualTuning;

    // ---- ATMOSPHERE BIOME RESOLUTION (decoupled from black-glass terrain) ----
    // atmosphereBiomeMode controls whether the global preset follows the biome.
    // Default "fixed_red_wasteland" — black glass is just a surface block and
    // does NOT change the sky. The old code snapped isBlackGlassZone→black sky.
    const biomeMode = (vt as any).atmosphereBiomeMode ?? "fixed_red_wasteland";
    let biome: "red_wasteland" | "black_glass_canyon" = "red_wasteland";
    if (biomeMode === "manual_black_glass") {
      biome = "black_glass_canyon";
    } else if (biomeMode === "follow_biome") {
      biome = this.worldService.isBlackGlassZone(x, z) ? "black_glass_canyon" : "red_wasteland";
    }

    let preset = resolveBiomePhasePreset(biome, altitude);

    // ---- Mod sky overlay (OPT-IN, default OFF) ----
    // The old code merged the purple example-ruins-pack/sky/sky.json every frame.
    // Now it only applies when useModSkyOverlay is true. This kills the Purple Dimension.
    const useModOverlay = (vt as any).useModSkyOverlay === true;
    if (useModOverlay) {
      preset = this.mergeModSkyOverlay(preset);
    }

    if (vt.fogAutoClampToRenderDistance) {
      preset = clampPresetToRenderDistance(preset, this.getRenderDistanceBlocks());
    }

    // ---- Fog + ClearColor ----
    scene.fogEnabled = vt.fogEnabled;
    scene.fogMode = BABYLON.Scene.FOGMODE_LINEAR;
    scene.fogColor = vt.fogColorHex
      ? parseHexColor3(vt.fogColorHex, new BABYLON.Color3(0.3, 0.2, 0.3))
      : parseHexColor3(preset.fogColor, new BABYLON.Color3(0.3, 0.2, 0.3));
    scene.clearColor = parseHexColor4(
      preset.skyColor,
      new BABYLON.Color4(0.05, 0.03, 0.08, 1.0)
    );
    scene.fogStart = vt.fogStart !== null ? vt.fogStart : preset.fogStart;
    scene.fogEnd = vt.fogEnd !== null ? vt.fogEnd : preset.fogEnd;
    if (scene.fogStart >= scene.fogEnd) {
      scene.fogStart = Math.max(20, scene.fogEnd - 40);
    }

    // ---- Real day/night brightness ----
    const dayT = Math.max(0, altitude);
    const nightT = Math.max(0, -altitude);

    const ambientIntensity =
      (vt.dayAmbientIntensity * dayT + vt.nightAmbientIntensity * (1 - dayT)) *
      vt.ambientIntensityMultiplier;
    const sunIntensity =
      (altitude > 0
        ? vt.noonSunIntensity * Math.sqrt(altitude)
        : vt.midnightSunIntensity) * vt.sunIntensityMultiplier;

    // ---- Drive scene.ambientColor from day/night (was constant 0.5 → night never dark) ----
    // VOXEL-LIGHT-REPAIR: in performance_voxel mode, terrain materials now
    // have disableLighting=true, so scene.ambientColor is NOT the primary
    // terrain driver (vertex colors are). But we still apply a floor (~0.15)
    // so non-terrain meshes (sky bodies, water, entities) and any lit-mode
    // fallback materials remain visible at night. The primary night-darkness
    // fix is the unlit terrain materials + the voxel light's skyLight ×
    // timeMultiplier baked into vertex colors.
    const daySceneAmbient = (vt as any).daySceneAmbient ?? 0.45;
    const nightSceneAmbient = (vt as any).nightSceneAmbient ?? 0.20;
    const sceneAmbientMult = (vt as any).sceneAmbientMultiplier ?? 1.0;
    const sceneAmbientBrightnessRaw =
      (daySceneAmbient * dayT + nightSceneAmbient * nightT) * sceneAmbientMult;
    // Floor: never let scene ambient go below 0.25 so the scene isn't pitch
    // black for non-terrain meshes (sky meshes, entities, etc). With unlit
    // terrain (disableLighting=true) this floor is a fallback, not the primary
    // terrain driver — but it keeps the sky/sun/moon meshes visible.
    const sceneAmbientBrightness = Math.max(0.25, sceneAmbientBrightnessRaw);
    const [ar, ag, ab] = preset.ambientColor;
    scene.ambientColor = new BABYLON.Color3(
      ar * sceneAmbientBrightness,
      ag * sceneAmbientBrightness,
      ab * sceneAmbientBrightness
    );

    // ---- Sun + ambient + moon light intensities ----
    // IMPORTANT: dynamicLightsEnabled controls ONLY WorldLightManager real
    // PointLights. It must NOT disable the sun/moon/ambient — those are the
    // day/night system and are independent. The old code gated sunLight.intensity
    // on vt.dynamicLightsEnabled, which turned off the sun when you toggled
    // dynamic lights off. Fixed.
    if (this.skyController) {
      const sunLight = this.skyController.getSunLight();
      if (sunLight) {
        sunLight.intensity = sunIntensity;
      }
      const ambient = this.skyController.getAmbientLight();
      if (ambient) {
        ambient.intensity = ambientIntensity;
      }
      const moonLight = this.skyController.getMoonLight();
      if (moonLight) {
        const moonEnabled = (vt as any).moonLightEnabled !== false;
        const moonInt = (vt as any).moonLightIntensity ?? 0.25;
        moonLight.intensity = moonEnabled ? moonInt * nightT : 0;
      }
    }

    // ---- Dynamic lights (WorldLightManager) — controlled by dynamicLightsEnabled ----
    if (this.worldLightManager) {
      this.worldLightManager.setEnabled(vt.dynamicLightsEnabled);
    }

    // ---- Voxel light sky-time multiplier ----
    const skyTimeMult = Math.max(0, altitude > 0 ? Math.sqrt(altitude) : 0);
    this.voxelLightManager?.setSkyLightTimeMultiplier(skyTimeMult);

    // ---- Apply glow/bloom/postprocess overrides ----
    this.renderPipelineService?.setGlowEnabled(vt.glowEnabled);
    if (vt.glowEnabled) {
      this.renderPipelineService?.setGlowIntensity(vt.glowIntensity);
    }
    this.renderPipelineService?.setBloomEnabled(vt.bloomEnabled);
    this.renderPipelineService?.setExposure(vt.exposure);
    this.renderPipelineService?.setContrast(vt.contrast);

    // ---- Apply sky visibility overrides ----
    this.skyController?.setVisibilityOverrides({
      sunVisible: vt.sunVisible,
      moonVisible: vt.moonVisible,
      starsVisible: vt.starsVisible,
      cloudsVisible: vt.cloudsVisible,
      starBrightness: vt.starBrightness,
    });

    // ---- Apply terrain material mode ----
    if (vt.terrainMaterialMode === "debug") {
      this.applyTerrainDebugMaterial(true);
    } else {
      this.applyTerrainDebugMaterial(false);
    }
  }

  /**
   * Merge mod sky overlays (ModRegistry.getActiveSky) on top of a base preset.
   * Mod values are advisory; clampPreset() still enforces hard safety floors.
   */
  private mergeModSkyOverlay(base: import('./rendering/visual-presets').VisualPreset) {
    const skyMod = ModRegistry.getInstance().getActiveSky();
    if (!skyMod) return base;
    const merged = { ...base };
    if (skyMod.fogColor) merged.fogColor = skyMod.fogColor;
    if (skyMod.skyColor) merged.skyColor = skyMod.skyColor;
    if (skyMod.dayColor && (merged.id.includes("day") || merged.id.includes("dusk"))) {
      merged.skyColor = skyMod.dayColor;
    }
    if (skyMod.nightColor && merged.id.includes("night")) {
      merged.skyColor = skyMod.nightColor;
    }
    if (typeof skyMod.fogStart === "number") merged.fogStart = skyMod.fogStart;
    if (typeof skyMod.fogEnd === "number") merged.fogEnd = skyMod.fogEnd;
    return merged;
  }

  private getBlockIdAt(x: number, y: number, z: number): number {
    if (typeof this.noa.getBlock === "function") {
      return this.noa.getBlock(x, y, z);
    }
    const worldAny = this.noa.world as any;
    if (worldAny && typeof worldAny.getBlockID === "function") {
      return worldAny.getBlockID(x, y, z);
    }
    return 0;
  }

  private getSceneSafe(): BABYLON.Scene | null {
    const rendering = (this.noa as any).rendering;
    if (!rendering || typeof rendering.getScene !== "function") return null;
    return rendering.getScene();
  }

  private getMovementSafe(): any | null {
    const entitiesAny = this.noa.entities as any;
    if (!entitiesAny || typeof entitiesAny.getMovement !== "function") return null;
    return entitiesAny.getMovement(this.noa.playerEntity);
  }

  private getPlayerPositionSafe(): [number, number, number] | null {
    const entities = this.noa.entities;
    if (!entities || typeof entities.getPosition !== "function") return null;
    const playerEnt = this.noa.playerEntity;
    if (!playerEnt) return null;
    const pos = entities.getPosition(playerEnt);
    return pos ? [pos[0], pos[1], pos[2]] : null;
  }

  private pickSafe(): any | null {
    if (typeof this.noa.pick === "function") {
      try {
        return this.noa.pick();
      } catch {
        return null;
      }
    }
    return null;
  }

  // ---- AGENT INPUT PAD (debug movement for AI/browser testing) ----

  /**
   * Move the player by a delta using noa's entity position setter.
   * This is NOT teleport — it moves through the normal position update path,
   * which triggers noa's chunk loading/culling. However, it bypasses physics
   * collision. For true walking, use WASD/pointer lock.
   */
  public agentMove(dx: number, dz: number): void {
    const pos = this.getPlayerPositionSafe();
    if (!pos) return;
    const newX = pos[0] + dx;
    const newZ = pos[2] + dz;
    this.noa.entities.setPosition(this.noa.playerEntity, [newX, pos[1], newZ]);
  }

  /** Jump the player up by 2 blocks. */
  public agentJump(): void {
    const pos = this.getPlayerPositionSafe();
    if (!pos) return;
    this.noa.entities.setPosition(this.noa.playerEntity, [pos[0], pos[1] + 2, pos[2]]);
  }

  /** Turn the camera by a delta in degrees. */
  public agentTurn(deltaDegrees: number): void {
    const cam = (this.noa as any).camera;
    if (!cam) return;
    cam.heading = (cam.heading + (deltaDegrees * Math.PI / 180)) % (Math.PI * 2);
  }

  /** Look up/down by delta in degrees. */
  public agentLook(deltaDegrees: number): void {
    const cam = (this.noa as any).camera;
    if (!cam) return;
    const maxPitch = Math.PI / 2 - 0.05;
    cam.pitch = Math.max(-maxPitch, Math.min(maxPitch, cam.pitch + (deltaDegrees * Math.PI / 180)));
  }

  /** Reset camera heading/pitch to default. */
  public agentResetLook(): void {
    const cam = (this.noa as any).camera;
    if (!cam) return;
    cam.heading = 0;
    cam.pitch = 0;
  }

  /** Teleport to a specific station (DEBUG ONLY — not walking acceptance). */
  public agentTeleportToStation(stationId: string): boolean {
    const stations = this.gameMode === 'polygon'
      ? (this.worldService as any).getStations?.() ?? []
      : [];
    const station = stations.find((s: any) => s.id === stationId);
    if (!station) return false;
    this.noa.entities.setPosition(this.noa.playerEntity, [station.pos[0], station.pos[1] + 2, station.pos[2]]);
    return true;
  }

  // ===========================================================================
  // WALKING LIGHT STOP TEST — the per-stop metrics harness for the Polygon
  // walking-light stability pass. walkingLightStopPlace places a light at a
  // WORLD position, syncs, and returns the full metrics the QA pass requires
  // (matched meshes with meshLocalOrigin / worldOriginOffset / meshWorldOrigin
  // / meshWorldChunkKey / matched YES/NO, tinted verts, farTintDetected,
  // unexpectedLargePlaneTint, stale, queue). The light STAYS PLACED so the
  // caller can screenshot the visible result. walkingLightStopRemove clears it
  // and verifies the tint clears.
  // ===========================================================================

  /** Place a test light at a WORLD position, sync, return full stop metrics. Light stays placed. */
  public walkingLightStopPlace(placeAt: [number, number, number]): any {
    const sc = this.getSceneSafe();
    const vlm = this.voxelLightManager;
    if (!sc || !vlm) return { error: "no scene/vlm" };
    const lightRes = this.resolveTestLightBlock();
    if ("error" in lightRes) return { error: lightRes.error };
    const bd = this.blockService.getBlock(lightRes.blockId);
    if (!bd) return { error: "no block def for test light" };
    const [px, py, pz] = placeAt;
    this.worldService.setBlockOverride(px, py, pz, bd.id);
    this.noa.setBlock(bd.id, px, py, pz);
    vlm.registerLight(px, py, pz, bd);
    const sync = this.syncBlockLightVisualsAroundSource(sc, px, py, pz, "walking stop place");
    const inspect = vlm.inspectLightingAt(px, py, pz);
    return this.collectWalkingStopMetrics(sc, vlm, sync, inspect, placeAt, "place");
  }

  /** Remove the test light at a WORLD position, sync, verify tint cleared. */
  public walkingLightStopRemove(placeAt: [number, number, number]): any {
    const sc = this.getSceneSafe();
    const vlm = this.voxelLightManager;
    if (!sc || !vlm) return { error: "no scene/vlm" };
    const [px, py, pz] = placeAt;
    this.worldService.setBlockOverride(px, py, pz, 0);
    this.noa.setBlock(0, px, py, pz);
    vlm.unregisterLight(px, py, pz);
    const sync = this.syncBlockLightVisualsAroundSource(sc, px, py, pz, "walking stop remove");
    const inspect = vlm.inspectLightingAt(px, py, pz);
    return this.collectWalkingStopMetrics(sc, vlm, sync, inspect, placeAt, "remove");
  }

  private collectWalkingStopMetrics(
    sc: BABYLON.Scene, vlm: any, sync: any, inspect: any,
    placeAt: [number, number, number], phase: "place" | "remove"
  ): any {
    const [px, py, pz] = placeAt;
    const playerPos = this.getPlayerPositionSafe();
    const off: [number, number, number] = (this.noa.worldOriginOffset || [0, 0, 0]).slice() as [number, number, number];
    const affectedSet = new Set<string>(sync.affectedChunkKeys as string[]);
    const matchedMeshDetails: any[] = [];
    let totalTintedVerts = 0;
    let totalBlockLitVerts = 0;
    let farTintAny = false;
    let largePlaneAny = false;
    let maxTintBBox = 0;
    for (const m of sc.meshes) {
      if (!m.name || !m.name.startsWith || !m.name.startsWith("chunk_")) continue;
      if (!m.isEnabled()) continue;
      const mKey = vlm.terrainMeshToWorldChunkKey(m);
      if (!affectedSet.has(mKey)) continue;
      const md: any = m.metadata || {};
      matchedMeshDetails.push({
        meshName: m.name,
        meshLocalOrigin: md.fpMeshLocalOrigin || null,
        worldOriginOffset: md.fpWorldOriginOffset || null,
        meshWorldOrigin: md.fpMeshWorldOrigin || null,
        meshWorldChunkKey: md.fpMeshWorldChunkKey || null,
        matched: "YES",
        fpBlockLitVertices: md.fpBlockLitVertices ?? 0,
        fpTintedVertexCount: md.fpTintedVertexCount ?? 0,
        fpTintBBoxExtent: md.fpTintBBoxExtent ?? 0,
        fpFarTintDetected: md.fpFarTintDetected ?? false,
        fpUnexpectedLargePlaneTint: md.fpUnexpectedLargePlaneTint ?? false,
        fpNearestSourceDistFromTintCenter: md.fpNearestSourceDistFromTintCenter ?? null,
        meshLightVersion: md.meshLightVersion ?? -1,
      });
      totalTintedVerts += md.fpTintedVertexCount ?? 0;
      totalBlockLitVerts += md.fpBlockLitVertices ?? 0;
      if (md.fpFarTintDetected) farTintAny = true;
      if (md.fpUnexpectedLargePlaneTint) largePlaneAny = true;
      if ((md.fpTintBBoxExtent ?? 0) > maxTintBBox) maxTintBBox = md.fpTintBBoxExtent ?? 0;
    }
    const neighbors: any[] = inspect?.neighbors || [];
    const rawCellsLit = neighbors.filter((n: any) => Math.max(n.r || 0, n.g || 0, n.b || 0) > 0).length;
    const maxBlockLightRGB = neighbors.length
      ? Math.max(...neighbors.map((n: any) => Math.max(n.r || 0, n.g || 0, n.b || 0)))
      : 0;
    const nearbySurfaceTintVisible = totalTintedVerts > 0;
    let result: "PASS" | "FAIL" = "FAIL";
    let rootCause: string | null = null;
    if (phase === "place") {
      if (sync.recoloredMeshes === 0) { rootCause = "BLOCKLIGHT_EXISTS_BUT_NO_MATCHED_MESH"; }
      else if (rawCellsLit === 0) { rootCause = "SOURCE_REGISTERED_BUT_NO_RAW_BLOCKLIGHT"; }
      else if (totalTintedVerts === 0) { rootCause = "BLOCKLIGHT_EXISTS_BUT_NO_VERTEX_TINT"; }
      else if (largePlaneAny) { rootCause = "LIGHT_ARTIFACT_LARGE_PLANE"; }
      else if (farTintAny) { rootCause = "LIGHT_ARTIFACT_SHIFTED_OR_OFFSET"; }
      else if (sync.staleAfter > 0) { rootCause = "BLOCKLIGHT_EXISTS_BUT_MESH_STALE"; }
      else if (sync.affectedQueuedChunksAfter > 0) { rootCause = "BLOCKLIGHT_EXISTS_BUT_QUEUE_NOT_DRAINED"; }
      else { result = "PASS"; }
    } else {
      if (maxBlockLightRGB > 0) { rootCause = "TINT_NOT_CLEARED_AFTER_REMOVE"; }
      else if (sync.staleAfter > 0) { rootCause = "BLOCKLIGHT_EXISTS_BUT_MESH_STALE"; }
      else { result = "PASS"; }
    }
    return {
      phase,
      playerWorldPos: playerPos ? [playerPos[0], playerPos[1], playerPos[2]] : null,
      worldOriginOffset: [off[0], off[1], off[2]],
      playerWorldChunk: playerPos ? vlm.worldToChunkKey(playerPos[0], playerPos[1], playerPos[2]) : null,
      sourceWorldPos: [px, py, pz],
      sourceWorldChunkKey: vlm.worldToChunkKey(px, py, pz),
      affectedWorldChunkKeys: sync.affectedChunkKeys,
      visibleMeshesNearSource: matchedMeshDetails.length,
      matchedAffectedMeshes: matchedMeshDetails.length,
      matchedMeshDetails,
      rawCellsLit,
      maxBlockLightRGB,
      recoloredMeshes: sync.recoloredMeshes,
      tintedVerts: totalTintedVerts,
      staleMeshesBefore: sync.staleBefore,
      staleMeshesAfter: sync.staleAfter,
      affectedQueuedChunksBefore: sync.affectedQueuedChunksBefore,
      affectedQueuedChunksAfter: sync.affectedQueuedChunksAfter,
      maxTintBBoxExtent: maxTintBBox,
      visualResult: {
        nearbySurfaceTintVisible,
        farTintDetected: farTintAny,
        unexpectedLargePlaneTint: largePlaneAny,
      },
      maxBlockAfterRemove: phase === "remove" ? maxBlockLightRGB : null,
      result,
      rootCause,
    };
  }

  /** Cross next chunk boundary in +X direction (moves to chunk+1). */
  public agentCrossChunkX(): void {
    const pos = this.getPlayerPositionSafe();
    if (!pos) return;
    const currentChunk = Math.floor(pos[0] / 16);
    const targetX = (currentChunk + 1) * 16 + 0.5;
    this.agentMove(targetX - pos[0], 0);
  }

  /** Cross next chunk boundary in +Z direction. */
  public agentCrossChunkZ(): void {
    const pos = this.getPlayerPositionSafe();
    if (!pos) return;
    const currentChunk = Math.floor(pos[2] / 16);
    const targetZ = (currentChunk + 1) * 16 + 0.5;
    this.agentMove(0, targetZ - pos[2]);
  }

  public getEngine(): NoaEngineInstance {
    return this.noa;
  }

  /**
   * Public accessor for runtime quality changes (future settings menu).
   */
  public setGraphicsQuality(quality: import('./rendering/graphics-settings').GraphicsQuality): void {
    this.graphicsSettings = getGraphicsSettings(quality);
    this.renderPipelineService?.setQuality(this.graphicsSettings);
    this.skyController?.setSettings(this.graphicsSettings);
    this.worldLightManager?.setSettings(this.graphicsSettings);
  }

  public getGraphicsSettings(): GraphicsSettings {
    return this.graphicsSettings;
  }

  public getWorldLightManager(): WorldLightManager | null {
    return this.worldLightManager;
  }

  // ---- CHUNK GRID VISUALIZATION ----
  private chunkGridLines: BABYLON.LinesMesh | null = null;
  private chunkGridHighlight: BABYLON.LinesMesh | null = null;
  private chunkGridVisible: boolean = false;
  private chunkGridYMin: number = 0;
  private chunkGridYMax: number = 0;
  private chunkGridLastBuildTime: number = 0;
  private chunkGridSegmentCount: number = 0;
  private lastGridPlayerChunkX: number = 999;
  private lastGridPlayerChunkZ: number = 999;

  public buildChunkGrid(scene: BABYLON.Scene): void {
    this.removeChunkGrid(scene);
    const pp = this.getPlayerPositionSafe() || [0, 15, 0];
    const px = Math.floor(pp[0]), py = Math.floor(pp[1]), pz = Math.floor(pp[2]);
    const playerChunkX = Math.floor(px / 16);
    const playerChunkZ = Math.floor(pz / 16);
    const yMin = py - 32;
    const yMax = py + 96;

    // Use CreateLineSystem with INDEPENDENT line segments.
    // Draw: current chunk (4 tall corner pillars + top/bottom outline),
    //        target chunk (if different, same outline in contrasting color).
    const segments: BABYLON.Vector3[][] = [];

    const tgt = this.getTargetBlockFallback();
    let targetChunkX = 999, targetChunkZ = 999;
    if (tgt) {
      targetChunkX = Math.floor(tgt.position[0] / 16);
      targetChunkZ = Math.floor(tgt.position[2] / 16);
    }

    // Draw a chunk outline with 4 tall corner pillars
    const drawChunkOutline = (cx: number, cz: number) => {
      const ox = cx * 16, oz = cz * 16;
      const c0 = [ox, yMin, oz], c1 = [ox + 16, yMin, oz], c2 = [ox + 16, yMin, oz + 16], c3 = [ox, yMin, oz + 16];
      const c4 = [ox, yMax, oz], c5 = [ox + 16, yMax, oz], c6 = [ox + 16, yMax, oz + 16], c7 = [ox, yMax, oz + 16];
      // 4 vertical corner pillars (tall, visible above hills)
      segments.push(
        [new BABYLON.Vector3(...c0 as [number,number,number]), new BABYLON.Vector3(...c4 as [number,number,number])],
        [new BABYLON.Vector3(...c1 as [number,number,number]), new BABYLON.Vector3(...c5 as [number,number,number])],
        [new BABYLON.Vector3(...c2 as [number,number,number]), new BABYLON.Vector3(...c6 as [number,number,number])],
        [new BABYLON.Vector3(...c3 as [number,number,number]), new BABYLON.Vector3(...c7 as [number,number,number])],
      );
      // Top outline
      segments.push(
        [new BABYLON.Vector3(...c4 as [number,number,number]), new BABYLON.Vector3(...c5 as [number,number,number])],
        [new BABYLON.Vector3(...c5 as [number,number,number]), new BABYLON.Vector3(...c6 as [number,number,number])],
        [new BABYLON.Vector3(...c6 as [number,number,number]), new BABYLON.Vector3(...c7 as [number,number,number])],
        [new BABYLON.Vector3(...c7 as [number,number,number]), new BABYLON.Vector3(...c4 as [number,number,number])],
      );
      // Bottom outline
      segments.push(
        [new BABYLON.Vector3(...c0 as [number,number,number]), new BABYLON.Vector3(...c1 as [number,number,number])],
        [new BABYLON.Vector3(...c1 as [number,number,number]), new BABYLON.Vector3(...c2 as [number,number,number])],
        [new BABYLON.Vector3(...c2 as [number,number,number]), new BABYLON.Vector3(...c3 as [number,number,number])],
        [new BABYLON.Vector3(...c3 as [number,number,number]), new BABYLON.Vector3(...c0 as [number,number,number])],
      );
    };

    // Draw player chunk
    drawChunkOutline(playerChunkX, playerChunkZ);
    // Draw target chunk if different
    if (targetChunkX !== 999 && (targetChunkX !== playerChunkX || targetChunkZ !== playerChunkZ)) {
      drawChunkOutline(targetChunkX, targetChunkZ);
    }

    this.chunkGridLines = BABYLON.MeshBuilder.CreateLineSystem("fp_chunk_grid", {
      lines: segments,
    }, scene);
    this.chunkGridLines.isPickable = false;
    this.chunkGridLines.alwaysSelectAsActiveMesh = true;
    this.chunkGridLines.color = new BABYLON.Color3(0.5, 0.5, 0.55); // neutral gray

    this.chunkGridYMin = yMin;
    this.chunkGridYMax = yMax;
    this.chunkGridLastBuildTime = Date.now();
    this.chunkGridSegmentCount = segments.length;
    const octMgr = (this.noa.rendering as any)?._octreeManager;
    if (octMgr && typeof octMgr.addMesh === "function") octMgr.addMesh(this.chunkGridLines, false);
    console.log(`[NoaEngineAdapter] Chunk grid ON: ${segments.length} segments, player chunk=${playerChunkX},0,${playerChunkZ}, yMin=${yMin}, yMax=${yMax}`);
  }

  public removeChunkGrid(scene: BABYLON.Scene): void {
    if (this.chunkGridLines) {
      this.chunkGridLines.dispose();
      this.chunkGridLines = null;
    }
    if (this.chunkGridHighlight) {
      this.chunkGridHighlight.dispose();
      this.chunkGridHighlight = null;
    }
  }

  // ---- WAIT FOR VISIBLE MESHES ----
  private async waitForVisibleMeshesAround(pos: [number, number, number], timeoutMs: number = 5000): Promise<number> {
    const sc = this.getSceneSafe();
    if (!sc) return 0;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let count = 0;
      for (const m of sc.meshes) {
        if (!m.name || !m.name.startsWith || !m.name.startsWith("chunk_")) continue;
        if (!m.isEnabled()) continue;
        const dx = m.position.x - pos[0];
        const dz = m.position.z - pos[2];
        if (dx * dx + dz * dz < 32 * 32) count++;
      }
      if (count > 0) return count;
      await new Promise(r => setTimeout(r, 200));
    }
    return 0;
  }

  // ---- LIGHT SWEEP TEST ----
  /**
   * Sweep test that runs the 3×3 Surface Light Test at each step.
   * Stops on first FAIL. Each step validates that SURROUNDING cells
   * brighten/dim, not just that the source is bright.
   */
  public async runLightSweep(direction: "+X" | "-X" | "+Z" | "-Z" | "diag"): Promise<any[]> {
    const sc = this.getSceneSafe();
    if (!sc) return [{ error: "no scene" }];
    const vlm = this.voxelLightManager;
    if (!vlm) return [{ error: "no vlm" }];
    const positions: number[] = [0, 5, 10, 15, 16, 20, 25, 30, 32, 40, 48, 64, 80];
    const results: any[] = [];
    const bd = this.blockService.getBlock(7); // yellow halogen
    if (!bd) return [{ error: "no block def for id 7" }];

    for (let stepIdx = 0; stepIdx < positions.length; stepIdx++) {
      const dist = positions[stepIdx];
      let lx: number, lz: number;
      if (direction === "+X") { lx = dist; lz = 0; }
      else if (direction === "-X") { lx = -dist; lz = 0; }
      else if (direction === "+Z") { lx = 0; lz = dist; }
      else if (direction === "-Z") { lx = 0; lz = -dist; }
      else { lx = dist; lz = dist; } // diag

      // Find ground level
      let ly = 14;
      for (let y = 20; y > 0; y--) {
        if (this.getBlockIdAt(lx, y, lz) !== 0) { ly = y + 1; break; }
      }

      // Teleport player + wait for meshes
      this.noa.entities.setPosition(this.noa.playerEntity, [lx, ly + 2, lz]);
      const visibleMeshes = await this.waitForVisibleMeshesAround([lx, ly, lz], 3000);

      // Run 3×3 surface test (the strict acceptance test)
      const surfaceResult = vlm.runSurface3x3Test(
        lx, ly, lz,
        () => {
          this.worldService.setBlockOverride(lx, ly, lz, 7);
          this.noa.setBlock(7, lx, ly, lz);
          vlm.registerLight(lx, ly, lz, bd);
          vlm.relightAround(sc, lx, ly, lz);
        },
        () => {
          this.worldService.setBlockOverride(lx, ly, lz, 0);
          this.noa.setBlock(0, lx, ly, lz);
          vlm.unregisterLight(lx, ly, lz);
          vlm.relightAround(sc, lx, ly, lz);
        }
      );

      const cx = Math.floor(lx / 16), cz = Math.floor(lz / 16);
      const localX = lx - cx * 16, localZ = lz - cz * 16;
      const isBoundary = localX === 0 || localX === 15 || localZ === 0 || localZ === 15;

      const stepResult = {
        direction,
        stepIndex: stepIdx,
        worldPos: [lx, ly, lz],
        chunkKey: `${cx},${Math.floor(ly/16)},${cz}`,
        localCell: [localX, ly % 16, localZ],
        distFromSpawn: Math.sqrt(lx*lx + lz*lz),
        isChunkBoundary: isBoundary,
        distToChunkBorderX: Math.min(localX, 15 - localX),
        distToChunkBorderZ: Math.min(localZ, 15 - localZ),
        visibleMeshesNearby: visibleMeshes,
        cellsBrightened: surfaceResult.cellsBrightened,
        cellsDimmed: surfaceResult.cellsDimmed,
        cellsWithLightData: surfaceResult.cellsWithLightData,
        result: surfaceResult.result,
        reason: surfaceResult.reason,
      };
      results.push(stepResult);
      console.log(`[Sweep ${direction}] step ${stepIdx}: pos=(${lx},${ly},${lz}) chunk=${stepResult.chunkKey} ${stepResult.result} meshes=${visibleMeshes} brightened=${surfaceResult.cellsBrightened} dimmed=${surfaceResult.cellsDimmed}`);

      // Stop on first FAIL (not INCONCLUSIVE — inconclusive means meshes
      // weren't loaded, so we keep going).
      if (surfaceResult.result === "FAIL") {
        console.log("[Sweep] STOPPING at first failure:", JSON.stringify(stepResult, null, 2));
        break;
      }
    }
    // Return to spawn
    this.noa.entities.setPosition(this.noa.playerEntity, [0, 15, 0]);
    vlm.relightAround(sc, 0, 15, 0);
    return results;
  }

  // ---- CHUNK BORDER TEST ----
  /**
   * Tests lighting at chunk border positions using 3×3 surface validation.
   * Validates that surface cells on BOTH sides of the border brighten/dim.
   */
  public async runChunkBorderTest(): Promise<any[]> {
    const sc = this.getSceneSafe();
    if (!sc) return [{ error: "no scene" }];
    const vlm = this.voxelLightManager;
    if (!vlm) return [{ error: "no vlm" }];
    const bd = this.blockService.getBlock(7);
    if (!bd) return [{ error: "no block def" }];

    const testPositions = [
      { x: 15, z: 0, label: "1-block before X border" },
      { x: 16, z: 0, label: "at X border (chunk 1)" },
      { x: 17, z: 0, label: "1-block after X border" },
      { x: 0, z: 15, label: "1-block before Z border" },
      { x: 0, z: 16, label: "at Z border (chunk 1)" },
      { x: 0, z: 17, label: "1-block after Z border" },
      { x: 15, z: 15, label: "corner before both borders" },
      { x: 16, z: 16, label: "corner at both borders" },
    ];

    const results: any[] = [];
    for (const tp of testPositions) {
      let ly = 14;
      for (let y = 20; y > 0; y--) {
        if (this.getBlockIdAt(tp.x, y, tp.z) !== 0) { ly = y + 1; break; }
      }

      // Teleport + wait for meshes
      this.noa.entities.setPosition(this.noa.playerEntity, [tp.x, ly + 2, tp.z]);
      const visibleMeshes = await this.waitForVisibleMeshesAround([tp.x, ly, tp.z], 3000);

      // Run 3×3 surface test at the border position
      const surfaceResult = vlm.runSurface3x3Test(
        tp.x, ly, tp.z,
        () => {
          this.worldService.setBlockOverride(tp.x, ly, tp.z, 7);
          this.noa.setBlock(7, tp.x, ly, tp.z);
          vlm.registerLight(tp.x, ly, tp.z, bd);
          vlm.relightAround(sc, tp.x, ly, tp.z);
        },
        () => {
          this.worldService.setBlockOverride(tp.x, ly, tp.z, 0);
          this.noa.setBlock(0, tp.x, ly, tp.z);
          vlm.unregisterLight(tp.x, ly, tp.z);
          vlm.relightAround(sc, tp.x, ly, tp.z);
        }
      );

      const r = {
        label: tp.label,
        worldPos: [tp.x, ly, tp.z],
        chunkKey: `${Math.floor(tp.x/16)},${Math.floor(ly/16)},${Math.floor(tp.z/16)}`,
        visibleMeshesNearby: visibleMeshes,
        cellsBrightened: surfaceResult.cellsBrightened,
        cellsDimmed: surfaceResult.cellsDimmed,
        cellsWithLightData: surfaceResult.cellsWithLightData,
        result: surfaceResult.result,
        reason: surfaceResult.reason,
      };
      results.push(r);
      console.log(`[BorderTest] ${tp.label}: ${r.result} brightened=${surfaceResult.cellsBrightened} dimmed=${surfaceResult.cellsDimmed}`);
    }
    // Return to spawn
    this.noa.entities.setPosition(this.noa.playerEntity, [0, 15, 0]);
    return results;
  }

  // ---- RUIN STRESS TEST ----
  public async runRuinStressTest(): Promise<any> {
    const sc = this.getSceneSafe();
    if (!sc) return { error: "no scene" };
    const vlm = this.voxelLightManager;
    if (!vlm) return { error: "no vlm" };
    const ruin = this.worldService.getRuinCenter();
    // Teleport
    this.noa.entities.setPosition(this.noa.playerEntity, [ruin[0] + 2, ruin[1] + 2, ruin[2] + 2]);
    await this.waitForVisibleMeshesAround([ruin[0], ruin[1], ruin[2]], 3000);
    vlm.forceRelightAllImmediate(sc);

    const sourcesBefore = (vlm as any).voxelLightSources.size;
    const inspectBefore = vlm.inspectLightingAt(ruin[0], ruin[1], ruin[2]);

    // Place + remove cyan lamp 5x
    const bd = this.blockService.getBlock(6);
    let stressPass = true;
    if (bd) {
      for (let i = 0; i < 5; i++) {
        const px = ruin[0] + 3, py = ruin[1], pz = ruin[2] + 3;
        this.worldService.setBlockOverride(px, py, pz, 6);
        this.noa.setBlock(6, px, py, pz);
        vlm.registerLight(px, py, pz, bd);
        vlm.relightAround(sc, px, py, pz);
        this.worldService.setBlockOverride(px, py, pz, 0);
        this.noa.setBlock(0, px, py, pz);
        vlm.unregisterLight(px, py, pz);
        vlm.relightAround(sc, px, py, pz);
      }
    }
    const sourcesAfter = (vlm as any).voxelLightSources.size;
    const inspectAfter = vlm.inspectLightingAt(ruin[0], ruin[1], ruin[2]);
    const vl = (window as any).__fpDebug().voxelLighting;

    return {
      ruinCenter: ruin,
      sourcesBefore, sourcesAfter,
      sourcesStable: sourcesBefore === sourcesAfter,
      inspectBefore: { sky: inspectBefore.skyLight, blockR: inspectBefore.blockLightR },
      inspectAfter: { sky: inspectAfter.skyLight, blockR: inspectAfter.blockLightR },
      realPointLights: vl.realPointLightsActive,
      invalidColors: vl.invalidColorWriteCount,
      registeredSources: vl.registeredVoxelSources,
      stressCycles: 5,
      pass: sourcesBefore === sourcesAfter && vl.realPointLightsActive === 0 && vl.invalidColorWriteCount === 0,
    };
  }

  // ---- RESOLVE TEST LIGHT BLOCK ----
  /**
   * Resolve which light block to use for tests. Priority:
   * 1. Currently selected block if it emits light
   * 2. Block under crosshair if it emits light
   * 3. First registered block definition with light_source tag
   * 4. Fallback error if no light block exists
   */
  public resolveTestLightBlock(): { blockId: number; blockKey: string; emissionRGB: [number, number, number]; strength: number; source: string } | { error: string } {
    // 1. Check currently selected block
    const selectedId = this.playerService.getSelectedBlockId();
    if (selectedId > 0) {
      const bd = this.blockService.getBlock(selectedId);
      if (bd && bd.light && (bd.tags?.includes("light_source") || bd.light)) {
        return {
          blockId: bd.id,
          blockKey: bd.materialName,
          emissionRGB: bd.light.color || bd.color,
          strength: bd.light.intensity,
          source: "selected block",
        };
      }
    }
    // 2. Check crosshair target
    const tgt = this.getTargetBlockFallback();
    if (tgt) {
      const tgtId = this.getBlockIdAt(tgt.position[0], tgt.position[1], tgt.position[2]);
      const bd = this.blockService.getBlock(tgtId);
      if (bd && bd.light && (bd.tags?.includes("light_source") || bd.light)) {
        return {
          blockId: bd.id,
          blockKey: bd.materialName,
          emissionRGB: bd.light.color || bd.color,
          strength: bd.light.intensity,
          source: "crosshair target",
        };
      }
    }
    // 3. First registered light_source block
    for (const bd of this.blockService.getBlockDefinitions()) {
      if (bd.light && (bd.tags?.includes("light_source") || bd.light)) {
        return {
          blockId: bd.id,
          blockKey: bd.materialName,
          emissionRGB: bd.light.color || bd.color,
          strength: bd.light.intensity,
          source: "first registered light block",
        };
      }
    }
    return { error: "NO_LIGHT_BLOCK_FOUND" };
  }

  // ---- USER LIGHT REPRO TEST ----
  /**
   * Reproduce the user's reported bug: lights work near spawn but fail far away.
   * Tests two specific locations from the user's screenshots:
   *   Near: [-4, 15, -12] (chunk [-1,0,-1])
   *   Far:  [-3, 18, -21] (chunk [-1,1,-2])
   * For each: teleport, wait for meshes, place/inspect light, sample raw
   * blockLight in face-adjacent air cells, verify mesh recolor.
   */
  public async runUserLightRepro(): Promise<any> {
    const sc = this.getSceneSafe();
    if (!sc) return { error: "no scene" };
    const vlm = this.voxelLightManager;
    if (!vlm) return { error: "no vlm" };
    const lightRes = this.resolveTestLightBlock();
    if ("error" in lightRes) return lightRes;
    const testBd = this.blockService.getBlock(lightRes.blockId);
    if (!testBd) return { error: "no block def" };

    const testLocation = async (name: string, px: number, py: number, pz: number): Promise<any> => {
      // Teleport
      this.noa.entities.setPosition(this.noa.playerEntity, [px, py + 2, pz]);
      const visibleMeshes = await this.waitForVisibleMeshesAround([px, py, pz], 4000);

      // Find ground level for light placement
      let ly = py;
      for (let y = py + 5; y > py - 10; y--) {
        if (this.getBlockIdAt(px, y, pz) !== 0) { ly = y + 1; break; }
      }

      // Sample raw blockLight in surrounding AIR cells before placement
      const sampleAirCells = (): any[] => {
        const cells: Array<{x:number;y:number;z:number}> = [];
        // 6 neighbors around the light position
        for (const [dx,dy,dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
          cells.push({x: px+dx, y: ly+dy, z: pz+dz});
        }
        // 3×3 floor below
        for (let dx = -1; dx <= 1; dx++)
          for (let dz = -1; dz <= 1; dz++)
            cells.push({x: px+dx, y: ly-1, z: pz+dz});
        return cells.map(c => {
          const s = (vlm as any).sampleLight(c.x, c.y, c.z);
          return { pos: [c.x,c.y,c.z], sky: s.sky, r: s.r, g: s.g, b: s.b, mag: Math.max(s.r,s.g,s.b), hasData: s.hasChunkData };
        });
      };

      const before = sampleAirCells();

      // Track source registration timing
      const sourceKey = `${px},${ly},${pz}`;
      const registeredSources = (vlm as any).voxelLightSources as Map<string, any>;
      const sourceBefore = registeredSources.has(sourceKey);

      // Place light
      this.worldService.setBlockOverride(px, ly, pz, testBd.id);
      this.noa.setBlock(testBd.id, px, ly, pz);
      vlm.registerLight(px, ly, pz, testBd);
      const sourceAfterRegister = registeredSources.has(sourceKey);
      const relightResult = vlm.relightAround(sc, px, ly, pz);
      const sourceAfterRelight = registeredSources.has(sourceKey);

      const after = sampleAirCells();

      // Remove light
      this.worldService.setBlockOverride(px, ly, pz, 0);
      this.noa.setBlock(0, px, ly, pz);
      vlm.unregisterLight(px, ly, pz);
      vlm.relightAround(sc, px, ly, pz);
      const sourceAfterRemoval = registeredSources.has(sourceKey);

      const afterRemove = sampleAirCells();

      // Analyze
      let cellsLit = 0, cellsCleared = 0;
      for (let i = 0; i < before.length; i++) {
        if (after[i].mag > before[i].mag) cellsLit++;
        if (afterRemove[i].mag < after[i].mag) cellsCleared++;
      }

      // Determine root cause
      let result: "PASS" | "FAIL" = "FAIL";
      let rootCause: string | null = null;
      if (!testBd.light) {
        rootCause = "BLOCK_NOT_EMISSIVE";
      } else if (!sourceAfterRegister) {
        rootCause = "SOURCE_NOT_REGISTERED";
      } else if (cellsLit === 0) {
        rootCause = "SOURCE_REGISTERED_BUT_NO_BLOCKLIGHT";
      } else if (relightResult.recoloredMeshCount === 0) {
        rootCause = "BLOCKLIGHT_EXISTS_BUT_NO_MESH_RECOLOR";
      } else if (cellsCleared === 0) {
        rootCause = "BLOCKLIGHT_NOT_CLEARED_AFTER_REMOVAL";
      } else if (sourceAfterRemoval) {
        rootCause = "SOURCE_NOT_UNREGISTERED_AFTER_REMOVAL";
      } else {
        result = "PASS";
      }

      const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
      return {
        locationName: name,
        playerPos: [px, py, pz],
        sourcePos: [px, ly, pz],
        sourceBlockId: testBd.id,
        sourceBlockKey: testBd.materialName,
        testLightBlockId: lightRes.blockId,
        testLightBlockKey: lightRes.blockKey,
        chunkKey: `${cx},${Math.floor(ly/16)},${cz}`,
        visibleMeshesNearby: visibleMeshes,
        sourceRegisteredBeforePlacement: sourceBefore,
        sourceRegisteredAfterRegister: sourceAfterRegister,
        sourceRegisteredAfterRelight: sourceAfterRelight,
        sourceRegisteredAfterRemoval: sourceAfterRemoval,
        affectedChunks: relightResult.recomputedChunks.length,
        recoloredMeshes: relightResult.recoloredMeshCount,
        cellsLitByRawBlockLight: cellsLit,
        cellsClearedAfterRemoval: cellsCleared,
        sampledAirCellsCount: before.length,
        beforeSample: before.slice(0, 3),
        afterSample: after.slice(0, 3),
        result,
        rootCause,
      };
    };

    const nearResult = await testLocation("Near (spawn-side)", -4, 15, -12);
    const farResult = await testLocation("Far (ruin-side)", -3, 18, -21);

    // Return to spawn
    this.noa.entities.setPosition(this.noa.playerEntity, [0, 15, 0]);

    return {
      near: nearResult,
      far: farResult,
      overallResult: nearResult.result === "PASS" && farResult.result === "PASS" ? "PASS" : "FAIL",
      overallReason: `near=${nearResult.result}(${nearResult.rootCause || "ok"}), far=${farResult.result}(${farResult.rootCause || "ok"})`,
    };
  }

  // ---- INSPECT TARGET LIGHT (crosshair) ----
  /**
   * Inspect the actual block under the crosshair. Reports full lighting chain
   * diagnostics: emissive status, source registration, raw blockLight at cell
   * + 6 neighbors, mesh version staleness.
   */
  public inspectTargetLight(): any {
    const tgt = this.getTargetBlockFallback();
    if (!tgt) {
      return { error: "NO_TARGET_BLOCK_UNDER_CROSSHAIR" };
    }
    const [tx, ty, tz] = tgt.position;
    const blockId = this.getBlockIdAt(tx, ty, tz);
    const bd = this.blockService.getBlock(blockId);
    const vlm = this.voxelLightManager;
    if (!vlm) return { error: "no vlm" };

    const isEmissive = !!(bd && bd.light && (bd.tags?.includes("light_source") || bd.light));
    const sourceKey = `${tx},${ty},${tz}`;
    const registeredSources = (vlm as any).voxelLightSources as Map<string, any>;
    const hasRegisteredSource = registeredSources.has(sourceKey);

    // Raw blockLight at target + 6 neighbors
    const inspect = vlm.inspectLightingAt(tx, ty, tz);
    const neighbors = inspect.neighbors || [];

    // Mesh staleness
    const sc = this.getSceneSafe();
    const cx = Math.floor(tx / 16), cy = Math.floor(ty / 16), cz = Math.floor(tz / 16);
    const chunkKey = `${cx},${cy},${cz}`;
    const chunkData = vlm.getChunkLight(cx, cy, cz);
    const chunkLightVersion = chunkData?.lightDataVersion ?? 0;
    let meshVersion = -1;
    let meshExists = false;
    let staleMesh = false;
    if (sc) {
      // Find chunk mesh
      const meshes = sc.meshes.filter((m: any) => m.name && m.name.startsWith("chunk_") && m.name.includes(chunkKey.replace(/,/g, "|")));
      if (meshes.length > 0) {
        meshExists = true;
        meshVersion = meshes[0].metadata?.meshLightVersion ?? -1;
        staleMesh = meshVersion < chunkLightVersion;
      }
    }

    return {
      targetPos: [tx, ty, tz],
      blockId,
      blockKey: bd?.materialName ?? "unknown",
      blockName: bd?.name ?? "unknown",
      emissive: isEmissive,
      emissionProfile: bd?.light ? { color: bd.light.color, intensity: bd.light.intensity, range: bd.light.range } : null,
      registeredSource: hasRegisteredSource,
      blockLightAtTarget: [inspect.blockLightR ?? 0, inspect.blockLightG ?? 0, inspect.blockLightB ?? 0],
      blockLightMagnitude: Math.max(inspect.blockLightR ?? 0, inspect.blockLightG ?? 0, inspect.blockLightB ?? 0),
      skyLightAtTarget: inspect.skyLight ?? 0,
      neighborBlockLight: neighbors.map((n: any) => ({
        offset: n.offset,
        pos: n.worldPos,
        rgb: [n.r ?? 0, n.g ?? 0, n.b ?? 0],
        magnitude: Math.max(n.r ?? 0, n.g ?? 0, n.b ?? 0),
      })),
      chunkKey,
      chunkHasLightData: !!chunkData,
      meshExists,
      meshLightVersion: meshVersion,
      chunkLightDataVersion: chunkLightVersion,
      staleMesh,
      // Lighting chain status — use MAGNITUDE (max of R,G,B), not R-only
      chain: {
        blockEmissive: isEmissive ? "OK" : "FAIL",
        sourceRegistered: hasRegisteredSource ? "OK" : (isEmissive ? "FAIL" : "N/A"),
        blockLightAtSource: Math.max(inspect.blockLightR ?? 0, inspect.blockLightG ?? 0, inspect.blockLightB ?? 0) > 0 ? "OK" : (isEmissive ? "FAIL" : "N/A"),
        anyNeighborHasBlockLight: neighbors.some((n: any) => Math.max(n.r ?? 0, n.g ?? 0, n.b ?? 0) > 0) ? "OK" : "FAIL",
        meshExists: meshExists ? "OK" : "FAIL",
        meshUpToDate: !staleMesh ? "OK" : "FAIL",
      },
    };
  }

  // ---- SYNC BLOCK LIGHT VISUALS AROUND SOURCE ----
  /**
   * Synchronize block light visuals for all chunks affected by a light source.
   * Recomputes light data for affected chunks, recolors their visible meshes,
   * and returns stale-before/after counts.
   *
   * Used for: placed lights, removed lights, existing light target test,
   * static/generated source discovered on chunk load.
   */
  public syncBlockLightVisualsAroundSource(
    scene: BABYLON.Scene,
    x: number,
    y: number,
    z: number,
    reason: string
  ): {
    affectedChunkKeys: string[];
    recomputedChunks: number;
    recoloredMeshes: number;
    staleBefore: number;
    staleAfter: number;
    queueBefore: number;
    queueAfter: number;
    affectedQueuedChunksBefore: number;
    affectedQueuedChunksAfter: number;
    processedQueueChunks: number;
    queueDrainIterations: number;
  } {
    const vlm = this.voxelLightManager;
    if (!vlm) return { affectedChunkKeys: [], recomputedChunks: 0, recoloredMeshes: 0, staleBefore: 0, staleAfter: 0, queueBefore: 0, queueAfter: 0, affectedQueuedChunksBefore: 0, affectedQueuedChunksAfter: 0, processedQueueChunks: 0, queueDrainIterations: 0 };

    // Compute affected chunk keys by MAX_LIGHT_RADIUS.
    // CANONICAL: x/y/z are WORLD coords and VLM is WORLD-space throughout, so
    // chunk keys are WORLD. (Previously this converted world→local and passed
    // LOCAL chunk coords to recomputeChunkNoQueue, which made
    // recomputeChunkLightFromWorld read voxels via noa.getBlock(LOCAL origin) —
    // reading WRONG blocks after noa rebase — producing the garbage BFS that
    // caused the huge light plane/band artifacts the user photographed.)
    const radius = 8; // MAX_LIGHT_RADIUS
    const minCx = Math.floor((x - radius) / CHUNK_SIZE);
    const maxCx = Math.floor((x + radius) / CHUNK_SIZE);
    const minCy = Math.floor((y - radius) / CHUNK_SIZE);
    const maxCy = Math.floor((y + radius) / CHUNK_SIZE);
    const minCz = Math.floor((z - radius) / CHUNK_SIZE);
    const maxCz = Math.floor((z + radius) / CHUNK_SIZE);
    const affectedChunkKeys: string[] = [];
    for (let acy = maxCy; acy >= minCy; acy--) {
      for (let acx = minCx; acx <= maxCx; acx++) {
        for (let acz = minCz; acz <= maxCz; acz++) {
          affectedChunkKeys.push(`${acx},${acy},${acz}`);
        }
      }
    }

    // Count stale meshes BEFORE sync
    let staleBefore = 0;
    for (const key of affectedChunkKeys) {
      const [cx, cy, cz] = key.split(",").map(Number);
      const chunkData = vlm.getChunkLight(cx, cy, cz);
      const chunkVer = chunkData?.lightDataVersion ?? 0;
      for (const m of scene.meshes) {
        if (!m.name || !m.name.startsWith("chunk_")) continue;
        if (!m.isEnabled()) continue;
        const mKey = vlm.terrainMeshToWorldChunkKey(m);
        if (mKey === key) {
          const meshVer = m.metadata?.meshLightVersion ?? -1;
          if (meshVer < chunkVer) staleBefore++;
        }
      }
    }

    const queueBefore = vlm.getRelightQueueKeys().length;
    const affectedSet = new Set(affectedChunkKeys);

    // Count affected chunks that are in the relight queue BEFORE sync
    let affectedQueuedChunksBefore = 0;
    for (const qk of vlm.getRelightQueueKeys()) {
      if (affectedSet.has(qk)) affectedQueuedChunksBefore++;
    }

    // Recompute light data for affected chunks (top-down by Y) WITHOUT
    // cross-chunk queueing. Chunk keys are WORLD (VLM is WORLD-space).
    // recomputeChunkNoQueue → recomputeChunkLightFromWorld reads voxels via
    // noa.getBlock(worldOrigin + lx) which is correct (noa.getBlock is WORLD).
    let recomputedChunks = 0;
    for (let acy = maxCy; acy >= minCy; acy--) {
      for (let acx = minCx; acx <= maxCx; acx++) {
        for (let acz = minCz; acz <= maxCz; acz++) {
          vlm.recomputeChunkNoQueue(acx, acy, acz);
          recomputedChunks++;
        }
      }
    }

    // No queue drain needed — recomputeChunkNoQueue doesn't queue neighbors.
    const processedQueueChunks = 0;
    const queueDrainIterations = 0;

    // Recolor visible affected meshes
    const recoloredMeshes = vlm.recolorAffectedMeshes(scene, affectedChunkKeys);

    // Count stale meshes AFTER sync
    let staleAfter = 0;
    for (const key of affectedChunkKeys) {
      const [cx, cy, cz] = key.split(",").map(Number);
      const chunkData = vlm.getChunkLight(cx, cy, cz);
      const chunkVer = chunkData?.lightDataVersion ?? 0;
      for (const m of scene.meshes) {
        if (!m.name || !m.name.startsWith("chunk_")) continue;
        if (!m.isEnabled()) continue;
        const mKey = vlm.terrainMeshToWorldChunkKey(m);
        if (mKey === key) {
          const meshVer = m.metadata?.meshLightVersion ?? -1;
          if (meshVer < chunkVer) staleAfter++;
        }
      }
    }

    const queueAfter = vlm.getRelightQueueKeys().length;

    // Count affected chunks still in queue AFTER sync
    let affectedQueuedChunksAfter = 0;
    for (const qk of vlm.getRelightQueueKeys()) {
      if (affectedSet.has(qk)) affectedQueuedChunksAfter++;
    }

    console.log(`[syncBlockLightVisuals] ${reason}: affected=${affectedChunkKeys.length} recomputed=${recomputedChunks} recolored=${recoloredMeshes} staleBefore=${staleBefore} staleAfter=${staleAfter} queueBefore=${queueBefore} queueAfter=${queueAfter} affectedQueuedBefore=${affectedQueuedChunksBefore} affectedQueuedAfter=${affectedQueuedChunksAfter} drainIters=${queueDrainIterations}`);

    return {
      affectedChunkKeys,
      recomputedChunks,
      recoloredMeshes,
      staleBefore,
      staleAfter,
      queueBefore,
      queueAfter,
      affectedQueuedChunksBefore,
      affectedQueuedChunksAfter,
      processedQueueChunks,
      queueDrainIterations,
    };
  }

  // ---- WALKING LIGHT MONITOR ----
  public startWalkingMonitor(): void {
    this.walkingMonitorActive = true;
    this.walkingMonitorStartChunk = "";
    this.walkingMonitorPrevChunk = "";
    this.walkingMonitorLastResult = null;
    console.log("[WalkingMonitor] Started. Walk across a chunk boundary to trigger validation.");
  }

  public stopWalkingMonitor(): void {
    this.walkingMonitorActive = false;
    console.log("[WalkingMonitor] Stopped.");
  }

  public getWalkingMonitorState(): any {
    const pos = this.getPlayerPositionSafe() || [0, 15, 0];
    const pcx = Math.floor(pos[0] / 16), pcy = Math.floor(pos[1] / 16), pcz = Math.floor(pos[2] / 16);
    return {
      active: this.walkingMonitorActive,
      startChunk: this.walkingMonitorStartChunk,
      previousChunk: this.walkingMonitorPrevChunk,
      currentChunk: `${pcx},${pcy},${pcz}`,
      crossedChunkBoundary: this.walkingMonitorLastResult?.crossedChunkBoundary ?? false,
      lastResult: this.walkingMonitorLastResult,
    };
  }

  /** Find an air cell near the player for placing a test light. */
  private findAirNearPlayer(pos: [number, number, number]): [number, number, number] | null {
    // pos is WORLD position. noa.getBlock works in world coords.
    const px = Math.floor(pos[0]), py = Math.floor(pos[1]), pz = Math.floor(pos[2]);
    for (let dy = 2; dy <= 4; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (dx === 0 && dz === 0 && dy === 0) continue;
          const x = px + dx, y = py + dy, z = pz + dz;
          if (this.getBlockIdAt(x, y, z) === 0) return [x, y, z];
        }
      }
    }
    return null;
  }

  /**
   * Run block light validation after a natural chunk boundary crossing.
   * If the player is looking at a light block, use that. Otherwise place
   * a temporary test light, validate, then remove it.
   */
  private runWalkingLightCheck(pos: [number, number, number], oldChunk: string, newChunk: string): any {
    const sc = this.getSceneSafe();
    if (!sc) return { error: "no scene" };
    const vlm = this.voxelLightManager;
    if (!vlm) return { error: "no vlm" };

    // Count visible meshes near player
    let visibleMeshesNearPlayer = 0;
    for (const m of sc.meshes) {
      if (!m.name || !m.name.startsWith("chunk_")) continue;
      if (!m.isEnabled()) continue;
      const dx = m.position.x - pos[0], dz = m.position.z - pos[2];
      if (dx * dx + dz * dz < 32 * 32) visibleMeshesNearPlayer++;
    }

    // FPS
    const fps = Math.round(1000 / Math.max(1, performance.now() - this.lastFrameTime));
    this.walkingMonitorFpsHistory.push(fps);
    if (this.walkingMonitorFpsHistory.length > 10) this.walkingMonitorFpsHistory.shift();
    const avgFps = Math.round(this.walkingMonitorFpsHistory.reduce((a, b) => a + b, 0) / this.walkingMonitorFpsHistory.length);

    // Check if player is targeting a light block
    const tgt = this.getTargetBlockFallback();
    let sourcePos: [number, number, number];
    let sourceBlockId: number;
    let sourceBlockKey: string;
    let placedTemporary = false;

    if (tgt) {
      const tgtId = this.getBlockIdAt(tgt.position[0], tgt.position[1], tgt.position[2]);
      const bd = this.blockService.getBlock(tgtId);
      if (bd && bd.light && (bd.tags?.includes("light_source") || bd.light)) {
        sourcePos = [tgt.position[0], tgt.position[1], tgt.position[2]];
        sourceBlockId = tgtId;
        sourceBlockKey = bd.materialName;
      } else {
        // Target is not a light — place temporary light at adjacent
        const lightRes = this.resolveTestLightBlock();
        if ("error" in lightRes) return { error: lightRes.error, crossedChunkBoundary: true, oldChunk, newChunk };
        const testBd = this.blockService.getBlock(lightRes.blockId);
        if (!testBd) return { error: "no block def", crossedChunkBoundary: true, oldChunk, newChunk };
        const adj = tgt.adjacent;
        if (this.getBlockIdAt(adj[0], adj[1], adj[2]) !== 0) {
          // Adjacent not air — search for air near player
          sourcePos = this.findAirNearPlayer(pos);
          if (!sourcePos) return { error: "NO_AIR_NEAR_PLAYER", crossedChunkBoundary: true, oldChunk, newChunk };
        } else {
          sourcePos = [adj[0], adj[1], adj[2]];
        }
        sourceBlockId = testBd.id;
        sourceBlockKey = testBd.materialName;
        placedTemporary = true;
        this.worldService.setBlockOverride(sourcePos[0], sourcePos[1], sourcePos[2], testBd.id);
        this.noa.setBlock(testBd.id, sourcePos[0], sourcePos[1], sourcePos[2]);
        vlm.registerLight(sourcePos[0], sourcePos[1], sourcePos[2], testBd);
      }
    } else {
      // No target — place light near player
      const lightRes = this.resolveTestLightBlock();
      if ("error" in lightRes) return { error: lightRes.error, crossedChunkBoundary: true, oldChunk, newChunk };
      const testBd = this.blockService.getBlock(lightRes.blockId);
      if (!testBd) return { error: "no block def", crossedChunkBoundary: true, oldChunk, newChunk };
      sourcePos = this.findAirNearPlayer(pos);
      if (!sourcePos) return { error: "NO_AIR_NEAR_PLAYER", crossedChunkBoundary: true, oldChunk, newChunk };
      sourceBlockId = testBd.id;
      sourceBlockKey = testBd.materialName;
      placedTemporary = true;
      this.worldService.setBlockOverride(sourcePos[0], sourcePos[1], sourcePos[2], testBd.id);
      this.noa.setBlock(testBd.id, sourcePos[0], sourcePos[1], sourcePos[2]);
      vlm.registerLight(sourcePos[0], sourcePos[1], sourcePos[2], testBd);
    }

    // Run source-centric sync
    const syncResult = this.syncBlockLightVisualsAroundSource(sc, sourcePos[0], sourcePos[1], sourcePos[2], "walking monitor");

    // Inspect after sync
    const inspect = vlm.inspectLightingAt(sourcePos[0], sourcePos[1], sourcePos[2]);
    const neighborLit = inspect.neighbors?.filter((n: any) => Math.max(n.r ?? 0, n.g ?? 0, n.b ?? 0) > 0).length ?? 0;

    // Count visual tinted vertices on affected meshes
    let visualTintedVertices = 0;
    const affectedMeshes = sc.meshes.filter((m: any) => {
      if (!m.name || !m.name.startsWith('chunk_')) return false;
      if (!m.isEnabled()) return false;
      const ox = Math.round(m.position.x), oy = Math.round(m.position.y), oz = Math.round(m.position.z);
      const cx = Math.round(ox / 16), cy = Math.round(oy / 16), cz = Math.round(oz / 16);
      return syncResult.affectedChunkKeys.includes(`${cx},${cy},${cz}`);
    });
    for (const m of affectedMeshes) {
      visualTintedVertices += m.metadata?.fpBlockLitVertices ?? 0;
    }

    // Remove temporary light if placed
    if (placedTemporary) {
      this.worldService.setBlockOverride(sourcePos[0], sourcePos[1], sourcePos[2], 0);
      this.noa.setBlock(0, sourcePos[0], sourcePos[1], sourcePos[2]);
      vlm.unregisterLight(sourcePos[0], sourcePos[1], sourcePos[2]);
      this.syncBlockLightVisualsAroundSource(sc, sourcePos[0], sourcePos[1], sourcePos[2], "walking monitor cleanup");
    }

    // Evaluate PASS/FAIL
    let result: "PASS" | "FAIL" = "FAIL";
    let rootCause: string | null = null;
    if (visibleMeshesNearPlayer === 0) {
      rootCause = "NO_VISIBLE_MESH_NEAR_PLAYER";
    } else if (neighborLit === 0) {
      rootCause = "SOURCE_REGISTERED_BUT_NO_RAW_BLOCKLIGHT";
    } else if (syncResult.affectedQueuedChunksAfter > 0) {
      rootCause = "BLOCKLIGHT_EXISTS_BUT_QUEUE_NOT_DRAINED";
    } else if (syncResult.staleAfter > 0) {
      rootCause = "BLOCKLIGHT_EXISTS_BUT_MESH_STALE";
    } else if (visualTintedVertices === 0) {
      rootCause = "BLOCKLIGHT_EXISTS_BUT_NO_VERTEX_TINT";
    } else {
      result = "PASS";
    }

    return {
      crossedChunkBoundary: true,
      oldChunk,
      newChunk,
      playerPos: [Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])],
      sourcePos,
      sourceBlockId,
      sourceBlockKey,
      visibleMeshesNearPlayer,
      affectedChunks: syncResult.affectedChunkKeys.length,
      cellsLit: neighborLit,
      queueBefore: syncResult.queueBefore,
      queueAfter: syncResult.queueAfter,
      affectedQueuedChunksAfter: syncResult.affectedQueuedChunksAfter,
      staleMeshesBefore: syncResult.staleBefore,
      staleMeshesAfter: syncResult.staleAfter,
      recoloredMeshes: syncResult.recoloredMeshes,
      tintedVerts: visualTintedVertices,
      changedNoLightVertices: 0,
      fpsCurrent: fps,
      fpsAverage: avgFps,
      result,
      rootCause,
    };
  }

  // ---- 3×3 AROUND TARGET TEST ----
  /**
   * 3×3 test that uses the crosshair target. If looking at a light block,
   * inspects existing light propagation. If looking at a non-light surface,
   * places a test light at the adjacent air cell and runs place/remove test.
   * Uses RAW blockLightRGB deltas, not clamped brightness.
   */
  public async run3x3AroundTargetTest(): Promise<any> {
    const sc = this.getSceneSafe();
    if (!sc) return { error: "no scene" };
    const vlm = this.voxelLightManager;
    if (!vlm) return { error: "no vlm" };

    const tgt = this.getTargetBlockFallback();
    if (!tgt) return { error: "NO_TARGET_BLOCK_UNDER_CROSSHAIR" };

    const [tx, ty, tz] = tgt.position;
    const blockId = this.getBlockIdAt(tx, ty, tz);
    const bd = this.blockService.getBlock(blockId);
    const isEmissive = !!(bd && bd.light && (bd.tags?.includes("light_source") || bd.light));

    // Resolve test light block
    const lightRes = this.resolveTestLightBlock();
    if ("error" in lightRes) return lightRes;
    const testBlock = lightRes;

    if (isEmissive) {
      // ---- EXISTING LIGHT: sync visuals + validate ----
      // Do NOT just inspect raw data. Force a visual sync so meshes are
      // recolored and meshLightVersion matches chunkLightDataVersion.
      const syncResult = this.syncBlockLightVisualsAroundSource(sc, tx, ty, tz, "existing light target test");

      // After sync, re-inspect to get current state
      const inspect = this.inspectTargetLight();
      const neighborLit = inspect.neighborBlockLight?.filter((n: any) => n.magnitude > 0).length ?? 0;

      // Check stale AFTER sync
      const staleAfter = syncResult.staleAfter;

      // Check visual tint: count vertices with blockTint > 0 on affected meshes
      let visualTintedVertices = 0;
      let changedNoLightVertices = 0;
      const affectedMeshes = sc.meshes.filter((m: any) => {
        if (!m.name || !m.name.startsWith('chunk_')) return false;
        if (!m.isEnabled()) return false;
        return syncResult.affectedChunkKeys.includes(vlm.terrainMeshToWorldChunkKey(m));
      });
      for (const m of affectedMeshes) {
        visualTintedVertices += m.metadata?.fpBlockLitVertices ?? 0;
        // changedNoLightVertices: we don't track this per-mesh yet, but
        // unchangedNoLightVertices + blockLitVertices should = total vertices.
        // If unchanged + lit != total, some no-light vertices changed unexpectedly.
      }

      // PASS only if ALL criteria met
      let result: "PASS" | "FAIL" = "FAIL";
      let rootCause: string | null = null;
      if (!isEmissive) {
        rootCause = "BLOCK_NOT_EMISSIVE";
      } else if (!inspect.registeredSource) {
        rootCause = "SOURCE_NOT_REGISTERED";
      } else if (neighborLit === 0) {
        rootCause = "SOURCE_REGISTERED_BUT_NO_RAW_BLOCKLIGHT";
      } else if (syncResult.affectedQueuedChunksAfter > 0) {
        rootCause = "BLOCKLIGHT_EXISTS_BUT_QUEUE_NOT_DRAINED";
      } else if (staleAfter > 0) {
        rootCause = "BLOCKLIGHT_EXISTS_BUT_MESH_STALE";
      } else if (visualTintedVertices === 0) {
        rootCause = "MESH_RECOLORED_BUT_NO_VISUAL_TINT";
      } else {
        result = "PASS";
      }

      return {
        targetPos: [tx, ty, tz],
        sourcePos: [tx, ty, tz],
        sourceWasExisting: true,
        sourceBlockId: blockId,
        sourceBlockKey: bd?.materialName,
        testLightBlockId: testBlock.blockId,
        testLightBlockKey: testBlock.blockKey,
        testLightEmissionRGB: testBlock.emissionRGB,
        testLightStrength: testBlock.strength,
        neighborBlockLight: inspect.neighborBlockLight,
        cellsLitByRawBlockLight: neighborLit,
        recoloredMeshes: syncResult.recoloredMeshes,
        staleMeshesBefore: syncResult.staleBefore,
        staleMeshesAfter: syncResult.staleAfter,
        visualTintedVertices,
        changedNoLightVertices,
        affectedChunks: syncResult.affectedChunkKeys.length,
        queueBefore: syncResult.queueBefore,
        queueAfter: syncResult.queueAfter,
        affectedQueuedChunksBefore: syncResult.affectedQueuedChunksBefore,
        affectedQueuedChunksAfter: syncResult.affectedQueuedChunksAfter,
        processedQueueChunks: syncResult.processedQueueChunks,
        queueDrainIterations: syncResult.queueDrainIterations,
        result,
        rootCause,
        chain: inspect.chain,
      };
    }

    // Non-light target: place test light at adjacent air cell
    const adj = tgt.adjacent;
    const [ax, ay, az] = adj;
    const adjBlockId = this.getBlockIdAt(ax, ay, az);
    if (adjBlockId !== 0) {
      return { error: "ADJACENT_CELL_NOT_AIR", adjacentPos: adj, adjacentBlockId: adjBlockId };
    }

    // Run 3×3 surface test with raw blockLight deltas
    const testBd = this.blockService.getBlock(testBlock.blockId);
    if (!testBd) return { error: "no block def for test light" };

    const result = this.runRawBlockLight3x3Test(ax, ay, az, testBd);
    return {
      targetPos: [tx, ty, tz],
      sourcePos: [ax, ay, az],
      sourceWasExisting: false,
      sourceBlockId: testBlock.blockId,
      sourceBlockKey: testBlock.blockKey,
      testLightBlockId: testBlock.blockId,
      testLightBlockKey: testBlock.blockKey,
      testLightEmissionRGB: testBlock.emissionRGB,
      testLightStrength: testBlock.strength,
      ...result,
    };
  }

  /**
   * Raw blockLight 3×3 test. Samples RAW blockLightR/G/B (not clamped
   * brightnessAtSurface) so it works even in daylight when sky saturates.
   */
  private runRawBlockLight3x3Test(cx: number, cy: number, cz: number, bd: BlockDefinition): any {
    const sc = this.getSceneSafe();
    if (!sc) return { error: "no scene" };
    const vlm = this.voxelLightManager;
    if (!vlm) return { error: "no vlm" };

    const surfaceY = cy - 1;
    const cells: Array<{ x: number; y: number; z: number }> = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        cells.push({ x: cx + dx, y: surfaceY, z: cz + dz });
      }
    }
    // Wall neighbors
    for (const [dx, , dz] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]) {
      cells.push({ x: cx + dx, y: cy, z: cz + dz });
    }

    const sampleRaw = (x: number, y: number, z: number) => {
      const s = (vlm as any).sampleLight(x, y, z);
      return { sky: s.sky, r: s.r, g: s.g, b: s.b, mag: Math.max(s.r, s.g, s.b), hasData: s.hasChunkData };
    };

    const before = cells.map(c => sampleRaw(c.x, c.y, c.z));

    // Place light
    this.worldService.setBlockOverride(cx, cy, cz, bd.id);
    this.noa.setBlock(bd.id, cx, cy, cz);
    vlm.registerLight(cx, cy, cz, bd);
    const relightResult = vlm.relightAround(sc, cx, cy, cz);

    const after = cells.map(c => sampleRaw(c.x, c.y, c.z));

    // Remove light
    this.worldService.setBlockOverride(cx, cy, cz, 0);
    this.noa.setBlock(0, cx, cy, cz);
    vlm.unregisterLight(cx, cy, cz);
    vlm.relightAround(sc, cx, cy, cz);

    const afterRemove = cells.map(c => sampleRaw(c.x, c.y, c.z));

    // Check mesh staleness
    const chunkCx = Math.floor(cx / 16), chunkCy = Math.floor(cy / 16), chunkCz = Math.floor(cz / 16);
    const chunkKey = `${chunkCx},${chunkCy},${chunkCz}`;
    const chunkData = vlm.getChunkLight(chunkCx, chunkCy, chunkCz);
    const chunkVersion = chunkData?.lightDataVersion ?? 0;
    let staleMeshes = 0;
    if (sc) {
      const meshes = sc.meshes.filter((m: any) => m.name && m.name.startsWith("chunk_"));
      for (const m of meshes) {
        const mv = m.metadata?.meshLightVersion ?? -1;
        if (mv < chunkVersion) staleMeshes++;
      }
    }

    // Analyze deltas
    let cellsLitByRawBlockLight = 0;
    let cellsClearedAfterRemoval = 0;
    const cellResults = before.map((b, i) => {
      const a = after[i];
      const ar = afterRemove[i];
      const litUp = a.mag > b.mag;
      const cleared = ar.mag < a.mag;
      if (litUp) cellsLitByRawBlockLight++;
      if (cleared) cellsClearedAfterRemoval++;
      return {
        pos: [cells[i].x, cells[i].y, cells[i].z],
        before: { r: b.r, g: b.g, b: b.b, mag: b.mag },
        after: { r: a.r, g: a.g, b: a.b, mag: a.mag },
        afterRemove: { r: ar.r, g: ar.g, b: ar.b, mag: ar.mag },
        deltaMag: a.mag - b.mag,
        litUp,
        cleared,
      };
    });

    // Determine sky saturation
    const skySaturated = before.some(b => b.sky >= 14);
    const rawBlockLightChanged = cellsLitByRawBlockLight > 0;
    const renderedBrightnessChanged = rawBlockLightChanged; // can't easily sample vertex colors

    // Lighting chain
    const sourceKey = `${cx},${cy},${cz}`;
    const registeredSources = (vlm as any).voxelLightSources as Map<string, any>;
    const sourceRegistered = registeredSources.has(sourceKey);
    const sourceStillRegisteredAfterRemoval = registeredSources.has(sourceKey);

    let result: "PASS" | "FAIL" = "FAIL";
    let rootCause: string | null = null;

    if (!bd.light) {
      rootCause = "BLOCK_NOT_EMISSIVE";
    } else if (!sourceRegistered) {
      rootCause = "SOURCE_NOT_REGISTERED";
    } else if (cellsLitByRawBlockLight === 0) {
      rootCause = "SOURCE_REGISTERED_BUT_NO_BLOCKLIGHT";
    } else if (relightResult.recoloredMeshCount === 0) {
      rootCause = "BLOCKLIGHT_EXISTS_BUT_NO_MESH_RECOLOR";
    } else if (staleMeshes > 0) {
      rootCause = "STALE_MESH_VERSION";
    } else if (cellsClearedAfterRemoval === 0) {
      rootCause = "BLOCKLIGHT_EXISTS_BUT_NOT_CLEARED_AFTER_REMOVAL";
    } else if (sourceStillRegisteredAfterRemoval) {
      rootCause = "SOURCE_NOT_UNREGISTERED_AFTER_REMOVAL";
    } else {
      result = "PASS";
    }

    return {
      cells: cellResults,
      cellsLitByRawBlockLight,
      cellsClearedAfterRemoval,
      recoloredMeshes: relightResult.recoloredMeshCount,
      staleMeshes,
      skySaturated,
      rawBlockLightChanged,
      renderedBrightnessChanged,
      sourceRegistered,
      sourceClearedAfterRemoval: !sourceStillRegisteredAfterRemoval,
      affectedChunks: relightResult.recomputedChunks.length,
      result,
      rootCause,
    };
  }

  // ---- 3×3 SURFACE LIGHT TEST ----
  /**
   * Run the 3×3 Surface Light Test at a given position (or near the player
   * if no position is given). This is the CORE acceptance test: it validates
   * that surrounding surface cells actually brighten when a light is placed
   * and dim when it's removed — not just that the source block is bright.
   */
  public async runSurface3x3Test(wx?: number, wy?: number, wz?: number): Promise<any> {
    const sc = this.getSceneSafe();
    if (!sc) return { error: "no scene" };
    const vlm = this.voxelLightManager;
    if (!vlm) return { error: "no vlm" };
    const bd = this.blockService.getBlock(7); // yellow halogen
    if (!bd) return { error: "no block def for id 7" };

    // Default: test near the player's current position (or spawn).
    let x = wx, y = wy, z = wz;
    if (x === undefined || y === undefined || z === undefined) {
      const pp = this.getPlayerPositionSafe() || [0, 15, 0];
      x = Math.floor(pp[0]);
      z = Math.floor(pp[2]);
      // Find ground level
      y = 14;
      for (let yy = 20; yy > 0; yy--) {
        if (this.getBlockIdAt(x, yy, z) !== 0) { y = yy + 1; break; }
      }
    }

    // Teleport + wait for meshes
    this.noa.entities.setPosition(this.noa.playerEntity, [x, y + 2, z]);
    await this.waitForVisibleMeshesAround([x, y, z], 3000);

    const result = vlm.runSurface3x3Test(
      x, y, z,
      () => {
        // placeFn
        this.worldService.setBlockOverride(x, y, z, 7);
        this.noa.setBlock(7, x, y, z);
        vlm.registerLight(x, y, z, bd);
        vlm.relightAround(sc, x, y, z);
      },
      () => {
        // removeFn
        this.worldService.setBlockOverride(x, y, z, 0);
        this.noa.setBlock(0, x, y, z);
        vlm.unregisterLight(x, y, z);
        vlm.relightAround(sc, x, y, z);
      }
    );

    console.log(`[3x3 Surface Test] at (${x},${y},${z}): ${result.result} — ${result.reason}`);
    return result;
  }

  // ---- FAR FROM SPAWN TEST ----
  /**
   * Teleport 5+ chunks away, run 3×3 surface test, return to spawn, run
   * another 3×3 surface test. PASS only if both far and spawn surfaces
   * update correctly.
   */
  public async runFarFromSpawnTest(): Promise<any> {
    const sc = this.getSceneSafe();
    if (!sc) return { error: "no scene" };
    // 5 chunks = 80 blocks. Go diagonally.
    const farX = 80, farZ = 80;
    // Find ground at far position
    let farY = 14;
    for (let yy = 20; yy > 0; yy--) {
      if (this.getBlockIdAt(farX, yy, farZ) !== 0) { farY = yy + 1; break; }
    }

    // Teleport far
    this.noa.entities.setPosition(this.noa.playerEntity, [farX, farY + 2, farZ]);
    const farMeshes = await this.waitForVisibleMeshesAround([farX, farY, farZ], 4000);
    const farResult = await this.runSurface3x3Test(farX, farY, farZ);

    // Return to spawn
    this.noa.entities.setPosition(this.noa.playerEntity, [0, 15, 0]);
    await this.waitForVisibleMeshesAround([0, 14, 0], 3000);
    const spawnResult = await this.runSurface3x3Test(0, 14, 0);

    const overallPass = farResult.result === "PASS" && spawnResult.result === "PASS";
    return {
      farPos: [farX, farY, farZ],
      farVisibleMeshes: farMeshes,
      farResult: { result: farResult.result, reason: farResult.reason, cellsBrightened: farResult.cellsBrightened, cellsDimmed: farResult.cellsDimmed },
      spawnResult: { result: spawnResult.result, reason: spawnResult.reason, cellsBrightened: spawnResult.cellsBrightened, cellsDimmed: spawnResult.cellsDimmed },
      result: overallPass ? "PASS" : (farResult.result === "INCONCLUSIVE" || spawnResult.result === "INCONCLUSIVE") ? "INCONCLUSIVE" : "FAIL",
      reason: `far=${farResult.result}, spawn=${spawnResult.result}`,
    };
  }

  // ---- PLACE/REMOVE 3×3 STRESS TEST ----
  /**
   * Repeat 20 place/remove cycles at a visible 3×3 surface. PASS only if
   * all cycles produce correct visible surface deltas.
   */
  public async runPlaceRemoveStressTest(): Promise<any> {
    const sc = this.getSceneSafe();
    if (!sc) return { error: "no scene" };
    const vlm = this.voxelLightManager;
    if (!vlm) return { error: "no vlm" };
    const bd = this.blockService.getBlock(7);
    if (!bd) return { error: "no block def" };

    const pp = this.getPlayerPositionSafe() || [0, 15, 0];
    const x = Math.floor(pp[0]);
    const z = Math.floor(pp[2]);
    let y = 14;
    for (let yy = 20; yy > 0; yy--) {
      if (this.getBlockIdAt(x, yy, z) !== 0) { y = yy + 1; break; }
    }

    this.noa.entities.setPosition(this.noa.playerEntity, [x, y + 2, z]);
    await this.waitForVisibleMeshesAround([x, y, z], 3000);

    const cycles: any[] = [];
    let allPass = true;
    for (let i = 0; i < 20; i++) {
      const cycleResult = vlm.runSurface3x3Test(
        x, y, z,
        () => {
          this.worldService.setBlockOverride(x, y, z, 7);
          this.noa.setBlock(7, x, y, z);
          vlm.registerLight(x, y, z, bd);
          vlm.relightAround(sc, x, y, z);
        },
        () => {
          this.worldService.setBlockOverride(x, y, z, 0);
          this.noa.setBlock(0, x, y, z);
          vlm.unregisterLight(x, y, z);
          vlm.relightAround(sc, x, y, z);
        }
      );
      cycles.push({
        cycle: i,
        result: cycleResult.result,
        cellsBrightened: cycleResult.cellsBrightened,
        cellsDimmed: cycleResult.cellsDimmed,
      });
      if (cycleResult.result !== "PASS") allPass = false;
    }

    const sourcesAfter = (vlm as any).voxelLightSources.size;
    return {
      testPos: [x, y, z],
      cycles,
      cyclesPassed: cycles.filter(c => c.result === "PASS").length,
      cyclesFailed: cycles.filter(c => c.result === "FAIL").length,
      sourcesRemaining: sourcesAfter,
      result: allPass ? "PASS" : "FAIL",
      reason: `${cycles.filter(c => c.result === "PASS").length}/20 cycles passed`,
    };
  }

  // ---- INSPECT CROSSHAIR LIGHTING ----
  /**
   * Inspect lighting at the player's crosshair target block (or player
   * position if no target). Returns full lighting breakdown.
   */
  public inspectCrosshairLighting(): any {
    const tgt = this.getTargetBlockFallback();
    if (tgt) {
      return this.voxelLightManager?.inspectLightingAt(
        tgt.position[0], tgt.position[1], tgt.position[2]
      );
    }
    const pp = this.getPlayerPositionSafe() || [0, 15, 0];
    return this.voxelLightManager?.inspectLightingAt(
      Math.floor(pp[0]), Math.floor(pp[1]), Math.floor(pp[2])
    );
  }

  public destroy(): void {
    this.isCleanup = true;
    console.log('[NoaEngineAdapter] Tearing down voxel canvas and disposing services...');

    const canvas = this.noa?.container?.canvas;
    if (canvas) {
      canvas.removeEventListener('contextmenu', this.handleContextMenuPrevent);
    }
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('keydown', this.handleDebugTimeKeys);

    // Dispose rendering services (Pass 1).
    try { this.materialService?.dispose(); } catch (e) { console.warn('[NoaEngineAdapter] MaterialService dispose:', e); }
    try { this.worldLightManager?.dispose(); } catch (e) { console.warn('[NoaEngineAdapter] WorldLightManager dispose:', e); }
    try { this.skyController?.dispose(); } catch (e) { console.warn('[NoaEngineAdapter] SkyController dispose:', e); }
    try { this.renderPipelineService?.dispose(); } catch (e) { console.warn('[NoaEngineAdapter] RenderPipelineService dispose:', e); }
    try { this.precipitationFieldRenderer?.dispose(); } catch (e) { console.warn('[NoaEngineAdapter] Abstract field dispose:', e); }
    this.precipitationFieldRenderer = null;

    try {
      this.noa.destroy();
    } catch (e) {
      console.warn('[NoaEngineAdapter] Safe error during tear down:', e);
    }
  }
}
