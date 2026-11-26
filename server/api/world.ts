// Stage 3: world map, location screen and travel REST API.

import type { FastifyInstance } from 'fastify';
import type { WorldFile, Location } from '../schemas/world';
import { getCharacter, type Character } from '../game/entities/character';
import { updateCharacter } from '../db/character-repo';
import {
  getVisibleLocations,
  getVisitedLocations,
  getWorldState,
  markVisited,
  openNeighbors,
} from '../db/world-repo';
import { canTravel } from '../game/world/travel';
import { rollEncounter } from '../game/world/spawn';
import { buildBattleState } from '../game/battle/start';
import { createBattle, getActiveBattleForCharacter } from '../db/battle-repo';
import type { Lang } from '../i18n';

// Public location shape for the map screen — no description/ambients/art/spawn data.
function toMapLocation(loc: Location, visible: Set<string>, visited: Set<string>) {
  return {
    id: loc.id,
    type: loc.type,
    nameKey: loc.nameKey,
    coords: loc.coords,
    dangerLevel: loc.dangerLevel,
    levelRange: loc.levelRange,
    connections: loc.connections.map((c) => ({ to: c.to, type: c.type })),
    isVisible: visible.has(loc.id),
    isVisited: visited.has(loc.id),
  };
}

// Picks 2-3 random ambient keys (or fewer if the location has only 1-2).
function pickAmbients(loc: Location): string[] {
  const keys = [...loc.ambientKeys];
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return keys.slice(0, Math.max(2, Math.min(3, keys.length)));
}

function notVisitedResponse() {
  return { error: 'not_visible' };
}

export async function worldRoutes(app: FastifyInstance): Promise<void> {
  const world: WorldFile = app.gameData.world;

  app.get('/api/world', async (_req, reply) => {
    const character = getCharacter(app.db);
    if (!character) {
      return reply.status(404).send({ error: 'no_character' });
    }
    const visible = getVisibleLocations(app.db, world, character.location_id);
    const visited = getVisitedLocations(app.db);
    return {
      locations: world.locations.map((l) => toMapLocation(l, visible, visited)),
      visible: [...visible],
      current: character.location_id,
    };
  });

  app.get<{ Params: { id: string } }>('/api/location/:id', async (req, reply) => {
    const character: Character | null = getCharacter(app.db);
    if (!character) {
      return reply.status(404).send({ error: 'no_character' });
    }
    const loc = world.locations.find((l) => l.id === req.params.id);
    if (!loc) {
      return reply.status(404).send({ error: 'unknown_location' });
    }
    const visible = getVisibleLocations(app.db, world, character.location_id);
    if (!visible.has(loc.id)) {
      return reply.status(403).send(notVisitedResponse());
    }
    const state = getWorldState(app.db, loc.id);
    return {
      id: loc.id,
      type: loc.type,
      nameKey: loc.nameKey,
      descriptionKey: loc.descriptionKey,
      ambientKeys: pickAmbients(loc),
      coords: loc.coords,
      dangerLevel: loc.dangerLevel,
      levelRange: loc.levelRange,
      connections: loc.connections.map((c) => {
        const target = world.locations.find((l) => l.id === c.to);
        return {
          to: c.to,
          type: c.type,
          nameKey: target?.nameKey ?? c.to,
          locationType: target?.type ?? loc.type,
        };
      }),
      isCurrent: loc.id === character.location_id,
      isVisited: state !== null && state.lastVisitedAt !== null,
      // Stage 7: the client shows "mobs respawn in ~N min" while this is ahead.
      respawnAt: state?.respawnAt ?? null,
      // Stage 8: shop and NPC entry points on the location screen.
      shopId: loc.shopId ?? null,
      npcIds: loc.npcIds,
    };
  });

  app.post<{ Body: unknown; Querystring: { lang?: string } }>('/api/travel', async (req, reply) => {
    const body = (req.body ?? {}) as { to?: unknown; lang?: unknown };
    const targetId = typeof body.to === 'string' ? body.to : '';
    const character = getCharacter(app.db);
    if (!character) {
      return reply.status(400).send({ error: 'no_character' });
    }
    const check = canTravel(world, character, targetId);
    if (!check.ok) {
      return reply.status(400).send({ error: check.error });
    }

    // Stage 7: an encounter may trigger on arrival, before the location update.
    const target = world.locations.find((l) => l.id === targetId)!;
    const roll = rollEncounter({
      location: target,
      worldState: getWorldState(app.db, targetId),
      config: app.gameData.battleConfig.spawn,
      mobs: app.gameData.mobs.mobs,
      rng: Math.random,
    });
    if (roll.encounter) {
      if (getActiveBattleForCharacter(app.db)) {
        return reply.status(409).send({ error: 'battle_already_active' });
      }
      const lang: Lang = (body.lang ?? req.query.lang) === 'en' ? 'en' : 'ru';
      const mobs = roll.mobIds.map((id) => app.gameData.mobs.mobs.find((m) => m.id === id)!);
      const battle = buildBattleState(
        app.db,
        world,
        { ...character, location_id: targetId },
        mobs,
        lang,
        app.gameData.items.items,
        roll.isElite,
      );
      createBattle(app.db, battle);
      const updated = updateCharacter(app.db, { id: 1, location_id: targetId });
      markVisited(app.db, targetId);
      openNeighbors(app.db, targetId, world);
      return {
        character: updated,
        fromLocationId: character.location_id,
        toLocationId: targetId,
        battle,
      };
    }

    const updated = updateCharacter(app.db, { id: 1, location_id: targetId });
    markVisited(app.db, targetId);
    openNeighbors(app.db, targetId, world);
    return {
      character: updated,
      fromLocationId: character.location_id,
      toLocationId: targetId,
      battle: null,
    };
  });
}
