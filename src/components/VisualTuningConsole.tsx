/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * VisualTuningConsole — the F3 debug tuning panel.
 *
 * Reads/writes window.__fpDebug().visualTuning live. Every control calls
 * __fpDebug().updateVisualTuning({ ...patch }) which merges into the adapter's
 * VisualTuning state and takes effect next frame.
 *
 * Sections:
 *   A. Presets
 *   B. Mod Sky Overlay (opt-in legacy overlay audit)
 *   C. Atmosphere / Fog
 *   D. Lighting (Day/Night) + Full Dark / Noon / Lamp Only test buttons
 *   E. Glow / Bloom / Postprocess
 *   F. Skybox / Celestial Bodies (Sky Meshes On/Off, Isolate Sky)
 *   G. Dynamic Lights (budget, nearest lights list)
 *   H. Chunks / Render Distance (diagnostics)
 *   I. Materials / Terrain Diagnostics
 *   J. Export / Import
 *
 * Each section shows requested vs actual runtime values where useful, and
 * labels settings that require a renderer restart.
 */

import { useEffect, useState, useCallback } from 'react';
import type { ReactNode } from 'react';

interface VisualTuningState {
  fogEnabled: boolean;
  fogStart: number | null;
  fogEnd: number | null;
  fogColorHex: string | null;
  fogAutoClampToRenderDistance: boolean;
  ambientIntensityMultiplier: number;
  sunIntensityMultiplier: number;
  nightAmbientIntensity: number;
  dayAmbientIntensity: number;
  noonSunIntensity: number;
  midnightSunIntensity: number;
  daySceneAmbient: number;
  nightSceneAmbient: number;
  sceneAmbientMultiplier: number;
  moonLightEnabled: boolean;
  moonLightIntensity: number;
  timeFrozen: boolean;
  timeSpeedMultiplier: number;
  dynamicLightsEnabled: boolean;
  activeLightBudget: number;
  lightIntensityMultiplier: number;
  lightRangeMultiplier: number;
  glowEnabled: boolean;
  glowIntensity: number;
  glowKernel: number;
  bloomEnabled: boolean;
  bloomWeight: number;
  bloomThreshold: number;
  bloomKernel: number;
  fxaaEnabled: boolean;
  toneMappingEnabled: boolean;
  exposure: number;
  contrast: number;
  skyMeshesEnabled: boolean;
  sunVisible: boolean;
  moonVisible: boolean;
  starsVisible: boolean;
  cloudsVisible: boolean;
  sunSize: number;
  moonSize: number;
  starBrightness: number;
  useModSkyOverlay: boolean;
  clearColorOverrideHex: string | null;
  terrainMaterialMode: 'default' | 'custom' | 'debug';
  litTerrainMaterials: boolean;
  pendingChunkAddDistance: number | null;
  pendingChunkRemoveDistance: number | null;
  fogMatchRenderDistance: boolean;
  showChunkBoundaries: boolean;
  activePresetName: string;
}

const DEFAULT_TUNING: VisualTuningState = {
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
  daySceneAmbient: 0.35,
  nightSceneAmbient: 0.06,
  sceneAmbientMultiplier: 1.0,
  moonLightEnabled: true,
  moonLightIntensity: 0.25,
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
  skyMeshesEnabled: true,
  sunVisible: true,
  moonVisible: true,
  starsVisible: true,
  cloudsVisible: false,
  sunSize: 30,
  moonSize: 40,
  starBrightness: 1.0,
  useModSkyOverlay: false,
  clearColorOverrideHex: null,
  terrainMaterialMode: 'default',
  litTerrainMaterials: true,
  pendingChunkAddDistance: null,
  pendingChunkRemoveDistance: null,
  fogMatchRenderDistance: true,
  showChunkBoundaries: false,
  activePresetName: 'Atmospheric Default',
};

const PRESET_NAMES = [
  'Safe Baseline',
  'Red Wasteland Day',
  'Red Wasteland Night',
  'Debug Fullbright',
  'Atmospheric Test',
];

function getDbg(): any {
  return (window as any).__fpDebug;
}

function updateTuning(patch: Partial<VisualTuningState>): void {
  const dbg = getDbg();
  if (dbg) {
    const snap = dbg();
    if (snap && snap.updateVisualTuning) {
      snap.updateVisualTuning(patch);
    }
  }
}

