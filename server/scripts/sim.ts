// Stage 10a / 10a-fix: balance simulation built on the real battle engine. Every fight
// runs a full turn cycle (move/shoot/endTurn + runEnemyTurn) on a 10x10 map,
// using the same configs as the live server. Warnings never fail the script.

import path from 'node:path';
import { loadGameData } from '../schemas/loader';
import { loadI18n, setI18n } from '../i18n';
import { openDb } from '../db';
import type Database from 'better-sqlite3';
import type { Item } from '../schemas/items';
import type { Mob } from '../schemas/mobs';
import type { Character } from '../game/entities/character';
import { createCharacter, getCharacter } from '../game/entities/character';
import { addItem, equipItem, getInventory } from '../db/inventory-repo';
import { updateCharacter } from '../db/character-repo';
import { buildBattleState } from '../game/battle/start';
import { applyAction, runEnemyTurn } from '../game/battle/engine';
import { hasLineOfSight, reachableHexes } from '../game/battle/los';
import type { ApCosts } from '../schemas/battle_config';
import { hexDistance, hexKey } from '../game/battle/hex';
import type { Action } from '../game/battle/actions';
import type { BattleState, HexCoord } from '../game/battle/state';

const DATA_DIR = path.resolve('data');
const gameData = loadGameData(DATA_DIR);
setI18n(loadI18n(DATA_DIR));
const config = gameData.battleConfig;
const items: Item[] = gameData.items.items;

function parseHex(key: string): HexCoord {
  const [q, r] = key.split(',').map(Number);
  return { q, r };
}

function makeFighter(db: Database.Database): Character {
  const character = createCharacter(db, {
    name: 'Симулятор',
    startLocationId: gameData.world.startLocationId,
    items,
  });
  for (const id of ['rusty_pipe', 'leather_jacket']) {
    let row = getInventory(db).find((r) => r.itemId === id);
    if (!row) row = addItem(db, id, 1);
    const equipped = equipItem(db, character, row.id, { items: gameData.items });
    if (!equipped.ok) throw new Error(`sim: cannot equip ${id}: ${equipped.error}`);
  }
  return getCharacter(db)!;
}

function resetFighter(db: Database.Database, fighter: Character): void {
  updateCharacter(db, {
    id: 1,
    hp_current: fighter.hp_max,
    hp_max: fighter.hp_max,
    ap_max: fighter.ap_max,
    level: fighter.level,
    str: fighter.str,
    agi: fighter.agi,
    int: fighter.int,
    end: fighter.end,
    per: fighter.per,
    intel: fighter.intel,
  });
}

function playerOf(state: BattleState) {
  const player = state.participants.find((p) => p.kind === 'player');
  if (!player) throw new Error('sim: no player');
  return player;
}

function playerWeapon(state: BattleState) {
  const player = playerOf(state);
  const weapon = items.find((i) => i.id === player.equipment.weaponId);
  return weapon?.type === 'weapon' ? weapon : undefined;
}

function shootCostKey(category: NonNullable<ReturnType<typeof playerWeapon>>['weaponCategory']): keyof ApCosts {
  switch (category) {
    case 'medium': return 'shootMedium';
    case 'heavy': return 'shootHeavy';
    case 'sniper': return 'shootSniper';
    default: return 'shootMelee';
  }
}

/** A simple but legal player policy: shoot when possible, otherwise step closer. */
function chooseAction(state: BattleState): Action {
  const player = playerOf(state);
  const targets = state.participants.filter((p) => p.kind === 'mob' && p.hp > 0);
  if (targets.length === 0) return { type: 'endTurn' };
  const target = targets.reduce((best, p) =>
    hexDistance(player.hex, p.hex) < hexDistance(player.hex, best.hex) ? p : best,
  );
  const distance = hexDistance(player.hex, target.hex);
  const weapon = playerWeapon(state);
  const range = weapon?.range ?? 1;
  const attackCost = weapon
    ? config.apCosts[shootCostKey(weapon.weaponCategory)]
    : config.apCosts.shootMelee;

  if (distance <= range) {
    const los = hasLineOfSight({
      from: player.hex,
      to: target.hex,
      obstacles: state.map.obstacles,
      mapWidth: state.map.width,
      mapHeight: state.map.height,
    });
    if (los) return { type: 'shoot', targetId: target.id, zone: 'torso' };
  }

  const occupied = state.participants.filter((p) => p.hp > 0).map((p) => p.hex);
  const reachable = reachableHexes({
    from: player.hex,
    maxSteps: 1,
    obstacles: state.map.obstacles,
    occupiedHexes: occupied,
    mapWidth: state.map.width,
    mapHeight: state.map.height,
  });
  const steps = [...reachable]
    .map(parseHex)
    .filter((hex) => !occupied.some((o) => hexKey(o) === hexKey(hex)))
    .sort(
      (a, b) =>
        hexDistance(a, target.hex) - hexDistance(b, target.hex) ||
        a.q - b.q ||
        a.r - b.r,
    );
  // Keep enough AP for the shot after closing in; otherwise end the turn.
  if (
    steps.length > 0 &&
    hexDistance(steps[0], target.hex) < distance &&
    player.ap >= config.apCosts.moveStand + attackCost
  ) {
    return { type: 'move', to: steps[0] };
  }
  return { type: 'endTurn' };
}

