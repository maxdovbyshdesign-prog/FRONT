/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * SkyController — visible celestial system for the frontier sky.
 *
 * PASS 2 BUGFIX — the previous version positioned sun/moon/stars at world
 * coordinates and hoped the camera frustum would show them. Several issues
 * made them invisible:
 *   - The sun/moon were small spheres (18/28 units) at radius 220 — easy to
 *     miss even when in the frustum.
 *   - Stars were 0.8-unit boxes — far too tiny to see.
 *   - The Babylon camera's default maxZ (~1000) plus fog could cull them.
 *   - Nothing parented them to a root that follows the player, so they could
 *     drift out of the frustum as the player moved.
 *
 * This version:
 *   - Creates a `skyRoot` TransformNode whose position is set to the player /
 *     camera position EVERY frame. All celestial bodies are parented to it.
 *   - Uses large emissive billboard discs (planes that face the camera) for
 *     the sun and moon so they are unmissable.
 *   - Uses larger star quads (3 units) parented to skyRoot.
 *   - Sets renderingGroupId = 1 on all sky meshes so they render behind
 *     terrain (Babylon sorts groups ascending; terrain is group 0).
 *   - Sets material.disableDepthWrite = true + applyFog = false so terrain
 *     never occludes the sky and fog never hides it.
 *   - Sets alwaysSelectAsActiveMesh = true so the frustum cull never drops them.
 *   - Bumps the camera.maxZ to 4000 on init so the far sky isn't clipped.
 *
 * Owns the sun DirectionalLight + ambient HemisphericLight so their
 * direction/intensity stay in sync with the visible sun position.
 */

import * as BABYLON from "@babylonjs/core";
import type { GraphicsSettings } from "./graphics-settings";

export interface SkyUpdateResult {
  /** sin(angle) of the sun. >0 day, <0 night, ~0 dawn/dusk. */
  sunAltitude: number;
  /** 0 = full day, 1 = full night. Used by callers for audio/preset blending. */
  nightFactor: number;
}

export class SkyController {
  private scene: BABYLON.Scene;
  private settings: GraphicsSettings;
  /**
   * Optional callback to register a mesh with noa's octree (dynamicContent).
   * CRITICAL: noa's OctreeSceneComponent overrides scene.getActiveMeshCandidates
   * to return only meshes registered with the octree. Sky meshes created via
   * MeshBuilder are NOT registered by default, so they're never evaluated as
   * active meshes and NEVER RENDER — even with alwaysSelectAsActiveMesh=true.
   * The adapter passes `(mesh) => noa.rendering._octreeManager.addMesh(mesh, false)`
   * so each celestial mesh is added to the octree's dynamic content list.
   */
  private registerWithOctree: ((mesh: BABYLON.AbstractMesh) => void) | null;

  /** Root node that follows the player every frame. All sky bodies are parented to it. */
  private skyRoot: BABYLON.TransformNode | null = null;
  private sunMesh: BABYLON.Mesh | null = null;
  private moonMesh: BABYLON.Mesh | null = null;
  private stars: BABYLON.Mesh[] = [];
  private clouds: BABYLON.Mesh[] = [];

  private sunMat: BABYLON.StandardMaterial | null = null;
  private moonMat: BABYLON.StandardMaterial | null = null;
  private starMats: BABYLON.StandardMaterial[] = [];
  private cloudMats: BABYLON.StandardMaterial[] = [];

  private sunLight: BABYLON.DirectionalLight | null = null;
  private ambientLight: BABYLON.HemisphericLight | null = null;
  /**
   * Separate cool moon fill light at night. A second HemisphericLight is cheap
   * and stable; its intensity is driven by the night factor so the scene gets a
   * faint blue moonlight at midnight (distinct from the warm sun).
   */
  private moonLight: BABYLON.HemisphericLight | null = null;

