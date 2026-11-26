import { z } from 'zod';

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Ожидается hex-цвет #rrggbb');

export const I18nKey = z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, 'i18n-ключ вида section.sub.1');

export const IdSchema = z.string().regex(/^[a-z0-9_]+$/, 'id: только a-z, 0-9, _');

export const RaritySchema = z.enum(['common', 'uncommon', 'rare', 'epic']);

export const ZoneSchema = z.enum(['head', 'torso', 'arms', 'legs']);

export const StatsSchema = z.object({
  str: z.number().int().min(1).max(50),
  agi: z.number().int().min(1).max(50),
  int: z.number().int().min(1).max(50),
  end: z.number().int().min(1).max(50),
});

export const RequirementsSchema = z.object({
  level: z.number().int().min(1).optional(),
  str: z.number().int().min(1).optional(),
  agi: z.number().int().min(1).optional(),
  int: z.number().int().min(1).optional(),
  end: z.number().int().min(1).optional(),
  per: z.number().int().min(1).optional(),
  intel: z.number().int().min(1).optional(),
}).default({});

export const ZoneArmorSchema = z.object({
  head: z.number().int().min(0),
  torso: z.number().int().min(0),
  arms: z.number().int().min(0),
  legs: z.number().int().min(0),
});

export const RangeSchema = z.object({
  min: z.number().int().min(0),
  max: z.number().int().min(0),
}).refine(r => r.max >= r.min, 'max >= min');

export const LootEntrySchema = z.object({
  itemId: IdSchema,
  weight: z.number().positive(),
  qty: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
});
