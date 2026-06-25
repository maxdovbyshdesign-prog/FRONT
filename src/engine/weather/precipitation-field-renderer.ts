/**
 * Abstract camera-relative falling field renderer.
 *
 * Prototype constraints:
 * - Polygon-only integration for now.
 * - Grey rectangles/streaks only.
 * - No weather presets, audio, fog, gameplay hazards, or lighting changes.
 */

import * as BABYLON from "@babylonjs/core";
import {
  DEFAULT_PRECIPITATION_FIELD_CONFIG,
  POLYGON_TEST_ROOF,
  type PrecipitationFieldConfig,
  type PrecipitationFieldDebugInfo,
  type PrecipitationFieldShelterMode,
  type PrecipitationFieldUpdateContext,
} from "./precipitation-field-types";

interface FieldElement {
  mesh: BABYLON.Mesh;
  offset: BABYLON.Vector3;
  driftPhase: number;
  yaw: number;
}

export class PrecipitationFieldRenderer {
  private scene: BABYLON.Scene;
  private config: PrecipitationFieldConfig;
  private registerMesh?: (mesh: BABYLON.AbstractMesh) => void;
  private material: BABYLON.StandardMaterial;
  private sourceMesh: BABYLON.Mesh;
  private elements: FieldElement[] = [];
  private testRoof: BABYLON.Mesh | null = null;
  private testRoofMaterial: BABYLON.StandardMaterial | null = null;
  private disposed = false;
  private enabled = false;
  private activeAlpha = 0;
  private shelterFactor = 1;
  private lastCameraLocalPosition: [number, number, number] | null = null;
  private sampleElementLocalPosition: [number, number, number] | null = null;

  constructor(
    scene: BABYLON.Scene,
    config: Partial<PrecipitationFieldConfig> = {},
    registerMesh?: (mesh: BABYLON.AbstractMesh) => void
  ) {
    this.scene = scene;
    this.registerMesh = registerMesh;
    this.config = {
      ...DEFAULT_PRECIPITATION_FIELD_CONFIG,
      ...config,
      elementSize: {
        ...DEFAULT_PRECIPITATION_FIELD_CONFIG.elementSize,
        ...(config.elementSize ?? {}),
      },
    };
    this.enabled = this.config.enabled;

    this.material = new BABYLON.StandardMaterial("fp_abstract_field_mat", scene);
    this.material.diffuseColor = new BABYLON.Color3(0.88, 0.88, 0.88);
    this.material.emissiveColor = new BABYLON.Color3(0.82, 0.82, 0.82);
    this.material.alpha = 0;
    this.material.backFaceCulling = false;
    this.material.disableLighting = true;
    this.material.fogEnabled = false;
    this.material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;

    this.sourceMesh = BABYLON.MeshBuilder.CreatePlane(
      "fp_abstract_field_source",
      {
        width: this.config.elementSize.width,
        height: this.config.elementSize.height,
        sideOrientation: BABYLON.Mesh.DOUBLESIDE,
      },
      scene
    );
    this.sourceMesh.material = this.material;
    this.sourceMesh.isPickable = false;
    this.sourceMesh.setEnabled(false);

    this.createElements();
    this.createTestRoof();
    this.setEnabled(this.enabled);
  }

