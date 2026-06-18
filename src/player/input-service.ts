/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PlayerService } from './player-service';

/**
 * InputService - Bridges hardware key triggers (1-5 block hotbars, etc.)
 * directly to the PlayerService and UI layers.
 */
export class InputService {
  private playerService: PlayerService;
  private listening: boolean = false;

  constructor(playerService: PlayerService) {
    this.playerService = playerService;
  }

  public startListening(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('keydown', this.handleKeyDown);
    console.log('[InputService] Keybind listening active (Hotkeys 1-5 maps block options).');
  }

  public stopListening(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener('keydown', this.handleKeyDown);
    console.log('[InputService] Keybind listening suspended.');
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    // Only map if not inside input inputs
    if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
      return;
    }

    const key = e.key;
    const hotbar = this.playerService.getHotbar();
    const keyNum = parseInt(key, 10);
    if (!isNaN(keyNum) && keyNum >= 1 && keyNum <= hotbar.length) {
      const blockId = hotbar[keyNum - 1];
      this.playerService.setSelectedBlockId(blockId);
    }
  };
}
