// Stage 6a: WebSocket battle channel. Actions travel over the socket, but the
// server owns all rules — the client only sends a Zod-validatable action.

import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { getBattle } from '../db/battle-repo';
import { ActionSchema, type Action } from '../game/battle/actions';
import type { BattleRewards } from '../game/battle/sync';
import { processBattleAction } from '../game/battle/service';
import { t, type Lang } from '../i18n';

type OutgoingMessage =
  | { type: 'state'; state: unknown }
  | { type: 'update'; state: unknown; logEntries: unknown; rewards?: BattleRewards }
  | { type: 'end'; state: unknown; rewards?: BattleRewards }
  | { type: 'error'; error: string; message: string }
  | { type: 'pong' };

const rooms = new Map<string, Set<WebSocket>>();

function send(ws: WebSocket, message: OutgoingMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

export function broadcastToRoom(
  battleId: string,
  message: OutgoingMessage,
): void {
  for (const client of rooms.get(battleId) ?? []) send(client, message);
}

export function closeBattleRoom(
  battleId: string,
  state: unknown,
  rewards?: BattleRewards,
): void {
  broadcastToRoom(battleId, { type: 'end', state, rewards });
  for (const client of rooms.get(battleId) ?? []) client.close(1000);
  rooms.delete(battleId);
}

function resolveLang(query: URLSearchParams, body?: unknown): Lang {
  const fromBody = (body as { lang?: unknown } | undefined)?.lang;
  const lang = fromBody ?? query.get('lang');
  return lang === 'en' ? 'en' : 'ru';
}

function errorMessage(error: string, lang: Lang): string {
  const key = `battle.error.${error}`;
  const message = t(key, lang);
  return message.startsWith('[missing:') ? t('battle.error.invalid_action', lang) : message;
}

export async function battleWebsocketPlugin(app: FastifyInstance): Promise<void> {
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (!/^\/ws\/battle\/[^/]+\/?$/.test(url.pathname)) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  app.server.on('upgrade', onUpgrade);

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const battleId = decodeURIComponent(
      url.pathname.replace(/^\/ws\/battle\//, '').replace(/\/$/, ''),
    );
    const queryLang = url.searchParams;

    const state = getBattle(app.db, battleId);
    if (!state) {
      ws.close(4004, 'battle_not_found');
      return;
    }
    if (state.status !== 'active') {
      ws.close(4000, 'battle_finished');
      return;
    }

    const clients = rooms.get(battleId) ?? new Set<WebSocket>();
    clients.add(ws);
    rooms.set(battleId, clients);
    send(ws, { type: 'state', state });

    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30_000);

    ws.on('message', (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(ws, {
          type: 'error',
          error: 'invalid_action',
          message: errorMessage('invalid_action', resolveLang(queryLang)),
        });
        return;
      }

      if (message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }
      const incoming = message as { type?: unknown; action?: unknown; lang?: unknown } | null;
      if (!incoming || incoming.type !== 'action') {
        send(ws, {
          type: 'error',
          error: 'invalid_action',
          message: errorMessage('invalid_action', resolveLang(queryLang, incoming ?? undefined)),
        });
        return;
      }
      const lang = resolveLang(queryLang, incoming);
      const parsed = ActionSchema.safeParse(incoming.action);
      if (!parsed.success) {
        send(ws, {
          type: 'error',
          error: 'invalid_action',
          message: errorMessage('invalid_action', lang),
        });
        return;
      }

      const current = getBattle(app.db, battleId);
      if (!current) {
        send(ws, { type: 'error', error: 'battle_not_found', message: errorMessage('battle_not_found', lang) });
        return;
      }
      const outcome = processBattleAction({
        db: app.db,
        gameData: app.gameData,
        state: current,
        action: parsed.data as Action,
        lang,
      });
      if (!outcome.ok) {
        send(ws, {
          type: 'error',
          error: outcome.error,
          message: outcome.message ?? errorMessage(outcome.error, lang),
        });
        return;
      }

      broadcastToRoom(battleId, {
        type: 'update',
        state: outcome.state,
        logEntries: outcome.logEntries,
        rewards: outcome.rewards,
      });
      if (outcome.state.status !== 'active') {
        closeBattleRoom(battleId, outcome.state, outcome.rewards);
      }
    });

    ws.on('close', () => {
      clearInterval(keepalive);
      const clients = rooms.get(battleId);
      clients?.delete(ws);
      if (clients && clients.size === 0) rooms.delete(battleId);
    });
    ws.on('error', () => {
      clearInterval(keepalive);
    });
  });

  app.addHook('onClose', async () => {
    app.server.off('upgrade', onUpgrade);
    for (const battleId of [...rooms.keys()]) {
      closeBattleRoom(battleId, null);
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
}
