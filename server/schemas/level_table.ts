// Stage 5b: level table (data/level_table.json).
// hpMax/apMax must match the character formulas: hpMax = 50 + 5×end, apMax = 15 + 2×end.

import { z } from 'zod';

export const LevelRowSchema = z.object({
  level: z.number().int().min(1),
  str: z.number().int().min(0),
  agi: z.number().int().min(0),
  int: z.number().int().min(0),
  end: z.number().int().min(0),
  per: z.number().int().min(0),
  intel: z.number().int().min(0),
  // Stage 9: cumulative perk points at this level (level 2 → 1, level 10 → 9).
  perkPoints: z.number().int().min(0),
  apMax: z.number().int().min(0),
  hpMax: z.number().int().min(1),
});

export const LevelTableSchema = z.object({
  version: z.string(),
  levels: z.array(LevelRowSchema).min(1),
}).superRefine((table, ctx) => {
  const seen = new Set<number>();
  for (const [i, row] of table.levels.entries()) {
    if (seen.has(row.level)) {
      ctx.addIssue({ code: 'custom', message: `Дубликат level: ${row.level}`, path: ['levels', i, 'level'] });
    }
    seen.add(row.level);
    if (row.hpMax !== 50 + 5 * row.end) {
      ctx.addIssue({
        code: 'custom',
        message: `level ${row.level}: hpMax ${row.hpMax} != 50 + 5×end (${50 + 5 * row.end})`,
        path: ['levels', i, 'hpMax'],
      });
    }
    if (row.apMax !== 15 + 2 * row.end) {
      ctx.addIssue({
        code: 'custom',
        message: `level ${row.level}: apMax ${row.apMax} != 15 + 2×end (${15 + 2 * row.end})`,
        path: ['levels', i, 'apMax'],
      });
    }
  }
});

export type LevelRow = z.infer<typeof LevelRowSchema>;
export type LevelTable = z.infer<typeof LevelTableSchema>;
