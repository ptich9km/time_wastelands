import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb } from '../server/db';
import { characterRoutes } from '../server/api/character';
import { inventoryRoutes } from '../server/api/inventory';
import { updateCharacter } from '../server/db/character-repo';
import { addItem, getInventory } from '../server/db/inventory-repo';
import { loadGameData, type GameData } from '../server/schemas/loader';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const gameData = loadGameData(DATA_DIR);

describe('out-of-battle healing API', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    app = Fastify();
    app.decorate('db', openDb(':memory:'));
    app.decorate('gameData', gameData as GameData);
    await app.register(characterRoutes);
    await app.register(inventoryRoutes);
    await app.listen({ port: 0 });
    const addr = app.server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const res = await post('/api/character', { name: 'Странник' });
    expect(res.status).toBe(201);
  });

  afterEach(async () => {
    await app.close();
    app.db.close();
  });

  const post = (url: string, payload: unknown = {}) =>
    fetch(`${baseUrl}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const get = (url: string) => fetch(`${baseUrl}${url}`);
  const character = async () => (await (await get('/api/character')).json()).character;
  const setCharacter = (patch: Record<string, unknown>) =>
    updateCharacter(app.db, { id: 1, ...patch });

  it('rest: in a city restores floor(hp_max * 0.3) and sets last_rest_at', async () => {
    const before = await character();
    await setCharacter({ hp_current: 1 });

    const res = await post('/api/character/rest');
    expect(res.status).toBe(200);
    const after = (await res.json()).character;
    expect(after.hp_current).toBe(1 + Math.floor(before.hp_max * 0.3));
    expect(after.hp_max).toBe(before.hp_max);
    expect(after.money).toBe(before.money);
    expect(typeof after.last_rest_at).toBe('string');
  });

  it('rest: outside a city → 400 not_in_city', async () => {
    await setCharacter({ hp_current: 10, location_id: 'ash_road' });
    const res = await post('/api/character/rest');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_in_city' });
  });

  it('rest: repeated within cooldown → 400 rest_cooldown with remainingSec', async () => {
    await setCharacter({
      hp_current: 10,
      last_rest_at: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await post('/api/character/rest');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('rest_cooldown');
    expect(body.remainingSec).toBeGreaterThan(0);
    expect(body.remainingSec).toBeLessThanOrEqual(300);
  });

  it('rest: full HP → 400 full_hp without spending the cooldown', async () => {
    const before = await character();
    const res = await post('/api/character/rest');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'full_hp' });
    expect((await character()).last_rest_at).toBe(before.last_rest_at);
  });

  it('heal: in a city fills HP and charges max(5, missing HP)', async () => {
    const before = await character();
    await setCharacter({ hp_current: before.hp_max - 20 });
    const expectedCost = Math.max(5, 20);

    const res = await post('/api/character/heal');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cost).toBe(expectedCost);
    expect(body.character.hp_current).toBe(body.character.hp_max);
    expect(body.character.money).toBe(before.money - expectedCost);
  });

  it('heal: not enough money → 400 not_enough_money with cost and have', async () => {
    const before = await character();
    await setCharacter({ hp_current: before.hp_max - 1, money: 3 });
    const res = await post('/api/character/heal');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_enough_money', cost: 5, have: 3 });
  });

  it('heal: outside a city → 400 not_in_city', async () => {
    await setCharacter({ hp_current: 10, location_id: 'pine_forest' });
    const res = await post('/api/character/heal');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_in_city' });
  });

  it('use: medkit restores HP and decrements qty', async () => {
    await setCharacter({ hp_current: 10 });
    const medkit = getInventory(app.db).find((r) => r.itemId === 'medkit')!;
    const res = await post('/api/inventory/use', { inventoryId: medkit.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.healed).toBe(20);
    expect(body.character.hp_current).toBe(30);
    expect(body.inventory.find((r: { inventoryId: number }) => r.inventoryId === medkit.id).qty).toBe(1);
    expect(getInventory(app.db).find((r) => r.id === medkit.id)?.qty).toBe(1);
  });

  it('use: full HP → 400 full_hp and the stack is untouched', async () => {
    const medkit = getInventory(app.db).find((r) => r.itemId === 'medkit')!;
    const res = await post('/api/inventory/use', { inventoryId: medkit.id });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'full_hp' });
    expect(getInventory(app.db).find((r) => r.id === medkit.id)?.qty).toBe(2);
  });

  it('use: non-consumable → 400 not_consumable', async () => {
    await setCharacter({ hp_current: 10 });
    const pipe = getInventory(app.db).find((r) => r.itemId === 'rusty_pipe')!;
    const res = await post('/api/inventory/use', { inventoryId: pipe.id });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_consumable' });
  });

  it('use: consumable without heal → 400 no_heal_effect', async () => {
    await setCharacter({ hp_current: 10 });
    const antidote = addItem(app.db, 'spore_antidote', 1);
    const res = await post('/api/inventory/use', { inventoryId: antidote.id });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'no_heal_effect' });
    expect(getInventory(app.db).find((r) => r.id === antidote.id)?.qty).toBe(1);
  });
});
