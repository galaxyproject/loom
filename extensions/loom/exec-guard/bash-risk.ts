export interface BashClass {
  kind: "safe" | "catastrophic" | "unknown";
  reason: string;
  /** Path-like args to read-style commands, for the policy layer to run through
   *  sensitive-read + jail. Best-effort; empty when not confidently parseable. */
  readPaths: string[];
}

// Never-legitimate, irreversible-system-damage patterns. Order matters; first match wins.
const CATASTROPHIC: Array<[RegExp, string]> = [
  [/(^|\s|;|&|\|)sudo(\s|$)/, "privilege escalation (sudo)"],
  [
    /\brm\s+(-[a-z]*\s+)*(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|~|\$HOME)(\s|\/|$)/,
    "recursive force-delete of / or home",
  ],
  [/:\s*\(\s*\)\s*\{.*:\|:.*\}/, "fork bomb"],
  [/\bdd\b[^\n]*\bof=\/dev\//, "dd to a device"],
  [/\bmkfs(\.[a-z0-9]+)?\b/, "filesystem format"],
  [/(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, "pipe remote content to a shell"],
  [/\bchmod\s+-R\s+777\s+\//, "world-writable recursive chmod on /"],
  [/>\s*\/dev\/(sd|nvme|disk)/, "redirect to a raw device"],
];

// Single read-only/analysis commands we auto-allow when the line is "simple".
const SAFE_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "echo",
  "grep",
  "rg",
  "fd",
  "find",
  "file",
  "stat",
  "du",
  "df",
  "which",
  "env",
  "date",
  "whoami",
  "uname",
]);
// Multi-token safe prefixes (exact leading tokens).
const SAFE_PREFIXES = [
  ["git", "status"],
  ["git", "diff"],
  ["git", "log"],
  ["git", "show"],
  ["conda", "run"],
];

// Any of these mean "we can't reason about this as a single safe command."
const SHELL_META = /[;&|`]|\$\(|\$\{|<\(|>>?|<|\\\n/;

const READ_LIKE = new Set(["cat", "head", "tail", "less", "more", "grep", "rg"]);

export function classifyBash(commandRaw: string): BashClass {
  const command = commandRaw.trim();
  for (const [re, why] of CATASTROPHIC) {
    if (re.test(command)) return { kind: "catastrophic", reason: why, readPaths: [] };
  }
  if (SHELL_META.test(command)) {
    return { kind: "unknown", reason: "compound or redirected command", readPaths: [] };
  }
  const tokens = command.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: "unknown", reason: "empty command", readPaths: [] };
  const cmd = tokens[0];

  const prefixHit = SAFE_PREFIXES.some((p) => p.every((t, i) => tokens[i] === t));
  const isSafeCmd = SAFE_COMMANDS.has(cmd) || prefixHit;
  if (!isSafeCmd) {
    return { kind: "unknown", reason: `'${cmd}' is not on the safe allowlist`, readPaths: [] };
  }

  // Collect path-like args for read-style commands so the policy layer can apply
  // the sensitive-read + jail floor (a "safe" cat must still not read ~/.ssh).
  const readPaths = READ_LIKE.has(cmd) ? tokens.slice(1).filter((t) => !t.startsWith("-")) : [];
  return { kind: "safe", reason: `read-only/analysis command '${cmd}'`, readPaths };
}
