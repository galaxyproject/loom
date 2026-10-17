import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { initSessionArtifacts, resetState } from "../extensions/loom/state";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf-8",
  }).trim();
}

describe("initSessionArtifacts", () => {
  const dirs: string[] = [];

  afterEach(() => {
    resetState();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not auto-commit notebook.md into an existing user repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-existing-repo-"));
    dirs.push(dir);
    git(["init"], dir);
    git(["config", "user.email", "loom-test@example.com"], dir);
    git(["config", "user.name", "Loom Test"], dir);
    writeFileSync(join(dir, "README.md"), "# Existing repo\n", "utf-8");
    git(["add", "README.md"], dir);
    git(["commit", "-m", "Initial commit"], dir);

    await initSessionArtifacts(dir);

    expect(existsSync(join(dir, "notebook.md"))).toBe(true);
    expect(git(["rev-list", "--count", "HEAD"], dir)).toBe("1");
    expect(git(["status", "--short"], dir)).toContain("?? notebook.md");
  });
});
