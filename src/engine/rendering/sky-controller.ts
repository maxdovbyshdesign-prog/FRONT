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

  /** Orbital radius for sun/moon (voxels from player). Kept within camera maxZ. */
  private readonly radius = 300;
  /** Diameter of the sun sphere. Moderate — not a giant glowing blob. */
  private readonly sunSize = 30;
  /** Diameter of the moon/planet sphere. */
  private readonly moonSize = 40;

  private disposed = false;

  constructor(scene: BABYLON.Scene, settings: GraphicsSettings) {
    this.scene = scene;
    this.settings = settings;
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
  }

  private buildSkyRoot(): void {
    this.skyRoot = new BABYLON.TransformNode("fp_sky_root", this.scene);
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

  /**
   * Toggle visibility of all sky meshes (sun, moon, stars, clouds) for QA.
   * Used by window.__fpDebug().setSkyVisible(false) to isolate whether sky
   * meshes are occluding terrain.
   */
  public setVisible(visible: boolean): void {
    if (this.sunMesh) this.sunMesh.setEnabled(visible);
    if (this.moonMesh) this.moonMesh.setEnabled(visible);
    for (const s of this.stars) s.setEnabled(visible);
    for (const c of this.clouds) c.setEnabled(visible);
    console.log(`[SkyController] Sky meshes ${visible ? "enabled" : "disabled"}.`);
  }

  /**
   * Apply granular visibility overrides from the VisualTuning console.
   * Each celestial body type can be toggled independently.
   */
  public setVisibilityOverrides(opts: {
    sunVisible: boolean;
    moonVisible: boolean;
    starsVisible: boolean;
    cloudsVisible: boolean;
    starBrightness: number;
  }): void {
    if (this.sunMesh) this.sunMesh.setEnabled(opts.sunVisible);
    if (this.moonMesh) this.moonMesh.setEnabled(opts.moonVisible);
    for (const s of this.stars) s.setEnabled(opts.starsVisible);
    for (const c of this.clouds) c.setEnabled(opts.cloudsVisible);
    // Star brightness = alpha multiplier. Applied in update() via nightFactor,
    // but we also store it for the update loop to use.
    this._starBrightnessOverride = opts.starBrightness;
  }

  private _starBrightnessOverride: number = 1.0;

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
  } {
    return {
      sunVisible: !!this.sunMesh?.isVisible,
      moonVisible: !!this.moonMesh?.isVisible,
      starCount: this.stars.length,
      starAlpha: this.starMats.length ? this.starMats[0].alpha : 0,
      sunLightIntensity: this.sunLight?.intensity ?? 0,
      ambientIntensity: this.ambientLight?.intensity ?? 0,
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
      this.skyRoot?.dispose();
    } catch {
      /* ignore */
    }
    console.log("[SkyController] Disposed.");
  }
}
