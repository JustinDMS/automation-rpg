// The player's language. Programs are trees, never text, so they can't have syntax errors.

export type Action = 'forward' | 'turn_left' | 'turn_right' | 'wait';
export type Sensor = 'wall_ahead' | 'wall_left' | 'wall_right' | 'visited_ahead' | 'loot_ahead' | 'coin';
export type Var = 'a' | 'b';
export type CmpOp = '==' | '<' | '>';

export type Cond =
  | { k: 'sensor'; s: Sensor; neg: boolean }
  | { k: 'cmp'; v: Var; op: CmpOp; n: number; neg: boolean };

export type Stmt =
  | { id: string; k: 'act'; a: Action }
  | { id: string; k: 'if'; c: Cond; body: Stmt[]; orelse: Stmt[] | null }
  | { id: string; k: 'set'; v: Var; n: number }
  | { id: string; k: 'add'; v: Var; n: number }
  | { id: string; k: 'repeat'; n: number; body: Stmt[] }
  | { id: string; k: 'while'; c: Cond; body: Stmt[] };

export type Program = Stmt[];
export type StmtKind = Stmt['k'];

export const ACTIONS: Action[] = ['forward', 'turn_left', 'turn_right', 'wait'];
export const SENSORS: Sensor[] = ['wall_ahead', 'wall_left', 'wall_right', 'visited_ahead', 'loot_ahead', 'coin'];
export const VARS: Var[] = ['a', 'b'];
export const CMP_OPS: CmpOp[] = ['==', '<', '>'];

let idCounter = 0;
export function newId(): string {
  idCounter += 1;
  return `n${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function defaultCond(): Cond {
  return { k: 'sensor', s: 'wall_ahead', neg: false };
}

/** A fresh statement of the given kind, with sensible defaults. */
export function makeStmt(k: StmtKind, a: Action = 'forward'): Stmt {
  const id = newId();
  switch (k) {
    case 'act': return { id, k, a };
    case 'if': return { id, k, c: defaultCond(), body: [], orelse: null };
    case 'set': return { id, k, v: 'a', n: 0 };
    case 'add': return { id, k, v: 'a', n: 1 };
    case 'repeat': return { id, k, n: 2, body: [] };
    case 'while': return { id, k, c: { k: 'sensor', s: 'wall_ahead', neg: true }, body: [] };
  }
}

/** Instruction slots used: every statement costs one, wherever it is nested. */
export function slotCount(p: Program): number {
  let n = 0;
  for (const s of p) {
    n += 1;
    if (s.k === 'if') n += slotCount(s.body) + (s.orelse ? slotCount(s.orelse) : 0);
    else if (s.k === 'repeat' || s.k === 'while') n += slotCount(s.body);
  }
  return n;
}

// ---- Tree editing (immutable) ----

/** Where a block lives: the top level (parent null) or a child block of an if/repeat/while. */
export interface BlockRef { parent: string | null; slot: 'body' | 'orelse' }

export function getBlock(p: Program, ref: BlockRef): Stmt[] | null {
  if (ref.parent === null) return p;
  const s = findStmt(p, ref.parent);
  if (!s) return null;
  if (ref.slot === 'orelse') return s.k === 'if' ? s.orelse : null;
  return 'body' in s ? s.body : null;
}

export function findStmt(p: Program, id: string): Stmt | null {
  for (const s of p) {
    if (s.id === id) return s;
    for (const child of children(s)) {
      const f = findStmt(child, id);
      if (f) return f;
    }
  }
  return null;
}

function children(s: Stmt): Stmt[][] {
  if (s.k === 'if') return s.orelse ? [s.body, s.orelse] : [s.body];
  if (s.k === 'repeat' || s.k === 'while') return [s.body];
  return [];
}

/** Rebuild the tree, letting `fn` rewrite each block (statement list). */
function mapBlocks(p: Program, fn: (block: Stmt[], ref: BlockRef) => Stmt[], ref: BlockRef = { parent: null, slot: 'body' }): Program {
  const rebuilt = p.map((s): Stmt => {
    if (s.k === 'if') {
      return {
        ...s,
        body: mapBlocks(s.body, fn, { parent: s.id, slot: 'body' }),
        orelse: s.orelse ? mapBlocks(s.orelse, fn, { parent: s.id, slot: 'orelse' }) : null,
      };
    }
    if (s.k === 'repeat' || s.k === 'while') return { ...s, body: mapBlocks(s.body, fn, { parent: s.id, slot: 'body' }) };
    return s;
  });
  return fn(rebuilt, ref);
}

const sameRef = (a: BlockRef, b: BlockRef) => a.parent === b.parent && (a.parent === null || a.slot === b.slot);

export function insertStmt(p: Program, ref: BlockRef, index: number, stmt: Stmt): Program {
  return mapBlocks(p, (block, r) => {
    if (!sameRef(r, ref)) return block;
    const out = block.slice();
    out.splice(Math.max(0, Math.min(index, out.length)), 0, stmt);
    return out;
  });
}

export function replaceStmt(p: Program, id: string, fn: (s: Stmt) => Stmt): Program {
  return mapBlocks(p, (block) => block.map((s) => (s.id === id ? fn(s) : s)));
}

export function removeStmt(p: Program, id: string): Program {
  return mapBlocks(p, (block) => block.filter((s) => s.id !== id));
}

/** Move a statement up (-1) or down (+1) within its block. */
export function moveStmt(p: Program, id: string, delta: -1 | 1): Program {
  return mapBlocks(p, (block) => {
    const i = block.findIndex((s) => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= block.length) return block;
    const out = block.slice();
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  });
}

/** Replace a statement with a new container (if/repeat/while) holding it. */
export function wrapStmt(p: Program, id: string, k: 'if' | 'repeat' | 'while'): Program {
  return mapBlocks(p, (block) => block.map((s) => {
    if (s.id !== id) return s;
    const w = makeStmt(k);
    return { ...w, body: [s] } as Stmt;
  }));
}

/** The block and index a statement sits at. */
export function locate(p: Program, id: string): { ref: BlockRef; index: number } | null {
  let found: { ref: BlockRef; index: number } | null = null;
  mapBlocks(p, (block, ref) => {
    const i = block.findIndex((s) => s.id === id);
    if (i >= 0) found = { ref, index: i };
    return block;
  });
  return found;
}

// ---- Text rendering (Python-flavoured, read-only for now) ----

export function condText(c: Cond): string {
  const core = c.k === 'sensor' ? c.s : `${c.v} ${c.op} ${c.n}`;
  return c.neg ? `not ${core}` : core;
}

export function toText(p: Program, indent = ''): string {
  if (p.length === 0) return `${indent}pass\n`;
  let out = '';
  for (const s of p) {
    switch (s.k) {
      case 'act': out += `${indent}${s.a}()\n`; break;
      case 'set': out += `${indent}${s.v} = ${s.n}\n`; break;
      case 'add': out += `${indent}${s.v} ${s.n < 0 ? '-=' : '+='} ${Math.abs(s.n)}\n`; break;
      case 'repeat': out += `${indent}repeat ${s.n}:\n${toText(s.body, indent + '    ')}`; break;
      case 'while': out += `${indent}while ${condText(s.c)}:\n${toText(s.body, indent + '    ')}`; break;
      case 'if':
        out += `${indent}if ${condText(s.c)}:\n${toText(s.body, indent + '    ')}`;
        if (s.orelse) out += `${indent}else:\n${toText(s.orelse, indent + '    ')}`;
        break;
    }
  }
  return out;
}
