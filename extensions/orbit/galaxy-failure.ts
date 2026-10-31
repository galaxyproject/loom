/**
 * What kind of failure a Galaxy call was, read from the call itself rather than from its text.
 *
 * galaxy-ops reports a typed `errorKind` on the envelope, and the wrapper knows when its own
 * deadline fired, so the wrapper records the kind on `details.galaxy.kind` and the guards read
 * that first. A shell's extras record no kind, so their failures are read by their wording.
 */
import type { GalaxyErrorKind } from "@galaxyproject/galaxy-ops";
import type { GalaxyToolFamily } from "../../shared/galaxy-tool-family.js";
import { record } from "./galaxy-output";

// A dropped transport: the server is gone and a new connection fixes it.
const DROPPED_ERROR_PATTERNS: RegExp[] = [
  /not connected(?!\s+to\s+galaxy)/i, // bare SDK "Not connected"; exclude the verbose auth error
  /connection closed/i, // -32000, and pi's "MCP connection closed"
  /MCP client is (?:closed|connecting)/i, // pi: a call on a client that already went away
  /-32000/,
];

// A timeout proves only that no response arrived within the request budget.
// Narrow reads first; reconnect can help a wedge but not an oversized query.
const TIMEOUT_ERROR_PATTERNS: RegExp[] = [
  /request timed out/i, // -32001
  /-32001/,
];

/**
 * Which kind of failure this is, so callers can give advice that can work. `auth` and
 * `service_outage` come only from an in-process call's details; no text reads as either.
 */
export type GalaxyFailureKind = "dropped" | "timeout" | "auth" | "service_outage" | null;

/** The kind a failure's text reads as, for a result that recorded none. */
export function classifyGalaxyFailure(
  toolName: string | undefined,
  text: string | undefined,
  family: GalaxyToolFamily,
): Exclude<GalaxyFailureKind, "auth" | "service_outage"> {
  if (family.toolName(toolName) === undefined || !text) return null;
  // Timeout first: a -32001 body can also mention "not connected" downstream,
  // and the timeout reading is the actionable one.
  if (TIMEOUT_ERROR_PATTERNS.some((p) => p.test(text))) return "timeout";
  if (DROPPED_ERROR_PATTERNS.some((p) => p.test(text))) return "dropped";
  return null;
}

/** A failure kind the recovery guidance has advice for. */
export type GalaxyCallKind = Exclude<GalaxyFailureKind, null>;

// Keeps "request timed out", so a reader that only has the text still sees a timeout.
export const GALAXY_DEADLINE_TEXT =
  "Galaxy request timed out after 300 seconds. Its result is unknown; this does not mean a Galaxy job failed.";

/**
 * The recovery kind behind galaxy-ops' own error kind. Only a request that never got an answer
 * (`connection`), one Galaxy refused for its credentials (`auth`) and one a hosted transport found
 * the service down for (`service_outage`, ours, not galaxy-ops') have recovery advice; a not-found
 * or a validation failure is the model's to read and fix.
 */
export function kindOfEnvelope(
  errorKind: GalaxyErrorKind | string | undefined,
): "dropped" | "auth" | "service_outage" | undefined {
  if (errorKind === "connection") return "dropped";
  if (errorKind === "auth") return "auth";
  if (errorKind === "service_outage") return "service_outage";
  return undefined;
}

/**
 * `details.galaxy.kind` when an in-process call recorded one, else the text classifier's reading.
 * A failed in-process op always records the key, null when its errorKind has no recovery advice:
 * Galaxy's own message can quote a wire phrase ("request timed out") the text classifier would
 * misread. Only a shell's extras, which record no kind, are read by their text.
 */
export function galaxyFailureKind(
  details: unknown,
  text: string | undefined,
  toolName: string | undefined,
  family: GalaxyToolFamily,
): GalaxyFailureKind {
  const galaxy = record(record(details)?.galaxy);
  if (galaxy && "kind" in galaxy) {
    return typeof galaxy.kind === "string" ? (galaxy.kind as GalaxyCallKind) : null;
  }
  return classifyGalaxyFailure(toolName, text, family);
}

/**
 * The first string `code` down an error's cause chain, or an AggregateError's first error's.
 * undici hides why a request failed on `cause` and galaxy-ops keeps only `.message`, so this is
 * the one place a connect timeout and a refused connection still differ.
 */
export function transportCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 6; depth++) {
    const { code, errors, cause } = cur as { code?: unknown; errors?: unknown; cause?: unknown };
    if (typeof code === "string" && code) return code;
    const first = Array.isArray(errors) ? (errors[0] as { code?: unknown } | undefined) : undefined;
    if (typeof first?.code === "string" && first.code) return first.code;
    cur = cause;
  }
  return undefined;
}
