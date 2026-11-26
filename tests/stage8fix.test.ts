// Stage 8-fix: army tags as the currency lore — item, mob loot, i18n strings.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadGameData } from '../server/schemas/loader';
import { loadI18n } from '../server/i18n';
import { getSellPrice } from '../server/db/shop-repo';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const gameData = loadGameData(DATA_DIR);
const i18n = loadI18n(DATA_DIR);

const HUMANS = ['rust_digger', 'bandit_scout', 'bandit_brute', 'bandit_shooter'];
const ANIMALS = ['pipe_rat', 'ash_dog', 'rat_elder', 'gray_widow'];
const SPORES = ['spore_youth', 'rot_walker', 'spore_hound', 'spore_priest', 'spore_shooter', 'rust_hulk'];

function mob(id: string) {
  const m = gameData.mobs.mobs.find((m) => m.id === id);
  if (!m) throw new Error(`no mob ${id}`);
  return m;
}

describe('army_tag item', () => {
  it('exists as misc with the currency tag and price 2 (sell = 1 tag)', () => {
    const item = gameData.items.items.find((i) => i.id === 'army_tag');
    expect(item).toBeDefined();
    expect(item!.type).toBe('misc');
    expect(item!.price).toBe(2);
    expect(item!.tags).toContain('currency');
  });

  it('selling army_tag yields exactly 1 tag (floor(2×0.5))', () => {
    expect(getSellPrice(2, false)).toBe(1);
  });
});

describe('army_tag in mob loot', () => {
  it('every mob drops army_tag (guaranteed or rare)', () => {
    for (const m of gameData.mobs.mobs) {
      const inGuaranteed = m.loot.guaranteed?.itemId === 'army_tag';
      const inRare = m.loot.rare.some((r) => r.itemId === 'army_tag');
      expect(inGuaranteed || inRare, m.id).toBe(true);
    }
  });

  it('animals: rare with a 30–50% chance', () => {
    for (const id of ANIMALS) {
      const entry = mob(id).loot.rare.find((r) => r.itemId === 'army_tag');
      expect(entry, id).toBeDefined();
      expect(entry!.weight, id).toBeGreaterThanOrEqual(30);
      expect(entry!.weight, id).toBeLessThanOrEqual(50);
    }
  });

  it('humans: always drop their own tags (weight 100)', () => {
    for (const id of HUMANS) {
      const entry = mob(id).loot.rare.find((r) => r.itemId === 'army_tag');
      expect(entry, id).toBeDefined();
      expect(entry!.weight, id).toBe(100);
    }
  });

  it('spores: rare with a 10–20% chance', () => {
    for (const id of SPORES) {
      const entry = mob(id).loot.rare.find((r) => r.itemId === 'army_tag');
      expect(entry, id).toBeDefined();
      expect(entry!.weight, id).toBeGreaterThanOrEqual(10);
      expect(entry!.weight, id).toBeLessThanOrEqual(20);
    }
  });
});

describe('i18n: army tags', () => {
  it('new lore keys exist in ru and en', () => {
    const keys = [
      'item.army_tag.name',
      'item.army_tag.desc',
      'npc.koval.line.6',
      'npc.molchun.rumor.2',
      'battle.log.loot_army_tag',
      'ui.character.money_tooltip',
    ];
    for (const key of keys) {
      expect(i18n.ru[key], `ru ${key}`).toBeTruthy();
      expect(i18n.en[key], `en ${key}`).toBeTruthy();
    }
  });

  it('no «гильзы»/shells left as currency strings', () => {
    for (const [key, value] of Object.entries(i18n.ru)) {
      expect(value.toLowerCase(), `ru ${key}`).not.toContain('гильз');
    }
    for (const [key, value] of Object.entries(i18n.en)) {
      expect(value.toLowerCase(), `en ${key}`).not.toMatch(/\bshells?\b/);
    }
  });

  it('old_coin item strings are untouched (it is an item, not currency)', () => {
    expect(i18n.ru['item.old_coin.name']).toBeTruthy();
    expect(i18n.ru['item.old_coin.desc']).toContain('двуглавым орлом');
  });
});

describe('npc data', () => {
  it('koval has line.6, molchun has rumor.2', () => {
    const koval = gameData.npcs.npcs.find((n) => n.id === 'koval')!;
    const molchun = gameData.npcs.npcs.find((n) => n.id === 'molchun')!;
    expect(koval.dialogueKeys).toContain('npc.koval.line.6');
    expect(molchun.rumorKeys).toContain('npc.molchun.rumor.2');
  });
});
