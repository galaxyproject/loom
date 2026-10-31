/**
 * The browser's capability grant as Orbit's capability profile reads it. The page grants the
 * agent `llm`, `read`, `write` and `local` (Pyodide); Orbit's brain says the same thing as
 * `galaxy: "read" | "write"` and `python`. A grant this can't map isn't guessed at: the worker
 * refuses to boot Orbit on it, since a wrong mapping would hand the brain more than the page gave.
 */
import type { Capability } from "../tool";

export interface OrbitGrant {
  galaxy: "read" | "write";
  python: boolean;
}

const KNOWN: ReadonlySet<string> = new Set<Capability>(["llm", "local", "read", "write"]);

export class UnmappableGrant extends Error {
  override readonly name = "UnmappableGrant";
}

/** The profile fields for `capabilities`, or a throw naming what doesn't map. */
export function orbitGrant(capabilities: readonly string[]): OrbitGrant {
  const unknown = capabilities.filter((c) => !KNOWN.has(c));
  if (unknown.length) {
    throw new UnmappableGrant(`Orbit's brain has no capability for ${unknown.join(", ")}`);
  }
  // Orbit has no brain without a model, and none that can't read the Galaxy it works in.
  for (const required of ["llm", "read"] as const) {
    if (!capabilities.includes(required)) {
      throw new UnmappableGrant(`Orbit's brain needs the "${required}" capability`);
    }
  }
  return {
    galaxy: capabilities.includes("write") ? "write" : "read",
    python: capabilities.includes("local"),
  };
}
