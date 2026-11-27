// Stage 10a-fix: pipe rat damage and pack size scaling by location level.

import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { loadGameData } from '../server/schemas/loader';
import { loadI18n, setI18n } from '../server/i18n';
import { SpawnConfigSchema, type SpawnConfig } from '../server/schemas/battle_config';
import { packSizeForLevel, rollEncounter } from '../server/game/world/spawn';
import { buildBattleState } from '../server/game/battle/start';
import { openDb } from '../server/db';
import { createCharacter, getCharacter } from '../server/game/entities/character';
import type { Location } from '../server/schemas/world';
import type { Mob } from '../server/schemas/mobs';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const gameData = loadGameData(DATA_DIR);
setI18n(loadI18n(DATA_DIR));
const cfg = gameData.battleConfig;
const SPAWN: SpawnConfig = cfg.spawn;
const rat = gameData.mobs.mobs.find((m) => m.id === 'pipe_rat')!;

function makeLocation(over: Partial<Location> = {}): Location {
  return {
    id: 'test_level',
    type: 'waste',
    nameKey: 'location.pine_forest.name',
    descriptionKey: 'location.pine_forest.desc',
    ambientKeys: ['location.pine_forest.ambient.1'],
    coords: { x: 0, y: 0 },
    dangerLevel: 50,
    levelRange: [1, 2],
    connections: [],
    spawnTable: [{ mobId: 'pipe_rat', weight: 1, min: 0, max: 1 }],
    cover: false,
    npcIds: [],
    art: { sky: ['#000000', '#111111'], ground: '#222222', weather: 'fog', silhouettes: [] },
    ...over,
  } as Location;
}

function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++] ?? 0;
}

function packRoll(level: number, countRoll: number) {
  return rollEncounter({
    location: makeLocation({ levelRange: [1, level] }),
    worldState: null,
    config: SPAWN,
    mobs: gameData.mobs.mobs,
    rng: seqRng([0, 0, countRoll]),
  });
}

describe('pipe_rat: урон 10a-fix', () => {
  it('attack = 4–8, pen 0, range 1', () => {
    expect(rat.attack).toEqual({ min: 4, max: 8, pen: 0, range: 1 });
  });

  it('остальные поля моба не изменены', () => {
    expect(rat.level).toBe(1);
    expect(rat.hp).toBe(22);
    expect(rat.ai).toBe('aggressive');
    expect(rat.moveAp).toBe(4);
    expect(rat.attackAp).toBe(8);
    expect(rat.spawnLevelRange).toEqual([1, 3]);
    expect(rat.tags).toEqual(['animal', 'rodent', 'pack']);
    expect(rat.loot.guaranteed).toEqual({ itemId: 'rat_pelt', weight: 1, qty: [1, 1] });
  });
});

describe('battle.json: spawn.packSizeByLevel', () => {
  it('набор диапазонов соответствует спецификации', () => {
    expect(SPAWN.packSizeByLevel).toEqual([
      { maxLevel: 2, min: 3, max: 5 },
      { maxLevel: 5, min: 5, max: 8 },
      { maxLevel: 8, min: 8, max: 12 },
      { maxLevel: 99, min: 10, max: 16 },
    ]);
  });

  it('схема отклоняет пустой список, min > max и неупорядоченные maxLevel', () => {
    expect(SpawnConfigSchema.safeParse({ ...SPAWN, packSizeByLevel: [] }).success).toBe(false);
    expect(SpawnConfigSchema.safeParse({
      ...SPAWN,
      packSizeByLevel: [{ maxLevel: 2, min: 5, max: 3 }],
    }).success).toBe(false);
    expect(SpawnConfigSchema.safeParse({
      ...SPAWN,
      packSizeByLevel: [
        { maxLevel: 5, min: 3, max: 5 },
        { maxLevel: 2, min: 5, max: 8 },
      ],
    }).success).toBe(false);
    expect(SpawnConfigSchema.parse(SPAWN).packSizeByLevel).toHaveLength(4);
  });
});

describe('packSizeForLevel: выбор диапазона по upper bound локации', () => {
  it.each([
    [1, 3, 5],
    [2, 3, 5],
    [3, 5, 8],
    [5, 5, 8],
    [6, 8, 12],
    [8, 8, 12],
    [9, 10, 16],
    [99, 10, 16],
    [100, 10, 16],
  ])('уровень %i → %i–%i', (level, min, max) => {
    expect(packSizeForLevel(SPAWN, level)).toEqual({ min, max });
  });
});

describe('rollEncounter: масштабирование стаи', () => {
  it.each([
    [2, 3, 5],
    [5, 5, 8],
    [8, 8, 12],
    [20, 10, 16],
  ])('levelRange[1] = %i → %i–%i крыс', (level, min, max) => {
    const low = packRoll(level, 0);
    const high = packRoll(level, 0.999);
    expect(low.encounter && low.mobIds.length).toBe(min);
    expect(high.encounter && high.mobIds.length).toBe(max);
    if (low.encounter) {
      expect(low.isElite).toHaveLength(low.mobIds.length);
      expect(new Set(low.mobIds)).toEqual(new Set(['pipe_rat']));
    }
  });

  it('моб без тега pack по-прежнему использует soloMin/soloMax', () => {
    const solo: Mob = { ...rat, tags: rat.tags.filter((tag) => tag !== 'pack') };
    const roll = rollEncounter({
      location: makeLocation({ levelRange: [1, 20] }),
      worldState: null,
      config: SPAWN,
      mobs: [solo],
      rng: seqRng([0, 0, 0.999]),
    });
    expect(roll.encounter).toBe(true);
    if (roll.encounter) {
      expect(roll.mobIds.length).toBeGreaterThanOrEqual(SPAWN.soloMin);
      expect(roll.mobIds.length).toBeLessThanOrEqual(SPAWN.soloMax);
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildBattleState: большие стаи', () => {
  it('12 и 16 мобов получают уникальные гексы внутри карты', () => {
    let n = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => (n++ % 100) / 100);
    const db = openDb(':memory:');
    try {
      createCharacter(db, {
        name: 'Баланс',
        startLocationId: gameData.world.startLocationId,
        items: gameData.items.items,
      });
      const character = getCharacter(db)!;
      for (const count of [12, 16]) {
        const state = buildBattleState(
          db,
          gameData.world,
          character,
          Array.from({ length: count }, () => rat),
          'ru',
          gameData.items.items,
          Array(count).fill(false),
          cfg,
        );
        expect(state.participants).toHaveLength(count + 1);
        const keys = state.participants.map((p) => `${p.hex.q},${p.hex.r}`);
        expect(new Set(keys).size).toBe(keys.length);
        for (const key of keys) {
          const [q, r] = key.split(',').map(Number);
          expect(q).toBeGreaterThanOrEqual(0);
          expect(q).toBeLessThan(state.map.width);
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThan(state.map.height);
        }
        expect(state.map.obstacles.some((o) => keys.includes(`${o.hex.q},${o.hex.r}`))).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});
