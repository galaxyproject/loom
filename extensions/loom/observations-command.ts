/**
 * /observations and /observe -- the user's half of the collector.
 *
 * Both are deterministic: no model turn, no agent in the loop. /observations is
 * how someone sees what the collector is doing, changes their mind, reads back
 * what was sent, and deletes a row. /observe is the one trigger the user owns.
 *
 * Switching to `auto` for the first time shows a REAL sample payload built
 * from this install (its client, its server, and the most recent thing a
 * trigger actually saw when there is one) plus the privacy statement, and does
 * not take effect without a confirm. Everything here writes only the
 * `observations` block of the config, through the fail-closed writer.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  hasAcknowledgedAuto,
  isObservationsHardDisabled,
  markAutoAcknowledged,
  peekInstallToken,
  resolveObservationsMode,
  setObservationsMode,
} from "./observations-config.js";
import type { ObservationsMode } from "./observations-config.js";
import {
  SENT_LOG_FILE,
  appendSentLog,
  buildObservation,
  collectObservationEnvelope,
  forgetRetractToken,
  observationsFilePath,
  readRetractToken,
  readSentLog,
  removeFromObservationOutbox,
  retractObservation,
} from "./observations.js";
import type { ObservationFacts, ObservationSentEntry } from "./observations.js";
import {
  deliverObservation,
  lastObservationFacts,
  liveDeliverDeps,
  localWriteWarning,
} from "./observation-triggers.js";
import {
  PRIVACY_STATEMENT,
  PURPOSE_STATEMENT,
  renderObservationForConfirm,
} from "./observation-ui.js";
import { scanObservationForLeaks, validateObservation } from "../../shared/observation-contract.js";

export const OBSERVATIONS_USAGE =
  "Usage: /observations [status | mode <off|ask|auto> | sent | retract <id>]";

export function formatObservationsStatus(info: {
  mode: ObservationsMode;
  hardDisabled: boolean;
  hasToken: boolean;
  sentLogPath: string;
  counts: { sent: number; queued: number; retracted: number; cancelled: number };
}): string {
  const lines = [
    "Observations -- failure patterns reported back so they become lessons Loom surfaces to everyone",
    "",
    `  mode: ${info.mode}`,
  ];
  if (info.hardDisabled) {
    lines.push("  ORBIT_OBSERVATIONS=off is set, so collection is disabled for this install");
    lines.push("  and the mode can't be changed from here.");
  }
  lines.push(
    `  install token: ${info.hasToken ? "stored locally (not shown)" : "not generated yet"}`,
    `  ${info.counts.sent} sent, ${info.counts.queued} queued, ${info.counts.retracted} retracted, ${info.counts.cancelled} cancelled`,
    `  log: ${info.sentLogPath}`,
    "",
    "  off  -- collect nothing",
    "  ask  -- show the exact payload, error text and description included, and send only on a confirm (default)",
    "  auto -- send without asking, structured fields only: no error text, no description",
    "",
    OBSERVATIONS_USAGE,
  );
  return lines.join("\n");
}

/** Latest status per id, oldest first. One line each, with the id to retract by. */
export function sentLogSummary(rows: ObservationSentEntry[]): string {
  if (rows.length === 0) {
    return "Nothing has been sent yet. /observations status shows the current mode.";
  }
  const latest = new Map<string, ObservationSentEntry>();
  for (const row of rows) latest.set(row.id, row);
  const lines = ["What this install has sent (newest last):", ""];
  for (const row of latest.values()) {
    lines.push(
      `  ${row.at}  ${row.status.padEnd(9)} ${row.kind.padEnd(18)} ${row.id}`,
      `      ${row.signature}`,
    );
    if (row.description) lines.push(`      ${row.description}`);
  }
  lines.push("", "Delete a sent one, or cancel a queued one, with /observations retract <id>.");
  return lines.join("\n");
}

// The confirm never prints the token, so the sample doesn't need the real one
// -- and building it shouldn't write a token to disk before the user says yes.
const SAMPLE_INSTALL_TOKEN = "0".repeat(32);

const REPRESENTATIVE_FACTS: ObservationFacts = {
  kind: "tool-error",
  trigger: "tool_error",
  mcpTool: "galaxy_run_tool",
  toolIds: ["toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2"],
  datatypes: ["fastqsanger.gz"],
  rawSignature: "ToolExecutionError: input dataset is in state 'error'",
};

/**
 * A sample that is honest about this install. When a trigger has already seen
 * something this session that is what gets shown -- but only if it would
 * actually be sent; a refused one would show the user text that never leaves
 * the machine. Otherwise a representative signature carries the same real
 * client and server fields.
 */
