// Seeded map generation. The same (type, seed) always yields the same map.

export type MapType = 'field' | 'maze' | 'caves';
export const MAP_TYPES: MapType[] = ['field', 'maze', 'caves'];

export const SIZE = 23; // odd, so mazes have a cell at the centre
export const LOOT_COUNT = 10;

export interface GameMap {
  type: MapType;
  seed: number;
  size: number;
  walls: Uint8Array; // 1 = wall
  loot: Uint8Array; // 1 = loot at start of run
  start: { x: number; y: number };
  floorCount: number; // reachable floor tiles
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const idx = (x: number, y: number) => y * SIZE + x;
const onEdge = (x: number, y: number) => x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1;

export function generateMap(type: MapType, seed: number): GameMap {
  const rand = mulberry32(seed * 7919 + type.length * 104729);
  const c = (SIZE - 1) / 2;
  const start = { x: c, y: c };
  const walls = type === 'maze' ? maze(rand, start) : type === 'caves' ? caves(rand) : field(rand);

  // Clear the start area so every map begins with room to move.
  if (type !== 'maze') {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) walls[idx(c + dx, c + dy)] = 0;
  }

  // Wall off anything unreachable so "explored %" is always achievable.
  const reach = reachable(walls, start);
  let floorCount = 0;
  for (let i = 0; i < walls.length; i++) {
    if (!walls[i] && !reach[i]) walls[i] = 1;
    if (!walls[i]) floorCount++;
  }

  const loot = new Uint8Array(SIZE * SIZE);
  const floor: number[] = [];
  for (let i = 0; i < walls.length; i++) if (!walls[i] && i !== idx(start.x, start.y)) floor.push(i);
  for (let n = 0; n < LOOT_COUNT && floor.length > 0; n++) {
    const pick = Math.floor(rand() * floor.length);
    loot[floor[pick]] = 1;
    floor.splice(pick, 1);
  }

  return { type, seed, size: SIZE, walls, loot, start, floorCount };
}

function field(rand: () => number): Uint8Array {
  const w = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    w[idx(x, y)] = onEdge(x, y) || rand() < 0.14 ? 1 : 0;
  }
  return w;
}

function maze(rand: () => number, start: { x: number; y: number }): Uint8Array {
  const w = new Uint8Array(SIZE * SIZE).fill(1);
  const stack = [start];
  w[idx(start.x, start.y)] = 0;
  const dirs = [[0, -2], [2, 0], [0, 2], [-2, 0]];
  while (stack.length) {
    const cur = stack[stack.length - 1];
    const options = dirs
      .map(([dx, dy]) => ({ x: cur.x + dx, y: cur.y + dy, mx: cur.x + dx / 2, my: cur.y + dy / 2 }))
      .filter((n) => n.x > 0 && n.y > 0 && n.x < SIZE - 1 && n.y < SIZE - 1 && w[idx(n.x, n.y)] === 1);
    if (!options.length) { stack.pop(); continue; }
    const n = options[Math.floor(rand() * options.length)];
    w[idx(n.mx, n.my)] = 0;
    w[idx(n.x, n.y)] = 0;
    stack.push({ x: n.x, y: n.y });
  }
  return w;
}

function caves(rand: () => number): Uint8Array {
  let w = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) w[idx(x, y)] = onEdge(x, y) || rand() < 0.43 ? 1 : 0;
  for (let iter = 0; iter < 4; iter++) {
    const next = new Uint8Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      if (onEdge(x, y)) { next[idx(x, y)] = 1; continue; }
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += w[idx(x + dx, y + dy)];
      next[idx(x, y)] = n >= 5 ? 1 : 0;
    }
    w = next;
  }
  return w;
}

function reachable(walls: Uint8Array, start: { x: number; y: number }): Uint8Array {
  const seen = new Uint8Array(SIZE * SIZE);
  const queue = [idx(start.x, start.y)];
  seen[queue[0]] = 1;
  while (queue.length) {
    const i = queue.pop()!;
    const x = i % SIZE, y = Math.floor(i / SIZE);
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const j = idx(x + dx, y + dy);
      if (!walls[j] && !seen[j]) { seen[j] = 1; queue.push(j); }
    }
  }
  return seen;
}
