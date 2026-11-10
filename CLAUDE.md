# Automation RPG

Incremental RPG where players automate an adventurer by writing JavaScript in a console and a library file.
Design doc: https://claude.ai/artifact/Ei2RUWui593PERf54BZLoC

## Rules

- **No hint text.** Never add tutorial copy, explanatory captions, tooltips (`title=`), or
  "how to play" lines to the UI. Let the game speak for itself: teach through goals, layout,
  feedback and progressive reveal. Labels, numbers and goal targets are fine; sentences that
  explain them are not.
- Keep `src/game/world.ts` pure TypeScript with no UI dependencies and fully deterministic
  (seeded randomness only), so a run can be replayed (offline progress, verification).
- Progress must stay reachable: `npm test` plays reference libraries against the world
  (lantern pacing, the frontier outearning staying home). Re-run it after changing the
  world, the economy or the sandbox.

## Commands

- `npm run dev`, `npm test`, `npm run build`
- Pushing to `main` runs tests and deploys to GitHub Pages.
