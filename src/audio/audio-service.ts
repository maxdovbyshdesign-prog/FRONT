/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ModRegistry } from '../modding/mod-registry';

export class AudioService {
  private static instance: AudioService | null = null;

  public static getInstance(): AudioService {
    if (!AudioService.instance) {
      AudioService.instance = new AudioService();
    }
    return AudioService.instance;
  }

  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private ambientSource: AudioScheduledSourceNode | null = null;
  private ambientGain: GainNode | null = null;
  private isAmbientPlaying: boolean = false;
  private noiseBuffer: AudioBuffer | null = null;
  private ambientFilter: BiquadFilterNode | null = null;

  private constructor() {
    console.log('[AudioService] Sound registers armed. Synthesizer standby.');
  }

  private initContext(): void {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
        // Master Volume tuning: suggested masterVolume: 0.7
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.setValueAtTime(0.7, this.ctx.currentTime);
        this.masterGain.connect(this.ctx.destination);
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().then(() => {
        console.log('[AudioService] Audio Context resumed successfully.');
      });
    }
  }

  public resume(): void {
    this.unlock();
  }

  public unlock(): void {
    try {
      this.initContext();
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().then(() => {
          console.log('[AudioService] Audio unlocked.');
          this.playAmbientDesert();
        });
      } else {
        this.playAmbientDesert();
      }
    } catch (e) {
      console.warn('[AudioService] Unlock failure:', e);
    }
  }

  /**
   * Generates white noise buffer for synthetic wind and impact sound designs
   */
  private createNoiseBuffer(): AudioBuffer {
    this.initContext();
    if (!this.ctx) throw new Error('Audio Context unavailable');

    if (this.noiseBuffer) {
      return this.noiseBuffer;
    }

    const bufferSize = this.ctx.sampleRate * 2; // 2 seconds
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
    return buffer;
  }

  /**
   * Play simple click chime for UI selections
   */
  public playUiClick(): void {
    try {
      this.initContext();
      if (!this.ctx) return;

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(600, this.ctx.currentTime + 0.1);

      // Suggested volume: UI click: 0.12
      gain.gain.setValueAtTime(0.12, this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.001, this.ctx.currentTime + 0.1);

      osc.connect(gain);
      if (this.masterGain) {
        gain.connect(this.masterGain);
      } else {
        gain.connect(this.ctx.destination);
      }

      osc.start();
      osc.stop(this.ctx.currentTime + 0.1);
    } catch (e) {
      console.warn('[AudioService] Click failure:', e);
    }
  }

  /**
   * Synthetic soft block placing feedback (organic thud)
   */
  public playBlockPlace(): void {
    try {
      this.initContext();
      if (!this.ctx) return;

      const activeSounds = ModRegistry.getInstance().getActiveSounds();
      const hasPlaceMod = activeSounds.sounds?.some(s => s.id === 'place' || s.path?.includes('place'));
      if (hasPlaceMod) {
        console.warn('[AudioService] Mod sound missing, using synth fallback.');
      }

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(150, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(60, this.ctx.currentTime + 0.15);

      // Suggested volume: block place: 0.25
      gain.gain.setValueAtTime(0.25, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.15);

      osc.connect(gain);
      if (this.masterGain) {
        gain.connect(this.masterGain);
      } else {
        gain.connect(this.ctx.destination);
      }

      osc.start();
      osc.stop(this.ctx.currentTime + 0.15);
      console.log('[AudioService] Block place sound triggered.');
    } catch (e) {
      console.warn('[AudioService] Block place audio error:', e);
    }
  }

  /**
   * Sound design of mining/excavating (explosive crack)
   */
  public playBlockDestroy(): void {
    try {
      this.initContext();
      if (!this.ctx) return;

      const activeSounds = ModRegistry.getInstance().getActiveSounds();
      const hasDestroyMod = activeSounds.sounds?.some(s => s.id === 'destroy' || s.path?.includes('destroy'));
      if (hasDestroyMod) {
        console.warn('[AudioService] Mod sound missing, using synth fallback.');
      }

      // Noise source
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.createNoiseBuffer();

      // Bandpass filter to make it sound earthy
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(250, this.ctx.currentTime);
      filter.Q.setValueAtTime(3.0, this.ctx.currentTime);

      const gain = this.ctx.createGain();
      // Suggested volume: block destroy: 0.28
      gain.gain.setValueAtTime(0.28, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.005, this.ctx.currentTime + 0.22);

      noise.connect(filter);
      filter.connect(gain);
      if (this.masterGain) {
        gain.connect(this.masterGain);
      } else {
        gain.connect(this.ctx.destination);
      }

      noise.start();
      noise.stop(this.ctx.currentTime + 0.22);
      console.log('[AudioService] Block destroy sound triggered.');
    } catch (e) {
      console.warn('[AudioService] Block mining audio error:', e);
    }
  }

  /**
   * Arpeggiator synth celebration chime for recovered core objective completes
   */
  public playArtifactPickup(): void {
    try {
      this.initContext();
      if (!this.ctx) return;

      const baseTime = this.ctx.currentTime;
      const notes = [261.63, 329.63, 392.00, 523.25, 659.25, 783.99]; // C major chord arpeggio
      
      notes.forEach((freq, idx) => {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, baseTime + idx * 0.1);
        
        // Suggested volume: artifact pickup: 0.12
        gain.gain.setValueAtTime(0.0, baseTime + idx * 0.1);
        gain.gain.linearRampToValueAtTime(0.12, baseTime + idx * 0.1 + 0.02);
        gain.gain.linearRampToValueAtTime(0.0, baseTime + idx * 0.1 + 0.3);
        
        osc.connect(gain);
        if (this.masterGain) {
          gain.connect(this.masterGain);
        } else {
          gain.connect(this.ctx.destination);
        }
        
        osc.start(baseTime + idx * 0.1);
        osc.stop(baseTime + idx * 0.1 + 0.3);
      });
      console.log('[AudioService] Artifact pickup sound triggered.');
    } catch (e) {
      console.warn('[AudioService] Arpeggio failure:', e);
    }
  }

  /**
   * Planetary wind synthesizer loop
   */
  public playAmbientDesert(): void {
    if (this.isAmbientPlaying) return;
    try {
      this.initContext();
      if (!this.ctx) return;

      this.isAmbientPlaying = true;

      // Infinite looping noise
      const bufferSource = this.ctx.createBufferSource();
      bufferSource.buffer = this.createNoiseBuffer();
      bufferSource.loop = true;

      // Bandpass filtration
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(320, this.ctx.currentTime);
      filter.Q.setValueAtTime(2.0, this.ctx.currentTime);
      this.ambientFilter = filter;

      // Low frequency oscillator modulates bandpass frequency to simulate roaring winds
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(0.12, this.ctx.currentTime); // very slow rumble

      const lfoGain = this.ctx.createGain();
      lfoGain.gain.setValueAtTime(140, this.ctx.currentTime); // sweep range

      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);

      this.ambientGain = this.ctx.createGain();
      // Suggested volume: ambience: 0.035 to 0.06 (let's use 0.05)
      this.ambientGain.gain.setValueAtTime(0.05, this.ctx.currentTime);

      bufferSource.connect(filter);
      filter.connect(this.ambientGain);
      if (this.masterGain) {
        this.ambientGain.connect(this.masterGain);
      } else {
        this.ambientGain.connect(this.ctx.destination);
      }

      lfo.start();
      bufferSource.start();

      this.ambientSource = bufferSource;
      console.log('[AudioService] Ambient started.');
    } catch (e) {
      console.warn('[AudioService] Failed to start ambient synthesized loop:', e);
    }
  }

  public stopAmbient(): void {
    if (!this.isAmbientPlaying) return;
    try {
      if (this.ambientSource) {
        this.ambientSource.stop();
        this.ambientSource.disconnect();
        this.ambientSource = null;
      }
      this.ambientFilter = null;
      this.isAmbientPlaying = false;
      console.log('[AudioService] Ambient loop suspended.');
    } catch (e) {
      console.warn(e);
    }
  }

  /**
   * Modulates wind filter frequency and Q dynamically based on day/night sun altitude
   */
  public updateAmbientAltitude(sunAltitude: number): void {
    if (!this.ctx || !this.ambientFilter) return;
    try {
      // Warm bright alien breeze during day vs cold, mysterious space drafts at night
      const altitudeClipped = Math.max(-1.0, Math.min(1.0, sunAltitude));
      const targetFreq = 220 + (altitudeClipped + 1.0) * 50; // Ranges smoothly from 170Hz (night) to 270Hz (day)
      const targetQ = sunAltitude > 0 ? 1.8 : 3.2; // Brighter & wider during day, whistlier & sharper at night
      this.ambientFilter.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.8);
      this.ambientFilter.Q.setTargetAtTime(targetQ, this.ctx.currentTime, 0.8);
    } catch (e) {
      // Ignore race updates from animation frames
    }
  }
}
