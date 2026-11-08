import { describe, expect, test } from 'vitest';
import { format, redeclarable, Session } from './sandbox';
import {
  advance, api, createWorld, ENCOUNTERS_AFTER, HIDE_WEIGHT, RATIONS, REGROW_TICKS, upgradeState,
  type Encounter, type State,
} from './world';

function session(seed: number) {
  const state = createWorld(seed);
  const lines: string[] = [];
  const s = new Session({ state: () => state, speed: () => 1e9, log: (l, c) => lines.push(`${c}: ${l}`), changed: () => {} });
  const errors = () => lines.filter((l) => l.startsWith('error'));
  return { state, lines, s, errors };
}

const nearest = (w: State, kind?: string) => w.places.find((p) => p.discovered && p.kind !== 'camp' && (!kind || p.kind === kind))!;
const dist = (w: State, a: number, b: number) => Math.hypot(w.places[a].x - w.places[b].x, w.places[a].y - w.places[b].y);
/** A walk costs one supply per whole league, as the prose and known() report it. */
const legs = (w: State, a: number, b: number) => Math.max(1, Math.round(dist(w, a, b)));

/** A reasonable player library: restock, pick the best place you know of, fill up, handle the road, come home. */
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
const handle = () => {
  const e = encounter(); if (!e) return
  if (e.kind === 'bandits') choose(pack().weight <= 6 ? 'hide' : e.count <= 2 ? 'flee' : 'pay')
  else if (e.kind === 'storm') choose('shelter')
  else choose('ignore')
}
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
  go(p); handle()
  fill()
  go(camp()); handle()
}`;

describe('probe world', () => {
  test('is deterministic', () => {
    const a = createWorld(3), b = createWorld(3);
    expect(a.places).toEqual(b.places);
    api.go(a, nearest(a).name); api.go(b, nearest(b).name);
    expect(a).toEqual(b);
  });

  test('a distance means what it costs: prose, known() and supplies agree', () => {
    for (let seed = 1; seed < 15; seed++) {
      const w = createWorld(seed);
      for (const p of (api.known(w).result as { name: string; kind: string; distance: number }[]).filter((x) => x.kind !== 'camp')) {
        const before = w.supplies;
        const said = Number(/You walk (\d+) league/.exec(api.go(w, p.name).log[0])![1]);
        expect([said, before - w.supplies]).toEqual([p.distance, p.distance]);
        api.go(w, 'camp'); w.supplies = 20;
      }
    }
  });

  test('speaks in prose; help is grouped and short; names are case-insensitive', () => {
    const w = createWorld(1);
    expect(api.look(w).log[0]).toMatch(/^Camp\. /);
    expect(api.go(w, nearest(w).name).log[0]).toMatch(/^You walk \d+ leagues? [NESW]+\. /); // the road is quiet at first
    const help = api.help(w, null).log;
    expect(help.filter((l) => !l.startsWith(' '))).toEqual(['Sense: free, returns data', 'Act: takes time, tells you what happened', 'Console']);
    for (const l of help.filter((x) => x.startsWith(' '))) expect(l.length).toBeLessThan(50); // one short line each
    expect(api.help(w, 'GO').log[0]).toMatch(/^go\(place\) +Walk to a known place/);
    expect(api.help(w, 'time').log[0]).toMatch(/no such command/);
    const w2 = createWorld(1);
    expect(api.go(w2, ` ${nearest(w2).name.toUpperCase()} `).result).toBeUndefined(); // arrived, no error
    expect(api.go(w2, 'nowhere').result).toHaveProperty('__error');
  });
});

describe('sense and act', () => {
  test('senses return data and never narrate', () => {
    const w = createWorld(1);
    w.tools.push('map');
    const senses: [keyof typeof api, unknown[]][] = [['here', []], ['known', []], ['pack', []], ['supplies', []], ['gold', []], ['shop', []], ['peek', [nearest(w).name]], ['encounter', []]];
    for (const [name, args] of senses) {
      const step = (api[name] as (s: State, ...a: unknown[]) => { log: string[]; ticks: number; result: unknown })(w, ...args);
      expect(step.log, name).toEqual([]);
      expect(step.ticks, name).toBe(0);
      expect(step.result, name).not.toBeUndefined();
    }
  });

  test('actions narrate and return nothing; time() and library() are gone', async () => {
    const { s, lines, errors } = session(1);
    await s.eval('var allVoid = [gather(), scout(), rest(5), buy("supplies", 1), drop("x")].every(r => r === undefined)');
    await s.eval('allVoid'); // a separate input: values aren't echoed after an action narrates
    expect(lines.at(-1)).toBe('value: true');
    expect(lines.filter((l) => l.startsWith('event:')).length).toBeGreaterThanOrEqual(4);
    await s.eval('[typeof time, typeof library]');
    expect(lines.at(-1)).toBe('value: undefined, undefined');
    await s.eval('encounter()');
    expect(lines.at(-1)).toBe('value: null');
    expect(errors()).toEqual([]);
  });
});

describe('encounters', () => {
  /** Put the player on the road from the camp to `dest` with a given encounter waiting. */
  function onRoad(e: Encounter, pack: { name: string; value: number; weight: number }[] = []) {
    const w = createWorld(5);
    const dest = nearest(w);
    w.pack = pack.map((i) => ({ ...i }));
    w.pending = { e, dest: dest.id };
    w.trips = ENCOUNTERS_AFTER;
    const walk = legs(w, 0, dest.id);
    return { w, dest, walk };
  }
  const furs = { name: 'furs', value: 6, weight: 2 }, timber = { name: 'timber', value: 3, weight: 3 };
  const bandits = (count: number): Encounter => ({ kind: 'bandits', options: ['pay', 'hide', 'flee'], facts: { count, wants: 'furs' } });

  test('none until the player has banked a few trips', () => {
    const w = createWorld(2);
    for (let i = 0; i < 40; i++) { api.go(w, nearest(w).name); api.go(w, 'camp'); expect(w.pending).toBeNull(); w.trips = 0; }
  });

  test('encounter() shows the facts that decide the outcome', () => {
    const { w, dest } = onRoad(bandits(3), [furs]);
    expect(api.encounter(w).result).toEqual({ kind: 'bandits', count: 3, wants: 'furs', options: ['pay', 'hide', 'flee'], heading: dest.name });
    api.choose(w, 'pay');
    expect(api.encounter(w).result).toBeNull();
    expect(w.here).toBe(dest.id);
  });

  test('bandits: pay loses what they want; hiding works only with a light pack; fleeing costs 2 supplies per bandit', () => {
    let r = onRoad(bandits(2), [furs, timber]);
    api.choose(r.w, 'pay');
    expect(r.w.pack.map((i) => i.name)).toEqual(['timber']);
    expect(r.w.supplies).toBe(20 - r.walk);

    r = onRoad(bandits(4), [furs, furs]); // weight 4: light enough
    expect(4).toBeLessThanOrEqual(HIDE_WEIGHT);
    api.choose(r.w, 'hide');
    expect([r.w.pack.length, r.w.supplies]).toEqual([2, 20 - r.walk]);

    r = onRoad(bandits(1), [furs, timber, timber]); // weight 8: too heavy
    api.choose(r.w, 'hide');
    expect(r.w.pack.map((i) => i.name)).toEqual(['timber', 'timber']);
    expect(r.w.supplies).toBe(20 - r.walk - 2);

    r = onRoad(bandits(3), [furs]);
    api.choose(r.w, 'flee');
    expect([r.w.pack.length, r.w.supplies]).toEqual([1, 20 - r.walk - 6]);
  });

  test('storms trade time for supplies; travellers trade supplies for a place near where you are going', () => {
    let r = onRoad({ kind: 'storm', options: ['shelter', 'push'], facts: { severity: 3 } });
    const shelter = api.choose(r.w, 'shelter');
    expect([shelter.ticks, r.w.supplies]).toEqual([r.walk + 30, 20 - r.walk]);
    r = onRoad({ kind: 'storm', options: ['shelter', 'push'], facts: { severity: 2 } });
    const push = api.choose(r.w, 'push');
    expect([push.ticks, r.w.supplies]).toEqual([r.walk, 20 - r.walk - 4]);

    r = onRoad({ kind: 'traveler', options: ['share', 'ignore'], facts: { wants: '2 supplies' } });
    const unknown = r.w.places.filter((p) => !p.discovered).sort((a, b) => dist(r.w, a.id, r.dest.id) - dist(r.w, b.id, r.dest.id))[0];
    api.choose(r.w, 'share');
    expect(unknown.discovered).toBe(true);
    expect(r.w.supplies).toBe(20 - r.walk - 2);
  });

  test('an unanswered encounter settles itself badly; a session can see and answer one', async () => {
    const r = onRoad(bandits(2), [furs]);
    const g = api.gather(r.w);
    expect(g.log[0]).toMatch(/never answered the bandits/);
    expect(r.w.pack.some((i) => i.name === 'furs')).toBe(false);

    const { s, state, lines, errors } = session(9);
    state.trips = ENCOUNTERS_AFTER;
    state.pack = [{ ...furs }];
    await s.eval(`var seen = 0; for (let i = 0; i < 30; i++) { go(known()[1]); const e = encounter(); if (e) { seen++; choose(e.options[0]); } go('camp'); if (encounter()) { seen++; choose(encounter().options[0]); } }`);
    await s.eval('seen');
    expect(errors()).toEqual([]);
    expect(Number(lines.at(-1)!.replace('value: ', ''))).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('never answered'))).toBe(false);
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

  test('prose suppresses the echo; senses echo as rows', async () => {
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
    await s.eval('while (true) { here(); }');
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

describe('economy', () => {
  test('supplies cost gold, only at camps; camps no longer refill for free', () => {
    const w = createWorld(1);
    w.gold = 10; w.supplies = 5;
    api.buy(w, 'supplies', 3);
    expect([w.supplies, w.gold]).toEqual([8, 7]);
    expect(api.buy(w, 'SUPPLIES', 100).log[0]).toMatch(/buy 7 supplies.*all you can afford/);
    expect([w.supplies, w.gold]).toEqual([15, 0]);
    expect(api.buy(w, 'supplies', 1).log[0]).toMatch(/can't afford/);
    expect(api.buy(w, 'supplies', 0).log).toEqual([]); // buying nothing is not an error
    expect(api.buy(w, 'supplies', -2).result).toHaveProperty('__error');
    w.gold = 50;
    expect(api.buy(w, 'supplies', 100).log[0]).toMatch(/buy 5 supplies.*all you can carry/);
    const near = nearest(w);
    w.here = near.id;
    expect(api.buy(w, 'supplies', 1).result).toHaveProperty('__error'); // shops are at camps
    w.supplies = 15;
    w.pack = [{ name: 'herbs', value: 2, weight: 1 }];
    api.go(w, 'camp');
    expect(w.supplies).toBe(15 - legs(w, 0, near.id)); // walking home cost supplies, and nothing refilled them
  });

  test('stranding with gold wakes you with nothing; buying when broke gets rations', () => {
    const w = createWorld(1);
    w.here = nearest(w).id; w.gold = 30; w.supplies = 0;
    api.go(w, 'camp');
    expect([w.here, w.supplies, w.stranded]).toEqual([0, 0, 1]); // no free refill for running out on purpose
    w.gold = 0;
    api.buy(w, 'supplies', 5);
    expect(w.supplies).toBe(RATIONS); // but nobody is ever stuck
  });

  test('nobody gets stuck: broke travellers reaching a camp get rations', () => {
    for (let seed = 1; seed < 20; seed++) {
      const w = createWorld(seed);
      w.here = nearest(w).id; w.gold = 0; w.supplies = 0; w.pack = [];
      api.go(w, 'camp');
      expect(w.here).toBe(0);
      expect(w.supplies).toBeGreaterThanOrEqual(RATIONS);
    }
  });

  test('rest lets places regrow; free at a camp, costs supplies elsewhere', () => {
    const w = createWorld(1);
    const near = nearest(w);
    near.stock = 0;
    const step = api.rest(w, 100);
    advance(w, step.ticks); // the host advances time by the ticks a call returns
    expect(near.stock).toBe(Math.min(near.maxStock, 100 / REGROW_TICKS));
    expect(w.supplies).toBe(20);
    w.here = near.id;
    api.rest(w, 30);
    expect(w.supplies).toBe(17);
    expect(api.rest(w, 0).result).toHaveProperty('__error');
  });

  test('the shop lists everything; tools are bought once', () => {
    const w = createWorld(1);
    expect((api.shop(w).result as { name: string }[]).map((i) => i.name)).toEqual(['supplies', 'lantern', 'map']);
    expect(api.buy(w, 'lantern').log[0]).toMatch(/can't afford the lantern \(40g; you have 0\)/);
    w.gold = 100;
    api.buy(w, 'lantern');
    expect(w.tools).toEqual(['lantern']);
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
    expect(api.gather(w).log[0]).toMatch(/Too dark/);
    expect(w.pack).toEqual([]);
    w.tools.push('lantern');
    api.gather(w);
    expect(w.pack.length).toBeGreaterThan(0);
  });

  test('known() reports what you last saw; peek() needs a map and tells the truth', () => {
    const w = createWorld(3);
    const a = nearest(w);
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
    delete w.tools; delete w.trips;
    w.pending = { e: { kind: 'storm', options: ['shelter', 'push'], distanceLeft: 3 }, dest: 1 }; // old-style encounter
    for (const p of (w.places as Record<string, unknown>[])) { delete p.seen; delete p.seenAt; }
    const u = upgradeState(w as unknown as State);
    expect([u.tools, u.trips, u.pending]).toEqual([[], ENCOUNTERS_AFTER, null]);
    expect(u.places[0].seen).toBe(0);
    expect(u.places[1].seen).toBeNull();
  });

  test('calibration: a sensible library affords the lantern in a handful of trips; never buying supplies strands you', async () => {
    const ticks: number[] = [], trips: number[] = [];
    for (const seed of [1, 2, 3, 4, 5]) {
      const smart = session(seed);
      await smart.s.loadLibrary(SMART);
      await smart.s.eval('let n = 0; while (!owns("lantern") && n++ < 200) trip()');
      expect(smart.errors()).toEqual([]);
      expect(smart.state.tools).toContain('lantern');
      ticks.push(smart.state.time);
      trips.push(smart.state.trips);
    }
    console.log('to the lantern by seed: trips', trips.join(', '), '| ticks', ticks.join(', '));
    // Enough trips to feel earned, few enough to reach in one sitting by hand.
    for (const t of trips) { expect(t).toBeGreaterThanOrEqual(3); expect(t).toBeLessThanOrEqual(10); }
    const naive = session(7);
    await naive.s.eval(`for (let i = 0; i < 40; i++) { go(known()[1]); gather(); go('Camp'); }`);
    expect(naive.state.stranded).toBeGreaterThan(0);
  });
});

describe('generation', () => {
  test('names are unique; nothing rich, and no camp, on the doorstep; a fair start', () => {
    for (let seed = 1; seed < 40; seed++) {
      const w = createWorld(seed);
      const names = w.places.map((p) => p.name);
      expect(new Set(names).size).toBe(names.length);
      for (const p of w.places.slice(1)) if (Math.hypot(p.x, p.y) < 7) expect(['meadow', 'forest']).toContain(p.kind);
      const start = w.places.filter((p) => p.discovered && p.id !== 0);
      expect(start.map((p) => p.kind).sort()).toEqual(['forest', 'meadow']);
    }
  });
});
