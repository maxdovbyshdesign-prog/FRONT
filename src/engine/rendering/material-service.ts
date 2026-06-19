/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * MaterialService — data-driven block material pipeline.
 *
 * PASS 3 BUGFIX — the previous custom StandardMaterial was missing
 * `ambientColor = (1,1,1)`, which noa's `makeStandardMaterial` sets by
 * default. With Babylon's default `ambientColor = (0,0,0)`, terrain blocks
 * received zero ambient light and rendered too dark / effectively invisible
 * against the purple sky clearColor.
 *
 * VOXEL-LIGHT-REPAIR PASS — when `litTerrainMaterials` is true (the default),
 * ALL opaque blocks get a custom StandardMaterial with `disableLighting = true`.
 * This makes the baked vertex colors (matColor × AO × VoxelLightManager tint)
 * the FINAL visible color — no Babylon scene-light multiplication. Day/night
 * works through the voxel light's skyLight × timeMultiplier baked into vertex
 * colors, NOT through Babylon scene lights. This is the key fix for "at
 * night/underground, vertex colors disappear": with disableLighting=true,
 * vertex colors are always visible regardless of scene ambient/sun intensity.
 *
 * This version:
 *   - Prefers `noa.rendering.makeStandardMaterial(name)` when available, so
 *     our materials inherit noa's exact defaults (ambientColor=1,1,1,
 *     specularColor=0,0,0, diffuseColor=1,1,1).
 *   - Falls back to a manually constructed StandardMaterial with the SAME
 *     defaults if the noa factory isn't accessible.
 *   - Supports a `?safeMaterials=1` query param / SAFE_MATERIALS_MODE flag
 *     that disables custom renderMaterial entirely (registers only flat
 *     colors) to isolate material regressions.
 *   - Passes the material to noa via `registerMaterial({ renderMaterial })`.
 *   - Sets maxSimultaneousLights, fogEnabled, emissive for light_source.
 *   - When litTerrainMaterials=true: disableLighting=true, useVertexColors=true
 *     on ALL opaque terrain materials so vertex colors are final.
 *   - Missing textures NEVER crash the game.
 */

import * as BABYLON from "@babylonjs/core";
import type { BlockDefinition, BlockMaterialConfig } from "../../types";

/**
 * Minimal noa registry shape. noa's registerMaterial accepts an options
 * object whose `renderMaterial` field is a Babylon Material to use directly
 * for terrain meshing.
 */
export interface NoaRegistryLike {
  registerMaterial(
    name: string,
    options: {
      color: [number, number, number];
      renderMaterial?: BABYLON.Material;
    }
  ): void;
  registerBlock(id: number, props: any): void;
}

/** Optional noa rendering object — used for makeStandardMaterial factory. */
export interface NoaRenderingLike {
  makeStandardMaterial?: (name: string) => BABYLON.StandardMaterial;
  getScene?: () => BABYLON.Scene;
}

/** How many concurrent dynamic lights a block material responds to. */
const DEFAULT_MAX_SIMULTANEOUS_LIGHTS = 12;

/** Detect ?safeMaterials=1 at module load time. */
function readSafeMaterialsMode(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("safeMaterials") === "1";
  } catch {
    return false;
  }
}

function readCustomTerrainMaterialsMode(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("customTerrainMaterials") === "1";
  } catch {
    return false;
  }
}

export class MaterialService {
  private scene: BABYLON.Scene;
  private registry: NoaRegistryLike;
  private noaRendering: NoaRenderingLike | null;
  private maxSimultaneousLights: number;
  private safeMaterialsMode: boolean;
  private customTerrainMaterialsMode: boolean;
  /** When true (default), ALL opaque blocks get a custom StandardMaterial with
   *  disableLighting=true so the baked vertex colors (matColor × AO × voxel
   *  light tint) are the FINAL visible color. This is the key fix for the
   *  voxel light system: at night/underground, scene ambient/sun no longer
   *  hide the vertex colors. Day/night works through the voxel light's
   *  skyLight × timeMultiplier baked into vertex colors. */
  private litTerrainMaterials: boolean;
  private built: Set<string> = new Set();
  private warnedMissing: Set<string> = new Set();
  private materials: BABYLON.StandardMaterial[] = [];

