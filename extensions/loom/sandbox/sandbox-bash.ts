import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

/**
 * A `BashOperations` that runs each command inside the OS sandbox.
 * `SandboxManager.wrapWithSandbox` rewraps the command for `sandbox-exec`
 * (macOS) / `bubblewrap` (Linux) using the profile from `SandboxManager.initialize`.
 *
 * Adapted from pi's bundled `examples/extensions/sandbox` reference: detached so
 * the whole process group can be SIGKILL'd on timeout/abort, stdout+stderr piped
 * to onData, and the standard timeout/abort/exit semantics pi expects. We can't use
 * pi's lighter `spawnHook` here -- that hook is synchronous, and `wrapWithSandbox`
 * is async -- so, like the reference, we supply a custom `exec`.
 *
 * Known limitation (inherited from that reference, and bounded by the tool timeout):
 * completion is detected via `"close"`, so a command that backgrounds a child
 * holding stdout/stderr can delay resolution until the timeout fires. pi's internal
 * backend avoids this with an `"exit"`-based wait + detached-PID tracking, but those
 * helpers aren't exported, so matching them downstream would diverge from the
 * maintained reference; the proper fix belongs upstream in pi.
 */
export function createSandboxedBashOps(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

      return new Promise((resolve, reject) => {
        // Abort may have fired before this point (incl. during the async
        // wrapWithSandbox above); don't spawn a command we'd immediately discard.
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }

        const child = spawn("bash", ["-c", wrappedCommand], {
          cwd,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        const killGroup = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killGroup();
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        });

        const onAbort = () => killGroup();
        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}
