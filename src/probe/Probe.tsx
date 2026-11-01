import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Sandbox } from './sandbox';
import { CAPACITY, createWorld, MAX_SUPPLIES, type State } from './world';

const CODE_KEY = 'probe/code', WORLD_KEY = 'probe/world';
const SPEEDS = [2, 10, 50, 250];

const DEFAULT_CODE = `while (true) {
  go(known()[1]);
  gather();
  go('Camp');
}
`;

const API = [
  'here()', 'known()', 'go(place)', 'scout()', 'gather()',
  'pack()', 'drop(name)', 'choose(option)', 'supplies()', 'gold()', 'time()', 'print(...)',
];

interface Line { n: number; t: number; text: string; cls: string }

function loadWorld(): State {
  try {
    const raw = localStorage.getItem(WORLD_KEY);
    if (raw) return JSON.parse(raw) as State;
  } catch { /* fresh */ }
  return createWorld(Date.now() % 100000);
}

export function Probe() {
  const [code, setCode] = useState(() => { try { return localStorage.getItem(CODE_KEY) ?? DEFAULT_CODE; } catch { return DEFAULT_CODE; } });
  const [speed, setSpeed] = useState(SPEEDS[1]);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const world = useRef<State>(null as unknown as State);
  if (!world.current) world.current = loadWorld();
  const sandbox = useRef<Sandbox | null>(null);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const seq = useRef(0);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => { try { localStorage.setItem(CODE_KEY, code); } catch { /* ignore */ } }, [code]);
  useEffect(() => { logEnd.current?.scrollIntoView({ block: 'end' }); }, [lines]);

  const save = useCallback(() => { try { localStorage.setItem(WORLD_KEY, JSON.stringify(world.current)); } catch { /* ignore */ } }, []);

  const push = useCallback((text: string, cls = 'event') => {
    setLines((ls) => [...ls.slice(-400), { n: seq.current++, t: world.current.time, text, cls }]);
  }, []);

  const start = async () => {
    if (running) return;
    setRunning(true);
    const sb = new Sandbox({ state: world.current, speed: () => speedRef.current, log: push, changed: () => { redraw(); save(); } });
    sandbox.current = sb;
    push('▶ run', 'print');
    await sb.run(code);
    sandbox.current = null;
    setRunning(false);
    redraw();
    save();
  };
  const stop = () => sandbox.current?.stop();
  const newWorld = () => {
    if (running || !confirm('Start a new world? Gold and discoveries reset; your code stays.')) return;
    world.current = createWorld(Date.now() % 100000);
    setLines([]);
    save();
    redraw();
  };

  const s = world.current;
  const here = s.places[s.here];
  const weight = s.pack.reduce((a, i) => a + i.weight, 0);
  const value = s.pack.reduce((a, i) => a + i.value, 0);
  const known = s.places.filter((p) => p.discovered).length;

  return (
    <div className="probe">
      <div className="status">
        <span className="gold">◆ {s.gold}</span>
        <span>{here.name}</span>
        <span>supplies {s.supplies}/{MAX_SUPPLIES}</span>
        <span className={weight > CAPACITY ? 'warn' : ''}>pack {weight}/{CAPACITY} · {value}g</span>
        <span>known {known}/{s.places.length}</span>
        <span>t {s.time}</span>
        {s.stranded > 0 && <span className="warn">stranded {s.stranded}</span>}
        {s.pending && <span className="warn">{s.pending.e.kind}!</span>}
      </div>

      <div className="panes">
        <section className="log">
          {lines.map((l) => <div key={l.n} className={`line ${l.cls}`}><span className="t">{l.t}</span>{l.text}</div>)}
          <div ref={logEnd} />
        </section>

        <section className="code">
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                e.preventDefault();
                const el = e.currentTarget, a = el.selectionStart, b = el.selectionEnd;
                setCode(code.slice(0, a) + '  ' + code.slice(b));
                requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + 2; });
              }
            }}
          />
          <div className="bar">
            {running ? <button className="primary" onClick={stop}>Stop</button> : <button className="primary" onClick={start}>Run</button>}
            <div className="speeds">
              {SPEEDS.map((v, i) => <button key={v} className={speed === v ? 'on' : ''} onClick={() => setSpeed(v)}>{['1×', '5×', '25×', '125×'][i]}</button>)}
            </div>
            <button onClick={newWorld} disabled={running}>New world</button>
          </div>
          <div className="api">{API.map((a) => <code key={a}>{a}</code>)}</div>
        </section>
      </div>
    </div>
  );
}
