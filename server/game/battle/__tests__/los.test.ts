import { describe, it, expect } from 'vitest';
import {
  hasLineOfSight, hasMeleePath, canMoveTo, reachableHexes, lineHexes, inBounds,
} from '../los';
import { hexKey, type HexCoord } from '../hex';
import type { Obstacle } from '../state';

// Test maps: empty 5×5, 5×5 with a wall in the center, 5×5 with a corner wall.
const W = 5;
const H = 5;

const wall = (q: number, r: number): Obstacle => ({
  hex: { q, r },
  type: 'wall',
  blocksLos: true,
  blocksMove: true,
  blocksMelee: true,
});
const crate = (q: number, r: number): Obstacle => ({
  hex: { q, r },
  type: 'crate',
  blocksLos: false,
  blocksMove: true,
  blocksMelee: false,
});
const barricade = (q: number, r: number): Obstacle => ({
  hex: { q, r },
  type: 'barricade',
  blocksLos: false,
  blocksMove: true,
  blocksMelee: true,
});
const bush = (q: number, r: number): Obstacle => ({
  hex: { q, r },
  type: 'bush',
  blocksLos: false,
  blocksMove: false,
  blocksMelee: false,
});

function los(from: HexCoord, to: HexCoord, obstacles: Obstacle[] = []): boolean {
  return hasLineOfSight({ from, to, obstacles, mapWidth: W, mapHeight: H });
}

describe('hasLineOfSight', () => {
  it('from === to → true', () => {
    expect(los({ q: 2, r: 2 }, { q: 2, r: 2 })).toBe(true);
  });

  it('соседи без препятствий → true', () => {
    expect(los({ q: 2, r: 2 }, { q: 3, r: 2 })).toBe(true);
  });

  it('пустая карта: любые две точки видят друг друга', () => {
    expect(los({ q: 0, r: 0 }, { q: 4, r: 4 })).toBe(true);
    expect(los({ q: 0, r: 4 }, { q: 4, r: 0 })).toBe(true);
  });

  it('LOS через стену (blocksLos: true) → false', () => {
    expect(los({ q: 0, r: 2 }, { q: 4, r: 2 }, [wall(2, 2)])).toBe(false);
  });

  it('LOS через crate (blocksLos: false) → true', () => {
    expect(los({ q: 0, r: 2 }, { q: 4, r: 2 }, [crate(2, 2)])).toBe(true);
  });

  it('стена на линии (from (0,0) → to (2,2), стена в (1,1)) → false', () => {
    // axial distance (0,0)→(2,2) = 4; линия проходит через (1,0), (1,1), (2,1)
    expect(lineHexes({ q: 0, r: 0 }, { q: 2, r: 2 })).toEqual([
      { q: 1, r: 0 },
      { q: 1, r: 1 },
      { q: 2, r: 1 },
    ]);
    expect(los({ q: 0, r: 0 }, { q: 2, r: 2 }, [wall(1, 1)])).toBe(false);
  });

  it('стена НЕ на линии → true', () => {
    expect(los({ q: 0, r: 0 }, { q: 2, r: 2 }, [wall(0, 2)])).toBe(true);
  });

  it('гекс стрелка/цели не блокирует сам себя', () => {
    // wall type on the target hex — target still visible
    expect(los({ q: 0, r: 0 }, { q: 2, r: 0 }, [wall(2, 0)])).toBe(true);
    expect(los({ q: 0, r: 0 }, { q: 2, r: 0 }, [wall(0, 0)])).toBe(true);
  });

  it('цель за границей карты → false', () => {
    expect(los({ q: 0, r: 0 }, { q: 7, r: 0 })).toBe(false);
  });

  it('стрелок за границей карты → false', () => {
    expect(los({ q: -1, r: 0 }, { q: 2, r: 0 })).toBe(false);
  });

  it('lineHexes соседей — пусто', () => {
    expect(lineHexes({ q: 1, r: 1 }, { q: 2, r: 1 })).toEqual([]);
  });
});

describe('hasMeleePath', () => {
  const melee = (
    from: HexCoord,
    to: HexCoord,
    obstacles: Obstacle[] = [],
  ): boolean => hasMeleePath({ from, to, obstacles, mapWidth: W, mapHeight: H });

  it('путь без препятствий → true', () => {
    expect(melee({ q: 0, r: 2 }, { q: 4, r: 2 })).toBe(true);
  });

  it('barricade на линии → false, хотя LOS сквозь неё проходит', () => {
    const obstacles = [barricade(2, 2)];
    expect(melee({ q: 0, r: 2 }, { q: 4, r: 2 }, obstacles)).toBe(false);
    expect(los({ q: 0, r: 2 }, { q: 4, r: 2 }, obstacles)).toBe(true);
  });

  it('crate и bush на линии не блокируют удар', () => {
    expect(melee({ q: 0, r: 2 }, { q: 4, r: 2 }, [crate(2, 2)])).toBe(true);
    expect(melee({ q: 0, r: 2 }, { q: 4, r: 2 }, [bush(2, 2)])).toBe(true);
  });

  it('wall на линии → false', () => {
    expect(melee({ q: 0, r: 2 }, { q: 4, r: 2 }, [wall(2, 2)])).toBe(false);
  });

  it('позиционная форма hasMeleePath(from, to, obstacles)', () => {
    expect(
      hasMeleePath({ q: 0, r: 2 }, { q: 4, r: 2 }, [barricade(2, 2)]),
    ).toBe(false);
  });
});

