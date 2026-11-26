import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb } from '../server/db';
import { characterRoutes } from '../server/api/character';
import { worldRoutes } from '../server/api/world';
import { shopRoutes } from '../server/api/shop';
import { npcRoutes } from '../server/api/npc';
import {
  getPrice,
  getSellPrice,
  getShopState,
  upsertShopState,
  restockIfNeeded,
  RESTOCK_MS,
} from '../server/db/shop-repo';
import { buyItem, sellItem } from '../server/game/economy/shop';
import { beggar, getNpcDialog } from '../server/game/economy/npc';
import { updateCharacter } from '../server/db/character-repo';
import { addItem, getInventory } from '../server/db/inventory-repo';
import { createCharacter } from '../server/game/entities/character';
import { loadGameData, crossValidate, type GameData } from '../server/schemas/loader';
import { loadI18n, setI18n } from '../server/i18n';
import type Database from 'better-sqlite3';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const gameData = loadGameData(DATA_DIR);
setI18n(loadI18n(DATA_DIR));

const ZARYA_SHOP = gameData.shops.shops.find((s) => s.id === 'zarya_shop')!;
const PEPEL_SHOP = gameData.shops.shops.find((s) => s.id === 'pepel_shop')!;

function makeDb(): Database.Database {
  const db = openDb(':memory:');
  createCharacter(db, {
    name: 'Странник',
    startLocationId: gameData.world.startLocationId,
    items: gameData.items.items,
  });
  return db;
}

function freshState(db: Database.Database, shopId: string, itemId: string, over: Partial<{
  stock: number; inflation: number; trend: number;
}> = {}) {
  upsertShopState(db, shopId, itemId, {
    stock: over.stock ?? 5,
    inflation: over.inflation ?? 0,
    trend: over.trend ?? 0,
    restockedAt: new Date().toISOString(),
  });
}

describe('getPrice / getSellPrice', () => {
  it('base 100, mult 1.0, inflation 0 → 100', () => {
    expect(getPrice(100, 1.0, 0)).toBe(100);
  });
  it('inflation 10 → 110', () => {
    expect(getPrice(100, 1.0, 10)).toBe(110);
  });
  it('mult 0.9 → 90', () => {
    expect(getPrice(100, 0.9, 0)).toBe(90);
  });
  it('sell: base 100, обычный → 50; тренд → 70', () => {
    expect(getSellPrice(100, false)).toBe(50);
    expect(getSellPrice(100, true)).toBe(70);
  });
  it('sell: rat_pelt (15) → 7 (50% с округлением вниз)', () => {
    expect(getSellPrice(15, false)).toBe(7);
  });
});

describe('restockIfNeeded', () => {
  it('пустое состояние → сток = baseQty, inflation 0, ровно один тренд', () => {
    const db = openDb(':memory:');
    const rows = restockIfNeeded(db, ZARYA_SHOP, Date.now(), () => 0);
    expect(rows).toHaveLength(ZARYA_SHOP.stock.length);
    for (const [i, row] of rows.entries()) {
      const entry = ZARYA_SHOP.stock.find((e) => e.itemId === row.itemId)!;
      expect(row.stock).toBe(entry.baseQty);
      expect(row.inflation).toBe(0);
      expect(row.trend).toBe(i === 0 ? 1 : 0); // rng 0 → первый предмет
    }
    expect(rows.filter((r) => r.trend === 1)).toHaveLength(1);
    db.close();
  });

  it('свежий restockedAt → ничего не меняется', () => {
    const db = openDb(':memory:');
    freshState(db, ZARYA_SHOP.id, 'medkit', { stock: 1, inflation: 5, trend: 1 });
    const rows = restockIfNeeded(db, ZARYA_SHOP);
    const medkit = rows.find((r) => r.itemId === 'medkit')!;
    expect(medkit.stock).toBe(1);
    expect(medkit.inflation).toBe(5);
    expect(medkit.trend).toBe(1);
    db.close();
  });

  it('restockedAt старше 15 минут → сток/инфляция/тренд пересчитаны', () => {
    const db = openDb(':memory:');
    const stale = new Date(Date.now() - RESTOCK_MS - 60_000).toISOString();
    upsertShopState(db, ZARYA_SHOP.id, 'medkit', { stock: 0, inflation: 42, trend: 0, restockedAt: stale });
    const before = Date.now();
    const rows = restockIfNeeded(db, ZARYA_SHOP);
    const medkit = rows.find((r) => r.itemId === 'medkit')!;
    expect(medkit.stock).toBe(5); // baseQty
    expect(medkit.inflation).toBe(0);
    expect(rows.filter((r) => r.trend === 1)).toHaveLength(1);
    expect(Date.parse(medkit.restockedAt)).toBeGreaterThanOrEqual(before);
    db.close();
  });
});

