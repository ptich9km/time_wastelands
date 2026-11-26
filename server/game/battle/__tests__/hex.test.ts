import { describe, it, expect } from 'vitest';
import {
  hexDistance,
  hexNeighbors,
  hexToCube,
  cubeToHex,
  hexToPixel,
  pixelToHex,
  hexKey,
  hexEquals,
  hexAdd,
  hexCorners,
  type HexCoord,
} from '../hex';

describe('hexDistance', () => {
  it('(0,0) → (0,0) = 0', () => {
    expect(hexDistance({ q: 0, r: 0 }, { q: 0, r: 0 })).toBe(0);
  });
  it('(0,0) → (1,0) = 1', () => {
    expect(hexDistance({ q: 0, r: 0 }, { q: 1, r: 0 })).toBe(1);
  });
  it('(0,0) → (0,1) = 1', () => {
    expect(hexDistance({ q: 0, r: 0 }, { q: 0, r: 1 })).toBe(1);
  });
  it('(0,0) → (2,-1) = 2', () => {
    expect(hexDistance({ q: 0, r: 0 }, { q: 2, r: -1 })).toBe(2);
  });
  it('симметрично', () => {
    expect(hexDistance({ q: 3, r: -2 }, { q: -1, r: 5 })).toBe(hexDistance({ q: -1, r: 5 }, { q: 3, r: -2 }));
  });
});

describe('hexNeighbors', () => {
  it('6 соседей', () => {
    expect(hexNeighbors({ q: 0, r: 0 })).toHaveLength(6);
  });
  it('порядок E, NE, NW, W, SW, SE', () => {
    expect(hexNeighbors({ q: 0, r: 0 })).toEqual([
      { q: 1, r: 0 },
      { q: 1, r: -1 },
      { q: 0, r: -1 },
      { q: -1, r: 0 },
      { q: -1, r: 1 },
      { q: 0, r: 1 },
    ]);
  });
  it('все соседи на расстоянии 1', () => {
    const c = { q: 3, r: 4 };
    for (const nb of hexNeighbors(c)) {
      expect(hexDistance(c, nb)).toBe(1);
    }
  });
});

describe('cube conversion', () => {
  it('hexToCube((1,2)) → {x:1, y:-3, z:2}', () => {
    expect(hexToCube({ q: 1, r: 2 })).toEqual({ x: 1, y: -3, z: 2 });
  });
  it('cubeToHex — обратное преобразование', () => {
    expect(cubeToHex({ x: 1, y: -3, z: 2 })).toEqual({ q: 1, r: 2 });
  });
});

describe('helpers', () => {
  it('hexKey формат "q,r"', () => {
    expect(hexKey({ q: -3, r: 7 })).toBe('-3,7');
  });
  it('hexEquals', () => {
    expect(hexEquals({ q: 1, r: 2 }, { q: 1, r: 2 })).toBe(true);
    expect(hexEquals({ q: 1, r: 2 }, { q: 2, r: 1 })).toBe(false);
  });
  it('hexAdd', () => {
    expect(hexAdd({ q: 1, r: -2 }, { q: 3, r: 4 })).toEqual({ q: 4, r: 2 });
  });
  it('hexCorners возвращает 6 углов на радиусе size', () => {
    const corners = hexCorners({ x: 10, y: 20 }, 28);
    expect(corners).toHaveLength(6);
    for (const c of corners) {
      expect(Math.hypot(c.x - 10, c.y - 20)).toBeCloseTo(28);
    }
  });
});

describe('hexToPixel / pixelToHex', () => {
  it('точки гекса (0,0) — начало координат', () => {
    expect(hexToPixel({ q: 0, r: 0 }, 28)).toEqual({ x: 0, y: 0 });
  });
  it('round-trip для 100 случайных гексов', () => {
    let seed = 42;
    const rand = () => {
      // deterministic LCG so the test never flakes
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 100; i++) {
      const hex: HexCoord = {
        q: Math.floor(rand() * 41) - 20,
        r: Math.floor(rand() * 41) - 20,
      };
      const size = 10 + rand() * 40;
      const back = pixelToHex(hexToPixel(hex, size), size);
      expect(hexDistance(back, hex)).toBeLessThanOrEqual(1);
      expect(back).toEqual(hex); // round-trip through the exact center is exact
    }
  });
});
