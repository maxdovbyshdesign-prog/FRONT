/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { MissionDefinition, Objective, GameEvent, GameEventType, MissionEventResult } from '../types';
import { gameState } from '../game/game-state';

/**
 * MissionService - Coordinates quest metrics, completion status,
 * extraction coordinates, and rewards.
 */
export class MissionService {
  private activeMission: MissionDefinition | null = null;
  private isArtifactRecoveredState: boolean = false;
  private isExtractedState: boolean = false;
  private onStateChangeCallbacks: (() => void)[] = [];

  constructor() {
    this.initializeDefaultMission();
    console.log('[MissionService] Extraction contract board initialized.');
  }

  private initializeDefaultMission(): void {
    const objectives: Objective[] = [
      {
        id: 'retrieve_core',
        type: 'locate_artifact',
        text: 'Retrieve the Glowing Artifact Block inside the ancient monument.',
        currentCount: 0,
        targetCount: 1,
        isCompleted: false
      },
      {
        id: 'extract_safely',
        type: 'reach_extraction',
        text: 'Return to the landing site extraction circle near spawn.',
        currentCount: 0,
        targetCount: 1,
        isCompleted: false
      }
    ];

    this.activeMission = {
      id: 'frontier_salvage',
      title: 'FIRST DESCENT: ANOMALOUS RETRIEVAL',
      description: 'Find the glowing quantum artifact block inside the half-buried monument and return it safely to the landing zone.',
      objectives,
      baseReward: 7500
    };
  }

  public getActiveMission(): MissionDefinition | null {
    return this.activeMission;
  }

  public isArtifactRecovered(): boolean {
    return this.isArtifactRecoveredState;
  }

  public isExtracted(): boolean {
    return this.isExtractedState;
  }

