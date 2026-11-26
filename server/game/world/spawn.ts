// Stage 7: mob spawn / encounter rolls for world travel.

import type { Location } from '../../schemas/world';
import type { Mob } from '../../schemas/mobs';
import type { SpawnConfig } from '../../schemas/battle_config';
import type { WorldState } from '../../db/world-repo';

export function randInt(min: number, max: number, rng: () => number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

// world_state rows written by SQLite datetime('now') have no timezone marker;
// treat them as UTC so the respawn comparison does not depend on the host TZ.
function parseDbTime(value: string): number {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

function pickWeighted<T extends { weight: number }>(entries: T[], rng: () => number): T {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  let roll = rng() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll < 0) return entry;
  }
  return entries[entries.length - 1];
}

export type EncounterRoll =
  | { encounter: false }
  | { encounter: true; mobIds: string[]; isElite: boolean[] };

// The spec signature omits the mob list, but the level-range/tags/elite checks
// are impossible without it — mobs is passed in explicitly.
export function rollEncounter(params: {
  location: Location;
  worldState: WorldState | null;
  config: SpawnConfig;
  mobs: Mob[];
  rng: () => number;
  now?: number;
}): EncounterRoll {
  const { location, worldState, config, mobs, rng } = params;
  const now = params.now ?? Date.now();

  if (location.type === 'city') return { encounter: false };
  if (worldState?.respawnAt && now < parseDbTime(worldState.respawnAt)) {
    return { encounter: false };
  }
  const chance = Math.min(
    1,
    Math.max(0, (location.dangerLevel / 100) * config.encounterChanceMultiplier),
  );
  if (rng() >= chance) return { encounter: false };
  if (location.spawnTable.length === 0) return { encounter: false };

  const entry = pickWeighted(location.spawnTable, rng);
  const mob = mobs.find((m) => m.id === entry.mobId);
  if (!mob) return { encounter: false };

  const [locMin, locMax] = location.levelRange;
  const [mobMin, mobMax] = mob.spawnLevelRange;
  if (mobMax < locMin || mobMin > locMax) return { encounter: false };

  const count = mob.tags.includes('pack')
    ? randInt(config.packMin, config.packMax, rng)
    : randInt(config.soloMin, config.soloMax, rng);
  const isElite = Array.from(
    { length: count },
    () => mob.elite !== undefined && rng() < config.eliteChance,
  );
  return { encounter: true, mobIds: Array(count).fill(mob.id), isElite };
}

export function applyElite(mob: Mob, isElite: boolean): Mob {
  if (!isElite || !mob.elite) return mob;
  return {
    ...mob,
    hp: Math.floor(mob.hp * mob.elite.hpMult),
    attack: {
      ...mob.attack,
      min: Math.floor(mob.attack.min * mob.elite.dmgMult),
      max: Math.floor(mob.attack.max * mob.elite.dmgMult),
    },
  };
}
