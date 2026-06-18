/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ItemStack } from '../types';

export interface CraftingRecipe {
  id: string;
  stationId: string;
  inputs: ItemStack[];
  output: ItemStack;
  durationMs: number;
}

/**
 * CraftingService - Handles modular alloy assembly, weapon workbench mods,
 * and base fabrication mechanics.
 */
export class CraftingService {
  constructor() {
    console.log('[CraftingService] Workbench blueprint registry loaded.');
  }

  public checkRequirements(inventory: ItemStack[], recipe: CraftingRecipe): boolean {
    return recipe.inputs.every(input => {
      const available = inventory.filter(item => item.itemId === input.itemId && item.type === input.type);
      const sum = available.reduce((acc, curr) => acc + curr.count, 0);
      return sum >= input.count;
    });
  }

  public processAssembly(recipe: CraftingRecipe): Promise<ItemStack> {
    return new Promise((resolve) => {
      console.log(`[CraftingService] Assembling ${recipe.output.itemId}...`);
      setTimeout(() => {
        resolve(recipe.output);
      }, recipe.durationMs);
    });
  }
}
