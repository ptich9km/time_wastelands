// Stage 8: shop REST API — catalog with live prices, buy and sell.

import type { FastifyInstance } from 'fastify';
import { getCharacter } from '../game/entities/character';
import { getPrice, getShop, restockIfNeeded, type ShopStateRow } from '../db/shop-repo';
import { buyItem, sellItem } from '../game/economy/shop';
import type { Shop } from '../schemas/shops';

// Serializes the shop for the client: base catalog merged with live state.
function serializeShop(app: FastifyInstance, shop: Shop, states: ShopStateRow[]) {
  const byItem = new Map(states.map((s) => [s.itemId, s]));
  return {
    id: shop.id,
    nameKey: shop.nameKey,
    locationId: shop.locationId,
    items: shop.stock.map((entry) => {
      const item = app.gameData.items.items.find((i) => i.id === entry.itemId)!;
      const state = byItem.get(entry.itemId);
      return {
        itemId: item.id,
        nameKey: item.nameKey,
        icon: item.icon,
        rarity: item.rarity,
        price: getPrice(item.price, shop.multiplier, state?.inflation ?? 0),
        stock: state?.stock ?? 0,
        trend: state?.trend === 1,
        requirements: item.requirements,
      };
    }),
  };
}

// Shared guard: shop exists and the character stands in its city.
function resolveShop(
  app: FastifyInstance,
  shopId: string,
): { shop: Shop } | { status: number; error: string } {
  const shop = getShop(app.gameData, shopId);
  if (!shop) return { status: 404, error: 'not_found' };
  const character = getCharacter(app.db);
  if (!character) return { status: 404, error: 'no_character' };
  if (character.location_id !== shop.locationId) {
    return { status: 400, error: 'not_in_city' };
  }
  return { shop };
}

export async function shopRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { shopId: string } }>('/api/shop/:shopId', async (req, reply) => {
    const resolved = resolveShop(app, req.params.shopId);
    if ('status' in resolved) {
      return reply.status(resolved.status).send({ error: resolved.error });
    }
    const states = restockIfNeeded(app.db, resolved.shop);
    return { shop: serializeShop(app, resolved.shop, states) };
  });

  app.post<{ Params: { shopId: string }; Body: unknown }>(
    '/api/shop/:shopId/buy',
    async (req, reply) => {
      const resolved = resolveShop(app, req.params.shopId);
      if ('status' in resolved) {
        return reply.status(resolved.status).send({ error: resolved.error });
      }
      const body = (req.body ?? {}) as { itemId?: unknown; qty?: unknown };
      const itemId = typeof body.itemId === 'string' ? body.itemId : '';
      const qty = Number.isInteger(body.qty) && (body.qty as number) >= 1 ? (body.qty as number) : 1;

      const result = buyItem(app.db, app.gameData, resolved.shop.id, itemId, qty);
      if (!result.ok) {
        const status = result.error === 'not_found' ? 404 : 400;
        return reply.status(status).send({ error: result.error });
      }
      const states = restockIfNeeded(app.db, resolved.shop);
      return {
        character: result.character,
        inventory: result.inventory,
        shop: serializeShop(app, resolved.shop, states),
      };
    },
  );

  app.post<{ Params: { shopId: string }; Body: unknown }>(
    '/api/shop/:shopId/sell',
    async (req, reply) => {
      const resolved = resolveShop(app, req.params.shopId);
      if ('status' in resolved) {
        return reply.status(resolved.status).send({ error: resolved.error });
      }
      const body = (req.body ?? {}) as { inventoryId?: unknown };
      const inventoryId = Number(body.inventoryId);
      if (!Number.isInteger(inventoryId)) {
        return reply.status(400).send({ error: 'not_found' });
      }

      const result = sellItem(app.db, app.gameData, resolved.shop.id, inventoryId);
      if (!result.ok) {
        const status = result.error === 'not_found' ? 404 : 400;
        return reply.status(status).send({ error: result.error });
      }
      const states = restockIfNeeded(app.db, resolved.shop);
      return {
        character: result.character,
        inventory: result.inventory,
        shop: serializeShop(app, resolved.shop, states),
        price: result.price,
      };
    },
  );
}
