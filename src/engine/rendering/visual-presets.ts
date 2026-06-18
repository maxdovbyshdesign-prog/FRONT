/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * VisualPresets — data-driven biome / time-of-day atmosphere presets.
 *
 * PASS 4 "Purple Dimension" FIX — the previous fog colors were saturated
 * purple (#5a3a4a, #4a2a30) and fogStart was very close (45-55). This
 * created a purple veil that hid all terrain. Now:
 *   - fog colors are muted dusty brown/mauve, NOT saturated purple
 *   - fogStart/fogEnd are computed from render distance at runtime
 *     (0.65×RDB → 1.15×RDB) so fog only appears at the far horizon
 *   - glow/bloom in presets are overridden by GraphicsSettings (bloom off,
 *     glow 0.10-0.20)
 */

import * as BABYLON from "@babylonjs/core";

export interface VisualPreset {
  id: string;
  /** Hex string e.g. "#150a1e". Used for scene.clearColor (sky). */
  skyColor: string;
  /** Hex string for scene.fogColor. */
  fogColor: string;
  fogStart: number;
  fogEnd: number;
  ambientColor: [number, number, number];
  directionalColor: [number, number, number];
  exposure: number;
  contrast: number;
  glowIntensity: number;
  bloomEnabled: boolean;
}

/**
 * Minimum gap between fogStart and fogEnd. Fog needs room to fade.
 */
export const MIN_FOG_GAP = 40;

/**
 * Built-in presets. Fog distances here are RELATIVE intentions; the actual
 * applied values are clamped to the render distance at runtime.
 *
 * Colors are MUTED dusty brown/mauve — never saturated purple. The frontier
 * should feel like a dusty alien desert, not a purple soup.
 */
export const VISUAL_PRESETS: Record<string, VisualPreset> = {
  red_wasteland_day: {
    id: "red_wasteland_day",
    skyColor: "#2a1a18",
    fogColor: "#6b4a3a",
    fogStart: 62,
    fogEnd: 115,
    ambientColor: [0.40, 0.34, 0.30],
    directionalColor: [1.0, 0.88, 0.72],
    exposure: 1.0,
    contrast: 1.03,
    glowIntensity: 0.10,
    bloomEnabled: false,
  },
  red_wasteland_dusk: {
    id: "red_wasteland_dusk",
    skyColor: "#2a1410",
    fogColor: "#5a3a2a",
    fogStart: 60,
    fogEnd: 112,
    ambientColor: [0.32, 0.22, 0.20],
    directionalColor: [1.0, 0.60, 0.35],
    exposure: 1.0,
    contrast: 1.05,
    glowIntensity: 0.12,
    bloomEnabled: false,
  },
  red_wasteland_night: {
    id: "red_wasteland_night",
    skyColor: "#080608",
    fogColor: "#100a0e",
    fogStart: 58,
    fogEnd: 110,
    ambientColor: [0.15, 0.14, 0.18],
    directionalColor: [0.25, 0.28, 0.42],
    exposure: 0.98,
    contrast: 1.02,
    glowIntensity: 0.15,
    bloomEnabled: false,
  },
  black_glass_day: {
    id: "black_glass_day",
    skyColor: "#0e0a0c",
    fogColor: "#1f1820",
    fogStart: 60,
    fogEnd: 112,
    ambientColor: [0.22, 0.20, 0.24],
    directionalColor: [0.72, 0.74, 0.85],
    exposure: 1.0,
    contrast: 1.04,
    glowIntensity: 0.12,
    bloomEnabled: false,
  },
  black_glass_night: {
    id: "black_glass_night",
    skyColor: "#030204",
    fogColor: "#080608",
    fogStart: 58,
    fogEnd: 108,
    ambientColor: [0.10, 0.09, 0.13],
    directionalColor: [0.16, 0.18, 0.30],
    exposure: 0.95,
    contrast: 1.03,
    glowIntensity: 0.18,
    bloomEnabled: false,
  },
};

/**
 * Clamp a preset's fog distances so they are safe AND visible relative to the
 * actual render distance.
 *
 * Pass 4 rules:
 *   - fogStart target = 0.65 × renderDistanceBlocks (far enough that near
 *     terrain is clear, close enough that chunk pop-in is hidden)
 *   - fogEnd target = 1.15 × renderDistanceBlocks (just beyond render edge)
 *   - fogStart has a minimum of 40 blocks (never fog in the player's face)
 *   - fogEnd always >= fogStart + MIN_FOG_GAP
 *   - No upper clamp on fogStart (don't push it out like the old bug)
 */
export function clampPresetToRenderDistance(
  input: VisualPreset,
  renderDistanceBlocks: number
): VisualPreset {
  const out: VisualPreset = { ...input };

  // Target fog distances relative to render distance.
  const targetStart = Math.max(40, renderDistanceBlocks * 0.65);
  const targetEnd = renderDistanceBlocks * 1.15;

  // Apply targets, but allow the preset's own values if they're sane and
  // further out (so dusk/night presets can be slightly clearer if desired).
  out.fogStart = Math.max(targetStart, Math.min(out.fogStart, renderDistanceBlocks * 0.8));
  if (out.fogStart < 40) out.fogStart = 40;

  // fogEnd: ensure at least fogStart + gap, cap at 1.15× render distance.
  const minEnd = out.fogStart + MIN_FOG_GAP;
  out.fogEnd = Math.max(minEnd, Math.min(targetEnd, out.fogEnd));
  if (out.fogEnd > targetEnd) out.fogEnd = targetEnd;

  // Final safety: fogStart must be < fogEnd.
  if (out.fogStart >= out.fogEnd) {
    out.fogStart = Math.max(40, out.fogEnd - MIN_FOG_GAP);
  }

  // Clamp image-processing to sane ranges.
  out.exposure = clamp(out.exposure, 0.5, 1.6);
  out.contrast = clamp(out.contrast, 0.8, 1.4);
  out.glowIntensity = clamp(out.glowIntensity, 0.0, 0.3);

  return out;
}

/**
 * Legacy clampPreset alias. Prefer clampPresetToRenderDistance.
 */
export function clampPreset(input: VisualPreset): VisualPreset {
  return clampPresetToRenderDistance(input, 96);
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/** Resolve a preset by id with a safe fallback to red_wasteland_day. */
export function getPreset(id: string): VisualPreset {
  return VISUAL_PRESETS[id] ?? VISUAL_PRESETS.red_wasteland_day;
}

/**
 * Pick the right base preset for a biome + day-phase.
 * `sunAltitude` is sin(angle): >0 day, <0 night, near 0 dusk/dawn.
 */
export function resolveBiomePhasePreset(
  biome: "red_wasteland" | "black_glass_canyon",
  sunAltitude: number
): VisualPreset {
  if (biome === "black_glass_canyon") {
    return sunAltitude > 0.05
      ? VISUAL_PRESETS.black_glass_day
      : VISUAL_PRESETS.black_glass_night;
  }
  if (sunAltitude > 0.15) return VISUAL_PRESETS.red_wasteland_day;
  if (sunAltitude < -0.15) return VISUAL_PRESETS.red_wasteland_night;
  return VISUAL_PRESETS.red_wasteland_dusk;
}

/** Parse a hex color string ("#rrggbb") into a Babylon Color3. */
export function parseHexColor3(
  hex: string,
  fallback: BABYLON.Color3
): BABYLON.Color3 {
  try {
    return BABYLON.Color3.FromHexString(hex);
  } catch {
    return fallback;
  }
}

/** Parse a hex color string into a Babylon Color4 (alpha = 1). */
export function parseHexColor4(
  hex: string,
  fallback: BABYLON.Color4
): BABYLON.Color4 {
  try {
    const c = BABYLON.Color3.FromHexString(hex);
    return new BABYLON.Color4(c.r, c.g, c.b, 1.0);
  } catch {
    return fallback;
  }
}
