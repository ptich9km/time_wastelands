// Stage 6a: WebSocket battle channel, post-battle synchronization and
// REST reward reads. The setup mirrors the existing REST integration tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { openDb } from '../server/db';
import { characterRoutes } from '../server/api/character';
import { battleRoutes } from '../server/api/battle';
import { battleWebsocketPlugin } from '../server/ws/battle';
import { loadGameData, type GameData } from '../server/schemas/loader';
import { loadI18n, setI18n } from '../server/i18n';
import { getCharacter, updateCharacter } from '../server/db/character-repo';
import { addItem, getInventory } from '../server/db/inventory-repo';
import { getBattle, updateBattleState } from '../server/db/battle-repo';
import { syncAfterBattle } from '../server/game/battle/sync';
import type { BattleState } from '../server/game/battle/state';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const gameData = loadGameData(DATA_DIR);
setI18n(loadI18n(DATA_DIR));

type Message = {
  type: string;
  state?: BattleState;
  rewards?: unknown;
  error?: string;
  message?: string;
};

function socketHandler(ws: WebSocket) {
  const messages: Message[] = [];
  const waiters: Array<(message: Message) => void> = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as Message;
    messages.push(message);
    for (const waiter of [...waiters]) waiter(message);
  });
  return {
    ws,
    messages,
    next(predicate: (message: Message) => boolean, timeoutMs = 3000): Promise<Message> {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no matching message: ${JSON.stringify(messages)}`)),
          timeoutMs,
        );
        const check = (message: Message) => {
          if (!predicate(message)) return;
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(message);
        };
        waiters.push(check);
      });
    },
  };
}

function waitClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

async function untilOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
}

describe('stage 6a: WebSocket battle and post-battle sync', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    app = Fastify();
    app.decorate('db', openDb(':memory:'));
    app.decorate('gameData', gameData as GameData);
    await app.register(characterRoutes);
    await app.register(battleRoutes);
    await app.register(battleWebsocketPlugin);
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
    for (const ws of sockets) ws.terminate();
    sockets.length = 0;
    await app.close();
    app.db.close();
    vi.restoreAllMocks();
  });

  const post = (url: string, payload?: unknown) =>
    fetch(`${baseUrl}${url}`, {
      method: 'POST',
      ...(payload === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }),
    });

  async function startBattle(): Promise<string> {
    const res = await post('/api/battle/start', { mobIds: ['pipe_rat'] });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { battleId: string };
    return data.battleId;
  }

  function connect(battleId: string) {
    const ws = new WebSocket(
      `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/ws/battle/${battleId}?lang=ru`,
    );
    sockets.push(ws);
    return socketHandler(ws);
  }

  function adjacentMob(battleId: string): BattleState {
    const state = getBattle(app.db, battleId)!;
    state.map.obstacles = [];
    const player = state.participants.find((p) => p.kind === 'player')!;
    player.ap = player.apMax;
    const mob = state.participants.find((p) => p.kind === 'mob')!;
    mob.hex = { q: player.hex.q + 1, r: player.hex.r };
    mob.hp = 100;
    mob.hpMax = 100;
    updateBattleState(app.db, state);
    return state;
  }

  it('подключение к активному бою присылает state', async () => {
    const battleId = await startBattle();
    const client = connect(battleId);
    const message = await client.next((m) => m.type === 'state');
    expect(message.state?.id).toBe(battleId);
    expect(message.state?.status).toBe('active');
  });

  it('подключение к завершённому бою закрывается с кодом 4000', async () => {
    const battleId = await startBattle();
    await post(`/api/battle/${battleId}/abandon`);
    const client = connect(battleId);
    expect(await waitClose(client.ws)).toBe(4000);
  });

  it('подключение к несуществующему бою закрывается с кодом 4004', async () => {
    const client = connect('00000000-0000-4000-8000-000000000000');
    expect(await waitClose(client.ws)).toBe(4004);
  });

  it('WS shoot с фиксированным RNG рассылает update с новым HP', async () => {
    const battleId = await startBattle();
    adjacentMob(battleId);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const client = connect(battleId);
    await client.next((m) => m.type === 'state');
    await untilOpen(client.ws);
    client.ws.send(
      JSON.stringify({ type: 'action', action: { type: 'shoot', targetId: 'mob_1', zone: 'torso' } }),
    );
    const update = await client.next((m) => m.type === 'update');
    const saved = getBattle(app.db, battleId)!;
    const mob = saved.participants.find((p) => p.kind === 'mob')!;
    expect(mob.hp).toBeLessThan(100);
    expect(saved.log.length).toBeGreaterThan((update.state?.log.length ?? 0) - 2);
  });

  it('WS endTurn запускает ход мобов и увеличивает раунд', async () => {
    const battleId = await startBattle();
    adjacentMob(battleId);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const client = connect(battleId);
    await client.next((m) => m.type === 'state');
    await untilOpen(client.ws);
    client.ws.send(JSON.stringify({ type: 'action', action: { type: 'endTurn' } }));
    const update = await client.next((m) => m.type === 'update');
    expect(update.state?.round).toBe(2);
    expect(update.state?.phase).toBe('player_turn');
    expect(getBattle(app.db, battleId)!.round).toBe(2);
  });

  it('WS action с ошибкой возвращает error, а не update', async () => {
    const battleId = await startBattle();
    const state = getBattle(app.db, battleId)!;
    const player = state.participants.find((p) => p.kind === 'player')!;
    player.ap = 0;
    updateBattleState(app.db, state);
    const client = connect(battleId);
    await client.next((m) => m.type === 'state');
    await untilOpen(client.ws);
    client.ws.send(JSON.stringify({ type: 'action', action: { type: 'aim' } }));
    const error = await client.next((m) => m.type === 'error');
    expect(error.error).toBe('not_enough_ap');
    expect(error.message).not.toContain('[missing:');
  });

  it('WS ping получает pong', async () => {
    const battleId = await startBattle();
    const client = connect(battleId);
    await client.next((m) => m.type === 'state');
    await untilOpen(client.ws);
    client.ws.send(JSON.stringify({ type: 'ping' }));
    expect((await client.next((m) => m.type === 'pong')).type).toBe('pong');
  });

  it('update рассылается всем соединениям одного боя', async () => {
    const battleId = await startBattle();
    adjacentMob(battleId);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const first = connect(battleId);
    const second = connect(battleId);
    await Promise.all([
      first.next((m) => m.type === 'state'),
      second.next((m) => m.type === 'state'),
    ]);
    await untilOpen(first.ws);
    first.ws.send(JSON.stringify({ type: 'action', action: { type: 'aim' } }));
    const [a, b] = await Promise.all([
      first.next((m) => m.type === 'update'),
      second.next((m) => m.type === 'update'),
    ]);
    expect(a.state?.id).toBe(battleId);
    expect(b.state?.id).toBe(battleId);
  });

  it('syncAfterBattle victory: XP, levelup и лут попадают в БД один раз', async () => {
    await updateCharacter(app.db, { id: 1, xp: 590 });
    const battleId = await startBattle();
    const state = getBattle(app.db, battleId)!;
    const player = state.participants.find((p) => p.kind === 'player')!;
    player.hp = 44;
    const mob = state.participants.find((p) => p.kind === 'mob')!;
    mob.hp = 0;
    const victory = { ...state, status: 'victory' as const, phase: 'finished' as const };

    const first = syncAfterBattle({
      db: app.db,
      state: victory,
      items: gameData.items.items,
      mobs: gameData.mobs.mobs,
      config: gameData.battleConfig,
      levelTable: gameData.levelTable,
      world: gameData.world,
      lang: 'ru',
      rng: () => 0.5,
    });
    expect(first.rewards.xp).toBe(18);
    expect(first.rewards.levelUp).toBe(true);
    expect(first.rewards.newLevel).toBe(2);
    expect(first.rewards.loot).toEqual([{ itemId: 'rat_pelt', qty: 1 }]);
    const after = getCharacter(app.db)!;
    expect(after.xp).toBe(8); // 590 + 18 - 600
    expect(after.level).toBe(2);
    expect(after.hp_current).toBe(70); // level-up restores HP (stage 9 table: level 2 hpMax 70)
    expect(getInventory(app.db).some((r) => r.itemId === 'rat_pelt')).toBe(true);

    const second = syncAfterBattle({
      db: app.db,
      state: victory,
      items: gameData.items.items,
      mobs: gameData.mobs.mobs,
      config: gameData.battleConfig,
      levelTable: gameData.levelTable,
      world: gameData.world,
      lang: 'ru',
      rng: () => 0.5,
    });
    expect(second.rewards).toEqual(first.rewards);
    expect(second.logEntries).toHaveLength(0);
    expect(getCharacter(app.db)!.xp).toBe(8);
    expect(getInventory(app.db).find((r) => r.itemId === 'rat_pelt')!.qty).toBe(1);
  });

  it('syncAfterBattle defeat: hp_current = 1, money × 0.9, стартовая локация', async () => {
    await updateCharacter(app.db, { id: 1, money: 100, location_id: 'old_crossing' });
    const battleId = await startBattle();
    const state = getBattle(app.db, battleId)!;
    const defeat = { ...state, status: 'defeat' as const, phase: 'finished' as const };
    const result = syncAfterBattle({
      db: app.db,
      state: defeat,
      items: gameData.items.items,
      mobs: gameData.mobs.mobs,
      config: gameData.battleConfig,
      levelTable: gameData.levelTable,
      world: gameData.world,
      lang: 'ru',
    });
    const character = getCharacter(app.db)!;
    expect(character.hp_current).toBe(1);
    expect(character.money).toBe(90);
    expect(character.location_id).toBe(gameData.world.startLocationId);
    expect(result.rewards.moneyLost).toBe(10);
    expect(result.rewards.xp).toBe(0);
  });

  it('syncAfterBattle fled: HP из боя, XP/лут не начисляются, локация не меняется', async () => {
    await updateCharacter(app.db, { id: 1, location_id: 'old_crossing', xp: 12 });
    const battleId = await startBattle();
    const state = getBattle(app.db, battleId)!;
    const player = state.participants.find((p) => p.kind === 'player')!;
    player.hp = 41;
    const fled = { ...state, status: 'fled' as const, phase: 'finished' as const };
    const result = syncAfterBattle({
      db: app.db,
      state: fled,
      items: gameData.items.items,
      mobs: gameData.mobs.mobs,
      config: gameData.battleConfig,
      levelTable: gameData.levelTable,
      world: gameData.world,
      lang: 'ru',
    });
    const character = getCharacter(app.db)!;
    expect(character.hp_current).toBe(41);
    expect(character.xp).toBe(12);
    expect(character.location_id).toBe('old_crossing');
    expect(result.rewards.loot).toEqual([]);
    expect(getInventory(app.db).some((r) => r.itemId === 'rat_pelt')).toBe(false);
  });

  it('syncAfterBattle списывает патроны за выстрелы', async () => {
    addItem(app.db, 'ammo_medium', 5);
    const battleId = await startBattle();
    const state = getBattle(app.db, battleId)!;
    const player = state.participants.find((p) => p.kind === 'player')!;
    player.equipment.weaponId = 'sawnoff';
    player.weaponCharges = 0;
    const mob = state.participants.find((p) => p.kind === 'mob')!;
    mob.hp = 0;
    const victory = { ...state, status: 'victory' as const, phase: 'finished' as const };
    syncAfterBattle({
      db: app.db,
      state: victory,
      items: gameData.items.items,
      mobs: gameData.mobs.mobs,
      config: gameData.battleConfig,
      levelTable: gameData.levelTable,
      world: gameData.world,
      lang: 'ru',
    });
    expect(getInventory(app.db).find((r) => r.itemId === 'ammo_medium')!.qty).toBe(3);
  });

  it('REST abandon возвращает rewards и GET /api/battle/:id их сохраняет', async () => {
    const battleId = await startBattle();
    const state = getBattle(app.db, battleId)!;
    const player = state.participants.find((p) => p.kind === 'player')!;
    player.hp = 55;
    updateBattleState(app.db, state);
    const res = await post(`/api/battle/${battleId}/abandon`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { state: BattleState; rewards: unknown };
    expect(data.state.status).toBe('fled');
    expect(data.rewards).toMatchObject({ xp: 0, loot: [], levelUp: false });
    expect(getCharacter(app.db)!.hp_current).toBe(55);

    const read = await fetch(`${baseUrl}/api/battle/${battleId}`);
    expect((await read.json()) as { rewards: unknown }).toMatchObject({ rewards: data.rewards });
    expect((await post(`/api/battle/${battleId}/abandon`)).status).toBe(400);
  });
});
