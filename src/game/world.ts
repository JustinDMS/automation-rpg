// The world: one continuous expedition across an endless plane of places.
// Deterministic given its seed. Gold buys supplies, tools and outposts; tools add commands.
//
// The API has two kinds of command. Senses are free, return data and never narrate.
// Actions take time, change the world, narrate, and return nothing.

/** Small, fast, seeded random numbers. */
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

export type Kind = 'camp' | 'meadow' | 'forest' | 'ruin' | 'cave' | 'mine';

export interface Item { name: string; value: number; weight: number }
export interface Place {
  id: number; name: string; kind: Kind; x: number; y: number;
  stock: number; maxStock: number; discovered: boolean; visits: number;
  /** Stock as the player last saw it, and when. What you know, not what is true. */
  seen: number | null; seenAt: number | null;
  /** Founded by the player: works as a camp (banks, sells, feeds) and keeps whatever grows here. */
  outpost?: boolean;
}
/**
 * Something on the road. Each kind shows the facts that decide its outcome, and
 * outcomes follow fixed rules the player can learn by watching:
 * - bandits: pay loses what they want; hide works if your pack weighs 6 or less, otherwise
 *   they take it anyway and the scuffle costs 2 supplies; flee keeps everything and costs
 *   2 supplies per bandit.
 * - storm: shelter costs 10 ticks per point of severity, and waiting eats 1 supply per 10
 *   ticks; if an unknown cave lies within 4 leagues of your destination, you shelter in it
 *   and it becomes known. push costs 2 supplies per point.
 * - traveler: share costs 2 supplies and they tell you of an unknown camp within 12 leagues
 *   of your destination, or failing that the unknown place nearest it; ignore costs nothing.
 */
export type Encounter =
  | { kind: 'bandits'; options: string[]; facts: { count: number; wants: string } }
  | { kind: 'storm'; options: string[]; facts: { severity: number } }
  | { kind: 'traveler'; options: string[]; facts: { wants: string } };

export interface State {
  seed: number; rng: number; time: number;
  here: number; supplies: number; gold: number;
  pack: Item[]; places: Place[];
  pending: { e: Encounter; dest: number } | null;
  stranded: number;
  tools: Tool[];
  /** How many supplies you can carry; raised by the haversack and the mule. */
  maxSupplies: number;
  /** How much weight you can carry before walking costs double; raised by the pannier and the cart. */
  capacity: number;
  /** Times you've come home with something to bank. The road is quiet for the first few. */
  trips: number;
  /** Outer cells of the map already filled with places ("cx,cy"). The world grows as you go. */
  cells: string[];
  /** Outposts founded so far. Each one costs more than the last. */
  outposts: number;
}

/** No encounters until the player has banked this many trips. */
export const ENCOUNTERS_AFTER = 3;
export const HIDE_WEIGHT = 6;

export type Tool = 'pannier' | 'cart' | 'haversack' | 'mule' | 'lantern' | 'spyglass';

