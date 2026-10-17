/**
 * What kind of failure an in-process Galaxy call was, read from the call itself rather than from
 * its text.
 *
 * pi's MCP client only ever handed back a string, so `galaxy-transport-error.ts` has to recognise
 * a dropped transport or a timeout by its wording. galaxy-ops reports a typed `errorKind` on the
 * envelope, and the wrapper knows when its own deadline fired, so the wrapper records the kind on
 * `details.galaxy.kind` and the guards read that first. MCP results never carry `details.galaxy`,
 * so their classification is the text classifier's, unchanged.
 */
import type { GalaxyErrorKind } from "@galaxyproject/galaxy-ops";
import { classifyGalaxyFailure, type GalaxyFailureKind } from "./galaxy-transport-error";
import { MCP_FAMILY, type GalaxyToolFamily } from "../../shared/galaxy-mcp-tools.js";
import { record } from "./galaxy-output";

/** A failure kind the recovery guidance has advice for. */
export type GalaxyCallKind = Exclude<GalaxyFailureKind, null>;

// Keeps "request timed out", so a reader that only has the text still sees a timeout.
export const GALAXY_DEADLINE_TEXT =
  "Galaxy request timed out after 300 seconds. Its result is unknown; this does not mean a Galaxy job failed.";

/**
 * The recovery kind behind galaxy-ops' own error kind. Only a request that never got an answer
 * (`connection`) or one Galaxy refused for its credentials (`auth`) has recovery advice; a
 * not-found or a validation failure is the model's to read and fix.
 */
export function kindOfEnvelope(
  errorKind: GalaxyErrorKind | string | undefined,
): "dropped" | "auth" | undefined {
  if (errorKind === "connection") return "dropped";
  if (errorKind === "auth") return "auth";
  return undefined;
}

/**
 * `details.galaxy.kind` when an in-process call recorded one, else the text classifier's reading.
 * A failed in-process op always records the key, null when its errorKind has no recovery advice:
 * Galaxy's own message can quote a wire phrase ("request timed out") the text classifier would
 * misread. Only MCP results and a shell's extras, which record no kind, are read by their text.
 */
export function galaxyFailureKind(
  details: unknown,
  text: string | undefined,
  toolName: string | undefined,
  family: GalaxyToolFamily = MCP_FAMILY,
): GalaxyFailureKind {
  const galaxy = record(record(details)?.galaxy);
  if (galaxy && "kind" in galaxy) {
    return typeof galaxy.kind === "string" ? (galaxy.kind as GalaxyCallKind) : null;
  }
  return classifyGalaxyFailure(toolName, text, family);
}
