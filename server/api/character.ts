// Stage 2: character REST API. Only `name` is accepted from the client — stats are fixed server-side.

import type { FastifyInstance } from 'fastify';
import { createCharacter, getCharacter } from '../game/entities/character';
import { updateCharacter } from '../db/character-repo';
import { getAllWeaponSkills } from '../game/entities/weapon-skill';

const REST_COOLDOWN_MS = 5 * 60 * 1000;

function isCity(app: FastifyInstance, locationId: string): boolean {
  return app.gameData.world.locations.some((loc) => loc.id === locationId && loc.type === 'city');
}

function cooldownRemainingSec(lastRestAt: string | null, now: number): number {
  if (!lastRestAt) return 0;
  const elapsed = now - Date.parse(lastRestAt);
  if (!Number.isFinite(elapsed) || elapsed >= REST_COOLDOWN_MS) return 0;
  return Math.ceil((REST_COOLDOWN_MS - elapsed) / 1000);
}

export async function characterRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/character', async (_req, reply) => {
    const character = getCharacter(app.db);
    if (!character) {
      return reply.status(404).send({ error: 'no_character' });
    }
    // Stage 9: weapon skills ride along with the character payload.
    return { character: { ...character, weaponSkills: getAllWeaponSkills(app.db) } };
  });

  app.post<{ Body: unknown }>('/api/character', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown };
    // Extra fields (str, agi, ...) are ignored — stats are always fixed.
    try {
      const character = createCharacter(app.db, {
        name: body.name,
        startLocationId: app.gameData.world.startLocationId,
        items: app.gameData.items?.items ?? [],
      });
      return reply.status(201).send({ character });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'invalid_name') {
        return reply.status(400).send({ error: 'invalid_name' });
      }
      if (msg === 'character_exists') {
        return reply.status(409).send({ error: 'character_exists' });
      }
      throw err;
    }
  });

  // Out-of-battle recovery (stage 06b-fix). Both actions require a city.
  app.post('/api/character/rest', async (_req, reply) => {
    const character = getCharacter(app.db);
    if (!character) {
      return reply.status(404).send({ error: 'no_character' });
    }
    if (!isCity(app, character.location_id)) {
      return reply.status(400).send({ error: 'not_in_city' });
    }
    const now = Date.now();
    const remainingSec = cooldownRemainingSec(character.last_rest_at, now);
    if (remainingSec > 0) {
      return reply.status(400).send({ error: 'rest_cooldown', remainingSec });
    }
    if (character.hp_current === character.hp_max) {
      return reply.status(400).send({ error: 'full_hp' });
    }
    const updated = updateCharacter(app.db, {
      id: 1,
      hp_current: Math.min(character.hp_max, character.hp_current + Math.floor(character.hp_max * 0.3)),
      last_rest_at: new Date(now).toISOString(),
    });
    return { character: updated };
  });

  app.post('/api/character/heal', async (_req, reply) => {
    const character = getCharacter(app.db);
    if (!character) {
      return reply.status(404).send({ error: 'no_character' });
    }
    if (!isCity(app, character.location_id)) {
      return reply.status(400).send({ error: 'not_in_city' });
    }
    if (character.hp_current === character.hp_max) {
      return reply.status(400).send({ error: 'full_hp' });
    }
    const cost = Math.max(5, character.hp_max - character.hp_current);
    if (character.money < cost) {
      return reply.status(400).send({ error: 'not_enough_money', cost, have: character.money });
    }
    const updated = updateCharacter(app.db, {
      id: 1,
      hp_current: character.hp_max,
      money: character.money - cost,
    });
    return { character: updated, cost };
  });
}