  constructor(
    scene: BABYLON.Scene,
    registry: NoaRegistryLike,
    maxSimultaneousLights: number = DEFAULT_MAX_SIMULTANEOUS_LIGHTS,
    noaRendering: NoaRenderingLike | null = null,
    safeMaterialsMode: boolean = readSafeMaterialsMode(),
    customTerrainMaterialsMode: boolean = readCustomTerrainMaterialsMode(),
    litTerrainMaterials: boolean = true
  ) {
    this.scene = scene;
    this.registry = registry;
    this.noaRendering = noaRendering;
    this.maxSimultaneousLights = maxSimultaneousLights;
    this.safeMaterialsMode = safeMaterialsMode;
    this.customTerrainMaterialsMode = customTerrainMaterialsMode;
    this.litTerrainMaterials = litTerrainMaterials;
    console.log(
      `[MaterialService] Block material pipeline online. maxSimultaneousLights = ${maxSimultaneousLights}, safeMaterialsMode = ${safeMaterialsMode}, customTerrainMaterialsMode = ${customTerrainMaterialsMode}, litTerrainMaterials = ${litTerrainMaterials}.`
    );
  }

  /**
   * Build a StandardMaterial mirroring noa's makeStandardMaterial defaults:
   *   specularColor = (0,0,0), ambientColor = (1,1,1), diffuseColor = (1,1,1)
   * Prefers noa.rendering.makeStandardMaterial when available so we inherit
   * any future noa defaults automatically.
   */
  private createBaseMaterial(name: string): BABYLON.StandardMaterial {
    if (this.noaRendering && typeof this.noaRendering.makeStandardMaterial === "function") {
      try {
        const mat = this.noaRendering.makeStandardMaterial(name);
        if (mat) {
          console.log(`[MaterialService] Created material "${name}" via noa.rendering.makeStandardMaterial.`);
          return mat;
        }
      } catch (e) {
        console.warn(`[MaterialService] noa.rendering.makeStandardMaterial failed, falling back to manual:`, e);
      }
    }
    // Manual fallback with EXACT noa defaults.
    const mat = new BABYLON.StandardMaterial(name, this.scene);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.ambientColor = new BABYLON.Color3(1, 1, 1);
    mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
    console.log(`[MaterialService] Created material "${name}" via manual fallback (noa defaults).`);
    return mat;
  }

