# Промты для Kimi: 7 атласов для игры

Статус: промты собраны по данным проекта и по контракту из `01-pipeline.md` — `04-toolbox.md`. **Не проверено на реальной генерации в Kimi**: сетка 5×5 у моделей часто ломается, поэтому сначала делается пробная полоса, потом полный лист.

## Запомненное правило пользователя

- Просить **именно спрайтшит/атлас для игры**, а не иллюстрацию, постер или концепт-арт.
- **Не использовать мелкие и узкие элементы**: цепочки, нити, провода, тонкие стволы, тонкие ветки, микро-болты, волосяные трещины. Минимальная толщина детали на исходном листе: 28 px для иконок 32×32, 24 px для мобов/препятствий, 13 px для портретов.
- Фон листа — плоский маджентовый хромакей `(255,0,255)`; прозрачность получаем резкой по маске, а не «прозрачным фоном от модели». См. `sprite_tools.py` и `02-recipes.md`.
- Никаких надписей, цифр, лейблов, рамок-макетов, сетки, теней и пола в кадре.

## Что проверено в данных

| Атлас | Запрошено | Есть в данных | Решение |
|---|---:|---:|---|
| 1. Оружие/броня | 25 | 8 оружий + 8 брони = 16 (`data/items.json`) | Добавлены 5 эмблем категорий оружия и 4 эмблемы пустых слотов — все из `ui.weapon_category.*` / `ui.inventory.slot.*`. |
| 2. Расходники/лут/валюта | 25 | 6 расходников + 3 патрона + 6 misc = 15 (`data/items.json`) | Добавлены 10 крупных вариантов лута/валюты (стопки, обломки, кости и т.п.). |
| 3. Портреты NPC | 4 | 3 NPC (`data/npcs.json`: koval, vera, molchun) | 4-й слот — нищий из `ui.location.button.beggar`; это **новый** образ, в `npcs.json` его нет. |
| 4. Мобы | 16 | 14 (`data/mobs.json`) | 15–16 — элитные версии `rat_elder` и `rust_hulk` (в данных есть их `elite`-множители). |
| 5. Действия/статусы | 25 | 8 действий + 4 позы + 4 зоны (`data/i18n/ru.json`, `battle.json`) | Добавлены 5 исходов попадания и 4 ресурса. |
| 6. Панели | 6 | нет готового арта | 6 типов UI-заготовок под текущую тёмную палитру. |
| 7. Препятствия | 25 | 4 типа (`server/game/battle/start.ts`: wall, rock, tree, crate) | 8/6/6/5 вариантов этих же четырёх типов. `crate` не блокирует LOS, остальные блокируют. |

Палитра взята из `data/world.json`: `#3a322c`, `#1a1614`, `#2a2420`, `#0f0c0a`, `#3a5a3a`. Остальные цвета — производные ржавые/споровые оттенки.

## Общий технический блок

Вставляется **в начало каждого промта** ниже. Фразы `SIDE VIEW`, `lean`, `character sheet`, `full body`, `side by side` в промт НЕ добавлять — по `03-pitfalls.md` они ломают позу и силуэт.

```text
ROLE/PURPOSE: production sprite-sheet atlas for a browser game. ONE PNG sheet only. Not an illustration, not a poster.
ART DIRECTION: gritty post-apocalyptic 2D game asset, chunky readable silhouette, clean cel shading, limited palette, three-quarter top-down view about 30 degrees, light from upper-left. Palette anchors: soot #1a1614, dust #3a322c, ground #2a2420, dark contour #0f0c0a, rust #7a3b2a, spore green #3a5a3a, warning orange #c27a33. Name colors by part: steel plates, orange cloth tabard, brown belt — never just "armor".
GAME-SCALE READ: these sprites are cut down to 32x32 for items, 48x48 for mobs and obstacles, 128x128 for portraits. Everything must survive that size. No thin chains, strings, wires, thin barrels, thin branches, narrow spikes, micro bolts, hairline cracks. Minimum detail width at source: 28 px for item icons, 24 px for mob and obstacle icons, 13 px for portraits.
BACKGROUND: flat solid magenta #FF00FF chroma key in every empty area. No floor, no ground plane, no cast shadow, no gradient, no grid lines, no scenery, no mockup frame.
LOCKS: identical scale, identical light direction, identical outline weight across all panels; exactly one object per panel; no duplicates; nothing touches a neighboring panel.
EXCLUDE: text, letters, numbers, labels, captions, watermarks, signatures, extra objects, duplicated panels, small details, narrow details.
```

