// Stage 8: buy/sell logic. HTTP-free; the API layer maps errors to statuses.

import type Database from 'better-sqlite3';
import type { GameData } from '../../schemas/loader';
import type { Item } from '../../schemas/items';
import { getCharacter, updateCharacter, type CharacterRow } from '../../db/character-repo';
import { addItem, getInventory, getItemById, removeItem, type InventoryRow } from '../../db/inventory-repo';
import {
  getShop,
  getShopState,
  getPrice,
  getSellPrice,
  increaseInflation,
  restockIfNeeded,
  upsertShopState,
  type ShopStateRow,
} from '../../db/shop-repo';

export type BuyError =
  | 'not_found'
  | 'no_character'
  | 'out_of_stock'
  | 'not_enough_money'
  | 'requirements_not_met';

export type SellError = 'not_found' | 'no_character' | 'not_sellable';

function requirementsMet(character: CharacterRow, item: Item): boolean {
  const req = item.requirements as Record<string, number | undefined>;
  for (const key of ['level', 'str', 'agi', 'int', 'end', 'per', 'intel']) {
    const need = req[key];
    if (need === undefined) continue;
    const have = (character as unknown as Record<string, number>)[key];
    if (have < need) return false;
  }
  return true;
}

export function canBuy(
  character: CharacterRow,
  item: Item,
  shopState: ShopStateRow,
  price: number,
): { ok: true } | { ok: false; reason: 'not_enough_money' | 'out_of_stock' | 'requirements_not_met' } {
  if (shopState.stock <= 0) return { ok: false, reason: 'out_of_stock' };
  if (character.money < price) return { ok: false, reason: 'not_enough_money' };
  if (!requirementsMet(character, item)) return { ok: false, reason: 'requirements_not_met' };
  return { ok: true };
}

export type BuyResult =
  | { ok: true; character: CharacterRow; inventory: InventoryRow[]; shopState: ShopStateRow[] }
  | { ok: false; error: BuyError };

export function buyItem(
  db: Database.Database,
  gameData: GameData,
  shopId: string,
  itemId: string,
  qty = 1,
): BuyResult {
  const shop = getShop(gameData, shopId);
  const entry = shop?.stock.find((s) => s.itemId === itemId);
  const item = getItemById(gameData, itemId);
  if (!shop || !entry || !item) return { ok: false, error: 'not_found' };
  const character = getCharacter(db);
  if (!character) return { ok: false, error: 'no_character' };

  const states = restockIfNeeded(db, shop);
  const state = states.find((s) => s.itemId === itemId)!;
  const price = getPrice(item.price, shop.multiplier, state.inflation);

  const check = canBuy(character, item, { ...state, stock: state.stock }, price * qty);
  if (!check.ok) return { ok: false, error: check.reason };
  if (state.stock < qty) return { ok: false, error: 'out_of_stock' };

  const total = price * qty;
  const apply = db.transaction(() => {
    updateCharacter(db, { id: 1, money: character.money - total });
    addItem(db, itemId, qty);
    upsertShopState(db, shopId, itemId, {
      stock: state.stock - qty,
      inflation: state.inflation,
      trend: state.trend,
      restockedAt: state.restockedAt,
    });
    increaseInflation(db, shopId, itemId, 0.5 * qty);
  });
  apply();

  return {
    ok: true,
    character: getCharacter(db)!,
    inventory: getInventory(db),
    shopState: getShopState(db, shopId),
  };
}

export type SellResult =
  | { ok: true; character: CharacterRow; inventory: InventoryRow[]; price: number }
  | { ok: false; error: SellError };

export function sellItem(
  db: Database.Database,
  gameData: GameData,
  shopId: string,
  inventoryId: number,
): SellResult {
  const shop = getShop(gameData, shopId);
  if (!shop) return { ok: false, error: 'not_found' };
  const character = getCharacter(db);
  if (!character) return { ok: false, error: 'no_character' };

  const row = db
    .prepare('SELECT id, item_id, qty, equipped_slot FROM inventory WHERE id = ? AND character_id = 1')
    .get(inventoryId) as { id: number; item_id: string; qty: number; equipped_slot: string | null } | undefined;
  if (!row) return { ok: false, error: 'not_found' };
  if (row.equipped_slot !== null) return { ok: false, error: 'not_sellable' };
  const item = getItemById(gameData, row.item_id);
  if (!item) return { ok: false, error: 'not_found' };

  const states = restockIfNeeded(db, shop);
  const isTrend = states.find((s) => s.itemId === item.id)?.trend === 1;
  const price = getSellPrice(item.price, isTrend);

  const apply = db.transaction(() => {
    removeItem(db, inventoryId, 1);
    updateCharacter(db, { id: 1, money: character.money + price });
  });
  apply();

  return { ok: true, character: getCharacter(db)!, inventory: getInventory(db), price };
}
