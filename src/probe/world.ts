// Probe world: one continuous expedition across a plane of places.
// Deterministic given its seed. Gold buys supplies and tools; tools add commands.

import { mulberry32 } from '../sim/map';

export type Kind = 'camp' | 'meadow' | 'forest' | 'ruin' | 'cave' | 'mine';

export interface Item { name: string; value: number; weight: number }
export interface Place {
  id: number; name: string; kind: Kind; x: number; y: number;
  stock: number; maxStock: number; discovered: boolean; visits: number;
  /** Stock as the player last saw it, and when. What you know, not what is true. */
  seen: number | null; seenAt: number | null;
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
  tools: Tool[];
}

export type Tool = 'lantern' | 'map';

export const MAX_SUPPLIES = 20;
export const CAPACITY = 15;
export const SUPPLY_PRICE = 1;
/** A traveller at a camp who can't afford supplies is fed up to this many, free. */
export const RATIONS = 8;
/** Each place regains one item per this many ticks, up to its maximum. */
export const REGROW_TICKS = 25;
export const TOOLS: { name: Tool; price: number; gives: string }[] = [
  { name: 'lantern', price: 40, gives: 'gather in caves' },
  { name: 'map', price: 60, gives: 'peek(place): what a place holds right now, from anywhere' },
];

const YIELD: Record<Kind, Item[]> = {
  camp: [],
  meadow: [{ name: 'herbs', value: 2, weight: 1 }, { name: 'berries', value: 1, weight: 1 }],
  forest: [{ name: 'timber', value: 3, weight: 3 }, { name: 'furs', value: 6, weight: 2 }],
  ruin: [{ name: 'relic', value: 20, weight: 2 }, { name: 'coins', value: 5, weight: 1 }],
  cave: [{ name: 'crystal', value: 12, weight: 2 }, { name: 'guano', value: 1, weight: 2 }],
  mine: [{ name: 'ore', value: 8, weight: 5 }, { name: 'gems', value: 25, weight: 1 }],
};
const NAMES: Record<Kind, string[]> = {
  camp: ['Camp', 'Outpost', 'Waystation', 'Lodge', 'Ford House', 'Tollgate', 'Shepherd Hut'],
  meadow: ['Green Meadow', 'Low Fields', 'Heather Flat', 'Sheep Run', 'Windy Lea', 'Bee Common', 'Long Acre', 'Marsh Edge', 'Kestrel Down', 'Thistle Bank', 'Mill Pasture', 'Hare Croft'],
  forest: ['Old Wood', 'Pine Stand', 'Dark Thicket', 'Birch Hollow', 'Oakshade', 'Rook Spinney', 'Fir Rise', 'Hazel Copse', 'Wolf Wood', 'Alder Carr', 'Yew Bend', 'Ash Holt'],
  ruin: ['Broken Tower', 'Sunken Hall', 'Kings Barrow', 'Moss Temple', 'Lost Gate', 'Giant Steps', 'Drowned Chapel', 'Watch Stones', 'Old Granary', 'Seven Pillars', 'Burnt Keep', 'Queens Rest'],
  cave: ['Echo Cave', 'Drip Hollow', 'Bat Warren', 'Cold Grotto', 'Glass Cavern', 'Fox Earth', 'Smugglers Hole', 'Blue Sink', 'Whistle Gap', 'Bone Shelf', 'Moth Cleft', 'Deep Throat'],
  mine: ['Rust Mine', 'Deep Shaft', 'Silver Cut', 'Dwarf Delve', 'Blackpit', 'Copper Adit', 'Tin Works', 'Lantern Level', 'Grey Seam', 'Widow Shaft', 'Salt Drift', 'Gold Stope'],
};

