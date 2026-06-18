/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Faction } from '../types';

export const FACTIONS: Faction[] = [
  {
    id: 'apex_mining_corp',
    name: 'Apex Resource Corporation',
    description: 'Ruthless interstellar conglomerate with heavily armed private security. They view the planets resources as their exclusive property.',
    standing: 0
  },
  {
    id: 'ancient_guardians',
    name: 'Aether Vigil Defense Grid',
    description: 'Dormant automatons and ancient defense systems that react violently to anyone attempting to harvest glowing artifacts.',
    standing: -80
  },
  {
    id: 'frontier_smugglers',
    name: 'Sol-Scavenger Cartel',
    description: 'Smugglers, black market merchants, and rogue ship captains willing to trade high-grade gear for rare alien tech.',
    standing: 15
  }
];
