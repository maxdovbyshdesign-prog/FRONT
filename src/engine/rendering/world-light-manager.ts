/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * WorldLightManager — data-driven, persistent voxel light source registry.
 *
 * This is the fix for Pass 3. It replaces the old hardcoded
 * `if (blockId === 6) {...} else if (blockId === 7) {...} else if (blockId === 8)`
 * logic inside NoaEngineAdapter.updateLocalLightAt().
 *
 * Design:
 *   - A light source is ANY block whose BlockDefinition has `tags` including
 *     "light_source" OR a non-null `light` profile. No numeric block IDs are
 *     ever inspected.
 *   - The registry is PERSISTENT: every light ever placed (by the player, by
 *     world generation, or pre-seeded static fixtures) stays in the Map. This
 *     means walking away and walking back re-activates the light — the old
 *     "lamp dies when you walk away" bug is fixed.
 *   - For performance, only the nearest N lights (by priority, then distance)
 *     have an active Babylon PointLight/SpotLight. The rest keep their registry
 *     entry but dispose their Babylon light. Their emissiveColor (set by
 *     MaterialService) still makes them visibly glow through the GlowLayer, so
 *     far lamps look "alive" without paying the dynamic-light cost.
 *   - flicker / pulse profiles are animated each update tick.
 */

import * as BABYLON from "@babylonjs/core";
import type { BlockDefinition, LightProfile, VoxelPosition } from "../../types";
import type { GraphicsSettings } from "./graphics-settings";

interface LightEntry {
  key: string;
  x: number;
  y: number;
  z: number;
  blockId: number;
  blockDef: BlockDefinition;
  profile: LightProfile;
  priority: number;
  /** The live Babylon light. Null when culled for performance. */
  light: BABYLON.PointLight | BABYLON.SpotLight | null;
  /** Base intensity (before flicker/pulse modulation). */
  baseIntensity: number;
  /** Phase offset for flicker/pulse so lamps don't sync. */
  phase: number;
}

export interface StaticLightSeed {
  pos: VoxelPosition;
  blockId: number;
}

export class WorldLightManager {
  private scene: BABYLON.Scene;
  private settings: GraphicsSettings;
  private registry: Map<string, LightEntry> = new Map();
  /** Reusable scratch arrays to avoid per-frame allocation. */
  private sortedScratch: LightEntry[] = [];
  private frame = 0;
  private disposed = false;
  /**
   * Master enabled state for real PointLights. PERFORMANCE MODE: false by
   * default. Tracked so newly-created lights (from registerLight/registerStaticLights)
   * inherit the disabled state — otherwise they'd default to enabled.
   */
  private enabled: boolean = false;

  constructor(scene: BABYLON.Scene, settings: GraphicsSettings) {
    this.scene = scene;
    this.settings = settings;
    console.log(
      `[WorldLightManager] Online. Active dynamic light budget: ${settings.maxActiveDynamicLights}.`
    );
  }

  /**
   * Register a light source at a voxel position. If the block is not actually
   * a light source (no tag + no profile), this is a no-op. Safe to call for
   * every block place / world-gen hit.
   */
  public registerLight(
    x: number,
    y: number,
    z: number,
    blockDef: BlockDefinition | undefined
  ): void {
    if (this.disposed) return;
    if (!blockDef) return;
    const isLight =
      (blockDef.tags && blockDef.tags.includes("light_source")) ||
      !!blockDef.light;
    if (!isLight || !blockDef.light) return;

    const key = this.key(x, y, z);
    // If already registered (e.g. re-seed), refresh the def but keep position.
    const existing = this.registry.get(key);
    if (existing) {
      existing.blockDef = blockDef;
      existing.profile = blockDef.light;
      existing.priority = blockDef.light.priority ?? 0;
      existing.baseIntensity = this.scaleIntensity(blockDef.light);
      return;
    }

    this.registry.set(key, {
      key,
      x,
      y,
      z,
      blockId: blockDef.id,
      blockDef,
      profile: blockDef.light,
      priority: blockDef.light.priority ?? 0,
      light: null,
      baseIntensity: this.scaleIntensity(blockDef.light),
      phase: Math.random() * Math.PI * 2,
    });
  }

  /**
   * Unregister a light (e.g. player destroyed the block). Disposes the Babylon
   * light and removes the registry entry entirely.
   */
  public unregisterLight(x: number, y: number, z: number): void {
    const key = this.key(x, y, z);
    const entry = this.registry.get(key);
    if (!entry) return;
    this.disposeEntryLight(entry);
    this.registry.delete(key);
  }

