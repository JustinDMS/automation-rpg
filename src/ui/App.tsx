import { MAP_TYPES } from '../sim/map';
import { TICK_BUDGET } from '../sim/run';
import { MAP_TIER, MASTERY, nextTier, TIERS, TRIAL_RUNS } from '../sim/progress';
import { Editor } from './Editor';
import { MapView } from './MapView';
import { SPEEDS, useGame } from './useGame';

export function App() {
  const g = useGame();
  const { save } = g;
  const w = g.run.world;
  const explored = (100 * w.revealedFloor) / w.map.floorCount;
  const veteran = save.runsDone > 0; // reveal the extra controls after the first finished run

  return (
    <div className="app">
      <header className="top">
        <h1>Automation RPG <small>grey box · v0.3</small></h1>
      </header>

      <main>
        <section className="stage">
          {save.tier >= 1 && (
            <div className="maps">
              {MAP_TYPES.filter((t) => MAP_TIER[t] <= save.tier).map((t) => (
                <button key={t} className={save.mapType === t ? 'on' : ''} onClick={() => g.setMapType(t)}>{t}</button>
              ))}
            </div>
          )}
          <MapView world={w} />
          <div className="stats">
            <span>tick {w.tick}/{TICK_BUDGET}</span>
            <span>explored {explored.toFixed(1)}%</span>
            {w.bumps > 0 && <span>bumps {w.bumps}</span>}
            {w.stalls > 0 && <span className="warn">stalls {w.stalls}</span>}
          </div>
          <div className="controls">
            <button className="primary" onClick={() => g.setPlaying(!g.playing)}>{g.playing ? 'Pause' : 'Run'}</button>
            {veteran && (
              <>
                <button onClick={g.step} disabled={g.playing}>Step</button>
                <button onClick={g.reset}>Reset</button>
                <div className="speeds">
                  {SPEEDS.map((s, i) => (
                    <button key={s} className={g.speed === s ? 'on' : ''} onClick={() => g.setSpeed(s)}>{4 ** i}×</button>
                  ))}
                </div>
              </>
            )}
          </div>
          <GoalCard g={g} />
        </section>

        <Editor program={save.program} tier={save.tier} currentId={g.run.currentId} onChange={g.setProgram} />
      </main>

      <footer>
        <button className="link" onClick={() => { if (confirm('Erase all progress?')) g.wipe(); }}>Reset save</button>
      </footer>
    </div>
  );
}

function GoalCard({ g }: { g: ReturnType<typeof useGame> }) {
  const { save, trial } = g;
  const next = nextTier(save.tier);
  const goal = next?.goal;
  const avg = trial.length ? trial.reduce((a, b) => a + b, 0) / trial.length : null;
  const earned = TIERS.filter((t) => t.goal && t.tier <= save.tier);

  return (
    <div className="goal">
      {g.news && (
        <div className="news">
          {g.news.unlocked !== null && <p><strong>Unlocked {TIERS[g.news.unlocked].name}!</strong> {TIERS[g.news.unlocked].grants}</p>}
          {g.news.newStars.map((t) => <p key={t}>★ {TIERS[t].goal!.type} ≤ {TIERS[t].goal!.starLines} lines</p>)}
          <button onClick={g.dismissNews}>OK</button>
        </div>
      )}

      {goal ? (
        <>
          <h2>{next!.name} 🔒</h2>
          <p><b>{goal.type}</b> · avg ≥ {goal.explored}% · ☆ ≤ {goal.starLines} lines</p>
          {save.mapType !== goal.type ? (
            <button onClick={() => g.setMapType(goal.type)}>{goal.type} →</button>
          ) : (
            <div className="pips">
              {Array.from({ length: TRIAL_RUNS }, (_, i) => (
                <span key={i} className={`pip${trial[i] === undefined ? '' : trial[i] >= goal.explored ? ' good' : ' low'}`}>
                  {trial[i] === undefined ? '·' : `${Math.round(trial[i])}%`}
                </span>
              ))}
              {avg !== null && <span className="muted">avg {avg.toFixed(1)}%</span>}
            </div>
          )}
        </>
      ) : (
        <>
          <h2>Mastery</h2>
          <ul className="list">
            {MASTERY.map((m) => {
              const best = save.bests[m.type];
              const done = !!best && best.explored >= m.explored;
              return <li key={m.label} className={done ? 'done' : ''}>{done ? '★' : '☆'} {m.label} <span className="muted">best {best ? `${best.explored}% in ${best.lines} lines` : '—'}</span></li>;
            })}
          </ul>
        </>
      )}

      {earned.length > 0 && (
        <details className="stars">
          <summary>★ {save.stars.length}/{earned.length}</summary>
          <ul className="list">
            {earned.map((t) => (
              <li key={t.tier} className={save.stars.includes(t.tier) ? 'done' : ''}>
                {save.stars.includes(t.tier) ? '★' : '☆'} {t.goal!.type} ≥ {t.goal!.explored}% in ≤ {t.goal!.starLines} lines
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
