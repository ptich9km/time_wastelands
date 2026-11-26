import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { ItemSchema, ItemsFileSchema } from '../items';
import { MobSchema } from '../mobs';
import { loadGameData, crossValidate } from '../loader';

const DATA_DIR = path.resolve(__dirname, '..', '..', '..', 'data');

const baseWeapon = {
  id: 'test_weapon',
  type: 'weapon',
  slot: 'weapon',
  nameKey: 'item.test.name',
  descriptionKey: 'item.test.desc',
  icon: '🔫',
  price: 100,
  weight: 2,
  level: 1,
  damage: { min: 5, max: 10 },
  range: 1,
  spread: 80,
  apCost: 5,
  reloadAp: 4,
  pen: 10,
  requirements: {},
  tags: [],
};

const baseArmor = {
  id: 'test_armor',
  type: 'armor',
  slot: 'torso',
  nameKey: 'item.test2.name',
  descriptionKey: 'item.test2.desc',
  icon: '🦺',
  price: 100,
  weight: 3,
  level: 2,
  armor: { head: 0, torso: 10, arms: 5, legs: 5 },
  requirements: {},
  tags: [],
};

const baseMob = {
  id: 'test_mob',
  nameKey: 'mob.test.name',
  descriptionKey: 'mob.test.desc',
  level: 2,
  hp: 30,
  stats: { str: 4, agi: 4, int: 2, end: 4, per: 5, intel: 1 },
  attack: { min: 3, max: 7, pen: 10, range: 1 },
  ai: 'aggressive',
  loot: { rare: [] },
  spawnLevelRange: [1, 3],
  tags: [],
};

describe('ItemSchema (v2.0)', () => {
  it('валидное оружие (винтовка-марксмен) проходит', () => {
    const result = ItemSchema.safeParse({
      ...baseWeapon,
      weaponCategory: 'sniper',
      range: 8,
      spread: 70,
      sniper: true,
      charges: 5,
      ammoType: 'medium',
    });
    expect(result.success).toBe(true);
  });

  it('валидная броня проходит', () => {
    expect(ItemSchema.safeParse(baseArmor).success).toBe(true);
  });

  it('melee-оружие без патронов проходит', () => {
    const result = ItemSchema.safeParse({
      ...baseWeapon,
      weaponCategory: 'melee',
      spread: 100,
      reloadAp: 1,
    });
    expect(result.success).toBe(true);
  });

  it('sniper: true без weaponCategory "sniper" → ошибка', () => {
    const result = ItemSchema.safeParse({
      ...baseWeapon,
      weaponCategory: 'light',
      sniper: true,
    });
    expect(result.success).toBe(false);
  });

  it('weaponCategory "sniper" без sniper: true → ошибка', () => {
    const result = ItemSchema.safeParse({
      ...baseWeapon,
      weaponCategory: 'sniper',
    });
    expect(result.success).toBe(false);
  });

  it('charges без ammoType → ошибка', () => {
    const result = ItemSchema.safeParse({ ...baseWeapon, weaponCategory: 'medium', charges: 5 });
    expect(result.success).toBe(false);
  });
});

describe('ItemsFileSchema (v2.0)', () => {
  it('ammoType без ammo-предмета → ошибка', () => {
    const file = {
      version: '2.0',
      items: [
        { ...baseWeapon, id: 'w1', weaponCategory: 'light', charges: 8, ammoType: 'light' },
      ],
    };
    expect(ItemsFileSchema.safeParse(file).success).toBe(false);
  });
});

describe('MobSchema (v2.0)', () => {
  it('валидный моб проходит (per/intel по умолчанию, moveAp/attackAp по умолчанию)', () => {
    const result = MobSchema.safeParse(baseMob);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.moveAp).toBe(4);
      expect(result.data.attackAp).toBe(8);
      expect(result.data.xp).toBe(0);
    }
  });

  it('per < 1 → ошибка (моб не может быть без меткости)', () => {
    expect(MobSchema.safeParse({ ...baseMob, stats: { ...baseMob.stats, per: 0 } }).success).toBe(false);
    expect(MobSchema.safeParse({ ...baseMob, stats: { ...baseMob.stats, per: -1 } }).success).toBe(false);
    expect(MobSchema.safeParse({ ...baseMob, stats: { ...baseMob.stats, intel: 0 } }).success).toBe(false);
    expect(MobSchema.safeParse({ ...baseMob, stats: { ...baseMob.stats, per: 1, intel: 1 } }).success).toBe(true);
  });

  it('ai = "tactical" → ошибка (в MVP только aggressive/coward)', () => {
    expect(MobSchema.safeParse({ ...baseMob, ai: 'tactical' }).success).toBe(false);
    expect(MobSchema.safeParse({ ...baseMob, ai: 'berserk' }).success).toBe(false);
  });
});

describe('crossValidate (v2.0)', () => {
  it('принимает валидные данные из data/', () => {
    const data = loadGameData(DATA_DIR);
    expect(() => crossValidate(data)).not.toThrow();
  });

  it('неизвестный mobId в spawnTable → ошибка', () => {
    const data = loadGameData(DATA_DIR);
    data.world.locations[0].spawnTable.push({ mobId: 'no_such_mob', weight: 1, min: 0, max: 1 });
    expect(() => crossValidate(data)).toThrow(/no_such_mob/);
  });

  it('weapon с ammoType, для которого нет ammo-предмета → ошибка', () => {
    const data = loadGameData(DATA_DIR);
    data.items.items = data.items.items.filter(i => i.type !== 'ammo');
    expect(() => crossValidate(data)).toThrow(/ammo/);
  });

  it('loot моба ссылается на несуществующий itemId → ошибка', () => {
    const data = loadGameData(DATA_DIR);
    data.mobs.mobs[0].loot.guaranteed = { itemId: 'no_such_item', weight: 1 };
    expect(() => crossValidate(data)).toThrow(/no_such_item/);
  });

  it('отсутствующий i18n-ключ → ошибка', () => {
    const data = loadGameData(DATA_DIR);
    delete data.i18n.ru['item.sniper_rifle.name'];
    expect(() => crossValidate(data)).toThrow(/sniper_rifle/);
  });
});
