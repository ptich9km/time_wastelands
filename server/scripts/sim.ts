// Stage 5b: balance simulation. Simplified combat — no applyAction, no map:
// both sides stand, hit the torso at distance 1, alternate single attacks
// until someone dies. Config tuning aid only.

import path from 'node:path';
import { loadGameData } from '../schemas/loader';
import type { Mob } from '../schemas/mobs';
import type { BattleConfig } from '../schemas/battle_config';
import {
  hitChance,
  rollDamage,
  rollCrit,
  applyCrit,
  armorAbsorb,
  rollPenetration,
  damageWithPenetration,
  type Rng,
} from '../game/battle/formulas';

const gameData = loadGameData(path.resolve('data'));
const config = gameData.battleConfig;
const rng: Rng = Math.random;

interface Fighter {
  name: string;
  hp: number;
  hpMax: number;
  stats: { str: number; agi: number; int: number; end: number; per: number; intel: number };
  // weapon view
  damage: { min: number; max: number };
  range: number;
  spread: number;
  sniper: boolean;
  pen: number;
  weaponLevel: number;
  armorValue: number; // torso armor
}

function playerFighter(): Fighter {
  const row = gameData.levelTable.levels.find((l) => l.level === 1)!;
  const weapon = gameData.items.items.find((i) => i.id === 'rusty_pipe');
  const jacket = gameData.items.items.find((i) => i.id === 'leather_jacket');
  if (!weapon || weapon.type !== 'weapon') throw new Error('rusty_pipe не найден');
  if (!jacket || jacket.type !== 'armor') throw new Error('leather_jacket не найден');
  return {
    name: 'player',
    hp: row.hpMax,
    hpMax: row.hpMax,
    stats: { str: row.str, agi: row.agi, int: row.int, end: row.end, per: row.per, intel: row.intel },
    damage: weapon.damage,
    range: weapon.range,
    spread: weapon.spread,
    sniper: weapon.sniper,
    pen: weapon.pen ?? 0,
    weaponLevel: weapon.level,
    armorValue: jacket.armor.torso,
  };
}

function mobFighter(mob: Mob): Fighter {
  return {
    name: mob.id,
    hp: mob.hp,
    hpMax: mob.hp,
    stats: { ...mob.stats },
    damage: { min: mob.attack.min, max: mob.attack.max },
    range: mob.attack.range,
    spread: 100,
    sniper: false,
    pen: mob.attack.pen,
    weaponLevel: mob.level,
    armorValue: 0, // mob armor is v0.2
  };
}

// One attack: attacker → defender (torso, distance 1, stand vs stand, no cover).
// Returns damage dealt (0 on miss).
function attack(attacker: Fighter, defender: Fighter): number {
  const hit = hitChance({
    perAttacker: attacker.stats.per,
    agiTarget: defender.stats.agi,
    zone: 'torso',
    distanceHexes: 1,
    weapon: { range: attacker.range, spread: attacker.spread, sniper: attacker.sniper },
    positionAttacker: 'stand',
    positionTarget: 'stand',
    coverTarget: false,
    config: config.hit,
    sniperConfig: config.distance.sniper,
  });
  if (rng() >= hit.chance / 100) return 0;
  let damage = rollDamage({ weaponDamage: attacker.damage, ammoBonus: 0, rng });
  if (rollCrit({ intel: attacker.stats.intel, config: config.damage, rng })) {
    damage = applyCrit(damage, config.damage);
  }
  const absorb = armorAbsorb({
    armorValue: defender.armorValue,
    weaponLevel: attacker.weaponLevel,
    config: config.armor,
  });
  const penetrated = rollPenetration({ pen: attacker.pen, rng });
  return damageWithPenetration({
    baseDamage: damage,
    absorb,
    penetrated,
    config: config.penetration,
    damageConfig: config.damage,
  });
}

interface SimResult {
  wins: number;
  rounds: number[];
  playerDamageDealt: number;
  playerHits: number;
}

function simulate(mobIds: string[], battles: number): SimResult {
  const mobs = mobIds.map((id) => {
    const mob = gameData.mobs.mobs.find((m) => m.id === id);
    if (!mob) throw new Error(`моб ${id} не найден`);
    return mob;
  });
  const result: SimResult = { wins: 0, rounds: [], playerDamageDealt: 0, playerHits: 0 };
  for (let b = 0; b < battles; b++) {
    const player = playerFighter();
    const enemies = mobs.map(mobFighter);
    let round = 1;
    while (player.hp > 0 && enemies.some((e) => e.hp > 0)) {
      // player strikes the first living mob
      const target = enemies.find((e) => e.hp > 0)!;
      const dealt = attack(player, target);
      if (dealt > 0) {
        result.playerDamageDealt += dealt;
        result.playerHits += 1;
      }
      target.hp -= dealt;
      // each living mob strikes back
      for (const enemy of enemies) {
        if (enemy.hp <= 0) continue;
        player.hp -= attack(enemy, player);
        if (player.hp <= 0) break;
      }
      if (player.hp > 0 && enemies.some((e) => e.hp > 0)) round += 1;
    }
    if (player.hp > 0) result.wins += 1;
    result.rounds.push(round);
  }
  return result;
}

function report(label: string, mobIds: string[], expected: string, check: (winrate: number) => boolean) {
  const battles = 10_000;
  const r = simulate(mobIds, battles);
  const winrate = (r.wins / battles) * 100;
  const avgRounds = r.rounds.reduce((s, x) => s + x, 0) / battles;
  const avgDamage = r.playerHits > 0 ? r.playerDamageDealt / r.playerHits : 0;
  console.log(
    `${label}: winrate ${winrate.toFixed(1)}% (ожидание: ${expected}) | ` +
      `ср. длина боя ${avgRounds.toFixed(2)} раунда | ср. урон за удар ${avgDamage.toFixed(2)}`,
  );
  if (!check(winrate)) {
    console.log(`⚠️  ПРЕДУПРЕЖДЕНИЕ: winrate ${winrate.toFixed(1)}% вне ожиданий (${expected}) — тюнить data/config/battle.json`);
  }
  return { winrate, avgRounds };
}

const r1 = report('1 ур. vs pipe_rat', ['pipe_rat'], '70–85%', (w) => w >= 70 && w <= 85);
report('1 ур. vs rust_hulk (6 ур.)', ['rust_hulk'], '<= 20%', (w) => w <= 20);
report('1 ур. vs 3 × pipe_rat', ['pipe_rat', 'pipe_rat', 'pipe_rat'], '20–50%', (w) => w >= 20 && w <= 50);
if (r1.avgRounds > 6) {
  console.log(`⚠️  ПРЕДУПРЕЖДЕНИЕ: средняя длина боя 1v1 = ${r1.avgRounds.toFixed(2)} > 6 раундов`);
}