  /**
   * Build + register a single block's material. Safe to call multiple times
   * for the same materialName — subsequent calls are no-ops.
   *
   * VOXEL-LIGHT-REPAIR: when `litTerrainMaterials` is true (the default),
   * ALL opaque blocks get a custom StandardMaterial with disableLighting=true.
   * This makes the baked vertex colors (matColor × AO × VoxelLightManager tint)
   * the FINAL visible color — no scene-light multiplication. This is required
   * for the voxel light system: at night/underground, scene ambient/sun would
   * otherwise hide the vertex colors. With disableLighting=true, the vertex
   * colors are always visible, and day/night is driven by the skyLight ×
   * timeMultiplier baked into vertex colors by VoxelLightManager.recolorMesh.
   *
   * Custom renderMaterial is also reserved for:
   *   - light_source blocks (need emissiveColor for glow)
   *   - blocks with emissiveColor/emissiveTexture
   *   - blocks with actual successfully loaded textures
   *   - ?customTerrainMaterials=1 opt-in dev flag (all blocks get custom mats)
   *   - litTerrainMaterials=true (default) — all opaque blocks get unlit mats
   */
  public registerBlockMaterial(block: BlockDefinition): void {
    if (this.built.has(block.materialName)) return;
    this.built.add(block.materialName);

    // Determine if this block needs a custom renderMaterial.
    const isLightSource =
      (block.tags && block.tags.includes("light_source")) ||
      !!block.light;
    const hasEmissiveConfig =
      !!block.material &&
      (!!block.material.emissiveColor ||
        !!block.material.emissiveTexture ||
        !!block.material.emissiveStrength);
    // litTerrainMaterials forces ALL opaque blocks through the custom
    // unlit-material path so vertex colors are the final visible color.
    const needsCustomMaterial =
      this.litTerrainMaterials ||
      this.customTerrainMaterialsMode ||
      isLightSource ||
      hasEmissiveConfig;

    // DEFAULT MODE: ordinary opaque block with no emissive needs → use noa's
    // flat-color registration. noa builds its own proven terrain material.
    if (!needsCustomMaterial) {
      this.registry.registerMaterial(block.materialName, { color: block.color });
      this.registry.registerBlock(block.id, {
        material: block.materialName,
        solid: block.solid !== false,
        opaque: block.opaque !== false,
      });
      console.log(
        `[MaterialService] registered flat color for ${block.materialName} (noa default material).`
      );
      return;
    }

    // SAFE MATERIALS MODE: ?safeMaterials=1 forces flat color for ALL blocks.
    if (this.safeMaterialsMode) {
      this.registry.registerMaterial(block.materialName, { color: block.color });
      this.registry.registerBlock(block.id, {
        material: block.materialName,
        solid: block.solid !== false,
        opaque: block.opaque !== false,
      });
      console.log(
        `[MaterialService] SAFE MODE: flat color for ${block.materialName}.`
      );
      return;
    }

    // CUSTOM MATERIAL MODE: light_source / emissive / textured blocks, OR
    // litTerrainMaterials=true (default) — all opaque blocks get an unlit
    // vertex-color-driven material so the baked voxel light shows through.
    const mat = this.createBaseMaterial(`fp_${block.materialName}`);
    mat.name = `fp_${block.materialName}`;

    const [cr, cg, cb] = block.color;

    this.applyMaterialConfig(mat, block);
    this.applyEmissiveForLightSource(mat, block);

    // Cap maxSimultaneousLights at the quality preset's cap.
    mat.maxSimultaneousLights = Math.min(
      this.maxSimultaneousLights,
      8
    );

    // PERFORMANCE VOXEL MODE: terrain material policy.
    //
    // noa's mesher bakes matColor × AO into vertex colors (confirmed:
    // terrainMesher.js pushAOColor: colors[ix] = baseCol[0] * mult).
    // Our recolorMesh then multiplies base vertex color × skyR(1.0) + blockPart.
    //
    // With disableLighting=false, Babylon computes:
    //   finalColor = diffuseColor * vertexColor * lightContribution + ambient
    //
    // If diffuseColor = blockColor (e.g. [0.75, 0.25, 0.15]) AND vertexColor
    // already contains matColor × AO, the material color is SQUARED:
    //   finalColor = matColor² × AO × light — too dark.
    //
    // FIX: diffuseColor = [1,1,1] (white passthrough). The vertex color
    // already contains the full material color × AO × voxel light. Babylon's
    // HemisphericLight provides the lightContribution (day/night brightness)
    // which multiplies the vertex color. No double-coloring.
    mat.fogEnabled = false; // fog handled at scene level; material fog can darken lit tests

    if (this.litTerrainMaterials) {
      mat.disableLighting = false;
      mat.diffuseColor = new BABYLON.Color3(1, 1, 1); // WHITE PASSTHROUGH — vertex color has matColor
      (mat as any).useVertexColors = true;
    } else {
      mat.diffuseColor = new BABYLON.Color3(cr, cg, cb);
    }

    // Ensure ambientColor = (1,1,1) so the block receives scene ambient light
    // (only matters when disableLighting=false; harmless otherwise).
    if (
      !mat.ambientColor ||
      (mat.ambientColor.r === 0 &&
        mat.ambientColor.g === 0 &&
        mat.ambientColor.b === 0)
    ) {
      mat.ambientColor = new BABYLON.Color3(1, 1, 1);
    }

    this.materials.push(mat);

    this.registry.registerMaterial(block.materialName, {
      color: block.color,
      renderMaterial: mat,
    });
    this.registry.registerBlock(block.id, {
      material: block.materialName,
      solid: block.solid !== false,
      opaque: block.opaque !== false,
    });

    console.log(
      `[MaterialService] registered custom renderMaterial for ${block.materialName}` +
        ` (lightSource=${isLightSource}, emissive=${hasEmissiveConfig}, maxLights=${mat.maxSimultaneousLights}, disableLighting=${mat.disableLighting}, useVertexColors=${(mat as any).useVertexColors === true})`
    );
  }

  /** Bulk helper. */
  public registerAll(blocks: BlockDefinition[]): void {
    for (const b of blocks) this.registerBlockMaterial(b);
  }

