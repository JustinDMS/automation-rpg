import { describe, expect, test } from 'vitest';
import { Sandbox } from './sandbox';
import { createWorld, api } from './world';

function headless(seed: number) {
  const state = createWorld(seed);
  const lines: string[] = [];
  const sb = new Sandbox({ state, speed: () => 1e9, log: (l, c) => lines.push(`${c ?? ''}: ${l}`), changed: () => {} });
  return { state, lines, sb };
}

describe('probe world', () => {
  test('is deterministic', () => {
    const a = createWorld(3), b = createWorld(3);
    expect(a.places).toEqual(b.places);
    api.go(a, a.places[1]); api.go(b, b.places[1]);
    expect(a).toEqual(b);
  });

  test('a naive loop banks gold and gets stranded sometimes', async () => {
    const { state, lines, sb } = headless(1);
    await sb.run(`
      for (let i = 0; i < 40; i++) {
        const p = known().filter(p => p.kind !== 'camp')[0];
        go(p); gather(); go('Camp');
      }
    `);
    expect(lines.some((l) => l.includes('banked'))).toBe(true);
    expect(state.gold).toBeGreaterThan(0);
    expect(lines.filter((l) => l.startsWith('error')).length).toBe(0);
  });

  test('a smarter loop earns more than the naive one', async () => {
    const naive = headless(7), smart = headless(7);
    await naive.sb.run(`for (let i = 0; i < 60; i++) { go(known()[1]); gather(); go('Camp'); }`);
    await smart.sb.run(`
      const camp = () => known().find(p => p.kind === 'camp');
      const best = () => known().filter(p => p.kind !== 'camp' && p.stock > 0)
        .reduce((a, b) => (b.stock * (b.kind === 'ruin' ? 4 : 1)) / (b.distance + 1) > (a.stock * (a.kind === 'ruin' ? 4 : 1)) / (a.distance + 1) ? b : a);
      const handle = (e) => { if (!e) return; choose(e.kind === 'bandits' ? (pack().weight <= 6 ? 'hide' : 'flee') : e.kind === 'storm' ? 'shelter' : 'share'); };
      for (let i = 0; i < 60; i++) {
        if (supplies() > 12 && known().length < 10) scout();
        const p = best(); if (!p) { scout(); continue; }
        handle(go(p));
        while (pack().weight < pack().capacity && here().stock > 0) gather();
        if (supplies() - p.distance < 3 || pack().weight >= pack().capacity - 2) handle(go(camp()));
      }
    `);
    expect(naive.lines.filter((l) => l.startsWith('error'))).toEqual([]);
    expect(smart.lines.filter((l) => l.startsWith('error'))).toEqual([]);
    expect(smart.state.gold).toBeGreaterThan(naive.state.gold);
  });

  test('runaway loops and bad calls are reported, not fatal', { timeout: 15000 }, async () => {
    const { lines, sb } = headless(2);
    await sb.run('while (true) {}');
    expect(lines.some((l) => l.startsWith('error'))).toBe(true);
    const b = headless(2);
    await b.sb.run("go('Nowhere')");
    expect(b.lines.some((l) => l.includes('unknown place'))).toBe(true);
  });
});
