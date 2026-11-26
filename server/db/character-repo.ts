// Character repository. Prepared statements; "end" is always in double quotes.

import type Database from 'better-sqlite3';

export interface CharacterRow {
  id: number;
  name: string;
  level: number;
  xp: number;
  str: number;
  agi: number;
  int: number;
  end: number;
  per: number;
  intel: number;
  hp_current: number;
  hp_max: number;
  ap_max: number;
  money: number;
  location_id: string;
  perk_points: number;
  last_rest_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_SQL = `
  SELECT id, name, level, xp, str, agi, int, "end", per, intel,
         hp_current, hp_max, ap_max, money, location_id, perk_points, last_rest_at, created_at, updated_at
  FROM characters WHERE id = 1
`;

export function getCharacter(db: Database.Database): CharacterRow | null {
  const row = db.prepare(SELECT_SQL).get() as CharacterRow | undefined;
  return row ?? null;
}

export interface InsertCharacterInput {
  name: string;
  str: number;
  agi: number;
  int: number;
  end: number;
  per: number;
  intel: number;
  hp_current: number;
  hp_max: number;
  ap_max: number;
  money: number;
  location_id: string;
}

export function insertCharacter(
  db: Database.Database,
  c: InsertCharacterInput,
): CharacterRow {
  db.prepare(
    `INSERT INTO characters
       (id, name, str, agi, int, "end", per, intel,
        hp_current, hp_max, ap_max, money, location_id)
     VALUES
       (1, @name, @str, @agi, @int, @end, @per, @intel,
        @hp_current, @hp_max, @ap_max, @money, @location_id)`,
  ).run({ ...c, end: c.end });
  return getCharacter(db)!;
}

export function updateCharacter(
  db: Database.Database,
  c: Partial<Omit<CharacterRow, 'id' | 'created_at' | 'updated_at'>> & { id: 1 },
): CharacterRow {
  const fields: Record<string, string> = {
    name: 'name', level: 'level', xp: 'xp', str: 'str', agi: 'agi',
    int: 'int', end: '"end"', per: 'per', intel: 'intel',
    hp_current: 'hp_current', hp_max: 'hp_max', ap_max: 'ap_max',
    money: 'money', location_id: 'location_id', perk_points: 'perk_points', last_rest_at: 'last_rest_at',
  };
  const sets: string[] = [];
  const params: Record<string, unknown> = { id: 1 };
  for (const [key, col] of Object.entries(fields)) {
    if (key in c) {
      sets.push(`${col} = @${key}`);
      params[key] = (c as Record<string, unknown>)[key];
    }
  }
  if (sets.length === 0) return getCharacter(db)!;
  sets.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE characters SET ${sets.join(', ')} WHERE id = 1`).run(params);
  return getCharacter(db)!;
}
