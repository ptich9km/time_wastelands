import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb } from '../server/db';
import {
  getWorldState,
  markVisited,
  openNeighbors,
  getVisibleLocations,
  cleanupWorldState,
} from '../server/db/world-repo';
import { canTravel, getTravelOptions } from '../server/game/world/travel';
import { createCharacter } from '../server/game/entities/character';
import { characterRoutes } from '../server/api/character';
import { worldRoutes } from '../server/api/world';
import { loadGameData, type GameData } from '../server/schemas/loader';
import type { WorldFile } from '../server/schemas/world';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const gameData = loadGameData(DATA_DIR);
const world = gameData.world;

// Tiny test world with an asymmetric connection (a → b exists, b → a does not).
// Bypasses WorldFileSchema validation on purpose — the validator rejects
// asymmetric links, but canTravel must still handle them defensively.
const asymWorld = {
  version: 'test',
  size: { width: 20, height: 20 },
  startLocationId: 'a',
  locations: [
    { id: 'a', type: 'road', coords: { x: 0, y: 0 }, connections: [{ to: 'b', type: 'plain' }] },
    { id: 'b', type: 'road', coords: { x: 1, y: 0 }, connections: [] },
  ],
} as unknown as WorldFile;

function charAt(locationId: string) {
  return { location_id: locationId } as ReturnType<typeof createCharacter>;
}

describe('canTravel', () => {
  it('сосед по connection → ok', () => {
    expect(canTravel(world, charAt('zarya'), 'ash_road')).toEqual({ ok: true });
  });

  it('не сосед → not_adjacent', () => {
    expect(canTravel(world, charAt('zarya'), 'pepel')).toEqual({
      ok: false,
      error: 'not_adjacent',
    });
  });

  it('несуществующий id → unknown_location', () => {
    expect(canTravel(world, charAt('zarya'), 'atlantis')).toEqual({
      ok: false,
      error: 'unknown_location',
    });
  });

  it('асимметричная связь → no_connection', () => {
    expect(canTravel(asymWorld, charAt('a'), 'b')).toEqual({
      ok: false,
      error: 'no_connection',
    });
    expect(canTravel(asymWorld, charAt('b'), 'a')).toEqual({
      ok: false,
      error: 'no_connection',
    });
  });
});

describe('getTravelOptions', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  it('road → 900ms, plain → 1500ms', () => {
    const road = getTravelOptions(db, world, charAt('zarya'), 'ash_road');
    expect(road?.type).toBe('road');
    expect(road?.baseTimeMs).toBe(900);
    const plain = getTravelOptions(db, world, charAt('ash_road'), 'pine_guard');
    expect(plain?.type).toBe('plain');
    expect(plain?.baseTimeMs).toBe(1500);
  });

  it('canQuick: false для непосещённой, true для посещённой', () => {
    expect(getTravelOptions(db, world, charAt('zarya'), 'ash_road')?.canQuick).toBe(false);
    markVisited(db, 'ash_road');
    expect(getTravelOptions(db, world, charAt('zarya'), 'ash_road')?.canQuick).toBe(true);
  });
});

describe('world-repo', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  it('openNeighbors: соседи zarya получают строку с last_visited_at = NULL', () => {
    markVisited(db, 'zarya');
    openNeighbors(db, 'zarya', world);
    const neighbor = getWorldState(db, 'ash_road');
    expect(neighbor).not.toBeNull();
    expect(neighbor!.lastVisitedAt).toBeNull();
  });

  it('getVisibleLocations: текущая + соседи видны, дальние — нет; посещённые — всегда', () => {
    let visible = getVisibleLocations(db, world, 'zarya');
    expect(visible.has('zarya')).toBe(true);
    expect(visible.has('ash_road')).toBe(true);
    expect(visible.has('pepel')).toBe(false);
    expect(visible.has('institute_9')).toBe(false);

    markVisited(db, 'ash_road');
    visible = getVisibleLocations(db, world, 'zarya');
    expect(visible.has('ash_road')).toBe(true);
    // Посещённая локация остаётся видимой, даже когда игрок далеко.
    visible = getVisibleLocations(db, world, 'pepel');
    expect(visible.has('ash_road')).toBe(true);
    expect(visible.has('institute_9')).toBe(false);
  });

  it('cleanupWorldState удаляет строки локаций, которых нет в world.json', () => {
    markVisited(db, 'zarya');
    markVisited(db, 'deleted_location');
    const removed = cleanupWorldState(db, world);
    expect(removed).toBe(1);
    expect(getWorldState(db, 'deleted_location')).toBeNull();
    expect(getWorldState(db, 'zarya')).not.toBeNull();
  });
});

