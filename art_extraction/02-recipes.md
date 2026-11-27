# 2. Проверенные алгоритмы: готовые рецепты

Код ниже — сжатая версия того, что реально работает в `C:\Work\Allodshome\tests\*.py`. Комментарии в сниппетах на английском по правилу проекта. Готовый переносимый вариант — `tools/sprite_tools.py`.

## 2.1. Маска мадженты

Источник: `gen_hero_strip.py:574-579`.

```python
def magenta_mask(a):
    # R and B of pure magenta are equal, so r-b>8 never matches.
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return (g < 110) & (r > 140) & (b > 140) & ((r - g) > 50)
```

## 2.2. Калибровка фона конкретного листа

Источник: `gen_hero_strip.py:531-571` (tol=60), `extract_hero_nb.py:107-112` (patch 24×24).

```python
from collections import deque

def normalize_bg(path, tol=60, patch=40):
    a = np.array(Image.open(path).convert("RGB"))
    h, w = a.shape[:2]
    corners = np.concatenate([
        a[:patch, :patch].reshape(-1, 3), a[:patch, -patch:].reshape(-1, 3),
        a[-patch:, :patch].reshape(-1, 3), a[-patch:, -patch:].reshape(-1, 3)])
    bg = np.median(corners, axis=0)
    near = np.abs(a.astype(np.int32) - bg.astype(np.int32)).max(axis=2) <= tol
    seen = flood_border(near)
    a[seen] = (255, 0, 255)
    Image.fromarray(a).save(path)
    return seen
```

`flood_border` — BFS от всех пикселей на границе по `near`. Важно: закрашивается **только связанный с краем** фон; внутренние светлые части фигуры остаются. Seedream отдаёт шумную мадженту ~[250,20,190], поэтому калибровка обязательна (`docs/journal/2026-10-b.md:2586-2616`).

## 2.3. Альфа из листа: flood + тёмная маджента + unmix

Источник: `extract_hero_nb.py:115-141`, `extract_cursor_frames.py:54-71`.

```python
def sheet_alpha(rgb, ref, tol=45):
    dist = np.sqrt(((rgb - ref) ** 2).sum(axis=2))
    # Dark magenta shadows are still background, even when far from the median.
    dark_magenta = (rgb[..., 1] < rgb[..., 2] - 25) & ((rgb[..., 0] - rgb[..., 1]) > 60)
    near = (dist <= tol) | dark_magenta
    seen = flood_border(near)
    core = (~seen) & (~near)

    # pixel = alpha*fg + (1-alpha)*BG; project onto the object-minus-BG axis.
    d = rgb[core].mean(axis=0) - ref
    denom = max(float(np.dot(d, d)), 1e-6)
    alpha = np.clip(((rgb - ref) @ d) / denom, 0.0, 1.0)
    tt = np.maximum(alpha[..., None], 1e-3)
    clean = np.clip((rgb - (1.0 - tt) * ref) / tt, 0, 255)
    return clean, alpha
```

Эрозию альфы применять нельзя: она съедает тонкие линии курсоров и контуры (`extract_cursor_frames.py:54-71`, инцидент 22.10).

## 2.4. Компоненты instead of column runs

Источник: `gen_hero_strip.py:582-619`.

```python
def components(mask, keep_ratio=0.18):
    m = mask > 0.35
    h, w = m.shape
    lab = np.zeros((h, w), np.int32)
    cur = 0
    for y in range(h):
        for x in range(w):
            if not m[y, x] or lab[y, x]:
                continue
            cur += 1
            stack = [(y, x)]
            lab[y, x] = cur
            while stack:
                cy, cx = stack.pop()
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w and m[ny, nx] and not lab[ny, nx]:
                        lab[y, x] = lab[y, x]  # no-op avoided below
                        lab[ny, nx] = cur
                        stack.append((ny, nx))
    ...  # keep components with area >= max_area*keep_ratio, return bboxes
```

Колоночные прогоны сливаются, когда хвост/рука/крыло соседней фигуры касаются: на полосе ходьбы орка четыре фигуры дали **один** прогон 2490 px. Замена на 4-связные компоненты это исправила.

> В сниппете выше строку `lab[y, x] = lab[y, x]` нужно удалить — она оставлена только как визуальная метка; рабочая реализация в `tools/sprite_tools.py`.

## 2.5. Группировка кадров в строки по линии стоп

Источник: `extract_hero_nb.py:208-235`.

