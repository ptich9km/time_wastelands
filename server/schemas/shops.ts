// Stage 8: shop definitions (data/shops.json).

import { z } from 'zod';
import { IdSchema, I18nKey } from './common';

export const ShopStockEntrySchema = z.object({
  itemId: IdSchema,
  baseQty: z.number().int().min(0),
});

export const ShopSchema = z.object({
  id: IdSchema,
  nameKey: I18nKey,
  locationId: IdSchema,
  multiplier: z.number().positive(),
  stock: z.array(ShopStockEntrySchema).min(1),
});

export const ShopsFileSchema = z
  .object({
    version: z.string(),
    shops: z.array(ShopSchema).min(1),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    for (const [i, shop] of data.shops.entries()) {
      if (seen.has(shop.id)) {
        ctx.addIssue({ code: 'custom', message: `Дубликат shop.id: ${shop.id}`, path: ['shops', i, 'id'] });
      }
      seen.add(shop.id);
    }
  });

export type Shop = z.infer<typeof ShopSchema>;
export type ShopsFile = z.infer<typeof ShopsFileSchema>;
