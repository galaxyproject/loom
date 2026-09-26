import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildExecutionModeBlock,
  buildLocalEnvContext,
  buildNoLocalShellBlock,
} from "../extensions/loom/context.js";

describe("context blocks under LOOM_LOCAL_SHELL", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.LOOM_LOCAL_SHELL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.LOOM_LOCAL_SHELL;
    else process.env.LOOM_LOCAL_SHELL = saved;
  });

  it("omits the local conda/bash guidance when there is no local shell", () => {
    process.env.LOOM_LOCAL_SHELL = "off";
    expect(buildLocalEnvContext()).toBe("");
  });

  it("injects a remote-only execution note when there is no local shell", () => {
    process.env.LOOM_LOCAL_SHELL = "off";
    const block = buildNoLocalShellBlock();
    expect(block).not.toBe("");
    expect(block).toMatch(/Galaxy/);
    expect(block.toLowerCase()).toMatch(/no local shell|remote-only/);
  });

  it("keeps the local conda/bash guidance when a local shell is available (mac/linux)", () => {
    delete process.env.LOOM_LOCAL_SHELL;
    expect(buildLocalEnvContext()).toMatch(/conda/);
  });

  it("emits no remote-only note when a local shell is available", () => {
    delete process.env.LOOM_LOCAL_SHELL;
    expect(buildNoLocalShellBlock()).toBe("");
  });

  it("drops the Local execution-mode block when there is no local shell", () => {
    process.env.LOOM_LOCAL_SHELL = "off";
    expect(buildExecutionModeBlock()).toBe("");
  });
});

describe("buildLocalEnvContext names the workspace's own state dir", () => {
  let saved: string | undefined;
  let cwd: string;
  beforeEach(() => {
    saved = process.env.LOOM_LOCAL_SHELL;
    delete process.env.LOOM_LOCAL_SHELL;
    cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loom-env-ctx-")));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.LOOM_LOCAL_SHELL;
    else process.env.LOOM_LOCAL_SHELL = saved;
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("points a new workspace at .loom/env", () => {
    const block = buildLocalEnvContext(cwd);
    expect(block).toContain("conda create -p .loom/env");
    expect(block).not.toContain(".orbit");
  });

  it("points an .orbit workspace at .orbit/env everywhere", () => {
    fs.mkdirSync(path.join(cwd, ".orbit"));
    const block = buildLocalEnvContext(cwd);
    expect(block).toContain("conda create -p .orbit/env");
    expect(block).toContain(".orbit/env/bin/foldseek");
    expect(block).not.toContain(".loom");
  });

  it("keeps the name it resolved first for the rest of the session", () => {
    // The prompt is one cached block; the agent creating a dir mid-session must
    // not rename the env out from under it.
    const first = buildLocalEnvContext(cwd);
    fs.mkdirSync(path.join(cwd, ".orbit"));
    expect(buildLocalEnvContext(cwd)).toBe(first);
  });
});
