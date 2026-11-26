// Stage 5c: hex math — pure functions, axial coordinates (pointy-top).
// Coordinates in BattleState are axial {q, r}; the battle map is treated as
// the rectangle 0 <= q < width, 0 <= r < height in axial space.

export interface HexCoord {
  q: number;
  r: number;
}

export interface Cube {
  x: number;
  y: number;
  z: number;
}

export interface Point {
  x: number;
  y: number;
}

// Axial neighbor directions in order: E, NE, NW, W, SW, SE.
const DIRECTIONS: HexCoord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function hexToCube(hex: HexCoord): Cube {
  return { x: hex.q, z: hex.r, y: -hex.q - hex.r };
}

export function cubeToHex(cube: Cube): HexCoord {
  return { q: cube.x, r: cube.z };
}

export function hexDistance(a: HexCoord, b: HexCoord): number {
  const ac = hexToCube(a);
  const bc = hexToCube(b);
  return (Math.abs(ac.x - bc.x) + Math.abs(ac.y - bc.y) + Math.abs(ac.z - bc.z)) / 2;
}

export function hexNeighbors(hex: HexCoord): HexCoord[] {
  return DIRECTIONS.map((d) => hexAdd(hex, d));
}

export function hexEquals(a: HexCoord, b: HexCoord): boolean {
  return a.q === b.q && a.r === b.r;
}

export function hexAdd(a: HexCoord, b: HexCoord): HexCoord {
  return { q: a.q + b.q, r: a.r + b.r };
}

export function hexKey(hex: HexCoord): string {
  return `${hex.q},${hex.r}`;
}

// --- Pixels (pointy-top); size = center-to-corner radius ---

const SQRT3 = Math.sqrt(3);

export function hexToPixel(hex: HexCoord, size: number): Point {
  return {
    x: size * (SQRT3 * hex.q + (SQRT3 / 2) * hex.r),
    y: size * (1.5 * hex.r),
  };
}

export function pixelToHex(point: Point, size: number): HexCoord {
  const q = ((SQRT3 / 3) * point.x - (1 / 3) * point.y) / size;
  const r = ((2 / 3) * point.y) / size;
  return cubeToHex(cubeRound({ x: q, y: -q - r, z: r }));
}

// Standard cube rounding: round all axes, then fix the axis with the
// largest rounding error so that x + y + z === 0.
export function cubeRound(cube: Cube): Cube {
  let rx = Math.round(cube.x);
  let ry = Math.round(cube.y);
  let rz = Math.round(cube.z);
  const dx = Math.abs(rx - cube.x);
  const dy = Math.abs(ry - cube.y);
  const dz = Math.abs(rz - cube.z);
  if (dx > dy && dx > dz) {
    rx = -ry - rz;
  } else if (dy > dz) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }
  return { x: rx, y: ry, z: rz };
}

// 6 corners of a pointy-top hexagon for <polygon points="...">.
export function hexCorners(center: Point, size: number): Point[] {
  const corners: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    corners.push({
      x: center.x + size * Math.cos(angle),
      y: center.y + size * Math.sin(angle),
    });
  }
  return corners;
}

// Linear interpolation between two hexes in cube space (for LOS).
export function hexLerpCube(a: Cube, b: Cube, t: number): Cube {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}
