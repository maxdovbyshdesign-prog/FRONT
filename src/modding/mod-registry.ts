/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BlockDefinition } from '../types';
import { 
  ModManifest, 
  ModBlockDefinition, 
  ModStructureDefinition, 
  ModPlacementRule, 
  ModUiTheme, 
  ModSoundManifest, 
  ModSkyConfig 
} from './types';

export class ModRegistry {
  private static instance: ModRegistry | null = null;

  public static getInstance(): ModRegistry {
    if (!ModRegistry.instance) {
      ModRegistry.instance = new ModRegistry();
    }
    return ModRegistry.instance;
  }

  private mods: Map<string, ModManifest> = new Map();
  private blocks: Map<string, ModBlockDefinition> = new Map();
  private blockIdToNamespace: Map<number, string> = new Map();
  private namespaceToBlockId: Map<string, number> = new Map();
  private structures: Map<string, ModStructureDefinition> = new Map();
  private structureBlockLookups: Map<string, Map<string, string>> = new Map();
  private placementRules: ModPlacementRule[] = [];
  
  private activeTheme: ModUiTheme = {};
  private activeSky: ModSkyConfig = {};
  private activeSounds: ModSoundManifest = { sounds: [] };

  /**
   * Sources that contributed each active-sky field, for F3 debug readback.
   * Keyed by field name → human-readable source string (mod id / file path).
   */
  private activeSkySources: Record<string, string> = {};

  /**
   * Runtime master toggle for the mod sky overlay. DEFAULT OFF.
   *
   * The old behavior merged ModRegistry.getActiveSky() into the live visual
   * preset every frame, which silently let legacy example-ruins-pack/sky/sky.json
   * (purple #12081f / #3b2630) dominate the built-in presets and turned the
   * world into a purple void. The overlay is now OPT-IN: it only applies when
   * this flag is true, and F3 labels it explicitly.
   */
  private modSkyOverlayEnabled: boolean = false;

  private nextBlockId: number = 10; // Start custom block IDs from 10

  private constructor() {
    console.log('[ModRegistry] Global custom content registry operational.');
  }

  public registerMod(manifest: ModManifest): void {
    this.mods.set(manifest.id, manifest);
    console.log(`[ModRegistry] Registered mod: ${manifest.name} v${manifest.version} by ${manifest.author}`);
  }

  public registerBlock(block: ModBlockDefinition): number {
    if (this.blocks.has(block.id)) {
      console.warn(`[ModRegistry] Warning: Block collision for ${block.id}. Overwriting...`);
    }

    const assignedId = this.nextBlockId++;
    this.blocks.set(block.id, block);
    this.blockIdToNamespace.set(assignedId, block.id);
    this.namespaceToBlockId.set(block.id, assignedId);

    console.log(`[ModRegistry] Registered block. Name: "${block.name}" ID: ${block.id} numeric: ${assignedId}`);
    return assignedId;
  }

  public registerStructure(structure: ModStructureDefinition): void {
    this.structures.set(structure.id, structure);
    const lookup = new Map<string, string>();
    for (const sb of structure.blocks) {
      lookup.set(`${sb.pos[0]},${sb.pos[1]},${sb.pos[2]}`, sb.block);
    }
    this.structureBlockLookups.set(structure.id, lookup);
    console.log(`[ModRegistry] Registered structure prefab: "${structure.name}" [${structure.id}] and compiled O(1) block lookup map.`);
  }

  public getStructureBlock(structureId: string, x: number, y: number, z: number): string | undefined {
    const lookup = this.structureBlockLookups.get(structureId);
    return lookup ? lookup.get(`${x},${y},${z}`) : undefined;
  }

  public registerPlacementRule(rule: ModPlacementRule): void {
    this.placementRules.push(rule);
    console.log(`[ModRegistry] Added procedural placement rule for structure: ${rule.structureId}`);
  }

  public applyUiTheme(theme: ModUiTheme): void {
    this.activeTheme = { ...this.activeTheme, ...theme };
    console.log('[ModRegistry] UI Modded Theme overridden:', this.activeTheme);
  }

