// A persistent JavaScript session in QuickJS. Each input is evaluated in the
// same global scope, so definitions stick around: that's the player's library.
// Time-taking calls block the guest while the host waits, so code is plain and
// synchronous.

import { newQuickJSAsyncWASMModuleFromVariant, type QuickJSAsyncContext, type QuickJSAsyncWASMModule } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-asyncify';
import { advance, api, type State } from './world';

const RUNAWAY_MS = 5000;

let modulePromise: Promise<QuickJSAsyncWASMModule> | null = null;
const loadModule = () => (modulePromise ??= newQuickJSAsyncWASMModuleFromVariant(variant));

/** A macrotask yield (setTimeout(0) is clamped to 4 ms once nested; MessageChannel isn't). */
const yieldToBrowser = (() => {
  if (typeof MessageChannel === 'undefined') return () => new Promise<void>((r) => setTimeout(r, 0));
  const ch = new MessageChannel();
  const waiting: (() => void)[] = [];
  ch.port1.onmessage = () => waiting.shift()?.();
  return () => new Promise<void>((r) => { waiting.push(r); ch.port2.postMessage(null); });
})();

const PRELUDE = `
  const __wrap = (name) => {
    const f = (...args) => {
      const r = JSON.parse(__call(name, JSON.stringify(args)));
      if (r && r.__error) throw new Error(r.__error);
      return r;
    };
    f.__cmd = name;
    return f;
  };
  for (const name of ${JSON.stringify(Object.keys(api))}) globalThis[name] = __wrap(name);
  globalThis.help = (x) => __call('help', JSON.stringify([x == null ? null : typeof x === 'function' ? x.__cmd ?? x.name : String(x)])) && undefined;
  globalThis.print = (...args) => { __print(args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); };
  globalThis.library = (what) => { __library(what == null ? null : typeof what === 'function' ? what.name : String(what)); };
  globalThis.console = { log: globalThis.print };
`;

export type Cls = 'event' | 'print' | 'error' | 'value' | 'input';

export interface Host {
  state: () => State;
  /** Ticks per real second. Read on every call, so it can change mid-run. */
  speed: () => number;
  log: (line: string, cls: Cls) => void;
  changed: () => void;
  /** The library changed (a definition was added or replaced). */
  libraryChanged?: (defs: Def[]) => void;
}

export interface Def { name: string; code: string }

/**
 * A top-level definition the player will want again next time. `const`/`let`/`class`
 * are rewritten to `var` so typing the definition again replaces it instead of
 * throwing a redeclaration error: editing a function is the core loop.
 */
