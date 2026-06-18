/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AiAgent } from '../types';

/**
 * AiService - Coordinates goal seeking, sensory alerts, and pathfinding
 * schedules for ancient guardian sentries and rival PMC mercenaries.
 */
export class AiService {
  private activeAgents: Map<string, AiAgent> = new Map();

  constructor() {
    console.log('[AiService] Combat heuristic network active.');
  }

  public registerAgent(agent: AiAgent): void {
    this.activeAgents.set(agent.entityId, agent);
  }

  public tickAiAgents(playerPosition: [number, number, number]): void {
    this.activeAgents.forEach((agent) => {
      // Direct behavior trees go here in the future
      const dist = this.getDistance(playerPosition, [0, 0, 0]); // dummy calc
      if (dist < 10) {
        agent.state = 'COMBAT';
        agent.goal = 'Neutralize trespasser';
      } else {
        agent.state = 'PATROL';
        agent.goal = 'Maintain security perimeter';
      }
    });
  }

  private getDistance(a: number[], b: number[]): number {
    return Math.sqrt(
      Math.pow(a[0] - b[0], 2) +
      Math.pow(a[1] - b[1], 2) +
      Math.pow(a[2] - b[2], 2)
    );
  }
}
