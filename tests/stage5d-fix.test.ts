// Stage 5d-fix: POST /api/battle/:id/abandon — closing an active battle without
// touching HP/XP/loot and without leaving a dangling active session.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb } from '../server/db';
import { characterRoutes } from '../server/api/character';
import { battleRoutes } from '../server/api/battle';
import { getBattle } from '../server/db/battle-repo';
import { loadGameData, type GameData } from '../server/schemas/loader';
import { loadI18n, setI18n } from '../server/i18n';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const gameData = loadGameData(DATA_DIR);

setI18n(loadI18n(DATA_DIR));

describe('battle API: abandon (stage 5d-fix)', () => {
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

  it('активный бой → 200, status/result "fled", phase "finished", запись flee в логе', async () => {
    const battleId = await startBattle();
    const before = getBattle(app.db, battleId)!;
    const playerHp = before.participants[0].hp;
    const logLength = before.log.length;

    const res = await post(`/api/battle/${battleId}/abandon`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { state: { status: string; result: string; phase: string } };
    expect(data.state.status).toBe('fled');
    expect(data.state.result).toBe('fled');
    expect(data.state.phase).toBe('finished');

    const saved = getBattle(app.db, battleId)!;
    expect(saved.status).toBe('fled');
    expect(saved.result).toBe('fled');
    expect(saved.phase).toBe('finished');
    expect(saved.log).toHaveLength(logLength + 1);
    const last = saved.log[saved.log.length - 1];
    expect(last.type).toBe('flee');
    expect(last.actor).toBe('system');
    // HP must stay exactly as it was before abandoning.
    expect(saved.participants[0].hp).toBe(playerHp);
  });

  it('уже завершённый бой → 400 battle_finished', async () => {
    const battleId = await startBattle();
    expect((await post(`/api/battle/${battleId}/abandon`)).status).toBe(200);
    const second = await post(`/api/battle/${battleId}/abandon`);
    expect(second.status).toBe(400);
    const data = (await second.json()) as { error: string };
    expect(data.error).toBe('battle_finished');
  });

  it('несуществующий бой → 404 battle_not_found', async () => {
    const res = await post('/api/battle/00000000-0000-4000-8000-000000000000/abandon');
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('battle_not_found');
  });

  it('после abandon GET /api/battle/active → 404, а start → 201', async () => {
    const battleId = await startBattle();
    expect((await post(`/api/battle/${battleId}/abandon`)).status).toBe(200);

    const active = await fetch(`${baseUrl}/api/battle/active`);
    expect(active.status).toBe(404);

    const fresh = await post('/api/battle/start', { mobIds: ['pipe_rat'] });
    expect(fresh.status).toBe(201);
  });
});
