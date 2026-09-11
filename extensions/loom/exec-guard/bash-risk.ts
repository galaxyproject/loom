import * as path from "path";
import { isLoomStatePath } from "./sensitive-read";

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
  /** `.loom/` write targets this classifier judged to be ordinary work product in
   *  an Orbit analysis workspace. It only sees the command string, so the policy
   *  layer realpaths each one and re-applies isLoomStatePath -- a symlink under
   *  the analyses tree pointing at Loom's own state is still Loom's own state.
   *  Empty unless a write verb aimed at `.loom/` was carved out. */
  loomWriteTargets: string[];
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
  // flip bypass on. The bypass key with an assignment is one signal; a write verb
  // aimed at Loom's own state is the other, and it needs a per-target decision, so
  // it lives in isCatastrophicLoomWrite below rather than in this table. Reads of
  // the config stay an `ask` via the sensitive-read floor (not caught here).
  [/dangerouslyBypassPermissions['"\]\s]*[:=]/, "attempt to enable the permissions bypass"],
];

// A write verb aimed at something under a `.loom/` directory. Only the trigger:
// whether it is really Loom state is decided per target below, because Orbit's
// own workspaces live under $HOME/.loom/analyses/<name>/.
const LOOM_WRITE = /(?:>>?|\btee\b|\bsed\b[^\n]*-i|\bcp\b|\bmv\b|\bdd\b)[^\n]*\.loom\//i;

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

// Unquoted characters that end a shell word. Quotes deliberately do NOT: bash
// concatenates adjacent quoted and unquoted fragments into one word, so reading
// only as far as a quote would hand back `$HOME/.loom/analyses/` for
// `"$HOME/.loom/analyses/"../config.json` -- the carved-out prefix of a target
// that walks straight back out of the tree. `=` is not a boundary either; it is
// an ordinary character in a pathname. Only space, tab and newline split a word:
// JS `\s` also matches U+00A0 and a carriage return, both of which bash keeps
// inside the word.
const WORD_BREAK = /[ \t\n;&|<>()]/;

/** A run of characters that shared one quoting context, in word order. Quoting
 *  has to survive parsing: bash decides each expansion from how the fragment
 *  that carries it was quoted, so `"$"HOME/x` is a literal `$HOME/x` and
 *  `~"/x"` keeps its tilde. Reading the concatenated text back would invent
 *  expansions the shell never performs. An empty fragment is kept -- `''~/x` is
 *  a word that does not begin with a tilde, so bash leaves the tilde alone. */
interface WordFragment {
  text: string;
  quote: "'" | '"' | null;
}

// Backslash escapes bash honours inside double quotes; elsewhere it escapes
// whatever follows.
const DQ_ESCAPABLE = '$`"\\\n';

// Split a command into shell words, tracking the quoting of each fragment.
// Models bash's word splitting, escaping and comments, not its expansions --
// anything that would need expanding is rejected by resolveLoomWord below.
function shellWords(command: string): WordFragment[][] {
  const words: WordFragment[][] = [];
  let word: WordFragment[] = [];
  let text = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  const endFragment = (keepEmpty: boolean) => {
    if (text || keepEmpty) word.push({ text, quote });
    text = "";
  };
  const endWord = () => {
    endFragment(false);
    if (word.length) words.push(word);
    word = [];
    started = false;
  };
  // An escaped character is literal, exactly like a single-quoted one -- and it
  // has to be recorded that way, or `\~/x` and `\$HOME/x` would be read back as
  // expansions the shell already refused to perform.
  const pushEscaped = (chr: string) => {
    endFragment(false);
    word.push({ text: chr, quote: "'" });
    started = true;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") {
        endFragment(true);
        quote = null;
      } else {
        text += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        endFragment(true);
        quote = null;
      } else if (ch === "\\" && i + 1 < command.length && DQ_ESCAPABLE.includes(command[i + 1])) {
        i++;
        if (command[i] !== "\n") pushEscaped(command[i]);
      } else {
        text += ch;
      }
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= command.length) {
        text += ch;
        started = true;
        continue;
      }
      i++;
      // A line continuation contributes nothing -- not even the fact that a word
      // began, or the `#` on the joined line would stop being a comment.
      if (command[i] !== "\n") pushEscaped(command[i]);
      continue;
    }
    if (ch === "'" || ch === '"') {
      endFragment(false);
      quote = ch;
      started = true;
      continue;
    }
    // `#` starts a comment only where a word has not started; inside one it is
    // an ordinary character, and treating it as a comment there would discard
    // the rest of the line -- including whatever runs after the next `;`.
    if (ch === "#" && !started) {
      const nl = command.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (WORD_BREAK.test(ch)) {
      endWord();
      continue;
    }
    started = true;
    text += ch;
  }
  endWord();
  return words;
}

function wordText(fragments: WordFragment[]): string {
  return fragments.map((f) => f.text).join("");
}

