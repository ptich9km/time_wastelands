// Stage 5a: BattleState types — Zod schemas are the source of truth.
// Formulas, actions, hex map rendering, UI — steps 5b–5e and 6.

import { z } from 'zod';

export const HexCoordSchema = z.object({
  q: z.number().int().min(-50).max(50),
  r: z.number().int().min(-50).max(50),
});
export type HexCoord = z.infer<typeof HexCoordSchema>;

export const PositionSchema = z.enum(['stand', 'crouch', 'run', 'cover']);
export type Position = z.infer<typeof PositionSchema>;

export const ParticipantKindSchema = z.enum(['player', 'mob']);
export type ParticipantKind = z.infer<typeof ParticipantKindSchema>;

// All stats >= 0: the player may have per/intel = 0 (mobs are validated >= 1 in mobs.json).
export const Stats6Schema = z.object({
  str: z.number().int().min(0),
  agi: z.number().int().min(0),
  int: z.number().int().min(0),
  end: z.number().int().min(0),
  per: z.number().int().min(0),
  intel: z.number().int().min(0),
});
export type Stats6 = z.infer<typeof Stats6Schema>;

// "arms" slot is not used by items.json yet — kept for compatibility.
export const EquipmentSchema = z.object({
  weaponId: z.string().nullable(),
  armor: z.object({
    head: z.string().nullable(),
    torso: z.string().nullable(),
    arms: z.string().nullable(),
    legs: z.string().nullable(),
  }),
});
export type Equipment = z.infer<typeof EquipmentSchema>;

export const EffectSchema = z.object({
  id: z.string(),
  kind: z.enum(['poison', 'bleed', 'stun', 'buff', 'debuff']),
  ttlRounds: z.number().int().min(0),
  payload: z.record(z.string(), z.unknown()).optional(), // v0.2
});
export type Effect = z.infer<typeof EffectSchema>;

export const ParticipantSchema = z.object({
  id: z.string(), // unique within the battle: "player" | "mob_1" | "mob_2"
  kind: ParticipantKindSchema,
  refId: z.string(), // characterId ("1") for the player, mobId for a mob
  stats: Stats6Schema,
  hp: z.number().int().min(0),
  hpMax: z.number().int().min(1),
  ap: z.number().int().min(0),
  apMax: z.number().int().min(0),
  hex: HexCoordSchema,
  position: PositionSchema,
  facing: z.number().int().min(0).max(5), // v0.2
  equipment: EquipmentSchema,
  effects: z.array(EffectSchema),
  // Stage 5d: rounds left in the weapon magazine. Kept in the battle state so
  // the DB is not touched mid-fight; synced back to inventory at stage 6.
  weaponCharges: z.number().int().min(0).optional(),
  mobLevel: z.number().int().min(1).optional(),
  mobNameKey: z.string().optional(),
  characterName: z.string().optional(),
  // Stage 7: elite mobs get boosted HP/damage at battle creation.
  isElite: z.boolean().optional(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const ObstacleSchema = z.object({
  hex: HexCoordSchema,
  type: z.enum(['wall', 'rock', 'tree', 'crate']),
  blocksLos: z.boolean(),
  blocksMove: z.boolean(),
});
export type Obstacle = z.infer<typeof ObstacleSchema>;

export const BattleMapSchema = z.object({
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  obstacles: z.array(ObstacleSchema),
});
export type BattleMap = z.infer<typeof BattleMapSchema>;

export const BattleLogTypeSchema = z.enum([
  'hit', 'miss', 'crit', 'info', 'system', 'flee', 'death', 'heal',
]);
export type BattleLogType = z.infer<typeof BattleLogTypeSchema>;

// The log text is already translated — written in the client's language at the
// moment of the event so a reconnect does not require re-rendering (by design).
export const BattleLogEntrySchema = z.object({
  round: z.number().int().min(1),
  actor: z.string(), // "player" | "mob_1" | "system"
  type: BattleLogTypeSchema,
  text: z.string().min(1),
  createdAt: z.string(),
});
export type BattleLogEntry = z.infer<typeof BattleLogEntrySchema>;

export const BattleContextSchema = z.object({
  locationId: z.string(),
  isAmbush: z.boolean(),
  cover: z.boolean(),
  timeOfDay: z.enum(['day', 'night']), // 'day' for now, v0.2
});
export type BattleContext = z.infer<typeof BattleContextSchema>;

export const BattleStatusSchema = z.enum(['active', 'victory', 'defeat', 'fled']);
export type BattleStatus = z.infer<typeof BattleStatusSchema>;

export const HealLimitSchema = z.object({
  current: z.number().int().min(0),
  max: z.number().int().min(0),
  regenPerRound: z.number().int().min(0),
});
export type HealLimit = z.infer<typeof HealLimitSchema>;

export const BattleStateSchema = z.object({
  id: z.string().uuid(),
  round: z.number().int().min(1),
  status: BattleStatusSchema,
  phase: z.enum(['player_turn', 'enemy_turn', 'finished']),
  map: BattleMapSchema,
  participants: z.array(ParticipantSchema).min(2),
  turnOrder: z.array(z.string()),
  currentActorId: z.string(),
  log: z.array(BattleLogEntrySchema), // append-only; stored in a separate table
  context: BattleContextSchema,
  healLimit: HealLimitSchema,
  result: z.enum(['victory', 'defeat', 'fled']).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BattleState = z.infer<typeof BattleStateSchema>;
