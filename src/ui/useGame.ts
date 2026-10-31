import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { makeStmt, slotCount, type Program } from '../sim/lang';
import { generateMap, MAP_TYPES, type MapType } from '../sim/map';
import { Run } from '../sim/run';
import { evaluateTrial, MAP_TIER, TRIAL_RUNS, type TrialOutcome } from '../sim/progress';

export interface Save {
  v: 2;
  program: Program;
  mapType: MapType;
  runSeed: number;
  tier: number;
  stars: number[];
  runsDone: number;
  bests: Partial<Record<MapType, { explored: number; lines: number }>>;
}

const KEY = 'automation-rpg/save';
const fresh = (): Save => ({
  v: 2, program: [makeStmt('act', 'forward')], mapType: 'field', runSeed: 1000, tier: 0, stars: [], runsDone: 0, bests: {},
});

function load(): Save {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Save;
      if (s.v === 2 && MAP_TYPES.includes(s.mapType)) return s;
    }
  } catch { /* storage unavailable: start fresh */ }
  return fresh();
}

export const SPEEDS = [8, 32, 128, 512]; // ticks per second

export function useGame() {
  const [save, setSave] = useState<Save>(load);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(SPEEDS[0]);
  /** % explored for each finished run of the current program on the current map type. */
  const [trial, setTrial] = useState<number[]>([]);
  const [news, setNews] = useState<TrialOutcome | null>(null);
  const [, redraw] = useReducer((x: number) => x + 1, 0);

  const saveRef = useRef(save);
  saveRef.current = save;
  const trialRef = useRef(trial);
  trialRef.current = trial;
  const runRef = useRef<Run>(null as unknown as Run);
  if (!runRef.current) runRef.current = new Run(save.program, generateMap(save.mapType, save.runSeed));

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(save)); } catch { /* ignore */ }
  }, [save]);

  const restart = useCallback((s: Save) => {
    runRef.current = new Run(s.program, generateMap(s.mapType, s.runSeed));
    redraw();
  }, []);

  const commit = (s: Save) => { saveRef.current = s; setSave(s); };

  // A run finished: score it toward the goal and roll a new map. This is the idle loop.
  const nextRun = useCallback(() => {
    const w = runRef.current.world;
    const explored = (100 * w.revealedFloor) / w.map.floorCount;
    const scores = [...trialRef.current, explored];
    let s: Save = { ...saveRef.current, runSeed: saveRef.current.runSeed + 1, runsDone: saveRef.current.runsDone + 1 };

    if (scores.length >= TRIAL_RUNS) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const lines = slotCount(s.program);
      const out = evaluateTrial(s.tier, s.stars, s.mapType, avg, lines);
      const prev = s.bests[s.mapType];
      const best = !prev || avg > prev.explored ? { explored: Math.round(avg * 10) / 10, lines } : prev;
      s = { ...s, tier: out.tier, stars: out.stars, bests: { ...s.bests, [s.mapType]: best } };
      if (out.unlocked !== null || out.newStars.length) setNews(out);
      trialRef.current = [];
      setTrial([]);
    } else {
      trialRef.current = scores;
      setTrial(scores);
    }
    commit(s);
    restart(s);
  }, [restart]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now(), acc = 0;
    const frame = (now: number) => {
      acc += (Math.min(now - last, 250) / 1000) * speed;
      last = now;
      let steps = 0;
      while (acc >= 1 && steps < 2000) {
        acc -= 1;
        steps++;
        if (!runRef.current.step()) { nextRun(); break; }
      }
      redraw();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, nextRun]);

  const clearTrial = () => { trialRef.current = []; setTrial([]); };

  const setProgram = useCallback((program: Program) => {
    const s = { ...saveRef.current, program };
    commit(s);
    clearTrial(); // a new program starts a new trial
    restart(s); // replay the same map so the effect of the edit is visible
  }, [restart]);

  const setMapType = useCallback((mapType: MapType) => {
    if (MAP_TIER[mapType] > saveRef.current.tier) return;
    const s = { ...saveRef.current, mapType, runSeed: saveRef.current.runSeed + 1 };
    commit(s);
    clearTrial();
    restart(s);
  }, [restart]);

  const step = useCallback(() => {
    if (!runRef.current.step()) nextRun();
    redraw();
  }, [nextRun]);

  const reset = useCallback(() => { clearTrial(); restart(saveRef.current); }, [restart]);

  const wipe = useCallback(() => {
    const s = fresh();
    commit(s);
    clearTrial();
    setNews(null);
    setPlaying(false);
    restart(s);
  }, [restart]);

  return {
    save, lines: slotCount(save.program), trial, news, dismissNews: () => setNews(null),
    run: runRef.current, playing, setPlaying, speed, setSpeed,
    setProgram, setMapType, step, reset, wipe,
  };
}
