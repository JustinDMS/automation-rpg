import { describe, expect, test } from 'vitest';
import {
  insertStmt, makeStmt, moveStmt, removeStmt, slotCount, toText, wrapStmt,
  type Action, type Cond, type Program, type Sensor, type Stmt,
} from './lang';
import { generateMap, MAP_TYPES } from './map';
import { benchmark, Run } from './run';
import { evaluateTrial, kindsForTier, TIERS } from './progress';

let n = 0;
const act = (a: Action): Stmt => ({ id: `a${n++}`, k: 'act', a });
const sensor = (s: Sensor, neg = false): Cond => ({ k: 'sensor', s, neg });
const iff = (c: Cond, body: Stmt[], orelse: Stmt[] | null = null): Stmt => ({ id: `i${n++}`, k: 'if', c, body, orelse });

/** A reference solution per tier goal, using only earlier tiers' language and earning the bonus star. */
const REFERENCE: Record<number, Program> = {
  1: [act('forward'), act('forward'), act('forward'), act('forward'), act('turn_right')],
  2: [iff(sensor('wall_right', true), [act('turn_right'), act('forward')], [iff(sensor('wall_ahead'), [act('turn_left')], [act('forward')])])],
  3: [iff(sensor('wall_ahead'), [iff(sensor('coin'), [act('turn_right')], [act('turn_left')])], [act('forward')])],
};

function kindsUsed(p: Program, out = new Set<string>()): Set<string> {
  for (const s of p) {
    out.add(s.k);
    if (s.k === 'if') { kindsUsed(s.body, out); if (s.orelse) kindsUsed(s.orelse, out); }
    if (s.k === 'repeat' || s.k === 'while') kindsUsed(s.body, out);
  }
  return out;
}

describe('maps', () => {
  test('are deterministic per seed', () => {
    for (const t of MAP_TYPES) expect(generateMap(t, 7).walls).toEqual(generateMap(t, 7).walls);
  });
  test('have a clear start and reachable floor', () => {
    for (const t of MAP_TYPES) for (let seed = 1; seed < 30; seed++) {
      const m = generateMap(t, seed);
      expect(m.walls[m.start.y * m.size + m.start.x]).toBe(0);
      expect(m.floorCount).toBeGreaterThan(60);
    }
  });
});

describe('interpreter', () => {
  test('an empty program stalls instead of hanging', () => {
    const w = new Run([], generateMap('field', 1)).finish();
    expect(w.tick).toBe(300);
    expect(w.stalls).toBe(300);
  });
  test('a while loop with no actions stalls instead of hanging', () => {
    const p: Program = [{ id: 'w', k: 'while', c: sensor('wall_ahead', true), body: [{ id: 's', k: 'add', v: 'a', n: 1 }] }];
    expect(new Run(p, generateMap('field', 1)).finish().tick).toBe(300);
  });
  test('runs are deterministic, coin flips included', () => {
    const a = benchmark(REFERENCE[3], 'caves');
    const b = benchmark(REFERENCE[3], 'caves');
    expect(a).toEqual(b);
  });
  test('repeat and variables work', () => {
    const p: Program = [{ id: 'r', k: 'repeat', n: 3, body: [{ id: 'x', k: 'add', v: 'b', n: 2 }, act('wait')] }];
    const run = new Run(p, generateMap('field', 1));
    for (let i = 0; i < 3; i++) run.step();
    expect(run.world.vars.b).toBe(6);
  });
});

describe('progression', () => {
  test.each(TIERS.filter((t) => t.goal).map((t) => [t.tier, t] as const))('tier %i goal is reachable, star included', (tier, t) => {
    const p = REFERENCE[tier];
    const allowed = kindsForTier(tier - 1);
    for (const k of kindsUsed(p)) expect(allowed.has(k as never)).toBe(true);
    expect(slotCount(p)).toBeLessThanOrEqual(t.goal!.starLines);
    expect(benchmark(p, t.goal!.type).explored).toBeGreaterThanOrEqual(t.goal!.explored);
  });
  test('goals unlock in order and award stars', () => {
    expect(evaluateTrial(0, [], 'maze', 90, 3).tier).toBe(0); // the field goal comes first
    const first = evaluateTrial(0, [], 'field', 12, 9);
    expect(first).toMatchObject({ tier: 1, unlocked: 1, stars: [] }); // too long for the star
    const again = evaluateTrial(1, first.stars, 'field', 12, 5);
    expect(again).toMatchObject({ tier: 1, unlocked: null, newStars: [1] });
  });
});

describe('tree editing', () => {
  test('insert, wrap, move, remove', () => {
    let p: Program = [];
    const f = act('forward'), t = act('turn_left');
    p = insertStmt(p, { parent: null, slot: 'body' }, 0, f);
    p = insertStmt(p, { parent: null, slot: 'body' }, 1, t);
    p = wrapStmt(p, f.id, 'repeat');
    expect(slotCount(p)).toBe(3);
    expect(toText(p)).toBe('repeat 2:\n    forward()\nturn_left()\n');
    p = moveStmt(p, t.id, -1);
    expect(p[0].id).toBe(t.id);
    p = removeStmt(p, f.id);
    expect(slotCount(p)).toBe(2);
    const inner = makeStmt('act', 'wait');
    p = insertStmt(p, { parent: p[1].id, slot: 'body' }, 0, inner);
    expect(toText(p)).toContain('    wait()');
  });
});
