/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * RenderPipelineService — Babylon post-processing stack.
 *
 * Uses ONLY Babylon built-ins:
 *   - GlowLayer            -> makes emissive materials (lamps, artifacts) glow
 *   - DefaultRenderingPipeline -> subtle bloom + tone mapping + FXAA
 *   - ImageProcessingConfiguration -> exposure / contrast
 *
 * Does NOT write custom bloom or godray shaders. Everything fails gracefully:
 * if any post-process fails to construct, we log and continue with whatever
 * succeeded. The game must never black-screen because bloom init threw.
 *
 * Quality is driven by GraphicsSettings (low / medium / high).
 */

import * as BABYLON from "@babylonjs/core";
import type { GraphicsSettings, GraphicsQuality } from "./graphics-settings";

export class RenderPipelineService {
  private scene: BABYLON.Scene;
  private camera: BABYLON.Camera | null;
  private settings: GraphicsSettings;

  private glowLayer: BABYLON.GlowLayer | null = null;
  private pipeline: BABYLON.DefaultRenderingPipeline | null = null;
  private disposed = false;

  constructor(
    scene: BABYLON.Scene,
    camera: BABYLON.Camera | null,
    settings: GraphicsSettings
  ) {
    this.scene = scene;
    this.camera = camera;
    this.settings = settings;
    console.log(
      `[RenderPipelineService] Booting graphics quality="${settings.quality}".`
    );
    this.init();
  }

  private init(): void {
    this.initGlowLayer();
    this.initDefaultPipeline();
  }

  /**
   * GlowLayer — cheap, reliable, makes emissiveColor visible. This is the
   * primary "lamps glow at night" mechanism and is always enabled (even on
   * low quality, just at reduced intensity).
   */
  private initGlowLayer(): void {
    try {
      this.glowLayer = new BABYLON.GlowLayer("fp_glow", this.scene, {
        mainTextureFixedSize: this.settings.quality === "high" ? 512 : 256,
        blurKernelSize: this.settings.glowKernel ?? 16,
      });
      this.glowLayer.intensity = this.settings.glowIntensity;
      console.log(
        `[RenderPipelineService] GlowLayer enabled @ intensity ${this.settings.glowIntensity}, kernel ${this.settings.glowKernel ?? 16}.`
      );
    } catch (e) {
      console.warn(
        "[RenderPipelineService] GlowLayer init failed — emissive blocks will still render but without glow halo:",
        e
      );
      this.glowLayer = null;
    }
  }

  /**
   * DefaultRenderingPipeline — bloom + tone mapping + FXAA. Skipped entirely on
   * "low" quality. Wrapped so a single failing sub-effect does not poison the
   * rest.
   */
  private initDefaultPipeline(): void {
    if (!this.camera) {
      console.warn(
        "[RenderPipelineService] No camera available; skipping DefaultRenderingPipeline."
      );
      return;
    }
    if (!this.settings.bloomEnabled && !this.settings.toneMappingEnabled) {
      console.log(
        "[RenderPipelineService] Bloom + tone mapping disabled by quality preset."
      );
      return;
    }

    try {
      this.pipeline = new BABYLON.DefaultRenderingPipeline(
        "fp_pipeline",
        this.settings.toneMappingEnabled, // HDR mode required for tone mapping
        this.scene,
        [this.camera]
      );
    } catch (e) {
      console.warn(
        "[RenderPipelineService] DefaultRenderingPipeline init failed — continuing with GlowLayer only:",
        e
      );
      this.pipeline = null;
      return;
    }

    try {
      // Bloom — keep it SUBTLE. The frontier is lonely, not a rave.
      this.pipeline.bloomEnabled = this.settings.bloomEnabled;
      if (this.settings.bloomEnabled) {
        this.pipeline.bloomKernel = this.settings.bloomKernel;
        this.pipeline.bloomWeight = this.settings.bloomWeight;
        this.pipeline.bloomThreshold = this.settings.bloomThreshold;
        this.pipeline.bloomScale = 0.5;
      }
    } catch (e) {
      console.warn("[RenderPipelineService] Bloom config failed:", e);
    }

    try {
      // Image processing (exposure / contrast / tone mapping).
      const ip = this.pipeline.imageProcessing;
      ip.exposure = this.settings.exposure;
      ip.contrast = this.settings.contrast;
      if (this.settings.toneMappingEnabled) {
        ip.toneMappingEnabled = true;
        ip.toneMappingType =
          BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
      }
    } catch (e) {
      console.warn("[RenderPipelineService] ImageProcessing config failed:", e);
    }

    try {
      // FXAA — cheap, safe, always on when pipeline exists.
      this.pipeline.fxaaEnabled = this.settings.fxaaEnabled;
    } catch (e) {
      console.warn("[RenderPipelineService] FXAA config failed:", e);
    }

    // Sharpening is intentionally OFF — it over-crisps voxel edges.
    try {
      this.pipeline.sharpenEnabled = false;
    } catch {
      /* ignore */
    }

    console.log("[RenderPipelineService] DefaultRenderingPipeline configured.");
  }

