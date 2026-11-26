// Stage 8: named NPC definitions (data/npcs.json).

import { z } from 'zod';
import { IdSchema, I18nKey } from './common';

export const NpcSchema = z.object({
  id: IdSchema,
  nameKey: I18nKey,
  locationId: IdSchema,
  role: z.string().min(1), // UI icon hint (blacksmith / medic / miner)
  dialogueKeys: z.array(I18nKey).min(1),
  rumorKeys: z.array(I18nKey).default([]),
});

export const NpcsFileSchema = z
  .object({
    version: z.string(),
    npcs: z.array(NpcSchema).min(1),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    for (const [i, npc] of data.npcs.entries()) {
      if (seen.has(npc.id)) {
        ctx.addIssue({ code: 'custom', message: `Дубликат npc.id: ${npc.id}`, path: ['npcs', i, 'id'] });
      }
      seen.add(npc.id);
    }
  });

export type Npc = z.infer<typeof NpcSchema>;
export type NpcsFile = z.infer<typeof NpcsFileSchema>;
