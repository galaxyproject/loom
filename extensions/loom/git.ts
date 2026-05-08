/**
 * Automatic git tracking for analysis notebooks.
 *
 * Uses child_process.execFileSync directly — no Pi API dependency — so it can
 * be called from state.ts without threading the extension context through.
 * Every function silently swallows errors: git tracking is nice-to-have,
 * never a reason to break an analysis.
 *
 * `execFileSync` (not `execSync`) is the only spawner used here. It bypasses
 * the shell, so commit messages or filenames containing backticks, $(...),
 * quotes, or any other shell metacharacters can never be interpreted as code.
 */

import { execFileSync } from "child_process";
import { writeFileSync, existsSync } from "fs";
import * as path from "path";

// Change types that warrant their own commit.  Everything else (frontmatter,
// galaxy_ref, literature_ref) is too granular — those changes get picked up
// by the next real commit since `git add` stages the current file state.
export const COMMIT_CHANGE_TYPES = new Set([
  "step_added",
  "step_updated",
  "decision",
  "checkpoint",
  "phase_change",
  "data_provenance",
  "publication_update",
  "brc_context_updated",
  "assertion_added",
]);

const GITIGNORE_CONTENT = `# Large bioinformatics data
*.fastq
*.fastq.gz
*.fq.gz
*.bam
*.bai
*.sam
*.cram
*.vcf.gz
*.bcf
*.bigwig
*.bw
*.h5ad

# Archives
*.tar.gz
*.tar.bz2
*.zip

# OS
.DS_Store
Thumbs.db

# Python/R
__pycache__/
*.pyc
.Rhistory
.RData

# Editors
.vscode/
.idea/
*.swp
*~

# Loom per-analysis conda env (large, reproducible from the notebook's
# Environment table rather than committed bytes)
.loom/env/

# Loom session sidecars
activity.jsonl
session.jsonl
`;

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function gitOutput(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf-8",
  }).trim();
}

export function isLoomManagedRepo(cwd: string): boolean {
  try {
    return gitOutput(["config", "--bool", "loom.managed"], cwd) === "true";
  } catch {
    return false;
  }
}

/**
 * Make sure `cwd` is inside a git repo. If it isn't, run `git init`,
 * drop a bioinformatics-friendly .gitignore, and create an initial commit.
 * Returns true only for repos Loom created or previously marked as managed.
 */
export function ensureGitRepo(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "ignore" });
    return isLoomManagedRepo(cwd);
  } catch {
    // not a repo — fall through to init
  }

  try {
    git(["init"], cwd);
    git(["config", "loom.managed", "true"], cwd);

    const gitignorePath = path.join(cwd, ".gitignore");
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, GITIGNORE_CONTENT);
    }

    git(["add", ".gitignore"], cwd);
    git(["commit", "-m", "Initialize analysis tracking"], cwd);
    return true;
  } catch {
    // git not installed or init failed — silently give up
    return false;
  }
}

/**
 * Stage a single file and commit with `message`.
 * No-ops if nothing changed (git commit exits non-zero, caught by try/catch).
 */
export function commitFile(filePath: string, message: string): void {
  try {
    const cwd = path.dirname(filePath);
    const filename = path.basename(filePath);
    git(["add", filename], cwd);
    git(["commit", "-m", message], cwd);
  } catch {
    // nothing to commit, or git not available
  }
}

/** Back-compat alias for callers that still commit the notebook file. */
export function commitNotebook(notebookPath: string, message: string): void {
  commitFile(notebookPath, message);
}

/**
 * Build a human-readable commit message from a change type and its data.
 */
export function buildCommitMessage(changeType: string, data: Record<string, unknown>): string {
  switch (changeType) {
    case "step_added":
      return `Add step: ${(data.step as { name?: string })?.name ?? "unknown"}`;
    case "step_updated":
      return `Step ${data.stepId ?? "?"}: ${data.status ?? "updated"}`;
    case "decision":
      return `Log: ${data.type ?? "decision"}`;
    case "checkpoint":
      return `QC: ${data.name ?? "checkpoint"} (${data.status ?? "?"})`;
    case "phase_change":
      return `Phase: ${data.phase ?? "unknown"}`;
    case "data_provenance":
      return "Data provenance updated";
    case "publication_update":
      return `Publication: ${data.updateType ?? "update"}`;
    case "assertion_added":
      return `Assertion: ${data.claim ?? "claim recorded"} (${data.verdict ?? "pending"})`;
    default:
      return `Notebook update (${changeType})`;
  }
}
