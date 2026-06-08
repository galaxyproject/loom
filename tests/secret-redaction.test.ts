import { describe, it, expect } from "vitest";
import {
  collectSecretValues,
  redactSecrets,
  redactContent,
  REDACTED,
} from "../extensions/loom/secret-redaction";

describe("collectSecretValues", () => {
  it("gathers plaintext + encrypted keys from llm providers and galaxy profiles", () => {
    const config = {
      llm: {
        active: "anthropic",
        providers: {
          anthropic: { apiKey: "sk-ant-PLAINTEXT-000000000" },
          google: { apiKeyEncrypted: "ENCRYPTEDBLOBaaaaaaaa==" },
        },
      },
      galaxy: {
        active: "main",
        profiles: { main: { apiKey: "galaxy-key-1111111111" } },
      },
    } as never;
    const secrets = collectSecretValues(config, {});
    expect(secrets).toContain("sk-ant-PLAINTEXT-000000000");
    expect(secrets).toContain("ENCRYPTEDBLOBaaaaaaaa==");
    expect(secrets).toContain("galaxy-key-1111111111");
  });

  it("includes the secret-valued env vars the agent process carries at runtime", () => {
    const secrets = collectSecretValues({} as never, {
      GALAXY_API_KEY: "galaxy-env-2222222222",
      ANTHROPIC_API_KEY: "sk-ant-env-3333333333",
      // Custom OpenAI-compatible endpoint key the brain receives as --api-key.
      // With the dev/CI env fallback it can arrive in the env without ever
      // touching config, so its value must still be redactable.
      LOOM_ACTIVE_LLM_API_KEY: "loom-active-env-4444444444",
      PATH: "/usr/bin", // not a secret var -> ignored
    });
    expect(secrets).toContain("galaxy-env-2222222222");
    expect(secrets).toContain("sk-ant-env-3333333333");
    expect(secrets).toContain("loom-active-env-4444444444");
    expect(secrets).not.toContain("/usr/bin");
  });

  it("ignores short/empty values so ordinary output isn't mangled", () => {
    const config = { llm: { active: "x", providers: { x: { apiKey: "abc" } } } } as never;
    expect(collectSecretValues(config, { GALAXY_API_KEY: "" })).toEqual([]);
  });

  it("tolerates a config with no llm/galaxy sections", () => {
    expect(collectSecretValues({} as never, {})).toEqual([]);
  });
});

describe("redactSecrets", () => {
  const KEY = "sk-ant-api03-SECRETVALUE-9999";
  it("replaces every occurrence of a known secret", () => {
    const out = redactSecrets(`key=${KEY} and again ${KEY}`, [KEY]);
    expect(out).not.toContain(KEY);
    expect(out).toBe(`key=${REDACTED} and again ${REDACTED}`);
  });
  it("leaves text untouched when no secret is present", () => {
    expect(redactSecrets("nothing secret here", [KEY])).toBe("nothing secret here");
  });
  it("redacts the longer secret first when one contains another", () => {
    const short = "longenoughsecret";
    const long = "longenoughsecret-with-suffix";
    expect(redactSecrets(`val=${long}`, [short, long])).toBe(`val=${REDACTED}`);
  });
  it("ignores empty/short secrets", () => {
    expect(redactSecrets("abc value", ["", "ab"])).toBe("abc value");
  });
});

describe("redactContent", () => {
  const KEY = "sk-ant-SECRET-444444444444";
  it("redacts text content and returns a changed copy without mutating the original", () => {
    const content = [{ type: "text", text: `here is ${KEY}` }];
    const out = redactContent(content, [KEY]);
    expect(out).not.toBeNull();
    expect(out?.[0].text).toBe(`here is ${REDACTED}`);
    expect(content[0].text).toBe(`here is ${KEY}`); // original untouched
  });
  it("returns null when nothing changed, so the hook can no-op", () => {
    expect(redactContent([{ type: "text", text: "clean" }], [KEY])).toBeNull();
    expect(redactContent([{ type: "text", text: "x" }], [])).toBeNull();
  });
  it("leaves non-text content (images) alone", () => {
    const content = [{ type: "image", data: "binarydata", mimeType: "image/png" }];
    expect(redactContent(content, [KEY])).toBeNull();
  });
});
