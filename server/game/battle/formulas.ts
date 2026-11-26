// Stage 5b: battle formulas — pure functions, all RNG is injected.
// No actions, no map, no AI (steps 5c–5e, 6).

import type { Position } from './state';
import type {
  HitConfig,
  DamageConfig,
  ArmorConfig,
  PenetrationConfig,
  DistanceConfig,
  XpConfig,
} from '../../schemas/battle_config';
import type { LevelTable } from '../../schemas/level_table';

export type Rng = () => number; // 0 <= rng() < 1

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

// --- Hit ---

export interface HitChanceParams {
  perAttacker: number;
  agiTarget: number;
  zone: 'head' | 'torso' | 'arms' | 'legs';
  distanceHexes: number; // >= 0; 0 = same hex
  weapon: { range: number; spread: number; sniper: boolean };
  positionAttacker: Position;
  positionTarget: Position;
  coverTarget: boolean;
  config: HitConfig;
  // Sniper falloff lives in config.distance.sniper of battle.json — passed separately.
  sniperConfig: DistanceConfig['sniper'];
}

export interface HitChanceResult {
  chance: number;
  distanceMod: number;
  zoneMod: number;
  positionMod: number;
  coverMod: number;
  pointBlank: boolean;
}

export function hitChance(params: HitChanceParams): HitChanceResult {
  const { config, weapon } = params;
  const pointBlank = params.distanceHexes <= config.pointBlankHexes;

  // Linear distance modifier:
  //  - normal weapon: 1.0 at 1 hex → spread/100 at `range` hexes, plateau beyond.
  //  - sniper: `sniper.pointBlank` at 1 hex → spread/100 at `sniper.plateauAt` × range, plateau.
  //  - distance 0 (same hex) → 1.0.
  const minMod = weapon.spread / 100;
  let distanceMod: number;
  if (params.distanceHexes <= 0) {
    distanceMod = 1.0;
  } else if (weapon.sniper) {
    const plateau = params.sniperConfig.plateauAt * weapon.range;
    if (params.distanceHexes <= 1) {
      distanceMod = params.sniperConfig.pointBlank;
    } else if (params.distanceHexes >= plateau) {
      distanceMod = minMod;
    } else {
      distanceMod =
        params.sniperConfig.pointBlank +
        (minMod - params.sniperConfig.pointBlank) *
          ((params.distanceHexes - 1) / (plateau - 1));
    }
  } else if (params.distanceHexes <= 1) {
    distanceMod = 1.0;
  } else if (params.distanceHexes >= weapon.range) {
    distanceMod = minMod;
  } else {
    distanceMod = 1.0 + (minMod - 1.0) * ((params.distanceHexes - 1) / (weapon.range - 1));
  }

  const baseRatio = params.perAttacker / Math.max(params.agiTarget, 1);
  const zoneMod =
    baseRatio >= 1 ? config.zoneModsIfPerAboveAgi : config.zoneMods[params.zone];

  const posA = config.positionMods[params.positionAttacker];
  const posT = config.positionMods[params.positionTarget];
  const positionMod = 1 + (posA.selfPenalty + posT.enemyPenalty) / 100;
  const coverMod = params.coverTarget ? 1 + config.coverBonus / 100 : 1.0;

  if (
    pointBlank &&
    (params.positionAttacker === 'stand' || params.positionAttacker === 'crouch') &&
    !params.coverTarget &&
    (params.positionTarget === 'stand' || params.positionTarget === 'crouch')
  ) {
    // Guaranteed hit in melee comfort — clamp does not apply.
    return { chance: 100, distanceMod, zoneMod, positionMod, coverMod, pointBlank };
  }

  const chance = clamp(
    100 * baseRatio * zoneMod * distanceMod * positionMod * coverMod,
    config.clampMin,
    config.clampMax,
  );
  return { chance, distanceMod, zoneMod, positionMod, coverMod, pointBlank };
}

// --- Damage ---

export function rollDamage(params: {
  weaponDamage: { min: number; max: number };
  ammoBonus: number; // 0 if no ammo loaded
  rng: Rng;
}): number {
  const { min, max } = params.weaponDamage;
  const rolled = min + Math.floor(params.rng() * (max - min + 1));
  return rolled + params.ammoBonus;
}

export function rollCrit(params: {
  intel: number;
  config: DamageConfig;
  rng: Rng;
}): boolean {
  const chance = (params.config.critChanceBase + params.intel * params.config.critChancePerIntel) / 100;
  return params.rng() < chance;
}

