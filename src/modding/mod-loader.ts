/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ModRegistry } from './mod-registry';
import { 
  ModManifest, 
  ModBlockDefinition, 
  ModStructureDefinition, 
  ModPlacementRule, 
  ModUiTheme, 
  ModSoundManifest, 
  ModSkyConfig 
} from './types';

export class ModLoader {
  private registry: ModRegistry;

  constructor() {
    this.registry = ModRegistry.getInstance();
  }

  /**
   * Discovers and loads multiple active mods using fetch
   */
  public async loadAllActiveMods(): Promise<void> {
    console.log('[ModLoader] Scan sequence initiated...');
    this.registry.clearAllCustomRegistrations();

    let modFolders: string[] = ['example-ruins-pack'];

    try {
      // Attempt to load the active mods list checklist
      const resp = await fetch('./mods/mod-list.json');
      if (resp.ok) {
        modFolders = await resp.json();
        console.log(`[ModLoader] Discovered ${modFolders.length} mod folder list from mod-list.json`);
      } else {
        console.warn('[ModLoader] mod-list.json not found, falling back to default example-ruins-pack');
      }
    } catch (e) {
      console.warn('[ModLoader] Failed to fetch mod-list.json. Falling back to defaults.', e);
    }

    for (const folderName of modFolders) {
      try {
        await this.loadMod(folderName);
      } catch (err) {
        console.error(`[ModLoader] Critical error loading mod folder "${folderName}":`, err);
      }
    }
  }

  private async loadMod(folderName: string): Promise<void> {
    const basePath = `./mods/${folderName}`;
    const manifestPath = `${basePath}/mod.json`;

    console.log(`[ModLoader] Fetching manifest at: ${manifestPath}`);
    const resp = await fetch(manifestPath);
    if (!resp.ok) {
      throw new Error(`Manifest load failed with status: ${resp.status}`);
    }

    const manifest: ModManifest = await resp.json();
    this.validateManifest(manifest);
    this.registry.registerMod(manifest);

    const content = manifest.content;

    // 1. Load blocks if declared
    if (content.blocks) {
      for (const relPath of content.blocks) {
        try {
          const blocksUrl = `${basePath}/${relPath}`;
          const blockResp = await fetch(blocksUrl);
          if (blockResp.ok) {
            const data = await blockResp.json();
            const blocksList: ModBlockDefinition[] = Array.isArray(data) ? data : (data.blocks || []);
            for (const block of blocksList) {
              if (this.validateBlock(block)) {
                this.registry.registerBlock(block);
              }
            }
          }
        } catch (e) {
          console.warn(`[ModLoader] Block load failure at ${relPath}:`, e);
        }
      }
    }

    // 2. Load structures
    if (content.structures) {
      for (const relPath of content.structures) {
        try {
          const structUrl = `${basePath}/${relPath}`;
          const structResp = await fetch(structUrl);
          if (structResp.ok) {
            const struct: ModStructureDefinition = await structResp.json();
            if (this.validateStructure(struct)) {
              this.registry.registerStructure(struct);
            }
          }
        } catch (e) {
          console.warn(`[ModLoader] Structure load failure at ${relPath}:`, e);
        }
      }
    }

    // 3. Load placement rules
    if (content.placement) {
      for (const relPath of content.placement) {
        try {
          const placementUrl = `${basePath}/${relPath}`;
          const placementResp = await fetch(placementUrl);
          if (placementResp.ok) {
            const data = await placementResp.json();
            const list: ModPlacementRule[] = Array.isArray(data) ? data : (data.placements || []);
            for (const rule of list) {
              this.registry.registerPlacementRule(rule);
            }
          }
        } catch (e) {
          console.warn(`[ModLoader] Placement load failure at ${relPath}:`, e);
        }
      }
    }

    // 4. Load UI themes
    if (content.uiThemes) {
      for (const relPath of content.uiThemes) {
        try {
          const themeUrl = `${basePath}/${relPath}`;
          const themeResp = await fetch(themeUrl);
          if (themeResp.ok) {
            const theme: ModUiTheme = await themeResp.json();
            this.registry.applyUiTheme(theme);
          }
        } catch (e) {
          console.warn(`[ModLoader] UI Theme load failure at ${relPath}:`, e);
        }
      }
    }

    // 5. Load sounds
    if (content.sounds) {
      for (const relPath of content.sounds) {
        try {
          const soundsUrl = `${basePath}/${relPath}`;
          const soundsResp = await fetch(soundsUrl);
          if (soundsResp.ok) {
            const soundsManifest: ModSoundManifest = await soundsResp.json();
            this.registry.registerSounds(soundsManifest);
          }
        } catch (e) {
          console.warn(`[ModLoader] Sound manifest load failure at ${relPath}:`, e);
        }
      }
    }

    // 6. Load Sky settings
    if (content.sky) {
      for (const relPath of content.sky) {
        try {
          const skyUrl = `${basePath}/${relPath}`;
          const skyResp = await fetch(skyUrl);
          if (skyResp.ok) {
            const skyConfig: ModSkyConfig = await skyResp.json();
            this.registry.applySkyConfig(skyConfig);
          }
        } catch (e) {
          console.warn(`[ModLoader] Sky config load failure at ${relPath}:`, e);
        }
      }
    }
  }

  private validateManifest(m: any): void {
    if (!m.id || !m.name || !m.version || !m.content) {
      throw new Error('Invalid manifest formatting. ID, Name, Version, and Content schema required.');
    }
  }

  private validateBlock(b: any): boolean {
    if (!b.id || !b.name || !b.materialName || !b.color) {
      console.warn('[ModLoader] Block validation failed (missing critical parameters):', b);
      return false;
    }
    if (!Array.isArray(b.color) || b.color.length !== 3) {
      console.warn('[ModLoader] Block color must be RGB array of 3 numbers:', b);
      return false;
    }
    return true;
  }

  private validateStructure(s: any): boolean {
    if (!s.id || !s.name || !s.size || !s.blocks || !Array.isArray(s.blocks)) {
      console.warn('[ModLoader] Structure validation failed:', s);
      return false;
    }
    return true;
  }
}