## 1. Оружие и броня — 25 иконок

```text
[ОБЩИЙ ТЕХНИЧЕСКИЙ БЛОК]

SUBJECT: 25 equipment icons in this exact reading order, row by row:
1 rusted short pipe with a thick taped grip; 2 hunting knife with a broad brown handle; 3 heavy fire axe with a wide steel blade and orange grip wrap; 4 sawed-off double-barrel shotgun, short and thick, wooden stock; 5 compact army pistol with a chunky slide.
6 rusty carbine with a thick stock and short barrel; 7 sniper rifle drawn compact with a fat scope, not a long thin barrel; 8 machine gun with a broad drum magazine and thick body; 9 brown leather jacket with wide collar and steel rivets; 10 heavy canvas pants with thick belt loops.
11 worn brown boots with broad soles; 12 welder mask with a wide dark visor; 13 army vest with thick green plates and wide straps; 14 spore cloak, dull olive with fat mushroom-shaped patches; 15 hi-tech vest, large dark panels with orange markers.
16 category emblem: chunky gloved fist and short blade for melee; 17 category emblem: compact broad pistol for light weapons; 18 category emblem: stubby carbine for medium weapons; 19 category emblem: broad machine gun silhouette for heavy weapons; 20 category emblem: short rifle with a big scope for sniper weapons.
21 empty weapon slot emblem: thick hollow weapon outline; 22 empty head slot emblem: thick helmet outline; 23 empty torso slot emblem: thick vest outline; 24 empty legs slot emblem: thick trouser outline; 25 empty boots slot emblem: thick boot outline.

LAYOUT_TAIL: ONE 2048x2048 PNG. Strict 5 columns x 5 rows. Panel centers: x = 200, 610, 1024, 1438, 1848; y = 200, 610, 1024, 1438, 1848. Keep every object inside a 300x300 px box around its center, leaving at least 55 px of clean magenta on all sides. Object 1 is row 1 column 1, object 25 is row 5 column 5. No extra row, no extra column, no rotation of the whole sheet.
```

## 2. Расходники, лут, валюта — 25 иконок

```text
[ОБЩИЙ ТЕХНИЧЕСКИЙ БЛОК]

SUBJECT: 25 loot and consumable icons in this exact reading order, row by row:
1 white medkit case with a thick red cross; 2 tightly rolled bandage with wide red stripe; 3 chunky glass vial of green spore antidote; 4 fat stimpack syringe with orange fluid; 5 large hard medical case with broad latches.
6 stimulant blister pack with three big tablets; 7 three fat light cartridges; 8 three fat rifle cartridges; 9 two heavy belt-linked rounds; 10 bent scrap-metal plate with thick edges.
11 folded rat pelt with a broad tail; 12 fat mushrooms in a stubby sample jar; 13 oversized old coin with a deep relief; 14 chunky military flashlight with a wide lens; 15 oversized army dog tag with a thick hole.
16 stack of three army dog tags; 17 stack of oversized old coins; 18 pile of thick bolts and nuts; 19 broken chunky gear; 20 rat skull with broad teeth.
21 large bone fragment; 22 tied bundle of rags; 23 swollen spore sac; 24 dented metal water flask; 25 thick filter cartridge.

LAYOUT_TAIL: ONE 2048x2048 PNG. Strict 5 columns x 5 rows. Panel centers: x = 200, 610, 1024, 1438, 1848; y = 200, 610, 1024, 1438, 1848. Keep every object inside a 300x300 px box around its center, leaving at least 55 px of clean magenta on all sides. Object 1 is row 1 column 1, object 25 is row 5 column 5. Do not draw tiny loose bullets or tiny coins: every stack must be chunky.
```

## 3. Портреты NPC — 4

