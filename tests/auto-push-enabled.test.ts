import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const loadConfigMock = vi.fn();

vi.mock("../extensions/loom/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

import { isAutoPushEnabled } from "../extensions/loom/auto-push-bridge";

describe("isAutoPushEnabled", () => {
  const originalEnv = process.env.LOOM_AUTO_PUSH;

  beforeEach(() => {
    delete process.env.LOOM_AUTO_PUSH;
    loadConfigMock.mockReset();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LOOM_AUTO_PUSH;
    else process.env.LOOM_AUTO_PUSH = originalEnv;
  });

  it("defaults off when env is unset and config has no experiments block", () => {
    loadConfigMock.mockReturnValue({});
    expect(isAutoPushEnabled()).toBe(false);
  });

  it("is on when config opts in and env is unset", () => {
    loadConfigMock.mockReturnValue({ experiments: { autoPush: true } });
    expect(isAutoPushEnabled()).toBe(true);
  });

  it("env=1 forces on even when config is off", () => {
    process.env.LOOM_AUTO_PUSH = "1";
    loadConfigMock.mockReturnValue({ experiments: { autoPush: false } });
    expect(isAutoPushEnabled()).toBe(true);
  });

  it("env=0 forces off even when config is on", () => {
    process.env.LOOM_AUTO_PUSH = "0";
    loadConfigMock.mockReturnValue({ experiments: { autoPush: true } });
    expect(isAutoPushEnabled()).toBe(false);
  });

  it("ignores garbage env values and falls through to config", () => {
    process.env.LOOM_AUTO_PUSH = "yes";
    loadConfigMock.mockReturnValue({ experiments: { autoPush: true } });
    expect(isAutoPushEnabled()).toBe(true);
  });
});
