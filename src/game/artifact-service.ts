/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ArtifactDefinition } from '../types';
import { ARTIFACTS } from '../data/artifacts-data';

/**
 * ArtifactService - Governs high-hazard anomalous items, containment
 * constraints, and chemical mutations.
 */
export class ArtifactService {
  private activeArtifacts: Map<string, ArtifactDefinition> = new Map();

  constructor() {
    // Seed artifacts
    ARTIFACTS.forEach(a => {
      this.activeArtifacts.set(a.id, a);
    });
    console.log('[ArtifactService] Anomaly registers synced.');
  }

  public getArtifactDefinition(artifactId: string): ArtifactDefinition | undefined {
    return this.activeArtifacts.get(artifactId);
  }

  public getRadiativeOutput(artifactId: string): number {
    const art = this.getArtifactDefinition(artifactId);
    if (!art) return 0;
    // Calculate radiation risk based on rarity/risk attributes
    return art.risk * 0.8;
  }
}
