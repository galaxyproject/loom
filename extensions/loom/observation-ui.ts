/**
 * Putting an observation in front of a human, and the `ask`-mode description
 * the human writes.
 *
 * The confirm shows the EXACT payload, field by field, because "we send
 * structured signals and a generic description" is a claim the user should be
 * able to check rather than take on trust -- the only value held back is the
 * install token, which is local state and is not something to invite anyone to
 * paste into a bug report.
 *
 * Only `ask` carries free text, because only `ask` has a human reading it
 * before it goes. `auto` sends the structured fields and nothing else, so no
 * model is ever asked to write a description. A description that fails
 * validation is dropped, never trimmed.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DESCRIPTION_MAX,
  textLeaks,
  validateObservation,
} from "../../shared/observation-contract.js";
import type { Observation } from "../../shared/observation-contract.js";
import type { ObservationsMode } from "./observations-config.js";

/**
 * Why anyone would say yes. The confirm leads with this because the privacy
 * statement alone reads like a cookie banner: it says what is withheld and
 * nothing about what the report is for.
 */
export const PURPOSE_STATEMENT =
  "Reports like this are how recurring problems get turned into lessons Loom surfaces " +
  "to everyone -- including you -- the next time it happens, and into fixes in Galaxy " +
  "and Loom.";

export const PRIVACY_STATEMENT =
  "Only the fields above are sent, to the Galaxy team's private intake queue, tied to " +
  "a random per-install token rather than any account or machine identity. In `ask` " +
  "mode the signature and description are shown to you in full and sent only if you " +
  "say yes; error text that still looks like it names a host, address, path or id " +
  "after scrubbing is withheld, and you are offered the rest. In `auto` mode no free text is sent at all -- no error text and no " +
  "description, only the structured fields; `/observe` always asks first, in any mode. " +
  "Never transcript text, data values, file " +
  "paths, history or dataset ids, or URLs. Rows expire after 180 days and " +
  "`/observations retract <id>` deletes one at any time. `/observations mode off` " +
  "stops collection entirely.";

// -----------------------------------------------------------------------------
// The confirm
// -----------------------------------------------------------------------------

function orNone(value: string): string {
  return value.length > 0 ? value : "(none)";
}

/** Pure, so the thing the user is shown is pinned by a test. */
export function renderObservationForConfirm(obs: Observation): string {
  const tools = obs.tools.map((t) => (t.version ? `${t.id} ${t.version}` : t.id)).join(", ");
  return [
    `kind: ${obs.kind}`,
    `stage: ${obs.stage}`,
    `trigger: ${obs.trigger}`,
    `signature: ${obs.signature}`,
    `description: ${orNone(obs.description)}`,
    `mcp tool: ${orNone(obs.mcpTool ?? "")}`,
    `galaxy tools: ${orNone(tools)}`,
    `datatypes: ${orNone(obs.datatypes.join(", "))}`,
    `galaxy server: ${obs.galaxy.server}${obs.galaxy.version ? ` (${obs.galaxy.version})` : ""}`,
    `client: ${obs.client.app} ${obs.client.version} ${obs.client.platform}${obs.client.wsl ? " (wsl)" : ""}`,
    `sent at: ${obs.clientTs}`,
    `id: ${obs.id}`,
    "install token: (32 random hex, stored locally, not shown)",
  ].join("\n");
}

export async function confirmObservation(
  obs: Observation,
  ctx: ExtensionContext,
  note?: string,
): Promise<boolean> {
  try {
    return await ctx.ui.confirm(
      "Send this observation to the Galaxy team?",
      `Loom hit something that looks like a failure pattern. ${PURPOSE_STATEMENT}\n\n` +
        (note ? `${note}\n\n` : "") +
        `${renderObservationForConfirm(obs)}\n\n${PRIVACY_STATEMENT}`,
    );
  } catch {
    // A stale context after a session swap, or a shell with no dialog. Either
    // way the answer is no.
    return false;
  }
}

// -----------------------------------------------------------------------------
// The description
// -----------------------------------------------------------------------------

/**
 * Accept a candidate description only if the contract would accept it. The
 * probe payload is a minimal legal observation with this description dropped
 * in, so the single source of truth for "is this text safe" stays the
 * validator rather than a second copy of its rules.
 */
export function acceptDescription(candidate: string): string {
  const whole = String(candidate ?? "");
  // Everything the user typed is scanned before any of it is cut: the cap and
  // the first-line rule can both drop the part of a leak a rule keys on.
  if (textLeaks(whole.replace(/\s+/g, " ")).length > 0) return "";
  const text = whole.split(/\r?\n/)[0].trim().slice(0, DESCRIPTION_MAX);
  if (!text || text === "NONE") return "";
  const probe = {
    schemaVersion: 1 as const,
    id: "00000000-0000-4000-8000-000000000000",
    clientTs: "2026-01-01T00:00:00.000Z",
    client: { app: "loom-cli" as const, version: "0", platform: "linux" as const },
    installToken: "0".repeat(32),
    kind: "other" as const,
    stage: "unknown" as const,
    trigger: "explicit" as const,
    tools: [],
    datatypes: [],
    signature: "unknown",
    galaxy: { server: "private" },
    description: text,
  };
  return validateObservation(probe).ok && textLeaks(text).length === 0 ? text : "";
}

/**
 * In `ask` mode the human writes it, because they are already being shown the
 * payload. One re-prompt on a rejection, then empty -- a third round of "that
 * still has an email address in it" is nagging.
 */
export async function askUserForDescription(
  obs: Observation,
  ctx: ExtensionContext,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string | undefined;
    try {
      raw = await ctx.ui.input(
        "One line about what went wrong (optional, generic -- no ids, paths or names)",
        // The built signature, not the raw facts: the prompt shows only what
        // already passed the builder.
        `signature: ${obs.signature}`,
      );
    } catch {
      return "";
    }
    if (!raw || !raw.trim()) return "";
    const accepted = acceptDescription(raw);
    if (accepted) return accepted;
    try {
      ctx.ui.notify(
        "That description looked like it carried an id, path, URL or address, so it was left blank. Try again, or press enter to skip.",
        "warning",
      );
    } catch {
      return "";
    }
  }
  return "";
}

export async function describeObservation(
  mode: ObservationsMode,
  obs: Observation,
  ctx: ExtensionContext,
): Promise<string> {
  // Only `ask` has a description. `auto` sends no free text, so there is
  // nothing to write and no model call to make.
  if (mode !== "ask" || !ctx.hasUI) return "";
  return askUserForDescription(obs, ctx);
}
