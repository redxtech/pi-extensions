// Minimal vi-compatible shim for the plain node:test runner.
//
// The upstream pi-usage suite was written for vitest and uses a bounded slice of
// vi: fn, spyOn, stubGlobal, unstubAllGlobals, fake timers, setSystemTime,
// advanceTimersByTimeAsync, and waitFor. This shim implements that slice on top
// of node:test without any third-party dependency.

type Fn = (...args: unknown[]) => unknown;
type OnceImplementation = Fn | { resolved: true; value: unknown };

interface MockResult {
  type: "return" | "throw";
  value: unknown;
}

export interface ViMock {
  (...args: unknown[]): unknown;
  mock: {
    calls: unknown[][];
    results: MockResult[];
  };
  mockResolvedValue(value: unknown): ViMock;
  mockResolvedValueOnce(value: unknown): ViMock;
  mockReturnValue(value: unknown): ViMock;
  mockImplementation(fn: Fn): ViMock;
  mockRestore(): void;
}

interface TimerEntry {
  id: number;
  at: number;
  interval: number | undefined;
  callback: () => unknown;
}

const RealDate = Date;
const realSetTimeout = globalThis.setTimeout;
const pendingOnces = new WeakMap<ViMock, OnceImplementation[]>();
const pendingImplementations = new WeakMap<ViMock, Fn | undefined>();

function createMock(implementation?: Fn): ViMock {
  const calls: unknown[][] = [];
  const results: MockResult[] = [];
  const call = (...args: unknown[]): unknown => {
    calls.push(args);
    const once = pendingOnces.get(call)?.shift();
    let value: unknown;
    let threw = false;
    try {
      const implementationToUse = once
        ? conclusion(once)
        : (pendingImplementations.get(call) ?? implementation);
      if (implementationToUse) value = Reflect.apply(implementationToUse, undefined, args);
    } catch (error) {
      threw = true;
      value = error;
    }
    results.push({ type: threw ? "throw" : "return", value });
    return value;
  };
  call.mock = { calls, results };
  call.mockResolvedValue = (value: unknown) => {
    pendingImplementations.set(call, async () => value);
    return call;
  };
  call.mockResolvedValueOnce = (value: unknown) => {
    queueOnce(call, { resolved: true, value });
    return call;
  };
  call.mockReturnValue = (value: unknown) => {
    pendingImplementations.set(call, () => value);
    return call;
  };
  call.mockImplementation = (fn: Fn) => {
    pendingImplementations.set(call, fn);
    return call;
  };
  call.mockRestore = () => restoreSpy(call);
  return call;
}

function queueOnce(mock: ViMock, implementation: OnceImplementation) {
  const queued = pendingOnces.get(mock) ?? [];
  queued.push(implementation);
  pendingOnces.set(mock, queued);
}

function conclusion(implementation: OnceImplementation): Fn {
  if (implementation.resolved) {
    const { value } = implementation;
    return async () => value;
  }
  return implementation;
}

const installedSpies = new Map<ViMock, { target: object; key: string | symbol; original: unknown }>();
const installedGlobals: Array<{ name: string; original: unknown; hadOriginal: boolean }> = [];

function restoreSpy(mock: ViMock) {
  const spy = installedSpies.get(mock);
  if (!spy) return;
  installedSpies.delete(mock);
  if (spy.original === undefined) delete (spy.target as Record<string, unknown>)[spy.key as string];
  else (spy.target as Record<string, unknown>)[spy.key as string] = spy.original;
}

// Fake clock

interface Clock {
  now: number;
  nextId: number;
  timers: TimerEntry[];
}

let clock: Clock | undefined;
const realGlobals: {
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
} = {};
let fakeDateInstalled = false;

function resetClock() {
  clock = { now: RealDate.now(), nextId: 1, timers: [] };
}

function virtualSetTimeout(callback: () => unknown, delay = 0): number {
  const at = (clock?.now ?? RealDate.now()) + delay;
  const id = clock!.nextId++;
  clock!.timers.push({ id, at, interval: undefined, callback });
  return id;
}

function virtualSetInterval(callback: () => unknown, delay = 0): number {
  const at = (clock?.now ?? RealDate.now()) + delay;
  const id = clock!.nextId++;
  clock!.timers.push({ id, at, interval: delay, callback });
  return id;
}

function virtualClearTimeout(id: number) {
  virtualClearInterval(id);
}

function virtualClearInterval(id: number) {
  clock?.timers.splice(
    clock.timers.findIndex((timer) => timer.id === id),
    1,
  );
}

function installFakeDate() {
  class FakeDate extends RealDate {
    static now() {
      return clock?.now ?? RealDate.now();
    }
    constructor(...args: ConstructorParameters<typeof RealDate>) {
      if (args.length === 0) super(clock?.now ?? RealDate.now());
      else super(...args);
    }
  }
  globalThis.Date = FakeDate as unknown as typeof Date;
  fakeDateInstalled = true;
}