export const MAX_SUPPLIES = 20;
export const CAPACITY = 15;
export const SUPPLY_PRICE = 1;
/** A traveller at a camp who can't afford supplies is fed up to this many, free. */
export const RATIONS = 8;
/** Each place regains one item per this many ticks, up to its maximum. */
export const REGROW_TICKS = 25;
/** Waiting away from a camp eats 1 supply per this many ticks. */
export const FOOD_TICKS = 10;
/** scout() reveals everything unknown within SCOUT_NEAR leagues, or else the nearest unknown place, however far. */
export const SCOUT_NEAR = 4;
/** Places exist at least this far around anywhere you have stood, so scouting always has something to find. */
const GROW_REACH = 16;
/** Ruins, caves and mines give up their haul once; meadows and forests regrow. */
export const FINITE: Kind[] = ['ruin', 'cave', 'mine'];
/** An outpost costs this much per league from the nearest camp, plus OUTPOST_STEP per outpost already founded. */
export const OUTPOST_PER_LEAGUE = 10, OUTPOST_STEP = 50;
/** The starting world reaches this far; beyond it, places are made as you approach, CELL leagues square at a time. */
export const HOME_RADIUS = 24, CELL = 8;
export const TOOLS: { name: Tool; price: number; gives: string; needs?: Tool; carry?: number; capacity?: number }[] = [
  { name: 'pannier', price: 40, gives: 'carry 22 weight', capacity: 22 },
  { name: 'cart', price: 120, gives: 'carry 30 weight', needs: 'pannier', capacity: 30 },
  { name: 'haversack', price: 30, gives: 'carry 30 supplies', carry: 30 },
  { name: 'mule', price: 100, gives: 'carry 40 supplies', needs: 'haversack', carry: 40 },
  { name: 'lantern', price: 40, gives: 'gather in caves' },
  { name: 'spyglass', price: 60, gives: 'peek(place): what a known place holds right now, visited or not, from anywhere' },
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
/** A camp, or an outpost you founded: somewhere to bank, buy and rest. */
export const isCamp = (p: Place) => p.kind === 'camp' || !!p.outpost;
const finite = (p: Place) => FINITE.includes(p.kind);
const level = (p: Place) => p.stock === 0 ? (finite(p) ? 'stripped' : 'picked clean') : p.stock < p.maxStock / 3 ? 'thin' : p.stock < p.maxStock * 0.8 ? 'some' : 'plenty';
const camps = (s: State) => s.places.filter((p) => p.discovered && isCamp(p));
const nearestCamp = (s: State, to: Place) => camps(s).reduce((a, b) => (dist(b, to) < dist(a, to) ? b : a));
/** What founding an outpost here costs. */
const outpostPrice = (s: State, p: Place) => OUTPOST_PER_LEAGUE * legs(dist(nearestCamp(s, p), p)) + OUTPOST_STEP * s.outposts;
const DIRS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
const dirTo = (a: Place, b: Place) => DIRS[Math.round(Math.atan2(-(b.y - a.y), b.x - a.x) / (Math.PI / 4) + 8) % 8];
/** Whole leagues between two places: what the prose says, what known() reports, and what a walk costs. */
const legs = (d: number) => Math.max(1, Math.round(d));
const leagues = (d: number) => { const n = legs(d); return `${n} league${n === 1 ? '' : 's'}`; };
const describe = (p: Place) => DESC[p.kind][p.id % DESC[p.kind].length];
const hereIs = (s: State, p: Place) => {
  if (p.kind === 'camp') return ' A quartermaster keeps a shop here.';
  const shop = p.outpost ? ' Your outpost: a shop and a fire.' : '';
  if (p.kind === 'cave' && !s.tools.includes('lantern')) return `${shop} Too dark to see what is here.`;
  const [a, b] = YIELD[p.kind];
  if (p.stock > 0) return `${shop} ${cap(a.name)} here (${level(p)}), maybe ${b.name}.`;
  return `${shop} Nothing left to take: ${a.name} and ${b.name} once, now ${level(p)}${finite(p) ? ' for good' : ''}.`;
};
/** One line for a place you have been before: the facts, no scenery. */
const brief = (s: State, p: Place) => {
  if (p.kind === 'camp') return `${p.name}.`;
  const name = `${p.name} (${p.outpost ? `${p.kind}, outpost` : p.kind})`;
  if (p.kind === 'cave' && !s.tools.includes('lantern')) return `${name}. Too dark to see.`;
  return `${name}. ${cap(YIELD[p.kind][0].name)}: ${level(p)}.`;
};
const cap = (t: string) => t[0].toUpperCase() + t.slice(1);
const itemLine = (i: Item) => `${i.name} (${i.value}g${i.weight >= 3 ? ', heavy' : ''})`;

export function createWorld(seed: number): State {
  const rand = mulberry32(seed);
  const places: Place[] = [{ id: 0, name: 'Camp', kind: 'camp', x: 0, y: 0, stock: 0, maxStock: 0, discovered: true, visits: 1, seen: 0, seenAt: 0 }];
  const used: Record<string, number> = {};
  const nameFor = (kind: Kind) => {
    const n = (used[kind] = (used[kind] ?? 0) + 1);
    const names = kind === 'camp' ? NAMES.camp.slice(1) : NAMES[kind]; // 'Camp' is the start
    const base = names[(n - 1) % names.length];
    return n > names.length ? `${base} ${Math.ceil(n / names.length)}` : base;
  };
  const kinds: Kind[] = ['meadow', 'forest', 'ruin', 'cave', 'mine', 'camp'];
  // Rings of places: richer kinds further out.
  for (let i = 1; i < 45; i++) {
    const r = 2 + rand() * 22, a = rand() * Math.PI * 2;
    // Order: meadow, forest, ruin, cave, mine, camp. Only meadows and forests near the start.
    const weights = r < 7 ? [5, 3, 0, 0, 0, 0] : r < 14 ? [1, 3, 2, 2, 0.5, 0.6] : [0.5, 1, 3, 3, 3, 0.6];
    const kind = pick(kinds, weights, rand());
    const name = nameFor(kind);
    const maxStock = stockFor(kind, r, rand);
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
    forest.name = nameFor('forest');
  }
  meadow.discovered = forest.discovered = true;
  // A door for the lantern: a cave within reach of the start (7 to 10 leagues out). If none
  // was rolled, the place nearest 8.5 leagues out becomes one.
  const r0 = (p: Place) => dist(p, places[0]);
  if (!places.some((p) => p.kind === 'cave' && r0(p) >= 7 && r0(p) <= 10)) {
    const c = places.filter((p) => p.kind !== 'camp' && !p.discovered).sort((p, q) => Math.abs(r0(p) - 8.5) - Math.abs(r0(q) - 8.5))[0];
    if (r0(c) < 7 || r0(c) > 10) { const k = 8.5 / r0(c); c.x = round(c.x * k); c.y = round(c.y * k); }
    c.kind = 'cave';
    c.name = nameFor('cave');
    c.maxStock = c.stock = stockFor('cave', r0(c), rand);
  }
  return { seed, rng: seed ^ 0x9e3779b9, time: 0, here: 0, supplies: MAX_SUPPLIES, gold: 0, pack: [], places, pending: null, stranded: 0, tools: [], trips: 0, maxSupplies: MAX_SUPPLIES, capacity: CAPACITY, cells: [], outposts: 0 };
}

/** How much a place holds, richer the further out. Finite places vary a lot: some hauls are poor, some great. */
function stockFor(kind: Kind, r: number, rand: () => number): number {
  if (kind === 'camp') return 0;
  const base = 6 + r * 0.8;
  return FINITE.includes(kind) ? Math.max(3, Math.round(base * (0.4 + rand() * 1.2))) : Math.round(base);
}

/**
 * Past the starting world, places are made a cell at a time as the player comes within reach,
 * each cell from its own seed, so where you go never changes what is out there.
 */
function grow(s: State, around: Place) {
  const reach = GROW_REACH + CELL;
  if (Math.hypot(around.x, around.y) + reach < HOME_RADIUS) return;
  const done = new Set(s.cells);
  for (let cx = Math.floor((around.x - reach) / CELL); cx <= Math.floor((around.x + reach) / CELL); cx++) {
    for (let cy = Math.floor((around.y - reach) / CELL); cy <= Math.floor((around.y + reach) / CELL); cy++) {
      const key = `${cx},${cy}`;
      if (done.has(key)) continue;
      done.add(key);
      s.cells.push(key);
      const rand = mulberry32((s.seed * 73856093) ^ (cx * 19349663) ^ (cy * 83492791));
      const n = 1 + Math.floor(rand() * 2.4); // about 1.7 places per cell, as dense as the start
      for (let i = 0; i < n; i++) {
        const x = round((cx + rand()) * CELL), y = round((cy + rand()) * CELL), r = Math.hypot(x, y);
        const kind = pick(['meadow', 'forest', 'ruin', 'cave', 'mine', 'camp'] as Kind[], [0.8, 1.2, 3, 3, 3, 0.7], rand());
        if (r < HOME_RADIUS) continue;
        const maxStock = stockFor(kind, r, rand);
        s.places.push({ id: s.places.length, name: nameIn(s, kind), kind, x, y, stock: maxStock, maxStock, discovered: false, visits: 0, seen: null, seenAt: null });
      }
    }
  }
}

/** The first unused name for a place of this kind; once the list runs out, names repeat with a number. */
function nameIn(s: State, kind: Kind): string {
  const names = kind === 'camp' ? NAMES.camp.slice(1) : NAMES[kind];
  const taken = new Set(s.places.map((p) => p.name.toLowerCase()));
  for (let round = 1; ; round++) {
    const free = names.map((n) => (round === 1 ? n : `${n} ${round}`)).find((n) => !taken.has(n.toLowerCase()));
    if (free) return free;
  }
}

/** Bring a saved world from an earlier version up to date. */
export function upgradeState(s: State): State {
  s.tools ??= [];
  s.tools = s.tools.map((t) => ((t as string) === 'map' ? 'spyglass' : t)); // the map was renamed
  s.maxSupplies ??= MAX_SUPPLIES;
  s.capacity ??= CAPACITY;
  s.trips ??= ENCOUNTERS_AFTER; // anyone with an old save has been on the road already
  s.cells ??= [];
  s.outposts ??= 0;
  if (s.pending && !('facts' in s.pending.e)) s.pending = null; // an old-style encounter just passes
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
/** An action: it narrates and returns nothing. */
const did = (ticks: number, log: string[]): Step => ({ log, ticks, result: undefined });

type HelpEntry = [sig: string, short: string, detail: string];
const HELP: { title: string; entries: HelpEntry[] }[] = [
  {
    title: 'Sense: free, returns data',
    entries: [
      ['here()', 'this place', 'This place: name, kind, stock as you see it now, and what an outpost here would cost.'],
      ['known()', 'places you know, as last seen', 'Every place you know: its distance in leagues from here, where it lies (x east, y south, in leagues from the first camp), and its stock as you last saw it (null if you have never been). seenAgo says how many ticks ago that was. Camps and outposts have camp: true.'],
      ['pack()', 'what you carry', 'Your items, their total weight and value, your weight capacity, and your supplies out of how many you can carry. Over weight capacity, walking costs double.'],
      ['supplies()', 'supplies left', 'Walking costs 1 supply per league. Run out on the road and you wake at a camp without your pack.'],
      ['gold()', 'gold banked', 'Reaching any camp turns your pack into gold.'],
      ['shop()', 'what camps sell', 'Everything camps sell, its price, and whether you own it.'],
      ['peek(place)', 'a place as it is now', 'A known place as it is right now, from anywhere, even one you have never visited. Needs a spyglass.'],
      ['encounter()', 'what waits on the road', 'Whatever has stopped you on the road, with the facts that decide how it goes, or null. Answer it with choose().'],
    ],
  },
  {
    title: 'Act: takes time, tells you what happened',
    entries: [
      ['go(place)', 'walk somewhere', "Walk to a known place, e.g. go('old wood'). Something may stop you on the road: see encounter()."],
      ['gather()', 'take what is here', 'Take 1 to 3 items from this place. Meadows and forests regrow; ruins, caves and mines give up their haul once.'],
      ['scout()', 'look for new places', 'Reveals every unknown place within 4 leagues, or if there are none, the nearest unknown place. Costs 2 supplies.'],
      ['bank()', 'cash in your pack', 'At a camp or outpost: turn your pack into gold without leaving. Arriving at one does this too.'],
      ['settle()', 'found an outpost here', 'Found an outpost where you stand: it banks your pack, sells supplies and tools, and feeds you like any camp. here() shows the price: more the further from a camp, and more for each outpost you have.'],
      ['choose(option)', 'answer an encounter', "Answer what has stopped you, e.g. choose('hide'). An encounter left unanswered settles itself, badly, at your next action."],
      ['buy(item, n)', 'buy at a camp', "At a camp: buy('supplies', 10), buy('haversack'). Buying more supplies than you can carry or afford buys what you can."],
      ['drop(name)', 'leave an item', "Leave one item behind, e.g. drop('timber')."],
      ['rest(ticks)', 'let time pass', 'Let time pass while places regrow. Free at a camp; away from one, waiting eats 1 supply per 10 ticks.'],
    ],
  },
  {
    title: 'Console',
    entries: [
      ['look()', 'describe where you are', 'Where you are, what is here, what you know nearby, and what you carry.'],
      ['help(cmd)', 'more on one command', "More on one command, e.g. help('go')."],
      ['print(...)', 'write a line', 'Write values to the console.'],
    ],
  },
];
const ALL_HELP = HELP.flatMap((g) => g.entries);
/** Every command with its signature and one-line summary, for completion. */
export const COMMANDS = ALL_HELP.map(([sig, short]) => ({ name: sig.slice(0, sig.indexOf('(')), sig, short }));

export const api = {
  // ---- Senses: free, return data, never narrate ----
  here: (s: State) => { const h = s.places[s.here]; see(s, h); return ok({ ...view(s, h), ...(isCamp(h) ? {} : { outpostPrice: outpostPrice(s, h) }) }); },
  known: (s: State) => ok(s.places.filter((p) => p.discovered).map((p) => view(s, p))),
  pack: (s: State) => ok({ items: s.pack, weight: weight(s), value: s.pack.reduce((a, i) => a + i.value, 0), capacity: s.capacity, supplies: s.supplies, maxSupplies: s.maxSupplies }),
  supplies: (s: State) => ok(s.supplies),
  gold: (s: State) => ok(s.gold),
  shop: (s: State) => ok([
    { name: 'supplies', price: SUPPLY_PRICE, gives: `walking; you carry ${s.supplies}/${s.maxSupplies}` },
    ...TOOLS.map((t) => ({ name: t.name, price: t.price, gives: t.gives, needs: t.needs, owned: s.tools.includes(t.name) })),
  ]),
  peek(s: State, target: unknown): Step {
    if (!s.tools.includes('spyglass')) return fail('peek: you need a spyglass; camps sell one');
    const p = resolvePlace(s, target);
    if (!p) return fail(`peek: unknown place ${JSON.stringify(target)}`);
    see(s, p);
    return ok(view(s, p));
  },
  encounter: (s: State) => ok(s.pending ? { kind: s.pending.e.kind, ...s.pending.e.facts, options: s.pending.e.options, heading: s.places[s.pending.dest].name } : null),

  // ---- Console ----
  look(s: State): Step {
    const h = s.places[s.here];
    see(s, h);
    const roads = s.places.filter((p) => p.discovered && p.id !== h.id)
      .sort((a, b) => dist(a, h) - dist(b, h)).slice(0, 6)
      .map((p) => `${p.name} (${leagues(dist(p, h))} ${dirTo(h, p)})`).join(', ');
    const pack = s.pack.length ? summary(s.pack) + ` · ${weight(s)}/${s.capacity} weight · ${s.pack.reduce((a, i) => a + i.value, 0)}g` : 'empty';
    const lines = [`${h.name}. ${describe(h)}${hereIs(s, h)}`, `Known from here: ${roads || 'nothing yet'}.`, `Pack: ${pack}. Supplies: ${s.supplies}/${s.maxSupplies}. Gold: ${s.gold}.`];
    if (s.pending) lines.push(encounterLine(s.pending.e));
    return ok(undefined, 0, lines);
  },
  help(_s: State, what: unknown): Step {
    if (what == null) {
      const lines = HELP.flatMap((g) => [g.title, ...g.entries.map(([sig, short]) => `  ${sig.padEnd(16)} ${short}`)]);
      return { ...ok(undefined, 0, lines), mono: true };
    }
    const name = String(what).toLowerCase().replace(/\(.*$/, '');
    const t = ALL_HELP.find(([sig]) => sig.startsWith(name + '('));
    return { ...ok(undefined, 0, [t ? `${t[0]}  ${t[2]}` : `no such command: ${String(what)}`]), mono: true };
  },

  // ---- Actions: take time, narrate, return nothing ----
  go(s: State, target: unknown): Step {
    const dest = resolvePlace(s, target);
    if (!dest) return fail(`go: unknown place ${JSON.stringify(target)}`);
    if (dest.id === s.here) return did(0, [`You are already at ${dest.name}.`]);
    const log: string[] = [];
    autoResolve(s, log);
    const d = dist(s.places[s.here], dest);
    if (s.supplies < walkCost(s, d)) return strand(s, dest, log);
    // Roughly one encounter per 30 leagues walked, once the player has found their feet.
    if (s.trips >= ENCOUNTERS_AFTER && next(s) < Math.min(0.25, legs(d) * 0.035)) {
      const e = roll(s);
      s.pending = { e, dest: dest.id };
      log.push(encounterLine(e));
      return did(0, log);
    }
    return arrive(s, dest, 0, 0, log);
  },

  choose(s: State, option: unknown): Step {
    if (!s.pending) return fail('choose: nothing is waiting on the road');
    const { e, dest } = s.pending;
    const opt = String(option).trim().toLowerCase();
    if (!e.options.includes(opt)) return fail(`choose: ${String(option)} is not one of ${e.options.join(', ')}`);
    s.pending = null;
    const log: string[] = [];
    let extraSupplies = 0, extraTicks = 0;
    if (e.kind === 'bandits') {
      const take = () => { const i = s.pack.findIndex((it) => it.name === e.facts.wants); if (i >= 0) s.pack.splice(i, 1); };
      if (opt === 'pay') { take(); log.push(`You hand over the ${e.facts.wants}. They let you pass.`); }
      else if (opt === 'hide') {
        if (weight(s) <= HIDE_WEIGHT) log.push('You crouch in the ferns with your light pack. They pass.');
        else { take(); extraSupplies = 2; log.push(`Too laden to hide. They find you, take the ${e.facts.wants}, and the scuffle costs you 2 supplies.`); }
      } else { extraSupplies = 2 * e.facts.count; log.push(`You outrun ${e.facts.count === 1 ? 'him' : 'them'}, the long way round: ${extraSupplies} supplies.`); }
    } else if (e.kind === 'storm') {
      if (opt === 'shelter') {
        extraTicks = 10 * e.facts.severity;
        extraSupplies = Math.ceil(extraTicks / FOOD_TICKS); // waiting away from camp eats food
        const target = s.places[dest];
        const cave = s.places.filter((q) => !q.discovered && q.kind === 'cave' && dist(q, target) <= 4).sort((a, b) => dist(a, target) - dist(b, target))[0];
        if (cave) { cave.discovered = true; log.push(`You shelter in the mouth of ${cave.name}, ${leagues(dist(cave, target))} ${dirTo(target, cave)} of ${target.name}: ${extraTicks} ticks, ${extraSupplies} supplies.`); }
        else log.push(`You wait it out under a rock: ${extraTicks} ticks, ${extraSupplies} supplies.`);
      }
      else { extraSupplies = 2 * e.facts.severity; log.push(`You push through, soaked: ${extraSupplies} supplies.`); }
    } else if (opt === 'share') {
      extraSupplies = 2;
      const target = s.places[dest];
      const unknown = s.places.filter((q) => !q.discovered).sort((a, b) => dist(a, target) - dist(b, target));
      const p = unknown.find((q) => q.kind === 'camp' && dist(q, target) <= 12) ?? unknown[0];
      if (p) { p.discovered = true; log.push(`You share a meal. In return: ${p.name}, ${leagues(dist(p, target))} ${dirTo(target, p)} of ${target.name}.`); }
      else log.push('You share a meal. Good company, no news.');
    } else log.push('You nod and keep walking.');
    return arrive(s, s.places[dest], extraSupplies, extraTicks, log);
  },

  gather(s: State): Step {
    const log: string[] = [];
    autoResolve(s, log);
    const h = s.places[s.here];
    if (h.kind === 'cave' && !s.tools.includes('lantern')) { log.push('Too dark to find anything. You feel your way back to the entrance.'); return did(2, log); }
    if (h.stock <= 0) { log.push(h.kind === 'camp' ? 'Nothing to gather at a camp.' : finite(h) ? 'Stripped bare. Nothing here will come back.' : 'Picked clean. Give it time.'); see(s, h); return did(2, log); }
    const n = Math.min(h.stock, 1 + Math.floor(next(s) * 3));
    const got: Item[] = [];
    for (let i = 0; i < n; i++) {
      const item = YIELD[h.kind][next(s) < 0.7 ? 0 : 1];
      got.push({ ...item });
      s.pack.push({ ...item });
    }
    h.stock -= n;
    see(s, h);
    const c: Record<string, Item> = {}; const counts: Record<string, number> = {};
    for (const i of got) { c[i.name] = i; counts[i.name] = (counts[i.name] ?? 0) + 1; }
    log.push(Object.keys(c).map((k) => `+${counts[k]} ${itemLine(c[k])}`).join(', ') + (weight(s) > s.capacity ? '. You are overloaded.' : ''));
    return did(3, log);
  },

  scout(s: State): Step {
    const log: string[] = [];
    autoResolve(s, log);
    if (s.supplies < 2) return strand(s, s.places[s.here], log);
    s.supplies -= 2;
    const h = s.places[s.here];
    grow(s, h);
    // Everything unknown within SCOUT_NEAR leagues; if there is nothing that close, the nearest unknown place.
    const unknown = s.places.filter((q) => !q.discovered).sort((a, b) => dist(a, h) - dist(b, h));
    let found = unknown.filter((q) => dist(q, h) <= SCOUT_NEAR);
    if (!found.length) found = unknown.slice(0, 1);
    if (!found.length) { log.push('You range about for hours. Nothing new anywhere.'); return did(4, log); }
    for (const p of found) p.discovered = true;
    log.push(`You climb for a view. ${found.map((p) => `${p.name} (${p.kind}), ${leagues(dist(p, h))} ${dirTo(h, p)}`).join('; ')}.`);
    return did(4, log);
  },

  buy(s: State, item: unknown, count?: unknown): Step {
    const name = String(item).trim().toLowerCase();
    if (!isCamp(s.places[s.here])) return fail('buy: shops are at camps and outposts');
    if (name === 'supplies' || name === 'supply') {
      const want = count == null ? 1 : Math.floor(Number(count));
      if (want === 0) return did(0, []);
      if (!(want > 0)) return fail(`buy: can't buy ${String(count)} supplies`);
      const room = s.maxSupplies - s.supplies;
      const n = Math.min(want, room, Math.floor(s.gold / SUPPLY_PRICE));
      if (n <= 0) {
        const log = [room === 0 ? 'You can carry no more supplies.' : `You can't afford supplies (${SUPPLY_PRICE}g each; you have ${s.gold}).`];
        rations(s, log);
        return did(0, log);
      }
      s.supplies += n;
      s.gold -= n * SUPPLY_PRICE;
      const why = n < want ? (n === room ? ' That is all you can carry.' : ' That is all you can afford.') : '';
      return did(0, [`You buy ${n} supplies for ${n * SUPPLY_PRICE} gold. Supplies: ${s.supplies}/${s.maxSupplies}.${why}`]);
    }
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return fail(`buy: nobody sells ${JSON.stringify(item)}; see shop()`);
    if (s.tools.includes(tool.name)) return did(0, [`You already have a ${tool.name}.`]);
    if (tool.needs && !s.tools.includes(tool.needs)) return did(0, [`You need a ${tool.needs} first.`]);
    if (s.gold < tool.price) return did(0, [`You can't afford the ${tool.name} (${tool.price}g; you have ${s.gold}).`]);
    s.gold -= tool.price;
    s.tools.push(tool.name);
    if (tool.carry) { s.maxSupplies = Math.max(s.maxSupplies, tool.carry); return did(0, [`You buy a ${tool.name}. You can carry ${s.maxSupplies} supplies.`]); }
    if (tool.capacity) { s.capacity = Math.max(s.capacity, tool.capacity); return did(0, [`You buy a ${tool.name}. You can carry ${s.capacity} weight.`]); }
    return did(0, [`You buy a ${tool.name}.`]);
  },

  drop(s: State, name: unknown): Step {
    const i = s.pack.findIndex((it) => it.name === String(name));
    if (i < 0) return did(0, [`You have no ${String(name)}.`]);
    s.pack.splice(i, 1);
    return did(0, [`You leave the ${String(name)} behind.`]);
  },

  rest(s: State, ticks?: unknown): Step {
    const n = ticks == null ? 10 : Math.floor(Number(ticks));
    if (!(n >= 1 && n <= 500)) return fail('rest: ticks must be between 1 and 500');
    const log: string[] = [];
    autoResolve(s, log);
    const h = s.places[s.here];
    if (!isCamp(h)) {
      const cost = Math.ceil(n / FOOD_TICKS);
      if (s.supplies < cost) return strand(s, h, log);
      s.supplies -= cost;
    }
    log.push(isCamp(h) ? 'You rest by the fire.' : 'You rest a while.');
    return did(n, log);
  },

  bank(s: State): Step {
    const log: string[] = [];
    autoResolve(s, log);
    if (!isCamp(s.places[s.here])) return did(0, [...log, 'Nobody here buys anything. Bank at a camp or an outpost.']);
    if (!s.pack.length) return did(0, [...log, 'Your pack is empty.']);
    bank(s, log);
    return did(2, log);
  },

  settle(s: State): Step {
    const log: string[] = [];
    autoResolve(s, log);
    const h = s.places[s.here];
    if (isCamp(h)) return did(0, [...log, `${h.name} already has a fire and a shop.`]);
    const price = outpostPrice(s, h);
    if (s.gold < price) return did(0, [...log, `An outpost here costs ${price} gold; you have ${s.gold}.`]);
    s.gold -= price;
    s.outposts++;
    h.outpost = true;
    log.push(`You raise a hut, dig a fire pit and hire a quartermaster: ${price} gold. ${h.name} is an outpost now.`);
    bank(s, log);
    return did(20, log);
  },
};

function fail(msg: string): Step { return { log: [], ticks: 0, result: { __error: msg } }; }

/** The player looks at a place: what they know about it becomes true again. */
function see(s: State, p: Place) { p.seen = p.stock; p.seenAt = s.time; }

/** A place as the player knows it: stock as last seen, and how long ago. */
function view(s: State, p: Place) {
  const h = s.places[s.here];
  return {
    id: p.id, name: p.name, kind: p.kind, distance: p.id === h.id ? 0 : legs(dist(h, p)), x: p.x, y: p.y,
    stock: p.seen, seenAgo: p.seenAt === null ? null : s.time - p.seenAt, ...(isCamp(p) ? { camp: true } : {}),
  };
}
const weight = (s: State) => s.pack.reduce((a, i) => a + i.weight, 0);
const walkCost = (s: State, d: number) => legs(d) * (weight(s) > s.capacity ? 2 : 1);
const summary = (items: Item[]) => {
  const c: Record<string, number> = {};
  for (const i of items) c[i.name] = (c[i.name] ?? 0) + 1;
  return Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
};

function resolvePlace(s: State, t: unknown): Place | null {
  if (t && typeof t === 'object' && 'id' in t) { const p = s.places[Number((t as { id: unknown }).id)]; return p?.discovered ? p : null; }
  if (typeof t === 'number') { const p = s.places[t]; return p?.discovered ? p : null; }
  if (typeof t === 'string') { const n = t.trim().toLowerCase(); return s.places.find((p) => p.name.toLowerCase() === n && p.discovered) ?? null; }
  return null;
}

function roll(s: State): Encounter {
  const r = next(s);
  if (r < 0.45 && s.pack.length) {
    const wants = s.pack.reduce((a, b) => (b.value > a.value ? b : a)).name;
    return { kind: 'bandits', options: ['pay', 'hide', 'flee'], facts: { count: 1 + Math.floor(next(s) * 4), wants } };
  }
  if (r < 0.75) return { kind: 'storm', options: ['shelter', 'push'], facts: { severity: 1 + Math.floor(next(s) * 3) } };
  return { kind: 'traveler', options: ['share', 'ignore'], facts: { wants: '2 supplies' } };
}

const NUMBER = ['', 'A lone bandit', 'Two bandits', 'Three bandits', 'Four bandits'];
const SEVERITY = ['', 'A squall', 'A storm', 'A great storm'];
function encounterLine(e: Encounter): string {
  const opts = e.options.map((o) => `'${o}'`).join(' | ');
  const what = e.kind === 'bandits' ? `${NUMBER[e.facts.count]} on the road! They want your ${e.facts.wants}.`
    : e.kind === 'storm' ? `${SEVERITY[e.facts.severity]} rolls in over the road (severity ${e.facts.severity}).`
      : 'A traveler hails you from the verge, hungry.';
  return `${what}  choose(${opts})`;
}

/** An ignored encounter settles itself, badly, before the next action. */
function autoResolve(s: State, log: string[]) {
  if (!s.pending) return;
  const { e } = s.pending;
  const worst = e.kind === 'bandits' ? 'pay' : e.kind === 'storm' ? 'push' : 'ignore';
  log.push(`You never answered the ${e.kind}.`, ...api.choose(s, worst).log);
}

function arrive(s: State, dest: Place, extraSupplies: number, extraTicks: number, log: string[]): Step {
  const from = s.places[s.here];
  const d = dist(from, dest);
  const cost = walkCost(s, d) + extraSupplies;
  if (s.supplies < cost) { const r = strand(s, dest, log); return { ...r, ticks: r.ticks + extraTicks }; }
  s.supplies -= cost;
  s.here = dest.id;
  grow(s, dest);
  const first = dest.visits === 0;
  dest.visits++;
  let ticks = legs(d) + extraTicks;
  see(s, dest);
  log.push(first
    ? `You walk ${leagues(d)} ${dirTo(from, dest)}. ${dest.name}, for the first time. ${describe(dest)}${hereIs(s, dest)}`
    : `You walk ${leagues(d)} ${dirTo(from, dest)} to ${brief(s, dest)}`);
  if (isCamp(dest)) { bank(s, log); ticks += 2; }
  return did(ticks, log);
}

/** At a camp or outpost: the pack turns into gold, and nobody goes hungry. */
function bank(s: State, log: string[]) {
  const v = s.pack.reduce((a, i) => a + i.value, 0);
  if (v > 0) { log.push(`Banked ${v} gold: ${summary(s.pack)}. Gold: ${s.gold + v}.`); s.trips++; }
  s.gold += v;
  s.pack = [];
  rations(s, log);
}

function strand(s: State, dest: Place, log: string[]): Step {
  const camp = nearestCamp(s, dest);
  log.push(`Your supplies run out on the way to ${dest.name}. You wake at ${camp.name}; someone carried you in. Your pack is gone (${summary(s.pack)}).`);
  s.pack = [];
  s.pending = null;
  s.here = camp.id;
  s.supplies = 0;
  s.stranded++;
  rations(s, log);
  return did(40, log);
}

/**
 * Nobody is stuck: at a camp, a traveller who can't afford food for a round trip to the nearest
 * known place with anything left to gather (and at least RATIONS) is fed that much, free.
 */
function rations(s: State, log: string[]) {
  const camp = s.places[s.here];
  const targets = s.places.filter((p) => p.discovered && p.kind !== 'camp' && p.seen !== 0 && !(finite(p) && p.seen === null) && (p.kind !== 'cave' || s.tools.includes('lantern')));
  const nearest = targets.reduce((a, b) => (!a || dist(b, camp) < dist(a, camp) ? b : a), null as Place | null);
  const need = Math.min(s.maxSupplies, Math.max(RATIONS, nearest ? 2 * legs(dist(nearest, camp)) + 1 : RATIONS));
  const short = need - s.supplies;
  if (short <= 0 || s.gold >= short * SUPPLY_PRICE) return;
  s.supplies = need;
  log.push(`The cook takes pity on you: rations, free. Supplies: ${need}.`);
}

/** Time passes: meadows and forests regrow at a steady rate. Called by the host with elapsed ticks. */
export function advance(s: State, ticks: number) {
  s.time += ticks;
  const whole = Math.floor(ticks / REGROW_TICKS), part = (ticks % REGROW_TICKS) / REGROW_TICKS;
  for (const p of s.places) {
    if (p.stock >= p.maxStock || finite(p)) continue;
    p.stock = Math.min(p.maxStock, p.stock + whole + (next(s) < part ? 1 : 0));
  }
}
