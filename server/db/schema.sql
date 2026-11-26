-- Stage 1: service table meta.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Stage 2: character (single-player — exactly one row, id = 1).
-- IMPORTANT: "end" is a potentially reserved word, ALWAYS in double quotes.
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 20),
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  str INTEGER NOT NULL DEFAULT 3,
  agi INTEGER NOT NULL DEFAULT 3,
  int INTEGER NOT NULL DEFAULT 3,
  "end" INTEGER NOT NULL DEFAULT 3,
  per INTEGER NOT NULL DEFAULT 0,
  intel INTEGER NOT NULL DEFAULT 0,
  hp_current INTEGER NOT NULL,
  hp_max INTEGER NOT NULL,
  ap_max INTEGER NOT NULL,
  money INTEGER NOT NULL DEFAULT 50,
  location_id TEXT NOT NULL,
  -- Stage 06b-fix: last out-of-battle rest timestamp (ISO string).
  last_rest_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (str >= 1 AND str <= 50),
  CHECK (agi >= 1 AND agi <= 50),
  CHECK (int >= 1 AND int <= 50),
  CHECK ("end" >= 1 AND "end" <= 50),
  CHECK (per >= 0 AND per <= 50),
  CHECK (intel >= 0 AND intel <= 50),
  CHECK (hp_current >= 0 AND hp_current <= hp_max),
  CHECK (ap_max >= 15),
  CHECK (money >= 0)
);

-- Stage 3: world state per location (fog of war, future mob respawns).
-- Rows are created lazily: on first visit, or for neighbors of a visited
-- location (last_visited_at IS NULL = revealed but never visited).
CREATE TABLE IF NOT EXISTS world_state (
  location_id TEXT PRIMARY KEY,
  respawn_at TEXT NOT NULL,            -- ISO datetime when mobs respawn here
  last_visited_at TEXT,                -- NULL = never visited (fog of war)
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stage 4b: inventory and equipment (single-player — character_id = 1).
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL DEFAULT 1 CHECK (character_id = 1),
  item_id TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 1),
  equipped_slot TEXT,                  -- NULL = not equipped; "weapon" | "head" | "torso" | "jacket" | "legs" | "boots"
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_inventory_character ON inventory(character_id);
CREATE INDEX IF NOT EXISTS idx_inventory_character_slot ON inventory(character_id, equipped_slot);
CREATE INDEX IF NOT EXISTS idx_inventory_character_item ON inventory(character_id, item_id);
-- One slot — one item (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_slot ON inventory(character_id, equipped_slot)
  WHERE equipped_slot IS NOT NULL;

-- Stage 5a: battle state. Log is stored separately (battle_log), so state_json
-- never contains the log — only state_json was updated by updateBattleState.
CREATE TABLE IF NOT EXISTS battle_sessions (
  id TEXT PRIMARY KEY,                       -- uuid v4
  character_id INTEGER NOT NULL DEFAULT 1 CHECK (character_id = 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'victory', 'defeat', 'fled')),
  state_json TEXT NOT NULL,                  -- BattleState without log
  synced_at TEXT NULL,                       -- stage 6a: post-battle sync timestamp
  rewards_json TEXT NULL,                    -- stage 6a: persisted rewards for idempotent reads
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_battle_sessions_character_status ON battle_sessions(character_id, status);
-- A character can have only one active battle.
CREATE UNIQUE INDEX IF NOT EXISTS uq_battle_sessions_active ON battle_sessions(character_id)
  WHERE status = 'active';

-- Stage 8: per-shop stock, purchase-driven inflation and the daily trend.
-- trend/restocked_at refresh once per game day (15 real-time minutes).
CREATE TABLE IF NOT EXISTS shop_state (
  shop_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  inflation REAL NOT NULL DEFAULT 0,   -- 0..50, accumulates from purchases
  trend INTEGER NOT NULL DEFAULT 0,    -- 1 = "trend of the day" (sell 70%), 0 = normal (50%)
  restocked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (shop_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_shop_state_shop ON shop_state(shop_id);

CREATE TABLE IF NOT EXISTS battle_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('hit','miss','crit','info','system','flee','death','heal')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (battle_id) REFERENCES battle_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_battle_log_battle ON battle_log(battle_id, id);
