import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NEW_WORKSPACE_STATE_DIR_NAME,
  WORKSPACE_STATE_DIR_NAMES,
  resolveWorkspaceStateDir,
  resolveWorkspaceStateDirName,
} from "../extensions/loom/workspace-state-dir";

let cwd: string;
beforeEach(() => {
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loom-state-dir-")));
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("resolveWorkspaceStateDirName", () => {
  it("knows both spellings", () => {
    expect([...WORKSPACE_STATE_DIR_NAMES].sort()).toEqual([".loom", ".orbit"]);
  });

  it("a workspace with neither gets the new-workspace default, still .loom in this release", () => {
    expect(NEW_WORKSPACE_STATE_DIR_NAME).toBe(".loom");
    expect(resolveWorkspaceStateDirName(cwd)).toBe(".loom");
    expect(resolveWorkspaceStateDir(cwd)).toBe(path.join(cwd, ".loom"));
  });

  it("keeps an existing .loom", () => {
    fs.mkdirSync(path.join(cwd, ".loom"));
    expect(resolveWorkspaceStateDirName(cwd)).toBe(".loom");
  });

  it("uses an existing .orbit", () => {
    fs.mkdirSync(path.join(cwd, ".orbit"));
    expect(resolveWorkspaceStateDirName(cwd)).toBe(".orbit");
    expect(resolveWorkspaceStateDir(cwd)).toBe(path.join(cwd, ".orbit"));
  });

  it("prefers .orbit when both exist", () => {
    fs.mkdirSync(path.join(cwd, ".loom"));
    fs.mkdirSync(path.join(cwd, ".orbit"));
    expect(resolveWorkspaceStateDirName(cwd)).toBe(".orbit");
  });

  it("ignores a plain file named .orbit", () => {
    fs.mkdirSync(path.join(cwd, ".loom"));
    fs.writeFileSync(path.join(cwd, ".orbit"), "");
    expect(resolveWorkspaceStateDirName(cwd)).toBe(".loom");
  });
});