```text
[ОБЩИЙ ТЕХНИЧЕСКИЙ БЛОК]

SUBJECT: four head-and-shoulders portraits in this exact reading order:
1 Old Koval, blacksmith: bald crown, thick grey beard, heavy soot-stained leather apron, broad shoulders, warm brown and soot-grey palette.
2 Vera, field medic: short dark hair, faded olive coat, wide red armband, tired but steady face, green and bone-white palette.
3 Molchun, miner: heavy helmet with a large lamp, thick dust mask, broad soot-dark coat, dusty brown and steel palette.
4 Beggar, a new character for this project: ragged heavy hood, gaunt face, thick patched blanket, a large tin cup, desaturated grey and rust palette.

VIEW: head-and-shoulders bust only, same three-quarter angle and same framing for all four; faces occupy the central 60% of each panel height.
GAME-SCALE READ: cut down to 128x128 px. No thin glasses, no thin wires on the helmet lamp, no tiny tools, no individual hair strands. Beard, hood, lamp and cup must be broad shapes.

LAYOUT_TAIL: ONE 2048x2048 PNG. Strict 2 columns x 2 rows. Panel centers: x = 512, 1536; y = 512, 1536. Keep each bust inside an 800x800 px box around its center, leaving at least 112 px of clean magenta on all sides. Object 1 is top-left, object 4 is bottom-right. No extra panels.
```

## 4. Иконки мобов — 16

```text
[ОБЩИЙ ТЕХНИЧЕСКИЙ БЛОК]

SUBJECT: 16 monster icons in this exact reading order, row by row:
1 pipe rat: fat grey rodent with a broad pink nose and chunky teeth; 2 ash dog: soot-grey mongrel with a thick muzzle; 3 spore youth: hunched humanoid with wide olive mushroom cap; 4 rust digger: human in a thick brown apron holding a broad shovel; 5 rot walker: bulky undead in ragged green rags.
6 rat elder: larger grey rat with a thick scar and broad ears; 7 bandit scout: lean but broad-shouldered human in a dark hood; 8 bandit brute: massive human in a wide rusty steel plate; 9 bandit shooter: human with a chunky short pistol; 10 spore shooter: humanoid with a fat green spore sac and a short thick launcher.
11 spore hound: four-legged beast with a wide mushroom crest; 12 spore priest: hooded humanoid with a large capped mushroom staff head; 13 rust hulk: huge bulky mutant with thick plated shoulders; 14 gray widow: fat pale insect with a broad abdomen, not thin legs; 15 elite rat elder: same rat as panel 6, 30% bulkier, with bold red markings; 16 elite rust hulk: same hulk as panel 13, 30% bulkier, with bold red markings.

LAYOUT_TAIL: ONE 2048x2048 PNG. Strict 4 columns x 4 rows. Panel centers: x = 256, 768, 1280, 1792; y = 256, 768, 1280, 1792. Keep every creature inside a 420x420 px box around its center, leaving at least 46 px of clean magenta on all sides. Object 1 is row 1 column 1, object 16 is row 4 column 4. No extra panels.
```

## 5. Действия и статусы — 25 иконок

```text
[ОБЩИЙ ТЕХНИЧЕСКИЙ БЛОК]

SUBJECT: 25 action and status icons in this exact reading order, row by row:
1 movement: thick boot with a broad arrow; 2 shoot: chunky muzzle flash and fat bullet; 3 aim: wide crosshair with bold rings; 4 stance change: broad up-down chevrons; 5 reload: fat magazine and thick curved arrow.
6 use item: white medical case with thick red cross; 7 flee: broad running boot and curved arrow; 8 end turn: thick hourglass; 9 stand: upright broad human silhouette; 10 crouch: compact bent human silhouette.
11 run: wide leaning human silhouette with motion blocks; 12 cover: thick wall block with a compact figure behind it; 13 head zone: broad head outline; 14 torso zone: broad chest outline; 15 arms zone: broad paired arm outlines.
16 legs zone: broad paired leg outlines; 17 hit: bold impact star; 18 critical hit: bold red impact star with wide fracture blocks; 19 miss: thick broken arrow; 20 death: heavy crossed mark, no gore.
21 dodge: wide curved arrow around a compact figure; 22 action points: thick lightning bolt; 23 health: broad heart shape; 24 ammo: three fat cartridges; 25 experience: thick upward arrow with a broad star.

LAYOUT_TAIL: ONE 2048x2048 PNG. Strict 5 columns x 5 rows. Panel centers: x = 200, 610, 1024, 1438, 1848; y = 200, 610, 1024, 1438, 1848. Keep every symbol inside a 300x300 px box around its center, leaving at least 55 px of clean magenta on all sides. Object 1 is row 1 column 1, object 25 is row 5 column 5. Signs and arrows must be wide, never hairline.
```

