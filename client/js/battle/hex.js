// Stage 5c: client-side hex math + LOS — a JS port of server/game/battle/hex.ts
// and los.ts (the client is framework-free JS and cannot import the TS modules).
// Keep in sync with the server implementation.

export function hexKey(hex) {
  return `${hex.q},${hex.r}`;
}

export function hexEquals(a, b) {
  return a.q === b.q && a.r === b.r;
}

export function hexToCube(hex) {
  return { x: hex.q, y: -hex.q - hex.r, z: hex.r };
}

export function cubeToHex(cube) {
  return { q: cube.x, r: cube.z };
}

export function hexDistance(a, b) {
  const ac = hexToCube(a);
  const bc = hexToCube(b);
  return (Math.abs(ac.x - bc.x) + Math.abs(ac.y - bc.y) + Math.abs(ac.z - bc.z)) / 2;
}

export function cubeRound(cube) {
  let rx = Math.round(cube.x);
  let ry = Math.round(cube.y);
  let rz = Math.round(cube.z);
  const dx = Math.abs(rx - cube.x);
  const dy = Math.abs(ry - cube.y);
  const dz = Math.abs(rz - cube.z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { x: rx, y: ry, z: rz };
}

export function hexToPixel(hex, size) {
  const SQRT3 = Math.sqrt(3);
  return {
    x: size * (SQRT3 * hex.q + (SQRT3 / 2) * hex.r),
    y: size * 1.5 * hex.r,
  };
}

export function hexCorners(center, size) {
  const corners = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    corners.push({
      x: center.x + size * Math.cos(angle),
      y: center.y + size * Math.sin(angle),
    });
  }
  return corners;
}

export function inBounds(hex, mapWidth, mapHeight) {
  return hex.q >= 0 && hex.q < mapWidth && hex.r >= 0 && hex.r < mapHeight;
}

const DIRECTIONS = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function hexNeighbors(hex) {
  return DIRECTIONS.map((d) => ({ q: hex.q + d.q, r: hex.r + d.r }));
}

// Stage 5d: the server's move action is single-step, while the highlight
// contains every hex reachable within the AP budget. This BFS inside the
// allowed set turns one click into a sequence of adjacent moves.
export function buildPath(from, to, allowedKeys) {
  const targetKey = hexKey(to);
  if (!allowedKeys.has(targetKey)) return null;
  const startKey = hexKey(from);
  const prev = new Map([[startKey, null]]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift();
    const currentKey = hexKey(current);
    if (currentKey === targetKey) {
      const path = [];
      let key = targetKey;
      while (key !== startKey) {
        const node = prev.get(key);
        if (!node) return null;
        const [q, r] = key.split(',').map(Number);
        path.unshift({ q, r });
        key = node;
      }
      return path;
    }
    for (const nb of hexNeighbors(current)) {
      const key = hexKey(nb);
      if (prev.has(key)) continue;
      if (!allowedKeys.has(key)) continue;
      prev.set(key, currentKey);
      queue.push(nb);
    }
  }
  return null;
}

function lineHexes(from, to) {
  const n = hexDistance(from, to);
  if (n <= 1) return [];
  const EPS = 1e-6;
  const a = hexToCube(from);
  const b = hexToCube(to);
  const result = [];
  for (let i = 1; i < n; i++) {
    const t = (i + EPS) / n;
    result.push(
      cubeToHex(
        cubeRound({
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: a.z + (b.z - a.z) * t,
        }),
      ),
    );
  }
  return result;
}

export function hasLineOfSight({ from, to, obstacles, mapWidth, mapHeight }) {
  if (hexEquals(from, to)) return true;
  if (!inBounds(from, mapWidth, mapHeight) || !inBounds(to, mapWidth, mapHeight)) {
    return false;
  }
  const blocking = new Set(obstacles.filter((o) => o.blocksLos).map((o) => hexKey(o.hex)));
  for (const hex of lineHexes(from, to)) {
    if (!inBounds(hex, mapWidth, mapHeight)) return false;
    if (blocking.has(hexKey(hex))) return false;
  }
  return true;
}
