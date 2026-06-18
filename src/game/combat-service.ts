/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { DamageEvent, HealthComponent } from '../types';

/**
 * CombatService - Decoupled damage-tick coordinator.
 * Manages player shields, creature health modifications, and faction hostile-alerts.
 */
export class CombatService {
  constructor() {
    console.log('[CombatService] Decoupled hit-registration system online.');
  }

  public applyDamage(health: HealthComponent, event: DamageEvent): HealthComponent {
    const reducedAmount = this.calculateArmorMitigation(event.amount, event.type);
    const updatedHealth = Math.max(0, health.currentHealth - reducedAmount);
    
    console.log(`[CombatService] Target ${event.targetEntityId} took ${reducedAmount} ${event.type} dmg. Current Health: ${updatedHealth}/${health.maxHealth}`);
    
    return {
      currentHealth: updatedHealth,
      maxHealth: health.maxHealth
    };
  }

  public applyHealing(health: HealthComponent, amount: number): HealthComponent {
    const updatedHealth = Math.min(health.maxHealth, health.currentHealth + amount);
    console.log(`[CombatService] Restored ${amount} health. Current Health: ${updatedHealth}/${health.maxHealth}`);
    return {
      currentHealth: updatedHealth,
      maxHealth: health.maxHealth
    };
  }

  private calculateArmorMitigation(amount: number, type: string): number {
    // Advanced damage formulas go here
    switch (type) {
      case 'radiation':
        return amount * 1.5; // Hazmat gear weak
      case 'energy':
        return amount * 0.8; // Plasma-shielded
      default:
        return amount; // Standard kinetic impact
    }
  }
}
