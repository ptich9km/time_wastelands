import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { WorldFileSchema, type WorldFile } from './world';
import { ItemsFileSchema, type ItemsFile } from './items';
import { MobsFileSchema, type MobsFile } from './mobs';
import { BattlePhrasesFileSchema, type BattlePhrasesFile } from './battle_phrases';
import { I18nFileSchema, type I18nFile } from './i18n';
import { BattleConfigSchema, type BattleConfig } from './battle_config';
import { LevelTableSchema, type LevelTable } from './level_table';
import { ShopsFileSchema, type ShopsFile } from './shops';
import { NpcsFileSchema, type NpcsFile } from './npcs';

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map(i => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

export type GameData = {
  world: WorldFile;
  items: ItemsFile;
  mobs: MobsFile;
  phrases: BattlePhrasesFile;
  i18n: { ru: I18nFile; en: I18nFile };
  battleConfig: BattleConfig;
  levelTable: LevelTable;
  shops: ShopsFile;
  npcs: NpcsFile;
};

export function loadGameData(dataDir: string): GameData {
  const world = WorldFileSchema.parse(readJson(path.join(dataDir, 'world.json')));
  const items = ItemsFileSchema.parse(readJson(path.join(dataDir, 'items.json')));
  const mobs = MobsFileSchema.parse(readJson(path.join(dataDir, 'mobs.json')));
  const phrases = BattlePhrasesFileSchema.parse(readJson(path.join(dataDir, 'battle_phrases.json')));
  const ru = I18nFileSchema.parse(readJson(path.join(dataDir, 'i18n', 'ru.json')));
  const en = I18nFileSchema.parse(readJson(path.join(dataDir, 'i18n', 'en.json')));
  const battleConfig = BattleConfigSchema.parse(readJson(path.join(dataDir, 'config', 'battle.json')));
  const levelTable = LevelTableSchema.parse(readJson(path.join(dataDir, 'level_table.json')));
  const shops = ShopsFileSchema.parse(readJson(path.join(dataDir, 'shops.json')));
  const npcs = NpcsFileSchema.parse(readJson(path.join(dataDir, 'npcs.json')));

  crossValidate({ world, items, mobs, phrases, i18n: { ru, en }, battleConfig, levelTable, shops, npcs });
  return { world, items, mobs, phrases, i18n: { ru, en }, battleConfig, levelTable, shops, npcs };
}

export function crossValidate(data: GameData): void {
  const errors: string[] = [];
  const itemIds = new Set(data.items.items.map(i => i.id));
  const mobIds = new Set(data.mobs.mobs.map(m => m.id));
  const i18nLangs = Object.keys(data.i18n) as ('ru' | 'en')[];

  // 1. Спавн ссылается на существующих мобов
  for (const loc of data.world.locations) {
    for (const s of loc.spawnTable) {
      if (!mobIds.has(s.mobId)) {
        errors.push(`world.${loc.id}.spawnTable: неизвестный mobId ${s.mobId}`);
      }
    }
  }

  // 2. Лут мобов ссылается на существующие предметы
  for (const mob of data.mobs.mobs) {
    const all = [
      ...(mob.loot.guaranteed ? [mob.loot.guaranteed] : []),
      ...mob.loot.rare,
    ];
    for (const entry of all) {
      if (!itemIds.has(entry.itemId)) {
        errors.push(`mobs.${mob.id}.loot: неизвестный itemId ${entry.itemId}`);
      }
    }
  }

  // 2b. Для каждого weapon.ammoType есть ammo-предмет этого типа
  const ammoTypes = new Set(
    data.items.items.flatMap(i => (i.type === 'ammo' ? [i.ammoType] : [])),
  );
  for (const item of data.items.items) {
    if (item.type === 'weapon' && item.ammoType && !ammoTypes.has(item.ammoType)) {
      errors.push(`items.${item.id}: нет ammo-предмета типа ${item.ammoType}`);
    }
  }

  // 2c. Предупреждение: моб спавнится в локации, чей levelRange не покрывает его уровень
  const mobById = new Map(data.mobs.mobs.map(m => [m.id, m]));
  for (const loc of data.world.locations) {
    const [min, max] = loc.levelRange;
    for (const s of loc.spawnTable) {
      const mob = mobById.get(s.mobId);
      if (mob && mob.level > 1 && (mob.level < min || mob.level > max)) {
        console.warn(`⚠️  world.${loc.id}: моб ${mob.id} (ур. ${mob.level}) вне levelRange [${min}, ${max}]`);
      }
    }
  }

  // 3. Все i18n-ключи из данных присутствуют во всех языках
  const requiredKeys = new Set<string>();
  for (const loc of data.world.locations) {
    requiredKeys.add(loc.nameKey);
    requiredKeys.add(loc.descriptionKey);
    loc.ambientKeys.forEach(k => requiredKeys.add(k));
  }
  for (const item of data.items.items) {
    requiredKeys.add(item.nameKey);
    requiredKeys.add(item.descriptionKey);
  }
  for (const mob of data.mobs.mobs) {
    requiredKeys.add(mob.nameKey);
    if (mob.descriptionKey) requiredKeys.add(mob.descriptionKey);
  }
  for (const shop of data.shops.shops) {
    requiredKeys.add(shop.nameKey);
  }
  for (const npc of data.npcs.npcs) {
    requiredKeys.add(npc.nameKey);
    npc.dialogueKeys.forEach((k) => requiredKeys.add(k));
    npc.rumorKeys.forEach((k) => requiredKeys.add(k));
  }

  for (const lang of i18nLangs) {
    const dict = data.i18n[lang];
    for (const key of requiredKeys) {
      if (!dict[key]) errors.push(`i18n.${lang}: отсутствует ключ ${key}`);
    }
  }

  // 4. Фразы боя: все варианты во всех языках + все плейсхолдеры
  for (const [category, cfg] of Object.entries(data.phrases.categories)) {
    for (let i = 1; i <= cfg.minVariants; i++) {
      const key = `${category}.${i}`;
      for (const lang of i18nLangs) {
        const text = data.i18n[lang][key];
        if (!text) {
          errors.push(`i18n.${lang}: отсутствует фраза ${key}`);
          continue;
        }
        for (const ph of cfg.placeholders) {
          if (!text.includes(`{${ph}}`)) {
            errors.push(`i18n.${lang}: фраза ${key} не содержит {${ph}}`);
          }
        }
      }
    }
  }

  // 5. Level table covers levels 1..10 without gaps; mob levels within 1..10
  const levelsPresent = new Set(data.levelTable.levels.map((l) => l.level));
  for (let lvl = 1; lvl <= 10; lvl++) {
    if (!levelsPresent.has(lvl)) {
      errors.push(`level_table: нет строки для уровня ${lvl}`);
    }
  }
  for (const mob of data.mobs.mobs) {
    if (mob.level > 10) {
      console.warn(`⚠️  mobs.${mob.id}: level ${mob.level} выше 10 — вне level_table`);
    }
  }

  // 6. Stage 8: shops and NPCs cross-references
  const locById = new Map(data.world.locations.map((l) => [l.id, l]));
  const shopIds = new Set(data.shops.shops.map((s) => s.id));
  const npcIds = new Set(data.npcs.npcs.map((n) => n.id));

  for (const loc of data.world.locations) {
    if (loc.shopId && !shopIds.has(loc.shopId)) {
      errors.push(`world.${loc.id}: неизвестный shopId ${loc.shopId}`);
    }
    for (const npcId of loc.npcIds) {
      if (!npcIds.has(npcId)) {
        errors.push(`world.${loc.id}: неизвестный npcId ${npcId}`);
      }
    }
  }
  for (const shop of data.shops.shops) {
    const loc = locById.get(shop.locationId);
    if (!loc) {
      errors.push(`shops.${shop.id}: неизвестная locationId ${shop.locationId}`);
    } else if (loc.type !== 'city') {
      errors.push(`shops.${shop.id}: locationId ${shop.locationId} не city (type=${loc.type})`);
    }
    for (const entry of shop.stock) {
      if (!itemIds.has(entry.itemId)) {
        errors.push(`shops.${shop.id}.stock: неизвестный itemId ${entry.itemId}`);
      }
    }
  }
  for (const npc of data.npcs.npcs) {
    if (!locById.has(npc.locationId)) {
      errors.push(`npcs.${npc.id}: неизвестная locationId ${npc.locationId}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Ошибки валидации данных (${errors.length}):\n${errors.join('\n')}`,
    );
  }
}
