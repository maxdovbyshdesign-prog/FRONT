/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Item definitions for FRONTIER PLANET.
 *
 * Two categories:
 *   - resources: raw materials obtained by mining blocks (dust, stone, metal, crystal).
 *   - consumables: crafted items that restore survival vitals or health when used.
 *
 * The crafting loop connects mining → resources → crafted consumables → restoring
 * the SurvivalService vitals (hydration / radiation / oxygen / stamina / health),
 * making the survival system interactive: the player MUST craft to survive long
 * expeditions, especially at night when radiation rises.
 */

export type ItemType = 'resource' | 'consumable';

export interface ItemDefinition {
  id: string;
  name: string;
  type: ItemType;
  /** Short flavor description for the inventory tooltip. */
  description: string;
  /** Tailwind/hex color for the inventory icon swatch. */
  color: string;
  /** Icon glyph (single emoji or short string) shown in the slot. */
  glyph: string;
  /** For consumables: the effect applied on use. */
  effect?: {
    health?: number;
    stamina?: number;
    oxygen?: number;
    hydration?: number;
    radiation?: number; // negative = reduces radiation
  };
  /** Max stack size in one inventory slot. */
  maxStack: number;
  /** Base credit value (for future economy / extraction reward). */
  value: number;
}

export const ITEMS: ItemDefinition[] = [
  // ---- Resources (from mining) ----
  {
    id: 'dust_shard',
    name: 'Dust Shard',
    type: 'resource',
    description: 'Crystalline red dust. Refines into filtration substrate and ration binder.',
    color: '#c0392b',
    glyph: '◆',
    maxStack: 64,
    value: 5,
  },
  {
    id: 'stone_chunk',
    name: 'Stone Chunk',
    type: 'resource',
    description: 'Ancient compressed stone. Building material and furnace feedstock.',
    color: '#7f8c8d',
    glyph: '◼',
    maxStack: 64,
    value: 3,
  },
  {
    id: 'metal_scrap',
    name: 'Metal Scrap',
    type: 'resource',
    description: 'Salvaged alloy plating. Workbench-grade fabrication feedstock.',
    color: '#bdc3c7',
    glyph: '⬢',
    maxStack: 64,
    value: 12,
  },
  {
    id: 'crystal_shard',
    name: 'Crystal Shard',
    type: 'resource',
    description: 'Resonant quantum crystal from artifact blocks. Rad-X precursor.',
    color: '#9b59b6',
    glyph: '✦',
    maxStack: 32,
    value: 40,
  },

  // ---- Consumables (crafted) ----
  {
    id: 'water_flask',
    name: 'Water Flask',
    type: 'consumable',
    description: 'Filtered hydration flask. Restores +40 hydration.',
    color: '#3498db',
    glyph: '🥤',
    maxStack: 8,
    value: 25,
    effect: { hydration: 40 },
  },
  {
    id: 'rad_x',
    name: 'Rad-X Injector',
    type: 'consumable',
    description: 'Anti-radiation auto-injector. Reduces radiation by 50.',
    color: '#8e44ad',
    glyph: '💉',
    maxStack: 8,
    value: 60,
    effect: { radiation: -50 },
  },
  {
    id: 'oxygen_canister',
    name: 'O₂ Canister',
    type: 'consumable',
    description: 'Compressed oxygen tank. Restores +60 oxygen for cave diving.',
    color: '#1abc9c',
    glyph: '🛢',
    maxStack: 8,
    value: 45,
    effect: { oxygen: 60 },
  },
  {
    id: 'energy_bar',
    name: 'Energy Bar',
    type: 'consumable',
    description: 'Dense ration bar. Restores +30 stamina instantly.',
    color: '#f39c12',
    glyph: '🍫',
    maxStack: 8,
    value: 20,
    effect: { stamina: 30 },
  },
  {
    id: 'medkit',
    name: 'Field Medkit',
    type: 'consumable',
    description: 'Nanite repair pack. Restores +40 health.',
    color: '#e74c3c',
    glyph: '✚',
    maxStack: 4,
    value: 80,
    effect: { health: 40 },
  },
];

const ITEM_MAP: Record<string, ItemDefinition> = Object.fromEntries(
  ITEMS.map(i => [i.id, i])
);

export function getItemById(id: string): ItemDefinition | undefined {
  return ITEM_MAP[id];
}

/**
 * Block → resource drop table. When a block is destroyed, the adapter rolls
 * these drops and adds them to the InventoryService. The block IDs match
 * src/data/blocks-data.ts.
 */
export interface BlockDrop {
  itemId: string;
  /** Guaranteed drop count (min). */
  min: number;
  /** Additional random drop count (max added on top of min). */
  max: number;
}

export const BLOCK_DROPS: Record<number, BlockDrop[]> = {
  1: [{ itemId: 'dust_shard', min: 1, max: 2 }],        // Red Dust
  2: [{ itemId: 'stone_chunk', min: 1, max: 1 }],       // Black Glass
  3: [{ itemId: 'metal_scrap', min: 1, max: 2 }],       // Metal Floor
  4: [{ itemId: 'stone_chunk', min: 1, max: 2 }],       // Ancient Stone
  5: [{ itemId: 'crystal_shard', min: 1, max: 1 }],     // Glowing Artifact Block
};
