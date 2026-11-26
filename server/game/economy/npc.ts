// Stage 8: NPC dialogue (random line + rumor) and begging.

import type Database from 'better-sqlite3';
import type { Npc } from '../../schemas/npcs';
import { getCharacter, updateCharacter, type CharacterRow } from '../../db/character-repo';
import { t, type Lang } from '../../i18n';

export interface NpcDialog {
  line: string;
  rumor?: string;
}

function pick<T>(items: T[], rng: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}

export function getNpcDialog(npc: Npc, lang: Lang, rng: () => number = Math.random): NpcDialog {
  const dialog: NpcDialog = { line: t(pick(npc.dialogueKeys, rng), lang) };
  if (npc.rumorKeys.length > 0) {
    dialog.rumor = t(pick(npc.rumorKeys, rng), lang);
  }
  return dialog;
}

const BEGGAR_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const BEGGAR_MONEY_LIMIT = 20;
const BEGGAR_HP_PCT = 0.3;
const BEGGAR_MONEY_GAIN = 10;
const BEGGAR_HP_GAIN = 20;

export type BeggarResult =
  | { ok: true; character: CharacterRow; received: { money: number; hp: number } }
  | { ok: false; error: 'no_character' | 'not_eligible' | 'already_begged' };

function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

export function beggar(db: Database.Database, now: number = Date.now()): BeggarResult {
  const character = getCharacter(db);
  if (!character) return { ok: false, error: 'no_character' };

  const eligible =
    character.money < BEGGAR_MONEY_LIMIT &&
    character.hp_current < character.hp_max * BEGGAR_HP_PCT;
  if (!eligible) return { ok: false, error: 'not_eligible' };

  const lastBeggedAt = getMeta(db, 'last_beggar_at');
  if (lastBeggedAt) {
    const elapsed = now - Date.parse(lastBeggedAt);
    if (Number.isFinite(elapsed) && elapsed < BEGGAR_COOLDOWN_MS) {
      return { ok: false, error: 'already_begged' };
    }
  }

  const updated = updateCharacter(db, {
    id: 1,
    money: character.money + BEGGAR_MONEY_GAIN,
    hp_current: Math.min(character.hp_max, character.hp_current + BEGGAR_HP_GAIN),
  });
  setMeta(db, 'last_beggar_at', new Date(now).toISOString());
  return {
    ok: true,
    character: updated,
    received: { money: BEGGAR_MONEY_GAIN, hp: BEGGAR_HP_GAIN },
  };
}
