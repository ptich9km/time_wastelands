import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb } from '../server/db';
import { createCharacter, getCharacter } from '../server/game/entities/character';
import { addItem } from '../server/db/inventory-repo';
import {
  createBattle,
  getBattle,
  updateBattleState,
  appendLog,
  getActiveBattleForCharacter,
  markFinished,
} from '../server/db/battle-repo';
import {
  BattleStateSchema,
  type BattleState,
  type BattleLogEntry,
} from '../server/game/battle/state';
import { buildBattleState } from '../server/game/battle/start';
import { characterRoutes } from '../server/api/character';
import { battleRoutes } from '../server/api/battle';
import { loadGameData, type GameData } from '../server/schemas/loader';
import { loadI18n, setI18n } from '../server/i18n';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const gameData = loadGameData(DATA_DIR);
const world = gameData.world;
const mobs = gameData.mobs.mobs;
const pipeRat = mobs.find((m) => m.id === 'pipe_rat')!;

setI18n(loadI18n(DATA_DIR));

function makeDb() {
  const db = openDb(':memory:');
  createCharacter(db, { name: 'Странник', startLocationId: world.startLocationId, items: gameData.items.items });
  return db;
}

function makeState(db: ReturnType<typeof makeDb>, mobIds: string[] = ['pipe_rat']): BattleState {
  const character = getCharacter(db)!;
  const ms = mobIds.map((id) => mobs.find((m) => m.id === id)!);
  return buildBattleState(db, world, character, ms, 'ru');
}

// Deep-equal ignoring createdAt/updatedAt timestamps.
function stripTimestamps(state: BattleState): unknown {
  return {
    ...state,
    createdAt: '',
    updatedAt: '',
    log: state.log.map((e) => ({ ...e, createdAt: '' })),
  };
}

function logEntry(round: number, n: number): BattleLogEntry {
  return {
    round,
    actor: 'player',
    type: 'hit',
    text: `Запись ${n}`,
    createdAt: new Date().toISOString(),
  };
}