export function sampleObservationFacts(): ObservationFacts {
  const last = lastObservationFacts();
  if (last) {
    const probe = buildObservation(
      last,
      collectObservationEnvelope(SAMPLE_INSTALL_TOKEN),
      "structured",
    );
    if (validateObservation(probe).ok && scanObservationForLeaks(probe).length === 0) return last;
  }
  return REPRESENTATIVE_FACTS;
}

export async function confirmAutoMode(ctx: ExtensionContext): Promise<boolean> {
  // The auto shape: the sample has to show what auto actually sends, which is
  // the structured fields with no signature text and no description.
  const sample = buildObservation(
    sampleObservationFacts(),
    collectObservationEnvelope(peekInstallToken() ?? SAMPLE_INSTALL_TOKEN),
    "structured",
  );
  try {
    return await ctx.ui.confirm(
      "Send observations automatically from now on?",
      `${PURPOSE_STATEMENT}\n\n` +
        "This is exactly what one looks like in auto mode -- the same fields, from this " +
        "install. The error text is never sent in auto, so the signature is always " +
        "`unknown` and there is no description:\n\n" +
        `${renderObservationForConfirm(sample)}\n\n${PRIVACY_STATEMENT}`,
    );
  } catch {
    return false;
  }
}

async function showStatus(ctx: ExtensionContext): Promise<void> {
  const rows = readSentLog();
  const latest = new Map<string, ObservationSentEntry>();
  for (const row of rows) latest.set(row.id, row);
  const counts = { sent: 0, queued: 0, retracted: 0, cancelled: 0 };
  for (const row of latest.values()) {
    if (row.status in counts) counts[row.status] += 1;
  }
  ctx.ui.notify(
    formatObservationsStatus({
      mode: resolveObservationsMode(),
      hardDisabled: isObservationsHardDisabled(),
      hasToken: peekInstallToken() !== undefined,
      sentLogPath: observationsFilePath(SENT_LOG_FILE),
      counts,
    }),
    "info",
  );
}

async function changeMode(ctx: ExtensionContext, requested: string): Promise<void> {
  if (requested !== "off" && requested !== "ask" && requested !== "auto") {
    ctx.ui.notify(`Unknown mode "${requested}".\n${OBSERVATIONS_USAGE}`, "warning");
    return;
  }
  // Turning collection ON is the one transition that needs the payload shown
  // first, and a shell with no dialog can't show it.
  if (requested === "auto" && !hasAcknowledgedAuto()) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Switching to auto needs interactive mode -- it shows you a real sample payload first. Re-run it in Orbit or an interactive CLI session.",
        "warning",
      );
      return;
    }
    if (!(await confirmAutoMode(ctx))) {
      ctx.ui.notify("Left as is. Nothing was changed.", "info");
      return;
    }
    markAutoAcknowledged();
  }
  try {
    setObservationsMode(requested);
  } catch (err) {
    // setObservationsMode only throws messages it authored.
    ctx.ui.notify(err instanceof Error ? err.message : "Couldn't change the mode.", "error");
    return;
  }
  ctx.ui.notify(`Observations mode is now ${requested}.`, "info");
}

/** A follow-up sent-log row for `id`, carrying over what the log already had. */
function sentLogRowFor(id: string, status: "retracted" | "cancelled"): ObservationSentEntry {
  const previous = readSentLog().find((r) => r.id === id);
  return {
    at: new Date().toISOString(),
    id,
    status,
    kind: previous?.kind ?? "other",
    stage: previous?.stage ?? "unknown",
    trigger: previous?.trigger ?? "explicit",
    signature: previous?.signature ?? "",
    tools: previous?.tools ?? [],
    ...(previous?.mcpTool ? { mcpTool: previous.mcpTool } : {}),
    datatypes: previous?.datatypes ?? [],
    server: previous?.server ?? "private",
    description: previous?.description ?? "",
  };
}

