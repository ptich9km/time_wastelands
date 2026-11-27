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

## Art generation (user rule)
- When asking an image model for art here, always request a game sprite sheet / atlas, never an illustration or poster. Explicitly forbid small and narrow elements (chains, wires, thin barrels, thin branches, micro bolts); require chunky silhouettes that survive 32×32 / 48×48 / 128×128.
- Kimi atlases: 2048×2048 PNG, flat magenta `#FF00FF` chroma key, fixed grid, no text/labels/shadows/grid lines. Transparent PNG is produced by cutting the keyed background with `art_extraction/tools/sprite_tools.py`, not by trusting model alpha.
- Prompt set and data-to-panel mapping: `art_extraction/05-kimi-atlas-prompts.md`. Pipeline and failure cases: `art_extraction/01-pipeline.md` — `04-toolbox.md`. No art-generation skill is installed in this repo.

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

## Stage 8-fix (army tags currency lore)
- UI currency is «Армейские жетоны» / «Army tags» — i18n values only; `characters.money`, shop API and prices are untouched. `item.old_coin` strings stay as they are (an item, not currency).
- `army_tag` is a misc ITEM (price 1, tag `currency`), not code-level money. Note: selling it yields `floor(1×0.5) = 0` — kept as spec'd (price 1).
- Mob loot: `loot.guaranteed` is a SINGLE object, so humans (rust_digger, both bandits, bandit_shooter) carry army_tag as a rare entry with `weight 100` (= always); animals 30–50%, spores 10–20%. `battle.log.loot_army_tag` exists as an i18n key but is not wired into sync.ts (spec: no code changes).

## Stage 9 (progression / weapon skills)
- `data/level_table.json` is the actual TimeZero-Rebirth table (v2.0) with cumulative `perkPoints` (0..9); `superRefine` enforces `apMax = 15+2×end`, `hpMax = 50+5×end`.
- `applyLevelUp` REPLACES `perk_points` with `row.perkPoints` (cumulative, not `+=`); `sync.ts` persists it via `updateCharacter`.
- `characters.perk_points` is added by an explicit migration in `openDb()`; `weapon_skills (character_id, weapon_category, skill, hits)` lives in `schema.sql`. Perk points are display-only until v0.2.
- `server/game/entities/weapon-skill.ts`: skill +1 per 10 successful player attacks (`hits` counter), clamp 0–100. Spec text also says "max skill = character.level" but its own acceptance tests clamp at 100 — the code follows the tests (cap 100).
- Engine stays pure: `applyAction` returns `weaponCategoryHit` on a player hit/crit and accepts `weaponSkillBonus` (0–10, additive in `hitChance`); `service.ts` reads the skill from DB, passes the bonus, and calls `incrementWeaponSkill` after a hit. Mob shots never touch skills.
- `GET /api/character` returns `character` with `perk_points` and `weaponSkills: [{weaponCategory, skill, hits}]` (lazy zeros for pre-stage-9 characters).

## Stage 10a (balance)
- `battle.json`: `per.rangeBonusPerPoint = 10` (effectiveRange used by both hit curve and sniper plateau), `armor.diminishingAfter = 50` / `diminishingFactor = 0.5` (80 → 65), `healLimit.startMult = 1.2`.
- `buildBattleState` takes an optional final `BattleConfig` arg; production routes pass `app.gameData.battleConfig`, tests without it load config from `data/`. Heal cap is `floor(hpMax × startMult)`, regen `floor(hpMax × regenPerRoundMult)`.
- `server/scripts/sim.ts` is now a full engine simulation (`applyAction` + `runEnemyTurn`, move/shoot/endTurn) with 1000 fights per scenario by default; `SIM_BATTLES` overrides. Observed (1000 fights): 1v1 100%, 1v3 100%, hulk 0.1%; warnings only — no data tuning allowed by spec.

## Stage 10b (polish)
- README.md is the final version (fan-made disclaimer, 3-command launch, stage-10 balance notes).
- `sync.ts` logs `battle.log.loot_army_tag` (with `{mob}`) when `army_tag` is actually in rewards; key exists in both RU/EN dictionaries.
- `spec-10b.txt` is truncated mid-sentence after "3 команды до игры:" — implemented the remaining listed tasks from its title/README context; no literal 30-minute manual session was possible, replaced by HTTP smoke + full test suite.

## Repo state
- This is a git repository (branch `master`, remote `origin` → github.com/ptich9km/time_wastelands). `.gitignore`: `import/`, `node_modules/`, `game.db*`. Commit only when the user explicitly asks; commit messages in English.
- `import/` holds original-game assets and is ignored; do not add or commit it.
