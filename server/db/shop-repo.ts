// Stage 8: shop state repository — stock, inflation, daily trend, restock.

import type Database from 'better-sqlite3';
import type { Shop } from '../schemas/shops';
import type { GameData } from '../schemas/loader';

export interface ShopStateRow {
  itemId: string;
  stock: number;
  inflation: number;
  trend: number;
  restockedAt: string;
}

// One game day: shop stock/trend refresh after 15 real-time minutes.
export const RESTOCK_MS = 15 * 60 * 1000;

interface Row {
  item_id: string;
  stock: number;
  inflation: number;
  trend: number;
  restocked_at: string;
}

// SQLite datetime('now') rows carry no timezone; treat them as UTC.
function parseDbTime(value: string): number {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

function toRow(r: Row): ShopStateRow {
  return {
    itemId: r.item_id,
    stock: r.stock,
    inflation: r.inflation,
    trend: r.trend,
    restockedAt: r.restocked_at,
  };
}

export function getShopState(db: Database.Database, shopId: string): ShopStateRow[] {
  const rows = db
    .prepare(
      `SELECT item_id, stock, inflation, trend, restocked_at
       FROM shop_state WHERE shop_id = ?`,
    )
    .all(shopId) as Row[];
  return rows.map(toRow);
}

export function upsertShopState(
  db: Database.Database,
  shopId: string,
  itemId: string,
  state: { stock: number; inflation: number; trend: number; restockedAt: string },
): void {
  db.prepare(
    `INSERT INTO shop_state (shop_id, item_id, stock, inflation, trend, restocked_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(shop_id, item_id) DO UPDATE SET
       stock = excluded.stock,
       inflation = excluded.inflation,
       trend = excluded.trend,
       restocked_at = excluded.restocked_at`,
  ).run(shopId, itemId, state.stock, state.inflation, state.trend, state.restockedAt);
}

// The spec signature takes db, but shop definitions live in gameData —
// the repository cannot reach them without the parameter.
export function getShop(gameData: GameData, shopId: string): Shop | undefined {
  return gameData.shops.shops.find((s) => s.id === shopId);
}

// Restocks when every row is older than RESTOCK_MS (or the shop was never
// initialized): stock = baseQty, inflation = 0, one random item becomes the
// trend of the day, restocked_at = now (ISO, timezone-independent).
export function restockIfNeeded(
  db: Database.Database,
  shop: Shop,
  now: number = Date.now(),
  rng: () => number = Math.random,
): ShopStateRow[] {
  const rows = getShopState(db, shop.id);
  const fresh =
    rows.length > 0 && rows.every((r) => now - parseDbTime(r.restockedAt) < RESTOCK_MS);
  if (fresh) return rows;

  const trendIndex = shop.stock.length > 0 ? Math.floor(rng() * shop.stock.length) : -1;
  const restockedAt = new Date(now).toISOString();
  for (const [i, entry] of shop.stock.entries()) {
    upsertShopState(db, shop.id, entry.itemId, {
      stock: entry.baseQty,
      inflation: 0,
      trend: i === trendIndex ? 1 : 0,
      restockedAt,
    });
  }
  return getShopState(db, shop.id);
}

export function getPrice(basePrice: number, shopMultiplier: number, inflation: number): number {
  return Math.round(basePrice * shopMultiplier * (1 + inflation / 100));
}

export function increaseInflation(
  db: Database.Database,
  shopId: string,
  itemId: string,
  amount = 0.5,
): void {
  db.prepare(
    `UPDATE shop_state
     SET inflation = MAX(0, MIN(50, inflation + ?))
     WHERE shop_id = ? AND item_id = ?`,
  ).run(amount, shopId, itemId);
}

// Sell price: 50% of base, 70% for the trend item. Floor, not round —
// the acceptance example sells rat_pelt (base 15) for 7.
export function getSellPrice(basePrice: number, isTrend: boolean): number {
  return Math.floor(basePrice * (isTrend ? 0.7 : 0.5));
}
