// Stage 6a: shared battle flow used by both REST and WebSocket. Keeping the
// action and sync sequence here prevents the two transports from diverging.

import type Database from 'better-sqlite3';
import type { GameData } from '../../schemas/loader';
import type { Action, ActionError } from './actions';
import type { BattleLogEntry, BattleState } from './state';
import type { Lang } from '../../i18n';
import { t } from '../../i18n';
import { applyAction, runEnemyTurn } from './engine';
import { getInventory, removeItem } from '../../db/inventory-repo';
import { getBattle, getSyncStatus, updateBattleState } from '../../db/battle-repo';
import { markRespawn } from '../../db/world-repo';
import { applyElite, randInt } from '../world/spawn';
import { getSkillBonus, getWeaponSkill, incrementWeaponSkill } from '../entities/weapon-skill';
import type { WeaponCategory } from '../entities/weapon-skill';
import type { Item } from '../../schemas/items';
type WeaponItem = Extract<Item, { type: 'weapon' }>;
import type { Mob } from '../../schemas/mobs';
import { syncAfterBattle, type BattleRewards } from './sync';

// Elite participants keep their boosted attack out of the engine's reach
// (it looks mobs up by refId), so the engine gets elite-adjusted definitions.
// The engine itself stays untouched.
function mobsForEngine(state: BattleState, mobs: Mob[]): Mob[] {
  return mobs.map((mob) =>
    state.participants.some((p) => p.kind === 'mob' && p.refId === mob.id && p.isElite === true)
      ? applyElite(mob, true)
      : mob,
  );
}

export type ProcessActionResult =
  | {
      ok: true;
      state: BattleState;
      logEntries: BattleLogEntry[];
      rewards?: BattleRewards;
    }
  | { ok: false; error: ActionError; message?: string };

export interface ProcessActionParams {
  db: Database.Database;
  gameData: GameData;
  state: BattleState;
  action: Action;
  lang: Lang;
  rng?: () => number;
}

export function processBattleAction(params: ProcessActionParams): ProcessActionResult {
  const { db, gameData, state, action, lang } = params;
  const rng = params.rng ?? Math.random;
  if (state.status !== 'active') return { ok: false, error: 'battle_finished' };
  if (state.phase === 'enemy_turn' || state.currentActorId !== 'player') {
    return { ok: false, error: 'not_your_turn' };
  }
  if (action.type === 'useItem') {
    const row = getInventory(db).find((r) => r.id === action.inventoryId);
    if (!row || row.itemId !== action.itemId || row.qty < 1) {
      return { ok: false, error: 'unknown_item' };
    }
  }

  const engineMobs = mobsForEngine(state, gameData.mobs.mobs);
  // Stage 9: the player's weapon skill adds 0..10 accuracy (engine stays pure).
  const playerWeaponId = state.participants.find((p) => p.kind === 'player')?.equipment.weaponId;
  const playerWeapon = playerWeaponId
    ? (gameData.items.items.find((i) => i.id === playerWeaponId && i.type === 'weapon') as
        | WeaponItem
        | undefined)
    : undefined;
  const weaponSkillBonus = playerWeapon
    ? getSkillBonus(getWeaponSkill(db, playerWeapon.weaponCategory))
    : 0;
  const result = applyAction({
    state,
    action,
    config: gameData.battleConfig,
    items: gameData.items.items,
    mobs: engineMobs,
    rng,
    lang,
    weaponSkillBonus,
  });
  if (!result.ok) return result;

  // Stage 9: a successful player shot grows the weapon skill (+1 per 10 hits).
  if (result.weaponCategoryHit) {
    incrementWeaponSkill(db, result.weaponCategoryHit as WeaponCategory, 1);
  }

  let finalState = result.newState;
  const logEntries = [...result.logEntries];
  if (action.type === 'endTurn' && finalState.status === 'active') {
    const enemyTurn = runEnemyTurn({
      state: finalState,
      config: gameData.battleConfig,
      items: gameData.items.items,
      mobs: engineMobs,
      rng,
      lang,
    });
    finalState = enemyTurn.newState;
    logEntries.push(...enemyTurn.logEntries);
  }

  let rewards: BattleRewards | undefined;
  if (finalState.status !== 'active') {
    const sync = syncAfterBattle({
      db,
      state: finalState,
      items: gameData.items.items,
      mobs: gameData.mobs.mobs,
      config: gameData.battleConfig,
      levelTable: gameData.levelTable,
      world: gameData.world,
      lang,
      rng,
    });
    rewards = sync.rewards;
    finalState = { ...finalState, log: [...finalState.log, ...sync.logEntries] };
    logEntries.push(...sync.logEntries);
    // Stage 7: the battle location respawns its mobs after the fight.
    const spawnCfg = gameData.battleConfig.spawn;
    markRespawn(
      db,
      finalState.context.locationId,
      randInt(spawnCfg.respawnMinMinutes, spawnCfg.respawnMaxMinutes, rng),
    );
  }

  updateBattleState(db, finalState);
  if (action.type === 'useItem') removeItem(db, action.inventoryId, 1);
  return { ok: true, state: finalState, logEntries, rewards };
}

export interface AbandonBattleParams {
  db: Database.Database;
  gameData: GameData;
  state: BattleState;
  lang: Lang;
  rng?: () => number;
}

export function abandonBattle(params: AbandonBattleParams): {
  state: BattleState;
  rewards: BattleRewards;
} {
  const { db, gameData, lang } = params;
  const now = new Date().toISOString();
  const base: BattleState = {
    ...params.state,
    status: 'fled',
    result: 'fled',
    phase: 'finished',
    log: [
      ...params.state.log,
      {
        round: params.state.round,
        actor: 'system',
        type: 'flee',
        text: t('battle.log.abandoned', lang, {}),
        createdAt: now,
      },
    ],
    updatedAt: now,
  };
  const sync = syncAfterBattle({
    db,
    state: base,
    items: gameData.items.items,
    mobs: gameData.mobs.mobs,
    config: gameData.battleConfig,
    levelTable: gameData.levelTable,
    world: gameData.world,
    lang,
    rng: params.rng ?? Math.random,
  });
  const state = { ...base, log: [...base.log, ...sync.logEntries] };
  const spawnCfg = gameData.battleConfig.spawn;
  markRespawn(
    db,
    state.context.locationId,
    randInt(spawnCfg.respawnMinMinutes, spawnCfg.respawnMaxMinutes, params.rng ?? Math.random),
  );
  updateBattleState(db, state);
  return { state, rewards: sync.rewards };
}

export function getBattleRewards(db: Database.Database, id: string): BattleRewards {
  const status = getSyncStatus(db, id);
  return status?.rewards ?? { xp: 0, loot: [], levelUp: false };
}

export function battleExists(db: Database.Database, id: string): boolean {
  return getBattle(db, id) !== null;
}
