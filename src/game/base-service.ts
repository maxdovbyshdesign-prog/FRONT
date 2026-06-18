/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { MachineDefinition } from '../types';

/**
 * BaseService - Coordinates structures, generator combustion, and oxygen
 * filters in player-administered safe zones.
 */
export class BaseService {
  private baseGridMachines: MachineDefinition[] = [];

  constructor() {
    console.log('[BaseService] Safe-house node database initialized.');
  }

  public installMachine(machine: MachineDefinition): void {
    this.baseGridMachines.push(machine);
    console.log(`[BaseService] Machine ${machine.name} booted and wired.`);
  }

  public calculatePowerLoad(): { netPower: number; demand: number; supply: number } {
    let supply = 0;
    let demand = 0;
    this.baseGridMachines.forEach(m => {
      if (m.powerDraw < 0) {
        supply += Math.abs(m.powerDraw);
      } else {
        demand += m.powerDraw;
      }
    });
    return {
      netPower: supply - demand,
      demand,
      supply
    };
  }
}
