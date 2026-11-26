// Stage 5e: mob AI — pure decisions, no side effects, RNG is injected.
// The engine applies the decisions inside runEnemyTurn.

import { hexDistance, hexKey, hexNeighbors, type HexCoord } from './hex';
import { hasLineOfSight, reachableHexes } from './los';
import type { BattleState, Obstacle, Participant } from './state';
import type { Zone } from './actions';
import type { BattleConfig } from '../../schemas/battle_config';
import type { Item } from '../../schemas/items';
import type { Mob } from '../../schemas/mobs';

export type MobDecision =
  | { type: 'move'; to: HexCoord }
  | { type: 'shoot'; targetId: string; zone: Zone }
  | { type: 'flee' }
  | { type: 'wait' };

// Defaults come from mobs.json (moveAp/attackAp have schema defaults), but the
// engine keeps hard fallbacks for hand-built states in tests.
export function mobMoveAp(def: Mob | null): number {
  return def?.moveAp ?? 4;
}

export function mobAttackAp(def: Mob | null): number {
  return def?.attackAp ?? 8;
}

function mobDefOf(mob: Participant, mobs: Mob[]): Mob | null {
  return mobs.find((m) => m.id === mob.refId) ?? null;
}

function adjacentCoverHexes(params: {
  obstacles: Obstacle[];
  mapWidth: number;
  mapHeight: number;
}): (hex: HexCoord) => boolean {
  const { obstacles, mapWidth, mapHeight } = params;
  return (hex: HexCoord): boolean => {
    if (hex.q < 0 || hex.q >= mapWidth || hex.r < 0 || hex.r >= mapHeight) return false;
    return obstacles.some(
      (o) => (o.blocksLos || o.blocksMove) && hexDistance(o.hex, hex) === 1,
    );
  };
}

/**
 * Best hex from `reachable` to move to.
 * Preference order (spec 5e):
 *   1. has LOS to target and distanceToTarget <= weaponRange
 *   2. has LOS to target
 *   3. distanceToTarget <= weaponRange
 *   4. everything else
 * Inside a group: minimal distance, ties broken by hexKey.
 */
export function findBestMoveHex(params: {
  from: HexCoord;
  targetHex: HexCoord;
  reachable: Set<string>;
  obstacles: Obstacle[];
  occupiedHexes: HexCoord[];
  weaponRange: number;
  needsLos: boolean;
  mapWidth: number;
  mapHeight: number;
}): HexCoord | null {
  void params.from;
  void params.occupiedHexes;
  if (params.reachable.size === 0) return null;

  const scored = [...params.reachable].sort().map((key) => {
    const [q, r] = key.split(',').map(Number);
    const hex = { q, r };
    const distanceToTarget = hexDistance(hex, params.targetHex);
    const hasLosToTarget = hasLineOfSight({
      from: hex,
      to: params.targetHex,
      obstacles: params.obstacles,
      mapWidth: params.mapWidth,
      mapHeight: params.mapHeight,
    });
    return { hex, key, distanceToTarget, hasLosToTarget };
  });

  if (!params.needsLos) {
    // Melee: LOS does not matter, closest hex wins.
    const best = scored.reduce((a, b) =>
      a.distanceToTarget < b.distanceToTarget ||
      (a.distanceToTarget === b.distanceToTarget && a.key < b.key)
        ? a
        : b,
    );
    return best.hex;
  }

  const groupIndex = (s: (typeof scored)[number]): number => {
    const inRange = s.distanceToTarget <= params.weaponRange;
    if (s.hasLosToTarget && inRange) return 0;
    if (s.hasLosToTarget) return 1;
    if (inRange) return 2;
    return 3;
  };

  let best: (typeof scored)[number] | null = null;
  let bestGroup = Number.POSITIVE_INFINITY;
  for (const s of scored) {
    const group = groupIndex(s);
    if (
      best === null ||
      group < bestGroup ||
      (group === bestGroup &&
        (s.distanceToTarget < best.distanceToTarget ||
          (s.distanceToTarget === best.distanceToTarget && s.key < best.key)))
    ) {
      best = s;
      bestGroup = group;
    }
  }
  return best ? best.hex : null;
}

