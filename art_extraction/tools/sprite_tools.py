"""Portable sprite-sheet extraction helpers.

Only Pillow and numpy are required. Run with: py -3 sprite_tools.py <command> ...
All comments and messages are kept in English by project convention.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

MAGENTA = np.array([255.0, 0.0, 255.0], dtype=np.float32)

CANVAS_W, CANVAS_H = 64, 64
FIGURE_H = 54
FEET_Y = 62
EDGE_MIN = 3
FEET_TOL = 14
MIN_GAP = 28
MIN_RATIO = 0.36
ROW_TOL = 50


# ---------------------------------------------------------------- segmentation

def magenta_mask(a: np.ndarray) -> np.ndarray:
    """Flat magenta detector; R and B are equal, so r-b cannot be used."""
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return (g < 110) & (r > 140) & (b > 140) & ((r - g) > 50)


def corner_median(a: np.ndarray, patch: int = 24) -> np.ndarray:
    """Background colour estimated from four corner patches."""
    h, w = a.shape[:2]
    p = min(patch, h, w)
    corners = np.concatenate([
        a[:p, :p].reshape(-1, 3), a[:p, -p:].reshape(-1, 3),
        a[-p:, :p].reshape(-1, 3), a[-p:, -p:].reshape(-1, 3)])
    return np.median(corners, axis=0).astype(np.float32)


def flood_border(seed: np.ndarray) -> np.ndarray:
    """4-connected flood fill from every pixel on the canvas border."""
    h, w = seed.shape
    seen = np.zeros((h, w), dtype=bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if seed[y, x] and not seen[y, x]:
                seen[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if seed[y, x] and not seen[y, x]:
                seen[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and seed[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                q.append((ny, nx))
    return seen


def sheet_alpha(rgb: np.ndarray, ref: np.ndarray, tol: float = 45.0):
    """Extract alpha and unmixed RGB from a sheet on a magenta background."""
    a = rgb.astype(np.float32)
    dist = np.sqrt(((a - ref) ** 2).sum(axis=2))
    dark_magenta = (a[..., 1] < a[..., 2] - 25) & ((a[..., 0] - a[..., 1]) > 60)
    near = (dist <= tol) | dark_magenta
    seen = flood_border(near)
    core = (~seen) & (~near)
    alpha = core.astype(np.float32)
    if int(core.sum()) > 8:
        # pixel = alpha*fg + (1-alpha)*BG; project onto the object-minus-BG axis.
        direction = a[core].mean(axis=0) - ref
        denom = max(float(np.dot(direction, direction)), 1e-6)
        alpha = np.clip(((a - ref) @ direction) / denom, 0.0, 1.0)
        alpha[seen] = 0.0
        tt = np.maximum(alpha[..., None], 1e-3)
        clean = np.clip((a - (1.0 - tt) * ref) / tt, 0, 255)
    else:
        clean = a.copy()
    return clean, alpha


def label_components(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """4-connected component labelling with an explicit stack."""
    m = mask > 0.35
    h, w = m.shape
    labels = np.zeros((h, w), dtype=np.int32)
    count = 0
    for y in range(h):
        for x in range(w):
            if not m[y, x] or labels[y, x]:
                continue
            count += 1
            stack = [(y, x)]
            labels[y, x] = count
            while stack:
                cy, cx = stack.pop()
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w and m[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = count
                        stack.append((ny, nx))
    return labels, count


def component_boxes(mask: np.ndarray, min_ratio: float = 0.08) -> list[dict]:
    """Bounding boxes of components heavier than a fraction of the largest."""
    labels, count = label_components(mask)
    if count == 0:
        return []
    areas = np.bincount(labels.ravel(), minlength=count + 1)
    areas[0] = 0
    cutoff = max(1.0, float(areas.max()) * min_ratio)
    boxes = []
    for i in range(1, count + 1):
        if areas[i] < cutoff:
            continue
        ys, xs = np.where(labels == i)
        boxes.append({"y0": int(ys.min()), "y1": int(ys.max()),
                      "x0": int(xs.min()), "x1": int(xs.max()),
                      "area": int(areas[i])})
    boxes.sort(key=lambda b: (b["y0"], b["x0"]))
    return boxes


def rows_by_feet(boxes: list[dict], tol: float = ROW_TOL) -> list[list[dict]]:
    """Group components by their feet line, not by vertical overlap."""
    rows: list[dict] = []
    for b in sorted(boxes, key=lambda t: t["y1"]):
        best, best_d = None, None
        for row in rows:
            d = abs(b["y1"] - row["feet"])
            if d <= tol and (best_d is None or d < best_d):
                best, best_d = row, d
        if best is None:
            rows.append({"feet": b["y1"], "boxes": [b]})
        else:
            n = len(best["boxes"])
            best["feet"] = int((best["feet"] * n + b["y1"]) / (n + 1))
            best["boxes"].append(b)
    return [row["boxes"] for row in rows]


def body_height(alpha: np.ndarray) -> int:
    """Height of the solid figure; thin staffs and tails do not count."""
    widths = (alpha > 0.5).sum(axis=1)
    if widths.max() <= 0:
        return 0
    keep = np.where(widths >= 0.25 * widths.max())[0]
    return int(keep[-1] - keep[0] + 1) if keep.size else 0


# ------------------------------------------------------------------- transform

def resize_premultiplied(rgba: np.ndarray, size: tuple[int, int],
                         resample=Image.Resampling.BOX) -> np.ndarray:
    """Premultiply, resize, unpremultiply; keeps magenta out of clean pixels."""
    arr = rgba.astype(np.float32)
    a = arr[..., 3:4] / 255.0
    premul = np.concatenate([arr[..., :3] * a, arr[..., 3:4]], axis=2)
    small = np.array(Image.fromarray(np.clip(premul, 0, 255).astype(np.uint8), "RGBA")
                     .resize(size, resample)).astype(np.float32)
    a2 = small[..., 3:4] / 255.0
    rgb = np.where(a2 > 0.002, small[..., :3] / np.maximum(a2, 1e-3), 0.0)
    return np.concatenate([np.clip(rgb, 0, 255), small[..., 3:4]], axis=2)


def drop_small_fragments(rgba: np.ndarray, min_ratio: float = 0.15) -> int:
    """Remove fragments created by the resize itself, after downscaling."""
    mask = rgba[..., 3] > 32
    labels, count = label_components(mask)
    if count <= 1:
        return 0
    areas = np.bincount(labels.ravel(), minlength=count + 1)
    areas[0] = 0
    keep = areas >= areas.max() * min_ratio
    keep[0] = False
    removed = int(np.count_nonzero(mask & ~keep[labels]))
    rgba[~keep[labels], 3] = 0
    return removed


def fit_frame(clean: np.ndarray, alpha: np.ndarray,
              canvas: tuple[int, int] = (CANVAS_W, CANVAS_H),
              figure_h: int = FIGURE_H, feet_y: int = FEET_Y,
              resample=Image.Resampling.BOX):
    """Scale to the figure contract and paste with the feet on the baseline."""
    h = body_height(alpha)
    ys, xs = np.where(alpha > 0.5)
    if h <= 0:
        h = int(ys.max() - ys.min() + 1) if ys.size else 1
    w = int(xs.max() - xs.min() + 1) if xs.size else 1
    # Keep the required margin on both sides of the exported frame.
    max_w = canvas[0] - 2 * EDGE_MIN
    scale = min(figure_h / float(h), max_w / float(w))
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    src = np.dstack([np.clip(clean, 0, 255), np.clip(alpha * 255.0, 0, 255)])
    small = resize_premultiplied(src, (nw, nh), resample)
    a = small[..., 3:4] / 255.0
    a = np.where(a < 0.25, 0.0, np.minimum(1.0, a * 1.35))
    small[..., 3:4] = np.clip(a * 255.0, 0, 255).astype(np.float32)
    removed = drop_small_fragments(small)
    cell = Image.new("RGBA", canvas, (0, 0, 0, 0))
    frame = Image.fromarray(np.clip(small, 0, 255).astype(np.uint8), "RGBA")
    cell.paste(frame, ((canvas[0] - nw) // 2, feet_y - nh), frame)
    return cell, {"width": nw, "height": nh, "fragments_removed": removed}


# ---------------------------------------------------------------------- checks

def _runs(active: np.ndarray) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    start = -1
    for x, v in enumerate(active):
        if v and start < 0:
            start = x
        elif not v and start >= 0:
            runs.append((start, x - 1))
            start = -1
    if start >= 0:
        runs.append((start, len(active) - 1))
    return runs


def preflight(path: Path, expect: int = 4, min_gap: int = MIN_GAP,
              feet_tol: int = FEET_TOL, edge_min: int = EDGE_MIN,
              min_ratio: float = MIN_RATIO, min_figure_h: int = 0) -> dict:
    """Check a raw sheet before paying for the rest of a batch."""
    a = np.array(Image.open(path).convert("RGB")).astype(np.float32)
    bgm = magenta_mask(a)
    fg = ~bgm
    h, w = fg.shape
    lines: list[str] = []
    checks: dict[str, bool] = {}

    bg_pixels = a[bgm]
    spread = float(bg_pixels.std(axis=0).max()) if bg_pixels.size else 999.0
    checks["background"] = bool(bg_pixels.size) and spread < 26
    lines.append(f"background: {bgm.mean()*100:.0f}% of canvas, channel sd={spread:.1f}")

    cols = fg.sum(axis=0)
    runs = _runs(cols >= 3)
    if min_figure_h > 0:
        kept = []
        for x0, x1 in runs:
            ys, _ = np.where(fg[:, x0:x1 + 1])
            if ys.size and int(ys.max() - ys.min() + 1) >= min_figure_h:
                kept.append((x0, x1))
        runs = kept
    gaps = [runs[i + 1][0] - runs[i][1] - 1 for i in range(len(runs) - 1)]
    checks["figures"] = len(runs) == expect
    checks["gaps"] = (not gaps) or min(gaps) >= min_gap
    lines.append(f"figures: {len(runs)} (expected {expect}), gaps: {gaps or '-'}")

    shadow_max, feet, pads, ratios = 0.0, [], [], []
    for x0, x1 in runs:
        ys, _ = np.where(fg[:, x0:x1 + 1])
        if ys.size == 0:
            continue
        foot = int(ys.max())
        feet.append(foot)
        pads.append((x0, int(ys.min()), w - 1 - x1, h - 1 - foot))
        band = a[foot + 3:foot + 26, x0:x1 + 1]
        if band.size:
            dark = (band[..., 0] < 140) & (band[..., 1] < 110)
            shadow_max = max(shadow_max, float(dark.sum()) / dark.size)
        sub = fg[:, x0:x1 + 1]
        yy, xx = np.where(sub)
        if yy.size:
            cw = int(xx.max() - xx.min() + 1)
            ch = int(yy.max() - yy.min() + 1)
            ratios.append(cw / max(1, ch))
    checks["shadow"] = shadow_max < 0.06
    lines.append(f"shadow: worst band {shadow_max*100:.0f}% dark pixels")

    spread_feet = (max(feet) - min(feet)) if feet else 999
    checks["feet_line"] = spread_feet <= feet_tol
    lines.append(f"feet line: spread {spread_feet}px (max {feet_tol})")

    edge = min((min(p) for p in pads), default=0)
    checks["edge"] = bool(pads) and edge >= edge_min
    lines.append(f"edge margin: worst {edge}px (min {edge_min})")

    worst_ratio = min(ratios, default=0.0)
    checks["thickness"] = bool(ratios) and worst_ratio >= min_ratio
    lines.append(f"thickness: worst w/h {worst_ratio:.2f} (min {min_ratio:.2f})")

    ok = all(checks.values())
    for line in lines:
        print("  " + line)
    failed = [k for k, v in checks.items() if not v]
    print(f"PREFLIGHT {'PASS' if ok else 'FAIL'}" + (f"; failed: {', '.join(failed)}" if failed else ""))
    return {"ok": ok, "checks": checks, "lines": lines, "figures": len(runs)}


def layout_report(path: Path) -> dict:
    """Measure the real panel layout of a raw sheet."""
    a = np.array(Image.open(path).convert("RGB")).astype(np.float32)
    fg = ~magenta_mask(a)
    runs = _runs(fg.sum(axis=0) >= 3)
    gaps = [runs[i + 1][0] - runs[i][1] - 1 for i in range(len(runs) - 1)]
    rows = fg.sum(axis=1) >= 5
    bands = _runs(rows)
    print(f"columns: {len(runs)}, bands: {len(bands)}")
    print(f"gaps: {gaps or '-'}")
    print(f"bands y: {bands}")
    for i, (x0, x1) in enumerate(runs):
        ys, _ = np.where(fg[:, x0:x1 + 1])
        if ys.size:
            print(f"  panel {i}: x={x0}..{x1} y={ys.min()}..{ys.max()} "
                  f"margins L={x0} R={a.shape[1]-1-x1} T={ys.min()} B={a.shape[0]-1-ys.max()}")
    return {"columns": len(runs), "gaps": gaps, "bands": bands}


# ------------------------------------------------------------------ utilities

def contact_sheet(paths: list[Path], out: Path, columns: int = 4,
                  cell: int = 128) -> None:
    """Build a nearest-neighbour contact sheet over a checkerboard."""
    if not paths:
        raise ValueError("no input frames")
    rows = (len(paths) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * cell, rows * cell), (32, 32, 32))
    draw = ImageDraw.Draw(sheet)
    tile = max(4, cell // 8)
    for ry in range(rows):
        for rx in range(columns):
            for ty in range(0, cell, tile):
                for tx in range(0, cell, tile):
                    base = 190 if ((tx // tile + ty // tile) % 2 == 0) else 140
                    draw.rectangle((rx * cell + tx, ry * cell + ty,
                                    rx * cell + tx + tile, ry * cell + ty + tile),
                                   fill=(base, base, base))
    for i, path in enumerate(paths):
        img = Image.open(path).convert("RGBA")
        img.thumbnail((cell - 8, cell - 8), Image.Resampling.NEAREST)
        x = (i % columns) * cell + (cell - img.width) // 2
        y = (i // columns) * cell + (cell - img.height) // 2
        sheet.paste(img, (x, y), img)
        draw.text(((i % columns) * cell + 3, (i // columns) * cell + 3), str(i), fill=(255, 80, 80))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    print(f"contact sheet: {out} ({len(paths)} frames)")


def check_frames(directory: Path, expect: int = 4,
                 canvas: tuple[int, int] = (CANVAS_W, CANVAS_H),
                 figure_h: int = FIGURE_H, edge_min: int = EDGE_MIN,
                 height_jitter: int = 6) -> bool:
    """Check exported frames: count, size, margins and height stability."""
    paths = sorted(p for p in directory.glob("*.png") if not p.name.startswith("_"))
    ok = True
    if expect and len(paths) != expect:
        print(f"FAIL frame count: {len(paths)} (expected {expect})")
        ok = False
    heights = []
    for path in paths:
        img = Image.open(path).convert("RGBA")
        if img.size != canvas:
            print(f"FAIL size: {path.name} {img.size} (expected {canvas})")
            ok = False
        a = np.array(img)[..., 3] > 32
        ys, xs = np.where(a)
        if not ys.size:
            print(f"FAIL empty frame: {path.name}")
            ok = False
            continue
        margins = (xs.min(), ys.min(), img.width - 1 - xs.max(), img.height - 1 - ys.max())
        if min(margins) < edge_min:
            print(f"FAIL edge margin {min(margins)}px: {path.name}")
            ok = False
        heights.append(int(ys.max() - ys.min() + 1))
    if heights and (max(heights) - min(heights)) > height_jitter:
        print(f"FAIL height jitter: {min(heights)}..{max(heights)}px "
              f"(max {height_jitter}, target {figure_h})")
        ok = False
    print(f"CHECK {'PASS' if ok else 'FAIL'}: {len(paths)} frames in {directory}")
    return ok


def cut_sheet(path: Path, out: Path, prefix: str = "frame", panels: int = 4,
              canvas: tuple[int, int] = (CANVAS_W, CANVAS_H),
              figure_h: int = FIGURE_H, feet_y: int = FEET_Y,
              min_figure_h: int = 8, tol: float = 45.0,
              min_component_ratio: float = 0.08) -> dict:
    """Detect panels, extract them and export contract-sized RGBA frames."""
    rgb = np.array(Image.open(path).convert("RGB"))
    ref = corner_median(rgb)
    clean, alpha = sheet_alpha(rgb, ref, tol)
    boxes = component_boxes(alpha, min_component_ratio)
    boxes = [b for b in boxes if b["y1"] - b["y0"] + 1 >= min_figure_h]
    rows = rows_by_feet(boxes)
    if not rows:
        raise ValueError(f"no figures found in {path}")
    row = max(rows, key=lambda r: sum(b["area"] for b in r))
    row.sort(key=lambda b: b["x0"])
    print(f"cut: {len(row)} panels from row y={min(b['y0'] for b in row)}.."
          f"{max(b['y1'] for b in row)}")
    if panels and len(row) != panels:
        print(f"WARNING expected {panels} panels, found {len(row)}")

    out.mkdir(parents=True, exist_ok=True)
    report = []
    for i, b in enumerate(row):
        clean_crop = clean[b["y0"]:b["y1"] + 1, b["x0"]:b["x1"] + 1]
        alpha_crop = alpha[b["y0"]:b["y1"] + 1, b["x0"]:b["x1"] + 1]
        frame, stats = fit_frame(clean_crop, alpha_crop, canvas, figure_h, feet_y)
        name = f"{prefix}_{i:02d}.png"
        frame.save(out / name)
        report.append({"file": name, "source_box": [b["x0"], b["y0"], b["x1"], b["y1"]], **stats})
    meta = {"source": str(path), "background_rgb": ref.tolist(),
            "canvas": list(canvas), "figure_height": figure_h, "feet_y": feet_y,
            "frames": report}
    (out / "_report.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    contact_sheet(sorted(out.glob("*.png")), out / "_contact.png")
    print(f"wrote {len(report)} frames to {out}")
    return meta


def expand_inputs(paths: list[Path]) -> list[Path]:
    """Expand shell-style wildcards for native-callers that do not glob."""
    out: list[Path] = []
    for path in paths:
        text = str(path)
        if any(ch in text for ch in "*?["):
            parent = path.parent if str(path.parent) else Path(".")
            out.extend(sorted(parent.glob(path.name)))
        else:
            out.append(path)
    return [p for p in out if not p.name.startswith("_")]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Portable sprite-sheet extraction helpers")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("preflight", help="check a raw sheet before cutting")
    p.add_argument("image", type=Path)
    p.add_argument("--panels", type=int, default=4)
    p.add_argument("--min-gap", type=int, default=MIN_GAP)
    p.add_argument("--min-ratio", type=float, default=MIN_RATIO)
    p.add_argument("--min-figure-h", type=int, default=0)

    p = sub.add_parser("layout", help="measure the real panel grid")
    p.add_argument("image", type=Path)

    p = sub.add_parser("cut", help="cut panels into contract-sized PNG frames")
    p.add_argument("image", type=Path)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--prefix", default="frame")
    p.add_argument("--panels", type=int, default=4)
    p.add_argument("--canvas-w", type=int, default=CANVAS_W)
    p.add_argument("--canvas-h", type=int, default=CANVAS_H)
    p.add_argument("--figure-h", type=int, default=FIGURE_H)
    p.add_argument("--feet-y", type=int, default=FEET_Y)
    p.add_argument("--min-figure-h", type=int, default=8)
    p.add_argument("--tol", type=float, default=45.0)

    p = sub.add_parser("check", help="validate exported frames")
    p.add_argument("directory", type=Path)
    p.add_argument("--expect", type=int, default=4)
    p.add_argument("--canvas-w", type=int, default=CANVAS_W)
    p.add_argument("--canvas-h", type=int, default=CANVAS_H)
    p.add_argument("--figure-h", type=int, default=FIGURE_H)
    p.add_argument("--edge-min", type=int, default=EDGE_MIN)
    p.add_argument("--height-jitter", type=int, default=6)

    p = sub.add_parser("sheet", help="build a contact sheet from PNG frames")
    p.add_argument("images", type=Path, nargs="+")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--columns", type=int, default=4)
    p.add_argument("--cell", type=int, default=128)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "preflight":
        result = preflight(args.image, args.panels, args.min_gap,
                           min_ratio=args.min_ratio, min_figure_h=args.min_figure_h)
        return 0 if result["ok"] else 1
    if args.command == "layout":
        layout_report(args.image)
        return 0
    if args.command == "cut":
        cut_sheet(args.image, args.out, args.prefix, args.panels,
                  (args.canvas_w, args.canvas_h), args.figure_h, args.feet_y,
                  args.min_figure_h, args.tol)
        return 0
    if args.command == "check":
        ok = check_frames(args.directory, args.expect,
                          (args.canvas_w, args.canvas_h), args.figure_h,
                          args.edge_min, args.height_jitter)
        return 0 if ok else 1
    if args.command == "sheet":
        images = expand_inputs(args.images)
        if not images:
            print("FAIL no frames matched the input pattern")
            return 1
        contact_sheet(images, args.out, args.columns, args.cell)
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
