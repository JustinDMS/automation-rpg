import { describe, expect, test } from 'vitest';
import { format, parseDefinition, Session } from './sandbox';
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
  test('definitions persist across inputs and values echo readably', async () => {
    const { s, lines, errors } = session(1);
    await s.eval('const camp = () => known().find(p => p.kind === "camp")');
    await s.eval('function twice(f) { f(); f(); }');
    await s.eval('camp().name');
    expect(lines.at(-1)).toBe('value: Camp');
    await s.eval('twice(() => gather())');
    expect(errors()).toEqual([]);
    expect(lines.filter((l) => l.includes('Nothing to gather')).length).toBe(2);
    expect(parseDefinition('const camp = 1')).toEqual({ name: 'camp', code: 'var camp = 1' });
    expect(parseDefinition('camp()')).toBeNull();
  });

  test('redefining replaces, the library is visible, and it replays into a new session', async () => {
    const a = session(1);
    await a.s.eval('const gather_x = (x) => { for (let i = 0; i < x; i++) gather(); }');
    expect(a.lines.at(-1)).toBe('value: gather_x saved to your library');
    await a.s.eval('const gather_x = (x) => x * 2'); // no redeclaration error
    expect(a.errors()).toEqual([]);
    expect(a.lines.at(-1)).toBe('value: gather_x updated in your library');
    await a.s.eval('gather_x(4)');
    expect(a.lines.at(-1)).toBe('value: 8');
    await a.s.eval('library()');
    expect(a.lines.at(-1)).toBe('input: var gather_x = (x) => x * 2');
    expect(a.s.defs.map((d) => d.name)).toEqual(['gather_x']);
    await a.s.eval('class Bag {}');
    await a.s.eval('class Bag { size() { return 3 } }');
    await a.s.eval('new Bag().size()');
    expect(a.lines.at(-1)).toBe('value: 3');

    const b = new Session({ state: () => createWorld(1), speed: () => 1e9, log: (l, c) => a.lines.push(`${c}: ${l}`), changed: () => {} }, a.s.defs);
    await b.eval('gather_x(5)');
    expect(a.lines.at(-1)).toBe('value: 10');
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
    await smart.s.eval('const camp = () => known().find(p => p.kind === "camp")');
    await smart.s.eval(`const best = () => known().filter(p => p.kind !== 'camp' && p.stock > 0)
      .reduce((a, b) => (b.stock * (b.kind === 'ruin' ? 4 : 1)) / (b.distance + 1) > (a.stock * (a.kind === 'ruin' ? 4 : 1)) / (a.distance + 1) ? b : a)`);
    await smart.s.eval(`const handle = (e) => { if (!e) return; choose(e.kind === 'bandits' ? (pack().weight <= 6 ? 'hide' : 'flee') : e.kind === 'storm' ? 'shelter' : 'share'); }`);
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