export function parseDefinition(code: string): Def | null {
  const m = /^\s*(const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/.exec(code);
  if (!m) return null;
  const [, kw, name] = m;
  let rewritten = code;
  if (kw === 'const' || kw === 'let') rewritten = code.replace(/^\s*(const|let)\b/, 'var');
  else if (kw === 'class') rewritten = code.replace(/^\s*class\b/, `var ${name} = class`);
  return { name, code: rewritten };
}

export class Session {
  private vm: QuickJSAsyncContext | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;
  private deadline = 0;
  private prose = 0;
  private worldCalls = 0;
  /** While restoring the library, world commands are refused so a bad entry can't act or wedge the VM. */
  private restoring = false;
  private restored = false;
  running = false;
  /** Everything the player has defined, in first-defined order. */
  readonly defs: Def[];

  constructor(private host: Host, defs: Def[] = []) {
    this.defs = defs.map((d) => ({ ...d }));
  }

  private async context(): Promise<QuickJSAsyncContext> {
    if (this.vm) return this.vm;
    const mod = await loadModule();
    const rt = mod.newRuntime();
    rt.setMemoryLimit(32 * 1024 * 1024);
    rt.setMaxStackSize(512 * 1024);
    const vm = rt.newContext();
    const { host } = this;
    rt.setInterruptHandler(() => this.stopped || Date.now() > this.deadline);

    const call = vm.newAsyncifiedFunction('__call', async (nameH, argsH) => {
      const name = vm.getString(nameH) as keyof typeof api;
      const args = JSON.parse(vm.getString(argsH)) as unknown[];
      this.worldCalls++;
      if (this.restoring) return vm.newString(JSON.stringify({ __error: `${name}() ran while restoring the library` }));
      const state = host.state();
      const step = (api[name] as (s: State, ...a: unknown[]) => ReturnType<typeof api.go>)(state, ...args);
      for (const line of step.log) { this.prose++; host.log(line, step.mono ? 'print' : 'event'); }
      if (step.ticks > 0) {
        advance(state, step.ticks);
        host.changed();
        await this.sleep((step.ticks / host.speed()) * 1000);
        this.deadline = Date.now() + RUNAWAY_MS;
      } else {
        await yieldToBrowser(); // keep the page responsive during query-only loops
      }
      return vm.newString(JSON.stringify(step.result ?? null));
    });
    vm.setProp(vm.global, '__call', call);
    call.dispose();
    const print = vm.newFunction('__print', (h) => { this.prose++; host.log(vm.getString(h), 'print'); });
    vm.setProp(vm.global, '__print', print);
    print.dispose();
    const library = vm.newFunction('__library', (h) => {
      this.prose++;
      const what = vm.dump(h) as string | null;
      const defs = what ? this.defs.filter((d) => d.name === what) : this.defs;
      if (defs.length === 0) host.log(what ? `nothing defined as ${what}` : 'your library is empty', 'value');
      for (const d of defs) host.log(d.code, 'input');
    });
    vm.setProp(vm.global, '__library', library);
    library.dispose();

    this.deadline = Date.now() + RUNAWAY_MS;
    const pre = vm.evalCode(PRELUDE);
    if (pre.error) { pre.error.dispose(); throw new Error('prelude failed'); }
    pre.value.dispose();
    this.vm = vm;
    return vm;
  }

  /** Re-enter saved definitions. Anything that fails (e.g. it calls the world) is dropped and reported. */
  private async restore(vm: QuickJSAsyncContext) {
    this.restored = true;
    this.restoring = true;
    let dropped = false;
    for (const d of this.defs.slice()) {
      this.deadline = Date.now() + RUNAWAY_MS;
      const r = await vm.evalCodeAsync(d.code, d.name);
      if (r.error) {
        const err = vm.dump(r.error) as { message?: string };
        r.error.dispose();
        this.defs.splice(this.defs.indexOf(d), 1);
        dropped = true;
        this.host.log(`${d.name} dropped from your library: ${err.message ?? 'could not be restored'}`, 'error');
      } else r.value.dispose();
    }
    this.restoring = false;
    if (dropped) this.host.libraryChanged?.(this.defs);
  }

  private queue: Promise<void> = Promise.resolve();

  /** Evaluate one input. Inputs run one at a time, in order; none are dropped. */
  eval(code: string, quiet = false): Promise<void> {
    const run = this.queue.then(() => this.evalNow(code, quiet));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Prose printed during an input suppresses the echo of its value. */
  private async evalNow(code: string, quiet: boolean): Promise<void> {
    this.running = true;
    this.stopped = false;
    this.prose = 0;
    const { host } = this;
    const def = parseDefinition(code);
    try {
      const vm = await this.context();
      if (!this.restored) await this.restore(vm);
      this.worldCalls = 0;
      this.deadline = Date.now() + RUNAWAY_MS;
      const res = await vm.evalCodeAsync(def ? def.code : code, 'console');
      if (res.error) {
        const err = vm.dump(res.error) as { name?: string; message?: string };
        res.error.dispose();
        if (this.stopped) host.log('stopped', 'error');
        else if (err.name === 'InternalError' && /interrupted/.test(err.message ?? '')) host.log(`interrupted: ${RUNAWAY_MS / 1000} s passed without game time passing`, 'error');
        else host.log(`${err.name ?? 'Error'}: ${err.message ?? ''}`, 'error');
      } else if (def) {
        // Only definitions that didn't act on the world are kept: a value computed
        // from the world is a snapshot, and replaying it on boot would act again.
        if (this.worldCalls > 0) {
          if (!quiet) host.log(`${def.name} not saved: it ran world commands`, 'value');
        } else {
          const i = this.defs.findIndex((d) => d.name === def.name);
          if (i >= 0) this.defs[i] = def; else this.defs.push(def);
          host.libraryChanged?.(this.defs);
          if (!quiet) host.log(`${def.name} ${i >= 0 ? 'updated in' : 'saved to'} your library`, 'value');
        }
        res.value.dispose();
      } else {
        const t = vm.typeof(res.value);
        if (!quiet && this.prose === 0 && t !== 'undefined') {
          const v = t === 'function' ? `[function ${vm.getProp(res.value, 'name').consume(vm.dump) || ''}]` : vm.dump(res.value);
          host.log(format(v), 'value');
        }
        res.value.dispose();
      }
    } finally {
      this.running = false;
      host.changed();
    }
  }

  stop() {
    this.stopped = true;
    this.wake?.();
  }

  private sleep(ms: number) {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(t); resolve(); };
    });
  }
}

/** Values echo as readable lines, not JSON. */
export function format(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return v.map((x) => row(x as Record<string, unknown>)).join('\n');
    return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  }
  if (typeof v === 'object') return row(v as Record<string, unknown>);
  return String(v);
}
const row = (o: Record<string, unknown>) =>
  Object.entries(o).filter(([k, x]) => k !== 'id' && x !== '' && x !== undefined)
    .map(([k, x]) => (k === 'name' ? String(x) : `${k} ${Array.isArray(x) ? format(x).replace(/\n/g, '; ') : typeof x === 'object' && x ? JSON.stringify(x) : String(x)}`))
    .join('  ');
