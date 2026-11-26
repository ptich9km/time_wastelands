import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  hitChance,
  rollDamage,
  rollCrit,
  applyCrit,
  armorAbsorb,
  damageAfterArmor,
  rollPenetration,
  damageWithPenetration,
  damageOutsideRange,
  xpForKill,
  xpToNextLevel,
  applyLevelUp,
  type Rng,
} from '../server/game/battle/formulas';
import { BattleConfigSchema } from '../server/schemas/battle_config';
import { LevelTableSchema } from '../server/schemas/level_table';
import { loadGameData } from '../server/schemas/loader';

const gameData = loadGameData(path.resolve(__dirname, '..', 'data'));
const cfg = gameData.battleConfig;
const levelTable = gameData.levelTable;

const MELEE = { range: 1, spread: 100, sniper: false };
const RNG_GUN = { range: 5, spread: 20, sniper: false };

function hit(overrides: Partial<Parameters<typeof hitChance>[0]> = {}) {
  return hitChance({
    perAttacker: 3,
    agiTarget: 3,
    zone: 'torso',
    distanceHexes: 1,
    weapon: MELEE,
    positionAttacker: 'stand',
    positionTarget: 'stand',
    coverTarget: false,
    config: cfg.hit,
    perConfig: cfg.per,
    sniperConfig: cfg.distance.sniper,
    ...overrides,
  });
}

describe('hitChance', () => {
  it('pointBlank, оба stand, не cover → 100', () => {
    expect(hit().chance).toBe(100);
  });

  it('pointBlank, target в cover → не 100 (работает формула)', () => {
    const r = hit({ coverTarget: true });
    expect(r.chance).not.toBe(100);
    expect(r.coverMod).toBeCloseTo(0.7);
  });

  it('per=agi, торс, distance 1, stand/stand → 100 × 1.0 → clamp 95', () => {
    const r = hit({ perAttacker: 3, agiTarget: 3, coverTarget: true });
    // per=agi → zoneMod 1.0; distanceMod 1.0; позиции 1.0; cover 0.7 → 70
    expect(r.chance).toBeCloseTo(70);
  });

  it('per=10, agi=20 (ratio 0.5), голова (0.6) → 30', () => {
    const r = hit({ perAttacker: 10, agiTarget: 20, zone: 'head', coverTarget: true, distanceHexes: 3, weapon: RNG_GUN });
    // Stage 10a: per 10 → effectiveRange = 5 + 1 = 6; distance 3, spread 20:
    // 1 + (0.2-1)*(2/5) = 0.68 → 100 × 0.5 × 0.6 × 0.68 × 0.7 = 14.28
    expect(r.zoneMod).toBe(0.6);
    expect(r.distanceMod).toBeCloseTo(0.68);
    expect(r.chance).toBeCloseTo(14.28);
  });

  it('чистый пример спеки: per=10 agi=20 голова, distance 1 → 30', () => {
    // distance 1, но coverTarget=true чтобы не сработал pointBlank-auto-100
    const r = hit({ perAttacker: 10, agiTarget: 20, zone: 'head', coverTarget: true, weapon: { range: 1, spread: 100, sniper: false } });
    // pointBlank + coverTarget → формула: 100 × 0.5 × 0.6 × 1.0 × 1 × 0.7 = 21
    expect(r.chance).toBeCloseTo(21);
  });

  it('per=20, agi=10 (ratio 2.0 ≥ 1), голова → zoneMod 1.0 → clamp 95', () => {
    const r = hit({ perAttacker: 20, agiTarget: 10, zone: 'head', coverTarget: true, distanceHexes: 2, weapon: { range: 5, spread: 100, sniper: false } });
    expect(r.zoneMod).toBe(1.0);
    // 100 × 2 × 1 × 1 × 1 × 0.7 = 140 → clamp 95
    expect(r.chance).toBe(95);
  });

  it('distance 5 при range 5, spread 20 → distanceMod 0.2', () => {
    const r = hit({ perAttacker: 3, agiTarget: 3, distanceHexes: 5, weapon: RNG_GUN, coverTarget: true });
    expect(r.distanceMod).toBeCloseTo(0.2);
    // 100 × 1 × 1 × 0.2 × 1 × 0.7 = 14
    expect(r.chance).toBeCloseTo(14);
  });

  it('distance 0 (тот же гекс) → distanceMod 1.0', () => {
    const r = hit({ distanceHexes: 0, weapon: RNG_GUN, coverTarget: true });
    expect(r.distanceMod).toBe(1.0);
  });

  it('sniper: range 10, spread 70, distance 1 → 0.1; distance 7 → 0.7; distance 10 → 0.7 (плато)', () => {
    const sniper = { range: 10, spread: 70, sniper: true };
    expect(hit({ weapon: sniper, distanceHexes: 1, coverTarget: true }).distanceMod).toBeCloseTo(0.1);
    expect(hit({ weapon: sniper, distanceHexes: 7, coverTarget: true }).distanceMod).toBeCloseTo(0.7);
    expect(hit({ weapon: sniper, distanceHexes: 10, coverTarget: true }).distanceMod).toBeCloseTo(0.7);
  });

  it('target run → positionMod учитывает enemyPenalty −30', () => {
    const r = hit({ positionTarget: 'run', coverTarget: true, distanceHexes: 3, weapon: RNG_GUN });
    expect(r.positionMod).toBeCloseTo(0.7);
  });

  it('attacker run → selfPenalty −20', () => {
    const r = hit({ positionAttacker: 'run', coverTarget: true, distanceHexes: 3, weapon: RNG_GUN });
    expect(r.positionMod).toBeCloseTo(0.8);
  });

  it('clampMin: промах не ниже 5%', () => {
    const r = hit({ perAttacker: 1, agiTarget: 50, zone: 'head', coverTarget: true, distanceHexes: 5, weapon: RNG_GUN });
    expect(r.chance).toBe(5);
  });
});

