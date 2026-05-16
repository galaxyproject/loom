import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathAllowed, shouldBlockTool } from "./web-mode-gate.js";

describe("isPathAllowed", () => {
  const allowlist = ["/tmp/loom-session/notebook.md"];

  it("allows the exact notebook path", () => {
    expect(isPathAllowed("/tmp/loom-session/notebook.md", allowlist)).toBe(true);
  });

  it("rejects sibling files", () => {
    expect(isPathAllowed("/tmp/loom-session/secrets.txt", allowlist)).toBe(false);
  });

  it("rejects parent directory traversal", () => {
    expect(isPathAllowed("/tmp/loom-session/../etc/passwd", allowlist)).toBe(false);
  });

  it("rejects relative path that resolves outside allowlist", () => {
    expect(isPathAllowed("../../etc/passwd", allowlist, "/tmp/loom-session")).toBe(false);
  });

  it("allows relative path to notebook.md when cwd is the session dir", () => {
    expect(isPathAllowed("notebook.md", allowlist, "/tmp/loom-session")).toBe(true);
  });
});

describe("isPathAllowed with real symlinks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "gate-test-")));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("treats a symlink that points at the allowed target as allowed", () => {
    const real = join(tmpDir, "notebook.md");
    writeFileSync(real, "");
    const link = join(tmpDir, "alias.md");
    symlinkSync(real, link);
    expect(isPathAllowed(link, [real])).toBe(true);
  });

  it("rejects a symlink that resolves outside the allowed target", () => {
    writeFileSync(join(tmpDir, "notebook.md"), "");
    writeFileSync(join(tmpDir, "secret.txt"), "");
    const link = join(tmpDir, "alias.md");
    symlinkSync(join(tmpDir, "secret.txt"), link);
    expect(isPathAllowed(link, [join(tmpDir, "notebook.md")])).toBe(false);
  });

  it("rejects access to a sibling reached through a symlinked parent dir", () => {
    const realDir = join(tmpDir, "real-session");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "notebook.md"), "");
    writeFileSync(join(realDir, "secret.txt"), "");
    const linkDir = join(tmpDir, "session");
    symlinkSync(realDir, linkDir);
    // Allowlist points at notebook.md via the symlinked dir; secret.txt
    // is in the same real dir but must still be rejected.
    expect(isPathAllowed(join(linkDir, "secret.txt"), [join(linkDir, "notebook.md")])).toBe(false);
  });

  it("allows a not-yet-existing notebook.md when the parent dir exists", () => {
    // First write to notebook.md: target doesn't exist yet but the cwd does.
    // realResolve should walk up to the (existing) parent and rejoin.
    const target = join(tmpDir, "notebook.md");
    expect(isPathAllowed(target, [target])).toBe(true);
  });
});

describe("shouldBlockTool", () => {
  it("blocks bash unconditionally", () => {
    const result = shouldBlockTool(
      "bash",
      { command: "ls" },
      ["/tmp/loom-session/notebook.md"],
      "/tmp/loom-session",
    );
    expect(result).toEqual({ block: true, reason: expect.stringContaining("bash") });
  });

  it("blocks edit outside allowlist", () => {
    const result = shouldBlockTool(
      "edit",
      { path: "/etc/passwd" },
      ["/tmp/loom-session/notebook.md"],
      "/tmp/loom-session",
    );
    expect(result?.block).toBe(true);
  });

  it("permits edit on notebook.md", () => {
    const result = shouldBlockTool(
      "edit",
      { path: "/tmp/loom-session/notebook.md" },
      ["/tmp/loom-session/notebook.md"],
      "/tmp/loom-session",
    );
    expect(result).toBeUndefined();
  });

  it("permits unrelated tools (e.g. galaxy_invocation_record)", () => {
    const result = shouldBlockTool(
      "galaxy_invocation_record",
      { foo: "bar" },
      ["/tmp/loom-session/notebook.md"],
      "/tmp/loom-session",
    );
    expect(result).toBeUndefined();
  });

  it("blocks grep unconditionally", () => {
    const result = shouldBlockTool(
      "grep",
      { pattern: "API_KEY", path: "/proc/self/environ" },
      ["/tmp/loom-session/notebook.md"],
      "/tmp/loom-session",
    );
    expect(result).toEqual({ block: true, reason: expect.stringContaining("grep") });
  });

  it("blocks find unconditionally", () => {
    const result = shouldBlockTool(
      "find",
      { path: "/", name: "*.env" },
      ["/tmp/loom-session/notebook.md"],
      "/tmp/loom-session",
    );
    expect(result).toEqual({ block: true, reason: expect.stringContaining("find") });
  });

  it("blocks ls unconditionally", () => {
    const result = shouldBlockTool(
      "ls",
      { path: "/etc" },
      ["/tmp/loom-session/notebook.md"],
      "/tmp/loom-session",
    );
    expect(result).toEqual({ block: true, reason: expect.stringContaining("ls") });
  });
});
