import { MAP_TYPES } from '../sim/map';
import { TICK_BUDGET } from '../sim/run';
import { MAP_TIER, MASTERY, slotUpgradeCost, TIERS } from '../sim/progress';
import { Editor } from './Editor';
import { MapView } from './MapView';
import { SPEEDS, useGame } from './useGame';

export function App() {
  const g = useGame();
  const w = g.run.world;
  const explored = (100 * w.revealedFloor) / w.map.floorCount;
  const cost = slotUpgradeCost(g.save.slotUpgrades);

  return (
    <div className="app">
      <header className="top">
        <h1>Automation RPG <small>grey box · v0.1</small></h1>
        <span className="materials">◆ {g.save.materials} materials</span>
      </header>

      <main>
        <section className="stage">
          <div className="maps">
            {MAP_TYPES.map((t) => (
              <button key={t} className={g.save.mapType === t ? 'on' : ''} disabled={MAP_TIER[t] > g.tier} onClick={() => g.setMapType(t)}>
                {t}{MAP_TIER[t] > g.tier ? ' 🔒' : ''}
              </button>
            ))}
          </div>
          <MapView world={w} />
          <div className="stats">
            <span>tick {w.tick}/{TICK_BUDGET}</span>
            <span>explored {explored.toFixed(1)}%</span>
            <span>loot {w.lootGot}</span>
            <span title="Walked into a wall">bumps {w.bumps}</span>
            {w.stalls > 0 && <span className="warn" title="Ticks with no action">stalls {w.stalls}</span>}
          </div>
          <div className="controls">
            <button className="primary" onClick={() => g.setPlaying(!g.playing)}>{g.playing ? 'Pause' : 'Run'}</button>
            <button onClick={g.step} disabled={g.playing}>Step</button>
            <button onClick={g.reset}>Reset</button>
            <div className="speeds">
              {SPEEDS.map((s, i) => (
                <button key={s} className={g.speed === s ? 'on' : ''} onClick={() => g.setSpeed(s)}>{4 ** i}×</button>
              ))}
            </div>
          </div>
          {g.lastRun && (
            <p className="muted">Last run: {g.lastRun.explored.toFixed(1)}% explored, +{g.lastRun.loot} materials. Runs repeat on new maps while playing.</p>
          )}
        </section>

        <Editor program={g.save.program} tier={g.tier} slots={g.slots} currentId={g.run.currentId} onChange={g.setProgram} />

        <section className="progress">
          <h2>Benchmark</h2>
          <p className="muted">Scores your program on 5 hidden {g.save.mapType} maps. Your best score unlocks new language features.</p>
          <button className="primary" onClick={g.runBenchmark}>Benchmark on {g.save.mapType}</button>
          {g.lastBench && (
            <p className="bench">
              {g.lastBench.result.explored}% explored · {g.lastBench.result.ticks} ticks · {g.lastBench.result.fullRuns}/5 fully explored · {g.slotsUsed} slots
              {g.lastBench.unlocked !== null && <strong> — Unlocked {TIERS[g.lastBench.unlocked].name}!</strong>}
            </p>
          )}

          <h2>Language</h2>
          <ul className="tiers">
            {TIERS.map((t) => {
              const best = t.req ? g.save.bests[t.req.type] : undefined;
              const done = t.tier <= g.tier;
              return (
                <li key={t.tier} className={done ? 'done' : ''}>
                  <b>{done ? '✓' : '○'} {t.name}</b> <span className="muted">{t.grants}</span>
                  {t.req && !done && (
                    <div className="req">Target: {t.req.type} ≥ {t.req.explored}% (best {best ? `${best.explored}%` : '—'})</div>
                  )}
                </li>
              );
            })}
          </ul>

          <h2>Hardware</h2>
          <p>Instruction slots: {g.slots}</p>
          <button onClick={g.buySlots} disabled={g.save.materials < cost}>+2 slots for ◆ {cost}</button>

          {g.tier === TIERS.length - 1 && (
            <>
              <h2>Mastery</h2>
              <ul className="tiers">
                {MASTERY.map((m) => {
                  const best = g.save.bests[m.type];
                  const done = !!best && best.explored >= m.explored;
                  return <li key={m.label} className={done ? 'done' : ''}><b>{done ? '★' : '☆'} {m.label}</b> <span className="muted">best {best ? `${best.explored}% in ${best.ticks} ticks` : '—'}</span></li>;
                })}
              </ul>
            </>
          )}

          <button className="link" onClick={() => { if (confirm('Erase all progress?')) g.wipe(); }}>Reset save</button>
        </section>
      </main>
    </div>
  );
}
