// Stage 5a: builds the initial BattleState. No formulas, no actions.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Character } from '../entities/character';
import { getEquipped } from '../../db/inventory-repo';
import type { Mob } from '../../schemas/mobs';
import type { WorldFile } from '../../schemas/world';
import type { Item } from '../../schemas/items';
import type { BattleConfig } from '../../schemas/battle_config';
import { loadGameData } from '../../schemas/loader';
import type { Equipment, Obstacle, Participant, BattleState, HexCoord, BattleLogEntry } from './state';
import { applyElite } from '../world/spawn';
import { t, type Lang } from '../../i18n';

const MAP_SIZE = 10;
const PLAYER_SPAWN: HexCoord = { q: 2, r: 5 };
// Stage 10a-fix: packSizeByLevel can bring up to 16 mobs, so the spawn list
// covers sixteen hexes on the default 10x10 map.
const MOB_SPAWNS: HexCoord[] = [
  { q: 7, r: 5 },
  { q: 7, r: 4 },
  { q: 7, r: 6 },
  { q: 8, r: 5 },
  { q: 6, r: 5 },
  { q: 8, r: 4 },
  { q: 8, r: 6 },
  { q: 6, r: 4 },
  { q: 6, r: 6 },
  { q: 9, r: 5 },
  { q: 9, r: 4 },
  { q: 9, r: 6 },
  { q: 5, r: 5 },
  { q: 5, r: 4 },
  { q: 5, r: 6 },
  { q: 9, r: 3 },
];

const OBSTACLE_TYPES: Array<Omit<Obstacle, 'hex'>> = [
  { type: 'wall', blocksLos: true, blocksMove: true, blocksMelee: true, image: '/assets/obstacles/wall_slab.png' },
  { type: 'tree', blocksLos: true, blocksMove: true, blocksMelee: true, image: '/assets/obstacles/dead_pine.png' },
  { type: 'rock', blocksLos: true, blocksMove: true, blocksMelee: true, image: '/assets/obstacles/boulder.png' },
  { type: 'small_building', blocksLos: true, blocksMove: true, blocksMelee: true, image: '/assets/obstacles/wall_factory.png' },
  { type: 'barricade', blocksLos: false, blocksMove: true, blocksMelee: true, image: '/assets/obstacles/palisade.png' },
  { type: 'crate', blocksLos: false, blocksMove: true, blocksMelee: false, image: '/assets/obstacles/crate_wood.png' },
  { type: 'bush', blocksLos: false, blocksMove: false, blocksMelee: false, image: '/assets/obstacles/spore_tree.png' },
];

function hexKey(h: HexCoord): string {
  return `${h.q},${h.r}`;
}

// 3–4 random obstacles, never on spawn hexes and never duplicated.
function rollObstacles(spawns: HexCoord[]): Obstacle[] {
  const count = 3 + (Math.random() < 0.5 ? 1 : 0);
  const used = new Set(spawns.map(hexKey));
  const obstacles: Obstacle[] = [];
  while (obstacles.length < count) {
    const hex: HexCoord = {
      q: Math.floor(Math.random() * MAP_SIZE),
      r: Math.floor(Math.random() * MAP_SIZE),
    };
    const key = hexKey(hex);
    if (used.has(key)) continue;
    used.add(key);
    const cfg = OBSTACLE_TYPES[Math.floor(Math.random() * OBSTACLE_TYPES.length)];
    obstacles.push({ hex, ...cfg });
  }
  return obstacles;
}

function playerEquipment(db: Database.Database): Equipment {
  const equipped = getEquipped(db);
  const bySlot = new Map(equipped.map((e) => [e.slot, e.itemId]));
  return {
    weaponId: bySlot.get('weapon') ?? null,
    armor: {
      head: bySlot.get('head') ?? null,
      // jacket is torso-layer armor until the "arms"/layering model of v0.2
      torso: bySlot.get('torso') ?? bySlot.get('jacket') ?? null,
      arms: null,
      legs: bySlot.get('legs') ?? bySlot.get('boots') ?? null,
    },
  };
}

