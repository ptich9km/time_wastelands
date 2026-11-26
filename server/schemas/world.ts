import { z } from 'zod';
import { IdSchema, I18nKey } from './common';
import { ArtSchema } from './art';

export const LocationTypeSchema = z.enum(['city', 'waste', 'ruins', 'mine', 'road', 'camp']);
export const ConnectionTypeSchema = z.enum(['plain', 'road']);
export const AnomalyTypeSchema = z.enum(['spore_low', 'rot_low']);

export const ConnectionSchema = z.object({
  to: IdSchema,
  type: ConnectionTypeSchema.default('plain'),
});

export const SpawnEntrySchema = z.object({
  mobId: IdSchema,
  weight: z.number().positive(),
  min: z.number().int().min(0).default(0),
  max: z.number().int().min(1).default(1),
}).refine(s => s.max >= s.min, 'spawn.max >= spawn.min');

export const LocationSchema = z.object({
  id: IdSchema,
  type: LocationTypeSchema,
  nameKey: I18nKey,
  descriptionKey: I18nKey,
  ambientKeys: z.array(I18nKey).min(1).max(10),
  coords: z.object({
    x: z.number().int().min(0).max(19),
    y: z.number().int().min(0).max(19),
  }),
  dangerLevel: z.number().int().min(0).max(100),
  levelRange: z.tuple([z.number().int().min(1), z.number().int().min(1)])
    .refine(([a, b]) => b >= a, 'levelRange: [min, max], max >= min'),
  connections: z.array(ConnectionSchema).min(1),
  spawnTable: z.array(SpawnEntrySchema).default([]),
  cover: z.boolean().default(false),
  anomaly: AnomalyTypeSchema.optional(),
  art: ArtSchema,
  shopId: IdSchema.optional(),
  npcIds: z.array(IdSchema).default([]),
});

export const WorldFileSchema = z.object({
  version: z.string(),
  size: z.object({
    width: z.number().int().min(1).max(50),
    height: z.number().int().min(1).max(50),
  }),
  startLocationId: IdSchema,
  locations: z.array(LocationSchema).min(1),
}).superRefine((world, ctx) => {
  const ids = new Set<string>();
  const coords = new Map<string, string>();
  for (const [i, loc] of world.locations.entries()) {
    if (ids.has(loc.id)) {
      ctx.addIssue({ code: 'custom', message: `Дубликат location.id: ${loc.id}`, path: ['locations', i, 'id'] });
    }
    ids.add(loc.id);
    if (loc.coords.x >= world.size.width || loc.coords.y >= world.size.height) {
      ctx.addIssue({ code: 'custom', message: `Координаты вне карты: ${loc.id}`, path: ['locations', i, 'coords'] });
    }
    const key = `${loc.coords.x},${loc.coords.y}`;
    if (coords.has(key)) {
      ctx.addIssue({ code: 'custom', message: `Координаты заняты: ${coords.get(key)} и ${loc.id}`, path: ['locations', i, 'coords'] });
    }
    coords.set(key, loc.id);
  }

  // связи: двусторонние и существующие
  for (const [i, loc] of world.locations.entries()) {
    for (const [j, conn] of loc.connections.entries()) {
      const target = world.locations.find(l => l.id === conn.to);
      if (!target) {
        ctx.addIssue({ code: 'custom', message: `Связь в несуществующую локацию: ${loc.id} → ${conn.to}`, path: ['locations', i, 'connections', j] });
        continue;
      }
      const back = target.connections.some(c => c.to === loc.id);
      if (!back) {
        ctx.addIssue({ code: 'custom', message: `Асимметричная связь: ${loc.id} → ${target.id}`, path: ['locations', i, 'connections', j] });
      }
      const dx = Math.abs(loc.coords.x - target.coords.x);
      const dy = Math.abs(loc.coords.y - target.coords.y);
      if (dx > 1 || dy > 1) {
        ctx.addIssue({ code: 'custom', message: `Связь не по соседству: ${loc.id} → ${target.id}`, path: ['locations', i, 'connections', j] });
      }
    }
  }

  if (!ids.has(world.startLocationId)) {
    ctx.addIssue({ code: 'custom', message: `startLocationId не найден: ${world.startLocationId}`, path: ['startLocationId'] });
  }
});

export type Location = z.infer<typeof LocationSchema>;
export type WorldFile = z.infer<typeof WorldFileSchema>;