// One adjacent step along the shortest path toward `goal`.
function firstStepToward(params: {
  from: HexCoord;
  goal: HexCoord;
  obstacles: Obstacle[];
  occupiedHexes: HexCoord[];
  mapWidth: number;
  mapHeight: number;
}): HexCoord | null {
  const { from, goal, obstacles, occupiedHexes, mapWidth, mapHeight } = params;
  const occupied = new Set(occupiedHexes.map((h) => hexKey(h)));
  let best: HexCoord | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestKey = '';
  for (const nb of hexNeighbors(from)) {
    if (nb.q < 0 || nb.q >= mapWidth || nb.r < 0 || nb.r >= mapHeight) continue;
    if (obstacles.some((o) => o.blocksMove && o.hex.q === nb.q && o.hex.r === nb.r)) continue;
    const key = hexKey(nb);
    if (occupied.has(key)) continue;
    const distance = hexDistance(nb, goal);
    if (distance < bestDistance || (distance === bestDistance && key < bestKey)) {
      best = nb;
      bestDistance = distance;
      bestKey = key;
    }
  }
  return best;
}

/**
 * Decision for one mob action (move / shoot / flee / wait).
 * The decision does not mutate the state; runEnemyTurn applies it.
 */
export function decideMobAction(params: {
  mob: Participant;
  state: BattleState;
  items: Item[];
  mobs: Mob[];
  config: BattleConfig;
  rng: () => number;
}): MobDecision {
  const { mob, state, mobs, config, rng } = params;
  void params.items;
  void rng;
  if (mob.hp <= 0) return { type: 'wait' };

  const def = mobDefOf(mob, mobs);
  if (!def) return { type: 'wait' };

  const profile = config.ai[def.ai];
  const moveCost = mobMoveAp(def);
  const attackCost = mobAttackAp(def);
  const weaponRange = def.attack.range;
  const mapWidth = state.map.width;
  const mapHeight = state.map.height;
  const obstacles = state.map.obstacles;
  const occupiedHexes = state.participants
    .filter((p) => p.hp > 0 && p.id !== mob.id)
    .map((p) => p.hex);

  const enemies = state.participants.filter((p) => p.kind === 'player' && p.hp > 0);
  if (enemies.length === 0) return { type: 'wait' };
  const player = enemies.reduce((nearest, p) =>
    hexDistance(mob.hex, p.hex) < hexDistance(mob.hex, nearest.hex) ? p : nearest,
  );

  const isRanged = weaponRange > 1;
  const hasLos = hasLineOfSight({
    from: mob.hex,
    to: player.hex,
    obstacles,
    mapWidth,
    mapHeight,
  });
  const distance = hexDistance(mob.hex, player.hex);

  // 1. Cowardly mobs try to flee below the HP threshold; with too little AP
  // they seek cover instead.
  const hpPct = (mob.hp / mob.hpMax) * 100;
  if (profile.fleeAtHpPct > 0 && hpPct < profile.fleeAtHpPct) {
    const fleeApThreshold = profile.fleeApThreshold ?? 0;
    if (mob.ap >= fleeApThreshold) return { type: 'flee' };
    if (!profile.coverAware) return { type: 'wait' };
    if (mob.ap < moveCost) return { type: 'wait' };

    const coverGoal = findCoverGoal({
      from: mob.hex,
      reachable: reachableHexes({
        from: mob.hex,
        maxSteps: Math.floor(mob.ap / moveCost),
        obstacles,
        occupiedHexes,
        mapWidth,
        mapHeight,
      }),
      obstacles,
      mapWidth,
      mapHeight,
    });
    if (!coverGoal) return { type: 'wait' };
    const step = firstStepToward({
      from: mob.hex,
      goal: coverGoal,
      obstacles,
      occupiedHexes,
      mapWidth,
      mapHeight,
    });
    return step ? { type: 'move', to: step } : { type: 'wait' };
  }

  // 2. Normal behaviour: shoot if already in range with LOS (melee needs no LOS).
  if (distance <= weaponRange && (!isRanged || hasLos)) {
    if (mob.ap < attackCost) return { type: 'wait' };
    return { type: 'shoot', targetId: player.id, zone: profile.preferZone };
  }

  // 3. In range but no LOS: step to a neighbouring hex that opens the shot.
  if (distance <= weaponRange && isRanged && !hasLos) {
    if (mob.ap < moveCost) return { type: 'wait' };
    const losStep = findLosStep({
      from: mob.hex,
      targetHex: player.hex,
      obstacles,
      occupiedHexes,
      mapWidth,
      mapHeight,
      weaponRange,
    });
    return losStep ? { type: 'move', to: losStep } : { type: 'wait' };
  }

  // 4. Approach the player.
  if (mob.ap < moveCost) return { type: 'wait' };
  const reachable = reachableHexes({
    from: mob.hex,
    maxSteps: Math.floor(mob.ap / moveCost),
    obstacles,
    occupiedHexes,
    mapWidth,
    mapHeight,
  });
  if (reachable.size === 0) return { type: 'wait' };
  const goal = findBestMoveHex({
    from: mob.hex,
    targetHex: player.hex,
    reachable,
    obstacles,
    occupiedHexes,
    weaponRange,
    needsLos: isRanged,
    mapWidth,
    mapHeight,
  });
  if (!goal) return { type: 'wait' };
  const step = firstStepToward({
    from: mob.hex,
    goal,
    obstacles,
    occupiedHexes,
    mapWidth,
    mapHeight,
  });
  return step ? { type: 'move', to: step } : { type: 'wait' };
}

