import path from 'node:path';
import { loadGameData } from '../schemas/loader';

try {
  loadGameData(path.resolve('data'));
  console.log('✅ data/ — валидно');
  process.exit(0);
} catch (err) {
  console.error('Ошибки валидации:\n' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