  public setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.enabled = enabled;
    for (const element of this.elements) {
      element.mesh.setEnabled(enabled);
    }
    this.updateTestRoofEnabled();
    if (!enabled) {
      this.material.alpha = 0;
      this.activeAlpha = 0;
    }
  }

  public toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  public setWind(wind: [number, number, number]): void {
    this.config.wind = wind;
  }

  public cycleWind(): [number, number, number] {
    const [x, , z] = this.config.wind;
    const next: [number, number, number] =
      Math.abs(x) > Math.abs(z)
        ? [-1.4, 0, 3.2]
        : [3.2, 0, -1.4];
    this.setWind(next);
    return next;
  }

  public setShelterMode(mode: PrecipitationFieldShelterMode): PrecipitationFieldShelterMode {
    this.config.shelterMode = mode;
    this.updateTestRoofEnabled();
    return this.config.shelterMode;
  }

  public toggleShelterMode(): PrecipitationFieldShelterMode {
    return this.setShelterMode(this.config.shelterMode === "off" ? "polygonTestRoof" : "off");
  }

  public update(ctx: PrecipitationFieldUpdateContext): void {
    if (this.disposed) return;
    this.updateTestRoof(ctx.worldOriginOffset);
    if (!this.enabled) return;

    const dt = Math.min(0.08, Math.max(0, ctx.dtMs / 1000));
    const center = BABYLON.Vector3.FromArray(ctx.cameraLocalPosition);
    this.lastCameraLocalPosition = [...ctx.cameraLocalPosition];
    const velocity = BABYLON.Vector3.FromArray(this.config.baseVelocity);
    const wind = BABYLON.Vector3.FromArray(this.config.wind);
    const motion = velocity.add(wind).scale(dt);
    const radius = this.config.fieldRadius;
    const halfHeight = this.config.fieldHeight / 2;
    this.shelterFactor = this.config.shelterMode === "off"
      ? 1
      : Math.max(0, Math.min(1, ctx.shelterFactor));
    this.activeAlpha = this.config.alpha * this.shelterFactor;
    this.material.alpha = this.activeAlpha;

    const windTilt = Math.atan2(this.config.wind[0], Math.abs(this.config.baseVelocity[1]) + 0.001) * 0.7;
    const windYaw = Math.atan2(this.config.wind[0], this.config.wind[2] || 0.001);

    for (const element of this.elements) {
      element.offset.addInPlace(motion);
      element.offset.x += Math.sin(performance.now() * 0.0015 + element.driftPhase) * dt * 0.35;
      element.offset.z += Math.cos(performance.now() * 0.0013 + element.driftPhase) * dt * 0.35;

      if (element.offset.y < -halfHeight) {
        this.resetElementToTop(element, radius, halfHeight);
      }

      if (this.config.wrapMode === "cameraCylinder") {
        const d2 = element.offset.x * element.offset.x + element.offset.z * element.offset.z;
        if (d2 > radius * radius) {
          this.wrapElementXZ(element, radius);
        }
      } else {
        if (Math.abs(element.offset.x) > radius) element.offset.x = -Math.sign(element.offset.x) * radius;
        if (Math.abs(element.offset.z) > radius) element.offset.z = -Math.sign(element.offset.z) * radius;
      }

      element.mesh.position.copyFrom(center).addInPlace(element.offset);
      element.mesh.rotation.set(windTilt, element.yaw + windYaw * 0.18, windTilt * 0.7);
    }

    const sample = this.elements[0]?.mesh.position;
    this.sampleElementLocalPosition = sample ? [sample.x, sample.y, sample.z] : null;
  }

  public getDebugInfo(): PrecipitationFieldDebugInfo {
    const visibleCount = this.elements.filter((element) => element.mesh.isEnabled() && element.mesh.isVisible).length;
    return {
      available: !this.disposed,
      enabled: this.enabled,
      elementCount: this.elements.length,
      visibleCount,
      activeAlpha: Number(this.activeAlpha.toFixed(3)),
      wind: [...this.config.wind],
      shelterMode: this.config.shelterMode,
      shelterActive: this.config.shelterMode !== "off",
      shelterFactor: Number(this.shelterFactor.toFixed(3)),
      fieldRadius: this.config.fieldRadius,
      fieldHeight: this.config.fieldHeight,
      cameraLocalPosition: this.lastCameraLocalPosition ? [...this.lastCameraLocalPosition] : null,
      sampleElementLocalPosition: this.sampleElementLocalPosition ? [...this.sampleElementLocalPosition] : null,
      testRoofWorldCenter: [...POLYGON_TEST_ROOF.center],
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const element of this.elements) {
      element.mesh.dispose();
    }
    this.elements = [];
    this.testRoof?.dispose();
    this.testRoof = null;
    this.testRoofMaterial?.dispose();
    this.testRoofMaterial = null;
    this.sourceMesh.dispose();
    this.material.dispose();
  }

  private createElements(): void {
    for (let i = 0; i < this.config.elementCount; i++) {
      const mesh = this.sourceMesh.clone(`fp_abstract_field_${i}`);
      if (!mesh) continue;
      mesh.material = this.material;
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;
      this.registerMesh?.(mesh);
      mesh.setEnabled(false);
      const element: FieldElement = {
        mesh,
        offset: this.randomOffset(this.config.fieldRadius, this.config.fieldHeight / 2),
        driftPhase: Math.random() * Math.PI * 2,
        yaw: Math.random() * Math.PI * 2,
      };
      this.elements.push(element);
    }
  }

  private createTestRoof(): void {
    this.testRoof = BABYLON.MeshBuilder.CreateBox(
      "fp_abstract_field_test_roof",
      {
        width: POLYGON_TEST_ROOF.halfSize[0] * 2,
        height: POLYGON_TEST_ROOF.halfSize[1] * 2,
        depth: POLYGON_TEST_ROOF.halfSize[2] * 2,
      },
      this.scene
    );
    this.testRoofMaterial = new BABYLON.StandardMaterial("fp_abstract_field_test_roof_mat", this.scene);
    this.testRoofMaterial.diffuseColor = new BABYLON.Color3(0.32, 0.32, 0.32);
    this.testRoofMaterial.emissiveColor = new BABYLON.Color3(0.08, 0.08, 0.08);
    this.testRoofMaterial.alpha = 0.72;
    this.testRoofMaterial.disableLighting = true;
    this.testRoofMaterial.fogEnabled = false;
    this.testRoof.material = this.testRoofMaterial;
    this.testRoof.isPickable = false;
    this.testRoof.alwaysSelectAsActiveMesh = true;
    this.registerMesh?.(this.testRoof);
    this.testRoof.setEnabled(false);
  }

  private updateTestRoof(worldOriginOffset: [number, number, number]): void {
    if (!this.testRoof) return;
    this.testRoof.position.set(
      POLYGON_TEST_ROOF.center[0] - worldOriginOffset[0],
      POLYGON_TEST_ROOF.center[1] - worldOriginOffset[1],
      POLYGON_TEST_ROOF.center[2] - worldOriginOffset[2]
    );
    this.updateTestRoofEnabled();
  }

  private updateTestRoofEnabled(): void {
    if (!this.testRoof) return;
    this.testRoof.setEnabled(this.enabled && this.config.shelterMode !== "off");
  }

  private randomOffset(radius: number, halfHeight: number): BABYLON.Vector3 {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    return new BABYLON.Vector3(
      Math.cos(angle) * r,
      -halfHeight + Math.random() * halfHeight * 2,
      Math.sin(angle) * r
    );
  }

  private resetElementToTop(element: FieldElement, radius: number, halfHeight: number): void {
    const next = this.randomOffset(radius, halfHeight);
    element.offset.x = next.x;
    element.offset.y = halfHeight;
    element.offset.z = next.z;
  }

  private wrapElementXZ(element: FieldElement, radius: number): void {
    const angle = Math.atan2(element.offset.z, element.offset.x) + Math.PI;
    const r = radius * (0.75 + Math.random() * 0.2);
    element.offset.x = Math.cos(angle) * r;
    element.offset.z = Math.sin(angle) * r;
  }
}
