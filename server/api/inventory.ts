// Stage 4b: inventory and equipment REST API.

import type { FastifyInstance } from 'fastify';
import { getCharacter } from '../game/entities/character';
import { updateCharacter } from '../db/character-repo';
import {
  getInventory,
  getItemById,
  equipItem,
  unequipItem,
  removeItem,
  getEquipped,
  EQUIP_SLOTS,
  type EquipSlot,
} from '../db/inventory-repo';
import type { Item } from '../schemas/items';

const MAX_SLOTS = 20;

function buildState(app: FastifyInstance) {
  const rows = getInventory(app.db);
  const items = rows.map((row) => ({
    inventoryId: row.id,
    itemId: row.itemId,
    qty: row.qty,
    equippedSlot: row.equippedSlot,
    item: getItemById(app.gameData, row.itemId) ?? null,
  }));
  const equipped: Partial<Record<EquipSlot, { inventoryId: number; itemId: string }>> = {};
  for (const e of getEquipped(app.db)) {
    equipped[e.slot] = { inventoryId: e.inventoryId, itemId: e.itemId };
  }
  const character = getCharacter(app.db)!;
  const itemById = new Map(app.gameData.items.items.map((i: Item) => [i.id, i]));
  const usedWeight = rows.reduce(
    (sum, r) => sum + (itemById.get(r.itemId)?.weight ?? 0) * r.qty,
    0,
  );
  return {
    items,
    equipped,
    capacity: {
      usedWeight: Math.round(usedWeight * 100) / 100,
      maxWeight: 1000 * character.str,
      usedSlots: rows.length,
      maxSlots: MAX_SLOTS,
    },
  };
}

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/inventory', async (_req, reply) => {
    const character = getCharacter(app.db);
    if (!character) {
      return reply.status(404).send({ error: 'no_character' });
    }
    return buildState(app);
  });

  app.post<{ Body: unknown }>('/api/inventory/equip', async (req, reply) => {
    const character = getCharacter(app.db);
    if (!character) {
      return reply.status(404).send({ error: 'no_character' });
    }
    const body = (req.body ?? {}) as { inventoryId?: unknown };
    const inventoryId = typeof body.inventoryId === 'number' ? body.inventoryId : NaN;
    const result = equipItem(app.db, character, inventoryId, app.gameData);
    if (!result.ok) {
      if (result.error === 'requirements_not_met') {
        return reply.status(400).send({ error: result.error, missing: result.missing });
      }
      return reply.status(400).send({ error: result.error });
    }
    const state = buildState(app);
    return { equipped: state.equipped, inventory: state.items };
  });

  app.post<{ Body: unknown }>('/api/inventory/unequip', async (req, reply) => {
    const character = getCharacter(app.db);
    if (!character) {
      return reply.status(404).send({ error: 'no_character' });
    }
    const body = (req.body ?? {}) as { inventoryId?: unknown };
    const inventoryId = typeof body.inventoryId === 'number' ? body.inventoryId : NaN;
    const result = unequipItem(app.db, inventoryId);
    if (!result.ok) {
      return reply.status(400).send({ error: result.error });
    }
    const state = buildState(app);
    return { equipped: state.equipped, inventory: state.items };
  });

  // Out-of-battle consumable use (stage 06b-fix): healing items only.
  app.post<{ Body: unknown }>('/api/inventory/use', async (req, reply) => {
    const character = getCharacter(app.db);
    if (!character) {
      return reply.status(404).send({ error: 'no_character' });
    }
    const body = (req.body ?? {}) as { inventoryId?: unknown };
    const inventoryId = typeof body.inventoryId === 'number' ? body.inventoryId : NaN;
    const row = getInventory(app.db).find((r) => r.id === inventoryId);
    if (!row) {
      return reply.status(400).send({ error: 'not_found' });
    }
    const item = getItemById(app.gameData, row.itemId);
    if (!item) {
      return reply.status(400).send({ error: 'not_found' });
    }
    if (item.type !== 'consumable') {
      return reply.status(400).send({ error: 'not_consumable' });
    }
    const healAmount = item.effect.heal ?? 0;
    if (healAmount <= 0) {
      return reply.status(400).send({ error: 'no_heal_effect' });
    }
    if (character.hp_current === character.hp_max) {
      return reply.status(400).send({ error: 'full_hp' });
    }
    const heal = Math.min(healAmount, character.hp_max - character.hp_current);
    const apply = app.db.transaction(() => {
      const updated = updateCharacter(app.db, {
        id: 1,
        hp_current: character.hp_current + heal,
      });
      removeItem(app.db, inventoryId, 1);
      return updated;
    });
    const updated = apply();
    const state = buildState(app);
    return { character: updated, inventory: state.items, healed: heal };
  });
}

// Re-export for tests.
export { EQUIP_SLOTS };
