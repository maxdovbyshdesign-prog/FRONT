/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SurvivalService — FRONTIER PLANET survival vitals system.
 *
 * Tracks four secondary vitals that feed back into PlayerService health:
 *   - stamina:  drains while sprinting, regenerates when walking/idle.
 *               At 0, sprint is blocked (the adapter reads canSprint()).
 *   - oxygen:   drains when the player is underground / indoors (skyLight=0).
 *               Integrates with VoxelLightManager — the lighting fix pays off
 *               here: oxygen correctly reads skyLight at the WORLD player cell
 *               even after noa rebase. At 0 → health damage (suffocation).
 *   - hydration: slowly drains over time, faster during day heat. At 0 →
 *               health damage (dehydration).
 *   - radiation: rises at night (0.45–0.55 timeOfDay band, planet surface
 *               emits radon after dark) and near artifact blocks. At high →
 *               health damage (radiation sickness).
 *
 * Design:
 *   - Pure logical state, ticked externally with a context snapshot. No
 *     direct engine coupling — the adapter gathers {dtMs, sprinting,
 *     skyLightAtPlayer, nightFactor, nearArtifact, timeOfDay} and calls tick().
 *   - Mirrors a snapshot into `gameState.survival` each tick so the React HUD
 *     can poll it at 12.5Hz without touching the service.
 *   - Emits UiService alerts on state transitions (low/critical/recovered).
 *   - Polygon mode is exempt from hydration/radiation damage (test world) but
 *     stamina + oxygen still simulate so the HUD is live.
 */

export interface SurvivalSnapshot {
  stamina: number;       // 0..100
  oxygen: number;        // 0..100
  hydration: number;     // 0..100
  radiation: number;     // 0..100
  /** Composite status for the HUD crest: nominal / warn / critical. */
  status: 'nominal' | 'warn' | 'critical';
  /** True if stamina is too low to sprint. */
  canSprint: boolean;
  /** Per-vital low flags for HUD pulsing. */
  lowStamina: boolean;
  lowOxygen: boolean;
  lowHydration: boolean;
  highRadiation: boolean;
}

export interface SurvivalTickContext {
  /** Delta time in milliseconds (clamped). */
  dtMs: number;
  /** True if the player is currently sprinting. */
  sprinting: boolean;
  /** Sky light level 0..15 at the player's WORLD cell (from VoxelLightManager). */
  skyLightAtPlayer: number;
  /** 0 = full day, 1 = full night (from SkyController). */
  nightFactor: number;
  /** True if the player is within ~6 blocks of an artifact/ruin block. */
  nearArtifact: boolean;
  /** Normalized time-of-day 0..1 (0=dawn, 0.25=noon, 0.5=dusk, 0.75=midnight). */
  timeOfDay: number;
  /** True if running in Polygon test mode (disables lethal damage). */
  polygonMode: boolean;
}

interface DecayRates {
  staminaSprintPerSec: number;
  staminaRegenPerSec: number;
  oxygenDrainPerSec: number;
  oxygenRegenPerSec: number;
  hydrationDrainDayPerSec: number;
  hydrationDrainNightPerSec: number;
  radiationNightPerSec: number;
  radiationArtifactPerSec: number;
  radiationDecayPerSec: number;
}

const DEFAULT_RATES: DecayRates = {
  // Stamina: 40s of sprint drains full bar; 12s to regen.
  staminaSprintPerSec: 100 / 40,
  staminaRegenPerSec: 100 / 12,
  // Oxygen: 50s underground → 0; 6s surface → full.
  oxygenDrainPerSec: 100 / 50,
  oxygenRegenPerSec: 100 / 6,
  // Hydration: ~10 min day drain, ~16 min night. Slow but real.
  hydrationDrainDayPerSec: 100 / 600,
  hydrationDrainNightPerSec: 100 / 960,
  // Radiation: night builds 1/180s → ~33% by dawn; artifact proximity 4x.
  radiationNightPerSec: 100 / 180,
  radiationArtifactPerSec: 100 / 45,
  radiationDecayPerSec: 100 / 90,
};

const LOW_THRESHOLD = 25;
const CRITICAL_THRESHOLD = 10;
const RADIATION_HIGH_THRESHOLD = 60;
const RADIATION_DAMAGE_THRESHOLD = 75;

