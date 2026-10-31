# Automation RPG (grey box)

An incremental RPG where you automate an adventurer by writing code in a tap-based language.
This is **prototype 1**: the Exploration skill only, with no art, to test one question —
*is writing and improving a 5–10 line script on a phone fun?*

Play: https://justindms.github.io/automation-rpg/ · Design doc: https://claude.ai/artifact/Ei2RUWui593PERf54BZLoC

## Run it

```bash
npm install
npm run dev      # open the printed URL; --host exposes it to your phone on the same network
npm test         # simulation tests, incl. "every unlock target is reachable"
npm run build
```

## How it plays

- Your program repeats forever; that loop is the idle engine. Each run has 300 ticks.
- **Benchmark** scores the program on 5 hidden maps. Best scores unlock language tiers:
  Motors → Sensors (field ≥ 10%) → Memory (maze ≥ 50%) → Loops (caves ≥ 75%).
- Loot from live runs buys instruction slots.

## Layout

| Path | What |
| --- | --- |
| `src/sim/` | Pure TypeScript simulation core, no UI deps: language tree + editing (`lang.ts`), seeded maps (`map.ts`), interpreter, runs and benchmark (`run.ts`), progression (`progress.ts`) |
| `src/ui/` | React UI: structured editor, canvas map, game loop hook |

The sim core is deterministic (same program + map + seed = same result), so the same code
can later verify leaderboard submissions on a server.
