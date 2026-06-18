/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { WeaponInstance, WeaponDefinition } from '../types';
import { WEAPONS } from '../data/weapons-data';

/**
 * WeaponService - Handles weapon attachment states, recoil stats,
 * muzzle flash coordinates, and projectile fires.
 */
export class WeaponService {
  private baseBlueprints: Map<string, WeaponDefinition> = new Map();

  constructor() {
    WEAPONS.forEach(w => {
      this.baseBlueprints.set(w.id, w);
    });
    console.log('[WeaponService] Firearms manufacturing blueprints loaded.');
  }

  public assembleInstance(definitionId: string): WeaponInstance | null {
    const blueprint = this.baseBlueprints.get(definitionId);
    if (!blueprint) return null;

    return {
      id: `w_${Math.random().toString(36).substr(2, 9)}`,
      definitionId,
      attachments: {},
      currentAmmo: blueprint.baseStats.fireRate > 200 ? 30 : 8 // realistic capacities
    };
  }

  public reloadWeapon(weapon: WeaponInstance): { success: boolean; ammoRestored: number } {
    const bp = this.baseBlueprints.get(weapon.definitionId);
    if (!bp) return { success: false, ammoRestored: 0 };

    const maxAmt = bp.baseStats.fireRate > 200 ? 30 : 8;
    const added = maxAmt - weapon.currentAmmo;
    weapon.currentAmmo = maxAmt;
    console.log(`[WeaponService] Reloaded ${bp.name}. Refilled +${added} rounds.`);
    return { success: true, ammoRestored: added };
  }
}
