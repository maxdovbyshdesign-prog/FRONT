/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ItemStack } from '../types';

/**
 * EconomyService - Manages credit balances, faction trade inflation and
 * buying dynamic rates of artifacts.
 */
export class EconomyService {
  private credits: number = 2500; // Starting funds

  constructor() {
    console.log('[EconomyService] Sol-Scavenger trading ledger loaded.');
  }

  public getCredits(): number {
    return this.credits;
  }

  public processPurchase(cost: number): boolean {
    if (this.credits >= cost) {
      this.credits -= cost;
      console.log(`[EconomyService] Transaction cleared. Deducted ${cost} credits. Current: ${this.credits}`);
      return true;
    }
    console.log('[EconomyService] Insufficient Sol-credits.');
    return false;
  }

  public sellArtifact(stack: ItemStack, demandMultiplier: number): number {
    if (stack.type !== 'artifact') return 0;
    const value = Math.round(500 * demandMultiplier); // basic value
    this.credits += value;
    console.log(`[EconomyService] Sold artifact for ${value} credits. Current: ${this.credits}`);
    return value;
  }
}
