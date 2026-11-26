import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { loadGameData, type GameData } from './schemas/loader';
import { openDb } from './db';
import { loadI18n, setI18n, getDictionary, getLangs, type Lang } from './i18n';
import { characterRoutes } from './api/character';
import { worldRoutes } from './api/world';
import { inventoryRoutes } from './api/inventory';
import { battleRoutes } from './api/battle';
import { shopRoutes } from './api/shop';
import { npcRoutes } from './api/npc';
import { battleWebsocketPlugin } from './ws/battle';
import { cleanupWorldState } from './db/world-repo';
import { backfillStarterKit } from './game/entities/character';

const VERSION = '0.1.0';
const PORT = 3000;

declare module 'fastify' {
  interface FastifyInstance {
    gameData: GameData;
    db: ReturnType<typeof openDb>;
  }
}

const app = Fastify({ logger: true });

let data: GameData;
try {
  data = loadGameData(path.resolve('data'));
  app.decorate('gameData', data);
  app.log.info(`Данные загружены: ${data.world.locations.length} локаций, ${data.items.items.length} предметов, ${data.mobs.mobs.length} мобов`);
} catch (err) {
  app.log.error('❌ Ошибка загрузки данных — сервер не стартует');
  app.log.error(err);
  process.exit(1);
}

const dicts = loadI18n(path.resolve('data'));
setI18n(dicts);

const db = openDb(path.resolve('game.db'));
app.decorate('db', db);
app.log.info('База данных открыта: game.db (WAL, busy_timeout=5000)');
const removed = cleanupWorldState(db, data.world);
if (removed > 0) {
  app.log.info(`world_state: удалено ${removed} строк на удалённых локаций`);
}
if (backfillStarterKit(db, data.items.items)) {
  app.log.info('Инвентарь: выдан стартовый набор (backfill)');
}

app.get('/health', async () => ({
  ok: true,
  version: VERSION,
  locations: data.world.locations.length,
  items: data.items.items.length,
  mobs: data.mobs.mobs.length,
  langs: getLangs(),
}));

app.get<{ Params: { lang: string } }>('/api/i18n/:lang', async (req, reply) => {
  const lang = req.params.lang;
  if (!getLangs().includes(lang as Lang)) {
    return reply.status(404).send({ error: 'unknown lang' });
  }
  return getDictionary(lang as Lang);
});

await app.register(characterRoutes);
await app.register(worldRoutes);
await app.register(inventoryRoutes);
await app.register(battleRoutes);
await app.register(shopRoutes);
await app.register(npcRoutes);
await app.register(battleWebsocketPlugin);

await app.register(fastifyStatic, {
  root: path.resolve('client'),
});

await app.listen({ port: PORT });
app.log.info(`Игра доступна на http://localhost:${PORT}`);
