// Stage 10a: PER→range, armor diminishing returns, heal cap, defeat check.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadGameData } from '../server/schemas/loader';
import { loadI18n, setI18n } from '../server/i18n';
import { openDb } from '../server/db';
import { createCharacter, getCharacter } from '../server/game/entities/character';
import { updateCharacter } from '../server/db/character-repo';
import { buildBattleState } from '../server/game/battle/start';
import { syncAfterBattle } from '../server/game/battle/sync';
import { armorAbsorb, hitChance } from '../server/game/battle/formulas';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const gameData = loadGameData(DATA_DIR);
const cfg = gameData.battleConfig;
setI18n(loadI18n(DATA_DIR));

const WEAPON = { range: 10, spread: 40, sniper: false };

function hit(overrides: Record<string, unknown> = {}) {
  return hitChance({
    perAttacker: 0,
    agiTarget: 5,
    zone: 'torso',
    distanceHexes: 2,
    weapon: WEAPON,
    positionAttacker: 'stand',
    positionTarget: 'stand',
    coverTarget: true,
    config: cfg.hit,
    perConfig: cfg.per,
    sniperConfig: cfg.distance.sniper,
    ...overrides,
  });
}

function absorb(armorValue: number, weaponLevel = 5) {
  return armorAbsorb({ armorValue, weaponLevel, config: cfg.armor });
}

function makeDb() {
  const db = openDb(':memory:');
  createCharacter(db, {
    name: 'Баланс',
    startLocationId: gameData.world.startLocationId,
    items: gameData.items.items,
  });
  return db;
}

describe('battle.json: новые секции 10a', () => {
  it('per.rangeBonusPerPoint = 10', () => {
    expect(cfg.per.rangeBonusPerPoint).toBe(10);
  });

  it('armor.diminishingAfter = 50, diminishingFactor = 0.5', () => {
    expect(cfg.armor.diminishingAfter).toBe(50);
    expect(cfg.armor.diminishingFactor).toBe(0.5);
  });

  it('healLimit.startMult = 1.2 (было 1.5)', () => {
    expect(cfg.healLimit.startMult).toBe(1.2);
    expect(cfg.healLimit.regenPerRoundMult).toBe(0.2);
  });
});

describe('hitChance: PER → effectiveRange', () => {
  it('per 0 → effectiveRange = weapon.range', () => {
    expect(hit().effectiveRange).toBe(WEAPON.range);
  });

  it('per 20 → effectiveRange = range + 2', () => {
    expect(hit({ perAttacker: 20 }).effectiveRange).toBe(WEAPON.range + 2);
  });

  it('mob и игрок считают диапазон одинаково', () => {
    const mob = hit({ perAttacker: 20, agiTarget: 5 });
    const player = hit({ perAttacker: 20, agiTarget: 5 });
    expect(mob.effectiveRange).toBe(player.effectiveRange);
  });

  it('sniper: per 20, range 10 → плато на 0.7 × 12 = 8.4', () => {
    const weapon = { range: 10, spread: 20, sniper: true };
    expect(hit({ perAttacker: 20, weapon }).effectiveRange).toBe(12);
    // At distance 8, per 0 is already past its plateau (7 → spread/100),
    // while per 20 is still on the slope towards the plateau at 8.4.
    expect(hit({ perAttacker: 0, weapon, distanceHexes: 8 }).distanceMod).toBeCloseTo(0.2);
    expect(hit({ perAttacker: 20, weapon, distanceHexes: 8 }).distanceMod).toBeLessThan(0.2);
  });
});

describe('armorAbsorb: убывающая отдача после 50%', () => {
  it('base 80 → 65', () => {
    // 128 × 50/80 = 80 before diminishing.
    expect(absorb(128)).toBe(65);
  });

  it('base 50 → 50 (без изменений)', () => {
    expect(absorb(80)).toBe(50);
  });

  it('base 30 → 30 (без изменений)', () => {
    expect(absorb(48)).toBe(30);
  });

  it('base 100 → clamp 80 → 65', () => {
    expect(absorb(1000)).toBe(65);
  });
});

describe('healLimit 1.2×', () => {
  it('hpMax 65 → healLimit.max = 78 (было 97)', () => {
    const db = makeDb();
    const state = buildBattleState(
      db,
      gameData.world,
      getCharacter(db)!,
      [gameData.mobs.mobs.find((m) => m.id === 'pipe_rat')!],
      'ru',
      gameData.items.items,
      [false],
      cfg,
    );
    expect(state.participants[0].hpMax).toBe(65);
    expect(state.healLimit.max).toBe(78);
    expect(state.healLimit.current).toBe(78);
  });

  it('regen = floor(65 × 0.2) = 13', () => {
    const db = makeDb();
    const state = buildBattleState(
      db,
      gameData.world,
      getCharacter(db)!,
      [gameData.mobs.mobs.find((m) => m.id === 'pipe_rat')!],
      'ru',
      gameData.items.items,
      [false],
      cfg,
    );
    expect(state.healLimit.regenPerRound).toBe(13);
  });
});

describe('syncAfterBattle defeat', () => {
  it('hp = 1, money = floor(53 × 0.9) = 47, стартовая локация', () => {
    const db = makeDb();
    updateCharacter(db, { id: 1, money: 53, location_id: 'old_crossing' });
    const character = getCharacter(db)!;
    const state = buildBattleState(
      db,
      gameData.world,
      character,
      [gameData.mobs.mobs.find((m) => m.id === 'pipe_rat')!],
      'ru',
      gameData.items.items,
      [false],
      cfg,
    );
    const defeat = { ...state, status: 'defeat' as const, phase: 'finished' as const };
    const result = syncAfterBattle({
      db,
      state: defeat,
      items: gameData.items.items,
      mobs: gameData.mobs.mobs,
      config: cfg,
      levelTable: gameData.levelTable,
      world: gameData.world,
      lang: 'ru',
    });
    expect(result.character.hp_current).toBe(1);
    expect(result.character.money).toBe(47);
    expect(result.character.location_id).toBe(gameData.world.startLocationId);
    expect(result.rewards.moneyLost).toBe(6);
  });
});
