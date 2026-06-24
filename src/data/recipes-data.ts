/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ItemStack } from '../types';
import { getItemById } from './items-data';

/**
 * Crafting recipes for FRONTIER PLANET.
 *
 * Each recipe maps resource inputs → a crafted output (usually a consumable
 * that restores a survival vital). This closes the gameplay loop:
 *   mine blocks → resources → craft consumable → consume to restore vitals.
 *
 * The player needs this loop to survive long night expeditions (radiation
 * rises at night → craft Rad-X from crystal_shard + metal_scrap) and cave
 * dives (oxygen drains underground → craft O₂ Canister from metal_scrap).
 */

export interface CraftingRecipe {
  id: string;
  name: string;
  description: string;
  inputs: ItemStack[];
  output: ItemStack;
  /** Optional crafting station requirement (future: workbench block). */
  stationId?: string;
}

export const RECIPES: CraftingRecipe[] = [
  {
    id: 'craft_water_flask',
    name: 'Water Flask',
    description: 'Filter dust shards + metal cap into a hydration flask.',
    inputs: [
      { itemId: 'dust_shard', count: 2, type: 'item' },
      { itemId: 'metal_scrap', count: 1, type: 'item' },
    ],
    output: { itemId: 'water_flask', count: 1, type: 'item' },
  },
  {
    id: 'craft_rad_x',
    name: 'Rad-X Injector',
    description: 'Synthesize anti-radiation meds from a crystal shard + alloy casing.',
    inputs: [
      { itemId: 'crystal_shard', count: 1, type: 'item' },
      { itemId: 'metal_scrap', count: 2, type: 'item' },
    ],
    output: { itemId: 'rad_x', count: 1, type: 'item' },
  },
  {
    id: 'craft_oxygen_canister',
    name: 'O₂ Canister',
    description: 'Pressurize a metal canister for cave diving.',
    inputs: [
      { itemId: 'metal_scrap', count: 3, type: 'item' },
    ],
    output: { itemId: 'oxygen_canister', count: 1, type: 'item' },
  },
  {
    id: 'craft_energy_bar',
    name: 'Energy Bar',
    description: 'Compress dust shards into a dense ration bar.',
    inputs: [
      { itemId: 'dust_shard', count: 2, type: 'item' },
    ],
    output: { itemId: 'energy_bar', count: 1, type: 'item' },
  },
  {
    id: 'craft_medkit',
    name: 'Field Medkit',
    description: 'Nanite repair pack. Requires rare crystal substrate.',
    inputs: [
      { itemId: 'crystal_shard', count: 2, type: 'item' },
      { itemId: 'dust_shard', count: 3, type: 'item' },
    ],
    output: { itemId: 'medkit', count: 1, type: 'item' },
  },
];

const RECIPE_MAP: Record<string, CraftingRecipe> = Object.fromEntries(
  RECIPES.map(r => [r.id, r])
);

export function getRecipeById(id: string): CraftingRecipe | undefined {
  return RECIPE_MAP[id];
}

/** Helper: validate a recipe output item exists in the item registry. */
export function validateRecipes(): boolean {
  for (const r of RECIPES) {
    if (!getItemById(r.output.itemId)) {
      console.error(`[Recipes] ${r.id} output item ${r.output.itemId} not found in ITEMS registry.`);
      return false;
    }
    for (const inp of r.inputs) {
      if (!getItemById(inp.itemId)) {
        console.error(`[Recipes] ${r.id} input item ${inp.itemId} not found in ITEMS registry.`);
        return false;
      }
    }
  }
  return true;
}