async function doRetract(ctx: ExtensionContext, id: string): Promise<void> {
  if (!id) {
    ctx.ui.notify(`Which one?\n${OBSERVATIONS_USAGE}`, "warning");
    return;
  }
  const token = readRetractToken(id);
  if (!token) {
    // No token means it was never accepted by the service -- but it may still
    // be sitting in the outbox, due to go on the next settle. Take it out.
    const removal = removeFromObservationOutbox(id);
    if (removal === "removed") {
      appendSentLog(sentLogRowFor(id, "cancelled"));
      ctx.ui.notify(`Cancelled ${id}. It was still queued, and now it will never be sent.`, "info");
      return;
    }
    if (removal === "busy") {
      ctx.ui.notify(
        `Queued observations are being sent right now, so ${id} can't be cancelled this moment. Try again shortly.`,
        "warning",
      );
      return;
    }
    if (removal === "failed") {
      ctx.ui.notify(
        `Couldn't update the local outbox to cancel ${id}, so nothing was changed. Check that the Loom state directory is writable.`,
        "error",
      );
      return;
    }
    ctx.ui.notify(
      `There is no retract token stored for "${id}", and it isn't queued. /observations sent lists the ids this install can still retract.`,
      "warning",
    );
    return;
  }
  const res = await retractObservation(id, token);
  if (!res.ok) {
    ctx.ui.notify(
      `Couldn't reach the service to retract ${id} (${res.error ?? `status ${res.status}`}). The token is kept, so try again later.`,
      "error",
    );
    return;
  }
  forgetRetractToken(id);
  // A row that was sent but whose outbox rewrite never happened (lock
  // contention, a crash mid-drain) would otherwise go again on the next drain
  // -- and after a retract the service would accept it as new.
  const leftover = removeFromObservationOutbox(id);
  appendSentLog(sentLogRowFor(id, "retracted"));
  ctx.ui.notify(
    (res.alreadyGone ? `${id} was already gone -- nothing is stored.` : `Retracted ${id}.`) +
      (leftover === "busy" || leftover === "failed"
        ? " A copy may still be queued locally; run the same retract again to cancel it."
        : ""),
    "info",
  );
}

const OBSERVE_CHOICES = [
  "something the agent got wrong",
  "a result that looked fine but was wrong",
] as const;

async function doObserve(args: string | undefined, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "/observe needs interactive mode. Re-run it in Orbit or an interactive CLI session.",
      "warning",
    );
    return;
  }
  if (resolveObservationsMode() === "off") {
    ctx.ui.notify(
      "Observations are off, so there is nowhere to send this. /observations mode ask turns them on.",
      "info",
    );
    return;
  }
  const note =
    (args && args.trim()) ||
    (
      await ctx.ui.input("What went wrong? (one line, generic -- no ids, paths or names)")
    )?.trim() ||
    "";
  if (!note) return;

  const chosen = await ctx.ui.select("What kind of problem is this?", [...OBSERVE_CHOICES]);
  if (chosen === undefined || chosen === null) return;
  const kind = chosen === OBSERVE_CHOICES[1] ? "silent-wrong-result" : "user-correction";

  const last = lastObservationFacts();
  const facts: ObservationFacts = {
    kind,
    // The user asked for this explicitly; nothing here was inferred from their
    // words. `user_correction` stays reserved in the contract for an automatic
    // detector, which nothing here builds on purpose.
    trigger: "explicit",
    ...(last?.mcpTool ? { mcpTool: last.mcpTool } : {}),
    toolIds: last?.toolIds ?? [],
    datatypes: last?.datatypes ?? [],
    rawSignature: note,
  };

  // Always the ask path, whatever the mode: the user typed a sentence and
  // should see what it normalized to before it goes, and the description is
  // theirs to write rather than a model call's.
  const outcome = await deliverObservation(facts, ctx, liveDeliverDeps("ask"));
  const warning = localWriteWarning(outcome);
  if (outcome === "sent") ctx.ui.notify("Thanks -- that was sent.", "info");
  else if (warning) ctx.ui.notify(warning, "warning");
  else if (outcome === "queued")
    ctx.ui.notify("Saved locally; it'll go when the service is reachable.", "warning");
  else if (outcome === "skipped")
    ctx.ui.notify(
      "Nothing was sent: observations were turned off before it went, or this session has already sent its share.",
      "info",
    );
  else if (outcome === "invalid")
    ctx.ui.notify(
      "That couldn't be sent safely -- it looked like it carried an id, path or address. Nothing was sent.",
      "warning",
    );
}

export function registerObservationsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("observations", {
    description:
      "Show or change automatic Galaxy-failure reporting. Subcommands: status | mode <off|ask|auto> | sent | retract <id>.",
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "").toLowerCase();
      try {
        if (!sub || sub === "status") return await showStatus(ctx);
        if (sub === "mode") return await changeMode(ctx, (parts[1] ?? "").toLowerCase());
        if (sub === "sent") {
          ctx.ui.notify(sentLogSummary(readSentLog()), "info");
          return;
        }
        if (sub === "retract") return await doRetract(ctx, parts[1] ?? "");
        ctx.ui.notify(
          `Unknown /observations subcommand: ${sub}.\n${OBSERVATIONS_USAGE}`,
          "warning",
        );
      } catch (err) {
        ctx.ui.notify(
          `/observations ${sub}: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("observe", {
    description:
      "Report that the agent or Galaxy got something wrong, as one generic line. You see the payload before it goes.",
    handler: doObserve,
  });
}
