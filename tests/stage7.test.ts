import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb } from '../server/db';
import { characterRoutes } from '../server/api/character';
import { worldRoutes } from '../server/api/world';
import { battleRoutes } from '../server/api/battle';
import { rollEncounter, applyElite } from '../server/game/world/spawn';
import { buildBattleState } from '../server/game/battle/start';
import { syncAfterBattle } from '../server/game/battle/sync';
import { getWorldState } from '../server/db/world-repo';
import { loadGameData, type GameData } from '../server/schemas/loader';
import { loadI18n, setI18n } from '../server/i18n';
import type { Location } from '../server/schemas/world';
import type { SpawnConfig } from '../server/schemas/battle_config';
import type { WorldState } from '../server/db/world-repo';
import { createCharacter as createChar } from '../server/game/entities/character';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const gameData = loadGameData(DATA_DIR);
setI18n(loadI18n(DATA_DIR));

const SPAWN: SpawnConfig = gameData.battleConfig.spawn;

function makeLocation(over: Partial<Location> = {}): Location {
  return {
    id: 'test_waste',
    type: 'waste',
    nameKey: 'location.pine_forest.name',
    descriptionKey: 'location.pine_forest.desc',
    ambientKeys: ['location.pine_forest.ambient.1'],
    coords: { x: 0, y: 0 },
    dangerLevel: 50,
    levelRange: [1, 5],
    connections: [{ to: 'zarya', type: 'plain' }],
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

// A constant Math.random mock hangs rollObstacles (same hex forever), so the
// mock cycles: the first rolls still hit the encounter branch deterministically.
function mockRandomCycle() {
  let n = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => (n++ % 100) / 100);
}

describe('rollEncounter', () => {
  it('city → encounter false', () => {
    const roll = rollEncounter({
      location: makeLocation({ type: 'city' }),
      worldState: null,
      config: SPAWN,
      mobs: gameData.mobs.mobs,
      rng: () => 0,
    });
    expect(roll).toEqual({ encounter: false });
  });

  it('respawn_at в будущем → encounter false', () => {
    const worldState: WorldState = {
      locationId: 'test_waste',
      respawnAt: new Date(Date.now() + 60_000).toISOString(),
      lastVisitedAt: null,
    };
    const roll = rollEncounter({
      location: makeLocation(),
      worldState,
      config: SPAWN,
      mobs: gameData.mobs.mobs,
      rng: () => 0,
    });
    expect(roll).toEqual({ encounter: false });
  });

  it('rng() >= chance → encounter false', () => {
    const roll = rollEncounter({
      location: makeLocation({ dangerLevel: 10 }),
      worldState: null,
      config: SPAWN,
      mobs: gameData.mobs.mobs,
      rng: () => 0.5,
    });
    expect(roll).toEqual({ encounter: false });
  });

  it('rng() < chance → encounter true, mobIds.length > 0', () => {
    const roll = rollEncounter({
      location: makeLocation(),
      worldState: null,
      config: SPAWN,
      mobs: gameData.mobs.mobs,
      rng: () => 0,
    });
    expect(roll.encounter).toBe(true);
    if (roll.encounter) expect(roll.mobIds.length).toBeGreaterThan(0);
  });

  it('pipe_rat (pack) → 3–5 мобов', () => {
    const low = rollEncounter({
      location: makeLocation(),
      worldState: null,
      config: SPAWN,
      mobs: gameData.mobs.mobs,
      rng: seqRng([0, 0, 0]),
    });
    const high = rollEncounter({
      location: makeLocation(),
      worldState: null,
      config: SPAWN,
      mobs: gameData.mobs.mobs,
      rng: seqRng([0, 0, 0.999]),
    });
    expect(low.encounter && low.mobIds.length).toBe(3);
    expect(high.encounter && high.mobIds.length).toBe(5);
    if (low.encounter) expect(new Set(low.mobIds)).toEqual(new Set(['pipe_rat']));
  });

  it('одиночный моб (без pack) → 1–3', () => {
    const roll = rollEncounter({
      location: makeLocation({
        spawnTable: [{ mobId: 'spore_youth', weight: 1, min: 0, max: 1 }],
      }),
      worldState: null,
      config: SPAWN,
      mobs: gameData.mobs.mobs,
      rng: seqRng([0, 0, 0.999]),
    });
    expect(roll.encounter).toBe(true);
    if (roll.encounter) {
      expect(roll.mobIds.length).toBeGreaterThanOrEqual(1);
      expect(roll.mobIds.length).toBeLessThanOrEqual(3);
    }
  });

  it('spawnLevelRange не пересекается с levelRange → encounter false', () => {
    const roll = rollEncounter({
      location: makeLocation({ levelRange: [5, 7] }),
      worldState: null,
      config: SPAWN,
      mobs: gameData.mobs.mobs,
      rng: () => 0,
    });
    expect(roll).toEqual({ encounter: false });
  });

  it('пустой spawnTable → encounter false', () => {
    const roll = rollEncounter({
      location: makeLocation({ spawnTable: [] }),
      worldState: null,
      config: SPAWN,
      mobs: gameData.mobs.mobs,
      rng: () => 0,
    });
    expect(roll).toEqual({ encounter: false });
  });

  it('eliteChance 1.0 → все isElite true', () => {
    const roll = rollEncounter({
      location: makeLocation({
        levelRange: [3, 5],
        spawnTable: [{ mobId: 'rat_elder', weight: 1, min: 0, max: 1 }],
      }),
      worldState: null,
      config: { ...SPAWN, eliteChance: 1 },
      mobs: gameData.mobs.mobs,
      rng: () => 0,
    });
    expect(roll.encounter).toBe(true);
    if (roll.encounter) {
      expect(roll.isElite.length).toBe(roll.mobIds.length);
      expect(roll.isElite.every(Boolean)).toBe(true);
    }
  });
});

describe('applyElite', () => {
  it('hp × hpMult, attack × dmgMult (floor)', () => {
    const rat = gameData.mobs.mobs.find((m) => m.id === 'rat_elder')!;
    const elite = applyElite(rat, true);
    expect(elite.hp).toBe(Math.floor(rat.hp * rat.elite!.hpMult));
    expect(elite.attack.min).toBe(Math.floor(rat.attack.min * rat.elite!.dmgMult));
    expect(elite.attack.max).toBe(Math.floor(rat.attack.max * rat.elite!.dmgMult));
    expect(elite).not.toBe(rat);
  });

  it('без элиты возвращает моба как есть', () => {
    const rat = gameData.mobs.mobs.find((m) => m.id === 'rat_elder')!;
    expect(applyElite(rat, false)).toBe(rat);
  });
});

describe('stage 7 API', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    app = Fastify();
    app.decorate('db', openDb(':memory:'));
    app.decorate('gameData', gameData as GameData);
    await app.register(characterRoutes);
    await app.register(worldRoutes);
    await app.register(battleRoutes);
    await app.listen({ port: 0 });
    const addr = app.server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    const res = await post('/api/character', { name: 'Странник' });
    expect(res.status).toBe(201);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    app.db.close();
  });

  const post = (url: string, payload: unknown = {}) =>
    fetch(`${baseUrl}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  it('POST /api/travel: encounter → battle создан, location_id обновлён', async () => {
    mockRandomCycle();
    const res = await post('/api/travel', { to: 'ash_road' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.character.location_id).toBe('ash_road');
    expect(body.battle).not.toBeNull();
    const mobs = body.battle.participants.filter((p: { kind: string }) => p.kind === 'mob');
    expect(mobs.length).toBe(3); // pipe_rat pack, min roll
    expect(mobs.every((p: { refId: string }) => p.refId === 'pipe_rat')).toBe(true);
  });

  it('POST /api/travel: нет encounter → battle null', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const res = await post('/api/travel', { to: 'ash_road' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.battle).toBeNull();
    expect(body.character.location_id).toBe('ash_road');
  });

  it('POST /api/travel: активный бой → 409 battle_already_active', async () => {
    const start = await post('/api/battle/start', { mobIds: ['pipe_rat'] });
    expect(start.status).toBe(201);
    mockRandomCycle();
    const res = await post('/api/travel', { to: 'ash_road' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'battle_already_active' });
    const character = (await (await fetch(`${baseUrl}/api/character`)).json()).character;
    expect(character.location_id).toBe('zarya');
  });

  it('после боя respawn_at в будущем, повторный переход без encounter', async () => {
    mockRandomCycle();
    const travel = await post('/api/travel', { to: 'ash_road' });
    const battle = (await travel.json()).battle;
    const abandon = await post(`/api/battle/${battle.id}/abandon`);
    expect(abandon.status).toBe(200);

    const state = getWorldState(app.db, 'ash_road');
    expect(state).not.toBeNull();
    expect(Date.parse(state!.respawnAt)).toBeGreaterThan(Date.now());

    const again = await post('/api/travel', { to: 'zarya' });
    expect((await again.json()).battle).toBeNull();
    const back = await post('/api/travel', { to: 'ash_road' });
    const body = await back.json();
    expect(body.battle).toBeNull();
    expect(body.character.location_id).toBe('ash_road');
  });

  it('POST /api/battle/start с isElite → Participant.isElite, hp увеличен', async () => {
    const res = await post('/api/battle/start', { mobIds: ['rat_elder'], isElite: [true] });
    expect(res.status).toBe(201);
    const { state } = await res.json();
    const mob = state.participants.find((p: { kind: string }) => p.kind === 'mob');
    expect(mob.isElite).toBe(true);
    expect(mob.hpMax).toBe(Math.floor(35 * 1.5));
    expect(
      state.log.some((e: { text: string }) => e.text.includes('крупнее обычного')),
    ).toBe(true);
  });

  it('buildBattleState без battleMap → дефолт 10×10, 3–4 препятствия, 5 мобов ок', async () => {
    const character = (await (await fetch(`${baseUrl}/api/character`)).json()).character;
    const rats = Array(5).fill(gameData.mobs.mobs.find((m) => m.id === 'pipe_rat')!);
    const state = buildBattleState(app.db, gameData.world, character, rats, 'ru');
    expect(state.map.width).toBe(10);
    expect(state.map.height).toBe(10);
    expect(state.map.obstacles.length).toBeGreaterThanOrEqual(3);
    expect(state.map.obstacles.length).toBeLessThanOrEqual(4);
    expect(state.participants).toHaveLength(6);
  });

  it('syncAfterBattle: rareChanceBonus только у элиты', () => {
    const rat = gameData.mobs.mobs.find((m) => m.id === 'rat_elder')!;
    const syncLoot = (elite: boolean) => {
      const db = openDb(':memory:');
      const char = createChar(db, {
        name: 'Странник',
        startLocationId: gameData.world.startLocationId,
        items: gameData.items.items,
      });
      const state = buildBattleState(db, gameData.world, char, [rat], 'ru', [], [elite]);
      state.status = 'victory';
      state.result = 'victory';
      state.phase = 'finished';
      const mob = state.participants.find((p) => p.kind === 'mob')!;
      mob.hp = 0;
      const result = syncAfterBattle({
        db,
        state,
        items: gameData.items.items,
        mobs: gameData.mobs.mobs,
        config: gameData.battleConfig,
        levelTable: gameData.levelTable,
        world: gameData.world,
        lang: 'ru',
        rng: () => 0.05,
      });
      db.close();
      return result.rewards.loot.map((l) => l.itemId);
    };

    expect(syncLoot(true)).toContain('stimpack');
    expect(syncLoot(false)).not.toContain('stimpack');
  });
});