  /**
   * Apply the extended material config (textures / normal / emissive / PBR-ish
   * fields) to a Babylon StandardMaterial. Missing textures are warned + skipped.
   *
   * CRITICAL: textures are attached to the material ONLY on successful load.
   * If we attach a texture that's still loading (or that failed), the
   * material's `isReady()` returns false forever and Babylon skips rendering
   * the mesh entirely — producing a blank clearColor canvas. This was the
   * root cause of the "purple blank 3D view" regression.
   */
  private applyMaterialConfig(
    mat: BABYLON.StandardMaterial,
    block: BlockDefinition
  ): void {
    const cfg: BlockMaterialConfig | undefined = block.material;
    if (!cfg) return; // legacy flat-color block — nothing to enhance.

    // Diffuse / albedo texture — attach on load, never block material readiness.
    const diffusePath = cfg.diffuseTexture || cfg.albedoTexture;
    if (diffusePath) {
      this.loadTextureAsync(diffusePath, block.materialName, "diffuse", (tex) => {
        mat.diffuseTexture = tex;
      });
    }

    // Normal / bump map.
    const normalPath = cfg.normalTexture || cfg.bumpTexture;
    if (normalPath) {
      this.loadTextureAsync(normalPath, block.materialName, "normal", (tex) => {
        tex.invertZ = false;
        mat.bumpTexture = tex;
      });
    }

    // Emissive texture.
    if (cfg.emissiveTexture) {
      this.loadTextureAsync(
        cfg.emissiveTexture,
        block.materialName,
        "emissive",
        (tex) => {
          mat.emissiveTexture = tex;
        }
      );
    }

    // Emissive color (applied immediately — not texture-dependent).
    if (cfg.emissiveColor) {
      const [r, g, b] = cfg.emissiveColor;
      const strength = cfg.emissiveStrength ?? 1.0;
      mat.emissiveColor = new BABYLON.Color3(
        r * strength,
        g * strength,
        b * strength
      );
    }

    // Specular tuning — default (0,0,0) like noa, unless config overrides.
    if (cfg.specularColor) {
      const [r, g, b] = cfg.specularColor;
      mat.specularColor = new BABYLON.Color3(r, g, b);
    }

    if (typeof cfg.roughness === "number") {
      const r = BABYLON.Scalar.Clamp(cfg.roughness, 0, 1);
      mat.specularPower = 32 * (1.0 - r) + 4;
    }
  }

  /**
   * Ensure light_source blocks always emit an emissiveColor so they look
   * "alive" through the GlowLayer even when their dynamic point light is culled.
   * Data-driven — no hardcoded block IDs.
   */
  private applyEmissiveForLightSource(
    mat: BABYLON.StandardMaterial,
    block: BlockDefinition
  ): void {
    const isLightSource =
      (block.tags && block.tags.includes("light_source")) ||
      (block.light && block.light.kind !== "emissive_only");
    if (!isLightSource) return;

    if (block.material && block.material.emissiveColor) return;

    const [r, g, b] = block.color;
    const strength =
      block.light?.emissiveStrength ?? block.material?.emissiveStrength ?? 0.85;
    mat.emissiveColor = new BABYLON.Color3(
      r * strength,
      g * strength,
      b * strength
    );
  }

  /**
   * Load a texture asynchronously. Calls `onLoaded(tex)` ONLY on successful
   * load. If the texture fails to load (404, etc.), the callback is NEVER
   * called — the material keeps its flat color and `isReady()` stays true.
   *
   * This is the critical fix for the "purple blank canvas" regression:
   * previously we attached a loading/failed texture to the material, which
   * made `material.isReady()` return false forever, so Babylon skipped
   * rendering the mesh entirely.
   */
  private loadTextureAsync(
    path: string,
    materialName: string,
    slot: string,
    onLoaded: (tex: BABYLON.Texture) => void
  ): void {
    if (!path) return;
    try {
      const tex = new BABYLON.Texture(
        path,
        this.scene,
        false, // no mipmaps
        true, // invertY
        BABYLON.Texture.TRILINEAR_SAMPLINGMODE,
        () => {
          // onLoad — texture is ready; safe to attach to the material.
          tex.name = `${materialName}_${slot}`;
          try {
            onLoaded(tex);
          } catch (e) {
            console.warn(`[MaterialService] onLoaded callback error for ${materialName}/${slot}:`, e);
          }
        },
        () => {
          // onError — texture failed to load. Do NOT attach it to the material.
          // The material keeps its flat diffuseColor and isReady() stays true.
          if (!this.warnedMissing.has(path)) {
            this.warnedMissing.add(path);
            console.warn(
              `[MaterialService] Missing ${slot} texture for "${materialName}": ${path} — falling back to flat color.`
            );
          }
          try {
            tex.dispose();
          } catch {
            /* ignore */
          }
        }
      );
    } catch (e) {
      if (!this.warnedMissing.has(path)) {
        this.warnedMissing.add(path);
        console.warn(
          `[MaterialService] Failed to construct ${slot} texture for "${materialName}" (${path}):`,
          e
        );
      }
    }
  }

  public getBuiltCount(): number {
    return this.materials.length;
  }

  public isSafeMaterialsMode(): boolean {
    return this.safeMaterialsMode;
  }

  public dispose(): void {
    for (const m of this.materials) {
      try {
        m.dispose();
      } catch {
        /* ignore */
      }
    }
    this.materials = [];
    this.built.clear();
    this.warnedMissing.clear();
    console.log("[MaterialService] Disposed.");
  }
}
