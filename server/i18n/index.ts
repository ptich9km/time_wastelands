import fs from 'node:fs';
import path from 'node:path';
import { I18nFileSchema, type I18nFile } from '../schemas/i18n';

export type Langs = { ru: I18nFile; en: I18nFile };
export type Lang = keyof Langs;

const LANGS: Lang[] = ['ru', 'en'];
const log = console;

export function loadI18n(dataDir: string): Langs {
  const result = {} as Record<Lang, I18nFile>;
  for (const lang of LANGS) {
    const file = path.join(dataDir, 'i18n', `${lang}.json`);
    result[lang] = I18nFileSchema.parse(
      JSON.parse(fs.readFileSync(file, 'utf8')),
    );
  }
  // наборы ключей должны совпадать во всех языках
  const [base, ...rest] = LANGS;
  const baseKeys = Object.keys(result[base]).sort();
  for (const lang of rest) {
    const keys = Object.keys(result[lang]).sort();
    const diff = [
      ...keys.filter(k => !result[base][k]),
      ...baseKeys.filter(k => !result[lang][k]),
    ];
    if (diff.length > 0) {
      throw new Error(
        `i18n: наборы ключей '${lang}' и '${base}' не совпадают:\n${diff.map(k => `  • ${k}`).join('\n')}`,
      );
    }
  }
  return { ru: result.ru, en: result.en };
}

let dictionaries: Langs | null = null;

export function setI18n(dicts: Langs): void {
  dictionaries = dicts;
}

export function t(
  key: string,
  lang: Lang,
  params?: Record<string, string | number>,
): string {
  if (!dictionaries) {
    throw new Error('i18n: словари не загружены (setI18n не вызван)');
  }
  let text = dictionaries[lang]?.[key];
  if (text === undefined) {
    log.warn(`[i18n] missing key: ${key} (${lang})`);
    return `[missing:${key}]`;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.split(`{${k}}`).join(String(v));
    }
  }
  return text;
}

export function getDictionary(lang: Lang): I18nFile {
  if (!dictionaries) {
    throw new Error('i18n: словари не загружены (setI18n не вызван)');
  }
  return dictionaries[lang];
}

export function getLangs(): Lang[] {
  return [...LANGS];
}
