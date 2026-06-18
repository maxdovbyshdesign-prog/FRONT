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
  /** Live-tunable visual parameters (F3 debug console). */
  private visualTuning: VisualTuning = loadVisualTuning();

  // Rendering services (Pass 1).
  private materialService: MaterialService | null = null;
  private renderPipelineService: RenderPipelineService | null = null;
  private worldLightManager: WorldLightManager | null = null;
  private skyController: SkyController | null = null;
  private graphicsSettings: GraphicsSettings;

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

    // Sky + celestial bodies + sun/ambient lights.
    this.skyController = new SkyController(scene, this.graphicsSettings);

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
      return {
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
      };
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
    const inBlackGlass = this.worldService.isBlackGlassZone(x, z);
    const biome: "red_wasteland" | "black_glass_canyon" = inBlackGlass
      ? "black_glass_canyon"
      : "red_wasteland";

    let altitude = sunAltitude;
    if (altitude === undefined) {
      const angle = this.timeOfDay * Math.PI * 2;
      altitude = Math.sin(angle);
    }

    let preset = resolveBiomePhasePreset(biome, altitude);
    preset = this.mergeModSkyOverlay(preset);
    if (this.visualTuning.fogAutoClampToRenderDistance) {
      preset = clampPresetToRenderDistance(preset, this.getRenderDistanceBlocks());
    }

    // ---- Apply VisualTuning fog overrides ----
    const vt = this.visualTuning;
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
    // Safety: fogStart must be < fogEnd.
    if (scene.fogStart >= scene.fogEnd) {
      scene.fogStart = Math.max(20, scene.fogEnd - 40);
    }

    // ---- Real day/night brightness ----
    // Scale ambient + sun light intensities by sun altitude so night is dark.
    // altitude: -1 (midnight) .. 0 (horizon) .. +1 (noon)
    const dayT = Math.max(0, altitude); // 0 at night, 1 at noon
    const nightT = Math.max(0, -altitude); // 0 at day, 1 at midnight

    const ambientIntensity =
      (vt.dayAmbientIntensity * dayT + vt.nightAmbientIntensity * (1 - dayT)) *
      vt.ambientIntensityMultiplier;
    const sunIntensity =
      (altitude > 0
        ? vt.noonSunIntensity * Math.sqrt(altitude)
        : vt.midnightSunIntensity) * vt.sunIntensityMultiplier;

    if (this.skyController) {
      const sunLight = this.skyController.getSunLight();
      if (sunLight) {
        sunLight.intensity = vt.dynamicLightsEnabled !== false ? sunIntensity : 0;
      }
      const ambient = this.skyController.getAmbientLight();
      if (ambient) {
        ambient.intensity = ambientIntensity;
      }
    }

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