interface SimResult {
  wins: number;
  rounds: number[];
}

function simulate(db: Database.Database, fighter: Character, mobIds: string[], battles: number): SimResult {
  const mobs: Mob[] = mobIds.map((id) => {
    const mob = gameData.mobs.mobs.find((m) => m.id === id);
    if (!mob) throw new Error(`sim: mob ${id} not found`);
    return mob;
  });

  const result: SimResult = { wins: 0, rounds: [] };
  for (let b = 0; b < battles; b++) {
    resetFighter(db, fighter);
    let state = buildBattleState(
      db,
      gameData.world,
      getCharacter(db)!,
      mobs,
      'ru',
      items,
      mobs.map(() => false),
      config,
    );

    // 200 actions is a generous guard against a stalled fight; normal fights
    // finish in well under 30 engine actions.
    for (let guard = 0; guard < 200 && state.status === 'active'; guard++) {
      const player = playerOf(state);
      const action: Action = player.ap <= 0 ? { type: 'endTurn' } : chooseAction(state);
      let applied: Action = action;
      const step = applyAction({
        state,
        action,
        config,
        items,
        mobs,
        rng: Math.random,
        lang: 'ru',
      });
      if (!step.ok) {
        const fallback = applyAction({
          state,
          action: { type: 'endTurn' },
          config,
          items,
          mobs,
          rng: Math.random,
          lang: 'ru',
        });
        if (!fallback.ok) break;
        state = fallback.newState;
        applied = { type: 'endTurn' };
      } else {
        state = step.newState;
      }
      if (applied.type === 'endTurn' && state.status === 'active') {
        state = runEnemyTurn({
          state,
          config,
          items,
          mobs,
          rng: Math.random,
          lang: 'ru',
        }).newState;
      }
    }
    if (state.status === 'victory') result.wins += 1;
    result.rounds.push(state.round);
  }
  return result;
}

function report(label: string, mobIds: string[], expected: string, check: (winrate: number) => boolean) {
  // Full engine cycles are much heavier than formula-only rolls; 1000 fights
  // keeps the run interactive (override with SIM_BATTLES for a longer soak).
  const battles = Math.max(1, Number(process.env.SIM_BATTLES ?? 1000));
  const db = openDb(':memory:');
  const fighter = makeFighter(db);
  const r = simulate(db, fighter, mobIds, battles);
  const winrate = (r.wins / battles) * 100;
  const avgRounds = r.rounds.reduce((s, x) => s + x, 0) / battles;
  console.log(
    `${label}: winrate ${winrate.toFixed(1)}% (ожидание: ${expected}) | ` +
      `ср. длина боя ${avgRounds.toFixed(2)} раунда`,
  );
  if (!check(winrate)) {
    console.log(`⚠️  ПРЕДУПРЕЖДЕНИЕ: winrate ${winrate.toFixed(1)}% вне диапазона (${expected}) — тюнить data/config/battle.json`);
  }
  return { winrate, avgRounds };
}

const r1 = report('1 ур. vs pipe_rat', ['pipe_rat'], '85–100%', (w) => w >= 85 && w <= 100);
report('1 ур. vs 3 × pipe_rat', ['pipe_rat', 'pipe_rat', 'pipe_rat'], '20–50%', (w) => w >= 20 && w <= 50);
report('1 ур. vs 5 × pipe_rat', Array(5).fill('pipe_rat'), '0–20%', (w) => w <= 20);
report('1 ур. vs 8 × pipe_rat', Array(8).fill('pipe_rat'), '0–10%', (w) => w <= 10);
report('1 ур. vs 12 × pipe_rat', Array(12).fill('pipe_rat'), '0%', (w) => w === 0);
report('1 ур. vs 16 × pipe_rat', Array(16).fill('pipe_rat'), '0%', (w) => w === 0);
report('1 ур. vs rust_hulk (6 ур.)', ['rust_hulk'], '<= 20%', (w) => w <= 20);
if (r1.avgRounds > 6) {
  console.log(`⚠️  ПРЕДУПРЕЖДЕНИЕ: средняя длина боя 1v1 = ${r1.avgRounds.toFixed(2)} > 6 раундов`);
}