  /**
   * MASTER enable for all sky meshes. When false, setVisibilityOverrides()
   * disables sun/moon/stars/clouds regardless of the per-body flags. This is
   * what "Sky Off / Sky On" flips — previously those buttons called
   * setVisible() which set setEnabled(), but applyAtmosphereForCurrentPhase()
   * re-enabled the meshes every frame via setVisibilityOverrides(), so the
   * buttons appeared to do nothing.
   */
  private meshesEnabled: boolean = true;

  /** Orbital radius for sun/moon (voxels from player). Kept within camera maxZ. */
  private readonly radius = 300;
  /** Diameter of the sun sphere. Moderate — not a giant glowing blob. */
  private readonly sunSize = 30;
  /** Diameter of the moon/planet sphere. */
  private readonly moonSize = 40;

  private disposed = false;

  constructor(
    scene: BABYLON.Scene,
    settings: GraphicsSettings,
    registerWithOctree?: ((mesh: BABYLON.AbstractMesh) => void) | null
  ) {
    this.scene = scene;
    this.settings = settings;
    this.registerWithOctree = registerWithOctree ?? null;
    console.log("[SkyController] Initializing celestial system...");
    this.ensureCameraFarPlane();
    this.buildLights();
    this.buildSkyRoot();
    this.buildSun();
    this.buildMoon();
    this.buildStars();
    this.buildClouds();
    console.log("[SkyController] Celestial system ready.");
  }

  /**
   * Bump the camera maxZ so the far sky (radius 600) is never clipped by the
   * default near far-plane (~1000). Safe to call multiple times.
   */
  private ensureCameraFarPlane(): void {
    const cam = this.scene.activeCamera;
    if (cam) {
      try {
        cam.maxZ = 4000;
        console.log(`[SkyController] Camera maxZ set to ${cam.maxZ}.`);
      } catch {
        /* ignore — some camera types don't expose maxZ */
      }
    }
  }

  // ---- Build ---------------------------------------------------------------

  private buildLights(): void {
    this.sunLight = new BABYLON.DirectionalLight(
      "fp_sun_light",
      new BABYLON.Vector3(-0.5, -1.0, -0.3),
      this.scene
    );
    this.sunLight.intensity = 1.0;

    this.ambientLight = new BABYLON.HemisphericLight(
      "fp_ambient_light",
      new BABYLON.Vector3(0, 1, 0),
      this.scene
    );
    this.ambientLight.intensity = 0.4;
    this.ambientLight.groundColor = new BABYLON.Color3(0.12, 0.08, 0.10);

    // Cool moon fill light. Starts at intensity 0; driven up at night in update().
    this.moonLight = new BABYLON.HemisphericLight(
      "fp_moon_light",
      new BABYLON.Vector3(0, -1, 0),
      this.scene
    );
    this.moonLight.intensity = 0.0;
    this.moonLight.diffuse = new BABYLON.Color3(0.30, 0.40, 0.60);
    this.moonLight.groundColor = new BABYLON.Color3(0.05, 0.06, 0.10);
    this.moonLight.specular = new BABYLON.Color3(0.05, 0.07, 0.12);
  }

  private buildSkyRoot(): void {
    this.skyRoot = new BABYLON.TransformNode("fp_sky_root", this.scene);
  }

  /**
   * Register a mesh with noa's octree so it actually renders. Without this,
   * noa's OctreeSceneComponent excludes the mesh from active-mesh candidates
   * (it only returns octree-registered meshes), so the celestial body is
   * invisible regardless of alwaysSelectAsActiveMesh / isVisible / setEnabled.
   */
  private register(mesh: BABYLON.AbstractMesh): void {
    if (this.registerWithOctree) {
      try {
        this.registerWithOctree(mesh);
      } catch (e) {
        console.warn("[SkyController] octree registration failed for", mesh.name, e);
      }
    }
  }

