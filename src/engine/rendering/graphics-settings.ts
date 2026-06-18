/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * GraphicsSettings — quality presets for the Babylon rendering layer.
 *
 * PASS 4 "Purple Dimension" FIX — drastically reduced glow, bloom, and dynamic
 * light budgets. The previous settings (glow 0.35-0.8, bloom enabled, 8-24
 * dynamic lights, maxSimultaneousLights up to 28) created a washed-out purple
 * veil with giant blurry light blobs. Terrain was unreadable.
 *
 * New conservative defaults:
 *   - glowIntensity: 0.10 / 0.15 / 0.20 (was 0.35 / 0.6 / 0.8)
 *   - bloomEnabled: false on ALL qualities (was true on medium/high)
 *   - maxActiveDynamicLights: 4 / 6 / 8 (was 8 / 16 / 24)
 *   - maxSimultaneousLights cap: 8 (was unbounded, hit 28)
 *   - clouds disabled by default (was 6 / 12 / 18)
 *   - star count reduced (was 40 / 80 / 140)
 */

export type GraphicsQuality = "low" | "medium" | "high";

export interface GraphicsSettings {
  quality: GraphicsQuality;
  /** Max simultaneously-active Babylon dynamic lights (point/spot). */
  maxActiveDynamicLights: number;
  /** GlowLayer intensity. Subtle — never blow out the screen. */
  glowIntensity: number;
  /** Whether bloom is enabled at all. Disabled by default (Pass 4). */
  bloomEnabled: boolean;
  /** Bloom kernel (blur spread). Higher = wider, softer glow. */
  bloomKernel: number;
  /** Bloom weight (strength of the bloom layer). */
  bloomWeight: number;
  /** Bloom threshold (luminance above which pixels bloom). */
  bloomThreshold: number;
  /** Image-processing exposure. 1.0 = neutral. */
  exposure: number;
  /** Image-processing contrast. 1.0 = neutral. */
  contrast: number;
  /** Tone mapping enabled. */
  toneMappingEnabled: boolean;
  /** Star field count for night sky. */
  starCount: number;
  /** Drifting cloud count. Disabled by default (Pass 4). */
  cloudCount: number;
  /** Whether FXAA anti-aliasing is enabled (cheap, safe). */
  fxaaEnabled: boolean;
  /** Glow blur kernel size. Smaller = tighter glow, less smear. */
  glowKernel: number;
  /** Hard cap on material.maxSimultaneousLights. Never exceed 8 in Pass 4. */
  maxSimultaneousLightsCap: number;
}

const PRESETS: Record<GraphicsQuality, Omit<GraphicsSettings, "quality">> = {
  low: {
    maxActiveDynamicLights: 4,
    glowIntensity: 0.10,
    bloomEnabled: false,
    bloomKernel: 16,
    bloomWeight: 0.2,
    bloomThreshold: 0.95,
    exposure: 1.0,
    contrast: 1.0,
    toneMappingEnabled: false,
    starCount: 30,
    cloudCount: 0,
    fxaaEnabled: true,
    glowKernel: 16,
    maxSimultaneousLightsCap: 6,
  },
  medium: {
    maxActiveDynamicLights: 6,
    glowIntensity: 0.15,
    bloomEnabled: false,
    bloomKernel: 24,
    bloomWeight: 0.25,
    bloomThreshold: 0.9,
    exposure: 1.0,
    contrast: 1.02,
    toneMappingEnabled: true,
    starCount: 50,
    cloudCount: 0,
    fxaaEnabled: true,
    glowKernel: 20,
    maxSimultaneousLightsCap: 8,
  },
  high: {
    maxActiveDynamicLights: 8,
    glowIntensity: 0.20,
    bloomEnabled: false,
    bloomKernel: 32,
    bloomWeight: 0.3,
    bloomThreshold: 0.85,
    exposure: 1.02,
    contrast: 1.04,
    toneMappingEnabled: true,
    starCount: 80,
    cloudCount: 0,
    fxaaEnabled: true,
    glowKernel: 24,
    maxSimultaneousLightsCap: 8,
  },
};

/**
 * Resolve a GraphicsSettings from a quality name.
 * Falls back to "medium" for unknown input.
 */
export function getGraphicsSettings(quality: GraphicsQuality): GraphicsSettings {
  const base = PRESETS[quality] ?? PRESETS.medium;
  return { quality, ...base };
}

/**
 * Detect a sensible default quality. We do not trust navigator.hardwareConcurrency
 * blindly; we just use it as a hint and clamp to "medium" by default so the
 * first-run experience is always playable.
 */
export function detectDefaultQuality(): GraphicsQuality {
  try {
    const cores = (navigator as any).hardwareConcurrency as number | undefined;
    if (typeof cores === "number") {
      if (cores <= 4) return "low";
      if (cores <= 6) return "medium";
      return "high";
    }
  } catch {
    /* ignore — sandboxed navigator */
  }
  return "medium";
}
