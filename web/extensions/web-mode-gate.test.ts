import { describe, it, expect } from "vitest";
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
});
