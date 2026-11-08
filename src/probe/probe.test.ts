import { describe, expect, test } from 'vitest';
import { format, redeclarable, Session } from './sandbox';
import { advance, api, createWorld, RATIONS, REGROW_TICKS, upgradeState, type State } from './world';

function session(seed: number) {
  const state = createWorld(seed);
  const lines: string[] = [];
  const s = new Session({ state: () => state, speed: () => 1e9, log: (l, c) => lines.push(`${c}: ${l}`), changed: () => {} });
  const errors = () => lines.filter((l) => l.startsWith('error'));
  return { state, lines, s, errors };
}

describe('probe world', () => {
  test('is deterministic', () => {
    const a = createWorld(3), b = createWorld(3);
    expect(a.places).toEqual(b.places);
    api.go(a, a.places[1]); api.go(b, b.places[1]);
    expect(a).toEqual(b);
  });

  test('speaks in prose and help answers', () => {
    const w = createWorld(1);
    expect(api.look(w).log[0]).toMatch(/^Camp\. /);
    const first = api.go(w, w.places.find((p) => p.discovered && p.kind !== 'camp')).log[0];
    expect(first).toMatch(/^You walk \d+ leagues? [NESW]+\. |choose\('/); // arrival, or an encounter on the way
    expect(api.help(w, 'go').log[0]).toMatch(/^go\(place\) +walk/);
    expect(api.help(w, 'GO').log[0]).toMatch(/^go\(place\)/);
    const target = createWorld(1).places.find((p) => p.discovered && p.kind !== 'camp')!.name;
    expect(api.go(createWorld(1), ` ${target.toUpperCase()} `).result).not.toHaveProperty('__error'); // names are case-insensitive
    expect(api.go(createWorld(1), 'nowhere').result).toHaveProperty('__error');
    expect(api.help(w, null).log.length).toBeGreaterThan(10);
  });
});

describe('session', () => {
  test('the library file defines things; saving again replaces them', async () => {
    const { s, lines, errors } = session(1);
    expect(await s.loadLibrary('const camp = () => known().find(p => p.kind === "camp")\nfunction twice(f) { f(); f(); }\nclass Bag { size() { return 3 } }')).toBe(true);
    await s.eval('camp().name');
    expect(lines.at(-1)).toBe('value: Camp');
    await s.eval('twice(() => gather())');
    expect(lines.filter((l) => l.includes('Nothing to gather')).length).toBe(2);
    expect(await s.loadLibrary('const camp = () => 7\nclass Bag { size() { return 4 } }')).toBe(true); // no redeclaration errors
    await s.eval('camp() + new Bag().size()');
    expect(lines.at(-1)).toBe('value: 11');
    expect(errors()).toEqual([]);
    await s.eval('library()');
    expect(lines.at(-1)).toMatch(/^print: const camp = \(\) => 7/);
    expect(redeclarable('const a = 1\n  const inner = 2\nclass B {}')).toBe('var a = 1\n  const inner = 2\nvar B = class B {}');
  });

  test('a library that acts on the world, or has a syntax error, is reported and the session survives', async () => {
    const { s, lines, errors } = session(1);
    expect(await s.loadLibrary('const f = () => gather()\nconst y = f()')).toBe(false);
    expect(errors().at(-1)).toMatch(/^error: library line \d+: Error: gather\(\) ran while loading the library/);
    expect(lines.some((l) => l.startsWith('event:'))).toBe(false); // it did not gather
    expect(await s.loadLibrary('const g = (')).toBe(false);
    expect(errors().at(-1)).toMatch(/SyntaxError/);
    await s.eval('typeof f');
    expect(lines.at(-1)).toBe('value: function');
  });

  test('console definitions work for the session and can be retyped', async () => {
    const { s, lines, errors } = session(1);
    await s.eval('const gather_x = (x) => x * 2');
    await s.eval('const gather_x = (x) => x * 3');
    await s.eval('gather_x(2)');
    expect(lines.at(-1)).toBe('value: 6');
    expect(errors()).toEqual([]);
  });

  test('prose suppresses the echo; data calls echo as rows', async () => {
    const { s, lines } = session(1);
    await s.eval('look()');
    expect(lines.some((l) => l.startsWith('value:'))).toBe(false);
    await s.eval('known()');
    const echo = lines.filter((l) => l.startsWith('value:'));
    expect(echo.length).toBe(1);
    expect(echo[0]).toMatch(/Camp/);
    expect(echo[0]).not.toMatch(/[{}"]/);
  });

  test('a naive loop banks gold; a smarter one banks more', async () => {
    const naive = session(7), smart = session(7);
    await naive.s.eval(`for (let i = 0; i < 60; i++) { go(known()[1]); gather(); go('Camp'); }`);
    await smart.s.loadLibrary(SMART);
    await smart.s.eval(`for (let i = 0; i < 60; i++) trip()`);
    expect(naive.errors()).toEqual([]);
    expect(smart.errors()).toEqual([]);
    expect(naive.state.gold).toBeGreaterThan(0);
    expect(smart.state.gold).toBeGreaterThan(naive.state.gold);
  });

  test('runaway loops and bad calls are reported, and the session survives', { timeout: 30000 }, async () => {
    const { s, lines, errors } = session(2);
    await s.eval('while (true) {}');
    expect(errors().at(-1)).toMatch(/interrupted/);
    await s.eval('while (true) { print(here()); }');
    expect(errors().at(-1)).toMatch(/interrupted/);
    await s.eval("go('Nowhere')");
    expect(errors().at(-1)).toMatch(/unknown place/);
    await s.eval('1 + 1');
    expect(lines.at(-1)).toBe('value: 2');
  });

  test('inputs sent while busy are queued, not dropped', async () => {
    const { s, lines } = session(1);
    const first = s.eval('gather()');
    const second = s.eval('1 + 1');
    await Promise.all([first, second]);
    expect(lines.at(-1)).toBe('value: 2');
  });

  test('format', () => {
    expect(format([{ id: 1, name: 'Old Wood', kind: 'forest', distance: 3, dir: 'W' }])).toBe('Old Wood  kind forest  distance 3  dir W');
    expect(format({ items: [], weight: 0 })).toBe('items []  weight 0');
    expect(format([1, 2])).toBe('1, 2');
  });
});

/** A reasonable player library: restock, pick the best place you know of, fill up, come home. */
const SMART = `const camp = () => known().find(p => p.kind === 'camp')
const owns = (tool) => shop().find(t => t.name === tool).owned
const restock = () => { if (here().kind === 'camp') buy('supplies', 20 - supplies()) }
// What you know goes stale: estimate regrowth from how long ago you looked (about 1 per 25 ticks).
const est = (p) => p.stock == null ? 4 : Math.min(12, p.stock + (p.seenAgo || 0) / 25)
const value = (p) => p.kind === 'ruin' ? 4 : p.kind === 'cave' ? 3 : 1
const reachable = (p) => p.distance * 2 + 2 <= supplies()
const best = () => known()
  .filter(p => p.kind !== 'camp' && est(p) >= 2 && reachable(p) && (p.kind !== 'cave' || owns('lantern')))
  .reduce((a, b) => (a && est(a) * value(a) / (a.distance + 1) >= est(b) * value(b) / (b.distance + 1) ? a : b), null)
const handle = (e) => { if (!e) return; choose(e.kind === 'bandits' ? (pack().weight <= 6 ? 'hide' : 'flee') : e.kind === 'storm' ? 'shelter' : 'share'); }
// Gather until full, then drop the worst value-for-weight items: overloading doubles the walk home.
const fill = () => {
  while (pack().weight < pack().capacity && here().stock > 0) gather()
  while (pack().weight > pack().capacity) drop(pack().items.reduce((a, b) => (a.value / a.weight <= b.value / b.weight ? a : b)).name)
}
const trip = () => {
  restock()
  if (gold() >= 40 && !owns('lantern')) buy('lantern')
  if (known().length < 8) scout()
  const p = best(); if (!p) { rest(30); return }
  handle(go(p))
  fill()
  handle(go(camp()))
}`;

describe('economy (phase 1)', () => {
  test('supplies cost gold, only at camps; camps no longer refill for free', () => {
    const w = createWorld(1);
    w.gold = 10; w.supplies = 5;
    expect(api.buy(w, 'supplies', 3).result).toBe(3);
    expect([w.supplies, w.gold]).toEqual([8, 7]);
    expect(api.buy(w, 'SUPPLIES', 100).result).toBe(7); // all you can afford
    expect([w.supplies, w.gold]).toEqual([15, 0]);
    expect(api.buy(w, 'supplies', 1).log[0]).toMatch(/can't afford/);
    expect(api.buy(w, 'supplies', 0).result).toBe(0); // buying nothing is not an error
    expect(api.buy(w, 'supplies', -2).result).toHaveProperty('__error');
    w.gold = 50;
    expect(api.buy(w, 'supplies', 100).result).toBe(5); // all you can carry
    const near = w.places.find((p) => p.discovered && p.kind !== 'camp')!;
    w.here = near.id;
    expect(api.buy(w, 'supplies', 1).result).toHaveProperty('__error'); // shops are at camps
    w.here = 0;
    w.supplies = 15;
    w.pack = [{ name: 'herbs', value: 2, weight: 1 }];
    w.here = near.id;
    const back = api.go(w, 'camp');
    if (back.result) api.choose(w, (back.result as { options: string[] }).options[0]);
    if (w.stranded === 0) expect(w.supplies).toBeLessThan(15); // walking home cost supplies, and nothing refilled them
  });

  test('stranding with gold wakes you with nothing; buying when broke gets rations', () => {
    const w = createWorld(1);
    const near = w.places.find((p) => p.discovered && p.kind !== 'camp')!;
    w.here = near.id; w.gold = 30; w.supplies = 0;
    api.go(w, 'camp');
    expect([w.here, w.supplies, w.stranded]).toEqual([0, 0, 1]); // no free refill for running out on purpose
    w.gold = 0;
    api.buy(w, 'supplies', 5);
    expect(w.supplies).toBe(RATIONS); // but nobody is ever stuck
  });

  test('rest lets places regrow; free at a camp, costs supplies elsewhere', () => {
    const w = createWorld(1);
    const near = w.places.find((p) => p.discovered && p.kind !== 'camp')!;
    near.stock = 0;
    api.rest(w, 100);
    advance(w, 100); // the host advances time by the ticks a call returns
    expect(near.stock).toBe(Math.min(near.maxStock, 100 / REGROW_TICKS));
    expect(w.supplies).toBe(20);
    w.here = near.id;
    api.rest(w, 30);
    expect(w.supplies).toBe(17);
    expect(api.rest(w, 0).result).toHaveProperty('__error');
  });

  test('nobody gets stuck: broke travellers get rations, and stranding wakes you fed', () => {
    for (let seed = 1; seed < 20; seed++) {
      const w = createWorld(seed);
      const near = w.places.find((p) => p.discovered && p.kind !== 'camp')!;
      w.here = near.id; w.gold = 0; w.supplies = 0; w.pack = [];
      const r = api.go(w, 'camp');
      if (r.result) api.choose(w, (r.result as { options: string[] }).options[0]);
      expect(w.here).toBe(0);
      expect(w.supplies).toBeGreaterThanOrEqual(RATIONS);
    }
  });

  test('the shop lists everything; tools are bought once', () => {
    const w = createWorld(1);
    const shop = api.shop(w);
    expect((shop.result as { name: string }[]).map((i) => i.name)).toEqual(['supplies', 'lantern', 'map']);
    expect(shop.log).toEqual([]); // data only: it doesn't narrate when code calls it
    expect(api.buy(w, 'lantern').log[0]).toMatch(/can't afford the lantern \(40g; you have 0\)/);
    w.gold = 100;
    expect(api.buy(w, 'lantern').result).toBe(true);
    expect(api.buy(w, 'lantern').log[0]).toMatch(/already have/);
    expect(w.gold).toBe(60);
    expect(api.buy(w, 'sword').result).toHaveProperty('__error');
  });

  test('caves are dark without a lantern', () => {
    const w = createWorld(2);
    const cave = w.places.find((p) => p.kind === 'cave')!;
    cave.discovered = true;
    w.here = cave.id;
    expect(api.look(w).log[0]).toMatch(/Too dark to see/);
    const dark = api.gather(w);
    expect(dark.result).toEqual([]);
    expect(dark.log[0]).toMatch(/Too dark/);
    w.tools.push('lantern');
    expect((api.gather(w).result as unknown[]).length).toBeGreaterThan(0);
  });

  test('known() reports what you last saw; peek() needs a map and tells the truth', () => {
    const w = createWorld(3);
    const [a] = w.places.filter((p) => p.discovered && p.kind !== 'camp');
    const row = () => (api.known(w).result as { id: number; stock?: number | null }[]).find((p) => p.id === a.id)!;
    expect(row().stock).toBeNull(); // never been there
    expect(api.peek(w, a.name).result).toHaveProperty('__error');
    w.here = a.id;
    api.gather(w);
    const seen = a.stock;
    expect(row().stock).toBe(seen);
    a.stock = a.maxStock; // it regrows while you're away
    w.here = 0;
    expect(row().stock).toBe(seen); // you still only know what you saw
    w.tools.push('map');
    expect((api.peek(w, a.name).result as { stock: number }).stock).toBe(a.maxStock);
    expect(row().stock).toBe(a.maxStock);
  });

  test('old saves upgrade cleanly', () => {
    const w = createWorld(4) as unknown as Record<string, unknown>;
    delete w.tools;
    for (const p of (w.places as Record<string, unknown>[])) { delete p.seen; delete p.seenAt; }
    const u = upgradeState(w as unknown as State);
    expect(u.tools).toEqual([]);
    expect(u.places[0].seen).toBe(0);
    expect(u.places[1].seen).toBeNull();
  });

  test('calibration: a restocking library affords the lantern in minutes; never buying supplies strands you', async () => {
    const ticks: number[] = [];
    for (const seed of [1, 2, 3, 4, 5]) {
      const smart = session(seed);
      await smart.s.loadLibrary(SMART);
      await smart.s.eval('let n = 0; while (!shop().find(t => t.name === "lantern").owned && n++ < 200) trip()');
      expect(smart.errors()).toEqual([]);
      expect(smart.state.tools).toContain('lantern');
      ticks.push(smart.state.time);
    }
    // 10 ticks a second: the lantern should take a few minutes of automated play, not seconds or hours.
    console.log("ticks to lantern by seed:", ticks.join(", "));
    for (const t of ticks) { expect(t).toBeGreaterThan(200); expect(t).toBeLessThan(3000); }
    const naive = session(7);
    await naive.s.eval(`for (let i = 0; i < 40; i++) { go(known()[1]); gather(); go('Camp'); }`);
    expect(naive.state.stranded).toBeGreaterThan(0);
  });
});

describe('generation', () => {
  test('names are unique, camps keep their distance, starting places are gatherable', () => {
    for (let seed = 1; seed < 40; seed++) {
      const w = createWorld(seed);
      const names = w.places.map((p) => p.name);
      expect(new Set(names).size).toBe(names.length);
      for (const p of w.places.slice(1)) if (Math.hypot(p.x, p.y) < 7) expect(['meadow', 'forest']).toContain(p.kind); // nothing rich, and no camp, on the doorstep
      const start = w.places.filter((p) => p.discovered && p.id !== 0);
      expect(start.map((p) => p.kind).sort()).toEqual(['forest', 'meadow']); // a fair start
    }
  });
});