export function buildBattleState(
  db: Database.Database,
  world: WorldFile,
  character: Character,
  mobs: Mob[],
  lang: Lang,
  items: Item[] = [],
  isElite: boolean[] = [],
  battleConfig?: BattleConfig,
): BattleState {
  const spawns = [PLAYER_SPAWN, ...MOB_SPAWNS.slice(0, mobs.length)];
  const now = new Date().toISOString();
  const location = world.locations.find((l) => l.id === character.location_id);
  const equipment = playerEquipment(db);
  // Stage 5d: the magazine starts full; charges live in the battle state.
  const weapon = equipment.weaponId ? items.find((i) => i.id === equipment.weaponId) : undefined;
  const weaponCharges =
    weapon && weapon.type === 'weapon' && weapon.charges !== undefined ? weapon.charges : undefined;

  const player: Participant = {
    id: 'player',
    kind: 'player',
    refId: String(character.id),
    stats: {
      str: character.str,
      agi: character.agi,
      int: character.int,
      end: character.end,
      per: character.per,
      intel: character.intel,
    },
    hp: character.hp_current,
    hpMax: character.hp_max,
    ap: character.ap_max,
    apMax: character.ap_max,
    hex: PLAYER_SPAWN,
    position: 'stand',
    facing: 0,
    equipment,
    weaponCharges,
    effects: [],
    characterName: character.name,
  };

  const mobParticipants: Participant[] = mobs.map((mob, i) => {
    const elite = isElite[i] === true;
    const effective = applyElite(mob, elite);
    return {
      id: `mob_${i + 1}`,
      kind: 'mob',
      refId: effective.id,
      stats: { ...effective.stats },
      hp: effective.hp,
      hpMax: effective.hp,
      // Stage 5e: a mob's AP pool is one move + one attack (pipe_rat: 4 + 8 = 12).
      ap: effective.moveAp + effective.attackAp,
      apMax: effective.moveAp + effective.attackAp,
      hex: MOB_SPAWNS[i],
      position: 'stand',
      facing: 0,
      equipment: { weaponId: null, armor: { head: null, torso: null, arms: null, legs: null } },
      effects: [],
      mobLevel: effective.level,
      mobNameKey: effective.nameKey,
      ...(elite ? { isElite: true } : {}),
    };
  });

  // Stage 10a: the healing cap now comes from battle.json (1.2× by default).
  const healConfig = (battleConfig ?? loadGameData(path.resolve('data')).battleConfig).healLimit;
  const healMax = Math.floor(character.hp_max * healConfig.startMult);
  const target = t(mobs[0].nameKey, lang);

  const log: BattleLogEntry[] = [
    {
      round: 1,
      actor: 'system',
      type: 'system',
      text: t('battle.start', lang, { target }),
      createdAt: now,
    },
  ];
  for (const mob of mobs.filter((_, i) => isElite[i] === true)) {
    log.push({
      round: 1,
      actor: 'system',
      type: 'system',
      text: t('battle.log.elite_spawn', lang, { mob: t(mob.nameKey, lang) }),
      createdAt: now,
    });
  }

  return {
    id: randomUUID(),
    round: 1,
    status: 'active',
    phase: 'player_turn',
    map: { width: MAP_SIZE, height: MAP_SIZE, obstacles: rollObstacles(spawns) },
    participants: [player, ...mobParticipants],
    turnOrder: ['player', ...mobParticipants.map((m) => m.id)],
    currentActorId: 'player',
    log,
    context: {
      locationId: character.location_id,
      isAmbush: false,
      cover: location?.cover ?? false,
      timeOfDay: 'day',
    },
    healLimit: {
      current: healMax,
      max: healMax,
      regenPerRound: Math.floor(character.hp_max * healConfig.regenPerRoundMult),
    },
    createdAt: now,
    updatedAt: now,
  };
}
