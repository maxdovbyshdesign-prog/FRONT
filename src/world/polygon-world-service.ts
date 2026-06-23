/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * PolygonWorldService — deterministic flatworld for dev/testing.
 *
 * Flat terrain at constant height, chunk border markers, lighting test stations.
 * No noise, no hills, no ruins — just a clean test environment.
 */

import { VoxelPosition } from '../types';
import { gameState } from '../game/game-state';

/** Ground height for the flatworld. */
const GROUND_Y = 8;
/** Test area radius (128×128 around origin). */
const TEST_RADIUS = 64;

/** Station definitions — predictable coordinates for each test. */
export interface PolygonStation {
  id: string;
  name: string;
  pos: [number, number, number];
  description: string;
}

export const POLYGON_STATIONS: PolygonStation[] = [
  { id: 'center', name: 'Center Light', pos: [0, GROUND_Y + 1, 0], description: 'Light source in center of chunk 0,0,0' },
  { id: 'x_border', name: 'X Border Light', pos: [15, GROUND_Y + 1, 0], description: 'Light at X chunk border (x=15/16)' },
  { id: 'z_border', name: 'Z Border Light', pos: [0, GROUND_Y + 1, 15], description: 'Light at Z chunk border (z=15/16)' },
  { id: 'corner', name: 'Corner Light', pos: [15, GROUND_Y + 1, 15], description: 'Light at 4-chunk corner' },
  { id: 'negative', name: 'Negative Coords Light', pos: [-20, GROUND_Y + 1, -20], description: 'Light in negative X/Z chunks' },
  { id: 'wall', name: 'Wall Lamp Test', pos: [32, GROUND_Y + 1, 0], description: 'Vertical wall with light' },
  { id: 'floor', name: 'Floor Light Test', pos: [0, GROUND_Y + 1, 32], description: 'Light on floor' },
  { id: 'tunnel', name: 'Tunnel/Dark Box', pos: [-32, GROUND_Y + 1, 0], description: 'Enclosed box for darkness test' },
  { id: 'fog', name: 'Fog Test Zone', pos: [0, GROUND_Y + 1, 48], description: 'Fog testing area' },
];

export class PolygonWorldService {
  private extractionCenter: [number, number] = [0, 0];
  private extractionRadius: number = 8;

  constructor() {
    console.log('[PolygonWorldService] Flatworld test environment initialized.');
  }

  public setBlockOverride(x: number, y: number, z: number, blockId: number): void {
    const key = `${x},${y},${z}`;
    gameState.changedBlocks.set(key, blockId);
  }

  public getBlockAt(x: number, y: number, z: number): number {
    const key = `${x},${y},${z}`;
    if (gameState.changedBlocks.has(key)) {
      return gameState.changedBlocks.get(key)!;
    }

    // Below ground = solid (block 1 = red dust)
    if (y < GROUND_Y) return 1;
    // Ground level = solid
    if (y === GROUND_Y) {
      // Chunk border markers — darker blocks every 16 blocks
      const localX = ((x % 16) + 16) % 16;
      const localZ = ((z % 16) + 16) % 16;
      if (localX === 0 || localX === 15 || localZ === 0 || localZ === 15) {
        return 4; // Ancient Stone (darker) for border markers
      }
      return 1; // Red Dust
    }
    // Above ground = air
    return 0;
  }

  public getExtractionBounds() {
    return { center: this.extractionCenter, radius: this.extractionRadius };
  }

  public getRuinCenter(): VoxelPosition {
    return [0, GROUND_Y, 0]; // No ruins in Polygon
  }

  public getStaticLightSources(): { pos: VoxelPosition; blockId: number }[] {
    // Place static light blocks at test stations
    return [
      { pos: [0, GROUND_Y + 1, 0], blockId: 6 },      // Center: Industrial Wall Lamp
      { pos: [15, GROUND_Y + 1, 0], blockId: 7 },      // X Border: Halogen Work Light
      { pos: [0, GROUND_Y + 1, 15], blockId: 8 },      // Z Border: Planetary Beacon
      { pos: [15, GROUND_Y + 1, 15], blockId: 6 },      // Corner: Industrial Wall Lamp
      { pos: [-20, GROUND_Y + 1, -20], blockId: 7 },   // Negative: Halogen Work Light
    ];
  }

  public isBlackGlassZone(_x: number, _z: number): boolean {
    return false; // No biome variation in Polygon
  }

  public getStation(id: string): PolygonStation | undefined {
    return POLYGON_STATIONS.find(s => s.id === id);
  }

  public getStations(): PolygonStation[] {
    return POLYGON_STATIONS;
  }
}
