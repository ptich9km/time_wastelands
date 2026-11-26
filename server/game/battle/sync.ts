// Stage 6a: persist the consequences of a finished battle (HP, XP, level,
// ammo, loot and defeat penalty). The battle session stores a sync timestamp
// and its rewards so a repeated call cannot award them twice.

import type Database from 'better-sqlite3';
import type { Character } from '../entities/character';
import type { Item } from '../../schemas/items';
import type { Mob } from '../../schemas/mobs';
import type { WorldFile } from '../../schemas/world';
import type { BattleConfig } from '../../schemas/battle_config';
import type { LevelTable } from '../../schemas/level_table';
import type { Lang } from '../../i18n';
import { t } from '../../i18n';
import { getCharacter, updateCharacter } from '../../db/character-repo';
import { getInventory, addItem, removeItem } from '../../db/inventory-repo';
import { getSyncStatus, markSynced } from '../../db/battle-repo';
import { applyLevelUp, xpToNextLevel } from './formulas';
import { battleVictoryXp } from './engine';
import type { BattleState, BattleLogEntry } from './state';

// Re-exported for callers that only need the type.
export interface LootReward {
  itemId: string;
  qty: number;
}

export interface BattleRewards {
  xp: number;
  loot: LootReward[];
  levelUp: boolean;
  newLevel?: number;
  moneyLost?: number;
}

export interface SyncAfterBattleResult {
  character: Character;
  rewards: BattleRewards;
  logEntries: BattleLogEntry[];
}

export interface SyncAfterBattleParams {
  db: Database.Database;
  state: BattleState;
  items: Item[];
  mobs: Mob[];
  config: BattleConfig;
  levelTable: LevelTable;
  world: WorldFile;
  lang: Lang;
  rng?: () => number;
}

function emptyRewards(): BattleRewards {
  return { xp: 0, loot: [], levelUp: false };
}

function rollLootQty(entry: { qty?: [number, number] }, rng: () => number): number {
  const [min, max] = entry.qty ?? [1, 1];
  return min + Math.floor(rng() * (max - min + 1));
}

function collectLoot(
  state: BattleState,
  mobs: Mob[],
  rng: () => number,
): LootReward[] {
  const totals = new Map<string, number>();
  for (const participant of state.participants) {
    if (participant.kind !== 'mob' || participant.hp > 0) continue;
    const mob = mobs.find((m) => m.id === participant.refId);
    if (!mob) continue;
    const add = (itemId: string, qty: number) => {
      totals.set(itemId, (totals.get(itemId) ?? 0) + qty);
    };
    if (mob.loot.guaranteed) {
      add(mob.loot.guaranteed.itemId, rollLootQty(mob.loot.guaranteed, rng));
    }
    for (const rare of mob.loot.rare) {
      // Stage 7: the elite rare-loot bonus applies only to actual elites.
      const bonus = participant.isElite === true ? (mob.elite?.rareChanceBonus ?? 0) : 0;
      const chance = Math.min(1, rare.weight / 100 + bonus);
      if (rng() < chance) add(rare.itemId, rollLootQty(rare, rng));
    }
  }
  return [...totals].map(([itemId, qty]) => ({ itemId, qty }));
}

/**
 * Applies the battle outcome exactly once. A stored sync marker short-circuits
 * repeated calls from REST/WS or from a reconnected client.
 */
