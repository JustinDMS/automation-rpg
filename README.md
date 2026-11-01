# Automation RPG (grey box)

An incremental RPG where you automate an adventurer by writing code in a tap-based language.
This is **prototype 1**: the Exploration skill only, with no art, to test one question —
*is writing and improving a 5–10 line script on a phone fun?*

Probe (current): https://justindms.github.io/automation-rpg/probe.html · Prototype 1 (superseded): https://justindms.github.io/automation-rpg/ · Design doc: https://claude.ai/artifact/Ei2RUWui593PERf54BZLoC

## Run it

```bash
npm install
npm run dev      # open the printed URL; --host exposes it to your phone on the same network
npm test         # simulation tests, incl. "every unlock target is reachable"
npm run build
```

## How it plays

- Your program repeats forever; that loop is the idle engine. Each run has 300 ticks on a new map.
- **Goals** are judged on the average of 3 runs in a row with the same program. Editing restarts the count.
  Goals unlock language tiers: Motors → Sensors (field ≥ 10%) → Memory (maze ≥ 50%) → Loops (caves ≥ 60%).
- No line limit. Each goal has an optional ★ for reaching it in few lines.
- Controls and maps appear as they become relevant, so the first screen is just map, Run, goal and editor.

## Probe: the JavaScript console

`probe.html` is a throwaway sandbox to find out what it's like to write JavaScript against a
continuous expedition world: places to discover, gather from and carry loot home from, with
encounters on the road. Player code runs in QuickJS (WebAssembly); calls that take game time
block the script, so code is plain and synchronous. Source in `src/probe/`.

## Layout

| Path | What |
| --- | --- |
| `src/sim/` | Pure TypeScript simulation core, no UI deps: language tree + editing (`lang.ts`), seeded maps (`map.ts`), interpreter, runs and benchmark (`run.ts`), progression (`progress.ts`) |
| `src/ui/` | React UI: structured editor, canvas map, game loop hook |

The sim core is deterministic (same program + map + seed = same result), so the same code
can later verify leaderboard submissions on a server.
