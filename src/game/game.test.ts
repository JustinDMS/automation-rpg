import { describe, expect, test } from 'vitest';
import { format, redeclarable, Session } from './sandbox';
import {
  advance, api, createWorld, ENCOUNTERS_AFTER, FOOD_TICKS, HIDE_WEIGHT, HOME_RADIUS, OUTPOST_PER_LEAGUE, OUTPOST_STEP, RATIONS, REGROW_TICKS, upgradeState,
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
const restock = () => { if (here().kind === 'camp') buy('supplies', pack().maxSupplies - supplies()) }
// What you know goes stale: estimate regrowth from how long ago you looked (about 1 per 25 ticks).
// Ruins, caves and mines never come back.
const spent = (p) => ['ruin', 'cave', 'mine'].includes(p.kind)
const est = (p) => p.stock == null ? 4 : spent(p) ? p.stock : Math.min(12, p.stock + (p.seenAgo || 0) / 25)
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

/** Reference libraries for the frontier: one farms what it can reach from the first camp, one pushes out and settles. */
const BASE = `const spent = (p) => ['ruin', 'cave', 'mine'].includes(p.kind)
const owns = (tool) => shop().find(t => t.name === tool).owned
const restock = () => { if (here().camp) buy('supplies', pack().maxSupplies - supplies()) }
const est = (p) => p.stock == null ? 6 : spent(p) ? p.stock : Math.min(12, p.stock + (p.seenAgo || 0) / 25)
const worth = { meadow: 1.7, forest: 3.9, ruin: 15.5, cave: 8.7, mine: 13 }
const usable = (p) => !p.camp && (p.kind !== 'cave' || owns('lantern'))
const reachable = (p) => p.distance * 2 + 2 <= supplies()
const score = (p) => Math.min(est(p), 10) * worth[p.kind] / (2 * p.distance + 4)
const best = (ok) => known().filter(p => usable(p) && est(p) >= 2 && reachable(p) && ok(p)).sort((a, b) => score(b) - score(a))[0]
const home = () => known().filter(p => p.camp).sort((a, b) => a.distance - b.distance)[0]
const handle = () => {
  const e = encounter(); if (!e) return
  if (e.kind === 'bandits') choose(pack().weight <= 6 ? 'hide' : e.count <= 2 ? 'flee' : 'pay')
  else if (e.kind === 'storm') choose('shelter')
  else choose('share')
}
const fill = () => {
  while (pack().weight < pack().capacity && here().stock > 0) gather()
  while (pack().weight > pack().capacity) drop(pack().items.reduce((a, b) => (a.value / a.weight <= b.value / b.weight ? a : b)).name)
}
const upgrade = () => { for (const t of ['lantern', 'pannier', 'haversack', 'cart', 'mule']) { const s = shop().find(x => x.name === t); if (!s.owned && (!s.needs || owns(s.needs)) && gold() >= s.price + 30) buy(t) } }
const visit = (p) => { go(p); handle(); fill(); go(home()); handle() }`;
const STAY = BASE + `
const trip = () => { restock(); upgrade(); if (known().length < 10) scout(); const p = best(() => true); if (p) visit(p); else rest(30) }`;
const FRONTIER = BASE + `
const out = (p) => Math.hypot(p.x, p.y)
const rich = () => best(p => spent(p))
const push = () => {
  const camp = home()
  const p = known().filter(q => usable(q) && reachable(q) && out(q) > out(camp)).sort((a, b) => out(b) - out(a))[0]
  if (!p) { scout(); return }
  go(p); handle(); scout()
  const h = here()
  if (h.outpostPrice != null && h.outpostPrice + 30 <= gold()) settle()
  else { fill(); go(home()); handle() }
}
const trip = () => {
  restock(); upgrade()
  const r = rich()
  if (r) visit(r)
  else if (gold() >= 150) push()
  else { const p = best(() => true); if (p) visit(p); else scout() }
}`;

describe('world', () => {
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
    w.tools.push('spyglass');
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

  test('storms: shelter costs time and the food you eat waiting, push costs double the supplies', () => {
    let r = onRoad({ kind: 'storm', options: ['shelter', 'push'], facts: { severity: 3 } });
    for (const p of r.w.places) if (p.kind === 'cave') p.discovered = true; // no cave to find here
    const shelter = api.choose(r.w, 'shelter');
    expect([shelter.ticks, r.w.supplies]).toEqual([r.walk + 30, 20 - r.walk - 30 / FOOD_TICKS]);
    expect(shelter.log[0]).toMatch(/under a rock/);
    r = onRoad({ kind: 'storm', options: ['shelter', 'push'], facts: { severity: 2 } });
    const push = api.choose(r.w, 'push');
    expect([push.ticks, r.w.supplies]).toEqual([r.walk, 20 - r.walk - 4]);
  });

  test('sheltering near an unknown cave finds it, by a fixed rule', () => {
    const r = onRoad({ kind: 'storm', options: ['shelter', 'push'], facts: { severity: 1 } });
    const cave = r.w.places.find((p) => p.kind === 'cave' && !p.discovered)!;
    for (const p of r.w.places) if (p.kind === 'cave' && p !== cave) p.discovered = true;
    cave.x = r.dest.x + 2; cave.y = r.dest.y + 1; // within 4 leagues of where you are heading
    const out = api.choose(r.w, 'shelter');
    expect(cave.discovered).toBe(true);
    expect(out.log[0]).toMatch(new RegExp(`mouth of ${cave.name}`));
  });

  test('travellers trade 2 supplies for an unknown camp near your destination, or else the nearest unknown place', () => {
    for (let seed = 1; seed < 30; seed++) {
      const w = createWorld(seed);
      const dest = nearest(w);
      w.pending = { e: { kind: 'traveler', options: ['share', 'ignore'], facts: { wants: '2 supplies' } }, dest: dest.id };
      const unknown = w.places.filter((p) => !p.discovered).sort((a, b) => dist(w, a.id, dest.id) - dist(w, b.id, dest.id));
      const expected = unknown.find((p) => p.kind === 'camp' && dist(w, p.id, dest.id) <= 12) ?? unknown[0];
      const walk = legs(w, 0, dest.id);
      api.choose(w, 'share');
      expect(expected.discovered).toBe(true);
      expect(w.supplies).toBe(20 - walk - 2);
    }
  });

  test('the road is quieter: roughly one encounter per 30 leagues', () => {
    const w = createWorld(4);
    w.trips = ENCOUNTERS_AFTER;
    let leagues = 0, met = 0;
    const p = nearest(w); // one fixed route: long walks are capped at 1 in 4
    for (let i = 0; i < 400; i++) {
      leagues += legs(w, w.here, p.id);
      api.go(w, p.name); if (w.pending) { met++; api.choose(w, w.pending.e.options[0]); }
      leagues += legs(w, w.here, 0);
      api.go(w, 'camp'); if (w.pending) { met++; api.choose(w, w.pending.e.options[0]); }
      w.supplies = 20; w.pack = [];
    }
    expect(leagues / met).toBeGreaterThan(20);
    expect(leagues / met).toBeLessThan(45);
  });

  test('an unanswered encounter settles itself badly; a session can see and answer one', async () => {
    const r = onRoad(bandits(2), [furs]);
    const g = api.gather(r.w);
    expect(g.log[0]).toMatch(/never answered the bandits/);
    expect(g.log[1]).toMatch(/hand over the furs/);

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
    expect((api.shop(w).result as { name: string }[]).map((i) => i.name)).toEqual(['supplies', 'pannier', 'cart', 'haversack', 'mule', 'lantern', 'spyglass']);
    expect(api.buy(w, 'lantern').log[0]).toMatch(/can't afford the lantern \(40g; you have 0\)/);
    w.gold = 100;
    api.buy(w, 'lantern');
    expect(w.tools).toEqual(['lantern']);
    expect(api.buy(w, 'lantern').log[0]).toMatch(/already have/);
    expect(w.gold).toBe(60);
    expect(api.buy(w, 'sword').result).toHaveProperty('__error');
  });

  test('the haversack and mule raise how many supplies you can carry; the mule needs the haversack', () => {
    const w = createWorld(1);
    w.gold = 200;
    expect(api.buy(w, 'mule').log[0]).toMatch(/need a haversack first/);
    api.buy(w, 'haversack');
    expect(w.maxSupplies).toBe(30);
    api.buy(w, 'supplies', 99);
    expect(w.supplies).toBe(30);
    api.buy(w, 'mule');
    expect([w.maxSupplies, w.gold]).toEqual([40, 200 - 30 - 10 - 100]);
    expect(api.pack(w).result).toMatchObject({ supplies: 30, maxSupplies: 40 });
    expect(api.look(w).log[2]).toMatch(/Supplies: 30\/40/);
  });

  test('the pannier and cart raise how much weight you carry before walking costs double', () => {
    const w = createWorld(1);
    w.gold = 500;
    expect(api.buy(w, 'cart').log[0]).toMatch(/need a pannier first/);
    api.buy(w, 'pannier');
    expect(w.capacity).toBe(22);
    api.buy(w, 'cart');
    expect(w.capacity).toBe(30);
    w.pack = Array.from({ length: 10 }, () => ({ name: 'timber', value: 3, weight: 3 })); // weight 30: not overloaded
    const near = nearest(w);
    api.go(w, near.name);
    expect(w.supplies).toBe(20 - legs(w, 0, near.id));
    expect(api.pack(w).result).toMatchObject({ weight: 30, capacity: 30 });
  });

  test('rations always cover a round trip to the nearest known place with anything left', () => {
    const w = createWorld(6);
    for (const p of w.places) if (p.discovered && p.kind !== 'camp') p.seen = 0; // the doorstep looks picked clean
    const far = w.places.filter((p) => !p.discovered && p.kind === 'forest').sort((a, b) => dist(w, 0, b.id) - dist(w, 0, a.id))[0];
    far.discovered = true; far.seen = far.stock; // the only known place with stock is far away
    w.gold = 0; w.supplies = 0;
    api.buy(w, 'supplies', 1);
    expect(w.supplies).toBe(Math.min(20, Math.max(RATIONS, 2 * legs(w, 0, far.id) + 1)));
  });

  test('scouting reveals everything unknown within 4 leagues, or else the nearest unknown place', () => {
    for (let seed = 1; seed < 15; seed++) {
      const w = createWorld(seed);
      const unknown = w.places.filter((p) => !p.discovered);
      const near = unknown.filter((p) => dist(w, 0, p.id) <= 4);
      const expected = near.length ? near : unknown.sort((a, b) => dist(w, 0, a.id) - dist(w, 0, b.id)).slice(0, 1);
      api.scout(w);
      expect(w.places.filter((p) => p.discovered && unknown.includes(p)).map((p) => p.id).sort()).toEqual(expected.map((p) => p.id).sort());
    }
  });

  test('a first visit is described; a return visit is one line of facts', () => {
    const w = createWorld(1);
    const p = nearest(w);
    expect(api.go(w, p.name).log[0]).toMatch(/for the first time\. .+\. /);
    api.go(w, 'camp');
    expect(api.go(w, p.name).log[0]).toMatch(new RegExp(`^You walk \\d+ leagues? \\w+ to ${p.name} \\(${p.kind}\\)\\. \\w+: (plenty|some|thin|picked clean)\\.$`));
    const rows = api.known(w).result as object[];
    expect(Object.keys(rows[0]).sort()).toEqual(['camp', 'distance', 'id', 'kind', 'name', 'seenAgo', 'stock', 'x', 'y']);
    expect(Object.keys(rows[1]).sort()).toEqual(['distance', 'id', 'kind', 'name', 'seenAgo', 'stock', 'x', 'y']);
  });

  test('the frontier pays: a library that founds outposts outearns one that stays home', { timeout: 120000 }, async () => {
    let stay = 0, frontier = 0;
    for (const seed of [1, 2, 3]) {
      for (const [name, lib] of [['stay', STAY], ['frontier', FRONTIER]] as const) {
        const { s, state, lines, errors } = session(seed);
        await s.loadLibrary(lib);
        while (state.time < 4500) await s.eval('trip()');
        expect(errors()).toEqual([]);
        const earned = lines.reduce((a, l) => a + Number(/Banked (\d+)/.exec(l)?.[1] ?? 0), 0);
        if (name === 'stay') { stay += earned; continue; }
        frontier += earned;
        const out = state.places.filter((p) => p.outpost).map((p) => Math.hypot(p.x, p.y));
        expect(out.length).toBeGreaterThanOrEqual(3);
        expect(Math.max(...out)).toBeGreaterThan(30);
      }
    }
    console.log('earned in 4500 ticks over three worlds: stay', stay, '| frontier', frontier);
    expect(frontier).toBeGreaterThan(stay * 1.5);
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

  test('known() reports what you last saw; peek() needs a spyglass and tells the truth', () => {
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
    w.tools.push('spyglass');
    expect((api.peek(w, a.name).result as { stock: number }).stock).toBe(a.maxStock);
    expect(row().stock).toBe(a.maxStock);
  });

  test('old saves upgrade cleanly; the map becomes a spyglass', () => {
    const old = createWorld(4) as unknown as Record<string, unknown>;
    old.tools = ['map']; delete old.maxSupplies; delete old.capacity;
    const o = upgradeState(old as unknown as State);
    expect([o.tools, o.maxSupplies, o.capacity]).toEqual([['spyglass'], 20, 15]);
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
    for (const t of trips) { expect(t).toBeGreaterThanOrEqual(3); expect(t).toBeLessThanOrEqual(12); }
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
      // a door for the lantern: a cave 7 to 10 leagues from the start
      expect(w.places.some((p) => p.kind === 'cave' && Math.hypot(p.x, p.y) >= 7 && Math.hypot(p.x, p.y) <= 10)).toBe(true);
    }
  });
});

describe('frontier', () => {
  const place = (w: State, kind: string) => w.places.find((p) => p.kind === kind && p.id !== 0)!;

  test('ruins, caves and mines give up their haul once; meadows and forests regrow', () => {
    const w = createWorld(1);
    const ruin = place(w, 'ruin'), meadow = place(w, 'meadow');
    ruin.stock = 0; meadow.stock = 0;
    advance(w, REGROW_TICKS * 10);
    expect(ruin.stock).toBe(0);
    expect(meadow.stock).toBeGreaterThan(0);
    ruin.discovered = true; w.here = ruin.id;
    expect(api.gather(w).log[0]).toMatch(/Nothing here will come back/);
    expect(api.look(w).log[0]).toMatch(/stripped for good/);
  });

  test('settle() founds an outpost: priced by distance and count, then it banks, sells and feeds like a camp', () => {
    const w = createWorld(2);
    const a = nearest(w);
    w.here = a.id;
    const price = OUTPOST_PER_LEAGUE * legs(w, 0, a.id);
    expect((api.here(w).result as { outpostPrice: number }).outpostPrice).toBe(price);
    w.gold = price - 1;
    expect(api.settle(w).log[0]).toMatch(/costs \d+ gold/);
    expect(a.outpost).toBeFalsy();
    w.gold = price + 5;
    w.pack = [{ name: 'herbs', value: 2, weight: 1 }];
    api.settle(w);
    expect([a.outpost, w.outposts, w.gold, w.pack]).toEqual([true, 1, 7, []]); // the pack was banked
    expect(api.here(w).result).not.toHaveProperty('outpostPrice');
    expect((api.known(w).result as { id: number; camp?: boolean }[]).find((p) => p.id === a.id)!.camp).toBe(true);
    expect(api.settle(w).log[0]).toMatch(/already has/);
    w.supplies = 0;
    api.buy(w, 'supplies', 5);
    expect([w.supplies, w.gold]).toEqual([5, 2]);
    // the next one costs OUTPOST_STEP more, on top of its distance to the nearest camp
    const b = w.places.filter((p) => p.discovered && !p.outpost && p.kind !== 'camp' && p.id !== a.id)[0];
    w.here = b.id;
    const near = Math.min(...[0, a.id].map((c) => legs(w, c, b.id)));
    expect((api.here(w).result as { outpostPrice: number }).outpostPrice).toBe(OUTPOST_PER_LEAGUE * near + OUTPOST_STEP);
  });

  test('the world grows past its edge as you approach, the same way every time', () => {
    const walkOut = () => {
      const w = createWorld(3);
      const n = w.places.length;
      const edge = w.places.reduce((a, b) => (Math.hypot(b.x, b.y) > Math.hypot(a.x, a.y) ? b : a));
      edge.discovered = true; w.here = edge.id; w.supplies = 40;
      api.scout(w);
      return { w, n };
    };
    const one = walkOut(), two = walkOut();
    expect(one.w.places.length).toBeGreaterThan(one.n);
    expect(one.w.places.slice(one.n).every((p) => Math.hypot(p.x, p.y) >= HOME_RADIUS)).toBe(true);
    expect(two.w.places).toEqual(one.w.places);
    const names = one.w.places.map((p) => p.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  test('scouting at the edge of what you know always finds something further', () => {
    const w = createWorld(4);
    w.supplies = 1000;
    let far = 0;
    for (let i = 0; i < 12; i++) {
      api.scout(w);
      const out = w.places.filter((p) => p.discovered).reduce((a, b) => (Math.hypot(b.x, b.y) > Math.hypot(a.x, a.y) ? b : a));
      w.here = out.id; // stand at the furthest place known, as a player pushing out would
      far = Math.hypot(out.x, out.y);
    }
    expect(far).toBeGreaterThan(HOME_RADIUS + 10);
  });

  test('the spyglass sees what a place holds before you ever walk there', () => {
    const w = createWorld(5);
    const r = place(w, 'ruin');
    r.discovered = true;
    w.tools.push('spyglass');
    expect((api.known(w).result as { id: number; stock: number | null }[]).find((p) => p.id === r.id)!.stock).toBeNull();
    expect((api.peek(w, r.name).result as { stock: number }).stock).toBe(r.maxStock);
  });

  test('bank() cashes in the pack at a camp or outpost without leaving', () => {
    const w = createWorld(7);
    const a = nearest(w);
    w.here = a.id;
    w.pack = [{ name: 'herbs', value: 2, weight: 1 }];
    expect(api.bank(w).log[0]).toMatch(/Bank at a camp/);
    expect(w.pack.length).toBe(1);
    w.gold = 500;
    api.settle(w);
    api.gather(w);
    const v = w.pack.reduce((t, i) => t + i.value, 0), g = w.gold;
    expect(v).toBeGreaterThan(0);
    expect(api.bank(w).log[0]).toMatch(/^Banked/);
    expect([w.pack, w.gold]).toEqual([[], g + v]);
  });

  test('old saves gain an empty frontier', () => {
    const old = createWorld(6) as unknown as Record<string, unknown>;
    delete old.cells; delete old.outposts;
    const u = upgradeState(old as unknown as State);
    expect([u.cells, u.outposts]).toEqual([[], 0]);
  });
});
