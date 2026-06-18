/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * VisualTuning — live-tunable graphics/world parameters for the debug console.
 *
 * This object is held by NoaEngineAdapter and mutated live by the F3 debug
 * tuning console. Every frame, applyAtmosphereForCurrentPhase() reads these
 * values and applies them to the Babylon scene, overriding the preset defaults.
 *
 * All values have safe defaults and are clamped on application. Settings
 * persist to localStorage under "frontierPlanet.visualSettings" and can be
 * exported/imported via __fpDebug().exportVisualSettings().
 */

export interface VisualTuning {
  // ---- Fog ----
  fogEnabled: boolean;
  fogStart: number | null; // null = auto from preset/render distance
  fogEnd: number | null;
  fogColorHex: string | null; // null = auto from preset
  fogAutoClampToRenderDistance: boolean;

  // ---- Lighting (day/night) ----
  /** Multiplier on the ambient hemispheric light intensity (0-3). */
  ambientIntensityMultiplier: number;
  /** Multiplier on the sun directional light intensity (0-3). */
  sunIntensityMultiplier: number;
  /** Ambient intensity at full night (0-1). */
  nightAmbientIntensity: number;
  /** Ambient intensity at full day (0-1). */
  dayAmbientIntensity: number;
  /** Sun intensity at noon (0-3). */
  noonSunIntensity: number;
  /** Sun intensity at midnight (0-1, usually 0). */
  midnightSunIntensity: number;

  // ---- Time ----
  timeFrozen: boolean;
  timeSpeedMultiplier: number; // 1 = normal, 0 = frozen, 10 = fast

  // ---- Dynamic lights ----
  dynamicLightsEnabled: boolean;
  activeLightBudget: number; // 4/6/8
  lightIntensityMultiplier: number; // 1 = default 8x scale
  lightRangeMultiplier: number; // 1 = default

  // ---- Glow / Bloom / Postprocess ----
  glowEnabled: boolean;
  glowIntensity: number; // 0-1
  glowKernel: number; // 8-64
  bloomEnabled: boolean;
  bloomWeight: number;
  bloomThreshold: number;
  bloomKernel: number;
  fxaaEnabled: boolean;
  toneMappingEnabled: boolean;
  exposure: number;
  contrast: number;

  // ---- Sky ----
  skyVisible: boolean;
  sunVisible: boolean;
  moonVisible: boolean;
  starsVisible: boolean;
  cloudsVisible: boolean;
  sunSize: number;
  moonSize: number;
  starBrightness: number; // 0-1 multiplier on star alpha

  // ---- Materials ----
  /** "default" = noa flat color for normal blocks, "custom" = custom renderMaterial for all, "debug" = force unlit orange. */
  terrainMaterialMode: "default" | "custom" | "debug";

  // ---- Chunk / render distance ----
  /** Pending chunk add distance (requires renderer restart to apply). */
  pendingChunkAddDistance: number | null;
  pendingChunkRemoveDistance: number | null;
  fogMatchRenderDistance: boolean;

  // ---- Preset name (for display) ----
  activePresetName: string;
}

export const DEFAULT_VISUAL_TUNING: VisualTuning = {
  fogEnabled: true,
  fogStart: null,
  fogEnd: null,
  fogColorHex: null,
  fogAutoClampToRenderDistance: true,

  ambientIntensityMultiplier: 1.0,
  sunIntensityMultiplier: 1.0,
  nightAmbientIntensity: 0.18,
  dayAmbientIntensity: 0.55,
  noonSunIntensity: 1.0,
  midnightSunIntensity: 0.0,

  timeFrozen: false,
  timeSpeedMultiplier: 1.0,

  dynamicLightsEnabled: true,
  activeLightBudget: 6,
  lightIntensityMultiplier: 1.0,
  lightRangeMultiplier: 1.0,

  glowEnabled: true,
  glowIntensity: 0.15,
  glowKernel: 20,
  bloomEnabled: false,
  bloomWeight: 0.25,
  bloomThreshold: 0.9,
  bloomKernel: 24,
  fxaaEnabled: true,
  toneMappingEnabled: true,
  exposure: 1.0,
  contrast: 1.03,

  skyVisible: true,
  sunVisible: true,
  moonVisible: true,
  starsVisible: true,
  cloudsVisible: false,
  sunSize: 30,
  moonSize: 40,
  starBrightness: 1.0,

  terrainMaterialMode: "default",

  pendingChunkAddDistance: null,
  pendingChunkRemoveDistance: null,
  fogMatchRenderDistance: true,

  activePresetName: "Atmospheric Default",
};

const STORAGE_KEY = "frontierPlanet.visualSettings";

/** Load saved tuning from localStorage, merged over defaults. */
export function loadVisualTuning(): VisualTuning {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VISUAL_TUNING };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_VISUAL_TUNING, ...parsed };
  } catch {
    return { ...DEFAULT_VISUAL_TUNING };
  }
}

/** Persist tuning to localStorage. */
export function saveVisualTuning(t: VisualTuning): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
  } catch {
    /* ignore quota errors */
  }
}

/** Named presets that apply a batch of tuning values. */
export const NAMED_PRESETS: Record<string, Partial<VisualTuning>> = {
  "Safe Baseline": {
    fogEnabled: false,
    glowEnabled: false,
    bloomEnabled: false,
    dynamicLightsEnabled: true,
    activeLightBudget: 4,
    ambientIntensityMultiplier: 1.2,
    sunIntensityMultiplier: 1.3,
    activePresetName: "Safe Baseline",
  },
  "Red Wasteland Day": {
    fogEnabled: true,
    fogStart: null,
    fogEnd: null,
    fogColorHex: "#6b4a3a",
    glowEnabled: true,
    glowIntensity: 0.12,
    bloomEnabled: false,
    ambientIntensityMultiplier: 1.0,
    sunIntensityMultiplier: 1.0,
    activePresetName: "Red Wasteland Day",
  },
  "Red Wasteland Night": {
    fogEnabled: true,
    fogColorHex: "#100a0e",
    glowEnabled: true,
    glowIntensity: 0.18,
    bloomEnabled: false,
    nightAmbientIntensity: 0.15,
    ambientIntensityMultiplier: 0.8,
    sunIntensityMultiplier: 0.5,
    activePresetName: "Red Wasteland Night",
  },
  "Debug Fullbright": {
    fogEnabled: false,
    glowEnabled: false,
    bloomEnabled: false,
    ambientIntensityMultiplier: 2.0,
    sunIntensityMultiplier: 1.5,
    nightAmbientIntensity: 0.8,
    dayAmbientIntensity: 0.9,
    terrainMaterialMode: "debug",
    activePresetName: "Debug Fullbright (DEBUG ONLY)",
  },
  "Atmospheric Test": {
    fogEnabled: true,
    glowEnabled: true,
    glowIntensity: 0.15,
    bloomEnabled: false,
    ambientIntensityMultiplier: 1.0,
    sunIntensityMultiplier: 1.0,
    activePresetName: "Atmospheric Test",
  },
};