const DESC: Record<Kind, string[]> = {
  camp: ['A fire, a bedroll, a cache under oilcloth.', 'Tents and a well. Someone is always awake.', 'A lean-to and a cold hearth.', 'A stone hut with a stout door.'],
  meadow: ['Tall grass, bees, a stream you can hear but not see.', 'Low ground, wet in the hollows. Sheep tracks.', 'Heather and wind. Not much cover.', 'A wide field gone to seed.', 'Grass to the knee and a lark overhead.'],
  forest: ['Pines, deadfall, the smell of resin.', 'Old trunks close together. Dark by mid-afternoon.', 'Thicket and bramble. Hard going off the path.', 'Birches, bright and thin. Quiet.', 'Oaks with room between them. Good shade.'],
  ruin: ['A tower snapped off at the second floor. Stairs go down.', 'A hall half under the hill. Carvings on the lintel.', 'A barrow with its door stone shifted aside.', 'Moss on fallen pillars. Something was worshipped here.', 'A gate with no wall. The road beyond is paved.'],
  cave: ['A mouth in the hillside. Your voice comes back twice.', 'Dripping dark, cool even at noon.', 'The floor is soft with droppings. Wings above.', 'Cold breath from below. Frost on the lip.', 'The walls glitter where the light catches.'],
  mine: ['Timbered shafts, rusted rails, a wheelbarrow with no wheel.', 'A pit straight down with a ladder you would not trust.', 'A cut in the rock, worked clean and then abandoned.', 'Low tunnels, dwarf-height, well made.', 'Black spoil heaps. The air tastes of iron.'],
};

const dist = (a: Place, b: Place) => Math.hypot(a.x - b.x, a.y - b.y);
const DIRS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
const dirTo = (a: Place, b: Place) => DIRS[Math.round(Math.atan2(-(b.y - a.y), b.x - a.x) / (Math.PI / 4) + 8) % 8];
const leagues = (d: number) => { const n = Math.round(d); return `${n} league${n === 1 ? '' : 's'}`; };
const describe = (p: Place) => DESC[p.kind][p.id % DESC[p.kind].length];
const hereIs = (s: State, p: Place) => {
  if (p.kind === 'camp') return ' A quartermaster keeps a shop here.';
  if (p.kind === 'cave' && !s.tools.includes('lantern')) return ' Too dark to see what is here.';
  const [a, b] = YIELD[p.kind];
  const level = p.stock === 0 ? 'picked clean' : p.stock < p.maxStock / 3 ? 'thin' : p.stock < p.maxStock * 0.8 ? 'some' : 'plenty';
  return p.stock === 0 ? ` Nothing left to take: ${a.name} and ${b.name} once, now ${level}.` : ` ${cap(a.name)} here (${level}), maybe ${b.name}.`;
};
const cap = (t: string) => t[0].toUpperCase() + t.slice(1);
const itemLine = (i: Item) => `${i.name} (${i.value}g${i.weight >= 3 ? ', heavy' : ''})`;

export function createWorld(seed: number): State {
  const rand = mulberry32(seed);
  const places: Place[] = [{ id: 0, name: 'Camp', kind: 'camp', x: 0, y: 0, stock: 0, maxStock: 0, discovered: true, visits: 1, seen: 0, seenAt: 0 }];
  const used: Record<string, number> = {};
  const kinds: Kind[] = ['meadow', 'forest', 'ruin', 'cave', 'mine', 'camp'];
  // Rings of places: richer kinds further out.
  for (let i = 1; i < 45; i++) {
    const r = 2 + rand() * 22, a = rand() * Math.PI * 2;
    // Order: meadow, forest, ruin, cave, mine, camp. Only meadows and forests near the start.
    const weights = r < 7 ? [5, 3, 0, 0, 0, 0] : r < 14 ? [1, 3, 2, 2, 0.5, 0.6] : [0.5, 1, 3, 3, 3, 0.6];
    const kind = pick(kinds, weights, rand());
    const n = (used[kind] = (used[kind] ?? 0) + 1);
    const names = kind === 'camp' ? NAMES.camp.slice(1) : NAMES[kind]; // 'Camp' is the start
    const base = names[(n - 1) % names.length];
    const name = n > names.length ? `${base} ${Math.ceil(n / names.length)}` : base;
    const maxStock = kind === 'camp' ? 0 : Math.round(6 + r * 0.8);
    places.push({ id: i, name, kind, x: round(r * Math.cos(a)), y: round(r * Math.sin(a)), stock: maxStock, maxStock, discovered: false, visits: 0, seen: null, seenAt: null });
  }
  // A fair start: the nearest meadow and the nearest forest are known. If no forest is
  // near, the second-nearest meadow becomes one.
  const near = places.filter((p) => p.kind === 'meadow' || p.kind === 'forest').sort((p, q) => dist(p, places[0]) - dist(q, places[0]));
  const meadow = near.find((p) => p.kind === 'meadow')!;
  let forest = near.find((p) => p.kind === 'forest' && dist(p, places[0]) < 7);
  if (!forest) {
    forest = near.find((p) => p !== meadow)!;
    forest.kind = 'forest';
    const n = (used.forest = (used.forest ?? 0) + 1);
    forest.name = NAMES.forest[(n - 1) % NAMES.forest.length] + (n > NAMES.forest.length ? ` ${Math.ceil(n / NAMES.forest.length)}` : '');
  }
  meadow.discovered = forest.discovered = true;
  return { seed, rng: seed ^ 0x9e3779b9, time: 0, here: 0, supplies: MAX_SUPPLIES, gold: 0, pack: [], places, pending: null, stranded: 0, tools: [] };
}

