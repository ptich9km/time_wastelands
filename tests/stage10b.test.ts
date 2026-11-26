// Stage 10b: final polish — army tag lore log, tooltip keys, palette, README.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { loadGameData } from '../server/schemas/loader';
import { loadI18n, setI18n, t } from '../server/i18n';
import { openDb } from '../server/db';
import { createCharacter, getCharacter } from '../server/game/entities/character';
import { buildBattleState } from '../server/game/battle/start';
import { syncAfterBattle } from '../server/game/battle/sync';

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const gameData = loadGameData(DATA_DIR);
const dicts = loadI18n(DATA_DIR);
setI18n(dicts);
const cfg = gameData.battleConfig;

function makeDb() {
  const db = openDb(':memory:');
  createCharacter(db, {
    name: 'Полировка',
    startLocationId: gameData.world.startLocationId,
    items: gameData.items.items,
  });
  return db;
}

describe('battle.log.loot_army_tag', () => {
  it('появляется в логе, когда жетон реально выпал', () => {
    const db = makeDb();
    const rat = gameData.mobs.mobs.find((m) => m.id === 'pipe_rat')!;
    const state = buildBattleState(
      db,
      gameData.world,
      getCharacter(db)!,
      [rat],
      'ru',
      gameData.items.items,
      [false],
      cfg,
    );
    const mob = state.participants.find((p) => p.kind === 'mob')!;
    mob.hp = 0;
    const victory = { ...state, status: 'victory' as const, phase: 'finished' as const };
    const result = syncAfterBattle({
      db,
      state: victory,
      items: gameData.items.items,
      mobs: gameData.mobs.mobs,
      config: cfg,
      levelTable: gameData.levelTable,
      world: gameData.world,
      lang: 'ru',
      rng: () => 0.2, // medkit (1%) не выпадает, army_tag (40%) выпадает
    });
    expect(result.rewards.loot).toContainEqual({ itemId: 'army_tag', qty: 1 });
    const expected = t('battle.log.loot_army_tag', 'ru', { mob: t(rat.nameKey, 'ru') });
    expect(result.logEntries.some((entry) => entry.text === expected)).toBe(true);
  });

  it('RU и EN ключи содержат подстановку {mob}', () => {
    expect(dicts.ru['battle.log.loot_army_tag']).toContain('{mob}');
    expect(dicts.en['battle.log.loot_army_tag']).toContain('{mob}');
  });
});

describe('тултипы и палитра', () => {
  it('тултип жетонов есть в обоих словарях и используется в UI', () => {
    expect(dicts.ru['ui.character.money_tooltip']).toBeTruthy();
    expect(dicts.en['ui.character.money_tooltip']).toBeTruthy();
    const character = fs.readFileSync(path.join(ROOT, 'client/js/screens/character.js'), 'utf8');
    const shop = fs.readFileSync(path.join(ROOT, 'client/js/screens/shop.js'), 'utf8');
    expect(character).toContain("t('ui.character.money_tooltip')");
    expect(shop).toContain("t('ui.character.money_tooltip')");
  });

  it('CSS задаёт финальную палитру', () => {
    const css = fs.readFileSync(path.join(ROOT, 'client/css/style.css'), 'utf8');
    for (const color of ['#1a1614', '#2a2420', '#3a322c', '#d4c9b8', '#c9a227', '#a83232']) {
      expect(css, color).toContain(color);
    }
  });
});

describe('README', () => {
  it('финальный: заголовок, дисклеймер и 3 команды', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    expect(readme.startsWith('# Пустошь: Ржавый Предел')).toBe(true);
    expect(readme).toContain('TimeZero / TimeZero-Rebirth');
    expect(readme).toContain('Не для публикации или монетизации');
    expect(readme.indexOf('npm i')).toBeLessThan(readme.indexOf('npm run dev'));
    expect(readme).toContain('http://localhost:3000');
  });
});
