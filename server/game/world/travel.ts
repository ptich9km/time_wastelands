// Stage 3: travel rules. Travel itself is instant on stage 3 —
// baseTimeMs is only used for the client-side "on the way" animation.

import type Database from 'better-sqlite3';
import type { WorldFile, Location } from '../../schemas/world';
import type { Character } from '../entities/character';
import { getWorldState } from '../../db/world-repo';

export type TravelError = 'not_adjacent' | 'no_connection' | 'unknown_location';

export type TravelCheck = { ok: true } | { ok: false; error: TravelError };

function findLocation(world: WorldFile, id: string): Location | undefined {
  return world.locations.find((l) => l.id === id);
}

export function canTravel(
  world: WorldFile,
  character: Character,
  targetId: string,
): TravelCheck {
  const from = findLocation(world, character.location_id);
  const to = findLocation(world, targetId);
  if (!to || !from) {
    return { ok: false, error: 'unknown_location' };
  }
  const forward = from.connections.some((c) => c.to === targetId);
  const back = to.connections.some((c) => c.to === character.location_id);
  if (!forward && !back) {
    return { ok: false, error: 'not_adjacent' };
  }
  if (!forward || !back) {
    return { ok: false, error: 'no_connection' };
  }
  return { ok: true };
}

export interface TravelOptions {
  distance: number;
  baseTimeMs: number;
  type: 'plain' | 'road';
  canQuick: boolean;
}

export function getTravelOptions(
  db: Database.Database,
  world: WorldFile,
  character: Character,
  targetId: string,
): TravelOptions | null {
  const from = findLocation(world, character.location_id);
  const to = findLocation(world, targetId);
  if (!from || !to) return null;
  const conn =
    from.connections.find((c) => c.to === targetId) ??
    to.connections.find((c) => c.to === character.location_id);
  if (!conn) return null;
  const distance = Math.max(
    Math.abs(from.coords.x - to.coords.x),
    Math.abs(from.coords.y - to.coords.y),
  );
  const state = getWorldState(db, targetId);
  return {
    distance,
    baseTimeMs: conn.type === 'road' ? 900 : 1500,
    type: conn.type,
    canQuick: state !== null && state.lastVisitedAt !== null,
  };
}
