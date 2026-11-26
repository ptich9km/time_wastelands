// Stage 9: progression — new level table, perk points, weapon skills.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db';
import { characterRoutes } from '../server/api/character';
import { battleRoutes } from '../server/api/battle';
import { createCharacter } from '../server/game/entities/character';
import {
  getWeaponSkill,
  getAllWeaponSkills,
  incrementWeaponSkill,
  getSkillBonus,
} from '../server/game/entities/weapon-skill';
import { applyLevelUp, hitChance } from '../server/game/battle/formulas';
import { getBattle, updateBattleState } from '../server/db/battle-repo';
import type { BattleState } from '../server/game/battle/state';
import { loadGameData } from '../server/schemas/loader';
import { loadI18n, setI18n } from '../server/i18n';
import { LevelTableSchema } from '../server/schemas/level_table';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const gameData = loadGameData(DATA_DIR);
setI18n(loadI18n(DATA_DIR));
const levelTable = gameData.levelTable;

function makeDb(): Database.Database {
  const db = openDb(':memory:');
  createCharacter(db, {
    name: 'Странник',
    startLocationId: gameData.world.startLocationId,
    items: gameData.items.items,
  });
  return db;
}

const BASE_CHAR = {
  str: 3, agi: 3, int: 3, end: 3, per: 0, intel: 0,
  hp: 65, hpMax: 65, apMax: 21, level: 1, perkPoints: 0,
};

