// WSL detection shared by both FeedbackSysinfo builders (Orbit's main process
// and the CLI brain) so the desktop app and the CLI report the same thing.
// Inputs are passed in rather than read off `process`/`os` so this is unit-
// testable without a WSL machine. No Node imports -- renderer-safe, same rule
// as feedback-contract.js.

const MICROSOFT_RELEASE = /microsoft/i;

/**
 * True when the caller is running under WSL. WSL reports `platform: "linux"`,
 * which is why a feedback row can't otherwise be told apart from a native
 * Linux desktop.
 */
export function isWsl(runtime = {}) {
  // WSL always presents a Linux userland. Gating on that keeps a Windows-side
  // process that inherited the interop env vars from being mislabelled.
  if (runtime.platform !== "linux") return false;
  const env = runtime.env || {};
  if (typeof env.WSL_DISTRO_NAME === "string" && env.WSL_DISTRO_NAME.length > 0) return true;
  if (typeof env.WSL_INTEROP === "string" && env.WSL_INTEROP.length > 0) return true;
  // The env can be stripped (systemd units, `env -i`), but both WSL1 and WSL2
  // carry "microsoft" in the kernel release string.
  return typeof runtime.release === "string" && MICROSOFT_RELEASE.test(runtime.release);
}
