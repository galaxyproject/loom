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
