// Stage 5d: battle action engine — pure, immutable, RNG is injected.
// No mob AI (5e), no WebSocket / full UI (6), no post-battle inventory sync (6).

import {
  applyCrit,
  armorAbsorb,
  damageWithPenetration,
  hitChance,
  rollCrit,
  rollDamage,
  rollPenetration,
  xpForKill,
} from './formulas';
import { canMoveTo, hasLineOfSight, reachableHexes } from './los';
import { decideMobAction, mobAttackAp, mobMoveAp } from './ai';
import { hexDistance, hexKey, type HexCoord } from './hex';
import type {
  BattleLogEntry,
  BattleLogType,
  BattleState,
  Effect,
  Participant,
} from './state';
import type { Action, ActionResult, ActionError, Zone } from './actions';
import type { ApCosts, BattleConfig } from '../../schemas/battle_config';
import type { Item } from '../../schemas/items';
import type { Mob } from '../../schemas/mobs';
import { t, type Lang } from '../../i18n';

const PLAYER_ID = 'player';
const AIM_BONUS = 15;

function nowIso(): string {
  return new Date().toISOString();
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

type WeaponItem = Extract<Item, { type: 'weapon' }>;

const SHOOT_COST_KEY: Record<WeaponItem['weaponCategory'], keyof ApCosts> = {
  light: 'shootLight',
  medium: 'shootMedium',
  heavy: 'shootHeavy',
  sniper: 'shootSniper',
  melee: 'shootMelee',
};

function reloadCostKey(category: WeaponItem['weaponCategory']): keyof ApCosts {
  switch (category) {
    case 'medium':
      return 'reloadMedium';
    case 'heavy':
      return 'reloadHeavy';
    case 'sniper':
      return 'reloadSniper';
    case 'light':
    case 'melee':
      return 'reloadLight';
  }
}

function findWeapon(items: Item[], weaponId: string | null): WeaponItem | null {
  if (!weaponId) return null;
  const item = items.find((i) => i.id === weaponId);
  return item && item.type === 'weapon' ? item : null;
}

function aliveMobs(state: BattleState): Participant[] {
  return state.participants.filter((p) => p.kind === 'mob' && p.hp > 0);
}

/** Sum of `payload.hitBonus` of all active aim effects. */
export function aimBonusFor(effects: Effect[]): number {
  return effects
    .filter((e) => e.id === 'aim')
    .reduce((sum, e) => {
      const bonus = e.payload?.hitBonus;
      return sum + (typeof bonus === 'number' ? bonus : 0);
    }, 0);
}

/**
 * Hit chance for a shot including active aim buffs (clamped 0..100).
 * Exported so tests verify the +15% aim bonus without rolling RNG.
 */
export function shootChance(params: {
  player: Participant;
  target: Participant;
  weapon: WeaponItem;
  zone: Zone;
  distanceHexes: number;
  config: BattleConfig;
  // Stage 9: accuracy bonus from the player's weapon skill (0..10).
  weaponSkillBonus?: number;
}): number {
  const { player, target, weapon, zone, distanceHexes, config } = params;
  const base = hitChance({
    perAttacker: player.stats.per,
    agiTarget: target.stats.agi,
    zone,
    distanceHexes,
    weapon: { range: weapon.range, spread: weapon.spread, sniper: weapon.sniper },
    positionAttacker: player.position,
    positionTarget: target.position,
    coverTarget: target.position === 'cover',
    config: config.hit,
    perConfig: config.per,
    sniperConfig: config.distance.sniper,
    weaponSkillBonus: params.weaponSkillBonus,
  });
  return clamp(base.chance + aimBonusFor(player.effects), 0, 100);
}

// Cover needs an adjacent obstacle (wall/rock/tree/crate).
function hasAdjacentCover(state: BattleState, hex: HexCoord): boolean {
  return state.map.obstacles.some(
    (o) => (o.blocksLos || o.blocksMove) && hexDistance(o.hex, hex) === 1,
  );
}

// Stage 5e: endTurn only hands control to the mobs; the round bookkeeping
// (AP, heal limit, effect ticks) moved to runEnemyTurn.
function checkBattleEnd(
  state: BattleState,
  push: (type: BattleLogType, text: string, actor?: string) => void,
  lang: Lang,
): void {
  if (state.status !== 'active') return;
  const player = state.participants.find((p) => p.kind === 'player');
  if (!player || player.hp <= 0) {
    state.status = 'defeat';
    state.result = 'defeat';
    state.phase = 'finished';
    push('system', t('battle.log.defeat', lang), 'system');
    return;
  }
  if (aliveMobs(state).length === 0) {
    state.status = 'victory';
    state.result = 'victory';
    state.phase = 'finished';
    push('system', t('battle.log.victory', lang), 'system');
  }
}

export function applyAction(params: {
  state: BattleState;
  action: Action;
  config: BattleConfig;
  items: Item[];
  mobs: Mob[];
  rng: () => number;
  lang: Lang;
  // Stage 9: accuracy bonus from the player's weapon skill (0..10).
  weaponSkillBonus?: number;
}): ActionResult {
  const { state, action, config, items, rng, lang } = params;

  if (state.status !== 'active') return { ok: false, error: 'battle_finished' };
  if (state.phase === 'enemy_turn') return { ok: false, error: 'not_your_turn' };
  if (state.currentActorId !== PLAYER_ID) return { ok: false, error: 'not_your_turn' };

  const next = structuredClone(state);
  const player = next.participants.find((p) => p.kind === 'player');
  if (!player) return { ok: false, error: 'invalid_target' };

  const entries: BattleLogEntry[] = [];
  // Stage 9: set on a successful player shot, consumed by the service layer.
  let weaponCategoryHit: string | undefined;
  const push = (type: BattleLogType, text: string, actor = PLAYER_ID): void => {
    const entry: BattleLogEntry = { round: next.round, actor, type, text, createdAt: nowIso() };
    entries.push(entry);
    next.log.push(entry);
  };

  switch (action.type) {
    case 'move': {
      const check = canMoveTo({
        from: player.hex,
        to: action.to,
        obstacles: next.map.obstacles,
        occupiedHexes: next.participants
          .filter((p) => p.id !== player.id && p.hp > 0)
          .map((p) => p.hex),
        mapWidth: next.map.width,
        mapHeight: next.map.height,
      });
      if (!check.ok) return { ok: false, error: check.reason };
      const cost =
        player.position === 'run'
          ? config.apCosts.moveRun
          : player.position === 'crouch'
            ? config.apCosts.moveCrouch
            : config.apCosts.moveStand;
      if (player.ap < cost) return { ok: false, error: 'not_enough_ap' };
      player.ap -= cost;
      player.hex = { ...action.to };
      push('info', t('battle.log.move', lang, { q: action.to.q, r: action.to.r }));
      break;
    }

    case 'shoot': {
      const target = next.participants.find((p) => p.id === action.targetId);
      if (!target || target.kind !== 'mob' || target.hp <= 0) {
        return { ok: false, error: 'invalid_target' };
      }
      const weapon = findWeapon(items, player.equipment.weaponId);
      if (!player.equipment.weaponId) return { ok: false, error: 'no_weapon' };
      if (!weapon) return { ok: false, error: 'unknown_item' };

      const charges = player.weaponCharges ?? weapon.charges;
      if (weapon.charges !== undefined && (charges ?? 0) <= 0) {
        return { ok: false, error: 'no_ammo' };
      }
      const distance = hexDistance(player.hex, target.hex);
      if (distance > weapon.range) return { ok: false, error: 'out_of_range' };
      const los = hasLineOfSight({
        from: player.hex,
        to: target.hex,
        obstacles: next.map.obstacles,
        mapWidth: next.map.width,
        mapHeight: next.map.height,
      });
      if (!los) return { ok: false, error: 'no_line_of_sight' };

      const cost = config.apCosts[SHOOT_COST_KEY[weapon.weaponCategory]];
      if (player.ap < cost) return { ok: false, error: 'not_enough_ap' };

      const chance = shootChance({
        player,
        target,
        weapon,
        zone: action.zone,
        distanceHexes: distance,
        config,
        weaponSkillBonus: params.weaponSkillBonus,
      });

      player.ap -= cost;
      if (weapon.charges !== undefined) {
        player.weaponCharges = (charges ?? weapon.charges) - 1;
      }
      // Aim is consumed by the shot it applies to.
      player.effects = player.effects.filter((e) => e.id !== 'aim');

      const targetName = t(target.mobNameKey ?? '', lang);
      const zoneName = t(`ui.battle.zone.${action.zone}`, lang);

      if (rng() * 100 >= chance) {
        push('miss', t('battle.log.shoot_miss', lang, { target: targetName }));
      } else {
        weaponCategoryHit = weapon.weaponCategory;
        let damage = rollDamage({ weaponDamage: weapon.damage, ammoBonus: 0, rng });
        const crit = rollCrit({ intel: player.stats.intel, config: config.damage, rng });
        if (crit) damage = applyCrit(damage, config.damage);

        const armorId = target.equipment.armor[action.zone];
        const armorItem = armorId ? items.find((i) => i.id === armorId) : undefined;
        const armorValue =
          armorItem && armorItem.type === 'armor' ? armorItem.armor[action.zone] : 0;
        const absorb = armorAbsorb({
          armorValue,
          weaponLevel: weapon.level,
          config: config.armor,
        });
        const penetrated = rollPenetration({ pen: weapon.pen, rng });
        const finalDamage = damageWithPenetration({
          baseDamage: damage,
          absorb,
          penetrated,
          config: config.penetration,
          damageConfig: config.damage,
        });
        target.hp = Math.max(0, target.hp - finalDamage);

        push(
          crit ? 'crit' : 'hit',
          t(crit ? 'battle.log.shoot_crit' : 'battle.log.shoot_hit', lang, {
            target: targetName,
            dmg: finalDamage,
            zone: zoneName,
          }),
        );
        if (target.hp === 0) {
          push('death', t('battle.log.shoot_death', lang, { target: targetName }));
        }
      }
      break;
    }

    case 'setStance': {
      const stances = ['stand', 'crouch', 'run', 'cover'];
      if (!stances.includes(action.stance)) return { ok: false, error: 'invalid_stance' };
      if (action.stance === player.position) break; // no-op, no AP, no log
      if (action.stance === 'cover' && !hasAdjacentCover(next, player.hex)) {
        return { ok: false, error: 'cover_not_available' };
      }
      const cost =
        action.stance === 'run'
          ? config.apCosts.setStanceRunEnter
          : player.position === 'run'
            ? config.apCosts.setStanceRunExit
            : action.stance === 'cover'
              ? config.apCosts.setStanceCover
              : config.apCosts.setStanceStandCrouch;
      if (player.ap < cost) return { ok: false, error: 'not_enough_ap' };
      player.ap -= cost;
      player.position = action.stance;
      push(
        'info',
        t('battle.log.stance_change', lang, {
          stance: t(`ui.battle.position.${action.stance}`, lang),
        }),
      );
      break;
    }

    case 'aim': {
      const cost = config.apCosts.aim;
      if (player.ap < cost) return { ok: false, error: 'not_enough_ap' };
      player.ap -= cost;
      player.effects = player.effects.filter((e) => e.id !== 'aim');
      player.effects.push({
        id: 'aim',
        kind: 'buff',
        ttlRounds: 1,
        payload: { hitBonus: AIM_BONUS },
      });
      push('info', t('battle.log.aim', lang));
      break;
    }

    case 'reload': {
      if (!player.equipment.weaponId) return { ok: false, error: 'no_weapon' };
      const weapon = findWeapon(items, player.equipment.weaponId);
      if (!weapon) return { ok: false, error: 'unknown_item' };
      if (weapon.charges === undefined) return { ok: false, error: 'no_weapon' };
      const cost = config.apCosts[reloadCostKey(weapon.weaponCategory)];
      if (player.ap < cost) return { ok: false, error: 'not_enough_ap' };
      player.ap -= cost;
      player.weaponCharges = weapon.charges;
      push('info', t('battle.log.reload', lang, { weapon: t(weapon.nameKey, lang) }));
      break;
    }

    case 'useItem': {
      const item = items.find((i) => i.id === action.itemId);
      if (!item || item.type !== 'consumable') return { ok: false, error: 'unknown_item' };
      const healAmount = item.effect.heal ?? 0;
      const cure = item.effect.cure;
      if (healAmount <= 0 && !cure) return { ok: false, error: 'unknown_item' };
      const cost = config.apCosts.useItem;
      if (player.ap < cost) return { ok: false, error: 'not_enough_ap' };
      player.ap -= cost;

      let healed = 0;
      if (healAmount > 0) {
        const room = Math.max(0, player.hpMax - player.hp);
        healed = Math.min(healAmount, room, next.healLimit.current);
        player.hp += healed;
        next.healLimit.current -= healed;
      }
      if (cure) player.effects = player.effects.filter((e) => e.kind !== cure);

      const itemName = t(item.nameKey, lang);
      if (healed > 0) {
        push('heal', t('battle.log.heal', lang, { item: itemName, hp: healed }));
      } else if (healAmount > 0) {
        push('info', t('battle.log.heal_limit_exceeded', lang, { item: itemName }));
      } else {
        push('heal', t('battle.log.heal', lang, { item: itemName, hp: 0 }));
      }
      break;
    }

    case 'flee': {
      if (player.position !== 'run') return { ok: false, error: 'cannot_flee' };
      const maxMobAgi = aliveMobs(next).reduce((max, p) => Math.max(max, p.stats.agi), 0);
      const chance = clamp(40 + (player.stats.agi - maxMobAgi) * 2, 10, 90);
      if (rng() * 100 < chance) {
        next.status = 'fled';
        next.result = 'fled';
        next.phase = 'finished';
        push('flee', t('battle.log.flee_success', lang));
      } else {
        // The mobs' free attack is stage 5e; 5d only logs the failure.
        push('info', t('battle.log.flee_fail', lang));
      }
      break;
    }

    case 'endTurn': {
      // Stage 5e contract: hand control to the mobs. Round/AP/heal bookkeeping
      // happens in runEnemyTurn, which the API calls right after this action.
      next.phase = 'enemy_turn';
      break;
    }
  }

  checkBattleEnd(next, push, lang);
  if (next.status !== 'active') next.phase = 'finished';
  next.updatedAt = nowIso();

  return { ok: true, newState: next, logEntries: entries, weaponCategoryHit };
}

/**
 * Stage 5e: runs every living mob's turn, then starts a new round.
 * Pure and immutable; the API calls it after applyAction(endTurn).
 */
export function runEnemyTurn(params: {
  state: BattleState;
  config: BattleConfig;
  items: Item[];
  mobs: Mob[];
  rng: () => number;
  lang: Lang;
}): { newState: BattleState; logEntries: BattleLogEntry[] } {
  const { state, config, items, mobs, rng, lang } = params;

  // Not the mobs' phase: return the state untouched, no log entries.
  if (state.phase === 'player_turn') {
    return { newState: structuredClone(state), logEntries: [] };
  }

  const next = structuredClone(state);
  const entries: BattleLogEntry[] = [];
  const push = (type: BattleLogType, text: string, actor = 'system'): void => {
    const entry: BattleLogEntry = { round: next.round, actor, type, text, createdAt: nowIso() };
    entries.push(entry);
    next.log.push(entry);
  };

  const player = next.participants.find((p) => p.kind === 'player');

  for (const actorId of next.turnOrder) {
    if (actorId === PLAYER_ID) continue;
    if (next.status !== 'active') break;
    const mob = next.participants.find((p) => p.id === actorId);
    if (!mob || mob.kind !== 'mob' || mob.hp <= 0) continue;

    const def = mobs.find((m) => m.id === mob.refId) ?? null;
    const moveCost = mobMoveAp(def);
    const attackCost = mobAttackAp(def);
    const mobLabel = t(mob.mobNameKey ?? '', lang);

    // Fresh AP pool for the mob's turn (one move + one attack).
    mob.ap = mob.apMax;

    // Hard cap of 5 decisions per mob: protects against decision loops.
    for (
      let actionCount = 0;
      actionCount < 5 && mob.ap > 0 && next.status === 'active';
      actionCount++
    ) {
      const decision = decideMobAction({ mob, state: next, items, mobs, config, rng });

      if (decision.type === 'wait') {
        push('info', t('battle.log.mob_wait', lang, { mob: mobLabel }), mob.id);
        break;
      }

      if (decision.type === 'move') {
        const check = canMoveTo({
          from: mob.hex,
          to: decision.to,
          obstacles: next.map.obstacles,
          occupiedHexes: next.participants
            .filter((p) => p.id !== mob.id && p.hp > 0)
            .map((p) => p.hex),
          mapWidth: next.map.width,
          mapHeight: next.map.height,
        });
        if (!check.ok) break;
        mob.ap -= moveCost;
        mob.hex = { ...decision.to };
        push(
          'info',
          t('battle.log.mob_move', lang, {
            mob: mobLabel,
            q: decision.to.q,
            r: decision.to.r,
          }),
          mob.id,
        );
        continue;
      }

      if (decision.type === 'shoot') {
        if (!player || player.hp <= 0) break;
        if (mob.ap < attackCost) break;
        if (!def) break;
        mob.ap -= attackCost;

        const distance = hexDistance(mob.hex, player.hex);
        const chance = hitChance({
          perAttacker: mob.stats.per,
          agiTarget: player.stats.agi,
          zone: decision.zone,
          distanceHexes: distance,
          // Mob attacks have no spread modifier: 100 keeps the distance mod at 1.
          weapon: { range: def.attack.range, spread: 100, sniper: false },
          positionAttacker: mob.position,
          positionTarget: player.position,
          coverTarget: player.position === 'cover',
          config: config.hit,
          perConfig: config.per,
          sniperConfig: config.distance.sniper,
        });

        if (rng() * 100 >= chance.chance) {
          push('miss', t('battle.log.mob_shoot_miss', lang, { mob: mobLabel }), mob.id);
          continue;
        }

        let damage = rollDamage({
          weaponDamage: { min: def.attack.min, max: def.attack.max },
          ammoBonus: 0,
          rng,
        });
        const crit = rollCrit({ intel: mob.stats.intel, config: config.damage, rng });
        if (crit) damage = applyCrit(damage, config.damage);

        const armorId = player.equipment.armor[decision.zone];
        const armorItem = armorId ? items.find((i) => i.id === armorId) : undefined;
        const armorValue =
          armorItem && armorItem.type === 'armor' ? armorItem.armor[decision.zone] : 0;
        const absorb = armorAbsorb({
          armorValue,
          weaponLevel: mob.mobLevel ?? def.level,
          config: config.armor,
        });
        const penetrated = rollPenetration({ pen: def.attack.pen, rng });
        const finalDamage = damageWithPenetration({
          baseDamage: damage,
          absorb,
          penetrated,
          config: config.penetration,
          damageConfig: config.damage,
        });
        player.hp = Math.max(0, player.hp - finalDamage);
        push(
          crit ? 'crit' : 'hit',
          t(crit ? 'battle.log.mob_shoot_crit' : 'battle.log.mob_shoot_hit', lang, {
            mob: mobLabel,
            dmg: finalDamage,
          }),
          mob.id,
        );

        if (player.hp === 0) {
          next.status = 'defeat';
          next.result = 'defeat';
          next.phase = 'finished';
          push('death', t('battle.log.player_died', lang), 'system');
          break;
        }
        continue;
      }

      // Flee: same formula as the player, using the mob's agility.
      const chance = player
        ? clamp(40 + (mob.stats.agi - player.stats.agi) * 2, 10, 90)
        : 0;
      if (rng() * 100 < chance) {
        next.status = 'fled';
        next.result = 'fled';
        next.phase = 'finished';
        push('flee', t('battle.log.mob_flee_success', lang, { mob: mobLabel }), mob.id);
      } else {
        push('info', t('battle.log.mob_flee_fail', lang, { mob: mobLabel }), mob.id);
      }
      break;
    }
  }

  // New round bookkeeping.
  next.round += 1;
  next.healLimit.current = Math.min(
    next.healLimit.max,
    next.healLimit.current + next.healLimit.regenPerRound,
  );
  for (const p of next.participants) {
    p.ap = p.apMax;
    p.effects = p.effects
      .map((e) => ({ ...e, ttlRounds: e.ttlRounds - 1 }))
      .filter((e) => e.ttlRounds > 0);
  }
  next.phase = next.status === 'active' ? 'player_turn' : 'finished';
  next.currentActorId = PLAYER_ID;
  push('system', t('battle.log.round_start', lang, { n: next.round }), 'system');
  next.updatedAt = nowIso();

  return { newState: next, logEntries: entries };
}

/**
 * XP awarded for the mobs killed in this battle (used by the API when the
 * fight ends in victory). Kept pure: the caller owns the character row.
 */
export function battleVictoryXp(params: {
  state: BattleState;
  mobs: Mob[];
  playerLevel: number;
  config: BattleConfig;
}): number {
  let xp = 0;
  for (const p of params.state.participants) {
    if (p.kind !== 'mob' || p.hp > 0) continue;
    const mob = params.mobs.find((m) => m.id === p.refId);
    xp += xpForKill({
      mobHp: p.hpMax,
      mobLevel: p.mobLevel ?? mob?.level ?? 1,
      playerLevel: params.playerLevel,
      config: params.config.xp,
    });
  }
  return xp;
}

/** Highlight sets for the client: reachable hexes (move) or LOS hexes (shoot). */
export function battleHighlight(params: {
  state: BattleState;
  action: 'move' | 'shoot';
  config: BattleConfig;
  items: Item[];
}): { reachable?: string[]; los?: string[] } {
  const { state, action, config, items } = params;
  const player = state.participants.find((p) => p.kind === 'player');
  if (!player || state.status !== 'active') return {};

  if (action === 'move') {
    const cost =
      player.position === 'run'
        ? config.apCosts.moveRun
        : player.position === 'crouch'
          ? config.apCosts.moveCrouch
          : config.apCosts.moveStand;
    const maxSteps = cost > 0 ? Math.floor(player.ap / cost) : 0;
    const reachable = reachableHexes({
      from: player.hex,
      maxSteps,
      obstacles: state.map.obstacles,
      occupiedHexes: state.participants.filter((p) => p.hp > 0 && p.id !== player.id).map((p) => p.hex),
      mapWidth: state.map.width,
      mapHeight: state.map.height,
    });
    return { reachable: [...reachable] };
  }

  const weapon = findWeapon(items, player.equipment.weaponId);
  if (!weapon) return { los: [] };
  const los: string[] = [];
  for (let r = 0; r < state.map.height; r++) {
    for (let q = 0; q < state.map.width; q++) {
      const to = { q, r };
      if (hexDistance(player.hex, to) > weapon.range) continue;
      if (
        hasLineOfSight({
          from: player.hex,
          to,
          obstacles: state.map.obstacles,
          mapWidth: state.map.width,
          mapHeight: state.map.height,
        })
      ) {
        los.push(hexKey(to));
      }
    }
  }
  return { los };
}

// Re-export for the API layer.
export type { ActionError };