/** Bring a saved world from an earlier version up to date. */
export function upgradeState(s: State): State {
  s.tools ??= [];
  for (const p of s.places) {
    if (p.seen === undefined) { p.seen = p.visits > 0 ? p.stock : null; p.seenAt = p.visits > 0 ? s.time : null; }
  }
  return s;
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

export interface Step { log: string[]; ticks: number; result: unknown; mono?: boolean }
const ok = (result: unknown, ticks = 0, log: string[] = []): Step => ({ log, ticks, result });

/** Each API call mutates the state and returns what the player sees plus log lines and elapsed ticks. */
const HELP: [string, string][] = [
  ['look()', 'where you are, what is here, where you can go, what you carry'],
  ['go(place)', "walk there, e.g. go('old wood'). Costs supplies by distance, double when overloaded. Returns an encounter or null"],
  ['gather()', 'take what this place has'],
  ['scout()', 'search nearby for a new place; costs 2 supplies'],
  ['choose(option)', "answer an encounter on the road, e.g. choose('hide')"],
  ['pack()', 'what you carry: items, weight, value, capacity'],
  ['drop(name)', "leave one item behind, e.g. drop('timber')"],
  ['known()', 'every place you know: distance, direction, and what you saw there last'],
  ['here()', 'this place as data'],
  ['shop()', 'what camps sell, and what you own'],
  ['buy(item, n)', "at a camp: buy('supplies', 10), buy('lantern')"],
  ['peek(place)', 'what a place holds right now, from anywhere. Needs a map'],
  ['rest(ticks)', 'let time pass while places regrow. Free at a camp; elsewhere 1 supply per 10 ticks'],
  ['supplies()', 'what is left. Camps sell more. Run out and you lose your pack'],
  ['gold()', 'banked so far. Reaching any camp banks your pack'],
  ['time()', 'ticks elapsed'],
  ['print(...)', 'write to the console'],
  ['library()', 'print your library file'],
  ['help(cmd)', "this list, or one command: help('go')"],
];
const helpLine = ([sig, desc]: [string, string]) => `${sig.padEnd(15)} ${desc}`;

export const api = {
  here: (s: State) => { const h = s.places[s.here]; see(s, h); return ok(view(s, h)); },
  look(s: State): Step {
    const h = s.places[s.here];
    const roads = s.places.filter((p) => p.discovered && p.id !== h.id)
      .sort((a, b) => dist(a, h) - dist(b, h)).slice(0, 6)
      .map((p) => `${p.name} (${leagues(dist(p, h))} ${dirTo(h, p)})`).join(', ');
    const pack = s.pack.length ? summary(s.pack) + ` · ${weight(s)}/${CAPACITY} weight · ${s.pack.reduce((a, i) => a + i.value, 0)}g` : 'empty';
    see(s, h);
    const lines = [`${h.name}. ${describe(h)}${hereIs(s, h)}`, `Known from here: ${roads || 'nothing yet; try scout()'}.`, `Pack: ${pack}. Supplies: ${s.supplies}/${MAX_SUPPLIES}. Gold: ${s.gold}.`];
    if (s.pending) lines.push(`${cap(s.pending.e.kind)} waiting on an answer: ${s.pending.e.options.map((o) => `'${o}'`).join(' | ')}`);
    return ok(null, 0, lines);
  },
  help(_s: State, what: unknown): Step {
    if (what == null) return { ...ok(null, 0, HELP.map(helpLine)), mono: true };
    const name = String(what).toLowerCase().replace(/\(.*$/, '');
    const t = HELP.find(([sig]) => sig.startsWith(name + '('));
    return { ...ok(null, 0, [t ? helpLine(t) : `no such command: ${String(what)}`]), mono: true };
  },
  time: (s: State) => ok(s.time),
  supplies: (s: State) => ok(s.supplies),
  gold: (s: State) => ok(s.gold),
  pack: (s: State) => ok({ items: s.pack, weight: weight(s), value: s.pack.reduce((a, i) => a + i.value, 0), capacity: CAPACITY }),
  known: (s: State) => ok(s.places.filter((p) => p.discovered).map((p) => view(s, p))),

  /** Plain data, like known(): shown as rows only when typed at the prompt. */
  shop: (s: State) => ok([
    { name: 'supplies', price: SUPPLY_PRICE, gives: `walking; you carry ${s.supplies}/${MAX_SUPPLIES}` },
    ...TOOLS.map((t) => ({ name: t.name, price: t.price, gives: t.gives, owned: s.tools.includes(t.name) })),
  ]),

  buy(s: State, item: unknown, count?: unknown): Step {
    const name = String(item).trim().toLowerCase();
    if (s.places[s.here].kind !== 'camp') return fail('buy: shops are at camps');
    if (name === 'supplies' || name === 'supply') {
      const want = count == null ? 1 : Math.floor(Number(count));
      if (want === 0) return ok(0);
      if (!(want > 0)) return fail(`buy: can't buy ${String(count)} supplies`);
      const room = MAX_SUPPLIES - s.supplies;
      const n = Math.min(want, room, Math.floor(s.gold / SUPPLY_PRICE));
      if (n <= 0) {
        const log = [room === 0 ? 'You can carry no more supplies.' : `You can't afford supplies (${SUPPLY_PRICE}g each; you have ${s.gold}).`];
        rations(s, log);
        return ok(0, 0, log);
      }
      s.supplies += n;
      s.gold -= n * SUPPLY_PRICE;
      const why = n < want ? (n === room ? ' That is all you can carry.' : ' That is all you can afford.') : '';
      return ok(n, 0, [`You buy ${n} supplies for ${n * SUPPLY_PRICE} gold. Supplies: ${s.supplies}/${MAX_SUPPLIES}.${why}`]);
    }
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return fail(`buy: nobody sells ${JSON.stringify(item)}; see shop()`);
    if (s.tools.includes(tool.name)) return ok(false, 0, [`You already have a ${tool.name}.`]);
    if (s.gold < tool.price) return ok(false, 0, [`You can't afford the ${tool.name} (${tool.price}g; you have ${s.gold}).`]);
    s.gold -= tool.price;
    s.tools.push(tool.name);
    return ok(true, 0, [`You buy a ${tool.name}.`]);
  },

  peek(s: State, target: unknown): Step {
    if (!s.tools.includes('map')) return fail('peek: you need a map; camps sell one');
    const p = resolvePlace(s, target);
    if (!p) return fail(`peek: unknown place ${JSON.stringify(target)}`);
    see(s, p);
    return ok(view(s, p));
  },

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
      log.push(encounterLine(e));
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
      if (opt === 'pay') { s.pack = s.pack.filter((i) => i !== e.demand); log.push(`You hand over the ${e.demand!.name}. They let you pass.`); }
      else if (opt === 'flee') { extraCost = 3; if (next(s) < 0.4 && s.pack.length) { const i = Math.floor(next(s) * s.pack.length); log.push(`You run. The ${s.pack[i].name} falls and you don't go back for it.`); s.pack.splice(i, 1); } else log.push('You run, and they are not fast. It costs you supplies.'); }
      else { if (weight(s) <= 6) log.push('You crouch in the ferns. They pass.'); else { extraCost = 3; const i = s.pack.indexOf(e.demand!); if (i >= 0) s.pack.splice(i, 1); log.push(`Too laden to hide. They find you and take the ${e.demand!.name}.`); } }
    } else if (e.kind === 'storm') {
      if (opt === 'shelter') { extraCost = 2; log.push('You wait it out under a rock. Hours pass.'); return finish(s, dest, e, extraCost, log, 6); }
      else { if (next(s) < 0.5) { extraCost = 4; log.push('Soaked through. You eat into your supplies to keep warm.'); } else log.push('You push through and the rain lets up.'); }
    } else {
      if (opt === 'share') { extraCost = 2; const p = s.places.find((q) => !q.discovered); if (p) { p.discovered = true; log.push(`You share a meal. In return: ${p.name}, ${leagues(dist(p, s.places[s.here]))} ${dirTo(s.places[s.here], p)} of here.`); } else log.push('You share a meal. Good company, no news.'); }
      else log.push('You nod and keep walking.');
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
    if (!p) { log.push('You range about for hours. Nothing new within reach of here.'); return ok(null, 4, log); }
    p.discovered = true;
    log.push(`You climb for a view. ${p.name}: ${leagues(dist(p, h))} ${dirTo(h, p)} of here.`);
    return ok(view(s, p), 4, log);
  },

  gather(s: State): Step {
    const log: string[] = [];
    autoResolve(s, log);
    const h = s.places[s.here];
    if (h.kind === 'cave' && !s.tools.includes('lantern')) { log.push('Too dark to find anything. You feel your way back to the entrance.'); return ok([], 2, log); }
    if (h.stock <= 0) { log.push(h.kind === 'camp' ? 'Nothing to gather at a camp.' : 'Picked clean. Give it time.'); see(s, h); return ok([], 2, log); }
    const n = Math.min(h.stock, 1 + Math.floor(next(s) * 3));
    const got: Item[] = [];
    for (let i = 0; i < n; i++) {
      const pool = YIELD[h.kind];
      const item = pool[next(s) < 0.7 ? 0 : 1];
      got.push({ ...item });
      s.pack.push({ ...item });
    }
    h.stock -= n;
    see(s, h);
    const c: Record<string, Item> = {}; const n2: Record<string, number> = {};
    for (const i of got) { c[i.name] = i; n2[i.name] = (n2[i.name] ?? 0) + 1; }
    log.push(Object.keys(c).map((k) => `+${n2[k]} ${itemLine(c[k])}`).join(', ') + (weight(s) > CAPACITY ? '. You are overloaded.' : ''));
    return ok(got, 3, log);
  },

  rest(s: State, ticks?: unknown): Step {
    const n = ticks == null ? 10 : Math.floor(Number(ticks));
    if (!(n >= 1 && n <= 500)) return fail('rest: ticks must be between 1 and 500');
    const log: string[] = [];
    autoResolve(s, log);
    const h = s.places[s.here];
    if (h.kind !== 'camp') {
      const cost = Math.ceil(n / 10);
      if (s.supplies < cost) return strand(s, h, log);
      s.supplies -= cost;
    }
    log.push(h.kind === 'camp' ? 'You rest by the fire.' : 'You rest a while.');
    return ok(null, n, log);
  },

  drop(s: State, name: unknown): Step {
    const i = s.pack.findIndex((it) => it.name === String(name));
    if (i < 0) return ok(false, 0, [`You have no ${String(name)}.`]);
    s.pack.splice(i, 1);
    return ok(true, 0, [`You leave the ${String(name)} behind.`]);
  },
};

function fail(msg: string): Step { return { log: [], ticks: 0, result: { __error: msg } }; }

/** The player looks at a place: what they know about it becomes true again. */
function see(s: State, p: Place) { p.seen = p.stock; p.seenAt = s.time; }

/** A place as the player knows it: stock as last seen, and how long ago. */
function view(s: State, p: Place) {
  const h = s.places[s.here];
  return {
    id: p.id, name: p.name, kind: p.kind, distance: round(dist(h, p)), dir: p.id === h.id ? '' : dirTo(h, p),
    stock: p.seen, seenAgo: p.seenAt === null ? null : s.time - p.seenAt, visits: p.visits,
  };
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
  if (typeof t === 'string') { const n = t.trim().toLowerCase(); return s.places.find((p) => p.name.toLowerCase() === n && p.discovered) ?? null; }
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

function encounterLine(e: Encounter): string {
  const opts = e.options.map((o) => `'${o}'`).join(' | ');
  const what = e.kind === 'bandits' ? `Bandits on the road! They want the ${e.demand!.name}.`
    : e.kind === 'storm' ? 'A storm rolls in over the road.' : 'A traveler hails you from the verge.';
  return `${what}  choose(${opts})`;
}

/** An ignored encounter resolves itself, badly, before the next action. */
function autoResolve(s: State, log: string[]) {
  if (!s.pending) return;
  const { e } = s.pending;
  const worst = e.kind === 'bandits' ? 'pay' : e.kind === 'storm' ? 'push' : 'ignore';
  log.push(`You never answered the ${e.kind}.`, ...api.choose(s, worst).log);
}

function finish(s: State, destId: number, e: Encounter, extra: number, log: string[], extraTicks: number): Step {
  const dest = s.places[destId];
  const cost = Math.ceil(e.distanceLeft * (weight(s) > CAPACITY ? 2 : 1)) + extra;
  if (s.supplies < cost) return strand(s, dest, log, extraTicks);
  const r = arrive(s, dest, cost, log);
  return { ...r, ticks: r.ticks + extraTicks };
}

function arrive(s: State, dest: Place, cost: number, log: string[]): Step {
  const from = s.places[s.here];
  s.supplies -= cost;
  s.here = dest.id;
  const first = dest.visits === 0;
  dest.visits++;
  let ticks = Math.ceil(dist(from, dest)) || cost;
  see(s, dest);
  log.push(`You walk ${leagues(dist(from, dest))} ${dirTo(from, dest)}. ${dest.name}${first ? ', for the first time' : ''}. ${describe(dest)}${hereIs(s, dest)}`);
  if (dest.kind === 'camp') {
    const v = s.pack.reduce((a, i) => a + i.value, 0);
    if (v > 0) log.push(`Banked ${v} gold: ${summary(s.pack)}. Gold: ${s.gold + v}.`);
    s.gold += v;
    s.pack = [];
    rations(s, log);
    ticks += 2;
  }
  return ok(null, ticks, log);
}

function strand(s: State, dest: Place, log: string[], extraTicks = 0): Step {
  const camps = s.places.filter((p) => p.kind === 'camp' && p.discovered);
  const camp = camps.reduce((a, b) => (dist(b, dest) < dist(a, dest) ? b : a));
  log.push(`Your supplies run out on the way to ${dest.name}. You wake at ${camp.name}; someone carried you in. Your pack is gone (${summary(s.pack)}).`);
  s.pack = [];
  s.pending = null;
  s.here = camp.id;
  s.supplies = 0;
  s.stranded++;
  rations(s, log);
  return ok(null, 40 + extraTicks, log);
}

/** Nobody is stuck: at a camp, a traveller who can't afford to get back to RATIONS is fed up to it, free. */
function rations(s: State, log: string[]) {
  const short = RATIONS - s.supplies;
  if (short <= 0 || s.gold >= short * SUPPLY_PRICE) return;
  s.supplies = RATIONS;
  log.push(`The cook takes pity on you: rations, free. Supplies: ${RATIONS}.`);
}

/** Time passes: every place regrows at a steady rate. Called by the host with elapsed ticks. */
export function advance(s: State, ticks: number) {
  s.time += ticks;
  const whole = Math.floor(ticks / REGROW_TICKS), part = (ticks % REGROW_TICKS) / REGROW_TICKS;
  for (const p of s.places) {
    if (p.stock >= p.maxStock) continue;
    p.stock = Math.min(p.maxStock, p.stock + whole + (next(s) < part ? 1 : 0));
  }
}