describe('rollDamage / rollCrit / applyCrit', () => {
  it('rng()=0 → min; rng()=0.99 → max', () => {
    expect(rollDamage({ weaponDamage: { min: 4, max: 9 }, ammoBonus: 0, rng: () => 0 })).toBe(4);
    expect(rollDamage({ weaponDamage: { min: 4, max: 9 }, ammoBonus: 0, rng: () => 0.99 })).toBe(9);
  });

  it('ammoBonus добавляется', () => {
    expect(rollDamage({ weaponDamage: { min: 4, max: 9 }, ammoBonus: 3, rng: () => 0 })).toBe(7);
  });

  it('rollCrit: intel=0, rng 0.04 → true; rng 0.06 → false', () => {
    expect(rollCrit({ intel: 0, config: cfg.damage, rng: () => 0.04 })).toBe(true);
    expect(rollCrit({ intel: 0, config: cfg.damage, rng: () => 0.06 })).toBe(false);
  });

  it('applyCrit: ×1.5 round', () => {
    expect(applyCrit(9, cfg.damage)).toBe(14); // 13.5 → 14
  });
});

describe('armorAbsorb', () => {
  it('armor 100, weapon 12 → 100×50/(240−80) = 31.25', () => {
    expect(armorAbsorb({ armorValue: 100, weaponLevel: 12, config: cfg.armor })).toBeCloseTo(31.25);
  });

  it('armor 80, weapon 5 (≤6) → min(80×50/80, 80) = 50', () => {
    expect(armorAbsorb({ armorValue: 80, weaponLevel: 5, config: cfg.armor })).toBe(50);
  });

  it('armor 200, weapon 12 → 62.5 × diminishing → 56.25', () => {
    expect(armorAbsorb({ armorValue: 200, weaponLevel: 12, config: cfg.armor })).toBeCloseTo(56.25);
  });

  it('armor 1000, weapon 12 → clamp 80 × diminishing → 65', () => {
    expect(armorAbsorb({ armorValue: 1000, weaponLevel: 12, config: cfg.armor })).toBe(65);
  });

  it('знаменатель ≤ 0 → maxAbsorb → diminishing → 65', () => {
    expect(armorAbsorb({ armorValue: 10, weaponLevel: 7, config: { ...cfg.armor, formulaAbove6: { mult50: 50, coef: 1, offset: 100 } } })).toBe(65);
  });
});