describe('buyItem / sellItem', () => {
  it('buy: успех → money −price, inventory +1, stock −1, inflation +0.5', () => {
    const db = makeDb();
    freshState(db, ZARYA_SHOP.id, 'medkit', { stock: 5 });
    const qtyBefore = getInventory(db).find((r) => r.itemId === 'medkit')?.qty ?? 0;
    const result = buyItem(db, gameData, ZARYA_SHOP.id, 'medkit');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.character.money).toBe(50 - 30);
    expect(result.inventory.find((r) => r.itemId === 'medkit')?.qty).toBe(qtyBefore + 1);
    const state = getShopState(db, ZARYA_SHOP.id).find((s) => s.itemId === 'medkit')!;
    expect(state.stock).toBe(4);
    expect(state.inflation).toBe(0.5);
    db.close();
  });

  it('buy: stock 0 → out_of_stock', () => {
    const db = makeDb();
    freshState(db, ZARYA_SHOP.id, 'medkit', { stock: 0 });
    const result = buyItem(db, gameData, ZARYA_SHOP.id, 'medkit');
    expect(result).toEqual({ ok: false, error: 'out_of_stock' });
    db.close();
  });

  it('buy: money < price → not_enough_money', () => {
    const db = makeDb();
    updateCharacter(db, { id: 1, money: 10 });
    freshState(db, ZARYA_SHOP.id, 'medkit', { stock: 5 });
    const result = buyItem(db, gameData, ZARYA_SHOP.id, 'medkit');
    expect(result).toEqual({ ok: false, error: 'not_enough_money' });
    db.close();
  });

  it('buy: requirements не выполнены → requirements_not_met', () => {
    const db = makeDb(); // str 3 < fire_axe str 7
    updateCharacter(db, { id: 1, money: 1000 }); // money is checked first
    freshState(db, PEPEL_SHOP.id, 'fire_axe', { stock: 1 });
    const result = buyItem(db, gameData, PEPEL_SHOP.id, 'fire_axe');
    expect(result).toEqual({ ok: false, error: 'requirements_not_met' });
    db.close();
  });

  it('buy: неизвестный товар → not_found', () => {
    const db = makeDb();
    expect(buyItem(db, gameData, ZARYA_SHOP.id, 'fire_axe')).toEqual({ ok: false, error: 'not_found' });
    expect(buyItem(db, gameData, 'no_such_shop', 'medkit')).toEqual({ ok: false, error: 'not_found' });
    db.close();
  });

  it('sell: успех → money +price, qty −1 (строка удалена)', () => {
    const db = makeDb();
    freshState(db, ZARYA_SHOP.id, 'rat_pelt', { stock: 0 });
    const row = addItem(db, 'rat_pelt', 1);
    const result = sellItem(db, gameData, ZARYA_SHOP.id, row.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.price).toBe(7); // 50% от 15
    expect(result.character.money).toBe(50 + 7);
    expect(result.inventory.find((r) => r.itemId === 'rat_pelt')).toBeUndefined();
    db.close();
  });

  it('sell: тренд → 70% (medkit 30 → 21)', () => {
    const db = makeDb();
    for (const entry of ZARYA_SHOP.stock) {
      freshState(db, ZARYA_SHOP.id, entry.itemId, { stock: entry.baseQty, trend: entry.itemId === 'medkit' ? 1 : 0 });
    }
    const row = addItem(db, 'medkit', 1);
    const result = sellItem(db, gameData, ZARYA_SHOP.id, row.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.price).toBe(21);
    db.close();
  });

  it('sell: экипированное → not_sellable', () => {
    const db = makeDb();
    freshState(db, ZARYA_SHOP.id, 'rusty_pipe', { stock: 3 });
    // The starter kit already has an equipped weapon.
    const equipped = getInventory(db).find((r) => r.equippedSlot !== null)!;
    expect(equipped).toBeDefined();
    const result = sellItem(db, gameData, ZARYA_SHOP.id, equipped.id);
    expect(result).toEqual({ ok: false, error: 'not_sellable' });
    db.close();
  });

  it('sell: нет такой строки → not_found', () => {
    const db = makeDb();
    freshState(db, ZARYA_SHOP.id, 'medkit', { stock: 5 });
    expect(sellItem(db, gameData, ZARYA_SHOP.id, 9999)).toEqual({ ok: false, error: 'not_found' });
    db.close();
  });
});

