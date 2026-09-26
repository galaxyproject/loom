import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mirrorToLegacyEnv } from "../shared/orbit-env.js";
import { buildBrainEnv } from "../shared/brain-env.js";
import { ACTIVE_LLM_API_KEY_ENV } from "../shared/custom-provider.js";
import { collectSecretValues } from "../extensions/loom/secret-redaction";

// pi looks the custom-provider key up by the one name models.json gives it,
// and the web BYO-key check does the same, so a key supplied only under the
// ORBIT_ spelling has to reach the LOOM_ one.

describe("mirrorToLegacyEnv", () => {
  it("copies an ORBIT_ value onto an unset legacy name", () => {
    const env: Record<string, string | undefined> = { ORBIT_ACTIVE_LLM_API_KEY: "k" };
    mirrorToLegacyEnv(env, "ACTIVE_LLM_API_KEY");
    expect(env.LOOM_ACTIVE_LLM_API_KEY).toBe("k");
  });

  it("leaves a legacy value that is already set alone", () => {
    const env = { ORBIT_ACTIVE_LLM_API_KEY: "ambient", LOOM_ACTIVE_LLM_API_KEY: "shell" };
    mirrorToLegacyEnv(env, "ACTIVE_LLM_API_KEY");
    expect(env.LOOM_ACTIVE_LLM_API_KEY).toBe("shell");
  });

  it("treats an empty legacy value as unset", () => {
    const env = { ORBIT_ACTIVE_LLM_API_KEY: "new", LOOM_ACTIVE_LLM_API_KEY: "" };
    mirrorToLegacyEnv(env, "ACTIVE_LLM_API_KEY");
    expect(env.LOOM_ACTIVE_LLM_API_KEY).toBe("new");
  });

  it("does not mirror an empty ORBIT_ value", () => {
    const env: Record<string, string | undefined> = { ORBIT_ACTIVE_LLM_API_KEY: "" };
    mirrorToLegacyEnv(env, "ACTIVE_LLM_API_KEY");
    expect(env.LOOM_ACTIVE_LLM_API_KEY).toBeUndefined();
  });

  it("does nothing without an ORBIT_ value", () => {
    const env: Record<string, string | undefined> = {};
    mirrorToLegacyEnv(env, "ACTIVE_LLM_API_KEY");
    expect(env).toEqual({});
  });

  it("uses the alias table for renamed clashes", () => {
    const env: Record<string, string | undefined> = { ORBIT_CORE_BIN: "/x" };
    mirrorToLegacyEnv(env, "CORE_BIN");
    expect(env.LOOM_BIN).toBe("/x");
  });
});

describe("buildBrainEnv", () => {
  it("hands the brain the key under the name pi resolves", () => {
    const env = buildBrainEnv({ ORBIT_ACTIVE_LLM_API_KEY: "sk-orbit" });
    expect(ACTIVE_LLM_API_KEY_ENV).toBe("LOOM_ACTIVE_LLM_API_KEY");
    expect(env[ACTIVE_LLM_API_KEY_ENV]).toBe("sk-orbit");
    expect(env.ORBIT_ACTIVE_LLM_API_KEY).toBe("sk-orbit");
  });

  it("does not let an ambient ORBIT_ key replace a LOOM_ key", () => {
    const env = buildBrainEnv({
      ORBIT_ACTIVE_LLM_API_KEY: "ambient",
      LOOM_ACTIVE_LLM_API_KEY: "deliberate",
    });
    expect(env.LOOM_ACTIVE_LLM_API_KEY).toBe("deliberate");
  });

  it("fills in an empty LOOM_ key from ORBIT_", () => {
    const env = buildBrainEnv({ ORBIT_ACTIVE_LLM_API_KEY: "new", LOOM_ACTIVE_LLM_API_KEY: "" });
    expect(env.LOOM_ACTIVE_LLM_API_KEY).toBe("new");
  });
});

describe("redaction", () => {
  it("redacts an ORBIT_-only key", () => {
    const secret = "sk-orbit-only-0123456789";
    expect(collectSecretValues({} as never, { ORBIT_ACTIVE_LLM_API_KEY: secret })).toContain(
      secret,
    );
  });
});

describe("entry points", () => {
  const REPO = resolve(__dirname, "..");
  it.each(["web/server.ts", "bin/loom.js"])("%s mirrors the key at startup", (f) => {
    const src = readFileSync(resolve(REPO, f), "utf-8");
    expect(src).toMatch(/mirrorToLegacyEnv\(process\.env, "ACTIVE_LLM_API_KEY"\)/);
  });
});
