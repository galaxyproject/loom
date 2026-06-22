import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  initSessionArtifacts,
  resetState,
  isGalaxyEffectivelyConnected,
  setGalaxyConnection,
} from "../extensions/loom/state";

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

  it("does not auto-commit notebook.md into an existing user repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-existing-repo-"));
    dirs.push(dir);
    git(["init"], dir);
    git(["config", "user.email", "loom-test@example.com"], dir);
    git(["config", "user.name", "Loom Test"], dir);
    writeFileSync(join(dir, "README.md"), "# Existing repo\n", "utf-8");
    git(["add", "README.md"], dir);
    git(["commit", "-m", "Initial commit"], dir);

    initSessionArtifacts(dir);

    expect(existsSync(join(dir, "notebook.md"))).toBe(true);
    expect(git(["rev-list", "--count", "HEAD"], dir)).toBe("1");
    expect(git(["status", "--short"], dir)).toContain("?? notebook.md");
  });
});

describe("isGalaxyEffectivelyConnected", () => {
  const saved = { url: process.env.GALAXY_URL, key: process.env.GALAXY_API_KEY };

  afterEach(() => {
    resetState();
    if (saved.url === undefined) delete process.env.GALAXY_URL;
    else process.env.GALAXY_URL = saved.url;
    if (saved.key === undefined) delete process.env.GALAXY_API_KEY;
    else process.env.GALAXY_API_KEY = saved.key;
  });

  it("is true when both env creds are present, even with the in-session flag false", () => {
    resetState();
    setGalaxyConnection(false);
    process.env.GALAXY_URL = "http://localhost:8080";
    process.env.GALAXY_API_KEY = "k";
    expect(isGalaxyEffectivelyConnected()).toBe(true);
  });

  it("falls back to the in-session flag when env creds are absent", () => {
    resetState();
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    expect(isGalaxyEffectivelyConnected()).toBe(false);
    setGalaxyConnection(true);
    expect(isGalaxyEffectivelyConnected()).toBe(true);
  });

  it("is false when only one env cred is present", () => {
    resetState();
    setGalaxyConnection(false);
    process.env.GALAXY_URL = "http://localhost:8080";
    delete process.env.GALAXY_API_KEY;
    expect(isGalaxyEffectivelyConnected()).toBe(false);
  });
});
