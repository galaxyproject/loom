/**
 * What the conformance test mocks chokidar and better-sqlite3 with: a module that answers every
 * member with more of itself. Under the browser profile Orbit should never drive either, and a
 * Node-native addon has no place in a worker bundle. Every touch is counted on a global ledger
 * the worker reports, because the stub is bundled into the entry and the worker is not, and a
 * silent proxy could not show that nothing was driven.
 */
const LEDGER = "__bootInertLedger";

export function ledger(): Record<string, number> {
  const g = globalThis as Record<string, unknown>;
  return (g[LEDGER] ??= {}) as Record<string, number>;
}

const hit = (key: string) => {
  const l = ledger();
  l[key] = (l[key] ?? 0) + 1;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function inert(name: string): any {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      if (prop === "__esModule") return true;
      hit(`get ${name}.${prop}`);
      return inert(`${name}.${prop}`);
    },
    apply: () => {
      hit(`call ${name}()`);
      return inert(`${name}()`);
    },
    construct: () => {
      hit(`new ${name}()`);
      return inert(`new ${name}()`);
    },
  });
}