  /**
   * Main game event handler for clean mission decoupling.
   * Processes BLOCK_DESTROYED, PLAYER_POSITION_CHANGED, etc. and computes mission progress.
   */
  public handleGameEvent(event: GameEvent): MissionEventResult[] {
    const alerts: MissionEventResult[] = [];

    switch (event.type) {
      case GameEventType.BLOCK_DESTROYED: {
        const { blockId, blockTags, artifactId } = event.payload;
        const isArtifactBlock = (blockTags && blockTags.includes('artifact')) || (blockId === 5);
        const resolvedArtifactId = artifactId || (blockId === 5 ? 'epsilon_glowing_core' : null);
        
        // If block has artifact tag, we trigger artifact recovery
        if (isArtifactBlock && resolvedArtifactId) {
          if (!this.isArtifactRecoveredState) {
            this.isArtifactRecoveredState = true;
            
            if (!gameState.recoveredArtifacts.includes(resolvedArtifactId)) {
              gameState.recoveredArtifacts.push(resolvedArtifactId);
            }
            
            if (this.activeMission) {
              const obj = this.activeMission.objectives.find(o => o.id === 'retrieve_core');
              if (obj) {
                obj.currentCount = 1;
                obj.isCompleted = true;
                gameState.missionState.objectivesProgress.retrieve_core = 1;
              }
            }
            alerts.push({
              alertText: 'Artifact recovered! Return to extraction pad at spawn.',
              alertType: 'success'
            });
            this.notifyListeners();
          }
        }
        break;
      }

      case GameEventType.PLAYER_POSITION_CHANGED: {
        const [px, py, pz] = event.payload.position;
        
        // Check artifact rescue distance (as a fallback/alternate method of recovery if needed)
        if (!this.isArtifactRecoveredState) {
          // Ancient monument coordinates are [-20, 14, -20]
          const rx = -20, ry = 14, rz = -20;
          const distToRuin = Math.sqrt(
            Math.pow(px - rx, 2) + Math.pow(py - ry, 2) + Math.pow(pz - rz, 2)
          );
          if (distToRuin < 2.8) {
            this.isArtifactRecoveredState = true;
            const artifactIdValue = 'epsilon_glowing_core';
            
            if (!gameState.recoveredArtifacts.includes(artifactIdValue)) {
              gameState.recoveredArtifacts.push(artifactIdValue);
            }

            if (this.activeMission) {
              const obj = this.activeMission.objectives.find(o => o.id === 'retrieve_core');
              if (obj) {
                obj.currentCount = 1;
                obj.isCompleted = true;
                gameState.missionState.objectivesProgress.retrieve_core = 1;
              }
            }
            alerts.push({
              alertText: 'Artifact recovered! Return to extraction pad at spawn.',
              alertType: 'success'
            });
            this.notifyListeners();
          }
        }

        // Check if player entered the landing pad extraction circle near spawn [0, 12, 0]
        if (this.isArtifactRecoveredState && !this.isExtractedState) {
          const distToSpawn = Math.sqrt(px * px + pz * pz);
          // Radius is 8m and landing pad altitude is ~12 (checking py >= 11.5)
          if (distToSpawn <= 8 && py >= 11.5) {
            this.isExtractedState = true;
            gameState.extracted = true;

            if (this.activeMission) {
              const obj = this.activeMission.objectives.find(o => o.id === 'extract_safely');
              if (obj) {
                obj.currentCount = 1;
                obj.isCompleted = true;
                gameState.missionState.objectivesProgress.extract_safely = 1;
              }
            }
            alerts.push({
              alertText: 'Extraction sequence complete. Contract secured!',
              alertType: 'success'
            });
            this.notifyListeners();
          }
        }
        break;
      }

      case GameEventType.ARTIFACT_RECOVERED: {
        const { artifactId } = event.payload;
        if (!this.isArtifactRecoveredState) {
          this.isArtifactRecoveredState = true;
          
          if (!gameState.recoveredArtifacts.includes(artifactId)) {
            gameState.recoveredArtifacts.push(artifactId);
          }

          if (this.activeMission) {
            const obj = this.activeMission.objectives.find(o => o.id === 'retrieve_core');
            if (obj) {
              obj.currentCount = 1;
              obj.isCompleted = true;
              gameState.missionState.objectivesProgress.retrieve_core = 1;
            }
          }
          alerts.push({
            alertText: 'Artifact recovered! Return to extraction pad at spawn.',
            alertType: 'success'
          });
          this.notifyListeners();
        }
        break;
      }

      case GameEventType.PLAYER_ENTERED_EXTRACTION_ZONE: {
        if (this.isArtifactRecoveredState && !this.isExtractedState) {
          this.isExtractedState = true;
          gameState.extracted = true;

          if (this.activeMission) {
            const obj = this.activeMission.objectives.find(o => o.id === 'extract_safely');
            if (obj) {
              obj.currentCount = 1;
              obj.isCompleted = true;
              gameState.missionState.objectivesProgress.extract_safely = 1;
            }
          }
          alerts.push({
            alertText: 'Extraction sequence complete. Contract secured!',
            alertType: 'success'
          });
          this.notifyListeners();
        }
        break;
      }

      default:
        break;
    }

    return alerts;
  }

  // Backwards compat check
  public recoverArtifact(): void {
    const res = this.handleGameEvent({
      type: GameEventType.ARTIFACT_RECOVERED,
      payload: { artifactId: 'epsilon_glowing_core', blockId: 5 },
      timestamp: Date.now()
    });
  }

  // Backwards compat check
  public enterExtractionZone(): boolean {
    const res = this.handleGameEvent({
      type: GameEventType.PLAYER_ENTERED_EXTRACTION_ZONE,
      payload: { position: [0, 12, 0], radius: 8 },
      timestamp: Date.now()
    });
    return this.isExtractedState;
  }

  public registerOnStateChange(callback: () => void): () => void {
    this.onStateChangeCallbacks.push(callback);
    return () => {
      this.onStateChangeCallbacks = this.onStateChangeCallbacks.filter(item => item !== callback);
    };
  }

  private notifyListeners(): void {
    this.onStateChangeCallbacks.forEach(cb => cb());
  }

  public resetMission(): void {
    this.isArtifactRecoveredState = false;
    this.isExtractedState = false;
    
    // reset central state
    gameState.recoveredArtifacts = [];
    gameState.extracted = false;
    gameState.missionState.objectivesProgress.retrieve_core = 0;
    gameState.missionState.objectivesProgress.extract_safely = 0;

    this.initializeDefaultMission();
    this.notifyListeners();
  }
}
