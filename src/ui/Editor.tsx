import { useState, type ReactNode } from 'react';
import {
  ACTIONS, CMP_OPS, condText, findStmt, insertStmt, locate, makeStmt, moveStmt, removeStmt, replaceStmt,
  SENSORS, slotCount, toText, VARS, wrapStmt,
  type Action, type BlockRef, type Cond, type Program, type Stmt, type StmtKind,
} from '../sim/lang';
import { kindsForTier, TIERS } from '../sim/progress';

type Sheet =
  | { mode: 'insert'; ref: BlockRef; index: number }
  | { mode: 'action'; id: string }
  | { mode: 'cond'; id: string }
  | null;

interface Props {
  program: Program;
  tier: number;
  currentId: string | null;
  onChange: (p: Program) => void;
}

const TOP: BlockRef = { parent: null, slot: 'body' };

export function Editor({ program, tier, currentId, onChange }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [view, setView] = useState<'blocks' | 'text'>('blocks');
  const kinds = kindsForTier(tier);
  const lines = slotCount(program);

  const update = (id: string, fn: (s: Stmt) => Stmt) => onChange(replaceStmt(program, id, fn));

  const insert = (k: StmtKind, a?: Action) => {
    if (!sheet || sheet.mode !== 'insert') return;
    const s = makeStmt(k, a);
    onChange(insertStmt(program, sheet.ref, sheet.index, s));
    setSelected(s.id);
    setSheet(null);
  };

  const block = (stmts: Stmt[], ref: BlockRef): ReactNode => (
    <div className="block">
      {stmts.map((s) => card(s))}
      <button className="add" onClick={() => setSheet({ mode: 'insert', ref, index: stmts.length })}>
        + add
      </button>
    </div>
  );

  const card = (s: Stmt): ReactNode => {
    const isSel = selected === s.id;
    return (
      <div key={s.id} className={`card k-${s.k}${isSel ? ' sel' : ''}${currentId === s.id ? ' cur' : ''}`}>
        <div className="row" onClick={() => setSelected(isSel ? null : s.id)}>
          {cardBody(s)}
        </div>
        {isSel && toolbar(s)}
        {s.k === 'if' && block(s.body, { parent: s.id, slot: 'body' })}
        {s.k === 'if' && s.orelse && (
          <>
            <div className="else">else</div>
            {block(s.orelse, { parent: s.id, slot: 'orelse' })}
          </>
        )}
        {(s.k === 'repeat' || s.k === 'while') && block(s.body, { parent: s.id, slot: 'body' })}
      </div>
    );
  };

  const chip = (label: string, onTap: () => void, cls = '') => (
    <button className={`chip ${cls}`} onClick={(e) => { e.stopPropagation(); onTap(); }}>{label}</button>
  );

  const stepper = (n: number, set: (n: number) => void, min: number, max: number) => (
    <span className="stepper" onClick={(e) => e.stopPropagation()}>
      <button onClick={() => set(Math.max(min, n - 1))} aria-label="decrease">−</button>
      <b>{n}</b>
      <button onClick={() => set(Math.min(max, n + 1))} aria-label="increase">+</button>
    </span>
  );

  const cycleVar = (s: Stmt) => update(s.id, (x) => ('v' in x ? { ...x, v: x.v === 'a' ? 'b' : 'a' } : x) as Stmt);

  const cardBody = (s: Stmt): ReactNode => {
    switch (s.k) {
      case 'act': return chip(s.a, () => setSheet({ mode: 'action', id: s.id }), 'act');
      case 'if': return <><Kw>if</Kw>{chip(condText(s.c), () => setSheet({ mode: 'cond', id: s.id }), 'cond')}</>;
      case 'while': return <><Kw>while</Kw>{chip(condText(s.c), () => setSheet({ mode: 'cond', id: s.id }), 'cond')}</>;
      case 'repeat': return <><Kw>repeat</Kw>{stepper(s.n, (n) => update(s.id, (x) => ({ ...x, n }) as Stmt), 1, 20)}<Kw>times</Kw></>;
      case 'set': return <>{chip(s.v, () => cycleVar(s), 'var')}<Kw>=</Kw>{stepper(s.n, (n) => update(s.id, (x) => ({ ...x, n }) as Stmt), -20, 20)}</>;
      case 'add': return <>{chip(s.v, () => cycleVar(s), 'var')}<Kw>+=</Kw>{stepper(s.n, (n) => update(s.id, (x) => ({ ...x, n }) as Stmt), -20, 20)}</>;
    }
  };

  const toolbar = (s: Stmt): ReactNode => {
    const loc = locate(program, s.id);
    return (
      <div className="toolbar">
        <button onClick={() => onChange(moveStmt(program, s.id, -1))} aria-label="move up">↑</button>
        <button onClick={() => onChange(moveStmt(program, s.id, 1))} aria-label="move down">↓</button>
        <button disabled={!loc} onClick={() => loc && setSheet({ mode: 'insert', ref: loc.ref, index: loc.index + 1 })}>+ below</button>
        {(['if', 'repeat', 'while'] as const).filter((k) => kinds.has(k)).map((k) => (
          <button key={k} onClick={() => onChange(wrapStmt(program, s.id, k))}>wrap {k}</button>
        ))}
        {s.k === 'if' && (
          <button
            onClick={() => update(s.id, (x) => (x.k === 'if' ? { ...x, orelse: x.orelse ? null : [] } : x))}
          >
            {s.orelse ? '− else' : '+ else'}
          </button>
        )}
        <button className="danger" onClick={() => { onChange(removeStmt(program, s.id)); setSelected(null); }}>delete</button>
      </div>
    );
  };

  return (
    <section className="editor">
      <header className="editor-head">
        <div className="tabs">
          <button className={view === 'blocks' ? 'on' : ''} onClick={() => setView('blocks')}>Blocks</button>
          <button className={view === 'text' ? 'on' : ''} onClick={() => setView('text')}>Text</button>
        </div>
        <span className="slots">{lines} {lines === 1 ? 'line' : 'lines'}</span>
      </header>
      {view === 'blocks' ? block(program, TOP) : <pre className="text">{toText(program)}</pre>}
      {sheet && (
        <div className="scrim" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {sheet.mode === 'insert' && <Palette tier={tier} kinds={kinds} onPick={insert} />}
            {sheet.mode === 'action' && (
              <div className="grid">
                {ACTIONS.map((a) => (
                  <button key={a} onClick={() => { update(sheet.id, (x) => ({ ...x, a }) as Stmt); setSheet(null); }}>{a}</button>
                ))}
              </div>
            )}
            {sheet.mode === 'cond' && (
              <CondPicker
                cond={(findStmt(program, sheet.id) as { c: Cond } | null)?.c ?? null}
                tier={tier}
                onChange={(c) => update(sheet.id, (x) => ({ ...x, c }) as Stmt)}
                onDone={() => setSheet(null)}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Kw({ children }: { children: ReactNode }) {
  return <span className="kw">{children}</span>;
}

function Palette({ tier, kinds, onPick }: { tier: number; kinds: Set<StmtKind>; onPick: (k: StmtKind, a?: Action) => void }) {
  const tokens: Record<number, { label: string; k: StmtKind; a?: Action }[]> = {
    0: ACTIONS.map((a) => ({ label: a, k: 'act' as const, a })),
    1: [{ label: 'if', k: 'if' }],
    2: [{ label: 'a = n', k: 'set' }, { label: 'a += n', k: 'add' }],
    3: [{ label: 'repeat', k: 'repeat' }, { label: 'while', k: 'while' }],
  };
  return (
    <div className="palette">
      {TIERS.filter((t) => t.tier <= tier + 1).map((t) => (
        <div key={t.tier} className={t.tier > tier ? 'locked' : ''}>
          <h4>{t.name}{t.tier > tier && ' · locked'}</h4>
          <div className="grid">
            {tokens[t.tier].map((tok) => (
              <button key={tok.label} disabled={!kinds.has(tok.k)} onClick={() => onPick(tok.k, tok.a)}>{tok.label}</button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CondPicker({ cond, tier, onChange, onDone }: { cond: Cond | null; tier: number; onChange: (c: Cond) => void; onDone: () => void }) {
  if (!cond) return null;
  const cmp: Cond = cond.k === 'cmp' ? cond : { k: 'cmp', v: 'a', op: '==', n: 0, neg: cond.neg };
  return (
    <div className="cond">
      <label className="toggle">
        <input type="checkbox" checked={cond.neg} onChange={() => onChange({ ...cond, neg: !cond.neg })} /> not
      </label>
      <h4>Sensors</h4>
      <div className="grid">
        {SENSORS.filter((s) => s !== 'loot_ahead').map((s) => (
          <button key={s} className={cond.k === 'sensor' && cond.s === s ? 'on' : ''} onClick={() => onChange({ k: 'sensor', s, neg: cond.neg })}>{s}</button>
        ))}
      </div>
      {tier >= 2 && (
        <>
          <h4>Compare a variable</h4>
          <div className="grid">
            {VARS.map((v) => (
              <button key={v} className={cond.k === 'cmp' && cond.v === v ? 'on' : ''} onClick={() => onChange({ ...cmp, v })}>{v}</button>
            ))}
            {CMP_OPS.map((op) => (
              <button key={op} className={cond.k === 'cmp' && cond.op === op ? 'on' : ''} onClick={() => onChange({ ...cmp, op })}>{op}</button>
            ))}
          </div>
          <div className="stepper big">
            <button onClick={() => onChange({ ...cmp, n: Math.max(-20, cmp.n - 1) })}>−</button>
            <b>{cmp.n}</b>
            <button onClick={() => onChange({ ...cmp, n: Math.min(20, cmp.n + 1) })}>+</button>
          </div>
        </>
      )}
      <button className="done" onClick={onDone}>Done</button>
    </div>
  );
}
