import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { slotCount, type Program } from '../sim/lang';
import { generateMap, MAP_TYPES, type MapType } from '../sim/map';
import { benchmark, Run, type BenchResult } from '../sim/run';
import { better, maxSlots, MAP_TIER, slotUpgradeCost, tierFromBests } from '../sim/progress';

export interface Save {
  v: 1;
  program: Program;
  materials: number;
  slotUpgrades: number;
  bests: Partial<Record<MapType, BenchResult>>;
  mapType: MapType;
  runSeed: number;
}

const KEY = 'automation-rpg/save';
const fresh = (): Save => ({ v: 1, program: [], materials: 0, slotUpgrades: 0, bests: {}, mapType: 'field', runSeed: 1 });

function load(): Save {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Save;
      if (s.v === 1 && MAP_TYPES.includes(s.mapType)) return s;
    }
  } catch { /* storage unavailable: start fresh */ }
  return fresh();
}

export const SPEEDS = [4, 16, 64, 256]; // ticks per second

export interface RunSummary { explored: number; loot: number; ticks: number }

export function useGame() {
  const [save, setSave] = useState<Save>(load);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(SPEEDS[0]);
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);
  const [lastBench, setLastBench] = useState<{ result: BenchResult; unlocked: number | null } | null>(null);
  const [, redraw] = useReducer((x: number) => x + 1, 0);

  const saveRef = useRef(save);
  saveRef.current = save;
  const runRef = useRef<Run>(null as unknown as Run);
  if (!runRef.current) runRef.current = new Run(save.program, generateMap(save.mapType, save.runSeed));

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(save)); } catch { /* ignore */ }
  }, [save]);

  const tier = tierFromBests(save.bests);
  const slots = maxSlots(save.slotUpgrades);

  const restart = useCallback((s: Save) => {
    runRef.current = new Run(s.program, generateMap(s.mapType, s.runSeed));
    redraw();
  }, []);

  // Bank a finished run and roll a new map: this is the idle loop.
  const nextRun = useCallback(() => {
    const w = runRef.current.world;
    setLastRun({ explored: (100 * w.revealedFloor) / w.map.floorCount, loot: w.lootGot, ticks: w.tick });
    const s = { ...saveRef.current, materials: saveRef.current.materials + w.lootGot, runSeed: saveRef.current.runSeed + 1 };
    saveRef.current = s;
    setSave(s);
    restart(s);
  }, [restart]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now(), acc = 0;
    const frame = (now: number) => {
      acc += ((now - last) / 1000) * speed;
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

  const setProgram = useCallback((program: Program) => {
    const s = { ...saveRef.current, program };
    saveRef.current = s;
    setSave(s);
    restart(s); // replay the same map so the effect of the edit is visible
  }, [restart]);

  const setMapType = useCallback((mapType: MapType) => {
    if (MAP_TIER[mapType] > tierFromBests(saveRef.current.bests)) return;
    const s = { ...saveRef.current, mapType, runSeed: saveRef.current.runSeed + 1 };
    saveRef.current = s;
    setSave(s);
    restart(s);
  }, [restart]);

  const step = useCallback(() => {
    if (!runRef.current.step()) nextRun();
    redraw();
  }, [nextRun]);

  const reset = useCallback(() => restart(saveRef.current), [restart]);

  const runBenchmark = useCallback(() => {
    const s = saveRef.current;
    const result = benchmark(s.program, s.mapType);
    const before = tierFromBests(s.bests);
    const bests = { ...s.bests, [s.mapType]: better(s.bests[s.mapType], result) };
    const after = tierFromBests(bests);
    setSave({ ...s, bests });
    setLastBench({ result, unlocked: after > before ? after : null });
  }, []);

  const buySlots = useCallback(() => {
    const s = saveRef.current;
    const cost = slotUpgradeCost(s.slotUpgrades);
    if (s.materials < cost) return;
    setSave({ ...s, materials: s.materials - cost, slotUpgrades: s.slotUpgrades + 1 });
  }, []);

  const wipe = useCallback(() => {
    const s = fresh();
    setSave(s);
    setLastBench(null);
    setLastRun(null);
    restart(s);
  }, [restart]);

  return {
    save, tier, slots, slotsUsed: slotCount(save.program),
    run: runRef.current, playing, setPlaying, speed, setSpeed, lastRun, lastBench,
    setProgram, setMapType, step, reset, runBenchmark, buySlots, wipe,
  };
}
