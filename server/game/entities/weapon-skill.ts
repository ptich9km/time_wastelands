// Stage 9: weapon skills. skill grows by +1 per 10 successful attacks
// (hits counter in weapon_skills). Shown on the character screen; the
// accuracy bonus (getSkillBonus) is wired into the player's shots.

import type Database from 'better-sqlite3';

export const WEAPON_CATEGORIES = ['light', 'medium', 'heavy', 'sniper', 'melee'] as const;
export type WeaponCategory = (typeof WEAPON_CATEGORIES)[number];

export interface WeaponSkillRow {
  weaponCategory: WeaponCategory;
  skill: number;
  hits: number;
}

const MAX_SKILL = 100;
const HITS_PER_SKILL = 10;

export function getWeaponSkill(db: Database.Database, weaponCategory: WeaponCategory): number {
  const row = db
    .prepare('SELECT skill FROM weapon_skills WHERE character_id = 1 AND weapon_category = ?')
    .get(weaponCategory) as { skill: number } | undefined;
  return row?.skill ?? 0;
}

// All 5 categories, lazily creating missing rows with skill 0 / hits 0
// (characters created before stage 9 have no rows).
export function getAllWeaponSkills(db: Database.Database): WeaponSkillRow[] {
  return WEAPON_CATEGORIES.map((category) => {
    const row = db
      .prepare(
        'SELECT skill, hits FROM weapon_skills WHERE character_id = 1 AND weapon_category = ?',
      )
      .get(category) as { skill: number; hits: number } | undefined;
    return { weaponCategory: category, skill: row?.skill ?? 0, hits: row?.hits ?? 0 };
  });
}

// One successful attack: hits += 1; every HITS_PER_SKILL hits → skill += 1.
// Returns the new skill value (clamped to 0..100).
export function incrementWeaponSkill(
  db: Database.Database,
  weaponCategory: WeaponCategory,
  amount = 1,
): number {
  const row = db
    .prepare(
      'SELECT skill, hits FROM weapon_skills WHERE character_id = 1 AND weapon_category = ?',
    )
    .get(weaponCategory) as { skill: number; hits: number } | undefined;
  let skill = row?.skill ?? 0;
  let hits = (row?.hits ?? 0) + amount;
  while (hits >= HITS_PER_SKILL) {
    hits -= HITS_PER_SKILL;
    skill = Math.min(MAX_SKILL, skill + 1);
  }
  db.prepare(
    `INSERT INTO weapon_skills (character_id, weapon_category, skill, hits)
     VALUES (1, ?, ?, ?)
     ON CONFLICT (character_id, weapon_category)
     DO UPDATE SET skill = excluded.skill, hits = excluded.hits`,
  ).run(weaponCategory, skill, hits);
  return skill;
}

// Accuracy bonus 0..10 for hitChance.
export function getSkillBonus(skill: number): number {
  return Math.floor(skill / 10);
}

// Called on character creation: 5 rows with skill 0 / hits 0.
export function initWeaponSkills(db: Database.Database): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO weapon_skills (character_id, weapon_category, skill, hits) VALUES (1, ?, 0, 0)',
  );
  for (const category of WEAPON_CATEGORIES) {
    insert.run(category);
  }
}
