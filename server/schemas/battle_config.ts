// Stage 5b: battle formulas config (data/config/battle.json).

import { z } from 'zod';

const PositionModsSchema = z.object({
  enemyPenalty: z.number(),
  selfPenalty: z.number(),
  dodge: z.number(),
});

export const HitConfigSchema = z.object({
  clampMin: z.number().min(0).max(100),
  clampMax: z.number().min(0).max(100),
  zoneMods: z.object({
    torso: z.number(),
    arms: z.number(),
    legs: z.number(),
    head: z.number(),
  }),
  zoneModsIfPerAboveAgi: z.number(),
  positionMods: z.object({
    stand: PositionModsSchema,
    crouch: PositionModsSchema,
    run: PositionModsSchema,
    cover: PositionModsSchema,
  }),
  coverBonus: z.number(),
  pointBlankHexes: z.number().min(0),
}).refine((c) => c.clampMin <= c.clampMax, 'hit.clampMin <= hit.clampMax');

// Stage 10a: every 10 PER points add one hex of effective weapon range.
export const PerConfigSchema = z.object({
  rangeBonusPerPoint: z.number().int().positive(),
});

export const DamageConfigSchema = z.object({
  critChanceBase: z.number().min(0).max(100),
  critChancePerIntel: z.number().min(0),
  critMultiplier: z.number().positive(),
  minDamage: z.number().int().min(1),
});

export const ArmorConfigSchema = z.object({
  formulaAbove6: z.object({
    mult50: z.number().positive(),
    coef: z.number().positive(),
    offset: z.number(),
  }),
  formulaUpTo6: z.object({
    cap: z.number().positive(),
    mult50: z.number().positive(),
  }),
  maxAbsorb: z.number().min(0).max(100),
  // Stage 10a: linear diminishing returns above `diminishingAfter` percent.
  diminishingAfter: z.number().min(0).max(100),
  diminishingFactor: z.number().min(0).max(1),
}).refine((c) => c.diminishingAfter <= c.maxAbsorb, 'armor.diminishingAfter <= maxAbsorb');

export const PenetrationConfigSchema = z.object({
  fullDamageBelow: z.number().min(0).max(100),
  linearFrom: z.number().min(0).max(100),
  linearTo: z.number().min(0).max(100),
  ignoredAbove: z.number().min(0).max(100),
}).refine((c) => c.linearFrom < c.linearTo, 'penetration.linearFrom < linearTo');

export const DistanceConfigSchema = z.object({
  outsideRangeDivisor: z.number().positive(),
  sniper: z.object({
    pointBlank: z.number().min(0).max(1),
    plateauAt: z.number().min(0).max(1),
  }),
});

export const XpConfigSchema = z.object({
  basePerLevel: z.number().int().min(1),
  perHpBase: z.number().min(0),
  levelDiffMod: z.number().min(0),
  levelDiffClampMin: z.number().min(0),
  levelDiffClampMax: z.number().min(0),
}).refine((c) => c.levelDiffClampMin <= c.levelDiffClampMax, 'xp.levelDiffClampMin <= max');

export const HealLimitConfigSchema = z.object({
  startMult: z.number().min(0),
  regenPerRoundMult: z.number().min(0),
});

// Stage 5d: AP costs per action (data/config/battle.json → apCosts).
export const ApCostsSchema = z.object({
  moveStand: z.number().int().min(0),
  moveCrouch: z.number().int().min(0),
  moveRun: z.number().int().min(0),
  setStanceStandCrouch: z.number().int().min(0),
  setStanceCover: z.number().int().min(0),
  setStanceRunEnter: z.number().int().min(0),
  setStanceRunExit: z.number().int().min(0),
  aim: z.number().int().min(0),
  shootLight: z.number().int().min(0),
  shootMedium: z.number().int().min(0),
  shootHeavy: z.number().int().min(0),
  shootSniper: z.number().int().min(0),
  shootMelee: z.number().int().min(0),
  reloadLight: z.number().int().min(0),
  reloadMedium: z.number().int().min(0),
  reloadHeavy: z.number().int().min(0),
  reloadSniper: z.number().int().min(0),
  useItem: z.number().int().min(0),
  flee: z.number().int().min(0),
});

// Stage 5e: mob AI profiles (data/config/battle.json → ai).
export const AiProfileConfigSchema = z.object({
  approach: z.boolean(),
  stopAtRange: z.literal('weapon'),
  preferZone: z.enum(['head', 'torso', 'arms', 'legs']),
  fleeAtHpPct: z.number().min(0).max(100),
  coverAware: z.boolean(),
  fleeApThreshold: z.number().int().min(0).optional(),
});

export const AiConfigSchema = z.object({
  aggressive: AiProfileConfigSchema,
  coward: AiProfileConfigSchema,
});

// Stage 7: mob spawn / encounter tuning (data/config/battle.json → spawn).
export const SpawnConfigSchema = z.object({
  encounterChanceMultiplier: z.number().min(0),
  packMin: z.number().int().min(1),
  packMax: z.number().int().min(1),
  soloMin: z.number().int().min(1),
  soloMax: z.number().int().min(1),
  eliteChance: z.number().min(0).max(1),
  respawnMinMinutes: z.number().int().min(1),
  respawnMaxMinutes: z.number().int().min(1),
}).refine((c) => c.packMin <= c.packMax, 'spawn.packMin <= packMax')
  .refine((c) => c.soloMin <= c.soloMax, 'spawn.soloMin <= soloMax')
  .refine((c) => c.respawnMinMinutes <= c.respawnMaxMinutes, 'spawn.respawnMinMinutes <= max');

export const BattleConfigSchema = z.object({
  hit: HitConfigSchema,
  per: PerConfigSchema,
  damage: DamageConfigSchema,
  armor: ArmorConfigSchema,
  penetration: PenetrationConfigSchema,
  distance: DistanceConfigSchema,
  xp: XpConfigSchema,
  healLimit: HealLimitConfigSchema,
  apCosts: ApCostsSchema,
  ai: AiConfigSchema,
  spawn: SpawnConfigSchema,
});

export type HitConfig = z.infer<typeof HitConfigSchema>;
export type PerConfig = z.infer<typeof PerConfigSchema>;
export type DamageConfig = z.infer<typeof DamageConfigSchema>;
export type ArmorConfig = z.infer<typeof ArmorConfigSchema>;
export type PenetrationConfig = z.infer<typeof PenetrationConfigSchema>;
export type DistanceConfig = z.infer<typeof DistanceConfigSchema>;
export type XpConfig = z.infer<typeof XpConfigSchema>;
export type ApCosts = z.infer<typeof ApCostsSchema>;
export type AiProfileConfig = z.infer<typeof AiProfileConfigSchema>;
export type AiConfig = z.infer<typeof AiConfigSchema>;
export type SpawnConfig = z.infer<typeof SpawnConfigSchema>;
export type BattleConfig = z.infer<typeof BattleConfigSchema>;
