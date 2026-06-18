/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * VehicleService - Framework for future heavy rover mounts, hover bikes,
 * and orbital drop-ship escape pods.
 */
export class VehicleService {
  private activeVehicleId: string | null = null;
  private fuelLevel: number = 100;

  constructor() {
    console.log('[VehicleService] Heavy rover garage telemetry online (standby).');
  }

  public mountVehicle(vehicleId: string): void {
    this.activeVehicleId = vehicleId;
    console.log(`[VehicleService] Player mounted vehicle shell: ${vehicleId}`);
  }

  public consumeFuel(amount: number): void {
    this.fuelLevel = Math.max(0, this.fuelLevel - amount);
    console.log(`[VehicleService] Throttled thruster. Fuel level: ${this.fuelLevel}%`);
  }

  public getVehicleStatus() {
    return {
      mounted: this.activeVehicleId !== null,
      id: this.activeVehicleId,
      fuel: this.fuelLevel
    };
  }
}
