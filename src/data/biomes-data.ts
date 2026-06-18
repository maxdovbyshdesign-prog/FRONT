/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BiomeDefinition } from '../types';

export const BIOMES: BiomeDefinition[] = [
  {
    id: 'red_wasteland',
    name: 'Red Wasteland Dust',
    description: 'Arid dunes of oxygenated iron dust swept by carbon storms.',
    groundBlockId: 1, // Red Dust
    subBlockId: 2,    // Black Glass
    ruinBlockId: 4,   // Ancient Stone
  }
];

export function getBiomeById(id: string): BiomeDefinition | undefined {
  return BIOMES.find(b => b.id === id);
}
