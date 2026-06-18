/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ArtifactDefinition } from '../types';

export const ARTIFACTS: ArtifactDefinition[] = [
  {
    id: 'epsilon_glowing_core',
    name: 'Epsilon Quantum Core',
    rarity: 'ancient',
    risk: 45,
    baseValue: 1250,
    effects: ['Quantum flux anomaly', 'Bio-hazard heat emissions'],
    containmentRequirement: 'Lead-lined vacuum capsule',
    description: 'A glowing structural pillar recovered from the center of ancient ruins.'
  }
];

export function getArtifactById(id: string): ArtifactDefinition | undefined {
  return ARTIFACTS.find(a => a.id === id);
}
