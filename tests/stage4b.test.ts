import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb } from '../server/db';
import {
  createCharacter,
  backfillStarterKit,
  getCharacter,
} from '../server/game/entities/character';
import {
  getInventory,
  getItemById,
  addItem,
  removeItem,
  equipItem,
  unequipItem,
  getEquipped,
  canEquip,
} from '../server/db/inventory-repo';
import { characterRoutes } from '../server/api/character';
import { inventoryRoutes } from '../server/api/inventory';
import { loadGameData, type GameData } from '../server/schemas/loader';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const gameData = loadGameData(DATA_DIR);
const world = gameData.world;
const items = gameData.items.items;

function makeDb() {
  return openDb(':memory:');
}

function makeChar(db: ReturnType<typeof makeDb>) {
  return createCharacter(db, { name: 'Странник', startLocationId: world.startLocationId, items });
}

describe('starter kit', () => {
  let db: ReturnType<typeof makeDb>;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('createCharacter → rusty_pipe и leather_jacket надеты, medkit ×2 в рюкзаке', () => {
    makeChar(db);
    const rows = getInventory(db);
    const pipe = rows.find((r) => r.itemId === 'rusty_pipe');
    const jacket = rows.find((r) => r.itemId === 'leather_jacket');
    const medkits = rows.filter((r) => r.itemId === 'medkit');
    expect(pipe?.equippedSlot).toBe('weapon');
    expect(jacket?.equippedSlot).toBe('jacket');
    expect(medkits.reduce((s, r) => s + r.qty, 0)).toBe(2);
    expect(medkits.every((r) => r.equippedSlot === null)).toBe(true);
  });

  it('backfill: персонаж без inventory получает набор один раз', () => {
    // Симулируем персонажа до 4b: без стартового набора.
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'inventory'").run();
    createCharacter(db, { name: 'Старый', startLocationId: world.startLocationId });
    db.prepare('DELETE FROM inventory').run();
    db.prepare("DELETE FROM meta WHERE key = 'starter_kit_granted'").run();

    expect(backfillStarterKit(db, items)).toBe(true);
    expect(getInventory(db).length).toBe(3);
    expect(backfillStarterKit(db, items)).toBe(false); // повторно не выдаётся
    expect(getInventory(db).length).toBe(3);
  });

  it('backfill: пустая БД — ничего не делает', () => {
    expect(backfillStarterKit(db, items)).toBe(false);
    expect(getInventory(db).length).toBe(0);
  });
});

describe('inventory repo', () => {
  let db: ReturnType<typeof makeDb>;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('addItem: апсерт в существующий стек; надетые строки не сливаются', () => {
    makeChar(db);
    addItem(db, 'medkit', 1);
    const medkits = getInventory(db).filter((r) => r.itemId === 'medkit' && r.equippedSlot === null);
    expect(medkits).toHaveLength(1);
    expect(medkits[0].qty).toBe(3);
    // Новый rusty_pipe — новая строка, не слияние с надетым.
    addItem(db, 'rusty_pipe', 1);
    const pipes = getInventory(db).filter((r) => r.itemId === 'rusty_pipe');
    expect(pipes).toHaveLength(2);
  });

  it('removeItem: уменьшает qty, на нуле удаляет строку', () => {
    makeChar(db);
    const medkit = getInventory(db).find((r) => r.itemId === 'medkit')!;
    removeItem(db, medkit.id, 1);
    expect(getInventory(db).find((r) => r.id === medkit.id)?.qty).toBe(1);
    removeItem(db, medkit.id, 5);
    expect(getInventory(db).find((r) => r.id === medkit.id)).toBeUndefined();
  });

  it('equipItem: medkit → not_equippable', () => {
    const char = makeChar(db);
    const medkit = getInventory(db).find((r) => r.itemId === 'medkit')!;
    expect(equipItem(db, char, medkit.id, gameData)).toEqual({ ok: false, error: 'not_equippable' });
  });

  it('equipItem: pipe и jacket надеты одновременно (разные слоты)', () => {
    const char = makeChar(db);
    const equipped = getEquipped(db);
    expect(equipped.map((e) => e.slot).sort()).toEqual(['jacket', 'weapon']);
    expect(char).toBeTruthy();
  });

  it('equipItem: второй pipe в weapon → первый снимается', () => {
    const char = makeChar(db);
    const newPipe = addItem(db, 'rusty_pipe', 1);
    const result = equipItem(db, char, newPipe.id, gameData);
    expect(result.ok).toBe(true);
    const equipped = getEquipped(db).filter((e) => e.slot === 'weapon');
    expect(equipped).toHaveLength(1);
    expect(equipped[0].inventoryId).toBe(newPipe.id);
    const oldPipe = getInventory(db).find((r) => r.itemId === 'rusty_pipe' && r.id !== newPipe.id)!;
    expect(oldPipe.equippedSlot).toBeNull();
  });

  it('equipItem: requirements_not_met — sniper_rifle (level 5) на 1 уровне', () => {
    const char = makeChar(db);
    const sniper = addItem(db, 'sniper_rifle', 1);
    const result = equipItem(db, char, sniper.id, gameData);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error === 'requirements_not_met') {
      expect(result.missing.level).toEqual({ need: 5, have: 1 });
    } else {
      expect.unreachable();
    }
  });

  it('equipItem: несуществующая строка → not_found', () => {
    const char = makeChar(db);
    expect(equipItem(db, char, 9999, gameData)).toEqual({ ok: false, error: 'not_found' });
  });

  it('unequipItem: снять надетое → NULL; повторно → not_equipped', () => {
    makeChar(db);
    const pipe = getInventory(db).find((r) => r.itemId === 'rusty_pipe')!;
    expect(unequipItem(db, pipe.id)).toEqual({ ok: true });
    expect(getInventory(db).find((r) => r.id === pipe.id)?.equippedSlot).toBeNull();
    expect(unequipItem(db, pipe.id)).toEqual({ ok: false, error: 'not_equipped' });
  });

  it('getEquipped: только надетые', () => {
    makeChar(db);
    const equipped = getEquipped(db);
    expect(equipped).toHaveLength(2);
    expect(equipped.every((e) => getInventory(db).find((r) => r.id === e.inventoryId)?.equippedSlot === e.slot)).toBe(true);
  });

  it('canEquip: weapon/armor ок, consumable/ammo/misc → not_equippable', () => {
    const char = getCharacter(db) ?? makeChar(db);
    const pipe = getItemById(gameData, 'rusty_pipe')!;
    const jacket = getItemById(gameData, 'leather_jacket')!;
    const medkit = getItemById(gameData, 'medkit')!;
    const ammo = getItemById(gameData, 'ammo_light')!;
    const scrap = getItemById(gameData, 'scrap_metal')!;
    expect(canEquip(char, pipe).ok).toBe(true);
    expect(canEquip(char, jacket).ok).toBe(true);
    expect(canEquip(char, medkit)).toEqual({ ok: false, missing: { not_equippable: true } });
    expect(canEquip(char, ammo).ok).toBe(false);
    expect(canEquip(char, scrap).ok).toBe(false);
  });

  it('canEquip: требование к стату не выполнено → missing с деталями', () => {
    const char = makeChar(db);
    const axe = getItemById(gameData, 'fire_axe')!; // str 7 при старте str 3
    const check = canEquip(char, axe);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.missing.str).toEqual({ need: 7, have: 3 });
    }
  });
});

