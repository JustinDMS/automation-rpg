# Automation RPG

An incremental RPG you play by writing JavaScript. You explore an endless world from a
console (`look()`, `go('Old Wood')`, `gather()`, `settle()`), and the world answers in prose.
Beside the console is `library.js`, one file you edit directly: the functions you write there
are how you automate the adventurer, as in The Farmer Was Replaced.

Play: https://justindms.github.io/automation-rpg/ · Design doc: https://claude.ai/artifact/Ei2RUWui593PERf54BZLoC

## Run it

```bash
npm install
npm run dev      # open the printed URL; --host exposes it to your phone on the same network
npm test         # world rules, the sandbox, and calibration against reference libraries
npm run build
```

## How it works

- **Senses** (`here()`, `known()`, `pack()`, …) are free and return data. **Actions** (`go()`,
  `gather()`, `scout()`, `settle()`, …) take game time, narrate, and return nothing.
- Meadows and forests regrow; ruins, caves and mines give up their haul once. The world grows
  past its starting edge as you push out, and outposts you found work as camps.
- Player code runs in QuickJS (WebAssembly). Calls that take game time block the script, so
  code stays plain and synchronous.
- The world is deterministic given its seed and your actions, so a run can be replayed.

## Layout

| Path | What |
| --- | --- |
| `src/game/world.ts` | The world and its API: pure TypeScript, no UI, seeded randomness only |
| `src/game/sandbox.ts` | The QuickJS session: runs console input and `library.js` against the world |
| `src/game/Repl.tsx`, `CodeEditor.tsx`, `KnownMap.tsx` | The console, the CodeMirror editors, the map |
| `src/game/game.test.ts` | Rules, sandbox, and calibration tests |

`probe.html` redirects to the game for old links. Prototype 1 (a grid-exploration puzzle with
a block editor) lives in git history before the switch to the console.
