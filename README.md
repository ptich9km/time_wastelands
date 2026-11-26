# Пустошь: Ржавый Предел

Локальная браузерная постапокалиптическая RPG (2D, DOM, без 3D). Fan-made проект, не аффилировано с TimeZero.

## Запуск — 3 команды

```bash
npm i
npm run validate-data
npm run dev
```

Открыть http://localhost:3000

## Скрипты

| Команда | Что делает |
|---|---|
| `npm run dev` | Запуск сервера на порту 3000 (tsx watch) |
| `npm run validate-data` | Проверка data/*.json: схемы Zod + кросс-валидация |
| `npm run validate-i18n` | Проверка совпадения наборов ключей ru/en |
| `npm test` | Юнит-тесты (vitest) |

## Стек

Node.js 20 + Fastify + better-sqlite3 + Zod, клиент — Vanilla JS (ES-модули) + HTML/CSS. Без сборщиков.

## Структура

- `server/` — Fastify, загрузчик данных, i18n, SQLite (WAL), API персонажа и мира (`server/api/`, `server/game/entities/`, `server/game/world/`, `server/db/`)
- `client/` — статика: `index.html`, `css/`, `js/`, экраны `js/screens/`
- `data/` — world/items/mobs/battle_phrases/i18n (валидируются при старте; битые данные = сервер не стартует)

## Этап 2 — персонаж

- Таблица `characters` (одна запись, `id = 1`), статы фиксированные 3/3/3/3/0/0, HP 65, ОД 21, деньги 50, стартовая локация из `world.startLocationId`.
- `GET /api/character` → 200 `{ character }` | 404 `{ error: "no_character" }`.
- `POST /api/character` `{ name }` → 201 | 400 `invalid_name` | 409 `character_exists`. Статы от клиента игнорируются.

## Этап 3 — карта мира, туман войны, локации, переходы

- Таблица `world_state` (ленивые строки на локацию; `last_visited_at IS NULL` = открыта, но не посещена). При старте сервер удаляет строки локаций, которых нет в `world.json`.
- Туман войны: видны текущая локация, её соседи и все когда-либо посещённые.
- `GET /api/world` → `{ locations, visible, current }` (без description/ambients/art/spawn).
- `GET /api/location/:id` → 200 (с 2–3 случайными `ambientKeys`) | 403 `not_visible` | 404 `unknown_location`.
- `POST /api/travel` `{ to }` → 200 `{ character, fromLocationId, toLocationId }` | 400 `no_character` / `not_adjacent` / `no_connection` / `unknown_location`. Переход мгновенный; `baseTimeMs` (дорога 900мс / пустошь 1500мс) — только для клиентской анимации.
- Клиент: экраны `map.js` (сетка 20×20, туман, пульс текущей локации) и `location.js` (описание, атмосфера, выходы), роутинг в `main.js` (character / map / location).

## Шаг 4b — инвентарь и экипировка

- Таблица `inventory` (character_id=1, `equipped_slot`, partial unique index «один слот — один предмет»).
- Стартовый набор при создании персонажа (транзакционно): ржавая труба и кожаная куртка надеты, аптечка ×2. Одноразовый backfill для старых сохранений (`meta.starter_kit_granted`).
- `GET /api/inventory` → `{ items, equipped, capacity }` (вес считается, не ограничивает; maxSlots=20, maxWeight=1000×STR).
- `POST /api/inventory/equip` / `unequip` → 200 `{ equipped, inventory }` | 400 `not_found` / `not_equippable` / `requirements_not_met` (+`missing` с `{need, have}`).
- Клиент: экран инвентаря (слоты экипировки, сетка предметов, панель деталей, редкость цветом), блок «Экипировка» на экране персонажа.

## Шаг 5a — боевое состояние (BattleState) и сериализация

- `server/game/battle/state.ts` — Zod-схемы: `BattleState`, `Participant`, `BattleLogEntry`, `BattleMap`, `Equipment`, `Effect` и т.д. (hex axial, facing 0–5, healLimit).
- Таблицы `battle_sessions` (state_json без лога; partial unique — один активный бой на персонажа) и `battle_log` (append-only, отдельная таблица).
- `server/db/battle-repo.ts` — `createBattle`, `getBattle`, `updateBattleState` (лог дописывается без дублей), `appendLog`, `getActiveBattleForCharacter`, `markFinished`.
- `POST /api/battle/start { mobIds: [1..3] }` → 201 `{ battleId, state }` | 400 `invalid_mob_ids` / `unknown_mob` / `too_hard` | 409 `battle_already_active`. Карта 10×10, 3–4 случайных препятствия вне точек спавна; лог пишется через `t()` на языке `?lang=` (ru по умолчанию).
- `GET /api/battle/:id`, `GET /api/battle/active` — state с логом.

## Шаг 5b — формулы боя

- `data/config/battle.json` — все константы формул (hit/damage/armor/penetration/distance/xp/healLimit); валидация `BattleConfigSchema` при загрузке, битый конфиг = сервер не стартует.
- `data/level_table.json` — уровни 1–10 (hpMax=50+5×end, apMax=15+2×end проверяются схемой); `gameData.levelTable`.
- `server/game/battle/formulas.ts` — чистые функции с инъекцией RNG: `hitChance` (point-blank, зоны, дистанция, позиции, укрытие, снайперское плато), `rollDamage`, `rollCrit`, `applyCrit`, `armorAbsorb`, `damageAfterArmor`, `rollPenetration`, `damageWithPenetration`, `damageOutsideRange`, `xpForKill`, `xpToNextLevel`, `applyLevelUp` (HP восстанавливается при левелапе).
- `npm run sim` — симуляция 10 000 боёв (1v1, 1v3, vs rust_hulk); выводит winrate и предупреждения при выходе за целевые рамки (не падает).

## Шаг 5c — гекс-карта: математика, LOS, SVG-рендер

- `server/game/battle/hex.ts` — чистая axial-математика (pointy-top): cube-конверсия, `hexDistance`, соседи (E/NE/NW/W/SW/SE), `hexToPixel`/`pixelToHex` (cube-round), углы для `<polygon>`. Координаты карты в BattleState — axial `{q,r}`, границы карты: `0<=q<width`, `0<=r<height`.
- `server/game/battle/los.ts` — `hasLineOfSight` (cube-lerp + cube-round с epsilon-сдвигом; `from`/`to` сами не блокируют; crate с `blocksLos:false` не мешает; выход за карту → false), `canMoveTo` (out_of_bounds/blocked/occupied/not_adjacent), `reachableHexes` (BFS, для подсветки в 5d).
- `client/js/battle/hex.js` — JS-порт hex-математики и LOS для клиента (клиент без сборки, TS не импортирует; держать в синхроне с сервером).
- `client/js/battle/hex-render.js` — SVG-рендер карты: препятствия по типам, подсветка reachable/los/selected/hover, участники (@/первая буква имени моба, HP-бар 20×2, иконка позы). Hover — без перестройки SVG (иначе mouseover-цикл).
- `client/js/screens/battle-map.js` — экран «Карта боя»: карта, список участников, лог (последние 20), polling 2 с до WebSocket (этап 6). Клик по мобу — подсветка гексов с LOS от игрока; клик по гексу — selected. Действий нет (5d).
- main.js: роутинг `battle-map`, deep-link `?battle=<id>` (переживает перезагрузку), временная кнопка «Начать тестовый бой» на экране персонажа (pipe_rat; при 409 — переход в активный бой). Убирается на этапе 6.

## Шаг 5d — действия в бою

- `server/game/battle/actions.ts` — Zod-схемы действий (`move`, `shoot`, `setStance`, `reload`, `useItem`, `flee`, `endTurn`, `aim`), `ActionResult` с типизированными ошибками.
- `server/game/battle/engine.ts` — `applyAction`: иммутабельный (`structuredClone`), валидация до применения, лог append-only (`logEntries` = только новые записи). Реализованы все 8 действий: стоимость ОД из `battleConfig.apCosts`; выстрел через формулы 5b (hit → damage → crit → armor → penetration), списание патронов в `Participant.weaponCharges`; прицел (+15% к следующему выстрелу, эффект снимается выстрелом); укрытие требует соседнее препятствие; бег только из позы `run`; `endTurn` передаёт ход мобам (с 5e — только `phase = 'enemy_turn'`; раунд/ОД/лимит лечения — в `runEnemyTurn`). Дополнительно экспортирует `shootChance`, `battleHighlight`, `battleVictoryXp`.
- `server/api/battle.ts` — `POST /api/battle/:id/action` (400 на ошибку действия, 409 если бой не active), `GET /api/battle/:id/highlight?action=move|shoot`. XP за победу начисляется на уровне API (в BattleState нет поля xp): `battleVictoryXp` → `xp`/`level` персонажа через `applyLevelUp`, запись в лог. Сохранение — только `updateBattleState` (он сам дописывает новые записи лога; `appendLog` параллельно дал бы дубли).
- `data/config/battle.json` — новая секция `apCosts` (значения из спеки); схема `BattleConfigSchema` дополнена, `ParticipantSchema` получил `weaponCharges?`.
- `client/js/screens/battle-map.js` — панель действий: ОД/поза/патроны, 8 кнопок (disabled по состоянию), режимы `move`/`shoot` с подсветкой, мини-панель зон, список расходников из инвентаря, ошибки сервера через i18n, баннер победы/поражения/побега, polling 1 с. Цвет лога по типу.
- `client/js/battle/hex.js` — `hexNeighbors` + `buildPath`: действие `move` на сервере — один соседний гекс, а подсветка `reachableHexes` многошаговая, поэтому клиент по клику прокладывает BFS-путь и отправляет цепочку одиночных шагов.
- i18n: +66 ключей (360/360), включая `battle.action.*`, `battle.error.*`, `battle.log.*`, `ui.battle.position/zone/button.*`.

## Шаг 5e — AI мобов

- `data/config/battle.json` — секция `ai` с двумя профилями (`aggressive`: `fleeAtHpPct 0`, `coverAware false`; `coward`: `fleeAtHpPct 30`, `coverAware true`, `fleeApThreshold 4`). Валидация — `AiConfigSchema` в `BattleConfigSchema`.
- `server/game/battle/ai.ts` — чистые решения без side effects: `decideMobAction({mob, state, items, mobs, config, rng})` и `findBestMoveHex`. Логика: трус ниже порога HP бежит (или ищет укрытие при нехватке ОД), иначе стреляет при `distance <= weapon.range` с LOS (ближник — без LOS), при отсутствии LOS ищет соседний гекс с LOS, иначе подходит (один соседний шаг к лучшему гексу из `reachableHexes`). Приоритеты `findBestMoveHex`: LOS+в дальности → LOS → в дальности → остальные; внутри группы — минимальная дистанция, тай-брейк по `hexKey`.
- `server/game/battle/engine.ts` — `runEnemyTurn({state, config, items, mobs, rng, lang})`: иммутабельно; пропускает ход, если `phase === 'player_turn'`; каждому живому мобу из `turnOrder` восстанавливает `ap = apMax`, крутит до 5 решений (move/shoot/flee/wait), списывает `mob.moveAp`/`mob.attackAp` (4/8); урон через те же формулы 5b (броня и пенетрация из `mob.attack`); смерть игрока → `defeat` + `phase finished`; затем `round += 1`, реген лимита лечения, `ap = apMax` всем, тик эффектов, `phase = player_turn`, лог «--- Раунд N ---».
- `start.ts` — `apMax` моба = `moveAp + attackAp` (pipe_rat: 12; в 5a была заглушка 4).
- `server/api/battle.ts` — после `applyAction(endTurn)` сразу вызывается `runEnemyTurn` (синхронно, в том же ответе); запрос в фазе `enemy_turn` → 400 `not_your_turn`; поражение возвращается 200 с `state` (не 400).
- `client/js/screens/battle-map.js` — лог показывает `{mob}: {text}` для записей не от игрока/системы; на время ответа `endTurn` подсказка «Ход противника…».
- i18n: +11 ключей (371/371): `battle.log.mob_*`, `battle.log.player_died`, `battle.log.enemy_defeated`, `ui.battle.enemy_turn`, `ui.battle.log.actor_mob`.

## Шаг 5d-fix — выход из боя и стабильный лог

- `server/api/battle.ts` — `POST /api/battle/:id/abandon`: 404 `battle_not_found`, 400 `battle_finished` для завершённого боя; иначе `status/result = 'fled'`, `phase = 'finished'`, `updatedAt = now`, запись `flee` от `system` в лог. HP/XP/лут/инвентарь не трогаются. Сохранение через `updateBattleState` (он сам дописывает новую запись; отдельный `appendLog` дал бы дубль).
- `client/js/screens/battle-map.js` — кнопка «Покинуть бой» в шапке, собственный мини-модал подтверждения (не нативный `confirm`), после 200 — остановка polling (`clearInterval`) и переход на экран локации по `state.context.locationId` через `main.js`.
- Лог боя — дельта-рендер вместо `innerHTML`: `lastLogLength` (id у записей нет), `appendChild` только новых записей, авто-скролл лишь когда пользователь у нижнего края (`scrollHeight - scrollTop - clientHeight < 30`), иначе кнопка «↓ новые сообщения»; первый рендер сразу прокручен вниз. DOM ограничен 20 записями только при автопрокрутке.
- i18n: +7 ключей (378/378): `battle.log.abandoned`, `ui.battle.button.abandon`, `ui.battle.abandon.confirm_*`, `ui.battle.log.new_messages`.
- Тесты: `tests/stage5d-fix.test.ts` (4): abandon активного → 200 и `fled` в БД, повторный → 400, несуществующий → 404, после abandon `active` → 404 и новый `start` → 201. Всего 256 тестов.

## Backlog

- Этап 6: WebSocket-сессии, полноценный экран боя (анимации, цветной лог глубже), убрать тестовую кнопку боя; синхронизация патронов/аптечек/HP с БД после боя
- AI: бонусная атака мобов при неудачном побеге игрока (в 5d/5e её нет), веса зон атаки (v0.2)
- Баланс: с текущим конфигом 1v1 vs pipe_rat даёт winrate ~100% (цель 70–85%) — упирается в point-blank auto-hit; тюнить конфиг/ТЗ на этапе боёвки
- Многошаговое движение: клиент прокладывает путь сам; при желании перенести в серверное действие `move` с путём (5e/6)
- Клиентский hex.js дублирует серверный hex.ts/los.ts — при появлении сборки вынести в общий модуль
- Этап 7: encounters и реальная длительность пути (3–10 сек)
- Этап 9: авторост статов при левелапе
- Этап 8: `data/shops.json`, `data/npcs.json`
- v0.2: реальная формула веса, запрет смены экипировки в бою