describe('level_table (stage 9)', () => {
  it('apMax = 15+2×end и hpMax = 50+5×end для всех уровней', () => {
    for (const row of levelTable.levels) {
      expect(row.apMax, `level ${row.level} apMax`).toBe(15 + 2 * row.end);
      expect(row.hpMax, `level ${row.level} hpMax`).toBe(50 + 5 * row.end);
    }
  });

  it('perkPoints накопительные: 0..9 для уровней 1..10', () => {
    expect(levelTable.levels.map((l) => l.perkPoints)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('таблица покрывает уровни 1..10 без дырок', () => {
    expect(levelTable.levels.map((l) => l.level).sort((a, b) => a - b))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('superRefine отклоняет строку с неверным hpMax', () => {
    const bad = {
      version: '2.0',
      levels: [{ level: 1, str: 3, agi: 3, int: 3, end: 3, per: 0, intel: 0, perkPoints: 0, apMax: 21, hpMax: 99 }],
    };
    expect(() => LevelTableSchema.parse(bad)).toThrow();
  });
});

describe('applyLevelUp (stage 9)', () => {
  it('level 1 → 2: статы 4/4/4/4/0/0, hpMax 70, apMax 23, perkPoints = 1', () => {
    const r = applyLevelUp({ character: BASE_CHAR, newLevel: 2, levelTable });
    expect(r.leveled).toBe(true);
    const c = r.character;
    expect([c.str, c.agi, c.int, c.end, c.per, c.intel]).toEqual([4, 4, 4, 4, 0, 0]);
    expect(c.hpMax).toBe(70);
    expect(c.apMax).toBe(23);
    expect(c.hp).toBe(70);
    expect(c.perkPoints).toBe(1);
  });

  it('level 2 → 3: статы 7/4/4/9/2/0, perkPoints заменяется на 2 (не +=)', () => {
    const char = { ...BASE_CHAR, level: 2, perkPoints: 1 };
    const r = applyLevelUp({ character: char, newLevel: 3, levelTable });
    const c = r.character;
    expect([c.str, c.agi, c.int, c.end, c.per, c.intel]).toEqual([7, 4, 4, 9, 2, 0]);
    expect(c.hpMax).toBe(95);
    expect(c.apMax).toBe(33);
    expect(c.perkPoints).toBe(2);
  });

  it('level 1 → 5 (прыжок): статы уровня 5, perkPoints = 4', () => {
    const r = applyLevelUp({ character: BASE_CHAR, newLevel: 5, levelTable });
    expect(r.character.str).toBe(11);
    expect(r.character.hpMax).toBe(125);
    expect(r.character.perkPoints).toBe(4);
  });

  it('level 5 → 5: leveled false, статы не меняются', () => {
    const char = { ...BASE_CHAR, level: 5, perkPoints: 4 };
    const r = applyLevelUp({ character: char, newLevel: 5, levelTable });
    expect(r.leveled).toBe(false);
    expect(r.character).toBe(char);
  });
});

describe('weapon skills', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => db.close());

  it('createCharacter инициализирует 5 строк (skill 0, hits 0)', () => {
    const rows = getAllWeaponSkills(db);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.weaponCategory).sort())
      .toEqual(['heavy', 'light', 'medium', 'melee', 'sniper']);
    for (const row of rows) {
      expect(row.skill).toBe(0);
      expect(row.hits).toBe(0);
    }
  });

  it('getWeaponSkill без строки → 0 (ленивая инициализация)', () => {
    const empty = openDb(':memory:');
    createCharacter(empty, {
      name: 'Странник',
      startLocationId: gameData.world.startLocationId,
    });
    empty.prepare('DELETE FROM weapon_skills').run();
    expect(getWeaponSkill(empty, 'light')).toBe(0);
    empty.close();
  });

  it('1 успешная атака → hits 1, skill 0', () => {
    expect(incrementWeaponSkill(db, 'light', 1)).toBe(0);
    const row = getAllWeaponSkills(db).find((r) => r.weaponCategory === 'light')!;
    expect(row.hits).toBe(1);
    expect(row.skill).toBe(0);
  });

  it('10 успешных атак → skill 1, hits 0', () => {
    for (let i = 0; i < 10; i++) incrementWeaponSkill(db, 'light', 1);
    const row = getAllWeaponSkills(db).find((r) => r.weaponCategory === 'light')!;
    expect(row.skill).toBe(1);
    expect(row.hits).toBe(0);
  });

  it('skill 100 → +1 успех: skill остаётся 100 (clamp), hits 1', () => {
    db.prepare("UPDATE weapon_skills SET skill = 100 WHERE weapon_category = 'light'").run();
    expect(incrementWeaponSkill(db, 'light', 1)).toBe(100);
    const row = getAllWeaponSkills(db).find((r) => r.weaponCategory === 'light')!;
    expect(row.skill).toBe(100);
    expect(row.hits).toBe(1);
  });

  it('getSkillBonus: 0 → 0, 10 → 1, 55 → 5, 100 → 10', () => {
    expect(getSkillBonus(0)).toBe(0);
    expect(getSkillBonus(10)).toBe(1);
    expect(getSkillBonus(55)).toBe(5);
    expect(getSkillBonus(100)).toBe(10);
  });
});

describe('hitChance с бонусом навыка', () => {
  const cfg = gameData.battleConfig;
  const params = {
    perAttacker: 5,
    agiTarget: 5,
    zone: 'torso' as const,
    distanceHexes: 2,
    weapon: { range: 5, spread: 50, sniper: false },
    positionAttacker: 'stand' as const,
    positionTarget: 'stand' as const,
    coverTarget: false,
    config: cfg.hit,
    sniperConfig: cfg.distance.sniper,
  };

  it('weaponSkillBonus прибавляется к шансу', () => {
    const base = hitChance(params).chance;
    const boosted = hitChance({ ...params, weaponSkillBonus: 7 }).chance;
    expect(boosted).toBeCloseTo(base + 7, 5);
  });

  it('без бонуса результат прежний (0 по умолчанию)', () => {
    expect(hitChance(params).chance).toBe(hitChance({ ...params, weaponSkillBonus: 0 }).chance);
  });
});

describe('stage 9 API', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    app = Fastify();
    app.db = openDb(':memory:');
    app.gameData = gameData;
    await app.register(characterRoutes);
    await app.register(battleRoutes);
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    await fetch(`${baseUrl}/api/character`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Странник' }),
    });
  });

  afterEach(async () => {
    await app.close();
    app.db.close();
    vi.restoreAllMocks();
  });

  const post = (url: string, payload?: unknown) =>
    fetch(`${baseUrl}${url}`, {
      method: 'POST',
      ...(payload === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    });

  async function startBattle(): Promise<string> {
    const res = await post('/api/battle/start', { mobIds: ['pipe_rat'] });
    expect(res.status).toBe(201);
    return ((await res.json()) as { battleId: string }).battleId;
  }

  // Places the mob at a given distance with a clean map and full player AP.
  function setupShot(battleId: string, distance: number): BattleState {
    const state = getBattle(app.db, battleId)!;
    state.map.obstacles = [];
    const player = state.participants.find((p) => p.kind === 'player')!;
    player.ap = player.apMax;
    const mob = state.participants.find((p) => p.kind === 'mob')!;
    mob.hex = { q: player.hex.q + distance, r: player.hex.r };
    mob.hp = 100;
    mob.hpMax = 100;
    updateBattleState(app.db, state);
    return state;
  }

  it('GET /api/character → perk_points и weaponSkills (5 категорий)', async () => {
    const res = await fetch(`${baseUrl}/api/character`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      character: { perk_points: number; weaponSkills: Array<{ weaponCategory: string; skill: number; hits: number }> };
    };
    expect(data.character.perk_points).toBe(0);
    expect(data.character.weaponSkills).toHaveLength(5);
    for (const s of data.character.weaponSkills) {
      expect(s.skill).toBe(0);
      expect(s.hits).toBe(0);
    }
  });

  it('успешный выстрел (труба, вплотную) → hits += 1', async () => {
    const battleId = await startBattle();
    setupShot(battleId, 1);
    vi.spyOn(Math, 'random').mockReturnValue(0.999); // point-blank: всё равно попадание
    const res = await post(`/api/battle/${battleId}/action`, {
      action: { type: 'shoot', targetId: 'mob_1', zone: 'torso' },
    });
    expect(res.status).toBe(200);
    const row = getAllWeaponSkills(app.db).find((r) => r.weaponCategory === 'melee')!;
    expect(row.hits).toBe(1);
  });

  it('промах (пистолет на дистанции, RNG 0.999) → hits не меняется', async () => {
    // Equip the pistol before the battle starts.
    app.db.prepare("UPDATE inventory SET equipped_slot = NULL WHERE equipped_slot = 'weapon'").run();
    app.db
      .prepare("INSERT INTO inventory (character_id, item_id, qty, equipped_slot) VALUES (1, 'army_pistol', 1, 'weapon')")
      .run();
    const battleId = await startBattle();
    setupShot(battleId, 3); // pistol range 3, chance < 100
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const res = await post(`/api/battle/${battleId}/action`, {
      action: { type: 'shoot', targetId: 'mob_1', zone: 'torso' },
    });
    expect(res.status).toBe(200);
    const skills = getAllWeaponSkills(app.db);
    expect(skills.find((r) => r.weaponCategory === 'light')!.hits).toBe(0);
    expect(skills.every((r) => r.hits === 0)).toBe(true);
  });

  it('10 попаданий подряд → skill = 1', async () => {
    for (let i = 0; i < 10; i++) {
      const battleId = await startBattle();
      setupShot(battleId, 1);
      vi.spyOn(Math, 'random').mockReturnValue(0.999);
      const res = await post(`/api/battle/${battleId}/action`, {
        action: { type: 'shoot', targetId: 'mob_1', zone: 'torso' },
      });
      expect(res.status).toBe(200);
      // Finish the battle so the next start is allowed.
      await post(`/api/battle/${battleId}/abandon`);
      vi.restoreAllMocks();
    }
    const row = getAllWeaponSkills(app.db).find((r) => r.weaponCategory === 'melee')!;
    expect(row.skill).toBe(1);
    expect(row.hits).toBe(0);
  });
});
