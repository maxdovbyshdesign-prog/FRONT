/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ItemStack, InventorySlot } from '../types';
import { getItemById } from '../data/items-data';

/**
 * InventoryService - Governs pack listings, quick-select hotbars,
 * item drag actions, and weight capacity caps.
 *
 * Extended to support the crafting + consumables loop:
 *   - addItem: stacks items respecting maxStack, spills into new slots.
 *   - getCount: total count of an itemId across all slots (for recipe checks).
 *   - hasItems / removeItems: bulk check+consume for crafting inputs.
 *   - consumeItem: use a consumable by itemId (returns the stack consumed).
 *   - getSnapshot: serializable copy for the React inventory UI (polled at 10Hz).
 */
export class InventoryService {
  private slots: InventorySlot[] = [];
  private maxSlots: number = 24;
  private callbacks: (() => void)[] = [];

  constructor() {
    // Populate slots with empty states
    for (let i = 0; i < this.maxSlots; i++) {
      this.slots.push({ slotId: i, stack: null });
    }
    console.log('[InventoryService] Modular 24-slot military pack initialized.');
  }

  public registerOnChange(cb: () => void): () => void {
    this.callbacks.push(cb);
    return () => {
      this.callbacks = this.callbacks.filter(c => c !== cb);
    };
  }

  private notify(): void {
    for (const cb of this.callbacks) cb();
  }

  public addItem(item: ItemStack): boolean {
    const def = getItemById(item.itemId);
    const maxStack = def?.maxStack ?? 64;

    // First, try to stack onto existing slots of the same item.
    let remaining = item.count;
    for (const slot of this.slots) {
      if (remaining <= 0) break;
      if (slot.stack && slot.stack.itemId === item.itemId && slot.stack.type === item.type && slot.stack.count < maxStack) {
        const space = maxStack - slot.stack.count;
        const add = Math.min(space, remaining);
        slot.stack.count += add;
        remaining -= add;
      }
    }
    // Then, place leftovers into free slots.
    while (remaining > 0) {
      const freeSlot = this.slots.find(s => s.stack === null);
      if (!freeSlot) {
        console.warn(`[InventoryService] Pack full — ${remaining}x ${item.itemId} lost.`);
        this.notify();
        return remaining < item.count; // partial success
      }
      const add = Math.min(maxStack, remaining);
      freeSlot.stack = { ...item, count: add };
      remaining -= add;
    }
    this.notify();
    return true;
  }

  /** Total count of an itemId across all slots. */
  public getCount(itemId: string): number {
    return this.slots.reduce((sum, s) => {
      if (s.stack && s.stack.itemId === itemId) return sum + s.stack.count;
      return sum;
    }, 0);
  }

  /** True if the inventory holds at least the requested items. */
  public hasItems(items: ItemStack[]): boolean {
    return items.every(req => this.getCount(req.itemId) >= req.count);
  }

  /** Remove a bulk set of items (for crafting inputs). Returns true if all removed. */
  public removeItems(items: ItemStack[]): boolean {
    if (!this.hasItems(items)) return false;
    for (const req of items) {
      let toRemove = req.count;
      for (const slot of this.slots) {
        if (toRemove <= 0) break;
        if (slot.stack && slot.stack.itemId === req.itemId) {
          const take = Math.min(slot.stack.count, toRemove);
          slot.stack.count -= take;
          toRemove -= take;
          if (slot.stack.count <= 0) slot.stack = null;
        }
      }
    }
    this.notify();
    return true;
  }

  /** Consume one unit of a consumable by itemId. Returns the item def or null. */
  public consumeItem(itemId: string): boolean {
    const def = getItemById(itemId);
    if (!def || def.type !== 'consumable') return false;
    const slot = this.slots.find(s => s.stack && s.stack.itemId === itemId);
    if (!slot || !slot.stack) return false;
    slot.stack.count -= 1;
    if (slot.stack.count <= 0) slot.stack = null;
    this.notify();
    return true;
  }

  public removeItem(slotId: number, countUnits: number): ItemStack | null {
    const slot = this.slots.find(s => s.slotId === slotId);
    if (!slot || !slot.stack) return null;

    if (slot.stack.count <= countUnits) {
      const removed = slot.stack;
      slot.stack = null;
      this.notify();
      return removed;
    } else {
      slot.stack.count -= countUnits;
      this.notify();
      return { ...slot.stack, count: countUnits };
    }
  }

  public getSlots(): InventorySlot[] {
    return this.slots;
  }

  /** Serializable snapshot for the React inventory UI. */
  public getSnapshot(): { slots: InventorySlot[]; usedSlots: number; totalItems: number } {
    let used = 0;
    let total = 0;
    for (const s of this.slots) {
      if (s.stack) {
        used++;
        total += s.stack.count;
      }
    }
    return {
      slots: this.slots.map(s => ({ slotId: s.slotId, stack: s.stack ? { ...s.stack } : null })),
      usedSlots: used,
      totalItems: total,
    };
  }

  /** Debug: give the player a starter kit of resources (QA only). */
  public debugGiveStarterKit(): void {
    this.addItem({ itemId: 'dust_shard', count: 6, type: 'item' });
    this.addItem({ itemId: 'metal_scrap', count: 4, type: 'item' });
    this.addItem({ itemId: 'crystal_shard', count: 1, type: 'item' });
  }
}