  /**
   * Build an emissive sphere for a celestial body. Spheres are simpler and
   * more reliable than billboard planes — they render like any normal mesh,
   * participate in depth testing naturally, and are visible from any angle.
   */
  private buildCelestialSphere(
    name: string,
    diameter: number,
    emissive: BABYLON.Color3,
    diffuse: BABYLON.Color3
  ): { mesh: BABYLON.Mesh; mat: BABYLON.StandardMaterial } {
    const mesh = BABYLON.MeshBuilder.CreateSphere(
      name,
      { diameter, segments: 12 },
      this.scene
    );
    mesh.parent = this.skyRoot;
    const mat = new BABYLON.StandardMaterial(`${name}_mat`, this.scene);
    mat.emissiveColor = emissive;
    mat.diffuseColor = diffuse;
    mat.disableLighting = true; // sky bodies emit their own light
    mat.fogEnabled = false; // never hidden by atmospheric fog
    mat.backFaceCulling = false;
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.applyFog = false;
    mesh.renderingGroupId = 0; // same group as terrain — natural depth sorting
    mesh.alwaysSelectAsActiveMesh = true; // never frustum-cull
    this.register(mesh);
    return { mesh, mat };
  }

  private buildSun(): void {
    const { mesh, mat } = this.buildCelestialSphere(
      "fp_sun",
      this.sunSize,
      new BABYLON.Color3(1.0, 0.92, 0.70),
      new BABYLON.Color3(0, 0, 0)
    );
    this.sunMesh = mesh;
    this.sunMat = mat;
    console.log(`[SkyController] Sun sphere built (diameter=${this.sunSize}).`);
  }

  private buildMoon(): void {
    const { mesh, mat } = this.buildCelestialSphere(
      "fp_moon",
      this.moonSize,
      new BABYLON.Color3(0.18, 0.40, 0.85),
      new BABYLON.Color3(0, 0, 0)
    );
    this.moonMesh = mesh;
    this.moonMat = mat;
    console.log(`[SkyController] Moon sphere built (diameter=${this.moonSize}).`);
  }

  private buildStars(): void {
    const count = this.settings.starCount;
    for (let i = 0; i < count; i++) {
      // Small emissive spheres — tiny points of light, not giant blobs.
      const star = BABYLON.MeshBuilder.CreateSphere(
        `fp_star_${i}`,
        { diameter: 1.5 + Math.random() * 1.5, segments: 4 },
        this.scene
      );
      star.parent = this.skyRoot;

      // Distribute on the upper hemisphere of the sky shell.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random()); // 0..π/2 → upper hemisphere
      const r = this.radius + 20 + Math.random() * 40;
      star.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi) + 20,
        r * Math.sin(phi) * Math.sin(theta)
      );

      const mat = new BABYLON.StandardMaterial(`fp_star_mat_${i}`, this.scene);
      const tint = Math.random();
      if (tint < 0.6) mat.emissiveColor = new BABYLON.Color3(0.95, 0.95, 1.0);
      else if (tint < 0.85) mat.emissiveColor = new BABYLON.Color3(1.0, 0.92, 0.80);
      else mat.emissiveColor = new BABYLON.Color3(0.70, 0.85, 1.0);
      mat.disableLighting = true;
      mat.fogEnabled = false;
      mat.backFaceCulling = false;
      mat.alpha = 0; // hidden until night
      star.material = mat;
      star.isPickable = false;
      star.applyFog = false;
      star.renderingGroupId = 0;
      star.alwaysSelectAsActiveMesh = true;
      this.register(star);

