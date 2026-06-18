/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { VoxelPosition } from '../types';
import { gameState } from '../game/game-state';

/**
 * PlayerService - Monitors health levels, oxygen indexes, selected build items,
 * and movement status.
 */
export class PlayerService {
  private health: number = 100;
  private maxHealth: number = 100;
  private position: VoxelPosition = [0, 15, 0]; // starting position
  private selectedBlockId: number = 1; // Default is Red Dust
  private hotbar: number[] = [1, 2, 3, 4, 5, 6, 7, 8]; // Hotbar slots
  private callbacks: (() => void)[] = [];

  constructor() {
    console.log('[PlayerService] Combat HUD telemetry online.');
    // Init state mirror
    gameState.playerPosition = [...this.position];
    gameState.selectedBlockId = this.selectedBlockId;
  }

  public getHealth(): number {
    return this.health;
  }

  public getPosition(): VoxelPosition {
    return this.position;
  }

  public updatePosition(pos: VoxelPosition): void {
    this.position = [...pos];
    gameState.playerPosition = [...pos];
  }

  public getSelectedBlockId(): number {
    return this.selectedBlockId;
  }

  public setSelectedBlockId(id: number): void {
    if (this.hotbar.includes(id)) {
      this.selectedBlockId = id;
      gameState.selectedBlockId = id;
      console.log(`[PlayerService] Activated voxel template ID: ${id}`);
      this.notifyListeners();
    }
  }

  public getHotbar(): number[] {
    return this.hotbar;
  }

  public damagePlayer(amount: number): void {
    this.health = Math.max(0, this.health - amount);
    this.notifyListeners();
  }

  public healPlayer(amount: number): void {
    this.health = Math.min(this.maxHealth, this.health + amount);
    this.notifyListeners();
  }

  public registerOnUpdate(cb: () => void): () => void {
    this.callbacks.push(cb);
    return () => {
      this.callbacks = this.callbacks.filter(item => item !== cb);
    };
  }

  private notifyListeners(): void {
    this.callbacks.forEach(cb => cb());
  }
}
