import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Session, type Cls } from './sandbox';
import { CAPACITY, createWorld, MAX_SUPPLIES, upgradeState, type State } from './world';

const WORLD_KEY = 'repl/world', LIB_KEY = 'repl/library.js', OLD_LIB_KEY = 'repl/library';
const SPEED = 10; // ticks per real second

interface Line { n: number; t: number; text: string; cls: Cls }

const read = <T,>(key: string, fallback: T): T => {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
};
const write = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } };

/** The library file. Older saves held captured console definitions; they become the file's first contents. */
function loadLibraryText(): string {
  const text = read<string | null>(LIB_KEY, null);
  if (text !== null) return text;
  const old = read<({ code: string } | string)[]>(OLD_LIB_KEY, []);
  return old.map((d) => (typeof d === 'string' ? d : d.code).replace(/^var\b/, 'const')).join('\n\n');
}

export function Repl() {
  const world = useRef<State>(null as unknown as State);
  if (!world.current) { const saved = read<State | null>(WORLD_KEY, null); world.current = saved ? upgradeState(saved) : createWorld(Date.now() % 100000); }
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<'console' | 'library'>('console');
  const [libText, setLibText] = useState(loadLibraryText);
  const [libSaved, setLibSaved] = useState(libText);
  const [, redraw] = useReducer((x: number) => x + 1, 0);
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
      speed: () => SPEED,
      log: push,
      changed: () => { redraw(); write(WORLD_KEY, world.current); },
    });
    return session.current;
  }, [push]);

  // Boot: load the library, then look around.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const s = getSession();
    void s.loadLibrary(libText);
    void s.eval('look()', true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getSession]);

  useEffect(() => { if (tab === 'console') outEnd.current?.scrollIntoView({ block: 'end' }); }, [lines, tab]);

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
    inputEl.current?.focus();
  };

  const saveLibrary = async () => {
    write(LIB_KEY, libText);
    setLibSaved(libText);
    const ok = await getSession().loadLibrary(libText);
    if (ok) push('library loaded', 'value');
  };

  const newWorld = () => {
    if (running || !confirm('Start a new world? Gold and discoveries reset; your library stays.')) return;
    world.current = createWorld(Date.now() % 100000);
    write(WORLD_KEY, world.current);
    setLines([]);
    void getSession().eval('look()', true);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); return; }
    const h = history.current;
    if (e.key === 'ArrowUp' && !input.includes('\n') && h.length) { e.preventDefault(); histPos.current = Math.max(0, histPos.current - 1); setInput(h[histPos.current]); }
    else if (e.key === 'ArrowDown' && !input.includes('\n')) { e.preventDefault(); histPos.current = Math.min(h.length, histPos.current + 1); setInput(h[histPos.current] ?? ''); }
  };

  const onLibKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void saveLibrary(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget, a = el.selectionStart, b = el.selectionEnd;
      setLibText(libText.slice(0, a) + '  ' + libText.slice(b));
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + 2; });
    }
  };

  const s = world.current;
  const here = s.places[s.here];
  const weight = s.pack.reduce((a, i) => a + i.weight, 0);
  const value = s.pack.reduce((a, i) => a + i.value, 0);
  const known = s.places.filter((p) => p.discovered).length;
  const dirty = libText !== libSaved;

  return (
    <div className="repl">
      <div className="status">
        <span className="gold">◆ {s.gold}</span>
        <span>{here.name}</span>
        <span>supplies {s.supplies}/{MAX_SUPPLIES}</span>
        <span className={weight > CAPACITY ? 'warn' : ''}>pack {weight}/{CAPACITY} · {value}g</span>
        <span>known {known}</span>
        {s.tools.length > 0 && <span>{s.tools.join(' · ')}</span>}
        <span>t {s.time}</span>
        {s.pending && <span className="warn">{s.pending.e.kind}!</span>}
        <span className="spacer" />
        <span className="tabs">
          <button className={tab === 'console' ? 'on' : ''} onClick={() => setTab('console')}>Console</button>
          <button className={tab === 'library' ? 'on' : ''} onClick={() => setTab('library')}>Library{dirty ? ' •' : ''}</button>
        </span>
        <button className="small" onClick={newWorld} disabled={running}>New world</button>
      </div>

      <div className={`panes show-${tab}`}>
        <div className="console">
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
              enterKeyHint="go"
            />
            {running ? <button className="primary" onClick={() => session.current?.stop()}>Stop</button> : <button className="primary" onClick={submit}>Go</button>}
          </div>
        </div>

        <div className="library">
          <textarea
            className="file"
            value={libText}
            onChange={(e) => setLibText(e.target.value)}
            onKeyDown={onLibKey}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
          />
          <div className="bar">
            <span className="filename">library.js{dirty ? ' •' : ''}</span>
            <span className="spacer" />
            <button className="primary" onClick={saveLibrary} disabled={!dirty && libSaved === getSession().library}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
