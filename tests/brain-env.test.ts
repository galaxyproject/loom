import { describe, it, expect } from "vitest";
import { buildBrainEnv } from "../shared/brain-env.js";

describe("buildBrainEnv", () => {
  it("forwards the named passthrough set", () => {
    const env = buildBrainEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      LANG: "en_US.UTF-8",
      AWS_ACCESS_KEY_ID: "AKIAleak",
      GITHUB_TOKEN: "ghp_leak",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/me");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("forwards LOOM_/GALAXY_/PI_ prefixed vars", () => {
    const env = buildBrainEnv({
      LOOM_MODE: "remote",
      LOOM_NOTEBOOK_ALLOWLIST: "/tmp/loom-session/notebook.md",
      GALAXY_URL: "https://usegalaxy.org",
      GALAXY_API_KEY: "secret",
      PI_DEBUG: "1",
      LOOMY: "no-underscore",
    });
    expect(env.LOOM_MODE).toBe("remote");
    expect(env.LOOM_NOTEBOOK_ALLOWLIST).toBe("/tmp/loom-session/notebook.md");
    expect(env.GALAXY_URL).toBe("https://usegalaxy.org");
    expect(env.GALAXY_API_KEY).toBe("secret");
    expect(env.PI_DEBUG).toBe("1");
    expect(env.LOOMY).toBeUndefined();
  });

  it("drops provider API keys by default", () => {
    const env = buildBrainEnv({
      ANTHROPIC_API_KEY: "sk-leak",
      OPENAI_API_KEY: "sk-leak",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("forwards provider API keys when includeProviderKeys is set", () => {
    const env = buildBrainEnv(
      {
        ANTHROPIC_API_KEY: "sk-anthropic",
        OPENAI_API_KEY: "sk-openai",
        GEMINI_API_KEY: "sk-gemini",
        XAI_API_KEY: "xai-key",
        AI_GATEWAY_API_KEY: "gw-key",
      },
      { includeProviderKeys: true },
    );
    expect(env.ANTHROPIC_API_KEY).toBe("sk-anthropic");
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
    expect(env.GEMINI_API_KEY).toBe("sk-gemini");
    expect(env.XAI_API_KEY).toBe("xai-key");
    expect(env.AI_GATEWAY_API_KEY).toBe("gw-key");
  });

  it("drops the explicit secrets the docstring lists", () => {
    const env = buildBrainEnv(
      {
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_SECRET_ACCESS_KEY: "shh",
        GITHUB_TOKEN: "ghp_",
        GOOGLE_APPLICATION_CREDENTIALS: "/etc/sa.json",
        ANTHROPIC_API_KEY: "sk-",
      },
      { includeProviderKeys: true },
    );
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    // Provider key still forwarded since includeProviderKeys is on.
    expect(env.ANTHROPIC_API_KEY).toBe("sk-");
  });

  it("ignores undefined values from the source env", () => {
    const env = buildBrainEnv({ PATH: undefined, LOOM_X: undefined });
    expect(env.PATH).toBeUndefined();
    expect(env.LOOM_X).toBeUndefined();
  });
});
