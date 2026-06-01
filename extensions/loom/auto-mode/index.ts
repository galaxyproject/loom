import * as os from "os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { loadGuardianConfig, resolveAutoMode } from "../exec-guard/guardian-config";
import { isAutoSandboxActive, setAutoSandboxActive } from "../exec-guard/runtime-state";
import { buildSandboxConfig } from "./sandbox-config";
import { createSandboxedBashOps } from "./sandbox-bash";

/**
 * Auto mode (push 1: containment). When enabled and the platform supports it,
 * `bash` runs inside an OS sandbox (sandbox-exec / bubblewrap via ASRT) so the
 * blast radius of an allowed command is the workspace, not the machine.
 *
 * This is layered UNDER the exec-guard, not instead of it: the guard's tool_call
 * gate still decides allow/ask/deny on the original command first; this only
 * changes HOW an already-allowed command executes. When auto mode is off, or the
 * sandbox can't init, bash behaves exactly as before. Push 2 will let the gate
 * relax the escape-shaped prompts once it knows the sandbox is active.
 *
 * Shell-neutral: all of this lives in the brain. Mid-session cwd changes still
 * use the cwd captured at session start (follow-up: re-init on cwd change).
 */
export function registerAutoMode(pi: ExtensionAPI): void {
  let sessionCwd = process.cwd();

  pi.registerTool({
    ...createBashTool(sessionCwd),
    async execute(id, params, signal, onUpdate) {
      const tool = isAutoSandboxActive()
        ? createBashTool(sessionCwd, { operations: createSandboxedBashOps() })
        : createBashTool(sessionCwd);
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // `!`-prefixed user commands bypass tool_call; sandbox them too when active.
  pi.on("user_bash", () => {
    if (!isAutoSandboxActive()) return;
    return { operations: createSandboxedBashOps() };
  });

  pi.on("session_start", async (_event, ctx) => {
    setAutoSandboxActive(false);
    const cfg = loadGuardianConfig();
    if (!resolveAutoMode(cfg)) return; // off -> plain gate, no sandbox

    sessionCwd = ctx.cwd;

    if (!SandboxManager.isSupportedPlatform()) {
      ctx.ui.notify(
        `Auto mode on, but OS sandboxing isn't supported on ${process.platform} -- bash stays gated per action.`,
        "warning",
      );
      return;
    }

    try {
      await SandboxManager.initialize(
        buildSandboxConfig({
          cwd: sessionCwd,
          tmpDir: os.tmpdir(),
          extraWriteRoots: cfg.extraWorkspaceRoots,
          galaxyUrl: process.env.GALAXY_URL,
        }),
      );
      setAutoSandboxActive(true);
      ctx.ui.setStatus("loom-auto", "Auto (sandboxed)");
      ctx.ui.notify("Auto mode: bash runs inside an OS sandbox.", "info");
    } catch (err) {
      setAutoSandboxActive(false);
      ctx.ui.notify(
        `Auto mode: sandbox init failed (${err instanceof Error ? err.message : String(err)}); bash stays gated per action.`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    if (!isAutoSandboxActive()) return;
    try {
      await SandboxManager.reset();
    } catch {
      // best-effort cleanup
    }
    setAutoSandboxActive(false);
  });

  pi.registerCommand("auto", {
    description: "Show Auto mode (sandbox) status",
    handler: async (_args, ctx) => {
      if (!resolveAutoMode(loadGuardianConfig())) {
        ctx.ui.notify(
          "Auto mode is off. Enable with --auto, LOOM_AUTO=1, or guardian.autoMode in config.",
          "info",
        );
        return;
      }
      ctx.ui.notify(
        isAutoSandboxActive()
          ? "Auto mode on -- bash runs inside the OS sandbox."
          : `Auto mode on, but the sandbox is inactive on ${process.platform}; bash stays gated per action.`,
        "info",
      );
    },
  });
}
