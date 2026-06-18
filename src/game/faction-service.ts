/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Faction, FactionRelation } from '../types';
import { FACTIONS } from '../data/factions-data';

/**
 * FactionService - Manages diplomatic standing, territorial boundaries,
 * and contract board allegiances.
 */
export class FactionService {
  private activeStandings: Record<string, number> = {};

  constructor() {
    FACTIONS.forEach(f => {
      this.activeStandings[f.id] = f.standing;
    });
    console.log('[FactionService] Standing system loaded with 3 active groups.');
  }

  public getStanding(factionId: string): number {
    return this.activeStandings[factionId] ?? 0;
  }

  public modifyStanding(factionId: string, delta: number): void {
    if (this.activeStandings[factionId] !== undefined) {
      this.activeStandings[factionId] = Math.max(-100, Math.min(100, this.activeStandings[factionId] + delta));
      console.log(`[FactionService] Dip standing updated for ${factionId}: ${this.activeStandings[factionId]}`);
    }
  }

  public getRelation(factionId: string): FactionRelation {
    const standing = this.getStanding(factionId);
    if (standing <= -40) return 'hostile';
    if (standing >= 40) return 'friendly';
    return 'neutral';
  }
}
