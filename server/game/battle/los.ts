// Stage 5c: line of sight, movement checks, reachable hexes (BFS).
// Pure functions — no actions, no state mutation.

import {
  hexDistance,
  hexEquals,
  hexKey,
  hexNeighbors,
  hexToCube,
  cubeToHex,
  cubeRound,
  hexLerpCube,
  type HexCoord,
} from './hex';
import type { Obstacle } from './state';

export function inBounds(hex: HexCoord, mapWidth: number, mapHeight: number): boolean {
  return hex.q >= 0 && hex.q < mapWidth && hex.r >= 0 && hex.r < mapHeight;
}

// All hexes the line between the centers of `from` and `to` passes through,
// endpoints excluded. Endpoints are nudged by a tiny epsilon so that a line
// passing exactly through a hex corner rounds deterministically.
export function lineHexes(from: HexCoord, to: HexCoord): HexCoord[] {
  const n = hexDistance(from, to);
  if (n <= 1) return [];
  const EPS = 1e-6;
  const a = hexToCube(from);
  const b = hexToCube(to);
  const result: HexCoord[] = [];
  for (let i = 1; i < n; i++) {
    const t = (i + EPS) / n;
    result.push(cubeToHex(cubeRound(hexLerpCube(a, b, t))));
  }
  return result;
}

export function hasLineOfSight(params: {
  from: HexCoord;
  to: HexCoord;
  obstacles: Obstacle[];
  mapWidth: number;
  mapHeight: number;
}): boolean {
  const { from, to, obstacles, mapWidth, mapHeight } = params;
  if (hexEquals(from, to)) return true;
  // Shooting outside the map is not allowed.
  if (!inBounds(from, mapWidth, mapHeight) || !inBounds(to, mapWidth, mapHeight)) {
    return false;
  }
  const blocking = new Set(
    obstacles.filter((o) => o.blocksLos).map((o) => hexKey(o.hex)),
  );
  // `from` and `to` themselves never block — the shooter and the target do
  // not obstruct themselves; only intermediate hexes are checked.
  for (const hex of lineHexes(from, to)) {
    if (!inBounds(hex, mapWidth, mapHeight)) return false;
    if (blocking.has(hexKey(hex))) return false;
  }
  return true;
}

export type MoveCheckResult =
  | { ok: true }
  | { ok: false; reason: 'out_of_bounds' | 'blocked' | 'occupied' | 'not_adjacent' };

export function canMoveTo(params: {
  from: HexCoord;
  to: HexCoord;
  obstacles: Obstacle[];
  occupiedHexes: HexCoord[];
  mapWidth: number;
  mapHeight: number;
}): MoveCheckResult {
  const { from, to, obstacles, occupiedHexes, mapWidth, mapHeight } = params;
  if (!inBounds(to, mapWidth, mapHeight)) {
    return { ok: false, reason: 'out_of_bounds' };
  }
  if (obstacles.some((o) => o.blocksMove && hexEquals(o.hex, to))) {
    return { ok: false, reason: 'blocked' };
  }
  if (occupiedHexes.some((h) => hexEquals(h, to))) {
    return { ok: false, reason: 'occupied' };
  }
  if (hexDistance(from, to) !== 1) {
    return { ok: false, reason: 'not_adjacent' };
  }
  return { ok: true };
}

// BFS over passable hexes within maxSteps. The start hex is not included.
export function reachableHexes(params: {
  from: HexCoord;
  maxSteps: number;
  obstacles: Obstacle[];
  occupiedHexes: HexCoord[];
  mapWidth: number;
  mapHeight: number;
}): Set<string> {
  const { from, maxSteps, obstacles, occupiedHexes, mapWidth, mapHeight } = params;
  const blocked = new Set(
    obstacles.filter((o) => o.blocksMove).map((o) => hexKey(o.hex)),
  );
  for (const h of occupiedHexes) blocked.add(hexKey(h));

  const visited = new Set<string>([hexKey(from)]);
  const result = new Set<string>();
  let frontier: HexCoord[] = [from];
  for (let step = 0; step < maxSteps; step++) {
    const next: HexCoord[] = [];
    for (const hex of frontier) {
      for (const nb of hexNeighbors(hex)) {
        const key = hexKey(nb);
        if (visited.has(key)) continue;
        if (!inBounds(nb, mapWidth, mapHeight)) continue;
        if (blocked.has(key)) continue;
        visited.add(key);
        result.add(key);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return result;
}
