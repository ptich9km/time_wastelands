// Stage 2: character rules. Starting stats are FIXED — the client never sends them.

import type Database from 'better-sqlite3';
import {
  getCharacter as repoGetCharacter,
  insertCharacter,
  type CharacterRow,
} from '../../db/character-repo';
import { addItem } from '../../db/inventory-repo';
import type { Item } from '../../schemas/items';

export type Character = CharacterRow;

// Starting values (TimeZero, 6 stats): 3/3/3/3/0/0
export const START_STATS = {
  str: 3,
  agi: 3,
  int: 3, // intuition
  end: 3, // endurance
  per: 0, // perception
  intel: 0, // intellect
} as const;

export const START_MONEY = 50;

export const NAME_RE = /^[\p{L}0-9 \-]{2,20}$/u;

export function isValidName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name);
}

export function calcHpMax(end: number): number {
  return 50 + 5 * end;
}

export function calcApMax(end: number): number {
  return 15 + 2 * end;
}

export function getCharacter(db: Database.Database): Character | null {
  return repoGetCharacter(db);
}

// Starter kit (stage 4b). Each entry is granted only if the item exists
// in items.json — missing entries are skipped silently.
const STARTER_KIT: Array<{ itemId: string; qty: number; slot: 'weapon' | 'jacket' | null }> = [
  { itemId: 'rusty_pipe', qty: 1, slot: 'weapon' },
  { itemId: 'leather_jacket', qty: 1, slot: 'jacket' },
  { itemId: 'medkit', qty: 2, slot: null },
];

export function grantStarterKit(
  db: Database.Database,
  items: Item[],
): void {
  const ids = new Set(items.map((i) => i.id));
  for (const entry of STARTER_KIT) {
    if (ids.has(entry.itemId)) {
      addItem(db, entry.itemId, entry.qty, entry.slot);
    }
  }
}

// Creates a character with fixed stats. Throws Error('character_exists')
// if row id=1 already exists, and Error('invalid_name') on a bad name.
// The starter kit is granted in the same transaction as character creation.
export function createCharacter(
  db: Database.Database,
  input: { name: unknown; startLocationId: string; items?: Item[] },
): Character {
  if (!isValidName(input.name)) {
    throw new Error('invalid_name');
  }
  if (repoGetCharacter(db)) {
    throw new Error('character_exists');
  }
  const hpMax = calcHpMax(START_STATS.end);
  const create = db.transaction(() => {
    const character = insertCharacter(db, {
      name: input.name as string,
      str: START_STATS.str,
      agi: START_STATS.agi,
      int: START_STATS.int,
      end: START_STATS.end,
      per: START_STATS.per,
      intel: START_STATS.intel,
      hp_current: hpMax,
      hp_max: hpMax,
      ap_max: calcApMax(START_STATS.end),
      money: START_MONEY,
      location_id: input.startLocationId,
    });
    if (input.items) {
      grantStarterKit(db, input.items);
    }
    return character;
  });
  return create();
}

// One-time backfill for characters created before stage 4b:
// if a character exists and the inventory is empty, grant the starter kit
// once and mark it in meta.
export function backfillStarterKit(
  db: Database.Database,
  items: Item[],
): boolean {
  const granted = db
    .prepare("SELECT value FROM meta WHERE key = 'starter_kit_granted'")
    .get() as { value: string } | undefined;
  if (granted) return false;
  const character = repoGetCharacter(db);
  if (!character) return false;
  const count = db
    .prepare('SELECT COUNT(*) AS c FROM inventory WHERE character_id = 1')
    .get() as { c: number };
  if (count.c > 0) {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('starter_kit_granted', '1')").run();
    return false;
  }
  const run = db.transaction(() => {
    grantStarterKit(db, items);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('starter_kit_granted', '1')").run();
  });
  run();
  return true;
}
