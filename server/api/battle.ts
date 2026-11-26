// Battle REST API — start, read, highlights, actions and stage 6a sync.

import type { FastifyInstance } from 'fastify';
import { getCharacter } from '../game/entities/character';
import { buildBattleState } from '../game/battle/start';
import { battleHighlight } from '../game/battle/engine';
import { ActionSchema, type Action } from '../game/battle/actions';
import type { BattleState } from '../game/battle/state';
import {
  createBattle,
  getBattle,
  getActiveBattleForCharacter,
} from '../db/battle-repo';
import { abandonBattle, getBattleRewards, processBattleAction } from '../game/battle/service';
import { closeBattleRoom } from '../ws/battle';
import type { Lang } from '../i18n';

function resolveLang(query: unknown, body?: unknown): Lang {
  const fromBody = (body as { lang?: unknown } | undefined)?.lang;
  const fromQuery = (query as { lang?: unknown } | undefined)?.lang;
  const lang = fromBody ?? fromQuery;
  return lang === 'en' ? 'en' : 'ru';
}

export async function battleRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: unknown; Querystring: { lang?: string } }>(
    '/api/battle/start',
    async (req, reply) => {
      const character = getCharacter(app.db);
      if (!character) {
        return reply.status(404).send({ error: 'no_character' });
      }
      const body = (req.body ?? {}) as { mobIds?: unknown; isElite?: unknown };
      const mobIds = Array.isArray(body.mobIds)
        ? body.mobIds.filter((m): m is string => typeof m === 'string')
        : [];
      // Stage 7: optional elite flags from rollEncounter; absent = all normal.
      const isElite = Array.isArray(body.isElite) ? body.isElite.map(Boolean) : [];
      if (mobIds.length < 1 || mobIds.length > 3) {
        return reply.status(400).send({ error: 'invalid_mob_ids' });
      }
      const mobs = mobIds.map((id) => app.gameData.mobs.mobs.find((m) => m.id === id));
      if (mobs.some((m) => m === undefined)) {
        return reply.status(400).send({ error: 'unknown_mob' });
      }
      if (getActiveBattleForCharacter(app.db)) {
        return reply.status(409).send({ error: 'battle_already_active' });
      }
      const totalLevel = mobs.reduce((sum, m) => sum + m!.level, 0);
      if (totalLevel > character.level + 5) {
        return reply.status(400).send({ error: 'too_hard' });
      }
      if (!app.gameData.world.locations.some((l) => l.id === character.location_id)) {
        return reply.status(400).send({ error: 'unknown_location' });
      }

      const lang = resolveLang(req.query);
      const state = buildBattleState(
        app.db,
        app.gameData.world,
        character,
        mobs as never[],
        lang,
        app.gameData.items.items,
        isElite,
      );
      createBattle(app.db, state);
      return reply.status(201).send({ battleId: state.id, state });
    },
  );

  app.get<{ Params: { id: string } }>('/api/battle/active', async (_req, reply) => {
    const state = getActiveBattleForCharacter(app.db);
    if (!state) {
      return reply.status(404).send({ error: 'no_active_battle' });
    }
    return { state };
  });

  app.get<{ Params: { id: string } }>('/api/battle/:id', async (req, reply) => {
    const state = getBattle(app.db, req.params.id);
    if (!state) {
      return reply.status(404).send({ error: 'battle_not_found' });
    }
    if (state.status !== 'active') {
      return { state, rewards: getBattleRewards(app.db, state.id) };
    }
    return { state };
  });

  // Stage 5d-fix: leaving the battle screen must not leave a dangling active
  // battle behind. This only closes the session — HP/XP/loot/inventory stay
  // untouched (the fight is simply abandoned, not won or lost).
  app.post<{
    Params: { id: string };
    Querystring: { lang?: string };
  }>('/api/battle/:id/abandon', async (req, reply) => {
    const state = getBattle(app.db, req.params.id);
    if (!state) {
      return reply.status(404).send({ error: 'battle_not_found' });
    }
    if (state.status !== 'active') {
      return reply.status(400).send({ error: 'battle_finished' });
    }

    const lang = resolveLang(req.query);
    const { state: newState, rewards } = abandonBattle({
      db: app.db,
      gameData: app.gameData,
      state,
      lang,
    });
    closeBattleRoom(state.id, newState, rewards);
    return { state: newState, rewards };
  });

  app.get<{
    Params: { id: string };
    Querystring: { action?: string };
  }>('/api/battle/:id/highlight', async (req, reply) => {
    const state = getBattle(app.db, req.params.id);
    if (!state) {
      return reply.status(404).send({ error: 'battle_not_found' });
    }
    const action = req.query.action === 'shoot' ? 'shoot' : 'move';
    const result = battleHighlight({
      state,
      action,
      config: app.gameData.battleConfig,
      items: app.gameData.items.items,
    });
    return result;
  });

  app.post<{
    Params: { id: string };
    Body: unknown;
    Querystring: { lang?: string };
  }>('/api/battle/:id/action', async (req, reply) => {
    const state = getBattle(app.db, req.params.id);
    if (!state) {
      return reply.status(404).send({ error: 'battle_not_found' });
    }
    if (state.status !== 'active') {
      return reply.status(409).send({ ok: false, error: 'battle_finished' });
    }
    if (state.phase === 'enemy_turn') {
      return reply.status(400).send({ ok: false, error: 'not_your_turn' });
    }
    const character = getCharacter(app.db);
    if (!character) {
      return reply.status(404).send({ error: 'no_character' });
    }

    const body = (req.body ?? {}) as { action?: unknown; lang?: unknown };
    const parsed = ActionSchema.safeParse(body.action);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ ok: false, error: 'invalid_action', issues: parsed.error.issues });
    }
    const action: Action = parsed.data;
    const lang = resolveLang(req.query, body);

    const result = processBattleAction({
      db: app.db,
      gameData: app.gameData,
      state,
      action,
      lang,
    });
    if (!result.ok) {
      const status = result.error === 'battle_finished' ? 409 : 400;
      return reply.status(status).send({ ok: false, error: result.error, message: result.message });
    }

    if (result.state.status !== 'active') {
      closeBattleRoom(state.id, result.state, result.rewards);
    }
    return { ok: true, state: result.state, logEntries: result.logEntries, rewards: result.rewards };
  });
}
