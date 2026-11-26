// Stage 3: world_state repository — fog of war and lazy per-location rows.

import type Database from 'better-sqlite3';
import type { WorldFile } from '../schemas/world';

export interface WorldState {
  locationId: string;
  respawnAt: string;
  lastVisitedAt: string | null;
}

interface WorldStateRow {
  location_id: string;
  respawn_at: string;
  last_visited_at: string | null;
}

function toState(row: WorldStateRow): WorldState {
  return {
    locationId: row.location_id,
    respawnAt: row.respawn_at,
    lastVisitedAt: row.last_visited_at,
  };
}

export function getWorldState(
  db: Database.Database,
  locationId: string,
): WorldState | null {
  const row = db
    .prepare('SELECT location_id, respawn_at, last_visited_at FROM world_state WHERE location_id = ?')
    .get(locationId) as WorldStateRow | undefined;
  return row ? toState(row) : null;
}

// Upsert: mark the location as visited now.
export function markVisited(db: Database.Database, locationId: string): void {
  db.prepare(
    `INSERT INTO world_state (location_id, respawn_at, last_visited_at)
     VALUES (?, datetime('now'), datetime('now'))
     ON CONFLICT(location_id) DO UPDATE SET
       last_visited_at = datetime('now'),
       updated_at = datetime('now')`,
  ).run(locationId);
}

// Stage 7: after a battle the location's mobs respawn in `minutes`.
// ISO string is stored so the respawn comparison is timezone-independent.
export function markRespawn(db: Database.Database, locationId: string, minutes: number): void {
  const respawnAt = new Date(Date.now() + minutes * 60_000).toISOString();
  db.prepare(
    `INSERT INTO world_state (location_id, respawn_at, last_visited_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(location_id) DO UPDATE SET
       respawn_at = excluded.respawn_at,
       updated_at = datetime('now')`,
  ).run(locationId, respawnAt);
}

// Reveal (but do not visit) every neighbor of the given location:
// missing rows are inserted with last_visited_at = NULL.
export function openNeighbors(
  db: Database.Database,
  locationId: string,
  world: WorldFile,
): void {
  const loc = world.locations.find((l) => l.id === locationId);
  if (!loc) return;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO world_state (location_id, respawn_at, last_visited_at)
     VALUES (?, datetime('now'), NULL)`,
  );
  for (const conn of loc.connections) {
    insert.run(conn.to);
  }
}

// Locations ever visited (last_visited_at IS NOT NULL).
export function getVisitedLocations(db: Database.Database): Set<string> {
  const rows = db
    .prepare('SELECT location_id FROM world_state WHERE last_visited_at IS NOT NULL')
    .all() as Array<{ location_id: string }>;
  return new Set(rows.map((r) => r.location_id));
}

// Locations visible on the map: the current one, all its neighbors,
// and everything ever visited.
export function getVisibleLocations(
  db: Database.Database,
  world: WorldFile,
  characterLocationId: string,
): Set<string> {
  const visible = new Set<string>([characterLocationId]);
  const current = world.locations.find((l) => l.id === characterLocationId);
  if (current) {
    for (const conn of current.connections) visible.add(conn.to);
  }
  for (const id of getVisitedLocations(db)) visible.add(id);
  return visible;
}

// Drops rows for locations that no longer exist in world.json.
export function cleanupWorldState(db: Database.Database, world: WorldFile): number {
  const ids = world.locations.map((l) => l.id);
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  const res = db
    .prepare(`DELETE FROM world_state WHERE location_id NOT IN (${placeholders})`)
    .run(...ids);
  return res.changes;
}