## 6. Текстуры панелей — 6

```text
ROLE/PURPOSE: production UI panel atlas for a browser game. ONE PNG sheet only. These six shapes are the UI art itself, not a mockup around it.
ART DIRECTION: gritty post-apocalyptic dark UI, chunky bevels, broad rivets, subtle rust speckle, flat center area suitable for stretching, three-quarter light from upper-left. Palette anchors: soot #1a1614, dust #3a322c, ground #2a2420, rust #7a3b2a, warning orange #c27a33.
GAME-SCALE READ: shapes are used at 1:1 or mildly scaled, so borders must be at least 48 px thick at source. No hairline borders, no thin engraving, no tiny rivets.
BACKGROUND: flat solid magenta #FF00FF outside every shape. No drop shadow, no floor, no gradient background, no grid, no text.
LOCKS: same palette, same bevel width, same rivet size across all six panels.

SUBJECT: six panel textures in this exact reading order:
1 main panel body: wide dark rectangle with a 48 px thick rusty border and a nearly flat soot center; 2 header bar: heavy horizontal band with four broad rivets and a warm rust top edge; 3 inventory slot frame: thick square border with chunky corner notches and an empty center; 4 primary button: raised bevel with a warm rust face and thick orange edge; 5 secondary or disabled button: flat desaturated dark face with a broad grey border; 6 tooltip and result overlay backing: solid dark slab with a thick border, wide corner plates, empty center.

LAYOUT_TAIL: ONE 2048x2048 PNG. Strict 3 columns x 2 rows. Panel centers: x = 341, 1024, 1707; y = 512, 1536. Keep every shape inside a 560x560 px box around its center, leaving at least 60 px of clean magenta on all sides. Object 1 is top-left, object 6 is bottom-right. No letters, no numbers, no mockup frame around the sheet.
```

## 7. Препятствия для боя — 25

```text
[ОБЩИЙ ТЕХНИЧЕСКИЙ БЛОК]

SUBJECT: 25 battle obstacle icons in this exact reading order, row by row. Obstacles sit on hex cells, so each one needs a compact footprint and a readable height:
1 concrete slab wall; 2 thick brick wall stub; 3 rusted steel barrier; 4 factory wall chunk; 5 ruined wall with a broad broken edge; 6 bundle of thick pipes; 7 heavy timber mine support; 8 solid palisade of broad planks.
9 large boulder; 10 rubble pile; 11 concrete chunk; 12 mine rock; 13 slag chunk; 14 mossy rock.
15 dead pine; 16 charred thick trunk; 17 dense conifer; 18 broken stump; 19 spore tree with a wide cap; 20 leaning heavy trunk.
21 wooden crate; 22 metal crate; 23 barrel stack; 24 supply box; 25 low sandbag stack.

GAMEPLAY READ: panels 1-20 are tall: they block both movement and line of sight, so show real height and a solid body. Panels 21-25 are low, waist-high cover: they block movement but NOT line of sight, so keep them short and broad. No thin fences, no wire mesh, no thin branches, no narrow rebar, no long thin planks.

LAYOUT_TAIL: ONE 2048x2048 PNG. Strict 5 columns x 5 rows. Panel centers: x = 200, 610, 1024, 1438, 1848; y = 200, 610, 1024, 1438, 1848. Keep every obstacle inside a 300x300 px box around its center, leaving at least 55 px of clean magenta on all sides. Object 1 is row 1 column 1, object 25 is row 5 column 5.
```

## После генерации

1. На каждом листе: `py -3 art_extraction\tools\sprite_tools.py preflight import\atlasN.png --panels 25` (для №3 `--panels 4`, №4 `--panels 16`, №6 `--panels 6`).
2. Если сетка сломана: `layout`, затем резка по компонентам; не перегенерировать весь лист сразу — сначала `--pick` по годным ячейкам (`01-pipeline.md`, шаги 3–4).
3. Резка: `cut` → `check` → `sheet` (контактный лист на шахматке).
4. Просмотр в реальном размере: иконки 32×32, мобы/препятствия 48×48, портреты 128×128. Картинка не готова, пока не проверена в игре.
