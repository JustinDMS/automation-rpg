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
  globalThis.console = { log: globalThis.print };
`;

export type Cls = 'event' | 'print' | 'error' | 'value' | 'input';

export interface Host {
  state: () => State;
  /** Ticks per real second. Read on every call, so it can change mid-run. */
  speed: () => number;
  log: (line: string, cls: Cls) => void;
  changed: () => void;
}

/** Looks like a definition the player will want again next time. */
export const isDefinition = (code: string) => /^\s*(const|let|var|function|class|async\s+function)\s/.test(code);

export class Session {
  private vm: QuickJSAsyncContext | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;
  private deadline = 0;
  private prose = 0;
  running = false;

  constructor(private host: Host) {}

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

    this.deadline = Date.now() + RUNAWAY_MS;
    const pre = vm.evalCode(PRELUDE);
    if (pre.error) { pre.error.dispose(); throw new Error('prelude failed'); }
    pre.value.dispose();
    this.vm = vm;
    return vm;
  }

  /** Evaluate one input. Prose printed during it suppresses the echo of its value. */
  async eval(code: string, quiet = false): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.prose = 0;
    const { host } = this;
    try {
      const vm = await this.context();
      this.deadline = Date.now() + RUNAWAY_MS;
      const res = await vm.evalCodeAsync(code, 'console');
      if (res.error) {
        const err = vm.dump(res.error) as { name?: string; message?: string };
        res.error.dispose();
        if (this.stopped) host.log('stopped', 'error');
        else if (err.name === 'InternalError' && /interrupted/.test(err.message ?? '')) host.log(`interrupted: ${RUNAWAY_MS / 1000} s passed without game time passing`, 'error');
        else host.log(`${err.name ?? 'Error'}: ${err.message ?? ''}`, 'error');
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
