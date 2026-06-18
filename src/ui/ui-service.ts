/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * UiService - Syncs game notices, alert banners, HUD overlays, and sound
 * trigger logs.
 */
export class UiService {
  private alertCallbacks: ((msg: string, status: 'warning' | 'success' | 'info') => void)[] = [];

  constructor() {
    console.log('[UiService] Overlay messaging engine connected.');
  }

  public emitAlert(message: string, status: 'warning' | 'success' | 'info' = 'info'): void {
    console.log(`[UiService Alert] [${status.toUpperCase()}] ${message}`);
    this.alertCallbacks.forEach((cb) => cb(message, status));
  }

  public registerAlertHandler(cb: (msg: string, status: 'warning' | 'success' | 'info') => void): () => void {
    this.alertCallbacks.push(cb);
    return () => {
      this.alertCallbacks = this.alertCallbacks.filter(item => item !== cb);
    };
  }
}
