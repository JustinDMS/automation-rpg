// A single run: one adventurer, one map, one program, a fixed tick budget.
// The program repeats forever (the implicit loop is the idle engine); the run ends when
// the budget is spent or every floor tile has been revealed.

import type { Action, Cond, Program, Sensor, Stmt, Var } from './lang';
import { generateMap, mulberry32, type GameMap, type MapType } from './map';

export const TICK_BUDGET = 300;
/** Control-flow steps allowed per tick before the adventurer stalls (guards `while` with no actions). */
export const OPS_PER_TICK = 64;

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

export interface World {
  map: GameMap;
  x: number;
  y: number;
  dir: number; // 0 N, 1 E, 2 S, 3 W
  revealed: Uint8Array;
  visited: Uint8Array;
  loot: Uint8Array;
  lootGot: number;
  revealedFloor: number;
  tick: number;
  bumps: number;
  stalls: number;
  vars: Record<Var, number>;
  /** Seeded per map, so runs stay deterministic and benchmarks reproducible. */
  rand: () => number;
}

type Yield = { kind: 'act'; a: Action; id: string } | { kind: 'stall'; id: string | null };

export function createWorld(map: GameMap): World {
  const n = map.size * map.size;
  const w: World = {
    map, x: map.start.x, y: map.start.y, dir: 0,
    revealed: new Uint8Array(n), visited: new Uint8Array(n), loot: map.loot.slice(),
    lootGot: 0, revealedFloor: 0, tick: 0, bumps: 0, stalls: 0, vars: { a: 0, b: 0 },
    rand: mulberry32(map.seed ^ 0x5bd1e995),
  };
  w.visited[w.y * map.size + w.x] = 1;
  reveal(w);
  return w;
}

function reveal(w: World) {
  const s = w.map.size;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = w.x + dx, y = w.y + dy;
    if (x < 0 || y < 0 || x >= s || y >= s) continue;
    const i = y * s + x;
    if (!w.revealed[i]) {
      w.revealed[i] = 1;
      if (!w.map.walls[i]) w.revealedFloor++;
    }
  }
}

/** Index of the tile at a direction relative to facing: 0 ahead, -1 left, +1 right. */
function rel(w: World, turn: number): number {
  const d = (w.dir + turn + 4) % 4;
  return (w.y + DY[d]) * w.map.size + (w.x + DX[d]);
}

export function sense(w: World, s: Sensor): boolean {
  switch (s) {
    case 'wall_ahead': return w.map.walls[rel(w, 0)] === 1;
    case 'wall_left': return w.map.walls[rel(w, -1)] === 1;
    case 'wall_right': return w.map.walls[rel(w, 1)] === 1;
    case 'visited_ahead': return w.visited[rel(w, 0)] === 1;
    case 'loot_ahead': return w.loot[rel(w, 0)] === 1;
    case 'coin': return w.rand() < 0.5;
  }
}

function evalCond(w: World, c: Cond): boolean {
  let v: boolean;
  if (c.k === 'sensor') v = sense(w, c.s);
  else {
    const x = w.vars[c.v];
    v = c.op === '==' ? x === c.n : c.op === '<' ? x < c.n : x > c.n;
  }
  return c.neg ? !v : v;
}

export function applyAction(w: World, a: Action) {
  if (a === 'turn_left') w.dir = (w.dir + 3) % 4;
  else if (a === 'turn_right') w.dir = (w.dir + 1) % 4;
  else if (a === 'forward') {
    const i = rel(w, 0);
    if (w.map.walls[i]) w.bumps++;
    else {
      w.x += DX[w.dir];
      w.y += DY[w.dir];
      w.visited[i] = 1;
      if (w.loot[i]) { w.loot[i] = 0; w.lootGot++; }
      reveal(w);
    }
  }
  w.tick++;
}

function* exec(block: Stmt[], w: World, ops: { n: number }): Generator<Yield, void> {
  for (const s of block) {
    if (++ops.n > OPS_PER_TICK) { ops.n = 0; yield { kind: 'stall', id: s.id }; }
    switch (s.k) {
      case 'act': ops.n = 0; yield { kind: 'act', a: s.a, id: s.id }; break;
      case 'set': w.vars[s.v] = s.n; break;
      case 'add': w.vars[s.v] += s.n; break;
      case 'if':
        if (evalCond(w, s.c)) yield* exec(s.body, w, ops);
        else if (s.orelse) yield* exec(s.orelse, w, ops);
        break;
      case 'repeat':
        for (let i = 0; i < s.n; i++) {
          if (++ops.n > OPS_PER_TICK) { ops.n = 0; yield { kind: 'stall', id: s.id }; }
          yield* exec(s.body, w, ops);
        }
        break;
      case 'while':
        while (evalCond(w, s.c)) {
          if (++ops.n > OPS_PER_TICK) { ops.n = 0; yield { kind: 'stall', id: s.id }; }
          yield* exec(s.body, w, ops);
        }
        break;
    }
  }
}

function* forever(p: Program, w: World): Generator<Yield, void> {
  const ops = { n: 0 };
  for (;;) {
    if (++ops.n > OPS_PER_TICK) { ops.n = 0; yield { kind: 'stall', id: null }; }
    yield* exec(p, w, ops);
  }
}

export class Run {
  readonly world: World;
  /** The statement that produced the most recent tick, for the debugger highlight. */
  currentId: string | null = null;
  private gen: Generator<Yield, void>;

  constructor(program: Program, map: GameMap, readonly budget = TICK_BUDGET) {
    this.world = createWorld(map);
    this.gen = forever(program, this.world);
  }

  get done(): boolean {
    return this.world.tick >= this.budget || this.world.revealedFloor >= this.world.map.floorCount;
  }

  /** Advance one tick. Returns false once the run is over. */
  step(): boolean {
    if (this.done) return false;
    const y = this.gen.next().value!;
    this.currentId = y.id;
    if (y.kind === 'act') applyAction(this.world, y.a);
    else { this.world.stalls++; this.world.tick++; }
    return !this.done;
  }

  finish(): World {
    while (this.step());
    return this.world;
  }
}

// ---- Benchmark: score a program on fixed hidden seeds (leaderboard-ready) ----

export const BENCH_SEEDS = [101, 202, 303, 404, 505];

export interface BenchResult {
  type: MapType;
  explored: number; // average % of floor revealed, 0-100
  ticks: number; // average ticks used (lower is better when fully explored)
  fullRuns: number; // seeds explored 100%
  loot: number; // average loot collected
}

export function benchmark(p: Program, type: MapType): BenchResult {
  let explored = 0, ticks = 0, fullRuns = 0, loot = 0;
  for (const seed of BENCH_SEEDS) {
    const w = new Run(p, generateMap(type, seed)).finish();
    const pct = (100 * w.revealedFloor) / w.map.floorCount;
    explored += pct;
    ticks += w.tick;
    loot += w.lootGot;
    if (w.revealedFloor >= w.map.floorCount) fullRuns++;
  }
  const n = BENCH_SEEDS.length;
  return { type, explored: Math.round((explored / n) * 10) / 10, ticks: Math.round(ticks / n), fullRuns, loot: Math.round((loot / n) * 10) / 10 };
}
