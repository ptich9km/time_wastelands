import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGameData, crossValidate } from '../server/schemas/loader';
import { loadI18n, setI18n, t } from '../server/i18n';

const DATA_DIR = path.resolve(__dirname, '..', 'data');

function makeTempI18nDir(ru: Record<string, string>, en: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-test-'));
  fs.mkdirSync(path.join(dir, 'i18n'));
  fs.writeFileSync(path.join(dir, 'i18n', 'ru.json'), JSON.stringify(ru));
  fs.writeFileSync(path.join(dir, 'i18n', 'en.json'), JSON.stringify(en));
  return dir;
}

describe('t()', () => {
  beforeEach(() => {
    setI18n({
      ru: { 'ui.stage1.ready': 'Этап 1 готов. Мир: {locations} локаций, {items} предметов, {mobs} мобов' },
      en: { 'ui.stage1.ready': 'Stage 1 is ready. World: {locations} locations, {items} items, {mobs} mobs' },
    });
  });

  it('подставляет параметры', () => {
    expect(t('ui.stage1.ready', 'ru', { locations: 12, items: 24, mobs: 12 }))
      .toBe('Этап 1 готов. Мир: 12 локаций, 24 предметов, 12 мобов');
  });

  it('возвращает [missing:key] для неизвестного ключа', () => {
    expect(t('no.such.key', 'ru')).toBe('[missing:no.such.key]');
  });
});

describe('crossValidate()', () => {
  it('принимает валидные данные из data/', () => {
    const data = loadGameData(DATA_DIR);
    expect(() => crossValidate(data)).not.toThrow();
  });

  it('ловит несуществующий mobId в spawnTable', () => {
    const data = loadGameData(DATA_DIR);
    data.world.locations[0].spawnTable.push({ mobId: 'no_such_mob', weight: 1, min: 0, max: 1 });
    expect(() => crossValidate(data)).toThrow(/no_such_mob/);
  });
});

describe('loadI18n()', () => {
  it('падает на разных наборах ключей', () => {
    const dir = makeTempI18nDir(
      { 'a.b': 'раз', 'c.d': 'два' },
      { 'a.b': 'one' },
    );
    expect(() => loadI18n(dir)).toThrow(/не совпадают/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('загружает совпадающие словари', () => {
    const dir = makeTempI18nDir(
      { 'a.b': 'раз' },
      { 'a.b': 'one' },
    );
    const dicts = loadI18n(dir);
    expect(dicts.ru['a.b']).toBe('раз');
    expect(dicts.en['a.b']).toBe('one');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
