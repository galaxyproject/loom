/**
 * What pi's MCP client gave every Galaxy tool for free, rebuilt for calls that run in-process:
 * a deadline, a spill for oversized output, and a result the guards can classify without reading
 * its prose.
 *
 * Every result is a galaxy-ops envelope (`{data, success, message, count, pagination}`, the
 * Python server's shape key for key), including the ones built here -- no connection, a refused
 * argument, the deadline -- so everything downstream parses one shape. The model reads the
 * envelope as JSON text; `structuredContent` carries the same object for programmatic callers;
 * `details.galaxy` says which tool ran, how it failed, and where a spilled output went.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { GalaxyContext, GalaxyResult } from "@galaxyproject/galaxy-ops";
import { utf8ByteLength } from "../../shared/truncate-middle.js";
import { galaxyOpsContext } from "./galaxy-api";
import { GALAXY_DEADLINE_TEXT, kindOfEnvelope, type GalaxyCallKind } from "./galaxy-failure";
import { record, spillPreview } from "./galaxy-output";
import { galaxyOutputStore } from "./galaxy-output-store";
import type { GalaxyTool } from "./galaxy-tool-source";

/** pi's MCP client gave every request five minutes; so does every in-process op. */
export const GALAXY_DEADLINE_MS = 300_000;
/** Above this many UTF-8 bytes the model gets a bounded preview and the full text is saved. */
export const GALAXY_SPILL_BYTES = 20 * 1024;

export type GalaxyEnvelope = GalaxyResult<unknown>;

export interface GalaxyCallDetails {
  /** `kind` is set on every failure, null when the failure has no recovery advice. */
  galaxy: { tool: string; kind?: GalaxyCallKind | null; outputId?: string; elapsedMs: number };
}

export interface GalaxyCallResult {
  content: { type: "text"; text: string }[];
  structuredContent: GalaxyEnvelope;
  details: GalaxyCallDetails;
  isError: boolean;
}

export type GalaxyContextFactory = (signal: AbortSignal) => GalaxyContext | null;

export interface GalaxyCallOptions {
  deadlineMs?: number;
  /** Where the call's context comes from; tests hand in their own. */
  context?: GalaxyContextFactory;
}

/** A failure envelope in runWithEnvelope's own shape, for a refusal made before Galaxy was asked. */
export function galaxyFailure(message: string, errorKind?: string): GalaxyEnvelope {
  return {
    data: undefined,
    success: false,
    message,
    ...(errorKind === undefined ? {} : { errorKind: errorKind as GalaxyEnvelope["errorKind"] }),
  };
}

const NOT_CONNECTED =
  "Galaxy is not connected: no Galaxy URL and API key are configured. Ask the user to run /connect.";

/** The envelope as the model and the guards see it, spilled when it is too large to show whole. */
export function renderGalaxyResult(
  tool: string,
  env: GalaxyEnvelope,
  elapsedMs: number,
  kind?: GalaxyCallKind,
): GalaxyCallResult {
  let text = JSON.stringify(env);
  let outputId: string | undefined;
  if (utf8ByteLength(text) > GALAXY_SPILL_BYTES) {
    outputId = galaxyOutputStore().put(text, tool);
    text = spillPreview(text, outputId, env.success === false);
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: env,
    details: {
      galaxy: {
        tool,
        ...(env.success === false ? { kind: kind ?? null } : {}),
        ...(outputId === undefined ? {} : { outputId }),
        elapsedMs,
      },
    },
    isError: env.success === false,
  };
}

type Deadlined<T> = { timedOut: false; value: T; late: boolean } | { timedOut: true };

/**
 * Run `work` against a deadline, and return when the deadline fires even if `work` never does.
 *
 * Joining the timer into the signal cancels well-behaved requests and poll sleeps, but a
 * transport is free to ignore its signal, and openapi-fetch then waits forever; only racing the
 * timer guarantees the call comes back. Our own timer rather than `AbortSignal.timeout` so fake
 * timers can drive it. A caller's abort is rethrown: that is pi stopping the turn, not a failure.
 */
