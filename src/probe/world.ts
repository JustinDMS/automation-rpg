// Throwaway probe world: one continuous expedition across a plane of places.
// Deterministic given its seed. No UI, no progression; just enough to find out
// what helpers a player writes against it.

import { mulberry32 } from '../sim/map';

export type Kind = 'camp' | 'meadow' | 'forest' | 'ruin' | 'cave' | 'mine';

export interface Item { name: string; value: number; weight: number }
export interface Place {
  id: number; name: string; kind: Kind; x: number; y: number;
  stock: number; maxStock: number; discovered: boolean; visits: number;
}
export interface Encounter {
  kind: 'bandits' | 'storm' | 'traveler';
  options: string[];
  /** Facts the player may want when choosing. */
  demand?: Item; distanceLeft: number;
}

export interface State {
  seed: number; rng: number; time: number;
  here: number; supplies: number; gold: number;
  pack: Item[]; places: Place[];
  pending: { e: Encounter; dest: number } | null;
  stranded: number;
}

export const MAX_SUPPLIES = 20;
export const CAPACITY = 15;

const YIELD: Record<Kind, Item[]> = {
  camp: [],
  meadow: [{ name: 'herbs', value: 2, weight: 1 }, { name: 'berries', value: 1, weight: 1 }],
  forest: [{ name: 'timber', value: 3, weight: 3 }, { name: 'furs', value: 6, weight: 2 }],
  ruin: [{ name: 'relic', value: 20, weight: 2 }, { name: 'coins', value: 5, weight: 1 }],
  cave: [{ name: 'crystal', value: 12, weight: 2 }, { name: 'guano', value: 1, weight: 2 }],
  mine: [{ name: 'ore', value: 8, weight: 5 }, { name: 'gems', value: 25, weight: 1 }],
};
const NAMES: Record<Kind, string[]> = {
  camp: ['Camp', 'Outpost', 'Waystation', 'Lodge'],
  meadow: ['Green Meadow', 'Low Fields', 'Heather Flat', 'Sheep Run', 'Windy Lea'],
  forest: ['Old Wood', 'Pine Stand', 'Dark Thicket', 'Birch Hollow', 'Oakshade'],
  ruin: ['Broken Tower', 'Sunken Hall', 'Kings Barrow', 'Moss Temple', 'Lost Gate'],
  cave: ['Echo Cave', 'Drip Hollow', 'Bat Warren', 'Cold Grotto', 'Glass Cavern'],
  mine: ['Rust Mine', 'Deep Shaft', 'Silver Cut', 'Dwarf Delve', 'Blackpit'],
};

const dist = (a: Place, b: Place) => Math.hypot(a.x - b.x, a.y - b.y);

export function createWorld(seed: number): State {
  const rand = mulberry32(seed);
  const places: Place[] = [{ id: 0, name: 'Camp', kind: 'camp', x: 0, y: 0, stock: 0, maxStock: 0, discovered: true, visits: 1 }];
  const used: Record<string, number> = {};
  const kinds: Kind[] = ['meadow', 'forest', 'ruin', 'cave', 'mine', 'camp'];
  // Rings of places: richer kinds further out.
  for (let i = 1; i < 45; i++) {
    const r = 2 + rand() * 22, a = rand() * Math.PI * 2;
    const weights = r < 8 ? [5, 3, 0.5, 0.5, 0, 0.3] : r < 15 ? [2, 3, 2, 2, 1, 0.4] : [0.5, 1, 3, 3, 3, 0.4];
    const kind = pick(kinds, weights, rand());
    const n = (used[kind] = (used[kind] ?? 0) + 1);
    const base = NAMES[kind][(n - 1) % NAMES[kind].length];
    const name = n > NAMES[kind].length ? `${base} ${Math.ceil(n / NAMES[kind].length)}` : base;
    const maxStock = kind === 'camp' ? 0 : Math.round(6 + r * 0.8);
    places.push({ id: i, name, kind, x: round(r * Math.cos(a)), y: round(r * Math.sin(a)), stock: maxStock, maxStock, discovered: false, visits: 0 });
  }
  // The two nearest places start discovered so the first script has somewhere to go.
  places.slice(1).sort((p, q) => dist(p, places[0]) - dist(q, places[0])).slice(0, 2).forEach((p) => { p.discovered = true; });
  return { seed, rng: seed ^ 0x9e3779b9, time: 0, here: 0, supplies: MAX_SUPPLIES, gold: 0, pack: [], places, pending: null, stranded: 0 };
}