// `.loom` is matched case-insensitively because the carve-out below folds case
// too (macOS resolves ~/.LOOM and ~/.loom to the same directory), and against a
// backslash-stripped copy so a quoted `.\loom/` -- where the backslash survives
// as a literal -- is still examined rather than skipped.
const LOOM_SEGMENT = /\.loom\//i;
function mentionsLoom(word: WordFragment[]): boolean {
  return LOOM_SEGMENT.test(wordText(word).replace(/\\/g, ""));
}

// Resolve a `.loom/` word to the absolute path the shell would act on, or null
// when we cannot say -- and null keeps the line denied. Conservative by
// construction: a leading `~/` expands only when the word begins with it
// unquoted, and `$HOME`/`${HOME}` only when the fragment carrying the variable
// is not single-quoted. Anything unresolvable afterwards -- a relative path
// (classifyBash has no cwd), another user's home, an unexpanded variable, a glob
// or bracket expression, a brace expansion, a surviving backslash, a command
// substitution, or any `..` segment (the resolver collapses those lexically
// before it realpaths, so a `..` after a symlink would never be inspected) --
// comes back null. What survives is an absolute path the caller can compare
// against the analyses tree the write tool already allows (isProtectedWritePath).
function resolveLoomWord(word: WordFragment[], home: string): string | null {
  if (!home) return null;
  const fragments = word.filter((f) => f.text.length > 0);
  if (fragments.length === 0) return null;
  let text = wordText(fragments);
  const head = fragments[0];
  if (word[0].quote === null && word[0].text.startsWith("~/")) {
    text = home + text.slice(1);
  } else if (head.quote !== "'") {
    for (const v of ["$HOME", "${HOME}"]) {
      // The variable has to sit whole in the leading fragment; `$HO"ME"` and
      // `"$"HOME` are two fragments and bash expands neither. The slash may
      // arrive in the next one, as in `"$HOME"/x`.
      if (head.text === v || head.text.startsWith(v + "/")) {
        const rest = text.slice(v.length);
        if (rest.startsWith("/")) {
          text = home + rest;
          break;
        }
      }
    }
  }
  if (text.startsWith("~") || /[*?$`\\{}[\]]/.test(text)) return null;
  if (!path.isAbsolute(text)) return null;
  if (text.split("/").includes("..")) return null;
  return path.normalize(text);
}

// Editing Loom's own state from the shell is how an agent would disable the gate
// (the write TOOL into .loom is gated by isProtectedWritePath). The rule used to
// be a single regex, which also caught every ordinary write into an Orbit
// analysis workspace -- Orbit's DEFAULT_CWD is ~/.loom/analyses -- and denied it
// outright while the same write through the file tool was allowed. Now a matched
// line is catastrophic only if some `.loom/` target on it is really Loom state;
// the rest are handed to the policy layer, which can realpath them.
function scanLoomWrite(
  command: string,
  home: string,
): { catastrophic: boolean; targets: string[] } {
  if (!LOOM_WRITE.test(command)) return { catastrophic: false, targets: [] };
  const words = shellWords(command).filter(mentionsLoom);
  if (words.length === 0) return { catastrophic: true, targets: [] };
  const targets: string[] = [];
  for (const w of words) {
    const resolved = resolveLoomWord(w, home);
    if (resolved === null || isLoomStatePath(resolved, home)) {
      return { catastrophic: true, targets: [] };
    }
    targets.push(resolved);
  }
  return { catastrophic: false, targets };
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
  const loom = scanLoomWrite(command, home);
  const base = { sensitiveReadPaths, loomWriteTargets: loom.targets };
  for (const [re, why] of CATASTROPHIC) {
    if (re.test(command)) return { kind: "catastrophic", reason: why, readPaths: [], ...base };
  }
  if (loom.catastrophic) {
    return {
      kind: "catastrophic",
      reason: "write to the Loom config directory",
      readPaths: [],
      ...base,
    };
  }
  if (isCatastrophicRm(command, home)) {
    return {
      kind: "catastrophic",
      reason: "recursive force-delete of / or home",
      readPaths: [],
      ...base,
    };
  }
  if (SHELL_META.test(command)) {
    return {
      kind: "unknown",
      reason: "compound or redirected command",
      readPaths: [],
      ...base,
    };
  }
  const tokens = command.split(/\s+/).filter(Boolean);
  if (tokens.length === 0)
    return { kind: "unknown", reason: "empty command", readPaths: [], ...base };
  const cmd = tokens[0];

  const prefixHit = SAFE_PREFIXES.some((p) => p.every((t, i) => tokens[i] === t));
  const isSafeCmd = SAFE_COMMANDS.has(cmd) || prefixHit;
  if (!isSafeCmd) {
    return {
      kind: "unknown",
      reason: `'${cmd}' is not on the safe allowlist`,
      readPaths: [],
      ...base,
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
    ...base,
  };
}
