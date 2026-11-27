import { z } from 'zod';
import { IdSchema, I18nKey, LootEntrySchema } from './common';

// v2.0 MVP: only these two AI profiles (tactical/berserk are postponed to v0.2).
export const AIProfileSchema = z.enum(['aggressive', 'coward']);

// Mob stats: every stat is at least 1 — a mob cannot be without
// marksmanship (per) or intellect (intel).
export const MobStatsSchema = z.object({
  str: z.number().int().min(1).max(50),
  agi: z.number().int().min(1).max(50),
  int: z.number().int().min(1).max(50),
  end: z.number().int().min(1).max(50),
  per: z.number().int().min(1).max(50),
  intel: z.number().int().min(1).max(50),
});

export const MobAttackSchema = z.object({
  min: z.number().int().min(0),
  max: z.number().int().min(0),
  pen: z.number().int().min(0).max(100),  // armor penetration %
  range: z.number().int().min(1),         // hexes; 1 = melee
}).refine(a => a.max >= a.min, 'attack.max >= attack.min');

export const MobLootSchema = z.object({
  guaranteed: LootEntrySchema.optional(),
  rare: z.array(LootEntrySchema).default([]),
});

export const EliteConfigSchema = z.object({
  hpMult: z.number().positive().default(1.5),
  dmgMult: z.number().positive().default(1.3),
  xpMult: z.number().positive().default(2),
  rareChanceBonus: z.number().min(0).max(1).default(0.15),
});

export const MobSchema = z.object({
  id: IdSchema,
  nameKey: I18nKey,
  descriptionKey: I18nKey.optional(),
  iconImage: z.string().min(1).optional(),
  level: z.number().int().min(1).max(50),
  hp: z.number().int().min(1),
  stats: MobStatsSchema,
  attack: MobAttackSchema,
  ai: AIProfileSchema,
  moveAp: z.number().int().min(1).default(4),
  attackAp: z.number().int().min(1).default(8),
  // Kept for compatibility; in v2.0 XP is computed from mob HP.
  xp: z.number().int().min(0).default(0),
  loot: MobLootSchema,
  spawnLevelRange: z.tuple([z.number().int().min(1), z.number().int().min(1)])
    .refine(([a, b]) => b >= a, 'spawnLevelRange: [min, max], max >= min'),
  elite: EliteConfigSchema.optional(),
  tags: z.array(z.string()).default([]),
});

export const MobsFileSchema = z.object({
  version: z.string(),
  mobs: z.array(MobSchema).min(1),
}).superRefine((data, ctx) => {
  const seen = new Set<string>();
  for (const [i, mob] of data.mobs.entries()) {
    if (seen.has(mob.id)) {
      ctx.addIssue({ code: 'custom', message: `Дубликат mob.id: ${mob.id}`, path: ['mobs', i, 'id'] });
    }
    seen.add(mob.id);
    // elite multiplier bounds and attack.range >= 1 are enforced by the
    // field-level schemas above.
  }
});

export type Mob = z.infer<typeof MobSchema>;
export type MobsFile = z.infer<typeof MobsFileSchema>;
