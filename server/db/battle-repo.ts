// Stage 5a: battle repository — serialization of BattleState into SQLite.
// state_json never contains the log; the log lives in battle_log (append-only).

import type Database from 'better-sqlite3';
import {
  BattleStateSchema,
  type BattleState,
  type BattleLogEntry,
  type BattleStatus,
} from '../game/battle/state';
import type { BattleRewards } from '../game/battle/sync';

function stateToJson(state: BattleState): string {
  const { log: _log, ...rest } = state;
  return JSON.stringify(rest);
}

interface SessionRow {
  id: string;
  state_json: string;
}

interface LogRow {
  round: number;
  actor: string;
  type: BattleLogEntry['type'];
  text: string;
  created_at: string;
}

const SELECT_LOG_SQL =
  'SELECT round, actor, type, text, created_at FROM battle_log WHERE battle_id = ? ORDER BY id';

function insertLogEntry(db: Database.Database, battleId: string, entry: BattleLogEntry): void {
  db.prepare(
    'INSERT INTO battle_log (battle_id, round, actor, type, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(battleId, entry.round, entry.actor, entry.type, entry.text, entry.createdAt);
}

export function createBattle(db: Database.Database, state: BattleState): void {
  const run = db.transaction(() => {
    db.prepare(
      'INSERT INTO battle_sessions (id, character_id, status, state_json, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?)',
    ).run(state.id, state.status, stateToJson(state), state.createdAt, state.updatedAt);
    for (const entry of state.log) {
      insertLogEntry(db, state.id, entry);
    }
  });
  run();
}

function rowToState(db: Database.Database, row: SessionRow): BattleState {
  const parsed = JSON.parse(row.state_json) as Record<string, unknown>;
  const log = (db.prepare(SELECT_LOG_SQL).all(row.id) as LogRow[]).map((r) => ({
    round: r.round,
    actor: r.actor,
    type: r.type,
    text: r.text,
    createdAt: r.created_at,
  }));
  return BattleStateSchema.parse({ ...parsed, log });
}

export function getBattle(db: Database.Database, id: string): BattleState | null {
  const row = db
    .prepare('SELECT id, state_json FROM battle_sessions WHERE id = ?')
    .get(id) as SessionRow | undefined;
  return row ? rowToState(db, row) : null;
}

// Updates state_json/updated_at; the log is append-only: only entries beyond
// the already-saved count are inserted (state.log = everything so far + new).
export function updateBattleState(db: Database.Database, state: BattleState): void {
  const run = db.transaction(() => {
    const saved = db
      .prepare('SELECT COUNT(*) AS c FROM battle_log WHERE battle_id = ?')
      .get(state.id) as { c: number };
    db.prepare(
      `UPDATE battle_sessions SET state_json = ?, status = ?, updated_at = ? WHERE id = ?`,
    ).run(stateToJson(state), state.status, state.updatedAt, state.id);
    for (const entry of state.log.slice(saved.c)) {
      insertLogEntry(db, state.id, entry);
    }
  });
  run();
}

export function appendLog(
  db: Database.Database,
  battleId: string,
  entries: BattleLogEntry[],
): void {
  const run = db.transaction(() => {
    for (const entry of entries) {
      insertLogEntry(db, battleId, entry);
    }
  });
  run();
}

export function getActiveBattleForCharacter(db: Database.Database): BattleState | null {
  const row = db
    .prepare("SELECT id, state_json FROM battle_sessions WHERE character_id = 1 AND status = 'active'")
    .get() as SessionRow | undefined;
  return row ? rowToState(db, row) : null;
}

export function markFinished(
  db: Database.Database,
  id: string,
  result: Exclude<BattleStatus, 'active'>,
): void {
  const run = db.transaction(() => {
    const row = db
      .prepare('SELECT state_json FROM battle_sessions WHERE id = ?')
      .get(id) as { state_json: string } | undefined;
    if (!row) return;
    const parsed = JSON.parse(row.state_json) as Record<string, unknown>;
    parsed.status = result;
    parsed.result = result;
    parsed.phase = 'finished';
    db.prepare(
      `UPDATE battle_sessions SET status = ?, state_json = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(result, JSON.stringify(parsed), id);
  });
  run();
}

export interface BattleSyncStatus {
  syncedAt: string | null;
  rewards: BattleRewards | null;
}

interface SyncRow {
  synced_at: string | null;
  rewards_json: string | null;
}

export function getSyncStatus(db: Database.Database, id: string): BattleSyncStatus | null {
  const row = db
    .prepare('SELECT synced_at, rewards_json FROM battle_sessions WHERE id = ?')
    .get(id) as SyncRow | undefined;
  if (!row) return null;
  let rewards: BattleRewards | null = null;
  if (row.rewards_json) {
    try {
      rewards = JSON.parse(row.rewards_json) as BattleRewards;
    } catch {
      rewards = null;
    }
  }
  return { syncedAt: row.synced_at, rewards };
}

export function markSynced(
  db: Database.Database,
  id: string,
  rewards: BattleRewards,
): void {
  db.prepare(
    `UPDATE battle_sessions SET synced_at = ?, rewards_json = ? WHERE id = ?`,
  ).run(new Date().toISOString(), JSON.stringify(rewards), id);
}
