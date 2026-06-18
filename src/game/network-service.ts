/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GameEvent } from '../types';

/**
 * NetworkService - Placeholder architecture for future multiplayer support.
 * Separates local client actions from replicated server events.
 */
export class NetworkService {
  private isConnected: boolean = false;
  private messageListeners: ((event: GameEvent) => void)[] = [];

  constructor() {
    console.log('[NetworkService] Initialized. Standing by for peer connections (offline mode).');
  }

  public connect(serverAddress: string): Promise<boolean> {
    return new Promise((resolve) => {
      console.log(`[NetworkService] Connecting to ${serverAddress}...`);
      setTimeout(() => {
        this.isConnected = true;
        console.log('[NetworkService] Connected successfully.');
        resolve(true);
      }, 500);
    });
  }

  public disconnect(): void {
    if (this.isConnected) {
      this.isConnected = false;
      console.log('[NetworkService] Disconnected from host.');
    }
  }

  public sendEvent(event: GameEvent): void {
    if (!this.isConnected) {
      // Local play: feedback loops immediately back
      return;
    }
    console.log(`[NetworkService] Replicating event: ${event.type}`);
  }

  public registerEventListener(callback: (event: GameEvent) => void): void {
    this.messageListeners.push(callback);
  }
}