async function withDeadline<T>(
  signal: AbortSignal | undefined,
  deadlineMs: number,
  work: (joined: AbortSignal) => Promise<T>,
): Promise<Deadlined<T>> {
  const timer = new AbortController();
  const handle = setTimeout(() => timer.abort(), deadlineMs);
  const joined = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
  let unlisten = () => {};
  const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
    const on = () => resolve({ kind: "aborted" });
    if (joined.aborted) return on();
    joined.addEventListener("abort", on, { once: true });
    unlisten = () => joined.removeEventListener("abort", on);
  });
  try {
    let running: Promise<T>;
    try {
      running = work(joined);
    } catch (error) {
      running = Promise.reject(error);
    }
    // Both outcomes are handled here, so the losing call's late rejection is never unhandled.
    const settled = await Promise.race([
      running.then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      aborted,
    ]);
    if (signal?.aborted) throw signal.reason;
    if (settled.kind === "value") {
      return { timedOut: false, value: settled.value, late: timer.signal.aborted };
    }
    // A call that throws once the deadline fired (a poll sleep's plain Error("aborted"), an
    // aborted fetch) failed because of the deadline, whatever it threw.
    if (settled.kind === "aborted" || timer.signal.aborted) return { timedOut: true };
    throw settled.error;
  } finally {
    clearTimeout(handle);
    unlisten();
  }
}

/**
 * Run one Galaxy call under the deadline, with a context bound to the joined signal, and render
 * what comes back. `call` returns an envelope; anything it throws that is not the deadline's
 * doing is rethrown, and pi turns it into an error result.
 */
export async function runGalaxyCall(
  tool: string,
  signal: AbortSignal | undefined,
  call: (ctx: GalaxyContext, signal: AbortSignal) => Promise<GalaxyEnvelope>,
  opts: GalaxyCallOptions = {},
): Promise<GalaxyCallResult> {
  const started = Date.now();
  const contextFor = opts.context ?? galaxyOpsContext;
  const outcome = await withDeadline(
    signal,
    opts.deadlineMs ?? GALAXY_DEADLINE_MS,
    async (joined): Promise<{ env: GalaxyEnvelope; kind?: GalaxyCallKind }> => {
      const ctx = contextFor(joined);
      if (!ctx) return { env: galaxyFailure(NOT_CONNECTED, "auth"), kind: "auth" };
      return { env: await call(ctx, joined) };
    },
  );
  const elapsedMs = Date.now() - started;
  if (outcome.timedOut) {
    return renderGalaxyResult(tool, galaxyFailure(GALAXY_DEADLINE_TEXT), elapsedMs, "timeout");
  }
  const { env, kind } = outcome.value;
  if (env.success !== false) return renderGalaxyResult(tool, env, elapsedMs);
  // A failure that lands after the timer fired is the aborted request's, not Galaxy's answer.
  if (outcome.late) {
    return renderGalaxyResult(tool, galaxyFailure(GALAXY_DEADLINE_TEXT), elapsedMs, "timeout");
  }
  return renderGalaxyResult(tool, env, elapsedMs, kind ?? kindOfEnvelope(env.errorKind));
}

/**
 * The same deadline and spill for a tool a shell supplies itself (an extra), so its large output
 * is read back through `galaxy_read_output` and the guards know it as a Galaxy call. A shell opts
 * an extra in; the source never wraps one on its own.
 */
export function wrapGalaxyTool(def: GalaxyTool, opts: { deadlineMs?: number } = {}): GalaxyTool {
  return {
    ...def,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const started = Date.now();
      const outcome = await withDeadline(signal, opts.deadlineMs ?? GALAXY_DEADLINE_MS, (joined) =>
        Promise.resolve(def.execute(toolCallId, params, joined, onUpdate, ctx)),
      );
      const elapsedMs = Date.now() - started;
      if (outcome.timedOut) {
        return {
          content: [{ type: "text", text: GALAXY_DEADLINE_TEXT }],
          details: { galaxy: { tool: def.name, kind: "timeout", elapsedMs } },
          isError: true,
        };
      }
      const result = outcome.value as AgentToolResult<unknown>;
      const text = result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
      let outputId: string | undefined;
      let content = result.content;
      if (utf8ByteLength(text) > GALAXY_SPILL_BYTES) {
        outputId = galaxyOutputStore().put(text, def.name);
        content = [
          ...result.content.filter((c) => c.type !== "text"),
          { type: "text", text: spillPreview(text, outputId, result.isError === true) },
        ];
      }
      return {
        ...result,
        content,
        details: {
          ...record(result.details),
          galaxy: { tool: def.name, ...(outputId === undefined ? {} : { outputId }), elapsedMs },
        },
      };
    },
  };
}

/** `outputSchema` for every in-process Galaxy tool: the envelope, as runWithEnvelope builds it. */
export const GALAXY_ENVELOPE_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    data: {},
    success: { type: "boolean" },
    message: { type: "string" },
    count: { type: ["integer", "null"] },
    pagination: { type: ["object", "null"] },
    errorKind: { type: "string" },
  },
  required: ["success"],
});
