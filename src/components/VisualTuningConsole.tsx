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
 *   A. Atmosphere / Fog
 *   B. Lighting (day/night)
 *   C. Glow / Bloom / Postprocess
 *   D. Skybox / Celestial Bodies
 *   E. Chunks / Render Distance
 *   F. Materials / Terrain Diagnostics
 *   G. Presets
 */

import { useEffect, useState, useCallback } from 'react';

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
  skyVisible: boolean;
  sunVisible: boolean;
  moonVisible: boolean;
  starsVisible: boolean;
  cloudsVisible: boolean;
  sunSize: number;
  moonSize: number;
  starBrightness: number;
  terrainMaterialMode: 'default' | 'custom' | 'debug';
  pendingChunkAddDistance: number | null;
  pendingChunkRemoveDistance: number | null;
  fogMatchRenderDistance: boolean;
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
  terrainMaterialMode: 'default',
  pendingChunkAddDistance: null,
  pendingChunkRemoveDistance: null,
  fogMatchRenderDistance: true,
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

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-white/10 pt-2">
      <div className="text-[#00f2ff] font-bold tracking-widest uppercase text-[9px] mb-1.5">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

// ---- Main console ----

export default function VisualTuningConsole() {
  const [tuning, setTuning] = useState<VisualTuningState>(DEFAULT_TUNING);
  const [liveStats, setLiveStats] = useState<any>(null);
  const [presetName, setPresetName] = useState('Atmospheric Default');

  // Poll live tuning + stats at 4Hz
  useEffect(() => {
    const id = window.setInterval(() => {
      const dbg = getDbg();
      if (dbg) {
        const snap = dbg();
        if (snap) {
          if (snap.visualTuning) setTuning(snap.visualTuning);
          setLiveStats(snap);
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
        setPresetName(name);
      }
    }
  };

  const fogStartVal = tuning.fogStart ?? (liveStats?.fog?.fogStart ?? 62);
  const fogEndVal = tuning.fogEnd ?? (liveStats?.fog?.fogEnd ?? 110);
  const rdb = liveStats?.renderDistanceBlocks ?? 96;

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
      <div className="bg-black/40 rounded p-1.5 text-[8px] text-white/60 font-mono">
        <div>TOD: {liveStats?.timeOfDay?.toFixed(3)} | RDB: {rdb}b | Q: {liveStats?.quality}</div>
        <div>Chunks: {liveStats?.terrain?.meshCount ?? '?'} | Lights: {liveStats?.worldLightManager?.active ?? '?'}/{liveStats?.worldLightManager?.registered ?? '?'}</div>
      </div>

      {/* G. Presets */}
      <Section title="Presets">
        <div className="flex flex-wrap gap-1">
          {PRESET_NAMES.map((name) => (
            <Button
              key={name}
              label={name}
              onClick={() => applyPreset(name)}
              variant={presetName === name ? 'primary' : 'normal'}
            />
          ))}
        </div>
        <div className="flex gap-1 mt-1">
          <Button label="Reset Default" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s) s.resetToAtmosphericDefault(); } }} />
          <Button label="Save" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s) s.saveVisualSettings(); } }} variant="primary" />
          <Button label="Load" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s) s.loadVisualSettings(); } }} />
        </div>
        <div className="text-white/40 text-[8px] mt-0.5">
          Current: <span className="text-[#00f2ff]">{tuning.activePresetName}</span>
        </div>
      </Section>

      {/* A. Atmosphere / Fog */}
      <Section title="Atmosphere / Fog">
        <Checkbox
          label="Fog enabled"
          checked={tuning.fogEnabled}
          onChange={(v) => patch({ fogEnabled: v })}
        />
        <Checkbox
          label="Auto-clamp to render distance"
          checked={tuning.fogAutoClampToRenderDistance}
          onChange={(v) => patch({ fogAutoClampToRenderDistance: v })}
        />
        <Slider
          label="fogStart"
          value={fogStartVal}
          min={10}
          max={200}
          step={1}
          onChange={(v) => patch({ fogStart: v })}
          fmt={(v) => v.toFixed(0)}
        />
        <Slider
          label="fogEnd"
          value={fogEndVal}
          min={20}
          max={300}
          step={1}
          onChange={(v) => patch({ fogEnd: v })}
          fmt={(v) => v.toFixed(0)}
        />
        <ColorInput
          label="fogColor"
          value={tuning.fogColorHex}
          onChange={(v) => patch({ fogColorHex: v })}
        />
        <div className="text-white/40 text-[8px]">
          Live: start={liveStats?.fog?.fogStart?.toFixed(0)} end={liveStats?.fog?.fogEnd?.toFixed(0)} color={liveStats?.fog?.fogColor}
        </div>
        <div className="flex gap-1">
          <Button label="Fog Off" onClick={() => patch({ fogEnabled: false })} />
          <Button label="Fog On" onClick={() => patch({ fogEnabled: true })} variant="primary" />
        </div>
      </Section>

      {/* B. Lighting */}
      <Section title="Lighting (Day/Night)">
        <Slider
          label="Ambient mult"
          value={tuning.ambientIntensityMultiplier}
          min={0}
          max={3}
          step={0.05}
          onChange={(v) => patch({ ambientIntensityMultiplier: v })}
        />
        <Slider
          label="Sun mult"
          value={tuning.sunIntensityMultiplier}
          min={0}
          max={3}
          step={0.05}
          onChange={(v) => patch({ sunIntensityMultiplier: v })}
        />
        <Slider
          label="Day ambient"
          value={tuning.dayAmbientIntensity}
          min={0}
          max={1.5}
          step={0.05}
          onChange={(v) => patch({ dayAmbientIntensity: v })}
        />
        <Slider
          label="Night ambient"
          value={tuning.nightAmbientIntensity}
          min={0}
          max={1}
          step={0.02}
          onChange={(v) => patch({ nightAmbientIntensity: v })}
        />
        <Slider
          label="Noon sun"
          value={tuning.noonSunIntensity}
          min={0}
          max={3}
          step={0.05}
          onChange={(v) => patch({ noonSunIntensity: v })}
        />
        <Slider
          label="Midnight sun"
          value={tuning.midnightSunIntensity}
          min={0}
          max={1}
          step={0.02}
          onChange={(v) => patch({ midnightSunIntensity: v })}
        />
        <div className="border-t border-white/10 pt-1 mt-1">
          <Slider
            label="Time speed"
            value={tuning.timeSpeedMultiplier}
            min={0}
            max={20}
            step={0.5}
            onChange={(v) => patch({ timeSpeedMultiplier: v })}
            fmt={(v) => v.toFixed(1) + '×'}
          />
          <Checkbox
            label="Freeze time"
            checked={tuning.timeFrozen}
            onChange={(v) => patch({ timeFrozen: v })}
          />
        </div>
        <div className="flex gap-1 mt-1">
          <Button label="Dawn" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s) s.setTimeOfDay(0.0); } }} />
          <Button label="Noon" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s) s.setTimeOfDay(0.25); } }} />
          <Button label="Dusk" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s) s.setTimeOfDay(0.5); } }} />
          <Button label="Midnight" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s) s.setTimeOfDay(0.75); } }} />
        </div>
      </Section>

      {/* Voxel Lighting Architecture (performance-first Minecraft-style) */}
      <Section title="Voxel Lighting (Performance Architecture)">
        <div className="text-white/50 text-[8px] mb-1">
          Minecraft-style per-cell light baked into chunk vertex colors. NO real PointLights per glowing block. Real lights are debug-only (cap 3).
        </div>
        <div className="bg-black/40 rounded p-1.5 text-[8px] text-white/60 space-y-0.5">
          <div className="text-[#00f2ff] font-bold uppercase tracking-wider">Lighting Architecture</div>
          <div className="flex justify-between"><span className="text-white/40">lightingMode</span><span className="text-[#00f2ff]">{liveStats?.voxelLighting?.lightingMode ?? '?'}</span></div>
          <div className="flex justify-between"><span className="text-white/40">realPointLights</span><span className="text-[#00f2ff]">{liveStats?.voxelLighting?.realPointLightsActive ?? '?'}/{liveStats?.voxelLighting?.realPointLightCap ?? 3}</span></div>
          <div className="flex justify-between"><span className="text-white/40">chunksWithLight</span><span className="text-white/70">{liveStats?.voxelLighting?.chunksWithLightData ?? '?'}</span></div>
          <div className="flex justify-between"><span className="text-white/40">relightQueue</span><span className="text-white/70">{liveStats?.voxelLighting?.relightQueueSize ?? '?'}</span></div>
          <div className="flex justify-between"><span className="text-white/40">floodFillOps</span><span className="text-white/70">{liveStats?.voxelLighting?.floodFillOpsLastUpdate ?? '?'}</span></div>
          <div className="flex justify-between"><span className="text-white/40">lastUpdateMs</span><span className="text-white/70">{liveStats?.voxelLighting?.lastLightUpdateMs ?? '?'}</span></div>
          <div className="flex justify-between"><span className="text-white/40">meshRebuilds/sec</span><span className="text-[#00f2ff]">{liveStats?.voxelLighting?.meshRebuildCountLastSecond ?? '?'}</span></div>
          <div className="flex justify-between"><span className="text-white/40">skyLight@player</span><span className="text-[#00f2ff]">{liveStats?.voxelLighting?.skyLightAtPlayer ?? '?'}</span></div>
          <div className="flex justify-between"><span className="text-white/40">blockLight@player</span><span className="text-[#00f2ff]">{liveStats?.voxelLighting?.blockLightAtPlayer ? `[${liveStats.voxelLighting.blockLightAtPlayer.join(',')}]` : '?'}</span></div>
          <div className="flex justify-between"><span className="text-white/40">brightness@player</span><span className="text-[#00f2ff]">{liveStats?.voxelLighting?.combinedBrightnessAtPlayer ?? '?'}</span></div>
          <div className="flex justify-between"><span className="text-white/40">glowingNearby</span><span className="text-white/70">{liveStats?.voxelLighting?.glowingBlocksNearby ?? '?'}</span></div>
          <div className="flex justify-between"><span className="text-white/40">voxelSourcesNearby</span><span className="text-white/70">{liveStats?.voxelLighting?.voxelLightSourcesNearby ?? '?'}</span></div>
        </div>
        <div className="text-white/50 text-[8px] mb-1 mt-1">Test buttons:</div>
        <div className="flex gap-1 flex-wrap">
          <Button label="Ruin Cluster" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s && s.ruinLightClusterTest) s.ruinLightClusterTest(); } }} variant="primary" />
          <Button label="Single Torch" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s && s.singleTorchVoxelTest) s.singleTorchVoxelTest(); } }} variant="primary" />
          <Button label="3-Color Blend" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s && s.threeColorVoxelBlendTest) s.threeColorVoxelBlendTest(); } }} variant="primary" />
        </div>
        <div className="flex gap-1 flex-wrap mt-1">
          <Button label="Real Lights ON" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s && s.toggleRealPointLights) s.toggleRealPointLights(true); } }} variant="danger" />
          <Button label="Real Lights OFF" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s && s.toggleRealPointLights) s.toggleRealPointLights(false); } }} />
          <Button label="Force Relight" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s && s.forceRelightAll) s.forceRelightAll(); } }} />
          <Button label="Reset Preset" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s && s.resetLightingPreset) s.resetLightingPreset(); } }} />
        </div>
        <div className="text-white/40 text-[8px] mt-0.5">
          Ruin Cluster: no flicker near ruin. Single Torch: one stable yellow pool. 3-Color: yellow+cyan+magenta blend. Real Lights = debug only (cap 3).
        </div>
      </Section>

      {/* C. Glow / Bloom */}
      <Section title="Glow / Bloom / Postprocess">
        <Checkbox
          label="Glow enabled"
          checked={tuning.glowEnabled}
          onChange={(v) => patch({ glowEnabled: v })}
        />
        <Slider
          label="Glow intensity"
          value={tuning.glowIntensity}
          min={0}
          max={1}
          step={0.02}
          onChange={(v) => patch({ glowIntensity: v })}
        />
        <Slider
          label="Glow kernel"
          value={tuning.glowKernel}
          min={8}
          max={64}
          step={2}
          onChange={(v) => patch({ glowKernel: v })}
          fmt={(v) => v.toFixed(0)}
        />
        <Checkbox
          label="Bloom enabled"
          checked={tuning.bloomEnabled}
          onChange={(v) => patch({ bloomEnabled: v })}
        />
        <Slider
          label="Bloom weight"
          value={tuning.bloomWeight}
          min={0}
          max={1}
          step={0.02}
          onChange={(v) => patch({ bloomWeight: v })}
        />
        <Slider
          label="Bloom threshold"
          value={tuning.bloomThreshold}
          min={0}
          max={1}
          step={0.02}
          onChange={(v) => patch({ bloomThreshold: v })}
        />
        <Slider
          label="Exposure"
          value={tuning.exposure}
          min={0.5}
          max={1.6}
          step={0.02}
          onChange={(v) => patch({ exposure: v })}
        />
        <Slider
          label="Contrast"
          value={tuning.contrast}
          min={0.8}
          max={1.4}
          step={0.02}
          onChange={(v) => patch({ contrast: v })}
        />
      </Section>

      {/* D. Sky */}
      <Section title="Skybox / Celestial">
        <Checkbox label="Sun visible" checked={tuning.sunVisible} onChange={(v) => patch({ sunVisible: v })} />
        <Checkbox label="Moon visible" checked={tuning.moonVisible} onChange={(v) => patch({ moonVisible: v })} />
        <Checkbox label="Stars visible" checked={tuning.starsVisible} onChange={(v) => patch({ starsVisible: v })} />
        <Checkbox label="Clouds visible" checked={tuning.cloudsVisible} onChange={(v) => patch({ cloudsVisible: v })} />
        <Slider
          label="Star brightness"
          value={tuning.starBrightness}
          min={0}
          max={2}
          step={0.05}
          onChange={(v) => patch({ starBrightness: v })}
        />
        <div className="flex gap-1 mt-1 flex-wrap">
          <Button label="Isolate Sky" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s) s.isolateSky(true); } }} />
          <Button label="Restore Scene" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s) s.isolateSky(false); } }} variant="primary" />
          <Button label="Sky Off" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s) s.setSkyVisible(false); } }} />
          <Button label="Sky On" onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s) s.setSkyVisible(true); } }} />
        </div>
        <div className="text-white/40 text-[8px] mt-0.5">
          sun: {String(liveStats?.skyController?.sunVisible)} | moon: {String(liveStats?.skyController?.moonVisible)} | stars: {liveStats?.skyController?.starCount}
        </div>
      </Section>

      {/* E. Chunks */}
      <Section title="Chunks / Render Distance">
        <div className="text-white/60 text-[8px] space-y-0.5">
          <div>chunkAddDistance: {liveStats?.chunkAddDistance}</div>
          <div>chunkRemoveDistance: {liveStats?.chunkRemoveDistance}</div>
          <div>renderDistanceBlocks: {rdb}</div>
          <div>loaded chunks: {liveStats?.terrain?.meshCount}</div>
        </div>
        <div className="text-white/40 text-[8px] mt-1">
          ⚠ Changing chunk distances requires renderer restart (not live-tunable in noa-engine v0.33).
        </div>
      </Section>

      {/* F. Materials */}
      <Section title="Materials / Terrain">
        <div className="flex flex-col gap-1">
          <label className="text-[9px] text-white/50">Terrain material mode:</label>
          <div className="flex gap-1">
            {(['default', 'custom', 'debug'] as const).map((mode) => (
              <Button
                key={mode}
                label={mode}
                onClick={() => patch({ terrainMaterialMode: mode })}
                variant={tuning.terrainMaterialMode === mode ? 'primary' : 'normal'}
              />
            ))}
          </div>
        </div>
        <div className="text-white/60 text-[8px] mt-1 space-y-0.5">
          <div>first mat: {liveStats?.terrain?.sample?.[0]?.matName}</div>
          <div>ambient: [{liveStats?.terrain?.sample?.[0]?.matAmbient?.join(',')}]</div>
          <div>maxLights: {liveStats?.terrain?.sample?.[0]?.matMaxLights}</div>
          <div>visible: {liveStats?.terrain?.visibleCount}/{liveStats?.terrain?.meshCount}</div>
        </div>
        <div className="flex gap-1 mt-1">
          <Button
            label="Force Debug Mat"
            onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s) s.forceTerrainDebugMaterial(true); } }}
            variant="danger"
          />
          <Button
            label="Restore Mat"
            onClick={() => { const dbg = getDbg(); if (dbg) { const s = dbg(); if (s) s.forceTerrainDebugMaterial(false); } }}
          />
        </div>
      </Section>

      {/* Export/Import */}
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
      </Section>
    </div>
  );
}