// Nearest reachable hex that has an adjacent obstacle (cover).
function findCoverGoal(params: {
  from: HexCoord;
  reachable: Set<string>;
  obstacles: Obstacle[];
  mapWidth: number;
  mapHeight: number;
}): HexCoord | null {
  const { from, reachable, obstacles, mapWidth, mapHeight } = params;
  const isCover = adjacentCoverHexes({ obstacles, mapWidth, mapHeight });
  let best: HexCoord | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestKey = '';
  for (const key of [...reachable].sort()) {
    const [q, r] = key.split(',').map(Number);
    const hex = { q, r };
    if (!isCover(hex)) continue;
    const distance = hexDistance(from, hex);
    if (distance < bestDistance || (distance === bestDistance && key < bestKey)) {
      best = hex;
      bestDistance = distance;
      bestKey = key;
    }
  }
  return best;
}

// Neighbouring hex that opens LOS to the target, preferring hexes in range.
function findLosStep(params: {
  from: HexCoord;
  targetHex: HexCoord;
  obstacles: Obstacle[];
  occupiedHexes: HexCoord[];
  mapWidth: number;
  mapHeight: number;
  weaponRange: number;
}): HexCoord | null {
  const { from, targetHex, obstacles, occupiedHexes, mapWidth, mapHeight, weaponRange } = params;
  const occupied = new Set(occupiedHexes.map((h) => hexKey(h)));
  let best: HexCoord | null = null;
  let bestScore: [number, number, string] | null = null;
  for (const nb of hexNeighbors(from)) {
    if (nb.q < 0 || nb.q >= mapWidth || nb.r < 0 || nb.r >= mapHeight) continue;
    if (obstacles.some((o) => o.blocksMove && o.hex.q === nb.q && o.hex.r === nb.r)) continue;
    const key = hexKey(nb);
    if (occupied.has(key)) continue;
    const los = hasLineOfSight({
      from: nb,
      to: targetHex,
      obstacles,
      mapWidth,
      mapHeight,
    });
    if (!los) continue;
    const distance = hexDistance(nb, targetHex);
    const score: [number, number, string] = [distance <= weaponRange ? 0 : 1, distance, key];
    if (
      bestScore === null ||
      score[0] < bestScore[0] ||
      (score[0] === bestScore[0] && score[1] < bestScore[1]) ||
      (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] < bestScore[2])
    ) {
      best = nb;
      bestScore = score;
    }
  }
  return best;
}