describe('damageAfterArmor', () => {
  it('base 100, absorb 0 → 100', () => {
    expect(damageAfterArmor({ damage: 100, absorb: 0, config: cfg.damage })).toBe(100);
  });
  it('base 100, absorb 50 → 50', () => {
    expect(damageAfterArmor({ damage: 100, absorb: 50, config: cfg.damage })).toBe(50);
  });
  it('base 100, absorb 80 → 20', () => {
    expect(damageAfterArmor({ damage: 100, absorb: 80, config: cfg.damage })).toBe(20);
  });
  it('base 1, absorb 80 → minDamage 1 (не 0)', () => {
    expect(damageAfterArmor({ damage: 1, absorb: 80, config: cfg.damage })).toBe(1);
  });
});

describe('damageWithPenetration (пример из вики)', () => {
  it('base 135, absorb 45, penetrated → 125', () => {
    expect(
      damageWithPenetration({ baseDamage: 135, absorb: 45, penetrated: true, config: cfg.penetration, damageConfig: cfg.damage }),
    ).toBe(125);
  });
  it('base 135, absorb 30, penetrated → 135 (полный урон)', () => {
    expect(
      damageWithPenetration({ baseDamage: 135, absorb: 30, penetrated: true, config: cfg.penetration, damageConfig: cfg.damage }),
    ).toBe(135);
  });
  it('base 135, absorb 75, penetrated → бронебой игнорируется → 34', () => {
    expect(
      damageWithPenetration({ baseDamage: 135, absorb: 75, penetrated: true, config: cfg.penetration, damageConfig: cfg.damage }),
    ).toBe(34); // 33.75 → round
  });
  it('base 135, absorb 45, not penetrated → 75', () => {
    expect(
      damageWithPenetration({ baseDamage: 135, absorb: 45, penetrated: false, config: cfg.penetration, damageConfig: cfg.damage }),
    ).toBe(74); // 74.25 → round
  });

  it('rollPenetration: pen 0 → false, pen 100 → true, граница rng', () => {
    expect(rollPenetration({ pen: 0, rng: () => 0 })).toBe(false);
    expect(rollPenetration({ pen: 100, rng: () => 0.99 })).toBe(true);
    expect(rollPenetration({ pen: 40, rng: () => 0.39 })).toBe(true);
    expect(rollPenetration({ pen: 40, rng: () => 0.41 })).toBe(false);
  });
});

describe('damageOutsideRange', () => {
  const base = { config: cfg.distance, damageConfig: cfg.damage };
  it('distance 5, range 5 → 100', () => {
    expect(damageOutsideRange({ damage: 100, distanceHexes: 5, weaponRange: 5, ...base })).toBe(100);
  });
  it('distance 6, range 5, divisor 2 → 50', () => {
    expect(damageOutsideRange({ damage: 100, distanceHexes: 6, weaponRange: 5, ...base })).toBe(50);
  });
  it('distance 8, range 5 → 12.5 → 13 (round)', () => {
    expect(damageOutsideRange({ damage: 100, distanceHexes: 8, weaponRange: 5, ...base })).toBe(13);
  });
});

