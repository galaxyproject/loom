export interface BashClass {
  kind: "safe" | "catastrophic" | "unknown";
  reason: string;
  /** Path-like args to read-style commands, for the policy layer to run through
   *  sensitive-read + jail. Best-effort; empty when not confidently parseable. */
  readPaths: string[];
  /** Content-read targets surfaced from EVERY shell segment, so the sensitive-read
   *  floor still fires when a pipe/compound forces kind="unknown" (closes the
   *  `cat secret | tool` evasion in #183). Unlike readPaths, this is computed even
   *  for compound commands; the policy layer applies only the sensitive floor to
   *  it (never the workspace-jail floor, so compound jail semantics are unchanged). */
  sensitiveReadPaths: string[];
}

// Never-legitimate, irreversible-system-damage patterns. Order matters; first match wins.
// `sudo` allows an absolute/relative path prefix (/usr/bin/sudo), and the
// pipe-to-interpreter rule covers path-prefixed and env-wrapped interpreters
// beyond bare POSIX shells (python/perl/node/...).
const CATASTROPHIC: Array<[RegExp, string]> = [
  [/(^|[\s;&|])(\S*\/)?sudo\b/, "privilege escalation (sudo)"],
  [/:\s*\(\s*\)\s*\{.*:\|:.*\}/, "fork bomb"],
  [/\bdd\b[^\n]*\bof=\/dev\//, "dd to a device"],
  [/\bmkfs(\.[a-z0-9]+)?\b/, "filesystem format"],
  [
    /(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(env\s+)?(\S*\/)?(sh|bash|zsh|dash|ksh|fish|python[0-9.]*|perl|ruby|node|php)\b/,
    "pipe remote content to an interpreter",
  ],
  [/\bchmod\s+-R\s+777\s+\//, "world-writable recursive chmod on /"],
  [/>\s*\/dev\/(sd|nvme|disk)/, "redirect to a raw device"],
  // Self-disabling: editing the gate's own config is how an agent would try to
  // flip bypass on. The write TOOL into .loom is already gated (isProtectedWritePath);
  // these close the bash path. The bypass key with an assignment, and any write
  // verb aimed at ~/.loom/config.json, are the signals. Reads of the config stay
  // an `ask` via the sensitive-read floor (not caught here).
  [/dangerouslyBypassPermissions['"\]\s]*[:=]/, "attempt to enable the permissions bypass"],
  [
    /(?:>>?|\btee\b|\bsed\b[^\n]*-i|\bcp\b|\bmv\b|\bdd\b)[^\n]*\.loom\//,
    "write to the Loom config directory",
  ],
];

// Command wrappers that delegate to a real command. We strip them so a
// catastrophic command can't hide behind `env`, `conda run`, `nice`, etc.
const WRAPPER_CMDS = new Set([
  "nohup",
  "setsid",
  "time",
  "nice",
  "ionice",
  "stdbuf",
  "timeout",
  "caffeinate",
  "command",
  "exec",
  "builtin",
]);

function stripQuotes(s: string): string {
  return s.replace(/^['"]+|['"]+$/g, "");
}

// Peel leading wrapper commands (env VAR=val, conda run -p PATH, nice -n N, ...)
// off a token list so the real verb is exposed to the catastrophic check.
function unwrap(tokens: string[]): string[] {
  let t = tokens;
  for (;;) {
    if (t.length === 0) return t;
    const head = t[0];
    if (head === "env") {
      t = t.slice(1);
      while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t = t.slice(1);
      continue;
    }
    if (head === "conda" && t[1] === "run") {
      t = t.slice(2);
      while (t.length && t[0].startsWith("-")) {
        const takesArg = ["-p", "--prefix", "-n", "--name"].includes(t[0]);
        t = t.slice(takesArg ? 2 : 1);
      }
      continue;
    }
    if (WRAPPER_CMDS.has(head)) {
      t = t.slice(1);
      while (t.length && t[0].startsWith("-")) t = t.slice(1);
      if (t.length && /^\d+[a-z]?$/i.test(t[0])) t = t.slice(1); // `timeout 5`, `nice 10`
      continue;
    }
    return t;
  }
}

// Roots whose recursive force-deletion is catastrophic. Quotes are stripped
// first, so `"$HOME"` and `'/'` are caught; the home dir is passed in so an
// explicit absolute home path (`rm -rf /Users/me`) is caught too.
const SYSTEM_ROOTS = new Set([
  "/",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc",
  "/var",
  "/boot",
  "/dev",
  "/opt",
  "/sys",
  "/proc",
  "/root",
  "/System",
  "/Library",
  "/Applications",
]);

function isFilesystemRoot(arg: string, home: string): boolean {
  const t = stripQuotes(arg);
  if (["/", "~", "~/", "~/*", "$HOME", "${HOME}", "$HOME/", "$HOME/*", "${HOME}/*"].includes(t)) {
    return true;
  }
  if (/^\/+$/.test(t)) return true;
  const noGlob = t.replace(/\/\*+$/, "");
  if (SYSTEM_ROOTS.has(noGlob)) return true;
  if (home && (noGlob === home || t === home + "/" || t === home)) return true;
  return false;
}

// `rm` with BOTH a recursive and a force flag pointed at a filesystem root.
// Token-based so it handles short/bundled/long flags in any order
// (`-rf`, `-r -f`, `--recursive --force`), quoted targets, and wrapper prefixes
// (`env rm`, `conda run rm`, `nice -n 10 rm`). A routine `rm -rf build` is NOT
// caught (target isn't a root); it stays "unknown" and still prompts. Each shell
// segment -- split on `;`, `&`, `|`, and NEWLINES -- is checked so it fires
// inside a compound or multi-line command too.
function isCatastrophicRm(command: string, home: string): boolean {
  for (const segment of command.split(/[;&|\n\r]+/)) {
    const tokens = unwrap(segment.trim().split(/\s+/).filter(Boolean).map(stripQuotes));
    if (tokens.length === 0) continue;
    const verb = tokens[0].split("/").pop(); // basename: /bin/rm -> rm
    if (verb !== "rm") continue;
    const flags = tokens.slice(1).filter((t) => t.startsWith("-"));
    const targets = tokens.slice(1).filter((t) => !t.startsWith("-"));
    const recursive = flags.some((f) => f === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(f));
    const force = flags.some((f) => f === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f));
    if (recursive && force && targets.some((t) => isFilesystemRoot(t, home))) return true;
  }
  return false;
}

// Single read-only/analysis commands we auto-allow when the line is "simple".
// Deliberately excludes command wrappers (`env`, `conda run`, `bash -c`, ...):
// those execute an arbitrary inner command, so they are never auto-safe -- they
// fall through to `unknown` and prompt.
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
];

// Any of these mean "we can't reason about this as a single safe command."
// Bare newlines count: the shell runs them as separate commands, so a line that
// starts with a safe verb but continues onto another line is NOT safe.
const SHELL_META = /[;&|`\n\r]|\$\(|\$\{|<\(|>>?|<|\\\n/;

const READ_LIKE = new Set(["cat", "head", "tail", "less", "more", "grep", "rg"]);

// Safe commands whose path operands the policy layer runs through the workspace
// jail. Superset of READ_LIKE: the content readers above plus the enumeration /
// metadata commands, which reveal the structure, filenames, sizes, or contents
// of their target. A bare `ls`/`find` on the safe allowlist was previously
// auto-allowed regardless of where it pointed, so `ls ~/Desktop` silently
// inspected outside the workspace while the equivalent `ls` *tool* prompted
// (#224). `df <path>` is here too: it reveals existence + the mount/capacity of
// its argument. The remaining safe commands (echo/pwd/which/date/whoami/uname)
// take no file-path operand, so they are deliberately excluded -- collecting
// their args would manufacture spurious out-of-workspace prompts. Unlike
// READ_LIKE, this set does NOT feed the sensitive-read pipe floor
// (extractReadTargets): `ls ~/.ssh` lists names, it does not dump key contents,
// so the jail's escape-ask is the right response, not the credential-store deny.
const PATH_READING = new Set([...READ_LIKE, "ls", "find", "fd", "file", "stat", "du", "df", "wc"]);

// Content-read targets across EVERY shell segment (split on the same separators
// as the catastrophic-rm scan). For any segment whose verb is a content reader,
// collect its non-flag args. This is what closes the pipe evasion: `cat secret |
// tool` is "unknown" as a whole, but its first segment still reads `secret`. A
// path that is only an auth arg to a non-reading command (`ssh -i key`) is NOT
// collected -- only verbs that dump file contents to stdout.
function extractReadTargets(command: string): string[] {
  const out: string[] = [];
  for (const segment of command.split(/[;&|\n\r]+/)) {
    const tokens = unwrap(segment.trim().split(/\s+/).filter(Boolean).map(stripQuotes));
    if (tokens.length === 0) continue;
    const verb = tokens[0].split("/").pop(); // basename: /bin/cat -> cat
    if (!verb || !READ_LIKE.has(verb)) continue;
    for (const t of tokens.slice(1)) if (!t.startsWith("-")) out.push(t);
  }
  return out;
}

export function classifyBash(commandRaw: string, home = ""): BashClass {
  const command = commandRaw.trim();
  // Computed for every kind (incl. compound/unknown) so the policy layer's
  // sensitive-read floor fires through a pipe; see BashClass.sensitiveReadPaths.
  const sensitiveReadPaths = extractReadTargets(command);
  for (const [re, why] of CATASTROPHIC) {
    if (re.test(command))
      return { kind: "catastrophic", reason: why, readPaths: [], sensitiveReadPaths };
  }
  if (isCatastrophicRm(command, home)) {
    return {
      kind: "catastrophic",
      reason: "recursive force-delete of / or home",
      readPaths: [],
      sensitiveReadPaths,
    };
  }
  if (SHELL_META.test(command)) {
    return {
      kind: "unknown",
      reason: "compound or redirected command",
      readPaths: [],
      sensitiveReadPaths,
    };
  }
  const tokens = command.split(/\s+/).filter(Boolean);
  if (tokens.length === 0)
    return { kind: "unknown", reason: "empty command", readPaths: [], sensitiveReadPaths };
  const cmd = tokens[0];

  const prefixHit = SAFE_PREFIXES.some((p) => p.every((t, i) => tokens[i] === t));
  const isSafeCmd = SAFE_COMMANDS.has(cmd) || prefixHit;
  if (!isSafeCmd) {
    return {
      kind: "unknown",
      reason: `'${cmd}' is not on the safe allowlist`,
      readPaths: [],
      sensitiveReadPaths,
    };
  }

  // Collect path-like args for read/enumerate commands so the policy layer can
  // apply the workspace jail (a "safe" cat/ls/find must still not reach outside
  // the workspace silently). See PATH_READING for why the set is broader than
  // READ_LIKE and which safe commands are deliberately left out. Quotes are
  // stripped first (mirroring extractReadTargets): without it `ls "/external"`
  // keeps its quotes, resolves as a cwd-relative path, and silently auto-allows.
  const readPaths = PATH_READING.has(cmd)
    ? tokens
        .slice(1)
        .map(stripQuotes)
        .filter((t) => t.length > 0 && !t.startsWith("-"))
    : [];
  return {
    kind: "safe",
    reason: `read-only/analysis command '${cmd}'`,
    readPaths,
    sensitiveReadPaths,
  };
}
