import { afterEach, describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  collectSecretValues,
  currentSecretValues,
  loadPiAuth,
  redactSecrets,
  redactContent,
  REDACTED,
} from "../extensions/loom/secret-redaction";
import { setGalaxyTransport } from "../extensions/loom/galaxy-api";
import { setConfigSource } from "../shared/config-source.js";

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

  it("takes extra values a caller already holds, under the same length rule", () => {
    const secrets = collectSecretValues({} as never, {}, null, [
      "extra-key-000000",
      "short",
      7,
      null,
    ]);
    expect(secrets).toEqual(["extra-key-000000"]);
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

describe("pi auth.json (the credentials Loom cannot encrypt at rest)", () => {
  it("collects both halves of an OAuth credential", () => {
    const auth = {
      "openai-codex": {
        type: "oauth",
        access: "eyJhbGciOiJSUzI1NiJ9.ACCESS-TOKEN-PAYLOAD",
        refresh: "REFRESH-TOKEN-4444444444",
        expires: 1789154768797,
        accountId: "d29d5ca8-0000-0000-0000-00000000d1ce",
      },
    };
    const secrets = collectSecretValues({} as never, {}, auth);
    expect(secrets).toContain("eyJhbGciOiJSUzI1NiJ9.ACCESS-TOKEN-PAYLOAD");
    // The refresh half matters more than the access half -- it mints new tokens
    // long after the access JWT in the same file has expired.
    expect(secrets).toContain("REFRESH-TOKEN-4444444444");
  });

  it("collects an api-key credential's key and its nested env values", () => {
    const auth = {
      cloudflare: {
        type: "api_key",
        key: "cf-key-5555555555",
        env: { CLOUDFLARE_ACCOUNT_ID: "acct-6666666666" },
      },
    };
    const secrets = collectSecretValues({} as never, {}, auth);
    expect(secrets).toContain("cf-key-5555555555");
    expect(secrets).toContain("acct-6666666666");
  });

  it("does not collect the type discriminator or the expiry", () => {
    // Redacting "oauth" would scrub the word out of unrelated prose.
    const auth = { p: { type: "api_key_long_enough", expires: "1789154768797" } };
    expect(collectSecretValues({} as never, {}, auth)).toHaveLength(0);
  });

  it("scrubs a dumped auth.json end to end", () => {
    const auth = {
      "openai-codex": { type: "oauth", access: "ACCESS-7777777777", refresh: "REFRESH-8888888888" },
    };
    const secrets = collectSecretValues({} as never, {}, auth);
    const out = redactSecrets(JSON.stringify(auth), secrets);
    expect(out).not.toContain("ACCESS-7777777777");
    expect(out).not.toContain("REFRESH-8888888888");
    expect(out).toContain(REDACTED);
  });

  it("tolerates a missing, unreadable, or malformed store", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-auth-"));
    expect(loadPiAuth(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "auth.json"), "{ not json");
    expect(loadPiAuth(dir)).toBeNull();
    // A null store must not throw or poison the rest of the collection.
    expect(collectSecretValues({} as never, { GALAXY_API_KEY: "gx-9999999999" }, null)).toContain(
      "gx-9999999999",
    );
  });

  it("reads a real store from PI_CODING_AGENT_DIR", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-auth-"));
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ p: { type: "oauth", access: "DISK-ACCESS-0000000000" } }),
    );
    expect(collectSecretValues({} as never, {}, loadPiAuth(dir))).toContain(
      "DISK-ACCESS-0000000000",
    );
  });
});

describe("currentSecretValues (what the hooks scrub right now)", () => {
  let dir: string;
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PI: process.env.PI_CODING_AGENT_DIR,
  };
  afterEach(() => {
    setGalaxyTransport(null);
    setConfigSource(null);
    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    if (prev.PI === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev.PI;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function sandbox(): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-current-secrets-"));
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
    fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "agent", "auth.json"),
      JSON.stringify({ p: { type: "oauth", access: "AUTH-JSON-TOKEN-00000" } }),
    );
  }

  it("reads pi's auth.json and the transport's Galaxy key on the default path", () => {
    sandbox();
    setGalaxyTransport({
      credentials: () => ({ url: "http://g.test", apiKey: "transport-key-1234567" }),
    });
    const secrets = currentSecretValues();
    expect(secrets).toContain("AUTH-JSON-TOKEN-00000");
    expect(secrets).toContain("transport-key-1234567");
  });

  it("leaves auth.json out for the activity log and lesson text (auth: false)", () => {
    sandbox();
    setGalaxyTransport({
      credentials: () => ({ url: "http://g.test", apiKey: "transport-key-1234567" }),
    });
    const secrets = currentSecretValues({ auth: false });
    expect(secrets).toContain("transport-key-1234567");
    expect(secrets).not.toContain("AUTH-JSON-TOKEN-00000");
  });

  it("takes the shell's list instead of auth.json while a config source is installed", () => {
    sandbox();
    setGalaxyTransport({
      credentials: () => ({ url: "http://g.test", apiKey: "transport-key-1234567" }),
    });
    setConfigSource({
      load: () => ({ llm: { active: "x", providers: { x: { apiKey: "source-config-key-000" } } } }),
      secrets: () => ["shell-held-secret-000"],
    });
    const secrets = currentSecretValues();
    expect(secrets).toContain("transport-key-1234567");
    expect(secrets).toContain("source-config-key-000");
    expect(secrets).toContain("shell-held-secret-000");
    expect(secrets).not.toContain("AUTH-JSON-TOKEN-00000");
  });
});
