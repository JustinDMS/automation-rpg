# Automation RPG

Incremental RPG where players automate an adventurer with a tap-based code editor.
Design doc: https://claude.ai/artifact/Ei2RUWui593PERf54BZLoC

## Rules

- **No hint text.** Never add tutorial copy, explanatory captions, tooltips (`title=`), or
  "how to play" lines to the UI. Let the game speak for itself: teach through goals, layout,
  feedback and progressive reveal. Labels, numbers and goal targets are fine; sentences that
  explain them are not.
- Keep `src/sim/` pure TypeScript with no UI dependencies and fully deterministic
  (seeded randomness only), so a server can re-run it to verify leaderboard scores.
- Every unlock goal must stay reachable: `npm test` checks this against reference programs.
  Re-run it after changing goals, maps or the interpreter.

## Commands

- `npm run dev`, `npm test`, `npm run build`
- Pushing to `main` runs tests and deploys to GitHub Pages.