```python
def rows_by_feet(boxes, tol=50):
    rows = []
    for b in sorted(boxes, key=lambda t: t[1]):  # sort by feet Y
        best, best_d = None, None
        for r in rows:
            d = abs(b[1] - r["feet"])
            if d <= tol and (best_d is None or d < best_d):
                best, best_d = r, d
        if best is None:
            rows.append({"feet": b[1], "boxes": [b]})
        else:
            best["feet"] = (best["feet"] * len(best["boxes"]) + b[1]) // (len(best["boxes"]) + 1)
            best["boxes"].append(b)
    return rows
```

На полосе смерти низ четырёх панелей был 1682/1674/1670/1672 — разброс 12 px, то есть одна строка. Группировка по вертикальному перекрытию отнесла четвёртую панель в отдельную строку.

## 2.6. Высота по «твёрдой» части фигуры

Источник: `extract_hero_nb.py:383-400`.

```python
def body_height(alpha):
    widths = (alpha > 0.5).sum(axis=1)
    if widths.max() <= 0:
        return 0
    keep = np.where(widths >= 0.25 * widths.max())[0]
    return int(keep[-1] - keep[0] + 1) if keep.size else 0
```

Вертикальный посох, уходящий за голову, занимает весь bbox, но имеет ширину в несколько пикселей; без этого фильтра кадры атаки мага уменьшались на 30 % относительно idle.

## 2.7. Premultiplied resize и посадка на линию стоп

Источник: `extract_hero_nb.py:403-444`, `extract_herb_strip.py:196-215`.

```python
def resize_premultiplied(rgba, size, resample=Image.Resampling.BOX):
    arr = np.array(rgba).astype(np.float32)
    a = arr[..., 3:4] / 255.0
    premul = np.concatenate([arr[..., :3] * a, arr[..., 3:4]], axis=2)
    small = np.array(Image.fromarray(np.clip(premul, 0, 255).astype(np.uint8), "RGBA")
                     .resize(size, resample)).astype(np.float32)
    a2 = small[..., 3:4] / 255.0
    rgb = np.where(a2 > 0.002, small[..., :3] / np.maximum(a2, 1e-3), 0.0)
    return np.concatenate([np.clip(rgb, 0, 255), small[..., 3:4]], axis=2)
```

Порядок `premultiply → resize → unpremultiply` обязателен. Прямой RGBA-resize смешивает RGB полностью прозрачных пикселей, которые всё ещё несут мадженту: травы получались оливковыми с розовым уклоном (замер на `tall_grass`, 350 исходных px → 24 px).

После ресайза: `alpha < 0.25 → 0`, `alpha × 1.35`, компоненты `< 15 %` главной — в ноль; вставка в холст с низом на `FEET_Y`.

## 2.8. Defringe Seedream

Источник: `fix_seedream_magenta.py:47-62`.

```python
# core: (g<90) & (r-g>90) & (b-g>70)
# fringe: (r-g>45) & (b-g>40) within 2 px of transparent pixels
# measured art ranges: r-g 3..24, b-g -17..8
```

Порог по хроме, а не по яркости: яркостный вариант `g<150, r-g>35` сжигал часть арта.

## 2.9. Семантические якоря

| Якорь | Реализация | Почему |
|-------|------------|--------|
| Стопы | `cell.paste(fr, ((W-nw)//2, FEET_Y-nh), fr)` | Общая линия пола между кадрами. |
| Корень растения | нижние 22 % высоты — ком земли; масштаб один на все 4 кадра | Иначе трава «дышит» размером и ездит вбок (`extract_herb_strip.py:9-15`). |
| Полоса головы NPC | `band = arr[int(H*0.08):int(H*0.22)]`, центр по альфе полосы | Посох сдвигает bbox тела (`gen_head_sets.py:208-214`). |
| Направление | центр кожи лица + смещение лица внутри bbox головы | Вытянутая рука ломает bbox тела (`facing_probe.py:68-89`). |

## 2.10. Дешёвое расширение набора: палитровый своп

Источник: `gen_grey_tiers.py:71-77,139-150`.

```python
# h' = target_hue + (h - base_hue) * spread_keep
# spread_keep: 0.55 / 0.55 / 0.60 / 0.65 for tiers 2..5
# tier 2 additionally: saturation *= 1.55, value *= 0.72
```

Сохранение внутреннего разброса оттенков важнее точного целевого цвета: плоская закраска превращает зверя в силуэт. Четыре тира зверя и три расы NPC были получены из одного набора без новых генераций (`gen_head_sets.py`).