function pick<T>(xs: T[], w: number[], r: number): T {
  const total = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < xs.length; i++) { acc += w[i] / total; if (r < acc) return xs[i]; }
  return xs[xs.length - 1];
}
const round = (x: number) => Math.round(x * 10) / 10;

function next(s: State): number {
  const f = mulberry32(s.rng);
  const v = f();
  s.rng = (s.rng + 0x6d2b79f5) >>> 0;
  return v;
}

export interface Step { log: string[]; ticks: number; result: unknown }
const ok = (result: unknown, ticks = 0, log: string[] = []): Step => ({ log, ticks, result });

/** Each API call mutates the state and returns what the player sees plus log lines and elapsed ticks. */
export const api = {
  here: (s: State) => ok(view(s, s.places[s.here])),
  time: (s: State) => ok(s.time),
  supplies: (s: State) => ok(s.supplies),
  gold: (s: State) => ok(s.gold),
  pack: (s: State) => ok({ items: s.pack, weight: weight(s), value: s.pack.reduce((a, i) => a + i.value, 0), capacity: CAPACITY }),
  known: (s: State) => ok(s.places.filter((p) => p.discovered).map((p) => view(s, p))),

  go(s: State, target: unknown): Step {
    const dest = resolvePlace(s, target);
    if (!dest) return fail(`go: unknown place ${JSON.stringify(target)}`);
    if (dest.id === s.here) return ok(null);
    const log: string[] = [];
    autoResolve(s, log);
    const d = dist(s.places[s.here], dest);
    const cost = Math.ceil(d * (weight(s) > CAPACITY ? 2 : 1));
    if (s.supplies < cost) return strand(s, dest, log);
    // Encounter check: roughly one per 10 units travelled.
    if (next(s) < Math.min(0.6, d * 0.1)) {
      const e = roll(s, d);
      s.pending = { e, dest: dest.id };
      log.push(`${e.kind} on the road to ${dest.name}`);
      return ok(e, Math.ceil(d), log);
    }
    return arrive(s, dest, cost, log);
  },

  choose(s: State, option: unknown): Step {
    if (!s.pending) return fail('choose: nothing to choose');
    const { e, dest } = s.pending;
    const opt = String(option);
    if (!e.options.includes(opt)) return fail(`choose: ${opt} is not one of ${e.options.join(', ')}`);
    s.pending = null;
    const log: string[] = [];
    let extraCost = 0;
    if (e.kind === 'bandits') {
      if (opt === 'pay') { s.pack = s.pack.filter((i) => i !== e.demand); log.push(`paid the bandits: ${e.demand!.name}`); }
      else if (opt === 'flee') { extraCost = 3; if (next(s) < 0.4 && s.pack.length) { const i = Math.floor(next(s) * s.pack.length); log.push(`dropped ${s.pack[i].name} while fleeing`); s.pack.splice(i, 1); } else log.push('fled the bandits'); }
      else { if (weight(s) <= 6) log.push('hid from the bandits'); else { extraCost = 3; const i = s.pack.indexOf(e.demand!); if (i >= 0) s.pack.splice(i, 1); log.push(`too laden to hide; bandits took ${e.demand!.name}`); } }
    } else if (e.kind === 'storm') {
      if (opt === 'shelter') { extraCost = 2; log.push('sheltered from the storm'); return finish(s, dest, e, extraCost, log, 6); }
      else { if (next(s) < 0.5) { extraCost = 4; log.push('the storm cost dearly'); } else log.push('pushed through the storm'); }
    } else {
      if (opt === 'share') { extraCost = 2; const p = s.places.find((q) => !q.discovered); if (p) { p.discovered = true; log.push(`the traveler told you of ${p.name}`); } else log.push('the traveler had nothing new'); }
      else log.push('passed the traveler by');
    }
    return finish(s, dest, e, extraCost, log, 0);
  },

  scout(s: State): Step {
    const log: string[] = [];
    autoResolve(s, log);
    if (s.supplies < 2) return strand(s, s.places[s.here], log);
    s.supplies -= 2;
    const h = s.places[s.here];
    const p = s.places.filter((q) => !q.discovered && dist(q, h) <= 7).sort((a, b) => dist(a, h) - dist(b, h))[0];
    if (!p) { log.push('scouted: nothing new nearby'); return ok(null, 4, log); }
    p.discovered = true;
    log.push(`discovered ${p.name}`);
    return ok(view(s, p), 4, log);
  },

  gather(s: State): Step {
    const log: string[] = [];
    autoResolve(s, log);
    const h = s.places[s.here];
    if (h.stock <= 0) return ok([], 2, log);
    const n = Math.min(h.stock, 1 + Math.floor(next(s) * 3));
    const got: Item[] = [];
    for (let i = 0; i < n; i++) {
      const pool = YIELD[h.kind];
      const item = pool[next(s) < 0.7 ? 0 : 1];
      got.push({ ...item });
      s.pack.push({ ...item });
    }
    h.stock -= n;
    log.push(`gathered ${summary(got)} at ${h.name}`);
    return ok(got, 3, log);
  },

  drop(s: State, name: unknown): Step {
    const i = s.pack.findIndex((it) => it.name === String(name));
    if (i < 0) return ok(false);
    s.pack.splice(i, 1);
    return ok(true);
  },
};

