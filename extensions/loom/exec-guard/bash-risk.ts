export interface BashClass {
  kind: "safe" | "catastrophic" | "unknown";
  reason: string;
  /** Path-like args to read-style commands, for the policy layer to run through
   *  sensitive-read + jail. Best-effort; empty when not confidently parseable. */
  readPaths: string[];
}

// Never-legitimate, irreversible-system-damage patterns. Order matters; first match wins.
// `sudo` allows an absolute/relative path prefix (/usr/bin/sudo), and the
// pipe-to-interpreter rule covers more than POSIX shells (python/perl/node/...).
const CATASTROPHIC: Array<[RegExp, string]> = [
  [/(^|[\s;&|])(\S*\/)?sudo\b/, "privilege escalation (sudo)"],
  [/:\s*\(\s*\)\s*\{.*:\|:.*\}/, "fork bomb"],
  [/\bdd\b[^\n]*\bof=\/dev\//, "dd to a device"],
  [/\bmkfs(\.[a-z0-9]+)?\b/, "filesystem format"],
  [
    /(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh|fish|python[0-9.]*|perl|ruby|node|php)\b/,
    "pipe remote content to an interpreter",
  ],
  [/\bchmod\s+-R\s+777\s+\//, "world-writable recursive chmod on /"],
  [/>\s*\/dev\/(sd|nvme|disk)/, "redirect to a raw device"],
];

// Roots whose recursive force-deletion is catastrophic. Surrounding quotes are
// stripped first, so `"$HOME"` and `'/'` are caught.
function isFilesystemRoot(arg: string): boolean {
  const t = arg.replace(/^['"]+|['"]+$/g, "");
  return ["/", "~", "~/", "$HOME", "${HOME}", "$HOME/"].includes(t) || /^\/+$/.test(t);
}

// `rm` with BOTH a recursive and a force flag pointed at a filesystem root.
// Token-based so it handles short/bundled/long flags in any order
// (`-rf`, `-r -f`, `--recursive --force`) and quoted targets -- cases the old
// single regex missed. A routine `rm -rf build` is NOT caught (target isn't a
// root); it stays "unknown" and still prompts. Each shell segment is checked so
// it fires inside a compound command too.
function isCatastrophicRm(command: string): boolean {
  for (const segment of command.split(/[;&|]+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const verb = tokens[0].split("/").pop(); // basename: /bin/rm -> rm
    if (verb !== "rm") continue;
    const flags = tokens.slice(1).filter((t) => t.startsWith("-"));
    const targets = tokens.slice(1).filter((t) => !t.startsWith("-"));
    const recursive = flags.some((f) => f === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(f));
    const force = flags.some((f) => f === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f));
    if (recursive && force && targets.some(isFilesystemRoot)) return true;
  }
  return false;
}

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
  if (isCatastrophicRm(command)) {
    return { kind: "catastrophic", reason: "recursive force-delete of / or home", readPaths: [] };
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
