// Stage 8: NPC REST API — dialogue lines/rumors and begging.

import type { FastifyInstance } from 'fastify';
import { beggar, getNpcDialog } from '../game/economy/npc';
import type { Lang } from '../i18n';

function resolveLang(query: unknown): Lang {
  const lang = (query as { lang?: unknown } | undefined)?.lang;
  return lang === 'en' ? 'en' : 'ru';
}

export async function npcRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { npcId: string }; Querystring: { lang?: string } }>(
    '/api/npc/:npcId',
    async (req, reply) => {
      const npc = app.gameData.npcs.npcs.find((n) => n.id === req.params.npcId);
      if (!npc) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const dialog = getNpcDialog(npc, resolveLang(req.query));
      return {
        npc: {
          id: npc.id,
          nameKey: npc.nameKey,
          role: npc.role,
          ...(npc.portrait ? { portrait: npc.portrait } : {}),
          line: dialog.line,
          ...(dialog.rumor ? { rumor: dialog.rumor } : {}),
        },
      };
    },
  );

  app.post<{ Params: { npcId: string } }>('/api/npc/:npcId/beggar', async (req, reply) => {
    const npc = app.gameData.npcs.npcs.find((n) => n.id === req.params.npcId);
    if (!npc) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const result = beggar(app.db);
    if (!result.ok) {
      const status = result.error === 'no_character' ? 404 : 400;
      return reply.status(status).send({ error: result.error });
    }
    return { character: result.character, received: result.received };
  });
}
