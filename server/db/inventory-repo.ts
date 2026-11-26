// Stage 4b: inventory repository — items, equipment, requirements checks.

import type Database from 'better-sqlite3';
import type { Item } from '../schemas/items';
import type { Character } from '../game/entities/character';

export const EQUIP_SLOTS = ['weapon', 'head', 'torso', 'jacket', 'legs', 'boots'] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];

export interface InventoryRow {
  id: number;
  itemId: string;
  qty: number;
  equippedSlot: EquipSlot | null;
}

export interface EquippedEntry {
  slot: EquipSlot;
  inventoryId: number;
  itemId: string;
}

export type EquipCheck =
  | { ok: true }
  | { ok: false; missing: Record<string, { need: number; have: number } | true> };

interface Row {
  id: number;
  item_id: string;
  qty: number;
  equipped_slot: string | null;
}

const SELECT_SQL =
  'SELECT id, item_id, qty, equipped_slot FROM inventory WHERE character_id = 1 ORDER BY id';

function toRow(r: Row): InventoryRow {
  return { id: r.id, itemId: r.item_id, qty: r.qty, equippedSlot: r.equipped_slot as EquipSlot | null };
}

export function getInventory(db: Database.Database): InventoryRow[] {
  return (db.prepare(SELECT_SQL).all() as Row[]).map(toRow);
}

// Item definitions live in gameData, not in the database.
export function getItemById(
  gameData: { items: { items: Item[] } },
  itemId: string,
): Item | undefined {
  return gameData.items.items.find((i) => i.id === itemId);
}

// Adds qty of itemId. If an unequipped stack of the same item exists, grows it;
// otherwise creates a new row. Equipped rows are never merged into.
export function addItem(
  db: Database.Database,
  itemId: string,
  qty: number,
  equippedSlot: EquipSlot | null = null,
): InventoryRow {
  if (equippedSlot === null) {
    const existing = db
      .prepare(
        'SELECT id FROM inventory WHERE character_id = 1 AND item_id = ? AND equipped_slot IS NULL',
      )
      .get(itemId) as { id: number } | undefined;
    if (existing) {
      db.prepare('UPDATE inventory SET qty = qty + ? WHERE id = ?').run(qty, existing.id);
      return toRow(
        db.prepare('SELECT id, item_id, qty, equipped_slot FROM inventory WHERE id = ?').get(existing.id) as Row,
      );
    }
  }
  const res = db
    .prepare(
      'INSERT INTO inventory (character_id, item_id, qty, equipped_slot) VALUES (1, ?, ?, ?)',
    )
    .run(itemId, qty, equippedSlot);
  return toRow(
    db.prepare('SELECT id, item_id, qty, equipped_slot FROM inventory WHERE id = ?').get(res.lastInsertRowid) as Row,
  );
}

// Decreases qty; removes the row when it reaches zero.
export function removeItem(db: Database.Database, inventoryId: number, qty: number): void {
  const row = db
    .prepare('SELECT qty FROM inventory WHERE id = ? AND character_id = 1')
    .get(inventoryId) as { qty: number } | undefined;
  if (!row) return;
  const left = row.qty - qty;
  if (left <= 0) {
    db.prepare('DELETE FROM inventory WHERE id = ?').run(inventoryId);
  } else {
    db.prepare('UPDATE inventory SET qty = ? WHERE id = ?').run(left, inventoryId);
  }
}

// Requirement check for weapon/armor against the character's stats.
export function canEquip(character: Character, item: Item): EquipCheck {
  if (item.type !== 'weapon' && item.type !== 'armor') {
    return { ok: false, missing: { not_equippable: true } };
  }
  const missing: Record<string, { need: number; have: number }> = {};
  const req = item.requirements as Record<string, number | undefined>;
  for (const key of ['level', 'str', 'agi', 'int', 'end', 'per', 'intel']) {
    const need = req[key];
    if (need === undefined) continue;
    const have = (character as unknown as Record<string, number>)[key];
    if (have < need) missing[key] = { need, have };
  }
  return Object.keys(missing).length > 0 ? { ok: false, missing } : { ok: true };
}

export type EquipResult =
  | { ok: true; row: InventoryRow }
  | { ok: false; error: 'not_found' | 'not_equippable' }
  | { ok: false; error: 'requirements_not_met'; missing: Record<string, { need: number; have: number }> };

// Equips the inventory row into its slot; whatever was equipped there is
// swapped out (equipped_slot = NULL).
export function equipItem(
  db: Database.Database,
  character: Character,
  inventoryId: number,
  gameData: { items: { items: Item[] } },
): EquipResult {
  const row = db
    .prepare('SELECT id, item_id, qty, equipped_slot FROM inventory WHERE id = ? AND character_id = 1')
    .get(inventoryId) as Row | undefined;
  if (!row) return { ok: false, error: 'not_found' };
  const item = getItemById(gameData, row.item_id);
  if (!item) return { ok: false, error: 'not_found' };
  const check = canEquip(character, item);
  if (!check.ok) {
    if ('not_equippable' in check.missing) return { ok: false, error: 'not_equippable' };
    return { ok: false, error: 'requirements_not_met', missing: check.missing as Record<string, { need: number; have: number }> };
  }
  // Reached only for weapon/armor.
  const slot: EquipSlot = item.type === 'weapon' ? 'weapon' : (item as { slot: EquipSlot }).slot;
  const apply = db.transaction(() => {
    db.prepare(
      'UPDATE inventory SET equipped_slot = NULL WHERE character_id = 1 AND equipped_slot = ?',
    ).run(slot);
    db.prepare('UPDATE inventory SET equipped_slot = ? WHERE id = ?').run(slot, inventoryId);
  });
  apply();
  return { ok: true, row: toRow({ ...row, equipped_slot: slot }) };
}

export function unequipItem(
  db: Database.Database,
  inventoryId: number,
): { ok: true } | { ok: false; error: 'not_found' | 'not_equipped' } {
  const row = db
    .prepare('SELECT equipped_slot FROM inventory WHERE id = ? AND character_id = 1')
    .get(inventoryId) as { equipped_slot: string | null } | undefined;
  if (!row) return { ok: false, error: 'not_found' };
  if (row.equipped_slot === null) return { ok: false, error: 'not_equipped' };
  db.prepare('UPDATE inventory SET equipped_slot = NULL WHERE id = ?').run(inventoryId);
  return { ok: true };
}

export function getEquipped(db: Database.Database): EquippedEntry[] {
  const rows = db
    .prepare(
      `SELECT id, item_id, equipped_slot FROM inventory
       WHERE character_id = 1 AND equipped_slot IS NOT NULL`,
    )
    .all() as Row[];
  return rows.map((r) => ({
    slot: r.equipped_slot as EquipSlot,
    inventoryId: r.id,
    itemId: r.item_id,
  }));
}