describe('inBounds', () => {
  it('границы [0..w-1] × [0..h-1]', () => {
    expect(inBounds({ q: 0, r: 0 }, W, H)).toBe(true);
    expect(inBounds({ q: 4, r: 4 }, W, H)).toBe(true);
    expect(inBounds({ q: 5, r: 0 }, W, H)).toBe(false);
    expect(inBounds({ q: 0, r: -1 }, W, H)).toBe(false);
  });
});

describe('canMoveTo', () => {
  const base = {
    from: { q: 2, r: 2 } as HexCoord,
    obstacles: [] as Obstacle[],
    occupiedHexes: [] as HexCoord[],
    mapWidth: W,
    mapHeight: H,
  };

  it('сосед, свободен → ok', () => {
    expect(canMoveTo({ ...base, to: { q: 3, r: 2 } })).toEqual({ ok: true });
  });
  it('сосед, стена → blocked', () => {
    expect(canMoveTo({ ...base, to: { q: 3, r: 2 }, obstacles: [wall(3, 2)] })).toEqual({
      ok: false,
      reason: 'blocked',
    });
  });
  it('сосед, crate (blocksMove) → blocked', () => {
    expect(canMoveTo({ ...base, to: { q: 3, r: 2 }, obstacles: [crate(3, 2)] })).toEqual({
      ok: false,
      reason: 'blocked',
    });
  });
  it('сосед, занят → occupied', () => {
    expect(canMoveTo({ ...base, to: { q: 3, r: 2 }, occupiedHexes: [{ q: 3, r: 2 }] })).toEqual({
      ok: false,
      reason: 'occupied',
    });
  });
  it('не сосед → not_adjacent', () => {
    expect(canMoveTo({ ...base, to: { q: 4, r: 2 } })).toEqual({
      ok: false,
      reason: 'not_adjacent',
    });
  });
  it('тот же гекс → not_adjacent', () => {
    expect(canMoveTo({ ...base, to: { q: 2, r: 2 } })).toEqual({
      ok: false,
      reason: 'not_adjacent',
    });
  });
  it('за границу → out_of_bounds', () => {
    expect(canMoveTo({ ...base, from: { q: 4, r: 4 }, to: { q: 5, r: 4 } })).toEqual({
      ok: false,
      reason: 'out_of_bounds',
    });
  });
});

describe('reachableHexes', () => {
  const base = {
    from: { q: 2, r: 2 } as HexCoord,
    obstacles: [] as Obstacle[],
    occupiedHexes: [] as HexCoord[],
    mapWidth: W,
    mapHeight: H,
  };

  it('1 шаг, без препятствий → 6 гексов', () => {
    const r = reachableHexes({ ...base, maxSteps: 1 });
    expect(r.size).toBe(6);
    expect(r.has('2,2')).toBe(false); // старт не входит
  });

  it('2 шага, без препятствий → 18 гексов', () => {
    expect(reachableHexes({ ...base, maxSteps: 2 }).size).toBe(18);
  });

  it('1 шаг, стена на соседе → 5 гексов', () => {
    const r = reachableHexes({ ...base, maxSteps: 1, obstacles: [wall(3, 2)] });
    expect(r.size).toBe(5);
    expect(r.has('3,2')).toBe(false);
  });

  it('занятый гекс недостижим и не проходим', () => {
    const r = reachableHexes({ ...base, maxSteps: 2, occupiedHexes: [{ q: 3, r: 2 }] });
    expect(r.size).toBe(16); // 18 − (3,2) − отрезанный (4,2)
    expect(r.has('3,2')).toBe(false);
    // (4,2) достижим только через (3,2) — единственного общего соседа → отрезан
    expect(r.has('4,2')).toBe(false);
  });

  it('у края карты соседи обрезаются границей', () => {
    const r = reachableHexes({ ...base, from: { q: 0, r: 0 }, maxSteps: 1 });
    // из (0,0) в границах 5×5 остаются только (1,0) и (0,1)
    expect(r.size).toBe(2);
  });

  it('0 шагов → пусто', () => {
    expect(reachableHexes({ ...base, maxSteps: 0 }).size).toBe(0);
  });

  it('возвращает hexKey-строки', () => {
    const r = reachableHexes({ ...base, maxSteps: 1 });
    expect(r.has(hexKey({ q: 3, r: 2 }))).toBe(true);
  });
});
