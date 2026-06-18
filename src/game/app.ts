/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PlayerService } from '../player/player-service';
import { WorldService } from '../world/world-service';
import { BlockService } from '../blocks/block-service';
import { MissionService } from '../missions/mission-service';
import { UiService } from '../ui/ui-service';
import { InputService } from '../player/input-service';

// Placeholders
import { InventoryService } from '../player/inventory-service';
import { CombatService } from './combat-service';
import { FactionService } from './faction-service';
import { CraftingService } from './crafting-service';
import { SaveService } from './save-service';
import { AiService } from './ai-service';
import { EconomyService } from './economy-service';
import { NetworkService } from './network-service';
import { VehicleService } from './vehicle-service';
import { BaseService } from './base-service';
import { ArtifactService } from './artifact-service';
import { WeaponService } from './weapon-service';

/**
 * GameApp - Unified core application bootstrap.
 * Controls lifecycle, schedules updates, and binds all standalone services together.
 */
export class GameApp {
  // Pure Services
  public playerService: PlayerService;
  public worldService: WorldService;
  public blockService: BlockService;
  public missionService: MissionService;
  public uiService: UiService;
  public inputService: InputService;

  // Extension Readiness Placeholders
  public inventoryService: InventoryService;
  public combatService: CombatService;
  public factionService: FactionService;
  public craftingService: CraftingService;
  public saveService: SaveService;
  public aiService: AiService;
  public economyService: EconomyService;
  public networkService: NetworkService;
  public vehicleService: VehicleService;
  public baseService: BaseService;
  public artifactService: ArtifactService;
  public weaponService: WeaponService;

  private isRunning: boolean = false;
  private animFrameId: number | null = null;

  constructor() {
    console.log('[GameApp] Orchestrator loading system layers...');

    // Boot Core Services
    this.playerService = new PlayerService();
    this.worldService = new WorldService();
    this.blockService = new BlockService();
    this.missionService = new MissionService();
    this.uiService = new UiService();
    this.inputService = new InputService(this.playerService);

    // Boot Extension Placeholders
    this.inventoryService = new InventoryService();
    this.combatService = new CombatService();
    this.factionService = new FactionService();
    this.craftingService = new CraftingService();
    this.saveService = new SaveService();
    this.aiService = new AiService();
    this.economyService = new EconomyService();
    this.networkService = new NetworkService();
    this.vehicleService = new VehicleService();
    this.baseService = new BaseService();
    this.artifactService = new ArtifactService();
    this.weaponService = new WeaponService();

    console.log('[GameApp] Dependency injection completed successfully.');
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Start Inputs
    this.inputService.startListening();

    // Start Heartbeat Loop
    this.scheduleTick();

    this.uiService.emitAlert('Frontier Planet descent sequence engaged. Welcome back, contractor.', 'info');
    console.log('[GameApp] Session loop active.');
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    this.inputService.stopListening();
    console.log('[GameApp] Session loop terminated.');
  }

  private scheduleTick = (): void => {
    if (!this.isRunning) return;

    this.tick();
    this.animFrameId = requestAnimationFrame(this.scheduleTick);
  };

  private tick(): void {
    // 1. tick AI systems periodically
    const playerPos = this.playerService.getPosition();
    this.aiService.tickAiAgents(playerPos);

    // 2. any scheduled event triggers
  }

  public restartRaid(): void {
    console.log('[GameApp] Resetting raid environment...');
    this.missionService.resetMission();
    this.playerService.healPlayer(100);
    this.uiService.emitAlert('Re-inserted into Frontier Planet drop-zone. Good luck.', 'info');
  }
}
