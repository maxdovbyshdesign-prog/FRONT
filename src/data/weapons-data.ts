/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { WeaponDefinition } from '../types';

export const WEAPONS: WeaponDefinition[] = [
  {
    id: 'carbine_fp4',
    name: 'FP-4 "Frontier" Carbine',
    type: 'carbine',
    baseStats: {
      damage: 18,
      fireRate: 600,
      accuracy: 82,
      range: 45
    },
    allowedAttachments: ['extended_mag', 'silencer', 'holo_sight'],
    description: 'Rugged kinetic assault carbine chambered in 6.5mm caseless. Reliability is its primary sales feature.'
  },
  {
    id: 'plasma_cutter',
    name: 'A-12 Plasma Mining Tool',
    type: 'heavy',
    baseStats: {
      damage: 35,
      fireRate: 80,
      accuracy: 95,
      range: 15
    },
    allowedAttachments: ['focus_lens', 'overcharge_coil'],
    description: 'Industrial laser modified to discharge high-energy plasma bolts. Capable of slicing through rock or power armor.'
  }
];