export class SurvivalService {
  private stamina = 100;
  private oxygen = 100;
  private hydration = 100;
  private radiation = 0;

  private rates: DecayRates = DEFAULT_RATES;

  // Alert throttle — only emit each alert once per state transition.
  private lastStaminaState: 'ok' | 'low' | 'critical' | 'empty' = 'ok';
  private lastOxygenState: 'ok' | 'low' | 'critical' | 'empty' = 'ok';
  private lastHydrationState: 'ok' | 'low' | 'critical' | 'empty' = 'ok';
  private lastRadiationState: 'ok' | 'high' | 'critical' = 'ok';

  // Damage tick accumulator — apply health damage at 1Hz, not every frame.
  private damageAccumulatorMs = 0;

  constructor() {
    console.log('[SurvivalService] Vitals telemetry online (stamina / oxygen / hydration / radiation).');
  }

  /** Full reset on raid restart / redeploy. */
  public reset(): void {
    this.stamina = 100;
    this.oxygen = 100;
    this.hydration = 100;
    this.radiation = 0;
    this.damageAccumulatorMs = 0;
    this.lastStaminaState = 'ok';
    this.lastOxygenState = 'ok';
    this.lastHydrationState = 'ok';
    this.lastRadiationState = 'ok';
  }

  /** Replenish hydration (e.g. drink from a water block — future feature). */
  public drink(amount: number): void {
    this.hydration = Math.min(100, this.hydration + amount);
  }

  /** Apply radiation meds (future item). */
  public administerRadX(amount: number): void {
    this.radiation = Math.max(0, this.radiation - amount);
  }

  /** Whether the player is allowed to start/continue sprinting. */
  public canSprint(): boolean {
    return this.stamina > 5;
  }

  public getSnapshot(): SurvivalSnapshot {
    const lowStamina = this.stamina < LOW_THRESHOLD;
    const lowOxygen = this.oxygen < LOW_THRESHOLD;
    const lowHydration = this.hydration < LOW_THRESHOLD;
    const highRadiation = this.radiation > RADIATION_HIGH_THRESHOLD;
    const anyLow = lowStamina || lowOxygen || lowHydration;
    const anyCritical =
      this.stamina < CRITICAL_THRESHOLD ||
      this.oxygen < CRITICAL_THRESHOLD ||
      this.hydration < CRITICAL_THRESHOLD ||
      this.radiation > RADIATION_DAMAGE_THRESHOLD;
    let status: 'nominal' | 'warn' | 'critical' = 'nominal';
    if (anyCritical) status = 'critical';
    else if (anyLow || highRadiation) status = 'warn';
    return {
      stamina: this.stamina,
      oxygen: this.oxygen,
      hydration: this.hydration,
      radiation: this.radiation,
      status,
      canSprint: this.canSprint(),
      lowStamina,
      lowOxygen,
      lowHydration,
      highRadiation,
    };
  }

