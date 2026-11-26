import { z } from 'zod';
import { HexColor } from './common';

export const SilhouetteTypeSchema = z.enum([
  'ruin', 'pipe', 'tree', 'tower', 'rubble', 'cave',
  'cover_box', 'fence', 'factory', 'rock', 'mushroom', 'anomaly_glow',
]);

export const SilhouetteSchema = z.object({
  type: SilhouetteTypeSchema,
  x: z.number().min(0).max(1),      // доля ширины
  y: z.number().min(0).max(1),      // доля высоты (0 = верх, 1 = низ)
  scale: z.number().min(0.1).max(3),
  color: HexColor,
  flip: z.boolean().optional(),
});

export const WeatherSchema = z.enum(['clear', 'fog', 'rain', 'spore_mist']);

export const ArtSchema = z.object({
  sky: z.tuple([HexColor, HexColor]),   // [верх, низ]
  ground: HexColor,
  silhouettes: z.array(SilhouetteSchema).max(8).default([]),
  weather: WeatherSchema.optional(),
  fog: z.boolean().optional(),
});

export type Art = z.infer<typeof ArtSchema>;
export type Silhouette = z.infer<typeof SilhouetteSchema>;
