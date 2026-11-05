import { describe, expect, test } from 'vitest';
import { format, redeclarable, Session } from './sandbox';
import { api, createWorld } from './world';

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
    await smart.s.loadLibrary(`const camp = () => known().find(p => p.kind === "camp")
const best = () => known().filter(p => p.kind !== 'camp' && p.stock > 0)
  .reduce((a, b) => (b.stock * (b.kind === 'ruin' ? 4 : 1)) / (b.distance + 1) > (a.stock * (a.kind === 'ruin' ? 4 : 1)) / (a.distance + 1) ? b : a)
const handle = (e) => { if (!e) return; choose(e.kind === 'bandits' ? (pack().weight <= 6 ? 'hide' : 'flee') : e.kind === 'storm' ? 'shelter' : 'share'); }`);
    await smart.s.eval(`for (let i = 0; i < 60; i++) {
      if (supplies() > 12 && known().length < 10) scout();
      const p = best(); if (!p) { scout(); continue; }
      handle(go(p));
      while (pack().weight < pack().capacity && here().stock > 0) gather();
      if (supplies() - p.distance < 3 || pack().weight >= pack().capacity - 2) handle(go(camp()));
    }`);
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

describe('generation', () => {
  test('names are unique, camps keep their distance, starting places are gatherable', () => {
    for (let seed = 1; seed < 40; seed++) {
      const w = createWorld(seed);
      const names = w.places.map((p) => p.name);
      expect(new Set(names).size).toBe(names.length);
      for (const p of w.places.slice(1)) if (p.kind === 'camp') expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(7);
      const start = w.places.filter((p) => p.discovered && p.id !== 0);
      expect(start.length).toBe(2);
      for (const p of start) expect(p.kind).not.toBe('camp');
    }
  });
});
