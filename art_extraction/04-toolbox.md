# 4. Инвентарь инструментов и что копировать

Пути ниже относительные: `C:\Work\Allodshome\tests\`. Это не «все скрипты подряд», а карта по задачам.

## 4.1. Копировать в первую очередь

| Что | Откуда | Зачем |
|-----|--------|-------|
| `normalize_bg`, `magenta_mask`, `components`, `preflight` | `gen_hero_strip.py:531-760` | Ядро проверки сырого листа и сегментации. |
| `bg_ref`, `cut_mask`, `rows_of`, `body_height`, `fit` | `extract_hero_nb.py:107-141,208-235,383-444` | Ядро резки персонажей: flood от краёв, линии стоп, premultiplied resize. |
| `unmix_frame` | `extract_cursor_frames.py:54-71` | Мягкая альфа проекцией, без эрозии. |
| `strip_layout.py`, `crop_rows.py`, `facing_probe.py`, `measure_strip_figures.py` |的那些 файлы | Диагностика до и после резки. |
| `sprite_tools.py` (этот каталог) | `tools/` | Уже собранный переносимый аналог上面的 ядра. |

## 4.2. Специализированные нарезчики (копировать под конкретный контракт)

| Задача | Скрипт | Ключевое know-how |
|--------|--------|-------------------|
| Герой / NPC / наёмник, 12 кадров | `extract_hero_nb.py` | `--pick "2:3,2:2,1:3,1:4"`, `--dest hero\|npc\|merc`, `MAX_W=60`, `EDGE_MIN=3` |
| Звери, 12 кадров | `extract_monster_nb.py` | `group_by_feet`, `FLY_Z` для летающих (`bat/bee/ghost/dragon/succubus`), медиана ширины пересчитывается каждый проход |
| Травы, 4 кадра 32×32 | `extract_herb_strip.py` | общий масштаб на все кадры, якорь по корню, `GROUND_Y=29`, `MIN_FIGURE_H=40` |
| Городские NPC 8 направлений | `extract_chatgpt_city_npcs.py`, `gen_head_sets.py` | холст 52×64; шахматный фон отличается по хроме; якорь по полосе головы |
| Kimi 4×4 | `extract_kimi_townsman.py` | keep-largest на маске /4 через union-find против кровотечения соседних панелей |
| Фракционные иконки 72×80 | `extract_faction_art.py` | фильтр призрачных дублей, `pick_band` по ≥25 % массы |
| Предметы из атласа 256 px | `slice_items_atlas.py` | альфа по `(B-G)`, дефринж, отсев «паутины» линий сетки (`<0.9` кадра) |
| Броня, шахматные дыры | `extract_chatgpt_armor.py` | различать кремовую ткань и шахматные дыры по средней хроме; largest-only теряет вторую ногу |
| Портреты 240 px | `extract_chatgpt_portraits.py` | векторный flood, `float32`, удаление фоновых карманов только в нижних 75 %, halos по `HALO_LIGHT_L=150` |
| Курсоры 32×32 | `extract_cursor_frames.py` | unmix проекцией, hotspot = верхний-левый пиксель крупнейшей компоненты первого кадра |
| Иконки квестов, 4 кадра | `extract_mission_sheets.py`, `extract_quest_art.py` | математический unmix против `(255,0,255)`, рез по связным колонкам |
| Тайлы 32×14 строк | `extract_chatgpt_tiles.py` | единственный `load_base_tiles()` на весь проект; `save_bmp()` только 24-bit bottom-up |
| Части для cutout-рига | `extract_rig_parts.py`, `cut_rig_parts.py` | сустав в центре чётного холста; паддинг с маской, не crop |

## 4.3. Генераторы и вспомогательные

- `gen_image_kodik.py` — вызов KodikRouter: ключ из `KODIK_API_KEY` или `%APPDATA%\Mirotokhome\kodik_key`, 5 ретраев только на сетевые ошибки, JPEG → PNG.
- `gen_hero_strip.py`, `gen_monster_strip.py`, `gen_herb_strip.py`, `gen_mission_sheets.py`, `gen_faction_art.py` — общий приём: `LAYOUT* + preflight + --dry-run/--check`.
- `model_prices.py` — цены с `/images/models/<id>/endpoints`, `--free`.
- `gen_grey_tiers.py`, `faction_tint.py` — палитровые варианты вместо генерации; `--check` сверяет арт.
- `contact_sheet.py` (в `C:\Work\ComfyUI\our_scripts`) и `build_preview_sheet.py` (скилл `create-game-assets`) — контактные листы.

## 4.4. Окружение

- Python 3.14.7 через `py -3` (просто `python` на этой машине — заглушка Microsoft Store).
- Проверенные версии библиотек: Pillow **12.3.0**, numpy **2.5.4** (`docs/journal/2026-10-b.md:2407`).
- `scipy` в нарезчиках этого проекта не используется; утилиты из `C:\Work\ComfyUI\our_scripts` — отдельная история.
- Godot 4.7: после появления новых PNG — `godot --headless --import`.
- Сеть/деньги: KodikRouter — внешний API; тарифы и наличие эндпоинта проверять отдельно вызовом, не по каталогу моделей.

## 4.5. Интеграционный гейт

Порядок, который стоит повторить в новом проекте:

1. `--dry-run` / `--check` на генераторе — промт и цена до вызова.
2. `preflight` сырого листа → `layout` → при необходимости `crop_rows` или `--pick`.
3. Резка → контактный лист → `check`.
4. Сверка с базой данных (число кадров, размеры, направления, имя набора).
5. Импорт в движок → просмотр в реальном размере и на реальном фоне → только потом коммит/публикация.