describe('stage 8 API', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    app = Fastify();
    app.decorate('db', openDb(':memory:'));
    app.decorate('gameData', gameData as GameData);
    await app.register(characterRoutes);
    await app.register(worldRoutes);
    await app.register(shopRoutes);
    await app.register(npcRoutes);
    await app.listen({ port: 0 });
    const addr = app.server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    const res = await post('/api/character', { name: 'Странник' });
    expect(res.status).toBe(201);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  it('GET /api/shop/:shopId: в городе → 200, 7 предметов, цены и сток', async () => {
    const res = await get('/api/shop/zarya_shop');
    expect(res.status).toBe(200);
    const { shop } = await res.json();
    expect(shop.id).toBe('zarya_shop');
    expect(shop.items).toHaveLength(7);
    const medkit = shop.items.find((i: { itemId: string }) => i.itemId === 'medkit');
    expect(medkit.price).toBe(30);
    expect(medkit.stock).toBe(5);
    expect(shop.items.filter((i: { trend: boolean }) => i.trend)).toHaveLength(1);
  });

  it('GET /api/shop/:shopId: не в городе → 400 not_in_city', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999); // no encounter
    await post('/api/travel', { to: 'ash_road' });
    const res = await get('/api/shop/zarya_shop');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_in_city' });
  });

  it('GET /api/shop/:shopId: нет shopId → 404', async () => {
    const res = await get('/api/shop/no_such_shop');
    expect(res.status).toBe(404);
  });

  it('POST buy: 200 → money −30, stock −1; повтор при нехватке → 400', async () => {
    const res = await post('/api/shop/zarya_shop/buy', { itemId: 'medkit' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.character.money).toBe(20);
    expect(body.shop.items.find((i: { itemId: string }) => i.itemId === 'medkit').stock).toBe(4);
    // The starter kit already holds medkits — the bought one stacks on top.
    const starterMedkits = getInventory(app.db).find((r) => r.itemId === 'medkit')!.qty;
    expect(body.inventory.find((r: { itemId: string }) => r.itemId === 'medkit').qty).toBe(starterMedkits);

    const again = await post('/api/shop/zarya_shop/buy', { itemId: 'medkit' });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'not_enough_money' });
  });

  it('POST buy: stock меньше qty → 400 out_of_stock', async () => {
    updateCharacter(app.db, { id: 1, money: 1000 });
    const res = await post('/api/shop/zarya_shop/buy', { itemId: 'medkit', qty: 6 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'out_of_stock' });
  });

  it('POST sell: rat_pelt → 200, price 7', async () => {
    const row = addItem(app.db, 'rat_pelt', 1);
    const res = await post('/api/shop/zarya_shop/sell', { inventoryId: row.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.price).toBe(7);
    expect(body.character.money).toBe(57);
  });

  it('POST sell: экипированное → 400 not_sellable', async () => {
    // The starter kit has an equipped weapon.
    const equipped = getInventory(app.db).find((r) => r.equippedSlot !== null)!;
    expect(equipped).toBeDefined();
    const res = await post('/api/shop/zarya_shop/sell', { inventoryId: equipped.id });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_sellable' });
  });

  it('GET /api/npc/:npcId → 200 с line и rumor', async () => {
    const res = await get('/api/npc/koval?lang=ru');
    expect(res.status).toBe(200);
    const { npc } = await res.json();
    expect(npc.id).toBe('koval');
    expect(npc.nameKey).toBe('npc.koval.name');
    expect(npc.role).toBe('blacksmith');
    expect(typeof npc.line).toBe('string');
    expect(npc.line.length).toBeGreaterThan(0);
    expect(typeof npc.rumor).toBe('string');
  });

  it('GET /api/npc/:npcId: неизвестный → 404', async () => {
    const res = await get('/api/npc/no_such_npc');
    expect(res.status).toBe(404);
  });

  it('beggar: money 5, hp 10/65 → 200, money 15, hp 30; повтор → already_begged', async () => {
    updateCharacter(app.db, { id: 1, money: 5, hp_current: 10 });
    const res = await post('/api/npc/vera/beggar');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toEqual({ money: 10, hp: 20 });
    expect(body.character.money).toBe(15);
    expect(body.character.hp_current).toBe(30);

    // Eligibility is checked before the cooldown (spec order), so the
    // character must still look miserable for the second attempt.
    updateCharacter(app.db, { id: 1, money: 5, hp_current: 10 });
    const again = await post('/api/npc/vera/beggar');
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'already_begged' });
  });

  it('beggar: money >= 20 → not_eligible', async () => {
    updateCharacter(app.db, { id: 1, money: 25, hp_current: 5 });
    const res = await post('/api/npc/koval/beggar');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_eligible' });
  });

  it('beggar: hp >= 30% → not_eligible', async () => {
    updateCharacter(app.db, { id: 1, money: 5, hp_current: 60 });
    const res = await post('/api/npc/koval/beggar');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_eligible' });
  });
});

