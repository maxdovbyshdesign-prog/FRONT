/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ItemStack, InventorySlot } from '../types';

/**
 * InventoryService - Governs pack listings, quick-select hotbars,
 * item drag actions, and weight capacity caps.
 */
export class InventoryService {
  private slots: InventorySlot[] = [];
  private maxSlots: number = 24;

  constructor() {
    // Populate slots with empty states
    for (let i = 0; i < this.maxSlots; i++) {
      this.slots.push({ slotId: i, stack: null });
    }
    console.log('[InventoryService] Modular 24-slot military pack initialized.');
  }

  public addItem(item: ItemStack): boolean {
    const existing = this.slots.find(s => s.stack !== null && s.stack.itemId === item.itemId && s.stack.type === item.type);
    if (existing && existing.stack) {
      existing.stack.count += item.count;
      console.log(`[InventoryService] Stacked +${item.count} to slot ${existing.slotId}.`);
      return true;
    }

    const freeSlot = this.slots.find(s => s.stack === null);
    if (freeSlot) {
      freeSlot.stack = { ...item };
      console.log(`[InventoryService] Lodged stack ${item.itemId} (count: ${item.count}) to slot ${freeSlot.slotId}.`);
      return true;
    }

    console.log('[InventoryService] Backpack storage maxed out! Extraction required.');
    return false;
  }

  public removeItem(slotId: number, countUnits: number): ItemStack | null {
    const slot = this.slots.find(s => s.slotId === slotId);
    if (!slot || !slot.stack) return null;

    if (slot.stack.count <= countUnits) {
      const removed = slot.stack;
      slot.stack = null;
      console.log(`[InventoryService] Emptied slot ${slotId}.`);
      return removed;
    } else {
      slot.stack.count -= countUnits;
      console.log(`[InventoryService] Extracted ${countUnits} units from slot ${slotId}.`);
      return { ...slot.stack, count: countUnits };
    }
  }

  public getSlots(): InventorySlot[] {
    return this.slots;
  }
}
