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
import { GameEvent, GameEventType } from '../types';
import { gameState } from '../game/game-state';
import { ModRegistry } from '../modding/mod-registry';
import { AudioService } from '../audio/audio-service';

// Rendering services (Pass 1).
import { MaterialService } from './rendering/material-service';
import { RenderPipelineService } from './rendering/render-pipeline-service';
import { WorldLightManager } from './rendering/world-light-manager';
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
  /** Tracks the currently-applied terrain material mode to avoid per-frame re-application. */
  private currentTerrainMaterialMode: "default" | "custom" | "debug" = "default";
  /** Live-tunable visual parameters (F3 debug console). */
  private visualTuning: VisualTuning = loadVisualTuning();

  // Rendering services (Pass 1).
  private materialService: MaterialService | null = null;
  private renderPipelineService: RenderPipelineService | null = null;
  private worldLightManager: WorldLightManager | null = null;
  private skyController: SkyController | null = null;
  private graphicsSettings: GraphicsSettings;

  // ---- Debug source tracking (sky/fog color provenance) ----
  /** Human-readable source of the currently-applied sky/clear color. */
  private skyColorSource: string = "built-in preset";
  /** Human-readable source of the currently-applied fog color. */
  private fogColorSource: string = "built-in preset";
  /** Active sky (clear) color as a hex string, for F3 readback. */
  private activeSkyColorHex: string = "#000000";
  /** Active fog color as a hex string, for F3 readback. */
  private activeFogColorHex: string = "#000000";
  /** Whether the mod sky overlay is currently applied to the scene. */
  private modSkyOverlayActive: boolean = false;
  /** Current lighting phase label (dawn/day/dusk/night). */
  private lightingPhase: string = "day";

  // ---- Test-mode flags (Full Dark / Noon / Lamp Only) ----
  /** When true, applyAtmosphereForCurrentPhase forces near-zero lighting. */
  private fullDarkTestActive: boolean = false;
  /** When true, forces bright noon lighting regardless of time-of-day. */
  private noonLightingTestActive: boolean = false;
  /** When true, disables fog/glow/bloom + near-zero ambient/sun/moon, dynamic lights on. */
  private lampOnlyTestActive: boolean = false;

  // ---- Chunk + FPS diagnostics ----
  private chunkGenCount: number = 0;
  private chunkGenTotalMs: number = 0;
  private chunkGenMaxMs: number = 0;
  private chunksThisWindow: number = 0;
  private lastChunksPerSecTime: number = Date.now();
  private chunksPerSec: number = 0;
  private pendingChunkRequests: number = 0;
  private frameCount: number = 0;
  private fps: number = 0;
  private lastFpsTime: number = performance.now();
  private lastFpsFrameCount: number = 0;

  constructor(
    container: HTMLElement,
    playerService: PlayerService,
    worldService: WorldService,
    blockService: BlockService,
    missionService: MissionService,
    uiService: UiService
  ) {
    this.containerElement = container;
    this.playerService = playerService;
    this.worldService = worldService;
    this.blockService = blockService;
    this.missionService = missionService;
    this.uiService = uiService;

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
    const spawnPos: [number, number, number] = [0, 15, 0];
    this.noa.entities.setPosition(this.noa.playerEntity, spawnPos);
    this.playerService.updatePosition(spawnPos);

    // 7. Set up preview camera so the world is visible BEFORE pointer lock.
    // noa's camera defaults to heading=0, pitch=0 (looking toward +Z), which
    // may face away from terrain. Point it at the ruin (which has terrain,
    // lamps, and the artifact) so the player sees a live world on boot.
    this.setupPreviewCamera();

    // 8. Sync the mod sky overlay toggle (default OFF) so the legacy
    // example-ruins-pack/sky/sky.json purple overlay does NOT silently
    // dominate the built-in visual presets at boot.
    this.syncModSkyOverlay();

    console.log('[NoaEngineAdapter] Standalone 3D voxel engine fully synchronized.');
  }

  /**
   * Keep ModRegistry's mod-sky-overlay enable flag in sync with the VisualTuning
   * `useModSkyOverlay` toggle. This is the single source of truth: the overlay
   * is applied to the scene ONLY when both vt.useModSkyOverlay is true AND a mod
   * has registered sky values. Default is OFF.
   */
  private syncModSkyOverlay(): void {
    const reg = ModRegistry.getInstance();
    const desired = this.visualTuning.useModSkyOverlay && reg.hasModSkyOverlay();
    if (reg.isModSkyOverlayEnabled() !== desired) {
      reg.setModSkyOverlayEnabled(desired);
    }
    this.modSkyOverlayActive = desired && reg.hasModSkyOverlay();
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
      // Sun orbital position at timeOfDay matches SkyController:
      //   angle = timeOfDay * 2π
      //   sunPos = (cos(angle)*r, sin(angle)*r, r*0.5)
      // We point the camera at the sun so the celestial body is ON-SCREEN at
      // boot (the old fixed downward pitch hid the high sun behind the top of
      // the viewport). A reduced pitch keeps terrain visible in the lower frame.
      const angle = this.timeOfDay * Math.PI * 2;
      const sunDirX = Math.cos(angle);
      const sunDirY = Math.sin(angle);
      const sunDirZ = 0.5; // matches SkyController's +z*0.5 bias
      let heading = Math.atan2(sunDirX, sunDirZ);
      if (heading < 0) heading += Math.PI * 2;
      cam.heading = heading;
      // Sun elevation angle above the horizon (radians).
      const horiz = Math.sqrt(sunDirX * sunDirX + sunDirZ * sunDirZ);
      const sunElevation = Math.atan2(sunDirY, horiz);
      // Aim the camera halfway between the horizon and the sun so BOTH the sun
      // (upper frame) and terrain (lower frame) are visible. noa's pitch is
      // applied as holder.rotation.x: POSITIVE = look DOWN, NEGATIVE = look UP.
      // The sun is up, so we use a negative (upward) pitch, scaled to half the
      // sun's elevation so terrain isn't lost.
      const pitch = -sunElevation * 0.55;
      cam.pitch = Math.max(-0.9, Math.min(0.3, pitch));
      console.log(
        `[NoaEngineAdapter] Preview camera set: heading=${(heading * 180 / Math.PI).toFixed(0)}°, pitch=${cam.pitch.toFixed(2)} rad (aiming at sun, timeOfDay=${this.timeOfDay.toFixed(3)}).`
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
      this.noa.rendering ?? null,
      undefined, // safeMaterialsMode (reads ?safeMaterials=1)
      undefined, // customTerrainMaterialsMode (reads ?customTerrainMaterials=1)
      this.visualTuning.litTerrainMaterials
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

    // Sky + celestial bodies + sun/ambient lights.
    // Pass an octree-registration callback so sky meshes are added to noa's
    // octree dynamicContent — without this, noa's OctreeSceneComponent excludes
    // them from active-mesh candidates and they NEVER RENDER.
    this.skyController = new SkyController(scene, this.graphicsSettings, (mesh) => {
      const octMgr = (this.noa.rendering as any)?._octreeManager;
      if (octMgr && typeof octMgr.addMesh === "function") {
        octMgr.addMesh(mesh, false);
      }
    });

    // World light registry. Pre-seed static + generated lights from WorldService.
    this.worldLightManager = new WorldLightManager(scene, this.graphicsSettings);
    this.worldLightManager.registerStaticLights(
      this.worldService.getStaticLightSources(),
      (id) => this.blockService.getBlock(id)
    );

    // Apply the initial visual preset (fog / clearColor / ambient tuning).
    this.applyAtmosphereForCurrentPhase([0, 15, 0]);

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
        /**
         * MASTER sky-mesh toggle ("Sky Off / Sky On"). Now PERSISTS — it flips
         * SkyController.setMeshesEnabled(), which setVisibilityOverrides()
         * respects every frame. Previously this called a one-shot setVisible()
         * that was immediately re-enabled next frame, so the buttons appeared
         * to do nothing.
         */
        setSkyVisible(visible: boolean) {
          if (adapter.skyController) {
            adapter.skyController.setMeshesEnabled(visible);
            return visible;
          }
          return null;
        },
        /** Granular per-body enable (sun/moon/stars/clouds) via VisualTuning. */
        setSkyBodyVisible(body: "sun" | "moon" | "stars" | "clouds", visible: boolean) {
          const key = body === "sun" ? "sunVisible"
            : body === "moon" ? "moonVisible"
            : body === "stars" ? "starsVisible"
            : "cloudsVisible";
          adapter.updateVisualTuning({ [key]: visible });
          return visible;
        },
        /** Toggle the legacy mod sky overlay (opt-in, default OFF). */
        setModSkyOverlay(enabled: boolean) {
          adapter.setModSkyOverlay(enabled);
          return adapter.modSkyOverlayActive;
        },
        /** Full Dark lighting test (ambient/sun/moon → 0). */
        fullDarkTest() { adapter.fullDarkTest(); },
        /** Noon lighting test (bright day). */
        noonLightingTest() { adapter.noonLightingTest(); },
        /** Lamp Only test (fog/glow/bloom off, ambient/sun/moon → 0, lights on). */
        lampOnlyTest() { adapter.lampOnlyTest(); },
        /** Clear all lighting test modes. */
        clearLightingTests() { adapter.clearLightingTests(); },
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
        /**
         * Isolate sky — hide terrain + world lights, disable fog, set a dark
         * readable clearColor (NOT purple), ensure sky meshes are on, and point
         * the camera at the sun/moon so bodies are on-screen. Pass false to
         * restore. Delegates to the adapter method.
         */
        isolateSky(isolated: boolean) {
          adapter.isolateSky(isolated);
        },
        /** Apply pending chunk distances (requires renderer restart). Best-effort. */
        applyChunkDistances(add: number, remove: number) {
          try {
            const worldAny = (adapter as any).noa?.world as any;
            if (worldAny) {
              if (typeof worldAny.setChunkAddDistance === 'function') worldAny.setChunkAddDistance(add);
              if (typeof worldAny.setChunkRemoveDistance === 'function') worldAny.setChunkRemoveDistance(remove);
            }
          } catch { /* noa may not support live changes */ }
          adapter.updateVisualTuning({ pendingChunkAddDistance: add, pendingChunkRemoveDistance: remove });
          console.warn('[NoaEngineAdapter] Chunk distance changes usually require a renderer restart to fully apply.');
        },
      };

      // ---- Rich debug snapshots (computed lazily on property access) ----
      Object.defineProperty(snapshot, 'sky', {
        get() {
          if (!adapter.skyController) return null;
          return adapter.skyController.getSkyDebug({
            activeSkyColor: adapter.activeSkyColorHex,
            skyColorSource: adapter.skyColorSource,
            activeFogColor: adapter.activeFogColorHex,
            fogColorSource: adapter.fogColorSource,
            modSkyOverlayActive: adapter.modSkyOverlayActive,
          });
        },
        configurable: true,
      });
      Object.defineProperty(snapshot, 'lights', {
        get() {
          const scene = adapter.getSceneSafe();
          const playerPos = adapter.getPlayerPositionSafe() || [0, 15, 0];
          const base = adapter.worldLightManager
            ? adapter.worldLightManager.getDebugInfo(playerPos, 8)
            : { registered: 0, active: 0, nearest: [] };
          // Probe a sample chunk material's maxSimultaneousLights.
          let terrainMaxLights: number | null = null;
          let terrainDisableLighting: boolean | null = null;
          let terrainEmissiveZero: boolean | null = null;
          if (scene) {
            const chunk = scene.meshes.find((m: any) => m.name.startsWith("chunk_") && m.material);
            if (chunk && chunk.material) {
              const mat = chunk.material as BABYLON.StandardMaterial;
              terrainMaxLights = (mat as any).maxSimultaneousLights ?? null;
              terrainDisableLighting = (mat as any).disableLighting ?? null;
              const em = (mat as any).emissiveColor;
              terrainEmissiveZero = em ? (em.r === 0 && em.g === 0 && em.b === 0) : null;
            }
          }
          const budget = adapter.worldLightManager ? adapter.worldLightManager.getBudget() : adapter.graphicsSettings.maxActiveDynamicLights;
          // Is the nearest placed light being limited by the budget?
          let budgetLimitingNearest = false;
          if (base.nearest && base.nearest.length) {
            // If there are more registered lights than budget, any non-active
            // nearest light is being culled by the budget.
            budgetLimitingNearest = base.registered > budget && base.nearest.some((n: any) => !n.active);
          }
          return {
            ...base,
            activeBudget: budget,
            dynamicLightsEnabled: adapter.visualTuning.dynamicLightsEnabled,
            terrainMaterialMaxSimultaneousLights: terrainMaxLights,
            terrainMaterialDisableLighting: terrainDisableLighting,
            terrainMaterialEmissiveZero: terrainEmissiveZero,
            budgetLimitingNearest,
          };
        },
        configurable: true,
      });
      Object.defineProperty(snapshot, 'lighting', {
        get() {
          const scene = adapter.getSceneSafe();
          const amb = scene ? scene.ambientColor : null;
          const sunLight = adapter.skyController?.getSunLight();
          const ambient = adapter.skyController?.getAmbientLight();
          const moon = adapter.skyController?.getMoonLight();
          return {
            timeOfDay: adapter.timeOfDay,
            phase: adapter.lightingPhase,
            sceneAmbientColor: amb ? [amb.r, amb.g, amb.b] : null,
            hemisphericIntensity: ambient?.intensity ?? 0,
            sunIntensity: sunLight?.intensity ?? 0,
            sunDiffuse: sunLight?.diffuse ? [sunLight.diffuse.r, sunLight.diffuse.g, sunLight.diffuse.b] : null,
            moonIntensity: moon?.intensity ?? 0,
            moonDiffuse: moon?.diffuse ? [moon.diffuse.r, moon.diffuse.g, moon.diffuse.b] : null,
            fullDarkTestActive: adapter.fullDarkTestActive,
            noonLightingTestActive: adapter.noonLightingTestActive,
            lampOnlyTestActive: adapter.lampOnlyTestActive,
            requested: {
              daySceneAmbient: adapter.visualTuning.daySceneAmbient,
              nightSceneAmbient: adapter.visualTuning.nightSceneAmbient,
              sceneAmbientMultiplier: adapter.visualTuning.sceneAmbientMultiplier,
              ambientIntensityMultiplier: adapter.visualTuning.ambientIntensityMultiplier,
              sunIntensityMultiplier: adapter.visualTuning.sunIntensityMultiplier,
              noonSunIntensity: adapter.visualTuning.noonSunIntensity,
              midnightSunIntensity: adapter.visualTuning.midnightSunIntensity,
              moonLightEnabled: adapter.visualTuning.moonLightEnabled,
              moonLightIntensity: adapter.visualTuning.moonLightIntensity,
            },
          };
        },
        configurable: true,
      });
      Object.defineProperty(snapshot, 'modSky', {
        get() {
          const reg = ModRegistry.getInstance();
          return {
            overlayActive: adapter.modSkyOverlayActive,
            useModSkyOverlay: adapter.visualTuning.useModSkyOverlay,
            registered: reg.hasModSkyOverlay(),
            enabled: reg.isModSkyOverlayEnabled(),
            config: reg.getActiveSky(),
            sources: reg.getActiveSkySources(),
            skyColorSource: adapter.skyColorSource,
            fogColorSource: adapter.fogColorSource,
            activeSkyColorHex: adapter.activeSkyColorHex,
            activeFogColorHex: adapter.activeFogColorHex,
          };
        },
        configurable: true,
      });
      Object.defineProperty(snapshot, 'chunks', {
        get() {
          const scene = adapter.getSceneSafe();
          const meshCount = scene ? scene.meshes.filter((m: any) => m.name.startsWith("chunk_")).length : 0;
          const avg = adapter.chunkGenCount > 0 ? adapter.chunkGenTotalMs / adapter.chunkGenCount : 0;
          return {
            chunkAddDistance: adapter.chunkAddDistance,
            chunkRemoveDistance: adapter.chunkRemoveDistance,
            pendingChunkAddDistance: adapter.visualTuning.pendingChunkAddDistance,
            pendingChunkRemoveDistance: adapter.visualTuning.pendingChunkRemoveDistance,
            blockDataNeededEmitInterval: BLOCK_DATA_NEEDED_EMIT_INTERVAL,
            renderDistanceBlocks: adapter.getRenderDistanceBlocks(),
            loadedChunkCount: meshCount,
            totalGenerated: adapter.chunkGenCount,
            avgGenMs: Number(avg.toFixed(2)),
            maxGenMs: Number(adapter.chunkGenMaxMs.toFixed(2)),
            chunksPerSec: adapter.chunksPerSec,
            fps: adapter.fps,
            fogMatchRenderDistance: adapter.visualTuning.fogMatchRenderDistance,
            showChunkBoundaries: adapter.visualTuning.showChunkBoundaries,
          };
        },
        configurable: true,
      });
      Object.defineProperty(snapshot, 'fps', {
        get() { return adapter.fps; },
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
    // Sync the mod sky overlay toggle whenever it changes.
    if (patch.useModSkyOverlay !== undefined) {
      this.syncModSkyOverlay();
    }
    // Propagate moon-light config to the sky controller.
    if (this.skyController && (
      patch.moonLightEnabled !== undefined ||
      patch.moonLightIntensity !== undefined
    )) {
      this.skyController.setMoonLight({
        enabled: this.visualTuning.moonLightEnabled,
        intensity: this.visualTuning.moonLightIntensity,
      });
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
      // Clear any active test modes when applying a preset.
      this.fullDarkTestActive = false;
      this.noonLightingTestActive = false;
      this.lampOnlyTestActive = false;
      // Sync mod overlay (presets set useModSkyOverlay:false so the legacy
      // purple overlay never silently re-enables).
      this.syncModSkyOverlay();
      // Propagate moon-light config.
      this.skyController?.setMoonLight({
        enabled: this.visualTuning.moonLightEnabled,
        intensity: this.visualTuning.moonLightIntensity,
      });
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
    this.syncModSkyOverlay();
    this.skyController?.setMoonLight({
      enabled: this.visualTuning.moonLightEnabled,
      intensity: this.visualTuning.moonLightIntensity,
    });
    return this.getVisualTuning();
  }

  // ---- Lighting test modes (F3 QA buttons) ----

  /**
   * FULL DARK TEST: ambient near zero, hemi=0, sun=0, moon=0. Normal terrain
   * MUST become genuinely dark. If it doesn't, the terrain material is unlit /
   * fullbright / emissive and must be fixed (disableLighting=false,
   * emissiveColor=0). Clears other test modes.
   */
  public fullDarkTest(): void {
    this.fullDarkTestActive = true;
    this.noonLightingTestActive = false;
    this.lampOnlyTestActive = false;
    console.log("[NoaEngineAdapter] FULL DARK TEST active — terrain should be dark.");
  }

  /**
   * NOON LIGHTING TEST: restore bright day lighting (ambient + sun at day
   * values) regardless of time-of-day. Terrain should be bright.
   */
  public noonLightingTest(): void {
    this.fullDarkTestActive = false;
    this.noonLightingTestActive = true;
    this.lampOnlyTestActive = false;
    console.log("[NoaEngineAdapter] NOON LIGHTING TEST active — terrain should be bright.");
  }

  /**
   * LAMP ONLY TEST: fog off, glow off, bloom off, ambient/sun/moon near zero,
   * dynamic lights ENABLED. Place a yellow (halogen, id 7) or cyan (wall lamp,
   * id 6) block — nearby terrain MUST receive colored illumination. Destroying
   * the block removes the light. This proves PointLights actually light terrain
   * (GlowLayer/emissive are NOT lighting).
   */
  public lampOnlyTest(): void {
    this.fullDarkTestActive = false;
    this.noonLightingTestActive = false;
    this.lampOnlyTestActive = true;
    // Ensure dynamic lights are on for this test, and boost the budget so the
    // nearest placed lamp actually activates (the proximity-aware sort favors
    // nearby lights, and a higher budget guarantees the test lamp isn't culled
    // by far mission artifacts).
    this.visualTuning.dynamicLightsEnabled = true;
    this.visualTuning.activeLightBudget = Math.max(8, this.visualTuning.activeLightBudget);
    this.worldLightManager?.setBudget(this.visualTuning.activeLightBudget);
    console.log("[NoaEngineAdapter] LAMP ONLY TEST active — place lamps to verify dynamic lighting.");
  }

  /** Clear all lighting test modes (return to normal day/night). */
  public clearLightingTests(): void {
    this.fullDarkTestActive = false;
    this.noonLightingTestActive = false;
    this.lampOnlyTestActive = false;
    console.log("[NoaEngineAdapter] Lighting test modes cleared.");
  }

  /** Toggle the mod sky overlay at runtime (F3). */
  public setModSkyOverlay(enabled: boolean): void {
    this.visualTuning.useModSkyOverlay = !!enabled;
    this.syncModSkyOverlay();
  }

  /**
   * ISOLATE SKY: hide terrain + world lights so only the celestial bodies
   * remain. Unlike the old version (which left the purple mod-overlay
   * clearColor), this:
   *   - sets a sticky `skyIsolated` flag that applyAtmosphereForCurrentPhase()
   *     respects (so the per-frame fog/clearColor apply does NOT overwrite the
   *     isolate state)
   *   - disables fog (so no haze hides the bodies)
   *   - forces a dark, readable clearColor (not purple)
   *   - ensures sky meshes are master-enabled
   *   - repositions the camera to look toward the sun (so bodies are on-screen)
   * Pass false to restore the scene.
   */
  public isolateSky(isolated: boolean): void {
    const scene = this.getSceneSafe();
    if (!scene) return;
    this.skyIsolated = isolated;
    if (isolated) {
      // Stash current fog/clear state so we can restore.
      this._preIsolateFogEnabled = scene.fogEnabled;
      this._preIsolateClearColor = scene.clearColor ? scene.clearColor.clone() : null;
      this._preIsolateSkyMeshesEnabled = this.skyController?.isMeshesEnabled() ?? true;

      scene.meshes.forEach((m: any) => {
        if (m.name.startsWith("chunk_") || m.name.startsWith("wl-")) {
          m.setEnabled(false);
        }
      });
      scene.fogEnabled = false;
      // Dark navy, NOT purple — clearly readable for celestial bodies.
      scene.clearColor = new BABYLON.Color4(0.01, 0.01, 0.03, 1.0);
      this.skyController?.setMeshesEnabled(true);

      // Reposition camera to look at the sun so bodies are on-screen.
      this.pointCameraAtSun();
      console.log("[NoaEngineAdapter] Sky isolated — terrain/lights hidden, camera pointed at sun.");
    } else {
      scene.meshes.forEach((m: any) => {
        if (m.name.startsWith("chunk_") || m.name.startsWith("wl-")) {
          m.setEnabled(true);
        }
      });
      if (this._preIsolateFogEnabled !== null) scene.fogEnabled = this._preIsolateFogEnabled;
      if (this._preIsolateClearColor) scene.clearColor = this._preIsolateClearColor;
      if (this._preIsolateSkyMeshesEnabled !== null) {
        this.skyController?.setMeshesEnabled(this._preIsolateSkyMeshesEnabled);
      }
      console.log("[NoaEngineAdapter] Sky restored — terrain/lights re-enabled.");
    }
  }

  /** Sticky flag: when true, applyAtmosphereForCurrentPhase skips fog/clearColor. */
  private skyIsolated: boolean = false;

  private _preIsolateFogEnabled: boolean | null = null;
  private _preIsolateClearColor: BABYLON.Color4 | null = null;
  private _preIsolateSkyMeshesEnabled: boolean | null = null;

  /**
   * Point the noa/Babylon camera toward the current sun (or moon) position so
   * celestial bodies are CENTERED on-screen (used by Isolate Sky). Does NOT
   * request pointer lock. noa applies cam.heading/pitch to the camera holder
   * every render frame, and these persist when pointer lock is not active.
   *
   * Convention (from noa-engine camera.js):
   *   - heading 0 = +Z, heading π/2 = +X (yaw around Y)
   *   - pitch: POSITIVE = look DOWN, NEGATIVE = look UP (rotateX)
   * So to look UP at a sun above the horizon, pitch must be NEGATIVE.
   */
  private pointCameraAtSun(): void {
    try {
      const cam = (this.noa as any).camera;
      const scene = this.getSceneSafe();
      if (!cam || !scene) return;
      const sunMesh = scene.getMeshByName("fp_sun");
      const moonMesh = scene.getMeshByName("fp_moon");
      // Prefer whichever body is currently visible.
      const target = sunMesh && sunMesh.isEnabled() && sunMesh.isVisible
        ? sunMesh
        : moonMesh && moonMesh.isEnabled() && moonMesh.isVisible
        ? moonMesh
        : sunMesh ?? moonMesh ?? null;
      if (!target) return;
      const tpos = target.getAbsolutePosition();
      // Camera world position = the holder position (camera is parented to it).
      const holder = (this.noa as any).rendering?._cameraHolder;
      const cpos = holder ? holder.position : (scene.activeCamera ? scene.activeCamera.position : null);
      if (!cpos || !tpos) return;
      const dx = tpos.x - cpos.x;
      const dz = tpos.z - cpos.z;
      const dy = tpos.y - cpos.y;
      // heading = atan2(dx, dz) (0 = +Z, π/2 = +X)
      let heading = Math.atan2(dx, dz);
      if (heading < 0) heading += Math.PI * 2;
      cam.heading = heading;
      // pitch: NEGATIVE to look up. Center the body fully.
      const horiz = Math.sqrt(dx * dx + dz * dz);
      const elevation = Math.atan2(dy, horiz); // positive when sun is above
      const pitch = -elevation; // negate so camera looks UP
      // Clamp to noa's safe range (just under ±π/2).
      cam.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, pitch));
      console.log(`[NoaEngineAdapter] Camera pointed at ${target.name} (heading=${(heading * 180 / Math.PI).toFixed(0)}°, pitch=${(cam.pitch * 180 / Math.PI).toFixed(0)}°).`);
    } catch (e) {
      console.warn("[NoaEngineAdapter] pointCameraAtSun failed:", e);
    }
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
    this.currentTerrainMaterialMode = enabled ? "debug" : "default";
    return enabled;
  }

  /** Actual render distance in blocks (chunkAddDistance × chunkSize). */
  public getRenderDistanceBlocks(): number {
    return this.chunkAddDistance * CHUNK_SIZE;
  }

  private setupWorldDataHandler(): void {
    const ENABLE_PERF_LOGS = true;

    this.noa.world.on('worldDataNeeded', (id: string, ndarray: any, x: number, y: number, z: number) => {
      const start = performance.now();
      const shape = ndarray.shape;
      for (let i = 0; i < shape[0]; ++i) {
        for (let j = 0; j < shape[1]; ++j) {
          for (let k = 0; k < shape[2]; ++k) {
            const voxelId = this.worldService.getBlockAt(x + i, y + j, z + k);
            ndarray.set(i, j, k, voxelId);
          }
        }
      }
      this.noa.world.setChunkData(id, ndarray);
      const elapsed = performance.now() - start;

      // Chunk diagnostics for F3: total count, avg/max gen time, chunks/sec.
      this.chunkGenCount++;
      this.chunkGenTotalMs += elapsed;
      if (elapsed > this.chunkGenMaxMs) this.chunkGenMaxMs = elapsed;
      this.chunksThisWindow++;

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

    this.worldService.setBlockOverride(pos[0], pos[1], pos[2], 0);
    this.noa.setBlock(0, pos[0], pos[1], pos[2]);

    // Data-driven light teardown: if the destroyed block was a light source,
    // remove it from the persistent registry. No hardcoded block IDs.
    this.worldLightManager?.unregisterLight(pos[0], pos[1], pos[2]);

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

    this.worldService.setBlockOverride(adjacent[0], adjacent[1], adjacent[2], currentSelected);
    this.noa.setBlock(currentSelected, adjacent[0], adjacent[1], adjacent[2]);

    // Data-driven light registration: if the placed block is a light source
    // (has tags.light_source OR a light profile), WorldLightManager will
    // register it. No hardcoded block IDs.
    const blockDef = this.blockService.getBlock(currentSelected);
    if (blockDef) {
      this.worldLightManager?.registerLight(
        adjacent[0], adjacent[1], adjacent[2], blockDef
      );
    }

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

      // FPS + chunks-per-sec diagnostics for F3.
      this.frameCount++;
      const fpsElapsed = now - this.lastFpsTime;
      if (fpsElapsed >= 500) {
        this.fps = Math.round(((this.frameCount - this.lastFpsFrameCount) * 1000) / fpsElapsed);
        this.lastFpsFrameCount = this.frameCount;
        this.lastFpsTime = now;
      }
      const cpsNow = Date.now();
      if (cpsNow - this.lastChunksPerSecTime >= 1000) {
        this.chunksPerSec = this.chunksThisWindow;
        this.chunksThisWindow = 0;
        this.lastChunksPerSecTime = cpsNow;
      }

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
            AudioService.getInstance().playArtifactPickup();
          }
        });

        this.playerService.updatePosition(pos as [number, number, number]);

        const headingObj = (this.noa as any).camera;
        const yawRad = headingObj ? headingObj.heading || 0 : 0;
        gameState.playerYaw = (yawRad * 180 / Math.PI) % 360;
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
   * mod sky overlays (ONLY when explicitly enabled), apply VisualTuning live
   * overrides, and apply to the scene + pipeline.
   *
   * SKY OVERLAY AUDIT (this pass):
   *   - The mod sky overlay is now OPT-IN. It only applies when
   *     `visualTuning.useModSkyOverlay` is true AND a mod has registered sky
   *     values. The old code merged it every frame, letting the legacy
   *     example-ruins-pack/sky/sky.json purple values silently dominate.
   *   - skyColor / fogColor sources are tracked and exposed via
   *     __fpDebug().sky for F3.
   *   - scene.ambientColor is now driven by the day/night cycle (was a constant
   *     0.5,0.5,0.5 — the root cause of "night never gets dark" and "lamps
   *     don't illuminate terrain").
   *   - Test modes (Full Dark / Noon / Lamp Only) override lighting for QA.
   */
  private applyAtmosphereForCurrentPhase(
    playerPos: [number, number, number],
    sunAltitude?: number
  ): void {
    const scene = this.getSceneSafe();
    if (!scene) return;

    // Keep the mod overlay flag in sync each frame (cheap).
    this.syncModSkyOverlay();

    const [x, , z] = playerPos;
    const inBlackGlass = this.worldService.isBlackGlassZone(x, z);
    const biome: "red_wasteland" | "black_glass_canyon" = inBlackGlass
      ? "black_glass_canyon"
      : "red_wasteland";

    let altitude = sunAltitude;
    if (altitude === undefined) {
      const angle = this.timeOfDay * Math.PI * 2;
      altitude = Math.sin(angle);
    }

    // Lighting phase label for F3.
    if (altitude > 0.15) this.lightingPhase = "day";
    else if (altitude > -0.15) this.lightingPhase = altitude >= 0 ? "dusk" : "dawn";
    else this.lightingPhase = "night";

    const vt = this.visualTuning;

    // ---- Resolve base preset (built-in) ----
    let preset = resolveBiomePhasePreset(biome, altitude);
    let resolvedSkyColor = preset.skyColor;
    let resolvedFogColor = preset.fogColor;
    this.skyColorSource = "built-in preset";
    this.fogColorSource = "built-in preset";

    // ---- Mod sky overlay (OPT-IN) ----
    // Only merge mod values when the toggle is on. This is the fix for the
    // "purple void" — the legacy example-ruins-pack/sky/sky.json no longer
    // silently overrides the built-in presets.
    if (this.modSkyOverlayActive) {
      const merged = this.mergeModSkyOverlay(preset);
      const reg = ModRegistry.getInstance();
      const sources = reg.getActiveSkySources();
      if (merged.skyColor !== preset.skyColor) {
        resolvedSkyColor = merged.skyColor;
        this.skyColorSource = `mod overlay (${sources.skyColor ?? sources.dayColor ?? sources.nightColor ?? 'unknown'})`;
      }
      if (merged.fogColor !== preset.fogColor) {
        resolvedFogColor = merged.fogColor;
        this.fogColorSource = `mod overlay (${sources.fogColor ?? 'unknown'})`;
      }
      preset = merged;
    }

    if (vt.fogAutoClampToRenderDistance) {
      preset = clampPresetToRenderDistance(preset, this.getRenderDistanceBlocks());
    }

    // ---- Fog + ClearColor ----
    // When sky is isolated (Isolate Sky debug mode), SKIP the per-frame
    // fog/clearColor apply so the isolate state (dark navy clearColor, fog off)
    // persists. isolateSky() manages these directly.
    if (!this.skyIsolated) {
      scene.fogEnabled = vt.fogEnabled;
      scene.fogMode = BABYLON.Scene.FOGMODE_LINEAR;
      if (vt.fogColorHex) {
        scene.fogColor = parseHexColor3(vt.fogColorHex, new BABYLON.Color3(0.3, 0.2, 0.3));
        this.fogColorSource = "debug override";
        this.activeFogColorHex = vt.fogColorHex;
      } else {
        scene.fogColor = parseHexColor3(resolvedFogColor, new BABYLON.Color3(0.3, 0.2, 0.3));
        this.activeFogColorHex = resolvedFogColor;
      }
      scene.fogStart = vt.fogStart !== null ? vt.fogStart : preset.fogStart;
      scene.fogEnd = vt.fogEnd !== null ? vt.fogEnd : preset.fogEnd;
      if (scene.fogStart >= scene.fogEnd) {
        scene.fogStart = Math.max(20, scene.fogEnd - 40);
      }

      // ClearColor (sky background) — separate from sky meshes.
      if (vt.clearColorOverrideHex) {
        scene.clearColor = parseHexColor4(
          vt.clearColorOverrideHex,
          new BABYLON.Color4(0.05, 0.03, 0.08, 1.0)
        );
        this.skyColorSource = "debug override (clearColor)";
        this.activeSkyColorHex = vt.clearColorOverrideHex;
      } else {
        scene.clearColor = parseHexColor4(
          resolvedSkyColor,
          new BABYLON.Color4(0.05, 0.03, 0.08, 1.0)
        );
        this.activeSkyColorHex = resolvedSkyColor;
      }
    } else {
      this.skyColorSource = "isolate sky (debug)";
      this.activeSkyColorHex = "#03030A";
      this.fogColorSource = "isolate sky (debug)";
      this.activeFogColorHex = "#03030A";
    }

    // ---- Real day/night brightness ----
    // altitude: -1 (midnight) .. 0 (horizon) .. +1 (noon)
    const dayT = Math.max(0, altitude); // 0 at night, 1 at noon
    const nightT = Math.max(0, -altitude); // 0 at day, 1 at midnight

    let ambientIntensity =
      (vt.dayAmbientIntensity * dayT + vt.nightAmbientIntensity * (1 - dayT)) *
      vt.ambientIntensityMultiplier;
    let sunIntensity =
      (altitude > 0
        ? vt.noonSunIntensity * Math.sqrt(altitude)
        : vt.midnightSunIntensity) * vt.sunIntensityMultiplier;

    // ---- Test modes override lighting ----
    if (this.fullDarkTestActive) {
      ambientIntensity = 0.0;
      sunIntensity = 0.0;
    } else if (this.noonLightingTestActive) {
      ambientIntensity = vt.dayAmbientIntensity * vt.ambientIntensityMultiplier;
      sunIntensity = vt.noonSunIntensity * vt.sunIntensityMultiplier;
    } else if (this.lampOnlyTestActive) {
      ambientIntensity = 0.0;
      sunIntensity = 0.0;
    }

    // ---- Drive scene.ambientColor from the day/night cycle ----
    // THIS is the key fix: noa sets scene.ambientColor=(0.5,0.5,0.5) at boot
    // and the old code never changed it. With material.ambientColor=(1,1,1),
    // that produced a constant 0.5 fill that prevented night from ever getting
    // dark and drowned out placed dynamic lights. Now we interpolate between
    // nightSceneAmbient (low) and daySceneAmbient (higher), tinted by the
    // preset's ambientColor, and scaled by the multiplier + test modes.
    const sceneAmbientBrightness =
      (this.fullDarkTestActive || this.lampOnlyTestActive)
        ? 0.0
        : this.noonLightingTestActive
        ? vt.daySceneAmbient
        : (vt.daySceneAmbient * dayT + vt.nightSceneAmbient * nightT) * vt.sceneAmbientMultiplier;
    const [ar, ag, ab] = preset.ambientColor;
    scene.ambientColor = new BABYLON.Color3(
      ar * sceneAmbientBrightness,
      ag * sceneAmbientBrightness,
      ab * sceneAmbientBrightness
    );

    // ---- Apply sun + ambient + moon light intensities ----
    if (this.skyController) {
      const sunLight = this.skyController.getSunLight();
      if (sunLight) {
        sunLight.intensity = (this.lampOnlyTestActive || this.fullDarkTestActive)
          ? 0
          : (vt.dynamicLightsEnabled !== false ? sunIntensity : 0);
      }
      const ambient = this.skyController.getAmbientLight();
      if (ambient) {
        ambient.intensity = ambientIntensity;
      }
      // Moon light: driven by night factor unless a test mode suppresses it.
      const moonNight = this.lampOnlyTestActive || this.fullDarkTestActive ? 0 : nightT;
      const moonLight = this.skyController.getMoonLight();
      if (moonLight) {
        moonLight.intensity = vt.moonLightEnabled ? vt.moonLightIntensity * moonNight : 0;
      }
    }

    // ---- Apply glow/bloom/postprocess overrides ----
    // Lamp Only Test: force glow/bloom OFF so only dynamic lights show.
    if (this.lampOnlyTestActive) {
      this.renderPipelineService?.setGlowEnabled(false);
      this.renderPipelineService?.setBloomEnabled(false);
    } else {
      this.renderPipelineService?.setGlowEnabled(vt.glowEnabled);
      if (vt.glowEnabled) {
        this.renderPipelineService?.setGlowIntensity(vt.glowIntensity);
      }
      this.renderPipelineService?.setBloomEnabled(vt.bloomEnabled);
    }
    this.renderPipelineService?.setExposure(vt.exposure);
    this.renderPipelineService?.setContrast(vt.contrast);

    // ---- Apply sky visibility overrides (respects master meshesEnabled) ----
    this.skyController?.setVisibilityOverrides({
      sunVisible: vt.sunVisible,
      moonVisible: vt.moonVisible,
      starsVisible: vt.starsVisible,
      cloudsVisible: vt.cloudsVisible,
      starBrightness: vt.starBrightness,
    });

    // ---- Apply terrain material mode (only on change, not every frame) ----
    if (vt.terrainMaterialMode !== this.currentTerrainMaterialMode) {
      if (vt.terrainMaterialMode === "debug") {
        this.applyTerrainDebugMaterial(true);
      } else {
        this.applyTerrainDebugMaterial(false);
      }
      this.currentTerrainMaterialMode = vt.terrainMaterialMode;
    }
  }

  /**
   * Merge mod sky overlays (ModRegistry.getActiveSky) on top of a base preset.
   * Only called when `modSkyOverlayActive` is true (opt-in). Returns the merged
   * preset; the caller tracks which fields changed for source labeling.
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

    try {
      this.noa.destroy();
    } catch (e) {
      console.warn('[NoaEngineAdapter] Safe error during tear down:', e);
    }
  }
}
