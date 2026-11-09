import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { CodeEditor, type EditorHandle, type Vocab } from './CodeEditor';
import { KnownMap } from './KnownMap';
import { Session, type Cls } from './sandbox';
import { createWorld, TOOLS, upgradeState, type State } from './world';

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

const WIDE = '(min-width: 900px)';
function useWide() {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => {
    const m = matchMedia(WIDE), on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

export function Repl() {
  const world = useRef<State>(null as unknown as State);
  if (!world.current) { const saved = read<State | null>(WORLD_KEY, null); world.current = saved ? upgradeState(saved) : createWorld(Date.now() % 100000); }
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInputState] = useState('');
  // The editor reports keystrokes and Enter in the same tick; submit reads the ref, not the render.
  const inputNow = useRef('');
  const setInput = (v: string) => { inputNow.current = v; setInputState(v); };
  const [running, setRunning] = useState(false);
  const wide = useWide();
  /** On a phone one pane shows at a time. */
  const [tab, setTab] = useState<'console' | 'library' | 'map'>('console');
  /** On desktop the console is always shown, beside the library, the map, or both stacked. */
  const [showLib, setShowLib] = useState(true);
  const [showMap, setShowMap] = useState(false);
  const [libText, setLibText] = useState(loadLibraryText);
  const [libSaved, setLibSaved] = useState(libText);
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const seq = useRef(0);
  const history = useRef<string[]>([]);
  const histPos = useRef(-1);
  const inputEl = useRef<EditorHandle>(null);
  const outEl = useRef<HTMLElement>(null);
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

  useEffect(() => { const o = outEl.current; if (o) o.scrollTop = o.scrollHeight; }, [lines, tab, wide]);

  const submit = async () => {
    const code = inputNow.current.trim();
    if (!code || running) return;
    setInput('');
    inputEl.current?.setText('');
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

  const onHistory = (dir: -1 | 1): string | null => {
    const h = history.current;
    if (!h.length) return null;
    histPos.current = Math.max(0, Math.min(h.length, histPos.current + dir));
    return h[histPos.current] ?? '';
  };

  const vocab: Vocab = {
    strings: () => {
      const w = world.current;
      const all = [
        ...w.places.filter((p) => p.discovered).map((p) => p.name), 'camp', 'supplies',
        ...TOOLS.map((t) => t.name), ...w.pack.map((i) => i.name), ...(w.pending?.e.options ?? []),
      ];
      const seen = new Set<string>();
      return all.filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
    },
    library: () => libText,
  };

  const toggle = (which: 'library' | 'map') => {
    if (!wide) { setTab(which); return; }
    // At least one side pane stays open.
    if (which === 'library') { if (!showLib || showMap) setShowLib(!showLib); }
    else if (!showMap || showLib) setShowMap(!showMap);
  };

  const s = world.current;
  const here = s.places[s.here];
  const weight = s.pack.reduce((a, i) => a + i.weight, 0);
  const value = s.pack.reduce((a, i) => a + i.value, 0);
  const known = s.places.filter((p) => p.discovered).length;
  const dirty = libText !== libSaved;
  const libOn = wide ? showLib : tab === 'library', mapOn = wide ? showMap : tab === 'map';
  const consoleOn = wide || tab === 'console';

  return (
    <div className="repl">
      <div className="status">
        <span className="gold">◆ {s.gold}</span>
        <span>{here.name}</span>
        <span>supplies {s.supplies}/{s.maxSupplies}</span>
        <span className={weight > s.capacity ? 'warn' : ''}>pack {weight}/{s.capacity} · {value}g</span>
        <span>known {known}</span>
        {s.tools.length > 0 && <span>{s.tools.join(' · ')}</span>}
        <span>t {s.time}</span>
        {s.pending && <span className="warn">{s.pending.e.kind}!</span>}
        <span className="spacer" />
        <span className="tabs">
          {!wide && <button className={tab === 'console' ? 'on' : ''} onClick={() => setTab('console')}>Console</button>}
          <button className={libOn ? 'on' : ''} onClick={() => toggle('library')}>Library{dirty ? ' •' : ''}</button>
          <button className={mapOn ? 'on' : ''} onClick={() => toggle('map')}>Map</button>
        </span>
        <button className="small" onClick={newWorld} disabled={running}>New world</button>
      </div>

      <div className={`panes${wide ? ' wide' : ''}`}>
        <div className="console" hidden={!consoleOn}>
          <section className="out" ref={outEl}>
            {lines.map((l) => (
              <div key={l.n} className={`line ${l.cls}`} onClick={l.cls === 'input' ? () => { inputEl.current?.setText(l.text); inputEl.current?.focus(); } : undefined}>
                {l.cls === 'input' ? <span className="prompt">›</span> : null}{l.text}
              </div>
            ))}
          </section>
          <div className="in">
            <span className="prompt">›</span>
            <CodeEditor ref={inputEl} mode="line" value={input} onChange={setInput} vocab={vocab} onSubmit={() => void submit()} onHistory={onHistory} />
            {running ? <button className="primary" onClick={() => session.current?.stop()}>Stop</button> : <button className="primary" onClick={submit}>Go</button>}
          </div>
        </div>

        <div className="side" hidden={!libOn && !mapOn}>
          <div className="lib-pane" hidden={!libOn}>
            <CodeEditor mode="file" value={libText} onChange={setLibText} vocab={vocab} onSave={() => void saveLibrary()} />
            <div className="bar">
              <span className="filename">library.js{dirty ? ' •' : ''}</span>
              <span className="spacer" />
              <button className="primary" onClick={saveLibrary} disabled={!dirty && libSaved === getSession().library}>Save</button>
            </div>
          </div>
          {mapOn && <div className="map-pane"><KnownMap state={s} /></div>}
        </div>
      </div>
    </div>
  );
}
