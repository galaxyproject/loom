/**
 * Orbit — Galaxy co-scientist extension for Pi.dev.
 *
 * Brain-side runtime that supports markdown-driven Galaxy bioinformatics
 * analyses. The notebook (`notebook.md`) is the durable record; plans live
 * inside it as markdown sections; Galaxy invocations are tracked via
 * `loom-invocation` YAML blocks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPlanTools } from "./tools";
import { registerGalaxyUploadTool } from "./galaxy-upload";
import { withJsonStringArgs } from "./tool-args-json";
import { registerNotebookSyncTools } from "./tools-sync";
import { registerSyncCommand } from "./sync-command";
import { registerSkillsCommand } from "./skills-command";
import { setupContextInjection, formatConnectionStatus } from "./context";
import { setupUIBridge } from "./ui-bridge";
import { registerSessionLifecycle } from "./session-lifecycle";
import { registerCommandsAsUserInput } from "./auto-resume";
import { registerActivityHooks } from "./activity-hooks";
import { registerSubmissionCapture } from "./galaxy-submission-capture";
import { isSubmissionReplayEnabled, registerSubmissionReplay } from "./submission-replay";
import { isObservationReplayEnabled, registerObservationReplay } from "./observation-replay";
import { registerCaptureFollowThrough } from "./galaxy-reconcile";
import { isGalaxyFixtureEnabled, registerGalaxyFixture } from "./galaxy-fixture";
import { isModelScriptEnabled, registerModelScript } from "./model-script";
import { registerExecutionCommands } from "./execution-commands";
import { registerDashboardTools } from "./dashboard-tools";
import { registerDashboardCommands } from "./dashboard-commands";
import { registerFeedbackCommand } from "./feedback-command";
import { registerLessonProposals } from "./lesson-command";
import { registerLessonsCommand } from "./lessons-command";
import { registerTesterIdCommand } from "./tester-id-command";
import { registerInstructionsCommand } from "./instructions-command";
import { registerTeamTools } from "./teams/tool";
import { isTeamDispatchEnabled } from "./teams/is-enabled";
import { registerSessionIndexTools } from "./session-index/tools";
import { isSessionIndexEnabled } from "./session-index/is-enabled";
import { registerSkillTriggers } from "./skill-triggers";
import { registerIwcPlanCheck } from "./iwc-plan-check";
import { registerEmptyCompletionCheck } from "./empty-completion";
import { registerSraImportGate } from "./sra-import-gate";
import { registerGalaxyRepeatGuard } from "./galaxy-repeat-guard";
import { registerGalaxyHistoryGuard } from "./galaxy-history-guard";
import { registerEvidenceGate } from "./evidence-gate";
import { registerEvidenceOverrideCommand } from "./evidence-override-command";
import { registerProposalCommands } from "./proposal-commands";
import { registerExecGuard } from "./exec-guard";
import { registerSandbox } from "./sandbox";
import { isLocalExecDisabled } from "./local-exec";
import { capabilityProfile } from "../../shared/capability-profile.js";
import { galaxyCredentials } from "./galaxy-api";
import { registerSecretRedaction } from "./secret-redaction";
import { registerLessonHint } from "./lesson-hint";
import { registerLessonsSearchTool } from "./lessons/search-tool";
import { isLessonReplayEnabled, registerLessonReplay } from "./lessons/replay";
import { registerObservationTriggers } from "./observation-triggers";
import { registerObservationsCommand } from "./observations-command";
import { registerMcpOutputRecovery } from "./mcp-output";
import { registerOrbitMcpServers } from "./mcp-servers";
import { registerGalaxyVersionCapture } from "./galaxy-version-capture";
import type { GalaxyToolFamily } from "../../shared/galaxy-tool-family.js";
import { registerGalaxyTools } from "./galaxy-tool-source";
import { registerGalaxyDestructiveGate } from "./galaxy-destructive-gate";
import { registerGalaxyOpPolicy } from "./galaxy-op-policy";
import { registerGalaxyRecovery } from "./galaxy-recovery";
import { registerGalaxyPollGuard } from "./galaxy-poll-guard";
import { registerProgressUpdates } from "./progress-updates";
import { recordStore } from "./record-store";
import {
  getState,
  getNotebookPath,
  getNotebookWidgetMode,
  setNotebookWidgetMode,
  reemitNotebookIfChanged,
} from "./state";
import {
  loadProfiles,
  saveProfile,
  switchProfile,
  profileNameFromUrl,
  normalizeGalaxyUrl,
} from "./profiles";
import { OrbitWidgetKey, encodeMarkdownWidget } from "../../shared/orbit-shell-contract.js";

/** Status-bar label for a Galaxy tool -- galaxy-ops' or Orbit's own -- else undefined. */
function galaxyToolLabel(
  toolName: string | undefined,
  family: GalaxyToolFamily,
): string | undefined {
  const bare = family.toolName(toolName) ?? toolName?.match(/^galaxy_(.+)/)?.[1];
  return bare?.replace(/_/g, " ");
}

