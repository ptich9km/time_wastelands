# Repository notes

## Source of truth
- `README.md` stops at stage 5d-fix and is stale for battle (still mentions polling and a removed test button). Current contracts are `spec-06a.txt`, `spec-06b.txt`, `spec-06b-fix.txt`, `spec-07.txt` and `spec-08.txt`; executable code wins over prose.
- No bundler: `client/` is served as static ES modules by `server/index.ts`. `npm run build` is only `tsc --noEmit` — no JS is emitted.
- No lint, formatter, CI, pre-commit, or `opencode.json` config exists here.

## Commands
```bash
npm i
npm run validate-data
npm run validate-i18n
npx tsc --noEmit          # same as npm run build
npm test                  # vitest run, all suites
npx vitest run tests/stage6a.test.ts
npx vitest run server/game/battle/__tests__/engine.test.ts
find client/js -name '*.js' -exec node --check {} \;
```
- Tests are self-contained: Fastify listens on port 0 and DBs are in-memory; no running server or seeded DB needed.
- `npm run sim` runs 10k battle simulations; its balance warnings are informational, not test failures.
- `tsconfig.json` includes only `server` and `tests`; client JS is not typechecked, so syntax-check touched client files manually.

## Data and i18n
- `data/*.json` and `data/config/battle.json` are Zod-validated at server startup; invalid data exits the process.
- `data/i18n/ru.json` and `en.json` must have identical key sets. Add every new user-facing string to both.
- Server calls `setI18n()` at boot; the client caches its dictionary and refreshes it only on `setLang()` (startup or language switch). After editing i18n/data, restart `npm run dev` and hard-reload the browser.
- `npm run validate-data` currently prints two expected non-fatal `institute_9` `levelRange` warnings; do not “fix” them unless asked.

## Runtime and DB
- `server/index.ts` is the real entry: load data/i18n → open DB → register REST + WS routes → serve `client/` statically on fixed port 3000.
- Only one character exists (`id = 1`) in `game.db` (WAL mode). Tests use `:memory:`.
- `openDb()` applies explicit migrations for `battle_sessions.synced_at` and `rewards_json`; `CREATE TABLE IF NOT EXISTS` alone will not add columns to old DBs.

## Battle wiring
- REST: `/api/battle/start`, `/api/battle/:id/action`, `/api/battle/:id/abandon`, `/api/battle/:id/highlight`. WS: `/ws/battle/:id?lang=ru|en` emits `state`, `update`, `end`.
- Post-battle HP/XP/loot/ammo sync is server-side in `server/game/battle/sync.ts`; do not duplicate it in the client.
- Stage 6b work is client-only except i18n keys. Do not rewrite WS, sync, or engine for UI/polish tasks.
- Client router is `client/js/main.js` (create / character / map / location / inventory / battle-map) and keeps the `?battle=<id>` deep link.
- `client/index.html` loads `style.css` then `battle.css`, then `main.js` as a module.
- Battle animations/sounds are derived from WS state diffs in `detectEffects()` (`client/js/screens/battle-map.js`). No HP/log delta means no effect by design. The result overlay is deliberately delayed ~900 ms so the hit/death animation and HP-bar transition remain visible.
- `client/js/battle/hex.js` is a manual port of server `hex.ts` / `los.ts`; keep both in sync when touching movement or LOS.
- The character screen still has the dev-only “Начать тестовый бой” button (`startTestBattle()`), despite comments claiming it was removed in stage 6.
- Out-of-battle healing is outside the battle stack: `POST /api/character/rest`, `/api/character/heal`, `POST /api/inventory/use` (`spec-06b-fix.txt`). `characters.last_rest_at` also needs the explicit migration in `openDb()` for old DBs.

## Stage 7 (spawn / encounters)
- `server/game/world/spawn.ts` (`rollEncounter`) needs `mobs` passed in — the spec signature omits it, but the level/tags/elite checks are impossible without it.
- `POST /api/travel` returns `battle: BattleState | null`; on encounter the battle is created before `location_id` updates, and an active battle yields 409 `battle_already_active`.
- Elite mobs: `Participant.isElite` carries boosted HP, but the engine looks mobs up by `refId`, so `service.ts` (`mobsForEngine`) feeds elite-adjusted definitions to `applyAction`/`runEnemyTurn` — the engine itself is untouched. Rare-loot bonus in `sync.ts` is gated on `participant.isElite`.
- `markRespawn` stores ISO timestamps; older `world_state.respawn_at` rows use SQLite `datetime('now')` — parse both as UTC (see `parseDbTime` in spawn.ts / location.js).
- `MOB_SPAWNS` in `battle/start.ts` covers 5 mobs (pack encounters); `POST /api/battle/start` still caps manual starts at 3.
- Test gotcha: a constant `Math.random` mock hangs `rollObstacles` (same hex forever) — use a cycling mock; `tests/stage3.test.ts` pins `0.999` to keep travel tests encounter-free.

## Stage 8 (economy / shops / NPCs)
- `data/shops.json` + `data/npcs.json` are Zod-validated and cross-validated in `loader.ts` (shopId/npcId refs, shop location must be `city`, stock itemIds, all NPC/shop i18n keys).
- `shop_state` table: stock/inflation/trend per shop item; `restockIfNeeded` resets it every 15 real minutes (one game day) and picks one random trend item. Rows written before stage 8 use SQLite `datetime('now')` — parse as UTC.
- `getSellPrice` uses `Math.floor`, not the spec's `round` — the acceptance example sells rat_pelt (base 15) for 7.
- Shop/NPC logic lives in `server/game/economy/{shop,npc}.ts`; REST in `server/api/{shop,npc}.ts`. Buying requires the character to stand in the shop's city; begging requires money < 20 AND hp < 30% (checked before the 24h `meta.last_beggar_at` cooldown).
- `GET /api/location/:id` now returns `shopId`/`npcIds`; the shop screen is `client/js/screens/shop.js` (route `'shop'` in main.js), NPC dialog is a modal in `location.js`.

## Repo state
- This working copy is currently not a git repository (`git status` will fail until `git init`). `.gitignore` exists with only `import/`.
- `import/` holds original-game assets and is ignored; do not add or commit it.