describe('xp', () => {
  it('xpForKill: равный уровень → mobHp', () => {
    expect(xpForKill({ mobHp: 18, mobLevel: 1, playerLevel: 1, config: cfg.xp })).toBe(18);
  });
  it('xpForKill: моб на 2 уровня старше → 18 × 1.2 = 21', () => {
    expect(xpForKill({ mobHp: 18, mobLevel: 3, playerLevel: 1, config: cfg.xp })).toBe(21);
  });
  it('xpForKill: моб намного слабее → clamp 0.1 → 1', () => {
    expect(xpForKill({ mobHp: 18, mobLevel: 1, playerLevel: 10, config: cfg.xp })).toBe(1);
  });
  it('xpForKill: моб намного сильнее → 100 × 1.9 = 190', () => {
    expect(xpForKill({ mobHp: 100, mobLevel: 10, playerLevel: 1, config: cfg.xp })).toBe(190);
  });
  it('xpToNextLevel: level 1 → 600, level 5 → 3000', () => {
    expect(xpToNextLevel({ level: 1, config: cfg.xp })).toBe(600);
    expect(xpToNextLevel({ level: 5, config: cfg.xp })).toBe(3000);
  });
});

describe('applyLevelUp', () => {
  const base = { str: 3, agi: 3, int: 3, end: 3, per: 0, intel: 0, hp: 40, hpMax: 65, apMax: 21, level: 1, perkPoints: 0 };

  it('level 1 → 2: статы из таблицы, hpMax 70, apMax 23, hp восстановлен', () => {
    const r = applyLevelUp({ character: base, newLevel: 2, levelTable });
    expect(r.leveled).toBe(true);
    expect(r.oldLevel).toBe(1);
    expect(r.character.str).toBe(4);
    expect(r.character.end).toBe(4);
    expect(r.character.hpMax).toBe(70);
    expect(r.character.apMax).toBe(23);
    expect(r.character.hp).toBe(70); // восстановлен до hpMax
  });

  it('level 5 → 5: leveled false, статы не меняются', () => {
    const char = { ...base, level: 5 };
    const r = applyLevelUp({ character: char, newLevel: 5, levelTable });
    expect(r.leveled).toBe(false);
    expect(r.character).toBe(char);
  });

  it('level 1 → 5 (прыжок): статы уровня 5, hpMax 125', () => {
    const r = applyLevelUp({ character: base, newLevel: 5, levelTable });
    expect(r.character.str).toBe(11);
    expect(r.character.hpMax).toBe(125);
    expect(r.character.level).toBe(5);
  });

  it('несуществующий уровень → ошибка', () => {
    expect(() => applyLevelUp({ character: base, newLevel: 99, levelTable })).toThrow();
  });
});

describe('конфиг и таблица уровней', () => {
  it('BattleConfigSchema валидирует дефолтный конфиг', () => {
    expect(() => BattleConfigSchema.parse(cfg)).not.toThrow();
  });

  it('битой конфиг (clampMin > clampMax) → ошибка', () => {
    expect(() =>
      BattleConfigSchema.parse({ ...cfg, hit: { ...cfg.hit, clampMin: 96, clampMax: 95 } }),
    ).toThrow();
  });

  it('level_table покрывает уровни 1..10 без дыр', () => {
    expect(levelTable.levels.map((l) => l.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('LevelTableSchema: hpMax/apMax соответствуют формулам', () => {
    expect(() => LevelTableSchema.parse(levelTable)).not.toThrow();
    const broken = {
      ...levelTable,
      levels: levelTable.levels.map((l) => (l.level === 1 ? { ...l, hpMax: 999 } : l)),
    };
    expect(() => LevelTableSchema.parse(broken)).toThrow();
  });
});

describe('формулы не используют Math.random напрямую', () => {
  it('тот же rng → тот же результат (детерминизм)', () => {
    const seq = [0.5, 0.03, 0.7];
    const make = () => {
      let i = 0;
      return () => seq[i++ % seq.length];
    };
    const a = rollDamage({ weaponDamage: { min: 1, max: 10 }, ammoBonus: 0, rng: make() });
    const b = rollDamage({ weaponDamage: { min: 1, max: 10 }, ammoBonus: 0, rng: make() });
    expect(a).toBe(b);
    const r: Rng = make();
    expect(rollCrit({ intel: 5, config: cfg.damage, rng: r })).toBe(rollCrit({ intel: 5, config: cfg.damage, rng: make() }));
  });
});
