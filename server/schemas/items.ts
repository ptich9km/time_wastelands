import { z } from 'zod';
import {
  IdSchema, I18nKey, RaritySchema, RequirementsSchema,
  ZoneArmorSchema, RangeSchema,
} from './common';

// v2.0: five weapon categories in MVP (no thrown/energy/bio).
export const WeaponCategorySchema = z.enum(['light', 'medium', 'heavy', 'sniper', 'melee']);
export const AmmoTypeSchema = z.enum(['light', 'medium', 'heavy']);
export const ArmorSlotSchema = z.enum(['head', 'torso', 'jacket', 'legs', 'boots']);
export const EffectKindSchema = z.enum(['poison', 'bleed', 'stun']);

const BaseItem = z.object({
  id: IdSchema,
  nameKey: I18nKey,
  descriptionKey: I18nKey,
  icon: z.string().min(1).max(4),      // emoji
  iconImage: z.string().min(1).optional(),
  price: z.number().int().min(1),
  weight: z.number().min(0),
  rarity: RaritySchema.default('common'),
  requirements: RequirementsSchema,
  durability: z.number().int().min(1).default(100),
  tags: z.array(z.string()).default([]),
});

// sniper === true if and only if weaponCategory === 'sniper'.
function checkSniperConsistency(
  w: { weaponCategory: string; sniper: boolean },
  ctx: z.RefinementCtx,
): void {
  if (w.sniper && w.weaponCategory !== 'sniper') {
    ctx.addIssue({ code: 'custom', message: 'sniper: true допустим только для weaponCategory "sniper"', path: ['sniper'] });
  }
  if (w.weaponCategory === 'sniper' && !w.sniper) {
    ctx.addIssue({ code: 'custom', message: 'weaponCategory "sniper" требует sniper: true', path: ['sniper'] });
  }
}

export const WeaponItemSchema = BaseItem.extend({
  type: z.literal('weapon'),
  slot: z.literal('weapon'),
  weaponCategory: WeaponCategorySchema,
  level: z.number().int().min(1),                 // weapon level for the armor formula
  damage: RangeSchema,
  range: z.number().int().min(1),                 // hexes
  spread: z.number().int().min(0).max(100),       // hit % at max range
  sniper: z.boolean().default(false),             // special sniper hit model
  apCost: z.number().int().min(1),                // AP per shot
  reloadAp: z.number().int().min(1),              // AP per reload
  pen: z.number().int().min(0).max(100),          // armor penetration %
  charges: z.number().int().min(1).optional(),    // magazine size (firearms)
  ammoType: AmmoTypeSchema.optional(),
})
  .refine(w => !w.charges || !!w.ammoType, 'Если есть charges, нужен ammoType')
  .superRefine(checkSniperConsistency);

export const ArmorItemSchema = BaseItem.extend({
  type: z.literal('armor'),
  slot: ArmorSlotSchema,
  level: z.number().int().min(1),                 // armor level for the absorption formula
  armor: ZoneArmorSchema,
});

export const ConsumableItemSchema = BaseItem.extend({
  type: z.literal('consumable'),
  effect: z.object({
    heal: z.number().int().min(0).default(0),
    cure: EffectKindSchema.optional(),
    restoreCharges: z.number().int().min(0).optional(),
    durationRounds: z.number().int().min(1).optional(),
  }),
});

export const AmmoItemSchema = BaseItem.extend({
  type: z.literal('ammo'),
  ammoType: AmmoTypeSchema,
  charges: z.number().int().min(1),
  damageBonus: z.number().int().min(0).default(0), // added to weapon damage
});

export const MiscItemSchema = BaseItem.extend({
  type: z.literal('misc'),
});

export const ItemSchema = z.discriminatedUnion('type', [
  WeaponItemSchema, ArmorItemSchema, ConsumableItemSchema, AmmoItemSchema, MiscItemSchema,
]);

export const ItemsFileSchema = z.object({
  version: z.string(),
  items: z.array(ItemSchema).min(1),
}).superRefine((data, ctx) => {
  const seen = new Set<string>();
  for (const [i, item] of data.items.entries()) {
    if (seen.has(item.id)) {
      ctx.addIssue({ code: 'custom', message: `Дубликат id: ${item.id}`, path: ['items', i, 'id'] });
    }
    seen.add(item.id);
    if (item.type === 'weapon') {
      if (item.ammoType) {
        const hasAmmo = data.items.some(it => it.type === 'ammo' && it.ammoType === item.ammoType);
        if (!hasAmmo) {
          ctx.addIssue({ code: 'custom', message: `Нет патронов типа ${item.ammoType} для ${item.id}`, path: ['items', i] });
        }
      }
      // weapon.level/range/apCost >= 1 and the sniper/category pairing are
      // already enforced by WeaponItemSchema field constraints.
    }
    if (item.type === 'armor' && item.level < 1) {
      ctx.addIssue({ code: 'custom', message: `armor.level >= 1: ${item.id}`, path: ['items', i, 'level'] });
    }
  }
});

export type Item = z.infer<typeof ItemSchema>;
export type ItemsFile = z.infer<typeof ItemsFileSchema>;
