// Runs the player's JavaScript in QuickJS. Time-taking calls block the guest
// while the host waits, so the player writes plain synchronous code.

import { newQuickJSAsyncWASMModuleFromVariant, type QuickJSAsyncWASMModule } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-asyncify';
import { advance, api, type State } from './world';

let modulePromise: Promise<QuickJSAsyncWASMModule> | null = null;
const loadModule = () => (modulePromise ??= newQuickJSAsyncWASMModuleFromVariant(variant));

const PRELUDE = `
  const __wrap = (name) => (...args) => {
    const r = JSON.parse(__call(name, JSON.stringify(args)));
    if (r && r.__error) throw new Error(r.__error);
    return r;
  };
  for (const name of ${JSON.stringify(Object.keys(api))}) globalThis[name] = __wrap(name);
  globalThis.print = (...args) => __print(args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
  globalThis.console = { log: globalThis.print };
`;

export interface Host {
  state: State;
  /** Ticks per real second. Read on every call, so it can change mid-run. */
  speed: () => number;
  log: (line: string, cls?: 'event' | 'print' | 'error') => void;
  changed: () => void;
}

export class Sandbox {
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(private host: Host) {}

  stop() {
    this.stopped = true;
    this.wake?.();
  }

  async run(code: string): Promise<void> {
    const mod = await loadModule();
    const rt = mod.newRuntime();
    rt.setMemoryLimit(32 * 1024 * 1024);
    rt.setMaxStackSize(512 * 1024);
    const vm = rt.newContext();
    const { host } = this;

    // Stop requests and runaway loops both come through the interrupt handler:
    // pure computation gets 5 s between API calls before it's cut off.
    const RUNAWAY_MS = 5000;
    let deadline = Date.now() + RUNAWAY_MS;
    rt.setInterruptHandler(() => this.stopped || Date.now() > deadline);

    const call = vm.newAsyncifiedFunction('__call', async (nameH, argsH) => {
      const name = vm.getString(nameH) as keyof typeof api;
      const args = JSON.parse(vm.getString(argsH)) as unknown[];
      const step = (api[name] as (s: State, ...a: unknown[]) => ReturnType<typeof api.go>)(host.state, ...args);
      for (const line of step.log) host.log(line, 'event');
      if (step.ticks > 0) {
        advance(host.state, step.ticks);
        host.changed();
        await this.sleep((step.ticks / host.speed()) * 1000);
      }
      deadline = Date.now() + RUNAWAY_MS;
      return vm.newString(JSON.stringify(step.result ?? null));
    });
    vm.setProp(vm.global, '__call', call);
    call.dispose();
    const print = vm.newFunction('__print', (h) => { host.log(vm.getString(h), 'print'); });
    vm.setProp(vm.global, '__print', print);
    print.dispose();

    try {
      const pre = vm.evalCode(PRELUDE);
      if (pre.error) { pre.error.dispose(); throw new Error('prelude failed'); }
      pre.value.dispose();
      const res = await vm.evalCodeAsync(code, 'script.js');
      if (res.error) {
        const err = vm.dump(res.error) as { name?: string; message?: string; stack?: string };
        res.error.dispose();
        if (!this.stopped) host.log(`${err.name ?? 'Error'}: ${err.message ?? ''}${err.stack ? '\n' + err.stack : ''}`, 'error');
      } else {
        res.value.dispose();
        host.log('script finished', 'event');
      }
    } finally {
      // Disposing the runtime after an asyncified run throws inside QuickJS; leaking it is fine for a probe.
      try { vm.dispose(); } catch { /* ignore */ }
    }
  }

  private sleep(ms: number) {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(t); resolve(); };
    });
  }
}