      this.stars.push(star);
      this.starMats.push(mat);
    }
    console.log(`[SkyController] ${count} stars built.`);
  }

  private buildClouds(): void {
    const count = this.settings.cloudCount;
    for (let i = 0; i < count; i++) {
      const cloud = BABYLON.MeshBuilder.CreateDisc(
        `fp_cloud_${i}`,
        { radius: 40 + Math.random() * 30, tessellation: 8 },
        this.scene
      );
      cloud.parent = this.skyRoot;
      cloud.rotation.x = Math.PI / 2;
      cloud.position.set(
        (Math.random() - 0.5) * 500,
        80 + Math.random() * 30,
        (Math.random() - 0.5) * 500
      );
      const mat = new BABYLON.StandardMaterial(`fp_cloud_mat_${i}`, this.scene);
      mat.diffuseColor = new BABYLON.Color3(0.92, 0.90, 0.94);
      mat.emissiveColor = new BABYLON.Color3(0.20, 0.18, 0.22);
      mat.alpha = 0.25;
      mat.disableLighting = true;
      mat.fogEnabled = false;
      mat.backFaceCulling = false;
      cloud.material = mat;
      cloud.isPickable = false;
      cloud.applyFog = false;
      cloud.renderingGroupId = 0;
      cloud.alwaysSelectAsActiveMesh = true;
      this.register(cloud);

      this.clouds.push(cloud);
      this.cloudMats.push(mat);
    }
    console.log(`[SkyController] ${count} clouds built.`);
  }

  // ---- Update --------------------------------------------------------------

  /**
   * Advance the sky by one frame.
   * @param timeOfDay 0..1 clock value.
   * @param playerPos current player voxel position (sky follows player).
   * @param dtMs delta time in ms (for cloud drift).
   */
  public update(
    timeOfDay: number,
    playerPos: [number, number, number],
    dtMs: number
  ): SkyUpdateResult {
    if (this.disposed) return { sunAltitude: 0, nightFactor: 0 };

    const angle = timeOfDay * Math.PI * 2;
    const altitude = Math.sin(angle); // -1..1
    const horizontal = Math.cos(angle);
    const r = this.radius;

    // Move the sky root to the player every frame so celestial bodies stay
    // at a fixed distance from the camera regardless of player motion.
    if (this.skyRoot) {
      this.skyRoot.position.set(playerPos[0], playerPos[1], playerPos[2]);
    }

    // Sun: explicit orbital position relative to skyRoot (local space).
    // The +z bias puts the sun in FRONT of the default noa camera (which
    // looks toward +z before pointer lock engages), so the sun is visible
    // from the spawn pose without requiring the player to look around.
    if (this.sunMesh) {
      this.sunMesh.position.set(horizontal * r, altitude * r, r * 0.5);
      // Visibility: hide sun when it's well below the horizon.
      this.sunMesh.isVisible = altitude > -0.1;
    }
    // Moon: opposite side of the orbit (also +z biased so it's visible at night
    // from the spawn pose).
    if (this.moonMesh) {
      this.moonMesh.position.set(-horizontal * r, -altitude * r, r * 0.5);
      this.moonMesh.isVisible = altitude < 0.1;
    }

    // Sun directional light: direction = from sun toward player.
    if (this.sunLight) {
      this.sunLight.direction = new BABYLON.Vector3(
        -horizontal,
        -altitude,
        -0.5
      ).normalize();
      this.sunLight.intensity = altitude > 0 ? 1.0 * Math.sqrt(altitude) : 0.0;
      if (altitude > 0 && altitude < 0.35) {
        const t = altitude / 0.35;
        this.sunLight.diffuse = new BABYLON.Color3(
          1.0,
          0.55 + 0.35 * t,
          0.30 + 0.45 * t
        );
      } else if (altitude >= 0.35) {
        this.sunLight.diffuse = new BABYLON.Color3(1.0, 0.92, 0.78);
      }
    }

    // Ambient fill.
    if (this.ambientLight) {
      this.ambientLight.intensity = altitude > 0.1
        ? 0.55
        : altitude < -0.1
        ? 0.22
        : 0.22 + (altitude + 0.1) / 0.2 * 0.33;
    }

    // Stars: fade in as the sun drops below the horizon.
    const nightFactor = altitude < 0
      ? Math.min(1.0, -altitude * 3.0)
      : 0.0;
    for (let i = 0; i < this.starMats.length; i++) {
      this.starMats[i].alpha = nightFactor * this._starBrightnessOverride;
    }

    // Moon fill light: driven by nightFactor and the VisualTuning override.
    if (this.moonLight) {
      this.moonLight.intensity = this._moonLightEnabled
        ? nightFactor * this._moonLightIntensity
        : 0.0;
    }

    // Clouds: drift + dim at night.
    const cloudDay = altitude > 0.1
      ? 1.0
      : altitude < -0.1
      ? 0.25
      : 0.25 + (altitude + 0.1) / 0.2 * 0.75;
    const drift = dtMs * 0.00002;
    for (let i = 0; i < this.clouds.length; i++) {
      const c = this.clouds[i];
      c.position.x += drift * 60;
      c.position.z += drift * 36;
      // Wrap relative to skyRoot origin.
      if (c.position.x > 350) c.position.x = -350;
      if (c.position.z > 350) c.position.z = -350;
      this.cloudMats[i].alpha = 0.25 * cloudDay;
    }

    return { sunAltitude: altitude, nightFactor };
  }

  // ---- Accessors -----------------------------------------------------------

  public getSunLight(): BABYLON.DirectionalLight | null {
    return this.sunLight;
  }

  public getAmbientLight(): BABYLON.HemisphericLight | null {
    return this.ambientLight;
  }

  public getMoonLight(): BABYLON.HemisphericLight | null {
    return this.moonLight;
  }

  /**
   * MASTER sky-mesh enable toggle. This is what "Sky Off / Sky On" flips.
   * It persists across frames because setVisibilityOverrides() reads it every
   * frame — unlike the old setVisible() one-shot which was immediately undone.
   */
  public setMeshesEnabled(enabled: boolean): void {
    this.meshesEnabled = enabled;
    console.log(`[SkyController] Sky meshes master ${enabled ? "ENABLED" : "DISABLED"}.`);
  }

  public isMeshesEnabled(): boolean {
    return this.meshesEnabled;
  }

  /**
   * Legacy one-shot visibility toggle. Kept for backward compatibility but now
   * also flips the master flag so it actually persists.
   */
  public setVisible(visible: boolean): void {
    this.setMeshesEnabled(visible);
  }

  /**
   * Moon light runtime config (driven by VisualTuning).
   */
  public setMoonLight(opts: { enabled: boolean; intensity: number }): void {
    this._moonLightEnabled = opts.enabled;
    this._moonLightIntensity = Math.max(0, opts.intensity);
  }

  /**
   * Apply granular visibility overrides from the VisualTuning console.
   * Each celestial body type can be toggled independently — BUT the master
   * `meshesEnabled` flag gates ALL of them. When master is off, everything is
   * disabled regardless of the per-body flags. This is why "Sky Off" now works.
   */
  public setVisibilityOverrides(opts: {
    sunVisible: boolean;
    moonVisible: boolean;
    starsVisible: boolean;
    cloudsVisible: boolean;
    starBrightness: number;
  }): void {
    this._starBrightnessOverride = opts.starBrightness;
    if (!this.meshesEnabled) {
      if (this.sunMesh) this.sunMesh.setEnabled(false);
      if (this.moonMesh) this.moonMesh.setEnabled(false);
      for (const s of this.stars) s.setEnabled(false);
      for (const c of this.clouds) c.setEnabled(false);
      return;
    }
    if (this.sunMesh) this.sunMesh.setEnabled(opts.sunVisible);
    if (this.moonMesh) this.moonMesh.setEnabled(opts.moonVisible);
    for (const s of this.stars) s.setEnabled(opts.starsVisible);
    for (const c of this.clouds) c.setEnabled(opts.cloudsVisible);
  }

  private _starBrightnessOverride: number = 1.0;
  private _moonLightEnabled: boolean = true;
  private _moonLightIntensity: number = 0.25;

  /**
   * Return the current celestial body positions (world space) for debug.
   */
  public getDebugInfo(): {
    sunVisible: boolean;
    moonVisible: boolean;
    starCount: number;
    starAlpha: number;
    sunLightIntensity: number;
    ambientIntensity: number;
    moonLightIntensity: number;
    meshesEnabled: boolean;
  } {
    return {
      sunVisible: !!this.sunMesh?.isVisible,
      moonVisible: !!this.moonMesh?.isVisible,
      starCount: this.stars.length,
      starAlpha: this.starMats.length ? this.starMats[0].alpha : 0,
      sunLightIntensity: this.sunLight?.intensity ?? 0,
      ambientIntensity: this.ambientLight?.intensity ?? 0,
      moonLightIntensity: this.moonLight?.intensity ?? 0,
      meshesEnabled: this.meshesEnabled,
    };
  }

  /**
   * Rich celestial debug snapshot for window.__fpDebug().sky. Includes mesh
   * names, enabled/isVisible state, absolute + screen positions, sky radius,
   * camera info, material fog flags, rendering group / layer mask, and the
   * active sky/fog color + source (passed in by the adapter).
   */
  public getSkyDebug(opts: {
    activeSkyColor: string;
    skyColorSource: string;
    activeFogColor: string;
    fogColorSource: string;
    modSkyOverlayActive: boolean;
  }): Record<string, unknown> {
    const cam = this.scene.activeCamera;
    const viewport = this.scene.activeCamera?.viewport;
    const engine = this.scene.getEngine();
    const renderWidth = engine.getRenderWidth();
    const renderHeight = engine.getRenderHeight();

    const toScreen = (worldPos: BABYLON.Vector3 | null): { x: number; y: number; onScreen: boolean } | null => {
      if (!cam || !worldPos) return null;
      try {
        // Babylon 6: Vector3.Project(vector, world, transform, viewport) where
        // transform = viewMatrix * projectionMatrix.
        const transform = cam.getViewMatrix().multiply(cam.getProjectionMatrix());
        const projected = BABYLON.Vector3.Project(
          worldPos,
          BABYLON.Matrix.Identity(),
          transform,
          viewport ?? new BABYLON.Viewport(0, 0, renderWidth, renderHeight)
        );
        return {
          x: Math.round(projected.x),
          y: Math.round(projected.y),
          onScreen: projected.x >= 0 && projected.x <= renderWidth && projected.y >= 0 && projected.y <= renderHeight && projected.z < 1,
        };
      } catch {
        return null;
      }
    };

    const camPos = cam ? cam.position : null;
    const camTarget = cam ? (cam as any).target : null;
    const camDir = cam && camTarget
      ? [camTarget.x - cam.position.x, camTarget.y - cam.position.y, camTarget.z - cam.position.z]
      : cam
      ? [(cam as any).getForwardRay?.()?.direction?.x ?? 0, (cam as any).getForwardRay?.()?.direction?.y ?? 0, (cam as any).getForwardRay?.()?.direction?.z ?? 0]
      : null;

    const sunWorld = this.sunMesh ? this.sunMesh.getAbsolutePosition() : null;
    const moonWorld = this.moonMesh ? this.moonMesh.getAbsolutePosition() : null;

    // First 10 stars' screen positions + count of currently-visible stars.
    const starScreen: Array<{ i: number; x: number; y: number; onScreen: boolean }> = [];
    let visibleStarCount = 0;
    for (let i = 0; i < Math.min(10, this.stars.length); i++) {
      const s = this.stars[i];
      if (!s) continue;
      const w = s.getAbsolutePosition();
      const sp = toScreen(w);
      if (sp) starScreen.push({ i, ...sp });
      if (s.isEnabled() && s.isVisible && (this.starMats[i]?.alpha ?? 0) > 0.05) visibleStarCount++;
    }
    for (let i = 10; i < this.stars.length; i++) {
      const s = this.stars[i];
      if (s && s.isEnabled() && s.isVisible && (this.starMats[i]?.alpha ?? 0) > 0.05) visibleStarCount++;
    }

    return {
      skyRoot: {
        name: this.skyRoot?.name ?? null,
        enabled: this.skyRoot?.isEnabled() ?? false,
        position: this.skyRoot ? [this.skyRoot.position.x, this.skyRoot.position.y, this.skyRoot.position.z] : null,
      },
      meshesEnabled: this.meshesEnabled,
      sun: this.sunMesh
        ? {
            meshName: this.sunMesh.name,
            enabled: this.sunMesh.isEnabled(),
            isVisible: this.sunMesh.isVisible,
            absolutePosition: sunWorld ? [sunWorld.x, sunWorld.y, sunWorld.z] : null,
            screenPosition: toScreen(sunWorld),
            renderingGroupId: this.sunMesh.renderingGroupId,
            layerMask: this.sunMesh.layerMask,
            materialFogEnabled: this.sunMat?.fogEnabled ?? null,
            materialDisableLighting: this.sunMat?.disableLighting ?? null,
          }
        : null,
      moon: this.moonMesh
        ? {
            meshName: this.moonMesh.name,
            enabled: this.moonMesh.isEnabled(),
            isVisible: this.moonMesh.isVisible,
            absolutePosition: moonWorld ? [moonWorld.x, moonWorld.y, moonWorld.z] : null,
            screenPosition: toScreen(moonWorld),
            renderingGroupId: this.moonMesh.renderingGroupId,
            layerMask: this.moonMesh.layerMask,
            materialFogEnabled: this.moonMat?.fogEnabled ?? null,
            materialDisableLighting: this.moonMat?.disableLighting ?? null,
          }
        : null,
      stars: {
        count: this.stars.length,
        visibleCount: visibleStarCount,
        first10ScreenPositions: starScreen,
        materialFogEnabled: this.starMats[0]?.fogEnabled ?? null,
        materialDisableLighting: this.starMats[0]?.disableLighting ?? null,
        renderingGroupId: this.stars[0]?.renderingGroupId ?? null,
      },
      clouds: {
        count: this.clouds.length,
        renderingGroupId: this.clouds[0]?.renderingGroupId ?? null,
      },
      skyRadius: this.radius,
      camera: cam
        ? {
            position: camPos ? [camPos.x, camPos.y, camPos.z] : null,
            direction: camDir,
            maxZ: cam.maxZ,
            minZ: cam.minZ,
            layerMask: cam.layerMask,
          }
        : null,
      activeSkyColor: opts.activeSkyColor,
      skyColorSource: opts.skyColorSource,
      activeFogColor: opts.activeFogColor,
      fogColorSource: opts.fogColorSource,
      modSkyOverlayActive: opts.modSkyOverlayActive,
      lights: {
        sunIntensity: this.sunLight?.intensity ?? 0,
        ambientIntensity: this.ambientLight?.intensity ?? 0,
        moonIntensity: this.moonLight?.intensity ?? 0,
      },
    };
  }

  public setSettings(settings: GraphicsSettings): void {
    this.settings = settings;
    if (settings.starCount !== this.stars.length) {
      this.disposeStars();
      this.buildStars();
    }
    if (settings.cloudCount !== this.clouds.length) {
      this.disposeClouds();
      this.buildClouds();
    }
  }

  // ---- Dispose -------------------------------------------------------------

  private disposeStars(): void {
    for (const s of this.stars) s.dispose();
    for (const m of this.starMats) m.dispose();
    this.stars = [];
    this.starMats = [];
  }

  private disposeClouds(): void {
    for (const c of this.clouds) c.dispose();
    for (const m of this.cloudMats) m.dispose();
    this.clouds = [];
    this.cloudMats = [];
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeStars();
    this.disposeClouds();
    try {
      this.sunMesh?.dispose();
      this.moonMesh?.dispose();
      this.sunMat?.dispose();
      this.moonMat?.dispose();
      this.sunLight?.dispose();
      this.ambientLight?.dispose();
      this.moonLight?.dispose();
      this.skyRoot?.dispose();
    } catch {
      /* ignore */
    }
    console.log("[SkyController] Disposed.");
  }
}
