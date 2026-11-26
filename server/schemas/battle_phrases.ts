import { z } from 'zod';

export const PhraseCategorySchema = z.object({
  minVariants: z.number().int().min(1).max(20).default(1),
  placeholders: z.array(z.string().regex(/^[a-z_]+$/)).default([]),
});

export const BattlePhrasesFileSchema = z.object({
  version: z.string(),
  categories: z.record(
    z.string().regex(/^battle\.[a-z0-9_.]+$/),
    PhraseCategorySchema,
  ).refine(r => Object.keys(r).length > 0, 'Нужна хотя бы одна категория фраз'),
});

export type BattlePhrasesFile = z.infer<typeof BattlePhrasesFileSchema>;