describe('battle-repo: сериализация/восстановление', () => {
  let db: ReturnType<typeof makeDb>;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('createBattle → getBattle возвращает идентичный state', () => {
    const state = makeState(db);
    createBattle(db, state);
    const loaded = getBattle(db, state.id)!;
    expect(loaded).not.toBeNull();
    expect(stripTimestamps(loaded)).toEqual(stripTimestamps(state));
    expect(loaded.log).toHaveLength(1);
  });

  it('сериализация: 3 участника, 2 препятствия, 5 записей лога → deepEqual', () => {
    const state = makeState(db, ['pipe_rat', 'ash_dog']);
    state.map.obstacles = [
      { hex: { q: 4, r: 4 }, type: 'wall', blocksLos: true, blocksMove: true },
      { hex: { q: 5, r: 3 }, type: 'crate', blocksLos: false, blocksMove: true },
    ];
    state.log = Array.from({ length: 5 }, (_, i) => logEntry(1, i + 1));
    createBattle(db, state);
    const loaded = getBattle(db, state.id)!;
    expect(loaded.participants).toHaveLength(3);
    expect(loaded.map.obstacles).toHaveLength(2);
    expect(stripTimestamps(loaded)).toEqual(stripTimestamps(state));
  });

  it('state валиден по BattleStateSchema', () => {
    const state = makeState(db);
    expect(() => BattleStateSchema.parse(state)).not.toThrow();
  });

  it('updateBattleState: новое hp и 2 новые записи лога → без дублей', () => {
    const state = makeState(db);
    createBattle(db, state);
    const loaded = getBattle(db, state.id)!;
    loaded.participants[0].hp = 10;
    loaded.log = [...loaded.log, logEntry(1, 2), logEntry(1, 3)];
    loaded.updatedAt = new Date().toISOString();
    updateBattleState(db, loaded);
    const again = getBattle(db, state.id)!;
    expect(again.participants[0].hp).toBe(10);
    expect(again.log).toHaveLength(3);
    expect(again.log.map((e) => e.text)).toEqual([state.log[0].text, 'Запись 2', 'Запись 3']);
  });

  it('updateBattleState без новых записей — лог не дублируется', () => {
    const state = makeState(db);
    createBattle(db, state);
    const loaded = getBattle(db, state.id)!;
    loaded.participants[0].hp = 20;
    updateBattleState(db, loaded);
    expect(getBattle(db, state.id)!.log).toHaveLength(1);
  });

  it('appendLog: добавить 2 записи к 5 → 7 всего', () => {
    const state = makeState(db);
    state.log = Array.from({ length: 5 }, (_, i) => logEntry(1, i + 1));
    createBattle(db, state);
    appendLog(db, state.id, [logEntry(2, 6), logEntry(2, 7)]);
    const loaded = getBattle(db, state.id)!;
    expect(loaded.log).toHaveLength(7);
    expect(loaded.log[6].text).toBe('Запись 7');
  });

  it('getActiveBattleForCharacter: после create — возвращает, после markFinished — null', () => {
    const state = makeState(db);
    createBattle(db, state);
    expect(getActiveBattleForCharacter(db)?.id).toBe(state.id);
    markFinished(db, state.id, 'victory');
    expect(getActiveBattleForCharacter(db)).toBeNull();
    const finished = getBattle(db, state.id)!;
    expect(finished.status).toBe('victory');
    expect(finished.result).toBe('victory');
    expect(finished.phase).toBe('finished');
  });

  it('UNIQUE active: второй активный бой того же персонажа → ошибка', () => {
    const state = makeState(db);
    createBattle(db, state);
    const second = makeState(db);
    expect(() => createBattle(db, second)).toThrow();
  });

  it('getBattle несуществующего id → null', () => {
    expect(getBattle(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('battle API', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    app = Fastify();
    app.decorate('db', openDb(':memory:'));
    app.decorate('gameData', gameData as GameData);
    await app.register(characterRoutes);
    await app.register(battleRoutes);
    await app.listen({ port: 0 });
    const addr = app.server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    await fetch(`${baseUrl}/api/character`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Странник' }),
    });
  });

  afterEach(async () => {
    await app.close();
    app.db.close();
  });

  const post = (url: string, payload: unknown) =>
    fetch(`${baseUrl}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  it('POST /api/battle/start { mobIds: ["pipe_rat"] } → 201, state валиден, стартовая запись в логе', async () => {
    const res = await post('/api/battle/start', { mobIds: ['pipe_rat'] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.battleId).toBeTruthy();
    const state = BattleStateSchema.parse(body.state);
    expect(state.map.width).toBe(10);
    expect(state.map.height).toBe(10);
    expect(state.map.obstacles.length).toBeGreaterThanOrEqual(3);
    expect(state.map.obstacles.length).toBeLessThanOrEqual(4);
    expect(state.participants).toHaveLength(2);
    expect(state.healLimit.max).toBe(Math.floor(state.participants[0].hpMax * 1.2));
    expect(state.turnOrder).toEqual(['player', 'mob_1']);
    expect(state.currentActorId).toBe('player');
    expect(state.log).toHaveLength(1);
    expect(state.log[0].type).toBe('system');
    expect(state.log[0].text).toBe('Трубный грызун бросается на вас!');
    // spawn hexes are not covered by obstacles
    const obstacleHexes = new Set(state.map.obstacles.map((o) => `${o.hex.q},${o.hex.r}`));
    for (const p of state.participants) {
      expect(obstacleHexes.has(`${p.hex.q},${p.hex.r}`)).toBe(false);
    }
  });

  it('POST /api/battle/start?lang=en → лог на английском', async () => {
    const res = await post('/api/battle/start?lang=en', { mobIds: ['pipe_rat'] });
    const body = await res.json();
    expect(body.state.log[0].text).toBe('Pipe Rodent lunges at you!');
  });

  it('игрок в state несёт надетое снаряжение', async () => {
    const res = await post('/api/battle/start', { mobIds: ['pipe_rat'] });
    const state = (await res.json()).state;
    expect(state.participants[0].equipment.weaponId).toBe('rusty_pipe');
    expect(state.participants[0].equipment.armor.torso).toBe('leather_jacket');
  });

  it('POST /api/battle/start с несуществующим mobId → 400', async () => {
    const res = await post('/api/battle/start', { mobIds: ['no_such_mob'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unknown_mob');
  });

  it('POST /api/battle/start без mobIds / с 4 мобами → 400', async () => {
    expect((await post('/api/battle/start', {})).status).toBe(400);
    expect(
      (await post('/api/battle/start', { mobIds: ['pipe_rat', 'pipe_rat', 'pipe_rat', 'pipe_rat'] })).status,
    ).toBe(400);
  });

  it('POST /api/battle/start: слишком сильные мобы → 400 too_hard', async () => {
    // 3 × rust_hulk (ур. 6) = 18 > level 1 + 5
    const res = await post('/api/battle/start', { mobIds: ['rust_hulk', 'rust_hulk', 'rust_hulk'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('too_hard');
  });

  it('POST /api/battle/start при активном бое → 409 battle_already_active', async () => {
    expect((await post('/api/battle/start', { mobIds: ['pipe_rat'] })).status).toBe(201);
    const res = await post('/api/battle/start', { mobIds: ['ash_dog'] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('battle_already_active');
  });

  it('GET /api/battle/:id → 200 с тем же state; несуществующий → 404', async () => {
    const res = await post('/api/battle/start', { mobIds: ['pipe_rat'] });
    const { battleId, state } = await res.json();
    const got = await fetch(`${baseUrl}/api/battle/${battleId}`);
    expect(got.status).toBe(200);
    expect(stripTimestamps((await got.json()).state)).toEqual(stripTimestamps(state));
    const missing = await fetch(`${baseUrl}/api/battle/00000000-0000-4000-8000-000000000000`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('battle_not_found');
  });

  it('GET /api/battle/active → 200 при активном бое, 404 без боя', async () => {
    const empty = await fetch(`${baseUrl}/api/battle/active`);
    expect(empty.status).toBe(404);
    expect((await empty.json()).error).toBe('no_active_battle');
    await post('/api/battle/start', { mobIds: ['pipe_rat'] });
    const active = await fetch(`${baseUrl}/api/battle/active`);
    expect(active.status).toBe(200);
    expect((await active.json()).state.status).toBe('active');
  });

  it('маршрут /api/battle/active не перехватывается /:id', async () => {
    await post('/api/battle/start', { mobIds: ['pipe_rat'] });
    const res = await fetch(`${baseUrl}/api/battle/active`);
    expect(res.status).toBe(200);
  });

  it('экипировка игрока из inventory: снятая труба → weaponId null', async () => {
    const inv = app.db
      .prepare("SELECT id FROM inventory WHERE item_id = 'rusty_pipe'")
      .get() as { id: number };
    app.db.prepare('UPDATE inventory SET equipped_slot = NULL WHERE id = ?').run(inv.id);
    addItem(app.db, 'rusty_pipe', 1); // в рюкзак, не надета
    const res = await post('/api/battle/start', { mobIds: ['pipe_rat'] });
    const state = (await res.json()).state;
    expect(state.participants[0].equipment.weaponId).toBeNull();
  });
});