describe('npc dialog (unit)', () => {
  it('возвращает line и rumor из ключей NPC', () => {
    const vera = gameData.npcs.npcs.find((n) => n.id === 'vera')!;
    const dialog = getNpcDialog(vera, 'ru', () => 0);
    expect(dialog.line.length).toBeGreaterThan(0);
    expect(dialog.rumor).toBeDefined();
  });
});

describe('crossValidate (stage 8)', () => {
  function broken(mutate: (data: GameData) => void): GameData {
    const copy = structuredClone(gameData) as GameData;
    mutate(copy);
    return copy;
  }

  it('shopId в world.json должен существовать', () => {
    const data = broken((d) => {
      d.world.locations.find((l) => l.id === 'zarya')!.shopId = 'ghost_shop';
    });
    expect(() => crossValidate(data)).toThrow(/ghost_shop/);
  });

  it('shop.locationId должен существовать и быть city', () => {
    const unknown = broken((d) => {
      d.shops.shops[0].locationId = 'nowhere';
    });
    expect(() => crossValidate(unknown)).toThrow(/nowhere/);
    const notCity = broken((d) => {
      d.shops.shops[0].locationId = 'ash_road';
    });
    expect(() => crossValidate(notCity)).toThrow(/не city/);
  });

  it('stock ссылается на существующие itemId', () => {
    const data = broken((d) => {
      d.shops.shops[0].stock.push({ itemId: 'ghost_item', baseQty: 1 });
    });
    expect(() => crossValidate(data)).toThrow(/ghost_item/);
  });

  it('npcId в world.npcIds и npc.locationId должны существовать', () => {
    const badRef = broken((d) => {
      d.world.locations.find((l) => l.id === 'zarya')!.npcIds.push('ghost_npc');
    });
    expect(() => crossValidate(badRef)).toThrow(/ghost_npc/);
    const badLoc = broken((d) => {
      d.npcs.npcs[0].locationId = 'nowhere';
    });
    expect(() => crossValidate(badLoc)).toThrow(/nowhere/);
  });

  it('реальные данные проходят crossValidate', () => {
    expect(() => crossValidate(gameData)).not.toThrow();
  });
});

describe('инфляция персистентна между «перезапусками»', () => {
  it('inflation сохраняется в shop_state и не сбрасывается без restock', () => {
    const db = makeDb();
    updateCharacter(db, { id: 1, money: 1000 });
    freshState(db, ZARYA_SHOP.id, 'medkit', { stock: 5 });
    buyItem(db, gameData, ZARYA_SHOP.id, 'medkit');
    buyItem(db, gameData, ZARYA_SHOP.id, 'medkit');
    const state = getShopState(db, ZARYA_SHOP.id).find((s) => s.itemId === 'medkit')!;
    expect(state.inflation).toBe(1);
    // Цена учитывает инфляцию: 30 × (1 + 1/100) ≈ 30.3 → round 30.
    expect(getPrice(30, 1.0, state.inflation)).toBe(30);
    expect(getPrice(30, 1.0, 10)).toBe(33);
    db.close();
  });
});