describe('world API', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    app = Fastify();
    app.decorate('db', openDb(':memory:'));
    app.decorate('gameData', gameData as GameData);
    await app.register(characterRoutes);
    await app.register(worldRoutes);
    await app.listen({ port: 0 });
    const addr = app.server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await app.close();
    app.db.close();
  });

  const post = (url: string, payload: unknown) =>
    fetch(`${baseUrl}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const get = (url: string) => fetch(`${baseUrl}${url}`);

  it('POST /api/travel без персонажа → 400 no_character', async () => {
    const res = await post('/api/travel', { to: 'ash_road' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'no_character' });
  });

  it('POST /api/travel: успех обновляет characters.location_id и world_state', async () => {
    await post('/api/character', { name: 'Странник' });
    // Stage 7: keep the roll deterministic — this test is about travel, not encounters.
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const res = await post('/api/travel', { to: 'ash_road' });
    vi.restoreAllMocks();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.fromLocationId).toBe('zarya');
    expect(data.toLocationId).toBe('ash_road');
    expect(data.character.location_id).toBe('ash_road');

    const visited = getWorldState(app.db, 'ash_road');
    expect(visited!.lastVisitedAt).not.toBeNull();
    // Соседи новой локации открыты, но не посещены.
    const neighbor = getWorldState(app.db, 'old_crossing');
    expect(neighbor).not.toBeNull();
    expect(neighbor!.lastVisitedAt).toBeNull();
  });

  it('POST /api/travel: не сосед → 400 not_adjacent, чужой id → 400 unknown_location', async () => {
    await post('/api/character', { name: 'Странник' });
    const res1 = await post('/api/travel', { to: 'pepel' });
    expect(res1.status).toBe(400);
    expect(await res1.json()).toEqual({ error: 'not_adjacent' });
    const res2 = await post('/api/travel', { to: 'atlantis' });
    expect(res2.status).toBe(400);
    expect(await res2.json()).toEqual({ error: 'unknown_location' });
  });

  it('GET /api/world: не отдаёт descriptionKey/ambientKeys/art/spawnTable', async () => {
    await post('/api/character', { name: 'Странник' });
    const res = await get('/api/world');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.current).toBe('zarya');
    expect(data.visible).toContain('zarya');
    expect(data.visible).toContain('ash_road');
    expect(data.visible).not.toContain('institute_9');
    for (const loc of data.locations) {
      expect(loc).not.toHaveProperty('descriptionKey');
      expect(loc).not.toHaveProperty('ambientKeys');
      expect(loc).not.toHaveProperty('art');
      expect(loc).not.toHaveProperty('spawnTable');
    }
  });

  it('GET /api/location/:id: 404 для несуществующей, 403 для невидимой, 200 для видимой', async () => {
    await post('/api/character', { name: 'Странник' });

    const res404 = await get('/api/location/atlantis');
    expect(res404.status).toBe(404);

    const res403 = await get('/api/location/institute_9');
    expect(res403.status).toBe(403);

    const res200 = await get('/api/location/ash_road');
    expect(res200.status).toBe(200);
    const loc = await res200.json();
    expect(loc.id).toBe('ash_road');
    expect(loc.descriptionKey).toBe('location.ash_road.desc');
    expect(loc.ambientKeys.length).toBeGreaterThanOrEqual(2);
    expect(loc.ambientKeys.length).toBeLessThanOrEqual(3);
    expect(loc.isCurrent).toBe(false);
  });
});
