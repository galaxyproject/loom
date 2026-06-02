import * as os from "os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { loadGuardianConfig, resolveSandbox } from "../exec-guard/guardian-config";
import { isSandboxActive, setSandboxActive } from "../exec-guard/runtime-state";
import { buildSandboxConfig } from "./sandbox-config";
import { createSandboxedBashOps } from "./sandbox-bash";

/**
 * Bash OS sandbox (opt-in). When enabled (`--sandbox` / LOOM_SANDBOX=1 /
 * guardian.sandbox) and the platform supports it, `bash` runs inside an OS sandbox
 * (sandbox-exec / bubblewrap via ASRT): its writes are confined to the workspace
 * and its network to an allowlist, so an allowed command's blast radius is the
 * analysis dir, not the machine.
 *
 * Layered UNDER the exec-guard: the guard's tool_call gate still decides
 * allow/ask/deny on the original command; this only changes HOW an already-allowed
 * command runs. OFF by default because the sandbox necessarily restricts bash
 * network (ASRT cannot confine writes alone, and rejects a wildcard allowlist) --
 * a tradeoff the user opts into.
 *
 * Default-on confinement of the model's *file* edits lives in the gate itself
 * (the exec-guard write/edit path-jail), independent of this sandbox.
 *
 * Shell-neutral: all of this lives in the brain. Mid-session cwd changes use the
 * cwd captured at session start (Orbit re-spawns the brain on a dir switch).
 */
export function registerSandbox(pi: ExtensionAPI): void {
  let sessionCwd = process.cwd();

  pi.registerTool({
    ...createBashTool(sessionCwd),
    async execute(id, params, signal, onUpdate) {
      const tool = isSandboxActive()
        ? createBashTool(sessionCwd, { operations: createSandboxedBashOps() })
        : createBashTool(sessionCwd);
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // `!`-prefixed user commands bypass tool_call; sandbox them too when active.
  pi.on("user_bash", () => {
    if (!isSandboxActive()) return;
    return { operations: createSandboxedBashOps() };
  });

  pi.on("session_start", async (_event, ctx) => {
    setSandboxActive(false);
    const cfg = loadGuardianConfig();
    if (!resolveSandbox(cfg)) return; // opt-in: off -> plain gate, no sandbox

    sessionCwd = ctx.cwd;

    if (!SandboxManager.isSupportedPlatform()) {
      ctx.ui.notify(
        `Bash sandbox requested, but OS sandboxing isn't supported on ${process.platform} -- bash stays gated per action.`,
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
      setSandboxActive(true);
      ctx.ui.setStatus("loom-sandbox", "Bash sandboxed");
      ctx.ui.notify(
        "Bash sandbox on: bash writes are confined to the workspace and its network is limited.",
        "info",
      );
    } catch (err) {
      setSandboxActive(false);
      ctx.ui.notify(
        `Bash sandbox init failed (${err instanceof Error ? err.message : String(err)}); bash stays gated per action.`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    if (!isSandboxActive()) return;
    try {
      await SandboxManager.reset();
    } catch {
      // best-effort cleanup
    }
    setSandboxActive(false);
  });

  pi.registerCommand("sandbox", {
    description: "Show bash sandbox status",
    handler: async (_args, ctx) => {
      if (!resolveSandbox(loadGuardianConfig())) {
        ctx.ui.notify(
          "Bash sandbox is off. Enable with --sandbox, LOOM_SANDBOX=1, or guardian.sandbox in config. (Your file-tool writes are confined to the analysis dir regardless.)",
          "info",
        );
        return;
      }
      ctx.ui.notify(
        isSandboxActive()
          ? "Bash sandbox on -- bash runs inside the OS sandbox (writes confined to the workspace; network limited)."
          : `Bash sandbox requested, but inactive on ${process.platform}; bash stays gated per action.`,
        "info",
      );
    },
  });
}