export function applyCrit(damage: number, config: DamageConfig): number {
  return Math.round(damage * config.critMultiplier);
}

// --- Armor ---

// Returns absorbed percentage, 0..config.maxAbsorb.
export function armorAbsorb(params: {
  armorValue: number; // Y
  weaponLevel: number; // X
  config: ArmorConfig;
}): number {
  const { config } = params;
  let absorb: number;
  if (params.weaponLevel <= 6) {
    absorb = (params.armorValue * config.formulaUpTo6.mult50) / config.formulaUpTo6.cap;
  } else {
    const denom = config.formulaAbove6.coef * params.weaponLevel - config.formulaAbove6.offset;
    // Zero/negative denominator: the armor is effectively "infinite" at this weapon level.
    absorb = denom <= 0 ? config.maxAbsorb : (params.armorValue * config.formulaAbove6.mult50) / denom;
  }
  return clamp(absorb, 0, config.maxAbsorb);
}

export function damageAfterArmor(params: {
  damage: number; // base after crit, before armor
  absorb: number; // percentage 0..maxAbsorb
  config: DamageConfig;
}): number {
  const final = params.damage * (1 - params.absorb / 100);
  return Math.max(Math.round(final), params.config.minDamage);
}

// --- Penetration ---

export function rollPenetration(params: { pen: number; rng: Rng }): boolean {
  return params.rng() < params.pen / 100;
}

export function damageWithPenetration(params: {
  baseDamage: number; // before armor, after crit
  absorb: number; // percentage
  penetrated: boolean;
  config: PenetrationConfig;
  damageConfig: DamageConfig;
}): number {
  const { baseDamage, absorb } = params;
  const ordinary = baseDamage * (1 - absorb / 100);
  let final: number;
  if (!params.penetrated || absorb > params.config.ignoredAbove) {
    final = ordinary;
  } else if (absorb < params.config.fullDamageBelow) {
    final = baseDamage; // full damage
  } else if (absorb <= params.config.linearTo) {
    const bonus = baseDamage - ordinary; // = baseDamage × absorb/100
    const penalty =
      (absorb - params.config.linearFrom) / (params.config.linearTo - params.config.linearFrom);
    final = ordinary + bonus * (1 - penalty);
  } else {
    final = ordinary;
  }
  return Math.max(Math.round(final), params.damageConfig.minDamage);
}

// --- Distance (damage beyond weapon range) ---

export function damageOutsideRange(params: {
  damage: number;
  distanceHexes: number;
  weaponRange: number;
  config: DistanceConfig;
  damageConfig: DamageConfig;
}): number {
  if (params.distanceHexes <= params.weaponRange) return params.damage;
  const divisor = params.config.outsideRangeDivisor;
  const final = params.damage / divisor ** (params.distanceHexes - params.weaponRange);
  return Math.max(Math.round(final), params.damageConfig.minDamage);
}

// --- XP ---

export function xpForKill(params: {
  mobHp: number;
  mobLevel: number;
  playerLevel: number;
  config: XpConfig;
}): number {
  const diff = params.mobLevel - params.playerLevel;
  const mod = clamp(
    1 + diff * params.config.levelDiffMod,
    params.config.levelDiffClampMin,
    params.config.levelDiffClampMax,
  );
  return Math.floor(params.mobHp * params.config.perHpBase * mod);
}

export function xpToNextLevel(params: { level: number; config: XpConfig }): number {
  return params.config.basePerLevel * params.level;
}

// --- Level up ---

export interface LevelableCharacter {
  str: number;
  agi: number;
  int: number;
  end: number;
  per: number;
  intel: number;
  hp: number;
  hpMax: number;
  apMax: number;
  level: number;
}

export function applyLevelUp(params: {
  character: LevelableCharacter;
  newLevel: number;
  levelTable: LevelTable;
}): { character: LevelableCharacter; leveled: boolean; oldLevel: number } {
  const { character, newLevel, levelTable } = params;
  const oldLevel = character.level;
  if (newLevel <= character.level) {
    return { character, leveled: false, oldLevel };
  }
  const row = levelTable.levels.find((l) => l.level === newLevel);
  if (!row) {
    throw new Error(`level_table: нет строки для уровня ${newLevel}`);
  }
  return {
    character: {
      ...character,
      str: row.str,
      agi: row.agi,
      int: row.int,
      end: row.end,
      per: row.per,
      intel: row.intel,
      hpMax: row.hpMax,
      apMax: row.apMax,
      hp: row.hpMax, // HP is fully restored on level up (MVP)
      level: row.level,
    },
    leveled: true,
    oldLevel,
  };
}