  /**
   * Bulk-register static / generated lights. Called once after world boot to
   * pre-seed outpost lamps, ruin beacons, etc.
   */
  public registerStaticLights(
    seeds: StaticLightSeed[],
    resolveBlock: (id: number) => BlockDefinition | undefined
  ): void {
    for (const s of seeds) {
      const def = resolveBlock(s.blockId);
      if (def) this.registerLight(s.pos[0], s.pos[1], s.pos[2], def);
    }
    console.log(
      `[WorldLightManager] Seeded ${this.registry.size} static light sources.`
    );
  }

  /**
   * Per-frame update. Culls to the active budget and animates flicker/pulse.
   * Cheap: O(n log n) sort only runs every ~10 frames; flicker is O(active).
   */
  public update(playerPos: VoxelPosition): void {
    if (this.disposed || this.registry.size === 0) return;
    // PERFORMANCE: when real PointLights are disabled (the default in
    // performance_voxel mode), do NOT create or animate any Babylon lights.
    // Early return — no new PointLights are created, no wasted work. Existing
    // lights (if any) were already setEnabled(false) by setEnabled().
    if (!this.enabled) return;
    this.frame++;

    const px = playerPos[0];
    const py = playerPos[1];
    const pz = playerPos[2];
    const budget = this.settings.maxActiveDynamicLights;

    // Rebuild the sorted scratch list every few frames (lights rarely move).
    if (this.frame % 6 === 1 || this.sortedScratch.length !== this.registry.size) {
      this.sortedScratch = Array.from(this.registry.values());
      this.sortedScratch.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        const da = distSq(a, px, py, pz);
        const db = distSq(b, px, py, pz);
        return da - db;
      });
    }

    let activeCount = 0;
    for (const entry of this.sortedScratch) {
      const shouldBeActive = activeCount < budget;
      if (shouldBeActive) {
        if (!entry.light) {
          this.createLight(entry);
        }
        if (entry.light) {
          this.animateLight(entry);
          activeCount++;
        }
      } else if (entry.light) {
        this.disposeEntryLight(entry);
      }
    }
  }

  /**
   * Create the Babylon light for an entry. PointLight for "point",
   * SpotLight for "spot", nothing for "emissive_only".
   */
  private createLight(entry: LightEntry): void {
    try {
      const pos = new BABYLON.Vector3(
        entry.x + 0.5,
        entry.y + 0.6,
        entry.z + 0.5
      );
      const [r, g, b] = entry.profile.color;
      const name = `wl-${entry.key}`;

      if (entry.profile.kind === "spot") {
        const spot = new BABYLON.SpotLight(
          name,
          pos,
          new BABYLON.Vector3(0, -1, 0),
          Math.PI / 3, // 60° cone
          2,
          this.scene
        );
        spot.diffuse = new BABYLON.Color3(r, g, b);
        spot.specular = new BABYLON.Color3(r * 0.5, g * 0.5, b * 0.5);
        spot.intensity = entry.baseIntensity;
        spot.range = this.scaleRange(entry.profile.range);
        spot.setEnabled(this.enabled); // inherit master enabled state
        entry.light = spot;
      } else if (entry.profile.kind === "point") {
        const point = new BABYLON.PointLight(name, pos, this.scene);
        point.diffuse = new BABYLON.Color3(r, g, b);
        point.specular = new BABYLON.Color3(r * 0.4, g * 0.4, b * 0.4);
        point.intensity = entry.baseIntensity;
        point.range = this.scaleRange(entry.profile.range);
        point.setEnabled(this.enabled); // inherit master enabled state
        entry.light = point;
      }
      // "emissive_only" -> no Babylon light; the emissive material + GlowLayer
      // handle the visual. This is the cheap path for decorative glow.
    } catch (e) {
      console.warn(`[WorldLightManager] Failed to create light at ${entry.key}:`, e);
    }
  }

  /**
   * Animate flicker / pulse for an active light.
   */
  private animateLight(entry: LightEntry): void {
    if (!entry.light) return;
    const t = performance.now() * 0.001 + entry.phase;

    if (entry.profile.flicker) {
      // Industrial flicker: sharp random dips.
      const flick = 0.7 + Math.random() * 0.3;
      entry.light.intensity = entry.baseIntensity * flick;
    } else if (entry.profile.pulse) {
      // Smooth beacon pulse.
      const pulse = 0.75 + 0.25 * Math.sin(t * 1.8);
      entry.light.intensity = entry.baseIntensity * pulse;
    } else {
      entry.light.intensity = entry.baseIntensity;
    }
  }

  private disposeEntryLight(entry: LightEntry): void {
    if (!entry.light) return;
    try {
      entry.light.dispose();
    } catch {
      /* ignore */
    }
    entry.light = null;
  }

  /**
   * Map a BlockDefinition light.intensity (1.0-ish scale) to a Babylon
   * PointLight intensity. Pass 4: reduced from 18× to 8× — the previous
   * value made lights nuclear-bright and caused blurry blob artifacts with
   * the GlowLayer. 8× is visible but not overwhelming.
   */
  private scaleIntensity(profile: LightProfile): number {
    return Math.max(0.3, profile.intensity * 8.0);
  }

  /**
   * Map a BlockDefinition light.range (voxels) to a Babylon light range.
   * Pass 4: clamped to 4-20 (was 4-48) so lights don't reach absurdly far
   * and cause performance issues.
   */
  private scaleRange(declared: number): number {
    return Math.max(4, Math.min(20, declared));
  }

  /**
   * Debug helper: return info about the nearest N registered lights relative
   * to a query position. Used by window.__fpDebug().lights.
   */
  public getDebugInfo(playerPos: VoxelPosition, maxCount: number = 8): {
    registered: number;
    active: number;
    nearest: Array<{
      key: string;
      pos: [number, number, number];
      blockId: number;
      blockName: string;
      intensity: number;
      range: number;
      active: boolean;
      distance: number;
    }>;
  } {
    const px = playerPos[0];
    const py = playerPos[1];
    const pz = playerPos[2];
    const all = Array.from(this.registry.values()).map((e) => ({
      key: e.key,
      pos: [e.x, e.y, e.z] as [number, number, number],
      blockId: e.blockId,
      blockName: e.blockDef.name,
      intensity: e.baseIntensity,
      range: this.scaleRange(e.profile.range),
      active: !!e.light,
      distance: Math.sqrt(distSq(e, px, py, pz)),
    }));
    all.sort((a, b) => a.distance - b.distance);
    return {
      registered: this.registry.size,
      active: this.getActiveCount(),
      nearest: all.slice(0, maxCount),
    };
  }

  private key(x: number, y: number, z: number): string {
    return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
  }

  public getRegisteredCount(): number {
    return this.registry.size;
  }

  public getActiveCount(): number {
    // Count only ENABLED real Babylon lights (not disabled objects).
    let n = 0;
    this.registry.forEach((e) => {
      if (e.light && e.light.isEnabled()) n++;
    });
    return n;
  }

  /**
   * Update the quality budget at runtime.
   */
  public setSettings(settings: GraphicsSettings): void {
    this.settings = settings;
  }

  /**
   * Set the active dynamic light budget at runtime (live tuning).
   */
  public setBudget(budget: number): void {
    this.settings = { ...this.settings, maxActiveDynamicLights: Math.max(1, Math.min(12, budget)) };
    console.log(`[WorldLightManager] Active light budget set to ${this.settings.maxActiveDynamicLights}.`);
  }

  /**
   * Master enable for real Babylon PointLights. PERFORMANCE MODE: disabled by
   * default — the primary lighting is VoxelLightManager (baked vertex colors).
   * Real PointLights are debug-only (cap 3). When disabled, all active lights
   * have isEnabled=false so they stop illuminating terrain (their emissiveColor
   * + GlowLayer still glow). Sun/moon/ambient are NOT affected.
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.registry.forEach((e) => {
      if (e.light) e.light.setEnabled(enabled);
    });
    console.log(`[WorldLightManager] Real PointLights ${enabled ? "enabled" : "disabled"} (sun/moon/ambient unaffected).`);
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.registry.forEach((e) => this.disposeEntryLight(e));
    this.registry.clear();
    this.sortedScratch = [];
    console.log("[WorldLightManager] Disposed.");
  }
}

function distSq(e: LightEntry, px: number, py: number, pz: number): number {
  const dx = e.x - px;
  const dy = e.y - py;
  const dz = e.z - pz;
  return dx * dx + dy * dy + dz * dz;
}
