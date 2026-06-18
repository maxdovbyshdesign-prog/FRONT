/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SerializableGameState } from '../types';

/**
 * SaveService - Centralizes local disk state serialization and player
 * stats retention across raid runs.
 */
export class SaveService {
  private STORAGE_KEY = 'frontier_planet_save';

  constructor() {
    console.log('[SaveService] State persistence adapter synchronized.');
  }

  public saveGame(state: SerializableGameState): boolean {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(state));
      console.log('[SaveService] Game state persistent buffer cached.');
      return true;
    } catch (e) {
      console.error('[SaveService] Failed to serialize game state:', e);
      return false;
    }
  }

  public loadGame(): SerializableGameState | null {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      if (!data) return null;
      console.log('[SaveService] Restored previous raid progression metrics.');
      return JSON.parse(data) as SerializableGameState;
    } catch (e) {
      console.error('[SaveService] Failed to load game state:', e);
      return null;
    }
  }

  public clearSave(): void {
    localStorage.removeItem(this.STORAGE_KEY);
    console.log('[SaveService] Cleared persistent progress history.');
  }
}
