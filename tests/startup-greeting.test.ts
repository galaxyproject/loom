import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { planStartupGreeting, sendStartupGreeting } from "../extensions/loom/session-lifecycle.js";

describe("planStartupGreeting", () => {
  it("usable -> a model turn that nudges galaxy_connect", () => {
    const action = planStartupGreeting("usable", false);
    expect(action.kind).toBe("model");
    if (action.kind === "model") expect(action.message).toContain("galaxy_connect");
  });

  it("configured-unusable -> a warning notify naming Orbit and GALAXY_API_KEY", () => {
    const action = planStartupGreeting("configured-unusable", false);
    expect(action.kind).toBe("notify");
    if (action.kind === "notify") {
      expect(action.level).toBe("warning");
      expect(action.text).toContain("GALAXY_API_KEY");
      expect(action.text).toContain("Orbit");
    }
  });

  it("none -> an info notify pointing at /connect", () => {
    const action = planStartupGreeting("none", false);
    expect(action.kind).toBe("notify");
    if (action.kind === "notify") {
      expect(action.level).toBe("info");
      expect(action.text).toContain("/connect");
    }
  });
});

// Dispatch: the greeting reads the live config + env (activeGalaxyStatus) and
// routes to a model turn or a static notify. Sandbox HOME so the on-disk config
// is ours; fake pi/ctx so we can see which channel fired.
describe("sendStartupGreeting (dispatch)", () => {
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let sandboxHome: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-greeting-test-"));
    process.env.HOME = sandboxHome;
    process.env.USERPROFILE = sandboxHome;
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.LOOM_SHELL_KIND;
    fs.mkdirSync(path.join(sandboxHome, ".loom"), { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    try {
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    } catch {}
  });

  function writeConfig(galaxy: unknown): void {
    const cfg = { llm: { active: "anthropic", providers: { anthropic: { apiKey: "k" } } }, galaxy };
    fs.writeFileSync(path.join(sandboxHome, ".loom", "config.json"), JSON.stringify(cfg));
  }

  function fakes() {
    const pi = { sendUserMessage: vi.fn() };
    const ctx = { ui: { notify: vi.fn() } };
    return { pi, ctx };
  }

  it("usable (encrypted profile + Orbit-injected env) -> model turn, no notify", () => {
    writeConfig({
      active: "default",
      profiles: { default: { url: "https://x.galaxyproject.org", apiKeyEncrypted: "ZW5j" } },
    });
    process.env.GALAXY_URL = "https://x.galaxyproject.org";
    process.env.GALAXY_API_KEY = "injected-by-orbit";
    const { pi, ctx } = fakes();
    sendStartupGreeting(pi as never, ctx as never);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("encrypted-only profile, no env -> warning notify, no model turn", () => {
    writeConfig({
      active: "default",
      profiles: { default: { url: "https://x.galaxyproject.org", apiKeyEncrypted: "ZW5j" } },
    });
    const { pi, ctx } = fakes();
    sendStartupGreeting(pi as never, ctx as never);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify.mock.calls[0][1]).toBe("warning");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("no active profile -> info notify, no model turn", () => {
    writeConfig({ active: null, profiles: {} });
    const { pi, ctx } = fakes();
    sendStartupGreeting(pi as never, ctx as never);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify.mock.calls[0][1]).toBe("info");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});