export default function galaxyAnalystExtension(pi: ExtensionAPI): void {
  // Before anything registers a command, so every one of them counts as user
  // input for the automatic follow-up cap.
  registerCommandsAsUserInput(pi);
  // Likewise before any tool: weaker models send object and array arguments as JSON text, and
  // pi's schema check would refuse every such call.
  withJsonStringArgs(pi);
  const profile = capabilityProfile();
  // The shell's Galaxy tools go in first, so every guard below is handed their names.
  const family = registerGalaxyTools(pi);
  // Local-execution safety gate + opt-in bash sandbox. Both only make sense
  // when the brain has a local execution surface. A shell that runs the brain
  // with no local exec -- the web/container remote shell (and eventually native
  // Windows remote-only) -- sets LOOM_LOCAL_EXEC=off and supplies its own
  // authoritative tool_call gate (web-mode-gate). Registering exec-guard there
  // is redundant, and its interactive approval prompts have no human to answer
  // in a headless container, so they would hang the agent on the first gated
  // action. Skipping both keeps the shell's gate the single tool_call authority.
  // Shells WITH a local exec surface (desktop, CLI) set LOOM_LOCAL_EXEC
  // authoritatively at spawn so an ambient value can't toggle this off here.
  if (profile.files) {
    // Register the gate first so its tool_call decision is the authoritative
    // boundary before anything else runs.
    registerExecGuard(pi);
    // The opt-in bash sandbox layers an OS sandbox UNDER the gate (the gate still
    // decides allow/ask/deny; the sandbox only contains an allowed command's blast
    // radius). Default-on file-write confinement lives in the gate itself.
    registerSandbox(pi);
  }
  // exec-guard confirms a history delete only where it is registered (a files
  // surface), and never reads galaxy-ops' destructiveHint, so the Galaxy tools
  // get their own confirm; with files, exec-guard keeps update_history and this
  // one asks only about the hinted tools. The remote container says LOCAL_EXEC=off
  // in env, and its web-mode-gate refuses a history delete outright, so asking
  // first would only ask about a call it then blocks.
  registerGalaxyDestructiveGate(pi, family, {
    classifyArgs: !profile.files && !isLocalExecDisabled(process.env),
  });
  registerGalaxyOpPolicy(pi);
  // Data-shaped backstop to the path-shaped gate: scrub known secret VALUES out
  // of tool OUTPUT before it returns to the model, so an approved/slipped read
  // (or an `env` dump) can't push API keys into the provider's logs (#183).
  // Passive and prompt-free, so it stays on even when a remote shell owns the
  // tool_call boundary and the gate above is skipped.
  // Inspect saved MCP output before redaction so its previews receive the same
  // secret scrubbing as ordinary tool results (including in remote shells).
  // Only pi's MCP layer truncates to a file, so it goes wherever an MCP server
  // does: that is brc-analytics, and the Galaxy tools keep their own
  // galaxy_read_output.
  if (profile.mcpServers) registerMcpOutputRecovery(pi, family);
  registerGalaxyRecovery(pi, family);
  registerGalaxyPollGuard(pi, family);
  registerProgressUpdates(pi, family);
  registerSecretRedaction(pi);
  // AFTER redaction, deliberately. pi runs tool_result handlers in
  // registration order and each sees the previous one's rewrite, so the
  // collector reads the content the model actually gets -- reading the raw
  // result would put an API key one normalization away from the wire.
  registerObservationTriggers(pi, family);
  // After the triggers, whose session_start forgets the last session's version.
  registerGalaxyVersionCapture(pi, family);
  // AFTER redaction and after the observation triggers. pi feeds each
  // tool_result handler the previous one's content, so anything registered
  // after the hint reads it as part of the result -- a Galaxy error with no
  // text of its own would get Orbit's hint as its error signature (the triggers
  // also drop hint blocks themselves, so this is the first line of defence).
  // Lesson text is redacted where it is rendered, so it needs nothing from the
  // redactor. After the oversized-output recovery, so it lands after the
  // preview the model actually reads.
  registerLessonHint(pi);

  // brc-analytics is the one MCP server Orbit brings; a shell with no MCP layer
  // at all (the browser worker) says so with mcpServers.
  if (profile.mcpServers) registerOrbitMcpServers(pi);

  setupUIBridge(pi);
  registerSessionLifecycle(pi);
  registerActivityHooks(pi);
  // Auto-registration of Galaxy submissions. Mode-independent on purpose: it
  // must not live inside the exec-guard, which is skipped entirely when
  // LOOM_LOCAL_EXEC=off (the web/container shell), and capture has to work
  // there too. Registered after the session lifecycle so the notebook path is
  // already set by the time anything can fire.
  registerSubmissionCapture(pi, family);
  // Eval-only seam: replays recorded submission results through the hook above
  // so the Tier-1 scenarios can pin capture behavior without a model. Off
  // unless LOOM_SUBMISSION_REPLAY names a file inside the session directory.
  if (isSubmissionReplayEnabled()) {
    registerSubmissionReplay(pi);
  }
  // The same eval-only seam for the lesson hint, which fires on tool_result and
  // so needs a model turn that Tier-1 scenarios don't have.
  if (isLessonReplayEnabled()) {
    registerLessonReplay(pi);
  }
  // Eval-only seam, same shape and the same containment rule as the submission
  // replay above. Registered here rather than with the triggers because its
  // session_start handler needs the notebook path the session lifecycle sets.
  if (isObservationReplayEnabled()) {
    registerObservationReplay(pi);
  }
  // ── Capture, part two (#473): reconcile + enrichment ──────────────────────
  // Everything that happens to a recorded run after the submit: reconcile on
  // session start, every Nth poller tick and on /reconcile; per-job enrichment
  // off the same queue. After the replay seam so a replayed session's blocks
  // are on disk before the first reconcile.
  // Provenance records and the reconcile cursor go through the provenance fs
  // (galaxy-provenance.ts), which is in memory under a page notebook, so this
  // registers under every profile.
  registerCaptureFollowThrough(pi);
  // Eval-only seam: answers Galaxy calls from a recorded fixture so the Tier-1
  // scenarios can drive reconcile and enrichment without a server. Off unless
  // LOOM_GALAXY_FIXTURE names a file inside the session directory.
  if (isGalaxyFixtureEnabled()) {
    registerGalaxyFixture(pi);
  }
  // Eval-only seam: a scripted model, so a Tier-1 scenario can make the tool
  // calls a model would and pi's own tool_call path decides them. Off unless
  // LOOM_MODEL_SCRIPT is set; the file it names must be inside the session
  // directory, and while it's set the session never reaches a real model.
  if (isModelScriptEnabled()) {
    registerModelScript(pi);
  }
  // ── end capture, part two ─────────────────────────────────────────────────

  registerPlanTools(pi, family);
  // Uploads a LOCAL file; without a file surface there is nothing to upload.
  if (profile.files) {
    registerGalaxyUploadTool(pi, family);
  }
  registerNotebookSyncTools(pi, family);
  registerSyncCommand(pi);
  registerSkillsCommand(pi);
  registerExecutionCommands(pi);
  // The terminal registers these because it writes the layout file for the
  // next desktop session; a worker has neither a file nor a pane to show it in.
  // Two ifs, not one block, so the tool order between them does not move.
  if (profile.ui !== "worker") {
    registerDashboardTools(pi);
  }
  registerLessonsSearchTool(pi);
  if (profile.ui !== "worker") {
    registerDashboardCommands(pi);
  }
  registerFeedbackCommand(pi);
  registerObservationsCommand(pi);
  registerLessonProposals(pi);
  registerLessonsCommand(pi);
  registerTesterIdCommand(pi);
  registerInstructionsCommand(pi);
  registerSkillTriggers(pi, family);
  registerIwcPlanCheck(pi, family);
  registerEmptyCompletionCheck(pi);
  registerEvidenceGate(pi, family);
  registerSraImportGate(pi, family);
  registerGalaxyRepeatGuard(pi, family);
  registerGalaxyHistoryGuard(pi, family);
  registerEvidenceOverrideCommand(pi);
  // ── Approval registry (#476): the model proposes with loom_propose; the user
  // approves with /approve (or revokes, or lists with /pending). The registry
  // itself is opened and closed by the session lifecycle.
  registerProposalCommands(pi);
  // ── end approval registry
  if (isTeamDispatchEnabled()) {
    registerTeamTools(pi);
  }
  if (isSessionIndexEnabled()) {
    registerSessionIndexTools(pi);
  }

  setupContextInjection(pi);

  // ─────────────────────────────────────────────────────────────────────────────
  // /connect — Galaxy connection with profile support
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerCommand("connect", {
    description:
      "Connect to Galaxy server. Use /connect to pick a profile or add a new one, /connect <name> to switch.",
    handler: async (args, ctx) => {
      // In a curated remote shell (no local exec) the Galaxy connection is pinned
      // to operator-injected env; the user must not repoint it or overwrite the
      // injected key. Slash commands are dispatched from browser input before the
      // model runs and bypass the tool_call gate, so guard here -- without it a
      // remote client could /connect to an attacker host or a cloud-metadata URL
      // (SSRF) and overwrite GALAXY_URL/GALAXY_API_KEY in-process.
      if (isLocalExecDisabled()) {
        ctx.ui.notify(
          "Galaxy connection is managed by the host in remote mode and can't be changed here.",
          "info",
        );
        return;
      }
      const { profiles, active } = loadProfiles();
      const profileNames = Object.keys(profiles);
      const current = galaxyCredentials();

      // The Galaxy tools read the credentials on every call, so setting the env is the whole
      // switch; the reload resets what this session holds about the old server, such as its
      // current history. Every shell that reaches here has a reload: the only
      // command ctx without one is the browser's, which has no files and returned above.
      const reloadSession = () => ctx.reload();

      const requestedName = args?.trim();
      if (requestedName) {
        if (switchProfile(requestedName)) {
          ctx.ui.notify(`Switched to ${requestedName} (${profiles[requestedName].url})`, "info");
          await reloadSession();
        } else {
          ctx.ui.notify(
            `Unknown profile "${requestedName}". Use /profiles to see available profiles.`,
            "warning",
          );
        }
        return;
      }

      if (profileNames.length > 1) {
        const choices = profileNames.map((name) => {
          const marker = name === active ? "* " : "  ";
          return `${marker}${name} (${profiles[name].url})`;
        });
        choices.push("  Add new server...");

        const selection = await ctx.ui.select("Select Galaxy server", choices);
        if (selection === undefined || selection === null) {
          ctx.ui.notify("Connection cancelled", "warning");
          return;
        }

        const selectedIndex =
          typeof selection === "number" ? selection : choices.indexOf(selection);

        if (selectedIndex >= 0 && selectedIndex < profileNames.length) {
          const name = profileNames[selectedIndex];
          switchProfile(name);
          ctx.ui.notify(`Switched to ${name} (${profiles[name].url})`, "info");
          await reloadSession();
          return;
        }
      } else if (profileNames.length === 1 && active && current.url && current.apiKey) {
        ctx.ui.notify(`Connecting to ${current.url}...`, "info");
        await reloadSession();
        return;
      }

      const galaxyUrlInput = await ctx.ui.input("Galaxy Server URL", "https://usegalaxy.org");
      if (!galaxyUrlInput) {
        ctx.ui.notify("Connection cancelled", "warning");
        return;
      }
      // Accept a bare host ("test.galaxyproject.org") by defaulting to https://
      // instead of rejecting it as an invalid URL.
      const galaxyUrl = normalizeGalaxyUrl(galaxyUrlInput);

      ctx.ui.notify(
        "To get your API key: Log into Galaxy → User → Preferences → Manage API Key",
        "info",
      );
      const apiKey = await ctx.ui.input("Galaxy API Key");
      if (!apiKey) {
        ctx.ui.notify("Connection cancelled - API key required", "warning");
        return;
      }

      const name = profileNameFromUrl(galaxyUrl);
      saveProfile(name, galaxyUrl, apiKey);

      process.env.GALAXY_URL = galaxyUrl;
      process.env.GALAXY_API_KEY = apiKey;

      ctx.ui.notify(`Saved profile "${name}" and connecting to ${galaxyUrl}...`, "info");
      await reloadSession();
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // /profiles — list saved Galaxy server profiles
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerCommand("profiles", {
    description: "List saved Galaxy server profiles",
    handler: async (_args, ctx) => {
      const { profiles, active } = loadProfiles();
      const names = Object.keys(profiles);

      if (names.length === 0) {
        ctx.ui.notify("No saved profiles. Use /connect to add one.", "info");
        return;
      }

      const lines: string[] = ["Galaxy Server Profiles", ""];
      for (const name of names) {
        const marker = name === active ? "*" : " ";
        lines.push(`  ${marker} ${name} (${profiles[name].url})`);
      }
      lines.push("");
      lines.push("Use /connect <name> to switch, or /connect to add a new server.");

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // /status — Galaxy connection + notebook path
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerCommand("status", {
    description: "Show Galaxy connection and notebook status",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      lines.push("🔬 Orbit Status");
      lines.push("");
      for (const line of formatConnectionStatus(ctx)) {
        lines.push(line);
      }

      lines.push("");
      const notebookPath = getNotebookPath();
      if (notebookPath) {
        lines.push(`📓 Notebook: ${notebookPath}`);
      } else {
        lines.push("📓 No notebook (cwd has no notebook.md)");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // /notebook — view current notebook content
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerCommand("notebook", {
    description: "Toggle the notebook panel",
    handler: async (_args, ctx) => {
      // Open → close. Marks "hidden" so the panel doesn't auto-reopen on the
      // next notebook write (see ui-bridge); a second /notebook reopens it.
      if (getNotebookWidgetMode() === "open") {
        ctx.ui.setWidget(OrbitWidgetKey.Notebook, undefined);
        setNotebookWidgetMode("hidden");
        return;
      }
      const notebookPath = getNotebookPath();
      const store = notebookPath ? recordStore(notebookPath) : null;
      if (store && (await store.stat()) !== null) {
        try {
          const { content } = await store.read();
          const header = `> \`${store.label}\`\n\n`;
          ctx.ui.setWidget(OrbitWidgetKey.Notebook, encodeMarkdownWidget(header + content));
          setNotebookWidgetMode("open");
        } catch (err) {
          ctx.ui.notify(`Failed to read notebook: ${err}`, "error");
        }
        return;
      }
      ctx.ui.notify(
        "No notebook in cwd. A new notebook.md is created automatically on session start.",
        "info",
      );
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // /compact — manually compact the conversation to reclaim context
  // ─────────────────────────────────────────────────────────────────────────────
  // Guards a second Orbit /compact from racing the first: pi's compact() has no
  // internal concurrency guard (it just resets its abort controller), so a
  // concurrent call orphans the in-flight run. This only covers Orbit-initiated
  // compactions -- pi's own auto-compaction isn't observable from an extension
  // (ExtensionContext exposes no isCompacting), so that race is left to pi.
  // Cleared in both completion callbacks and on a synchronous compact() throw.
  let compactionInFlight = false;
  pi.registerCommand("compact", {
    description:
      "Compact the conversation to free up context. Optional: /compact <instructions> to steer the summary.",
    handler: async (args, ctx) => {
      // No UI (e.g. headless RPC consumers) -> skip notifications; still compact.
      // Wrapped because ctx.ui/hasUI assert an active context and can throw if the
      // session was swapped while a compaction was in flight; a dropped toast is fine.
      const notify = (msg: string, level: "info" | "warning" | "error") => {
        try {
          if (ctx.hasUI) ctx.ui.notify(msg, level);
        } catch {
          /* stale context after a session swap -- nothing to show */
        }
      };

      if (compactionInFlight) {
        notify("A compaction is already running.", "warning");
        return;
      }

      const before = ctx.getContextUsage();
      const beforeStr = before?.tokens != null ? `${before.tokens.toLocaleString()} tokens` : "?";
      // The notebook is the durable record (snapshotted on session_before_compact),
      // so the summary can drop verbose tool chatter without losing project state.
      const customInstructions =
        args.trim() ||
        "Preserve the current analysis plan, decisions, and Galaxy invocation state. " +
          "Verbose tool outputs and dataset previews can be dropped — the notebook holds the durable record.";

      compactionInFlight = true;
      notify(`Compacting (was ${beforeStr})…`, "info");
      try {
        ctx.compact({
          customInstructions,
          onComplete: (result) => {
            compactionInFlight = false;
            // getContextUsage() reads null right after compaction (pi only learns the
            // new size on the next model response), so report the authoritative
            // before-count from the result; the footer shows the new size next turn.
            notify(
              `✅ Compacted (was ${result.tokensBefore.toLocaleString()} tokens). New size shows after the next turn.`,
              "info",
            );
          },
          onError: (err) => {
            compactionInFlight = false;
            notify(`Compaction failed: ${err.message}`, "error");
          },
        });
      } catch (err) {
        // ctx.compact() asserts an active context synchronously and can throw
        // before either callback runs; reset the guard so /compact isn't wedged.
        compactionInFlight = false;
        notify(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool execution lifecycle: show status when Galaxy tools run
  // ─────────────────────────────────────────────────────────────────────────────
  const toolStartTimes = new Map<string, number>();

  pi.on("tool_execution_start", async (event, ctx) => {
    const label = galaxyToolLabel(event.toolName, family);
    if (label) {
      toolStartTimes.set(event.toolName, Date.now());
      ctx.ui.setStatus("galaxy-tool", `🔧 Running ${label}...`);
    }
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    // Re-sync the Notebook panel after any tool. A bash write to notebook.md
    // can slip past the single-file watcher -- an atomic temp-and-rename save
    // (`sed -i`, editors) swaps the inode, and a plain truncate can race the
    // watcher's awaitWriteFinish window. This is content-guarded so it only
    // emits on a real change and is a no-op otherwise. #253
    await reemitNotebookIfChanged();

    const label = galaxyToolLabel(event.toolName, family);
    if (label) {
      const startTime = toolStartTimes.get(event.toolName);
      if (startTime) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        ctx.ui.setStatus("galaxy-tool", `✓ ${label} (${elapsed}s)`);
        toolStartTimes.delete(event.toolName);
        setTimeout(() => {
          // pi throws on a ctx captured before a reload or session switch (/connect,
          // /new); uncaught, that takes the whole brain down three seconds later.
          try {
            ctx.ui.setStatus("galaxy-tool", "");
          } catch {
            // The session that showed the label is gone, and its status with it.
          }
        }, 3000);
      } else {
        ctx.ui.setStatus("galaxy-tool", "");
      }
    }

    if (family.toolName(event.toolName) === "create_history" && !event.isError) {
      try {
        const resultText =
          typeof event.result === "string" ? event.result : JSON.stringify(event.result);
        const match = resultText.match(/"id":\s*"([^"]+)"/);
        if (match) {
          const state = getState();
          state.currentHistoryId = match[1];
        }
      } catch {
        /* ignore */
      }
    }
  });

  pi.on("tool_result", async (event) => {
    if (family.toolName(event.toolName) === "create_history") {
      try {
        const firstContent = event.content?.[0];
        const resultText = firstContent && "text" in firstContent ? firstContent.text : undefined;
        if (resultText) {
          const match = resultText.match(/"id":\s*"([^"]+)"/);
          if (match) {
            const state = getState();
            state.currentHistoryId = match[1];
          }
        }
      } catch {
        /* ignore */
      }
    }
  });
}
