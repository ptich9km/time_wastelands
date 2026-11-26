import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb } from '../server/db';
import {
  createCharacter,
  getCharacter,
  isValidName,
} from '../server/game/entities/character';
import { characterRoutes } from '../server/api/character';
import { loadGameData, type GameData } from '../server/schemas/loader';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const world = loadGameData(DATA_DIR).world;

function makeApp(): FastifyInstance {
  const app = Fastify();
  app.decorate('db', openDb(':memory:'));
  // Роутам нужен только world; полный GameData здесь не требуется.
  app.decorate('gameData', { world } as GameData);
  app.register(characterRoutes);
  return app;
}

describe('character entity (in-memory SQLite)', () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('createCharacter: hp_max=65, ap_max=21, per=0, intel=0, стартовая локация', () => {
    const c = createCharacter(db, { name: 'Странник', startLocationId: world.startLocationId });
    expect(c.id).toBe(1);
    expect(c.str).toBe(3);
    expect(c.agi).toBe(3);
    expect(c.int).toBe(3);
    expect(c.end).toBe(3);
    expect(c.per).toBe(0);
    expect(c.intel).toBe(0);
    expect(c.hp_current).toBe(65);
    expect(c.hp_max).toBe(65);
    expect(c.ap_max).toBe(21);
    expect(c.money).toBe(50);
    expect(c.level).toBe(1);
    expect(c.xp).toBe(0);
    expect(c.location_id).toBe(world.startLocationId);
  });

  it('повторное создание бросает character_exists', () => {
    createCharacter(db, { name: 'Странник', startLocationId: world.startLocationId });
    expect(() =>
      createCharacter(db, { name: 'Второй', startLocationId: world.startLocationId }),
    ).toThrow(/character_exists/);
  });

  it('валидация имени: "a" и 21 символ — нет, "Иван-2" — да', () => {
    expect(isValidName('a')).toBe(false);
    expect(isValidName('a'.repeat(21))).toBe(false);
    expect(isValidName('Иван-2')).toBe(true);
    expect(isValidName('')).toBe(false);
    expect(isValidName('Имя_с_подчёркиванием')).toBe(false);
  });

  it('getCharacter до создания → null', () => {
    expect(getCharacter(db)).toBeNull();
  });
});

describe('character API', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    app = makeApp();
    // inject() ломается о cookie ESM в light-my-request — поднимаем реальный сервер на случайном порту.
    await app.listen({ port: 0 });
    const addr = app.server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await app.close();
    app.db.close();
  });

  const post = (payload: unknown) =>
    fetch(`${baseUrl}/api/character`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const get = () => fetch(`${baseUrl}/api/character`);

  it('GET без персонажа → 404 no_character', async () => {
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_character' });
  });

  it('POST → 201, затем GET → 200 с тем же персонажем', async () => {
    const res = await post({ name: 'Странник' });
    expect(res.status).toBe(201);
    const created = (await res.json()).character;
    expect(created.hp_max).toBe(65);

    const getRes = await get();
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).character).toEqual(created);
  });

  it('повторный POST → 409 character_exists', async () => {
    await post({ name: 'Странник' });
    const res = await post({ name: 'Второй' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'character_exists' });
  });

  it('POST с лишними статами от клиента — они игнорируются', async () => {
    const res = await post({ name: 'Читер', str: 99, agi: 99, hp_max: 9999 });
    expect(res.status).toBe(201);
    const c = (await res.json()).character;
    expect([c.str, c.agi, c.int, c.end, c.per, c.intel]).toEqual([3, 3, 3, 3, 0, 0]);
    expect(c.hp_max).toBe(65);
  });

  it('POST с плохим именем → 400 invalid_name', async () => {
    const res = await post({ name: 'a' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_name' });
  });
});
