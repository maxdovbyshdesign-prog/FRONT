/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BlockDefinition } from '../types';
import { BLOCKS, getBlockById } from '../data/blocks-data';
import { ModRegistry } from '../modding/mod-registry';

/**
 * BlockService - Holds block statistics, hardness levels, values,
 * and registration hooks.
 */
export class BlockService {
  constructor() {
    console.log('[BlockService] Subsystem online. Loaded block registry with mod support.');
  }

  public getBlockDefinitions(): BlockDefinition[] {
    const custom = ModRegistry.getInstance().getCustomBlockDefinitionsAsCore();
    return [...BLOCKS, ...custom];
  }

  public getBlock(id: number): BlockDefinition | undefined {
    if (id < 10) {
      return getBlockById(id);
    }
    return ModRegistry.getInstance().getCustomBlockDefinitionsAsCore().find(b => b.id === id);
  }

  public getBlockColor(id: number): [number, number, number] {
    const block = this.getBlock(id);
    return block ? block.color : [0.5, 0.5, 0.5];
  }
}