function uninstallFakeDate() {
  globalThis.Date = RealDate;
  fakeDateInstalled = false;
}

function installFakeTimers() {
  if (clock) return;
  realGlobals.setTimeout = globalThis.setTimeout;
  realGlobals.clearTimeout = globalThis.clearTimeout;
  realGlobals.setInterval = globalThis.setInterval;
  realGlobals.clearInterval = globalThis.clearInterval;
  resetClock();
  globalThis.setTimeout = virtualSetTimeout as typeof setTimeout;
  globalThis.setInterval = virtualSetInterval as typeof setInterval;
  globalThis.clearTimeout = virtualClearTimeout as typeof clearTimeout;
  globalThis.clearInterval = virtualClearInterval as typeof clearInterval;
  installFakeDate();
}

function uninstallFakeTimers() {
  if (!clock) return;
  if (realGlobals.setTimeout) globalThis.setTimeout = realGlobals.setTimeout;
  if (realGlobals.clearTimeout) globalThis.clearTimeout = realGlobals.clearTimeout;
  if (realGlobals.setInterval) globalThis.setInterval = realGlobals.setInterval;
  if (realGlobals.clearInterval) globalThis.clearInterval = realGlobals.clearInterval;
  clock = undefined;
  if (fakeDateInstalled) uninstallFakeDate();
}

async function drainMicrotasks() {
  // let queued async continuations settle between virtual timer firings
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve();
  }
}

async function runDueTimers(target: number) {
  while (clock) {
    let earliest: TimerEntry | undefined;
    for (const timer of clock.timers) {
      if (timer.at > target) continue;
      if (!earliest || timer.at < earliest.at) earliest = timer;
    }
    if (!earliest) break;
    clock.now = earliest.at;
    clock.timers = clock.timers.filter((timer) => timer.id !== earliest.id);
    if (earliest.interval !== undefined) {
      const id = clock!.nextId++;
      clock.timers.push({ id, at: earliest.at + earliest.interval, interval: earliest.interval, callback: earliest.callback });
    }
    await earliest.callback();
    await drainMicrotasks();
  }
}

function restoreOriginalGlobals() {
  for (const entry of installedGlobals.splice(0)) {
    if (entry.hadOriginal) (globalThis as Record<string, unknown>)[entry.name] = entry.original;
    else delete (globalThis as Record<string, unknown>)[entry.name];
  }
  for (const mock of [...installedSpies.keys()]) restoreSpy(mock);
}

export const vi = {
  fn(implementation?: Fn) {
    return createMock(implementation);
  },
  spyOn<T extends object>(target: T, key: keyof T & (string | symbol)): ViMock {
    const original = (target as Record<string, unknown>)[key as string];
    const mock = createMock(
      original !== undefined && typeof original === "function"
        ? (...args: unknown[]) => Reflect.apply(original as Fn, target, args)
        : undefined,
    );
    (target as Record<string, unknown>)[key as string] = mock;
    installedSpies.set(mock, { target, key, original });
    return mock;
  },
  stubGlobal(name: string, value: unknown) {
    installedGlobals.push({
      name,
      original: (globalThis as Record<string, unknown>)[name],
      hadOriginal: name in globalThis,
    });
    (globalThis as Record<string, unknown>)[name] = value;
  },
  unstubAllGlobals() {
    restoreOriginalGlobals();
  },
  useFakeTimers() {
    installFakeTimers();
  },
  useRealTimers() {
    uninstallFakeTimers();
  },
  setSystemTime(value?: number | string | Date) {
    if (!clock) resetClock();
    clock!.now = value === undefined ? RealDate.now() : typeof value === "number" ? value : RealDate.parse(String(value));
  },
  async advanceTimersByTimeAsync(ms: number) {
    if (!clock) throw new Error("vi.advanceTimersByTimeAsync requires fake timers");
    // sinon's tickAsync, which backs vitest, yields to already-queued microtasks
    // before moving the virtual clock so pending chains can schedule their timers.
    await drainMicrotasks();
    const target = clock.now + ms;
    await runDueTimers(target);
    // drain pending async work again so promise chains triggered by virtual
    // timers settle before assertions.
    if (clock) {
      clock.now = target;
      await drainMicrotasks();
    }
  },
  async waitFor(
    callback: () => void,
    options: { timeout?: number; interval?: number } = {},
  ) {
    const timeout = options.timeout ?? 1_000;
    const interval = options.interval ?? 5;
    const deadline = RealDate.now() + timeout;
    let lastError: unknown;
    while (RealDate.now() < deadline) {
      try {
        await callback();
        return;
      } catch (error) {
        lastError = error;
      }
      await new Promise<void>((resolve) => realSetTimeout(resolve, interval));
    }
    throw lastError ?? new Error("vi.waitFor timed out");
  },
};