// ---- Small reusable controls ----

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  fmt,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
}) {
  return (
    <label className="flex items-center gap-2 text-[9px]">
      <span className="text-white/50 w-24 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-[#00f2ff] h-1"
      />
      <span className="text-[#00f2ff] w-12 text-right tabular-nums">
        {fmt ? fmt(value) : value.toFixed(2)}
      </span>
    </label>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[9px] cursor-pointer hover:text-white">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[#00f2ff] w-3 h-3"
      />
      <span className="text-white/70">{label}</span>
    </label>
  );
}

function ColorInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[9px]">
      <span className="text-white/50 w-24 shrink-0">{label}</span>
      <input
        type="color"
        value={value || '#6b4a3a'}
        onChange={(e) => onChange(e.target.value)}
        className="w-8 h-5 rounded border border-white/20 bg-transparent cursor-pointer"
      />
      <span className="text-[#00f2ff] text-[8px]">{value || 'auto'}</span>
      <button
        onClick={() => onChange(null)}
        className="text-[8px] text-white/40 hover:text-white underline"
      >
        auto
      </button>
    </label>
  );
}

function Button({
  label,
  onClick,
  variant = 'normal',
}: {
  label: string;
  onClick: () => void;
  variant?: 'normal' | 'primary' | 'danger';
}) {
  const cls =
    variant === 'primary'
      ? 'bg-[#00f2ff]/20 hover:bg-[#00f2ff]/30 border-[#00f2ff]/40 text-[#00f2ff]'
      : variant === 'danger'
      ? 'bg-red-900/30 hover:bg-red-900/50 border-red-500/40 text-red-300'
      : 'bg-white/5 hover:bg-white/10 border-white/15 text-white/70';
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 rounded text-[8px] font-bold tracking-wider uppercase border ${cls} cursor-pointer transition-colors`}
    >
      {label}
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-white/10 pt-2">
      <div className="text-[#00f2ff] font-bold tracking-widest uppercase text-[9px] mb-1.5">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div className="flex justify-between gap-2 text-[8px]">
      <span className="text-white/40">{label}</span>
      <span className={accent ? 'text-[#00f2ff] tabular-nums' : 'text-white/70 tabular-nums'}>{value}</span>
    </div>
  );
}

// ---- Main console ----

export default function VisualTuningConsole() {
  const [tuning, setTuning] = useState<VisualTuningState>(DEFAULT_TUNING);
  const [live, setLive] = useState<any>(null);

  // Poll live tuning + stats at 4Hz
  useEffect(() => {
    const id = window.setInterval(() => {
      const dbg = getDbg();
      if (dbg) {
        const snap = dbg();
        if (snap) {
          if (snap.visualTuning) setTuning(snap.visualTuning);
          setLive(snap);
        }
      }
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  const patch = useCallback((p: Partial<VisualTuningState>) => {
    updateTuning(p);
    setTuning((prev) => ({ ...prev, ...p }));
  }, []);

  const applyPreset = (name: string) => {
    const dbg = getDbg();
    if (dbg) {
      const snap = dbg();
      if (snap && snap.applyNamedPreset) {
        snap.applyNamedPreset(name);
      }
    }
  };

  const call = (fn: string, ...args: any[]) => {
    const dbg = getDbg();
    if (dbg) {
      const snap = dbg();
      if (snap && typeof snap[fn] === 'function') snap[fn](...args);
    }
  };

  const fogStartVal = tuning.fogStart ?? (live?.fog?.fogStart ?? 62);
  const fogEndVal = tuning.fogEnd ?? (live?.fog?.fogEnd ?? 110);
  const rdb = live?.renderDistanceBlocks ?? 96;
  const sky = live?.sky;
  const lighting = live?.lighting;
  const lights = live?.lights;
  const chunks = live?.chunks;
  const modSky = live?.modSky;
  const skyCtrl = live?.skyController;

  return (
    <div className="space-y-2 text-[9px] leading-relaxed w-72 max-h-[80vh] overflow-y-auto pr-1">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 pb-2">
        <span className="text-[#00f2ff] font-black tracking-widest uppercase text-[10px]">
          Tuning Console
        </span>
        <span className="text-white/40 text-[8px]">F3 to close</span>
      </div>

      {/* Live stats bar */}
      <div className="bg-black/40 rounded p-1.5 text-[8px] text-white/60 font-mono space-y-0.5">
        <div>FPS: <span className="text-[#00f2ff]">{live?.fps ?? '?'}</span> | TOD: {live?.timeOfDay?.toFixed(3)} | {lighting?.phase ?? '?'}</div>
        <div>Chunks: {live?.terrain?.meshCount ?? '?'} | {chunks?.chunksPerSec ?? 0}/s | Lights: {lights?.active ?? '?'}/{lights?.registered ?? '?'}</div>
        <div>skyColor: <span className="text-[#00f2ff]">{modSky?.activeSkyColorHex}</span> ← {modSky?.skyColorSource}</div>
        <div>fogColor: <span className="text-[#00f2ff]">{modSky?.activeFogColorHex}</span> ← {modSky?.fogColorSource}</div>
        <div>Mod overlay: <span className={modSky?.overlayActive ? 'text-amber-400' : 'text-white/50'}>{modSky?.overlayActive ? 'ON' : 'OFF'}</span>{modSky?.registered ? ' (registered)' : ''}</div>
      </div>

      {/* A. Presets */}
      <Section title="Presets">
        <div className="flex flex-wrap gap-1">
          {PRESET_NAMES.map((name) => (
            <Button
              key={name}
              label={name}
              onClick={() => applyPreset(name)}
              variant={tuning.activePresetName === name ? 'primary' : 'normal'}
            />
          ))}
        </div>
        <div className="flex gap-1 mt-1">
          <Button label="Reset Default" onClick={() => call('resetToAtmosphericDefault')} />
          <Button label="Save" onClick={() => call('saveVisualSettings')} variant="primary" />
          <Button label="Load" onClick={() => call('loadVisualSettings')} />
        </div>
        <Stat label="Current preset" value={tuning.activePresetName} accent />
      </Section>

      {/* B. Mod Sky Overlay */}
      <Section title="Mod Sky Overlay (Audit)">
        <Checkbox
          label="Use mod sky overlay (legacy purple)"
          checked={tuning.useModSkyOverlay}
          onChange={(v) => patch({ useModSkyOverlay: v })}
        />
        <div className="text-white/40 text-[8px]">
          Default OFF. When ON, the old example-ruins-pack/sky/sky.json values apply and are labeled as the source.
        </div>
        <Stat label="Registered" value={modSky?.registered ? 'yes' : 'no'} />
        <Stat label="Enabled" value={modSky?.enabled ? 'yes' : 'no'} />
        {modSky?.registered && (
          <div className="text-white/40 text-[8px] break-all">
            sources: {JSON.stringify(modSky?.sources)}
          </div>
        )}
        <div className="flex gap-1">
          <Button label="Overlay Off" onClick={() => call('setModSkyOverlay', false)} />
          <Button label="Overlay On" onClick={() => call('setModSkyOverlay', true)} variant="danger" />
        </div>
        <ColorInput
          label="clearColor override"
          value={tuning.clearColorOverrideHex}
          onChange={(v) => patch({ clearColorOverrideHex: v })}
        />
        <div className="text-white/40 text-[8px]">Overrides scene.clearColor directly (separate from sky meshes).</div>
      </Section>

      {/* C. Atmosphere / Fog */}
      <Section title="Atmosphere / Fog">
        <Checkbox label="Fog enabled" checked={tuning.fogEnabled} onChange={(v) => patch({ fogEnabled: v })} />
        <Checkbox label="Auto-clamp to render distance" checked={tuning.fogAutoClampToRenderDistance} onChange={(v) => patch({ fogAutoClampToRenderDistance: v })} />
        <Slider label="fogStart" value={fogStartVal} min={10} max={200} step={1} onChange={(v) => patch({ fogStart: v })} fmt={(v) => v.toFixed(0)} />
        <Slider label="fogEnd" value={fogEndVal} min={20} max={300} step={1} onChange={(v) => patch({ fogEnd: v })} fmt={(v) => v.toFixed(0)} />
        <ColorInput label="fogColor" value={tuning.fogColorHex} onChange={(v) => patch({ fogColorHex: v })} />
        <Stat label="Live start/end" value={`${live?.fog?.fogStart?.toFixed(0) ?? '?'}/${live?.fog?.fogEnd?.toFixed(0) ?? '?'}`} />
        <Stat label="Live fogColor" value={live?.fog?.fogColor ?? '?'} accent />
        <div className="flex gap-1">
          <Button label="Fog Off" onClick={() => patch({ fogEnabled: false })} />
          <Button label="Fog On" onClick={() => patch({ fogEnabled: true })} variant="primary" />
        </div>
      </Section>

      {/* D. Lighting (Day/Night) */}
      <Section title="Lighting (Day/Night)">
        <Slider label="Scene amb day" value={tuning.daySceneAmbient} min={0} max={1} step={0.02} onChange={(v) => patch({ daySceneAmbient: v })} />
        <Slider label="Scene amb night" value={tuning.nightSceneAmbient} min={0} max={0.5} step={0.01} onChange={(v) => patch({ nightSceneAmbient: v })} />
        <Slider label="Scene amb mult" value={tuning.sceneAmbientMultiplier} min={0} max={3} step={0.05} onChange={(v) => patch({ sceneAmbientMultiplier: v })} />
        <Slider label="Hemi mult" value={tuning.ambientIntensityMultiplier} min={0} max={3} step={0.05} onChange={(v) => patch({ ambientIntensityMultiplier: v })} />
        <Slider label="Sun mult" value={tuning.sunIntensityMultiplier} min={0} max={3} step={0.05} onChange={(v) => patch({ sunIntensityMultiplier: v })} />
        <Slider label="Day ambient" value={tuning.dayAmbientIntensity} min={0} max={1.5} step={0.05} onChange={(v) => patch({ dayAmbientIntensity: v })} />
        <Slider label="Night ambient" value={tuning.nightAmbientIntensity} min={0} max={1} step={0.02} onChange={(v) => patch({ nightAmbientIntensity: v })} />
        <Slider label="Noon sun" value={tuning.noonSunIntensity} min={0} max={3} step={0.05} onChange={(v) => patch({ noonSunIntensity: v })} />
        <Slider label="Midnight sun" value={tuning.midnightSunIntensity} min={0} max={1} step={0.02} onChange={(v) => patch({ midnightSunIntensity: v })} />
        <div className="border-t border-white/10 pt-1 mt-1">
          <Checkbox label="Moon light enabled" checked={tuning.moonLightEnabled} onChange={(v) => patch({ moonLightEnabled: v })} />
          <Slider label="Moon intensity" value={tuning.moonLightIntensity} min={0} max={1} step={0.02} onChange={(v) => patch({ moonLightIntensity: v })} />
        </div>
        <div className="border-t border-white/10 pt-1 mt-1">
          <Slider label="Time speed" value={tuning.timeSpeedMultiplier} min={0} max={20} step={0.5} onChange={(v) => patch({ timeSpeedMultiplier: v })} fmt={(v) => v.toFixed(1) + '×'} />
          <Checkbox label="Freeze time" checked={tuning.timeFrozen} onChange={(v) => patch({ timeFrozen: v })} />
        </div>
        <div className="flex gap-1 mt-1 flex-wrap">
          <Button label="Dawn" onClick={() => call('setTimeOfDay', 0.0)} />
          <Button label="Noon" onClick={() => call('setTimeOfDay', 0.25)} variant="primary" />
          <Button label="Dusk" onClick={() => call('setTimeOfDay', 0.5)} />
          <Button label="Midnight" onClick={() => call('setTimeOfDay', 0.75)} />
        </div>
        {/* Lighting readbacks (actual runtime values) */}
        <div className="bg-black/40 rounded p-1.5 mt-1 space-y-0.5">
          <div className="text-[#00f2ff] font-bold text-[8px] uppercase tracking-wider">Actual Runtime</div>
          <Stat label="scene.ambientColor" value={lighting?.sceneAmbientColor ? `[${lighting.sceneAmbientColor.map((c: number) => c.toFixed(3)).join(',')}]` : '?'} accent />
          <Stat label="hemi intensity" value={lighting?.hemisphericIntensity?.toFixed(3)} accent />
          <Stat label="sun intensity" value={lighting?.sunIntensity?.toFixed(3)} accent />
          <Stat label="sun diffuse" value={lighting?.sunDiffuse ? `[${lighting.sunDiffuse.map((c: number) => c.toFixed(2)).join(',')}]` : '?'} />
          <Stat label="moon intensity" value={lighting?.moonIntensity?.toFixed(3)} accent />
          <Stat label="phase" value={lighting?.phase} />
        </div>
        {/* Test buttons */}
        <div className="border-t border-white/10 pt-1 mt-1">
          <div className="text-white/50 text-[8px] mb-1">Lighting tests:</div>
          <div className="flex gap-1 flex-wrap">
            <Button label="Full Dark" onClick={() => call('fullDarkTest')} variant="danger" />
            <Button label="Noon Light" onClick={() => call('noonLightingTest')} variant="primary" />
            <Button label="Lamp Only" onClick={() => call('lampOnlyTest')} variant="danger" />
            <Button label="Clear Tests" onClick={() => call('clearLightingTests')} />
          </div>
          <div className="text-white/40 text-[8px] mt-0.5">
            Full Dark: terrain must go dark. Lamp Only: place lamps to see colored light on terrain.
          </div>
        </div>
      </Section>

      {/* E. Glow / Bloom */}
      <Section title="Glow / Bloom / Postprocess">
        <Checkbox label="Glow enabled" checked={tuning.glowEnabled} onChange={(v) => patch({ glowEnabled: v })} />
        <Slider label="Glow intensity" value={tuning.glowIntensity} min={0} max={1} step={0.02} onChange={(v) => patch({ glowIntensity: v })} />
        <Slider label="Glow kernel" value={tuning.glowKernel} min={8} max={64} step={2} onChange={(v) => patch({ glowKernel: v })} fmt={(v) => v.toFixed(0)} />
        <Checkbox label="Bloom enabled" checked={tuning.bloomEnabled} onChange={(v) => patch({ bloomEnabled: v })} />
        <Slider label="Bloom weight" value={tuning.bloomWeight} min={0} max={1} step={0.02} onChange={(v) => patch({ bloomWeight: v })} />
        <Slider label="Bloom threshold" value={tuning.bloomThreshold} min={0} max={1} step={0.02} onChange={(v) => patch({ bloomThreshold: v })} />
        <Slider label="Exposure" value={tuning.exposure} min={0.5} max={1.6} step={0.02} onChange={(v) => patch({ exposure: v })} />
        <Slider label="Contrast" value={tuning.contrast} min={0.8} max={1.4} step={0.02} onChange={(v) => patch({ contrast: v })} />
      </Section>

      {/* F. Skybox / Celestial */}
      <Section title="Skybox / Celestial">
        <Checkbox label="Sky meshes ON (master)" checked={tuning.skyMeshesEnabled} onChange={(v) => { patch({ skyMeshesEnabled: v }); call('setSkyVisible', v); }} />
        <Checkbox label="Sun visible" checked={tuning.sunVisible} onChange={(v) => patch({ sunVisible: v })} />
        <Checkbox label="Moon visible" checked={tuning.moonVisible} onChange={(v) => patch({ moonVisible: v })} />
        <Checkbox label="Stars visible" checked={tuning.starsVisible} onChange={(v) => patch({ starsVisible: v })} />
        <Checkbox label="Clouds visible" checked={tuning.cloudsVisible} onChange={(v) => patch({ cloudsVisible: v })} />
        <Slider label="Star brightness" value={tuning.starBrightness} min={0} max={2} step={0.05} onChange={(v) => patch({ starBrightness: v })} />
        <div className="flex gap-1 mt-1 flex-wrap">
          <Button label="Sky Off" onClick={() => { call('setSkyVisible', false); patch({ skyMeshesEnabled: false }); }} />
          <Button label="Sky On" onClick={() => { call('setSkyVisible', true); patch({ skyMeshesEnabled: true }); }} variant="primary" />
          <Button label="Isolate Sky" onClick={() => call('isolateSky', true)} variant="danger" />
          <Button label="Restore Scene" onClick={() => call('isolateSky', false)} />
        </div>
        {/* Sky readbacks */}
        <div className="bg-black/40 rounded p-1.5 mt-1 space-y-0.5">
          <div className="text-[#00f2ff] font-bold text-[8px] uppercase tracking-wider">Celestial State</div>
          <Stat label="meshesEnabled" value={String(sky?.meshesEnabled ?? skyCtrl?.meshesEnabled)} accent />
          <Stat label="sun enabled/visible" value={`${sky?.sun?.enabled ?? '?'}/${sky?.sun?.isVisible ?? '?'}`} accent />
          <Stat label="sun screen" value={sky?.sun?.screenPosition ? `${sky.sun.screenPosition.x},${sky.sun.screenPosition.y} ${sky.sun.screenPosition.onScreen ? '(on-screen)' : '(off-screen)'}` : '?'} />
          <Stat label="moon enabled/visible" value={`${sky?.moon?.enabled ?? '?'}/${sky?.moon?.isVisible ?? '?'}`} accent />
          <Stat label="moon screen" value={sky?.moon?.screenPosition ? `${sky.moon.screenPosition.x},${sky.moon.screenPosition.y} ${sky.moon.screenPosition.onScreen ? '(on-screen)' : '(off-screen)'}` : '?'} />
          <Stat label="stars visible/count" value={`${sky?.stars?.visibleCount ?? '?'}/${sky?.stars?.count ?? '?'}`} accent />
          <Stat label="skyRoot pos" value={sky?.skyRoot?.position ? `[${sky.skyRoot.position.map((c: number) => c.toFixed(0)).join(',')}]` : '?'} />
          <Stat label="cam dir" value={sky?.camera?.direction ? `[${sky.camera.direction.map((c: number) => c.toFixed(2)).join(',')}]` : '?'} />
        </div>
      </Section>

      {/* G. Dynamic Lights */}
      <Section title="Dynamic Lights">
        <Checkbox label="Dynamic lights enabled" checked={tuning.dynamicLightsEnabled} onChange={(v) => patch({ dynamicLightsEnabled: v })} />
        <Slider label="Active budget" value={tuning.activeLightBudget} min={1} max={12} step={1} onChange={(v) => patch({ activeLightBudget: v })} fmt={(v) => v.toFixed(0)} />
        <Slider label="Intensity mult" value={tuning.lightIntensityMultiplier} min={0} max={3} step={0.1} onChange={(v) => patch({ lightIntensityMultiplier: v })} />
        <Slider label="Range mult" value={tuning.lightRangeMultiplier} min={0.1} max={3} step={0.1} onChange={(v) => patch({ lightRangeMultiplier: v })} />
        <Stat label="registered / active" value={`${lights?.registered ?? '?'}/${lights?.active ?? '?'}`} accent />
        <Stat label="budget" value={lights?.activeBudget ?? '?'} />
        <Stat label="terrain maxLights" value={lights?.terrainMaterialMaxSimultaneousLights ?? '?'} accent />
        <Stat label="terrain disableLighting" value={String(lights?.terrainMaterialDisableLighting ?? '?')} accent />
        <Stat label="terrain emissive=0" value={String(lights?.terrainMaterialEmissiveZero ?? '?')} accent />
        <Stat label="budget limiting nearest" value={String(lights?.budgetLimitingNearest ?? '?')} />
        {/* Nearest lights list */}
        <div className="bg-black/40 rounded p-1.5 mt-1 max-h-40 overflow-y-auto">
          <div className="text-[#00f2ff] font-bold text-[8px] uppercase tracking-wider mb-1">Nearest lights</div>
          {lights?.nearest && lights.nearest.length > 0 ? (
            <div className="space-y-1">
              {lights.nearest.map((l: any) => (
                <div key={l.key} className="text-[7px] text-white/60 leading-tight">
                  <div className="flex justify-between">
                    <span className="text-white/80">{l.blockName}</span>
                    <span className={l.active ? 'text-[#00f2ff]' : 'text-red-400'}>{l.active ? 'ACTIVE' : 'culled'}</span>
                  </div>
                  <div>dist {l.distance.toFixed(1)} | range {l.range} | int {l.intensity.toFixed(1)} | pri {l.priority}</div>
                  <div className="flex items-center gap-1">
                    <span>color</span>
                    <span className="inline-block w-3 h-3 rounded-sm border border-white/20" style={{ background: `rgb(${Math.round(l.color[0]*255)},${Math.round(l.color[1]*255)},${Math.round(l.color[2]*255)})` }} />
                    <span>[{l.color.map((c: number) => c.toFixed(2)).join(',')}]</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-white/40 text-[7px]">No registered lights. Place a lamp (LMB/RMB) or visit the outpost.</div>
          )}
        </div>
      </Section>

      {/* H. Chunks / Render Distance */}
      <Section title="Chunks / Render Distance">
        <div className="text-white/60 text-[8px] space-y-0.5">
          <Stat label="chunkAddDistance" value={chunks?.chunkAddDistance ?? live?.chunkAddDistance ?? '?'} />
          <Stat label="chunkRemoveDistance" value={chunks?.chunkRemoveDistance ?? live?.chunkRemoveDistance ?? '?'} />
          <Stat label="blockDataNeededInterval" value={chunks?.blockDataNeededEmitInterval ?? '?'} />
          <Stat label="renderDistanceBlocks" value={rdb} accent />
          <Stat label="loaded chunks" value={chunks?.loadedChunkCount ?? live?.terrain?.meshCount ?? '?'} accent />
          <Stat label="total generated" value={chunks?.totalGenerated ?? '?'} />
          <Stat label="avg gen ms" value={chunks?.avgGenMs ?? '?'} accent />
          <Stat label="max gen ms" value={chunks?.maxGenMs ?? '?'} />
          <Stat label="chunks/sec" value={chunks?.chunksPerSec ?? '?'} accent />
          <Stat label="FPS" value={live?.fps ?? chunks?.fps ?? '?'} accent />
        </div>
        <Checkbox label="Fog match render distance" checked={tuning.fogMatchRenderDistance} onChange={(v) => patch({ fogMatchRenderDistance: v })} />
        <Checkbox label="Show chunk boundaries" checked={tuning.showChunkBoundaries} onChange={(v) => patch({ showChunkBoundaries: v })} />
        <div className="text-amber-400/70 text-[8px] mt-1">
          ⚠ Changing chunk distances requires renderer restart (not live-tunable in noa-engine v0.33).
        </div>
        <div className="flex gap-1 mt-1">
          <Button label="Apply (best-effort)" onClick={() => call('applyChunkDistances', tuning.pendingChunkAddDistance ?? chunks?.chunkAddDistance ?? 8, tuning.pendingChunkRemoveDistance ?? chunks?.chunkRemoveDistance ?? 10)} />
        </div>
      </Section>

      {/* I. Materials / Terrain Diagnostics */}
      <Section title="Materials / Terrain">
        <Checkbox label="Lit terrain materials (requires restart)" checked={tuning.litTerrainMaterials} onChange={(v) => patch({ litTerrainMaterials: v })} />
        <div className="text-white/40 text-[8px]">When ON, all opaque blocks use lit StandardMaterials (day/night + dynamic lights work). OFF = noa flat-color.</div>
        <div className="flex gap-1 mt-1">
          {(['default', 'custom', 'debug'] as const).map((mode) => (
            <Button
              key={mode}
              label={mode}
              onClick={() => patch({ terrainMaterialMode: mode })}
              variant={tuning.terrainMaterialMode === mode ? 'primary' : 'normal'}
            />
          ))}
        </div>
        <div className="text-white/60 text-[8px] mt-1 space-y-0.5">
          <Stat label="first mat" value={live?.terrain?.sample?.[0]?.matName} />
          <Stat label="mat ambient" value={live?.terrain?.sample?.[0]?.matAmbient ? `[${live.terrain.sample[0].matAmbient.join(',')}]` : '?'} />
          <Stat label="mat maxLights" value={live?.terrain?.sample?.[0]?.matMaxLights} accent />
          <Stat label="mat fogEnabled" value={String(live?.terrain?.sample?.[0]?.matFogEnabled)} />
          <Stat label="visible/enabled" value={`${live?.terrain?.visibleCount}/${live?.terrain?.meshCount}`} />
        </div>
        <div className="flex gap-1 mt-1">
          <Button label="Force Debug Mat" onClick={() => call('forceTerrainDebugMaterial', true)} variant="danger" />
          <Button label="Restore Mat" onClick={() => call('forceTerrainDebugMaterial', false)} />
        </div>
      </Section>

      {/* J. Export / Import */}
      <Section title="Export / Import">
        <div className="flex gap-1">
          <Button
            label="Export JSON"
            onClick={() => {
              const dbg = getDbg();
              if (dbg) {
                const s = dbg();
                if (s) {
                  const json = s.exportVisualSettings();
                  try { navigator.clipboard?.writeText(json); } catch { /* ignore */ }
                  console.log('[VisualTuning] Exported:', json);
                }
              }
            }}
          />
          <Button
            label="Log to Console"
            onClick={() => {
              const dbg = getDbg();
              if (dbg) { const s = dbg(); if (s) console.log(s.exportVisualSettings()); }
            }}
          />
        </div>
        <div className="text-white/40 text-[8px]">Settings persist to localStorage: frontierPlanet.visualSettings</div>
      </Section>
    </div>
  );
}