function fail(msg: string): Step { return { log: [], ticks: 0, result: { __error: msg } }; }

function view(s: State, p: Place) {
  return { id: p.id, name: p.name, kind: p.kind, x: p.x, y: p.y, distance: round(dist(s.places[s.here], p)), stock: p.stock, visits: p.visits };
}
const weight = (s: State) => s.pack.reduce((a, i) => a + i.weight, 0);
const summary = (items: Item[]) => {
  const c: Record<string, number> = {};
  for (const i of items) c[i.name] = (c[i.name] ?? 0) + 1;
  return Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
};

function resolvePlace(s: State, t: unknown): Place | null {
  if (t && typeof t === 'object' && 'id' in t) return s.places[Number((t as { id: unknown }).id)] ?? null;
  if (typeof t === 'number') return s.places[t] ?? null;
  if (typeof t === 'string') return s.places.find((p) => p.name === t && p.discovered) ?? null;
  return null;
}

function roll(s: State, d: number): Encounter {
  const r = next(s);
  const distanceLeft = Math.ceil(d);
  if (r < 0.45 && s.pack.length) {
    const demand = s.pack.reduce((a, b) => (b.value > a.value ? b : a));
    return { kind: 'bandits', options: ['pay', 'flee', 'hide'], demand, distanceLeft };
  }
  if (r < 0.75) return { kind: 'storm', options: ['shelter', 'push'], distanceLeft };
  return { kind: 'traveler', options: ['share', 'ignore'], distanceLeft };
}

/** An ignored encounter resolves itself, badly, before the next action. */
function autoResolve(s: State, log: string[]) {
  if (!s.pending) return;
  const { e } = s.pending;
  const worst = e.kind === 'bandits' ? 'pay' : e.kind === 'storm' ? 'push' : 'ignore';
  log.push(`${e.kind} ignored`, ...api.choose(s, worst).log);
}

function finish(s: State, destId: number, e: Encounter, extra: number, log: string[], extraTicks: number): Step {
  const dest = s.places[destId];
  const cost = Math.ceil(e.distanceLeft * (weight(s) > CAPACITY ? 2 : 1)) + extra;
  if (s.supplies < cost) return strand(s, dest, log, extraTicks);
  const r = arrive(s, dest, cost, log);
  return { ...r, ticks: r.ticks + extraTicks };
}

function arrive(s: State, dest: Place, cost: number, log: string[]): Step {
  s.supplies -= cost;
  s.here = dest.id;
  dest.visits++;
  let ticks = Math.ceil(dist(s.places[s.here], dest)) || cost;
  if (dest.kind === 'camp') {
    const v = s.pack.reduce((a, i) => a + i.value, 0);
    if (v > 0) log.push(`banked ${v} gold at ${dest.name} (${summary(s.pack)})`);
    s.gold += v;
    s.pack = [];
    s.supplies = MAX_SUPPLIES;
    ticks += 2;
  }
  return ok(null, ticks, log);
}

function strand(s: State, dest: Place, log: string[], extraTicks = 0): Step {
  const camps = s.places.filter((p) => p.kind === 'camp' && p.discovered);
  const camp = camps.reduce((a, b) => (dist(b, dest) < dist(a, dest) ? b : a));
  log.push(`out of supplies on the way to ${dest.name}; carried back to ${camp.name}, pack lost (${summary(s.pack)})`);
  s.pack = [];
  s.pending = null;
  s.here = camp.id;
  s.supplies = MAX_SUPPLIES;
  s.stranded++;
  return ok(null, 40 + extraTicks, log);
}

/** Time passes: stock regrows. Called by the host with elapsed ticks. */
export function advance(s: State, ticks: number) {
  s.time += ticks;
  for (const p of s.places) if (p.stock < p.maxStock && next(s) < ticks * 0.02) p.stock++;
}
