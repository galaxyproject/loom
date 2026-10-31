/**
 * A browser tool, as a flavor or the core writes one: its schema, what it needs, and how it runs
 * against the conversation's Galaxy, the web and Python. The adapter (orbit/adapter.ts) registers
 * each with Orbit's brain as a pi tool.
 */
import type { Artifact } from "../artifacts/kinds";
import type { Galaxy, Web } from "./galaxy";

export type { Artifact } from "../artifacts/kinds";

export type Capability = "llm" | "local" | "read" | "write";

/** What a tool reports when the plain result is not the whole story. */
export class Outcome {
  constructor(
    readonly text: string,
    readonly isError = false,
    /** What refused the call, when something did (a process's own refusal, say). */
    readonly guard?: string,
    /** The result `text` renders. */
    readonly data?: unknown,
  ) {}
}

export const fail = (text: string) => new Outcome(text, true);

export interface Python {
  /** An abort ends the run and the realm with it; the next call starts afresh. */
  run(code: string, signal?: AbortSignal): Promise<string>;
  write(path: string, data: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array | undefined>;
}

/** The conversation's identity in Galaxy: its id, its record page, the history it works in. */
export interface Binding {
  sessionId?: string;
  pageId?: string;
  historyId?: string;
}

export interface Context {
  galaxy: Galaxy;
  /** Hosts other than Galaxy, ended with the call or once its time is up. */
  web: Web;
  python: Python;
  /** What this session is bound to; the session owns it and reports its changes. */
  binding: Binding;
  /** Earlier turns' artifacts and this turn's, which a page may place. */
  artifacts: { prior: Artifact[]; produced: Artifact[] };
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  capability?: Capability;
  /** Deletes or cancels something that cannot be brought back: the user is asked first. */
  destructive?: boolean;
  /** Every capability the tool needs, when it is more than `capability` alone. */
  requires?: Capability[];
  run(args: any, ctx: Context): Promise<unknown>;
}

/** A Galaxy result as the model reads it: the envelope's non-empty payload fields. */
export function rendered(envelope: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const key of ["data", "message", "pagination"]) {
    if (envelope[key] !== undefined && envelope[key] !== null) {
      out[key] = envelope[key];
    }
  }
  return JSON.stringify(out);
}

/** Route an artifact to the shell, leaving its kind and title in the result. */
export function claim(value: unknown, ctx: Context, hint?: string): unknown {
  const artifact = (value as { artifact?: Artifact } | null)?.artifact;
  if (!artifact || typeof artifact !== "object") {
    return value;
  }
  ctx.artifacts.produced.push(artifact);
  return {
    ...(value as object),
    artifact: { kind: artifact.kind, title: artifact.title },
    ...(hint ? { hint } : {}),
  };
}