  /**
   * Apply a VisualPreset's exposure / contrast / glow tuning at runtime.
   * Used by SkyController when the day/night phase changes.
   */
  public applyPresetTuning(p: {
    exposure: number;
    contrast: number;
    glowIntensity: number;
    bloomEnabled: boolean;
  }): void {
    try {
      if (this.pipeline && this.pipeline.imageProcessing) {
        this.pipeline.imageProcessing.exposure = p.exposure;
        this.pipeline.imageProcessing.contrast = p.contrast;
      }
    } catch {
      /* ignore */
    }
    try {
      if (this.glowLayer) {
        this.glowLayer.intensity = p.glowIntensity;
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Switch quality at runtime. Rebuilds the pipeline.
   */
  public setQuality(settings: GraphicsSettings): void {
    if (this.disposed) return;
    this.settings = settings;
    this.disposePipeline();
    this.init();
  }

  /**
   * Toggle GlowLayer on/off at runtime (QA debug).
   */
  public setGlowEnabled(enabled: boolean): void {
    try {
      if (this.glowLayer) {
        this.glowLayer.intensity = enabled ? this.settings.glowIntensity : 0;
      }
      console.log(`[RenderPipelineService] Glow ${enabled ? "enabled" : "disabled"}.`);
    } catch {
      /* ignore */
    }
  }

  /**
   * Toggle bloom on/off at runtime (QA debug).
   */
  public setBloomEnabled(enabled: boolean): void {
    try {
      if (this.pipeline) {
        this.pipeline.bloomEnabled = enabled;
      }
      console.log(`[RenderPipelineService] Bloom ${enabled ? "enabled" : "disabled"}.`);
    } catch {
      /* ignore */
    }
  }

  public getGlowIntensity(): number {
    return this.glowLayer ? this.glowLayer.intensity : 0;
  }

  public setGlowIntensity(intensity: number): void {
    try {
      if (this.glowLayer) {
        this.glowLayer.intensity = Math.max(0, Math.min(1.5, intensity));
      }
    } catch {
      /* ignore */
    }
  }

  public setExposure(exposure: number): void {
    try {
      if (this.pipeline && this.pipeline.imageProcessing) {
        this.pipeline.imageProcessing.exposure = Math.max(0.5, Math.min(1.6, exposure));
      }
    } catch {
      /* ignore */
    }
  }

  public setContrast(contrast: number): void {
    try {
      if (this.pipeline && this.pipeline.imageProcessing) {
        this.pipeline.imageProcessing.contrast = Math.max(0.8, Math.min(1.4, contrast));
      }
    } catch {
      /* ignore */
    }
  }

  public getBloomEnabled(): boolean {
    return this.pipeline ? this.pipeline.bloomEnabled : false;
  }

  public getQuality(): GraphicsQuality {
    return this.settings.quality;
  }

  public getGlowLayer(): BABYLON.GlowLayer | null {
    return this.glowLayer;
  }

  private disposePipeline(): void {
    try {
      if (this.pipeline) {
        this.pipeline.dispose();
        this.pipeline = null;
      }
    } catch {
      /* ignore */
    }
    try {
      if (this.glowLayer) {
        this.glowLayer.dispose();
        this.glowLayer = null;
      }
    } catch {
      /* ignore */
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposePipeline();
    console.log("[RenderPipelineService] Disposed.");
  }
}