export function syncAfterBattle(params: SyncAfterBattleParams): SyncAfterBattleResult {
  const { db, state, items, mobs, config, levelTable, world, lang } = params;
  const rng = params.rng ?? Math.random;

  return db.transaction(() => {
    const current = getCharacter(db);
    if (!current) throw new Error('syncAfterBattle: character_not_found');

    const saved = getSyncStatus(db, state.id);
    if (saved?.syncedAt) {
      return { character: current, rewards: saved.rewards ?? emptyRewards(), logEntries: [] };
    }
    if (state.status === 'active') {
      return { character: current, rewards: emptyRewards(), logEntries: [] };
    }

    const player = state.participants.find((p) => p.kind === 'player');
    const now = new Date().toISOString();
    const entries: BattleLogEntry[] = [];
    const log = (text: string) =>
      entries.push({ round: state.round, actor: 'system', type: 'system', text, createdAt: now });

    let character = current;
    const rewards = emptyRewards();

    if (state.status === 'victory') {
      const xp = battleVictoryXp({ state, mobs, playerLevel: current.level, config });
      rewards.xp = xp;
      if (xp > 0) log(t('battle.log.xp_reward', lang, { xp }));

      let newXp = current.xp + xp;
      let levelable = {
        str: current.str,
        agi: current.agi,
        int: current.int,
        end: current.end,
        per: current.per,
        intel: current.intel,
        hp: player?.hp ?? current.hp_current,
        hpMax: current.hp_max,
        apMax: current.ap_max,
        level: current.level,
      };
      const maxLevel = Math.max(...levelTable.levels.map((l) => l.level));
      while (
        levelable.level < maxLevel &&
        newXp >= xpToNextLevel({ level: levelable.level, config: config.xp })
      ) {
        const need = xpToNextLevel({ level: levelable.level, config: config.xp });
        const up = applyLevelUp({
          character: levelable,
          newLevel: levelable.level + 1,
          levelTable,
        });
        if (!up.leveled) break;
        levelable = up.character;
        newXp -= need;
        log(t('battle.log.level_up', lang, { level: levelable.level }));
      }
      rewards.levelUp = levelable.level > current.level;
      if (rewards.levelUp) rewards.newLevel = levelable.level;

      rewards.loot = collectLoot(state, mobs, rng);
      if (rewards.loot.length > 0) {
        const names = rewards.loot
          .map((reward) => `${reward.itemId} ×${reward.qty}`)
          .join(', ');
        log(t('battle.log.loot', lang, { loot: names }));
        for (const reward of rewards.loot) addItem(db, reward.itemId, reward.qty);
      }

      character = updateCharacter(db, {
        id: 1,
        xp: newXp,
        level: levelable.level,
        str: levelable.str,
        agi: levelable.agi,
        int: levelable.int,
        end: levelable.end,
        per: levelable.per,
        intel: levelable.intel,
        hp_current: levelable.hp,
        hp_max: levelable.hpMax,
        ap_max: levelable.apMax,
      });
    } else if (state.status === 'defeat') {
      const moneyLost = current.money - Math.floor(current.money * 0.9);
      rewards.moneyLost = moneyLost;
      character = updateCharacter(db, {
        id: 1,
        hp_current: 1,
        money: Math.floor(current.money * 0.9),
        location_id: world.startLocationId,
      });
    } else {
      character = updateCharacter(db, { id: 1, hp_current: player?.hp ?? 0 });
    }

    // Ammo is consumed for shots fired in active fights; medkits were already
    // deducted by the REST action handler. Defeat has no ammo bookkeeping.
    if (state.status !== 'defeat') {
      const weaponId = player?.equipment.weaponId;
      const weapon = weaponId ? items.find((i) => i.id === weaponId) : undefined;
      if (weapon?.type === 'weapon' && weapon.charges !== undefined && weapon.ammoType) {
        const spent = Math.max(0, weapon.charges - (player?.weaponCharges ?? weapon.charges));
        if (spent > 0) {
          const ammoRows = getInventory(db).filter((row) => {
            if (row.equippedSlot !== null) return false;
            const item = items.find((i) => i.id === row.itemId);
            return item?.type === 'ammo' && item.ammoType === weapon.ammoType;
          });
          let left = spent;
          for (const row of ammoRows) {
            if (left <= 0) break;
            const taken = Math.min(left, row.qty);
            removeItem(db, row.id, taken);
            left -= taken;
          }
          if (left > 0) log(t('battle.log.ammo_empty', lang, {}));
        }
      }
    }

    markSynced(db, state.id, rewards);
    return { character, rewards, logEntries: entries };
  })();
}