  /**
   * Advance the survival simulation. Returns the damage to apply to health
   * this tick (caller applies via PlayerService). Polygon mode returns 0
   * damage but still simulates decay so the HUD is live.
   */
  public tick(
    ctx: SurvivalTickContext,
    emitAlert: (msg: string, type: 'info' | 'success' | 'warning') => void
  ): number {
    const dt = ctx.dtMs / 1000;

    // ---- Stamina ----
    if (ctx.sprinting && this.stamina > 0) {
      this.stamina = Math.max(0, this.stamina - this.rates.staminaSprintPerSec * dt);
    } else if (!ctx.sprinting) {
      this.stamina = Math.min(100, this.stamina + this.rates.staminaRegenPerSec * dt);
    }
    this.transitionStamina(emitAlert);

    // ---- Oxygen (integrates with the lighting system) ----
    // skyLight 0 = underground / indoors → drain. skyLight >= 1 = surface → regen.
    if (ctx.skyLightAtPlayer <= 0) {
      this.oxygen = Math.max(0, this.oxygen - this.rates.oxygenDrainPerSec * dt);
    } else {
      this.oxygen = Math.min(100, this.oxygen + this.rates.oxygenRegenPerSec * dt);
    }
    this.transitionOxygen(emitAlert);

    // ---- Hydration (time-of-day heat) ----
    if (!ctx.polygonMode) {
      const isDay = ctx.nightFactor < 0.5;
      const drain = isDay ? this.rates.hydrationDrainDayPerSec : this.rates.hydrationDrainNightPerSec;
      this.hydration = Math.max(0, this.hydration - drain * dt);
    }
    this.transitionHydration(emitAlert);

    // ---- Radiation (night + artifact proximity) ----
    if (!ctx.polygonMode) {
      // Night band: timeOfDay in [0.45, 0.55] is dusk→midnight→dawn transition.
      // Use nightFactor as the smooth driver instead of a hard band.
      if (ctx.nightFactor > 0.3) {
        this.radiation = Math.min(100, this.radiation + this.rates.radiationNightPerSec * ctx.nightFactor * dt);
      }
      if (ctx.nearArtifact) {
        this.radiation = Math.min(100, this.radiation + this.rates.radiationArtifactPerSec * dt);
      }
      // Decay during full day.
      if (ctx.nightFactor < 0.1 && !ctx.nearArtifact) {
        this.radiation = Math.max(0, this.radiation - this.rates.radiationDecayPerSec * dt);
      }
    }
    this.transitionRadiation(emitAlert);

    // ---- Health damage from depleted vitals (1Hz tick) ----
    this.damageAccumulatorMs += ctx.dtMs;
    let damage = 0;
    if (this.damageAccumulatorMs >= 1000) {
      this.damageAccumulatorMs -= 1000;
      if (!ctx.polygonMode) {
        if (this.oxygen <= 0) damage += 6;       // suffocation
        if (this.hydration <= 0) damage += 3;    // dehydration
        if (this.radiation >= RADIATION_DAMAGE_THRESHOLD) damage += 4; // rad sickness
      }
    }
    return damage;
  }

  private transitionStamina(emit: (m: string, t: 'info' | 'success' | 'warning') => void): void {
    const s = this.stamina <= 0 ? 'empty' : this.stamina < CRITICAL_THRESHOLD ? 'critical' : this.stamina < LOW_THRESHOLD ? 'low' : 'ok';
    if (s !== this.lastStaminaState) {
      if (s === 'low') emit('Stamina low — catch your breath, contractor.', 'warning');
      else if (s === 'empty') emit('Stamina exhausted — sprint locked.', 'warning');
      else if (s === 'ok' && (this.lastStaminaState === 'low' || this.lastStaminaState === 'empty' || this.lastStaminaState === 'critical')) {
        emit('Stamina recovered.', 'success');
      }
      this.lastStaminaState = s;
    }
  }

  private transitionOxygen(emit: (m: string, t: 'info' | 'success' | 'warning') => void): void {
    const s = this.oxygen <= 0 ? 'empty' : this.oxygen < CRITICAL_THRESHOLD ? 'critical' : this.oxygen < LOW_THRESHOLD ? 'low' : 'ok';
    if (s !== this.lastOxygenState) {
      if (s === 'low') emit('Oxygen low — return to open air.', 'warning');
      else if (s === 'critical') emit('Oxygen critical — suffocation imminent!', 'warning');
      else if (s === 'ok' && this.lastOxygenState !== 'ok') emit('Oxygen levels nominal.', 'success');
      this.lastOxygenState = s;
    }
  }

  private transitionHydration(emit: (m: string, t: 'info' | 'success' | 'warning') => void): void {
    const s = this.hydration <= 0 ? 'empty' : this.hydration < CRITICAL_THRESHOLD ? 'critical' : this.hydration < LOW_THRESHOLD ? 'low' : 'ok';
    if (s !== this.lastHydrationState) {
      if (s === 'low') emit('Hydration low — find water.', 'warning');
      else if (s === 'critical') emit('Dehydration critical — health failing!', 'warning');
      this.lastHydrationState = s;
    }
  }

  private transitionRadiation(emit: (m: string, t: 'info' | 'success' | 'warning') => void): void {
    const s = this.radiation > RADIATION_DAMAGE_THRESHOLD ? 'critical' : this.radiation > RADIATION_HIGH_THRESHOLD ? 'high' : 'ok';
    if (s !== this.lastRadiationState) {
      if (s === 'high') emit('Radiation rising — take cover or use Rad-X.', 'warning');
      else if (s === 'critical') emit('Radiation sickness — health draining!', 'warning');
      this.lastRadiationState = s;
    }
  }
}