describe('inventory API', () => {
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

  it('GET /api/inventory без персонажа → 404', async () => {
    const res = await get('/api/inventory');
    expect(res.status).toBe(404);
  });

  it('POST /api/character → GET /api/inventory: items/equipped/capacity', async () => {
    await post('/api/character', { name: 'Странник' });
    const res = await get('/api/inventory');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(3);
    expect(data.equipped.weapon.itemId).toBe('rusty_pipe');
    expect(data.equipped.jacket.itemId).toBe('leather_jacket');
    expect(data.items.find((i: { itemId: string }) => i.itemId === 'medkit').qty).toBe(2);
    expect(data.capacity.usedSlots).toBe(3);
    expect(data.capacity.maxSlots).toBe(20);
    expect(data.capacity.maxWeight).toBe(3000); // 1000 × str 3
    expect(data.items[0].item.nameKey).toBeTruthy(); // полный предмет из gameData
  });

  it('POST /api/inventory/equip: medkit → 400 not_equippable', async () => {
    await post('/api/character', { name: 'Странник' });
    const inv = (await (await get('/api/inventory')).json()).items;
    const medkit = inv.find((i: { itemId: string }) => i.itemId === 'medkit');
    const res = await post('/api/inventory/equip', { inventoryId: medkit.inventoryId });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_equippable' });
  });

  it('POST /api/inventory/equip: sniper_rifle → 400 requirements_not_met с missing', async () => {
    await post('/api/character', { name: 'Странник' });
    addItem(app.db, 'sniper_rifle', 1);
    const inv = (await (await get('/api/inventory')).json()).items;
    const sniper = inv.find((i: { itemId: string }) => i.itemId === 'sniper_rifle');
    const res = await post('/api/inventory/equip', { inventoryId: sniper.inventoryId });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('requirements_not_met');
    expect(body.missing.level).toEqual({ need: 5, have: 1 });
  });

  it('POST /api/inventory/equip → 200, затем unequip → 200', async () => {
    await post('/api/character', { name: 'Странник' });
    const inv = (await (await get('/api/inventory')).json()).items;
    const medkit = inv.find((i: { itemId: string }) => i.itemId === 'medkit');
    // сначала снимаем pipe
    const pipe = inv.find((i: { itemId: string }) => i.itemId === 'rusty_pipe');
    const res1 = await post('/api/inventory/unequip', { inventoryId: pipe.inventoryId });
    expect(res1.status).toBe(200);
    expect((await res1.json()).equipped.weapon).toBeUndefined();
    // medkit надеть нельзя — 400
    const res2 = await post('/api/inventory/equip', { inventoryId: medkit.inventoryId });
    expect(res2.status).toBe(400);
    // снова надеваем pipe — 200
    const res3 = await post('/api/inventory/equip', { inventoryId: pipe.inventoryId });
    expect(res3.status).toBe(200);
    expect((await res3.json()).equipped.weapon.inventoryId).toBe(pipe.inventoryId);
  });
});
