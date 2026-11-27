// Stage 5d: battle action types — Zod schemas are the source of truth.

import { z } from 'zod';
import { HexCoordSchema, PositionSchema, type BattleLogEntry, type BattleState } from './state';

export const ZoneSchema = z.enum(['head', 'torso', 'arms', 'legs']);
export type Zone = z.infer<typeof ZoneSchema>;

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), to: HexCoordSchema }),
  z.object({ type: z.literal('shoot'), targetId: z.string().min(1), zone: ZoneSchema }),
  z.object({ type: z.literal('setStance'), stance: PositionSchema }),
  z.object({ type: z.literal('reload') }),
  z.object({
    type: z.literal('useItem'),
    itemId: z.string().min(1),
    inventoryId: z.number().int().positive(),
  }),
  z.object({ type: z.literal('flee') }),
  z.object({ type: z.literal('endTurn') }),
  z.object({ type: z.literal('aim') }),
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action['type'];

export type ActionError =
  | 'not_your_turn'
  | 'battle_finished'
  | 'not_enough_ap'
  | 'invalid_target'
  | 'out_of_range'
  | 'no_line_of_sight'
  | 'melee_blocked'
  | 'no_weapon'
  | 'no_ammo'
  | 'occupied'
  | 'out_of_bounds'
  | 'blocked'
  | 'not_adjacent'
  | 'cannot_flee'
  | 'invalid_stance'
  | 'not_equipped'
  | 'unknown_item'
  | 'requirements_not_met'
  | 'cover_not_available'
  | 'run_not_available'
  | 'invalid_action';

export type ActionResult =
  | {
      ok: true;
      newState: BattleState;
      logEntries: BattleLogEntry[];
      // Stage 9: set when the PLAYER lands a hit/crit — the service layer
      // increments the weapon skill (the engine itself never touches the DB).
      weaponCategoryHit?: string;
    }
  | {
      ok: false;
      error: ActionError;
      message?: string;
    };
