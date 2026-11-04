import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { isDefinition, Session, type Cls } from './sandbox';
import { CAPACITY, createWorld, MAX_SUPPLIES, type State } from './world';

const WORLD_KEY = 'repl/world', LIB_KEY = 'repl/library';
const SPEEDS = [2, 10, 50, 250];

interface Line { n: number; t: number; text: string; cls: Cls }

const read = <T,>(key: string, fallback: T): T => {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
};
const write = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } };

export function Repl() {
  const world = useRef<State>(null as unknown as State);
  if (!world.current) world.current = read<State | null>(WORLD_KEY, null) ?? createWorld(Date.now() % 100000);
  /** Definitions the player typed, replayed into each new session so they persist. */
  const library = useRef<string[]>(read<string[]>(LIB_KEY, []));
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState('');
  const [speed, setSpeed] = useState(SPEEDS[1]);
  const [running, setRunning] = useState(false);
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const seq = useRef(0);
  const history = useRef<string[]>([]);
  const histPos = useRef(-1);
  const inputEl = useRef<HTMLTextAreaElement>(null);
  const outEnd = useRef<HTMLDivElement>(null);
  const booted = useRef(false);

  const buffer = useRef<Line[]>([]);
  const flushQueued = useRef(false);
  const push = useCallback((text: string, cls: Cls) => {
    buffer.current.push({ n: seq.current++, t: world.current.time, text, cls });
    if (flushQueued.current) return;
    flushQueued.current = true;
    requestAnimationFrame(() => {
      flushQueued.current = false;
      const fresh = buffer.current.splice(0);
      setLines((ls) => [...ls, ...fresh].slice(-600));
    });
  }, []);

  const session = useRef<Session | null>(null);
  const getSession = useCallback(() => {
    session.current ??= new Session({
      state: () => world.current,
      speed: () => speedRef.current,
      log: push,
      changed: () => { redraw(); write(WORLD_KEY, world.current); },
    });
    return session.current;
  }, [push]);

  // Boot: replay the library quietly, then look around.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      const s = getSession();
      for (const def of library.current) await s.eval(def, true);
      await s.eval('look()', true);
    })();
  }, [getSession]);

  useEffect(() => { outEnd.current?.scrollIntoView({ block: 'end' }); }, [lines]);

  const submit = async () => {
    const code = input.trim();
    if (!code || running) return;
    setInput('');
    history.current.push(code);
    histPos.current = history.current.length;
    push(code, 'input');
    setRunning(true);
    await getSession().eval(code);
    setRunning(false);
    if (isDefinition(code)) { library.current.push(code); write(LIB_KEY, library.current); }
    inputEl.current?.focus();
  };

  const newWorld = () => {
    if (running || !confirm('Start a new world? Gold and discoveries reset; your definitions stay.')) return;
    world.current = createWorld(Date.now() % 100000);
    write(WORLD_KEY, world.current);
    setLines([]);
    getSession().eval('look()', true);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); return; }
    const h = history.current;
    if (e.key === 'ArrowUp' && !input.includes('\n') && h.length) { e.preventDefault(); histPos.current = Math.max(0, histPos.current - 1); setInput(h[histPos.current]); }
    else if (e.key === 'ArrowDown' && !input.includes('\n')) { e.preventDefault(); histPos.current = Math.min(h.length, histPos.current + 1); setInput(h[histPos.current] ?? ''); }
  };

  const s = world.current;
  const here = s.places[s.here];
  const weight = s.pack.reduce((a, i) => a + i.weight, 0);
  const value = s.pack.reduce((a, i) => a + i.value, 0);
  const known = s.places.filter((p) => p.discovered).length;

  return (
    <div className="repl">
      <div className="status">
        <span className="gold">◆ {s.gold}</span>
        <span>{here.name}</span>
        <span>supplies {s.supplies}/{MAX_SUPPLIES}</span>
        <span className={weight > CAPACITY ? 'warn' : ''}>pack {weight}/{CAPACITY} · {value}g</span>
        <span>known {known}</span>
        <span>t {s.time}</span>
        {s.pending && <span className="warn">{s.pending.e.kind}!</span>}
        <span className="spacer" />
        <span className="speeds">
          {SPEEDS.map((v, i) => <button key={v} className={speed === v ? 'on' : ''} onClick={() => setSpeed(v)}>{['1×', '5×', '25×', '125×'][i]}</button>)}
        </span>
        <button className="small" onClick={newWorld} disabled={running}>New world</button>
      </div>

      <section className="out">
        {lines.map((l) => (
          <div key={l.n} className={`line ${l.cls}`} onClick={l.cls === 'input' ? () => { setInput(l.text); inputEl.current?.focus(); } : undefined}>
            {l.cls === 'input' ? <span className="prompt">›</span> : null}{l.text}
          </div>
        ))}
        <div ref={outEnd} />
      </section>

      <div className="in">
        <span className="prompt">›</span>
        <textarea
          ref={inputEl}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          autoFocus
          enterKeyHint="go"
        />
        {running ? <button className="primary" onClick={() => session.current?.stop()}>Stop</button> : <button className="primary" onClick={submit}>Go</button>}
      </div>
    </div>
  );
}
