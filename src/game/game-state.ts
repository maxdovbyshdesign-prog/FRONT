/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { VoxelPosition } from '../types';
import type { SurvivalSnapshot } from '../player/survival-service';

export interface GameState {
  playerPosition: VoxelPosition;
  selectedBlockId: number;
  targetedBlockInfo: string;
  playerYaw: number;
  missionState: {
    activeMissionId: string;
    objectivesProgress: Record<string, number>; // id override -> count
  };
  recoveredArtifacts: string[]; // e.g., ["epsilon_glowing_core"]
  extracted: boolean;
  worldSeed: number;
  changedBlocks: Map<string, number>; // key: "x,y,z" -> blockId
  /** Survival vitals snapshot, mirrored by SurvivalService each tick for the HUD. */
  survival: SurvivalSnapshot;
}

export const gameState: GameState = {
  playerPosition: [0, 15, 0],
  selectedBlockId: 1,
  targetedBlockInfo: 'None',
  playerYaw: 0,
  missionState: {
    activeMissionId: 'frontier_salvage',
    objectivesProgress: {
      retrieve_core: 0,
      extract_safely: 0,
    },
  },
  recoveredArtifacts: [],
  extracted: false,
  worldSeed: 12345,
  changedBlocks: new Map<string, number>(),
  survival: {
    stamina: 100,
    oxygen: 100,
    hydration: 100,
    radiation: 0,
    status: 'nominal',
    canSprint: true,
    lowStamina: false,
    lowOxygen: false,
    lowHydration: false,
    highRadiation: false,
  },
};