  /**
   * Merge a mod sky config into the active overlay. Also records which mod
   * supplied each field so F3 can show "skyColor source: example-ruins-pack".
   * NOTE: this only REGISTERS the overlay — it does NOT enable it. The overlay
   * is applied to the scene only when `setModSkyOverlayEnabled(true)` is called
   * (default OFF). See `modSkyOverlayEnabled`.
   */
  public applySkyConfig(sky: ModSkyConfig, sourceId?: string): void {
    const src = sourceId ?? 'unknown-mod';
    this.activeSky = { ...this.activeSky, ...sky };
    for (const k of Object.keys(sky)) {
      this.activeSkySources[k] = src;
    }
    console.log(`[ModRegistry] Sky overlay registered from "${src}" (overlay is ${this.modSkyOverlayEnabled ? 'ON' : 'OFF'}):`, this.activeSky);
  }

  /** Enable/disable the mod sky overlay at runtime (F3 debug toggle). */
  public setModSkyOverlayEnabled(enabled: boolean): void {
    this.modSkyOverlayEnabled = !!enabled;
    console.log(`[ModRegistry] Mod sky overlay ${this.modSkyOverlayEnabled ? 'ENABLED' : 'DISABLED'}.`);
  }

  /** Whether the mod sky overlay is currently applied to the scene. */
  public isModSkyOverlayEnabled(): boolean {
    return this.modSkyOverlayEnabled;
  }

  /** True if any mod has registered a sky overlay (whether or not it is enabled). */
  public hasModSkyOverlay(): boolean {
    return Object.keys(this.activeSky).length > 0;
  }

  /** Source string per field (e.g. { skyColor: 'example-ruins-pack' }). */
  public getActiveSkySources(): Record<string, string> {
    return { ...this.activeSkySources };
  }

  public registerSounds(sounds: ModSoundManifest): void {
    if (sounds.sounds) {
      this.activeSounds.sounds = [...(this.activeSounds.sounds || []), ...sounds.sounds];
    }
    console.log('[ModRegistry] Active audio registers updated.');
  }

  // Getters
  public getMods(): ModManifest[] {
    return Array.from(this.mods.values());
  }

  public getBlockByNumericId(numericId: number): ModBlockDefinition | undefined {
    const ns = this.blockIdToNamespace.get(numericId);
    return ns ? this.blocks.get(ns) : undefined;
  }

  public getNumericIdByNamespace(namespace: string): number | undefined {
    // If it's a numeric string or we can parse it directly
    if (/^\d+$/.test(namespace)) {
      return parseInt(namespace, 10);
    }
    return this.namespaceToBlockId.get(namespace);
  }

  public getNamespaceByNumericId(numericId: number): string | undefined {
    return this.blockIdToNamespace.get(numericId);
  }

  public getCustomBlockDefinitionsAsCore(): BlockDefinition[] {
    const list: BlockDefinition[] = [];
    this.blocks.forEach((mb, nsId) => {
      const numId = this.namespaceToBlockId.get(nsId);
      if (numId !== undefined) {
        list.push({
          id: numId,
          name: mb.name,
          materialName: mb.materialName,
          color: mb.color,
          solid: mb.solid !== false,
          opaque: mb.opaque !== false,
          baseValue: mb.baseValue || 10,
          description: mb.description,
          tags: mb.tags || [],
          artifactId: mb.artifactId,
          // Preserve data-driven material + light so modded blocks render and
          // illuminate identically to core blocks once registered.
          material: mb.material,
          light: mb.light
        });
      }
    });
    return list;
  }

  public getStructures(): ModStructureDefinition[] {
    return Array.from(this.structures.values());
  }

  public getStructure(id: string): ModStructureDefinition | undefined {
    return this.structures.get(id);
  }

  public getPlacementRules(): ModPlacementRule[] {
    return this.placementRules;
  }

  public getActiveUiTheme(): ModUiTheme {
    return this.activeTheme;
  }

  public getActiveSky(): ModSkyConfig {
    return this.activeSky;
  }

  public getActiveSounds(): ModSoundManifest {
    return this.activeSounds;
  }

  public clearAllCustomRegistrations(): void {
    this.mods.clear();
    this.blocks.clear();
    this.blockIdToNamespace.clear();
    this.namespaceToBlockId.clear();
    this.structures.clear();
    this.structureBlockLookups.clear();
    this.placementRules = [];
    this.activeTheme = {};
    this.activeSky = {};
    this.activeSkySources = {};
    this.modSkyOverlayEnabled = false;
    this.activeSounds = { sounds: [] };
    this.nextBlockId = 10;
  }
}
