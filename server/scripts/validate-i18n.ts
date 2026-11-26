import path from 'node:path';
import { loadI18n } from '../i18n';

try {
  const dicts = loadI18n(path.resolve('data'));
  console.log(`✅ i18n — валидно (ru: ${Object.keys(dicts.ru).length}, en: ${Object.keys(dicts.en).length} ключей)`);
  process.exit(0);
} catch (err) {
  console.error('Ошибки валидации i18n:\n' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
