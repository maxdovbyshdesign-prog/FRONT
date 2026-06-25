/**
 * Abstract camera-relative falling field prototype types.
 *
 * This is deliberately not a weather preset model. Keep it small until the
 * renderer has passed Polygon-only spatial/lifecycle tests.
 */

export type PrecipitationFieldWrapMode = "cameraCylinder" | "cameraBox";
export type PrecipitationFieldRespawnMode = "top" | "wrap";
export type PrecipitationFieldShelterMode = "off" | "polygonTestRoof" | "playerRoofProbe";

export interface PrecipitationFieldConfig {
  enabled: boolean;
  elementCount: number;
  fieldRadius: number;
  fieldHeight: number;
  baseVelocity: [number, number, number];
  wind: [number, number, number];
  elementSize: {
    width: number;
    height: number;
  };
  alpha: number;
  wrapMode: PrecipitationFieldWrapMode;
  respawnMode: PrecipitationFieldRespawnMode;
  shelterMode: PrecipitationFieldShelterMode;
  shelterReduction: number;
}

export interface PrecipitationFieldUpdateContext {
  dtMs: number;
  cameraLocalPosition: [number, number, number];
  playerWorldPosition: [number, number, number];
  worldOriginOffset: [number, number, number];
  shelterFactor: number;
}

export interface PrecipitationFieldDebugInfo {
  available: boolean;
  enabled: boolean;
  elementCount: number;
  visibleCount: number;
  activeAlpha: number;
  wind: [number, number, number];
  shelterMode: PrecipitationFieldShelterMode;
  shelterActive: boolean;
  shelterFactor: number;
  fieldRadius: number;
  fieldHeight: number;
  cameraLocalPosition: [number, number, number] | null;
  sampleElementLocalPosition: [number, number, number] | null;
  testRoofWorldCenter: [number, number, number];
}

export const DEFAULT_PRECIPITATION_FIELD_CONFIG: PrecipitationFieldConfig = {
  enabled: false,
  elementCount: 180,
  fieldRadius: 36,
  fieldHeight: 54,
  baseVelocity: [0, -12, 0],
  wind: [2.8, 0, -1.2],
  elementSize: {
    width: 0.22,
    height: 4.2,
  },
  alpha: 0.86,
  wrapMode: "cameraCylinder",
  respawnMode: "top",
  shelterMode: "off",
  shelterReduction: 0.12,
};

export const POLYGON_TEST_ROOF = {
  center: [32, 14, 0] as [number, number, number],
  halfSize: [6, 0.25, 6] as [number, number, number],
};
