import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  MIGRATE_TO_ORBIT_STATE_DIR,
  MOVED_MARKER_FILE,
  migrateStateDir,
  resolveCliVersionCheckPath,
  resolveConfigPath,
  resolveDefaultAnalysesDir,
  resolveStateDir,
} from "../shared/state-dir.js";

// Every test runs against a throwaway HOME, passed explicitly (and, for the
// integration cases, via a homedir spy) so the real ~/.loom and ~/.orbit are
// never read or written.
let home: string;
let loom: string;
let orbit: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "loom-state-home-"));
  loom = path.join(home, ".loom");
  orbit = path.join(home, ".orbit");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function put(file: string, content: string | Buffer = "{}", mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

const both = [false, true] as const;
const posixOnly = process.platform === "win32" ? it.skip : it;

describe("resolveStateDir", () => {
  it("keeps a fresh machine on ~/.loom until migration is switched on", () => {
    expect(resolveStateDir({ home, migrate: false })).toBe(loom);
    expect(resolveStateDir({ home, migrate: true })).toBe(orbit);
  });

  it("keeps a loom-only machine on ~/.loom", () => {
    put(path.join(loom, "config.json"));
    for (const migrate of both) expect(resolveStateDir({ home, migrate })).toBe(loom);
  });

  it("uses ~/.orbit once it holds a config", () => {
    put(path.join(orbit, "config.json"));
    for (const migrate of both) expect(resolveStateDir({ home, migrate })).toBe(orbit);
  });

  it("prefers ~/.orbit when both have a config", () => {
    put(path.join(loom, "config.json"));
    put(path.join(orbit, "config.json"));
    for (const migrate of both) expect(resolveStateDir({ home, migrate })).toBe(orbit);
  });

  it("ignores a ~/.orbit that only holds desktop shell state", () => {
    put(path.join(orbit, "window-state.json"));
    put(path.join(orbit, "version-check.json"));
    expect(resolveStateDir({ home, migrate: false })).toBe(loom);
  });
});

describe("resolveConfigPath", () => {
  it("is config.json in the state dir", () => {
    expect(resolveConfigPath({ home, migrate: false })).toBe(path.join(loom, "config.json"));
    put(path.join(orbit, "config.json"));
    expect(resolveConfigPath({ home })).toBe(path.join(orbit, "config.json"));
  });
});

describe("resolveCliVersionCheckPath", () => {
  it("keeps the old name in ~/.loom", () => {
    expect(resolveCliVersionCheckPath({ home, migrate: false })).toBe(
      path.join(loom, "version-check.json"),
    );
  });

  it("never lands on the desktop's ~/.orbit/version-check.json", () => {
    put(path.join(orbit, "config.json"));
    const p = resolveCliVersionCheckPath({ home });
    expect(p).toBe(path.join(orbit, "cli-version-check.json"));
    expect(resolveCliVersionCheckPath({ home, migrate: true })).toBe(p);
  });

  it("uses the namespaced name on a fresh machine after the flip", () => {
    expect(resolveCliVersionCheckPath({ home, migrate: true })).toBe(
      path.join(orbit, "cli-version-check.json"),
    );
  });
});

describe("resolveDefaultAnalysesDir", () => {
  it("is ~/.loom/analyses on a fresh machine today and ~/.orbit/analyses after the flip", () => {
    expect(resolveDefaultAnalysesDir({ home, migrate: false })).toBe(path.join(loom, "analyses"));
    expect(resolveDefaultAnalysesDir({ home, migrate: true })).toBe(path.join(orbit, "analyses"));
  });

  it("keeps an existing ~/.loom/analyses even after the config moves", () => {
    fs.mkdirSync(path.join(loom, "analyses"), { recursive: true });
    put(path.join(orbit, "config.json"));
    for (const migrate of both) {
      expect(resolveDefaultAnalysesDir({ home, migrate })).toBe(path.join(loom, "analyses"));
    }
  });

  it("switches to ~/.orbit/analyses once that exists", () => {
    fs.mkdirSync(path.join(loom, "analyses"), { recursive: true });
    fs.mkdirSync(path.join(orbit, "analyses"), { recursive: true });
    put(path.join(orbit, "config.json"));
    expect(resolveDefaultAnalysesDir({ home })).toBe(path.join(orbit, "analyses"));
  });

  it("follows the state dir for an orbit-only machine", () => {
    put(path.join(orbit, "config.json"));
    expect(resolveDefaultAnalysesDir({ home })).toBe(path.join(orbit, "analyses"));
  });
});

describe("migrateStateDir", () => {
  // Shaped like a real config: encrypted blobs are opaque base64 that must
  // survive untouched, so the fixture also carries odd whitespace and no
  // trailing newline to catch any parse/re-serialize.
  const encrypted = randomBytes(96).toString("base64");
  const configBytes = Buffer.from(
    `{"llm":{"active":"anthropic","providers":{"anthropic":{"apiKeyEncrypted":"${encrypted}"}}},\n` +
      `  "galaxy":{"active":"eu","profiles":{"eu":{"url":"https://usegalaxy.eu","apiKeyEncrypted":"${encrypted}"}}},` +
      `"note":"café → ok"}`,
    "utf-8",
  );

  function seedLoom(mode = 0o600) {
    put(path.join(loom, "config.json"), configBytes, mode);
    put(path.join(loom, "whats-new-seen.json"), '{"version":"0.7.0"}');
    put(path.join(loom, "version-check.json"), '{"fetchedAt":1}');
    put(path.join(loom, "sessions-index.db"), "db");
    put(path.join(loom, "cache", "skills", "galaxy-skills@abc", "SKILL.md"), "x");
    fs.mkdirSync(path.join(loom, "analyses", "demo"), { recursive: true });
  }

  it("is off in this release", () => {
    expect(MIGRATE_TO_ORBIT_STATE_DIR).toBe(false);
    seedLoom();
    expect(migrateStateDir({ home })).toEqual({ status: "disabled" });
    expect(fs.existsSync(orbit)).toBe(false);
    expect(fs.existsSync(path.join(loom, MOVED_MARKER_FILE))).toBe(false);
  });

  it("does nothing on a fresh machine", () => {
    expect(migrateStateDir({ home, enabled: true }).status).toBe("nothing-to-migrate");
    expect(fs.existsSync(orbit)).toBe(false);
  });

  it("copies config.json byte-for-byte and switches the resolver over", () => {
    seedLoom();
    expect(migrateStateDir({ home, enabled: true }).status).toBe("migrated");
    const copied = fs.readFileSync(path.join(orbit, "config.json"));
    expect(copied.equals(configBytes)).toBe(true);
    expect(copied.toString("utf-8")).toContain(encrypted);
    expect(resolveStateDir({ home, migrate: true })).toBe(orbit);
  });

  posixOnly("writes the copy as 0600, even from a looser source", () => {
    seedLoom(0o644);
    migrateStateDir({ home, enabled: true });
    expect(fs.statSync(path.join(orbit, "config.json")).mode & 0o777).toBe(0o600);
  });

  posixOnly("keeps 0600 from a 0600 source", () => {
    seedLoom(0o600);
    migrateStateDir({ home, enabled: true });
    expect(fs.statSync(path.join(orbit, "config.json")).mode & 0o777).toBe(0o600);
  });

  it("copies the what's-new stamp but not caches or the version check", () => {
    seedLoom();
    migrateStateDir({ home, enabled: true });
    expect(fs.readFileSync(path.join(orbit, "whats-new-seen.json"), "utf-8")).toBe(
      '{"version":"0.7.0"}',
    );
    for (const left of ["cache", "sessions-index.db", "version-check.json", "analyses"]) {
      expect(fs.existsSync(path.join(orbit, left)), left).toBe(false);
    }
    expect(fs.existsSync(path.join(orbit, "cli-version-check.json"))).toBe(false);
  });

  it("leaves ~/.loom intact and writes the marker", () => {
    seedLoom();
    migrateStateDir({ home, enabled: true, now: new Date("2026-10-01T00:00:00Z") });
    expect(fs.readFileSync(path.join(loom, "config.json")).equals(configBytes)).toBe(true);
    expect(fs.existsSync(path.join(loom, "cache", "skills", "galaxy-skills@abc", "SKILL.md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(loom, "analyses", "demo"))).toBe(true);
    const marker = fs.readFileSync(path.join(loom, MOVED_MARKER_FILE), "utf-8");
    expect(marker).toContain(path.join(orbit, "config.json"));
    expect(marker).toContain("2026-10-01");
    expect(marker).toContain(path.join(loom, "analyses"));
  });

  it("leaves no staging files behind", () => {
    seedLoom();
    migrateStateDir({ home, enabled: true });
    expect(fs.readdirSync(orbit).filter((f) => f.includes(".migrating-"))).toEqual([]);
  });

  it("is idempotent and never overwrites the new copy", () => {
    seedLoom();
    migrateStateDir({ home, enabled: true, now: new Date("2026-10-01T00:00:00Z") });
    const marker = fs.readFileSync(path.join(loom, MOVED_MARKER_FILE), "utf-8");
    // The user changes settings after migrating; a second run must not revert them.
    fs.writeFileSync(path.join(orbit, "config.json"), '{"changed":true}');
    expect(
      migrateStateDir({ home, enabled: true, now: new Date("2027-01-01T00:00:00Z") }).status,
    ).toBe("already-migrated");
    expect(fs.readFileSync(path.join(orbit, "config.json"), "utf-8")).toBe('{"changed":true}');
    expect(fs.readFileSync(path.join(loom, MOVED_MARKER_FILE), "utf-8")).toBe(marker);
  });

  it("does not disturb desktop state already in ~/.orbit", () => {
    seedLoom();
    put(path.join(orbit, "window-state.json"), '{"width":1}');
    put(path.join(orbit, "version-check.json"), '{"desktop":true}');
    put(path.join(orbit, "whats-new-seen.json"), '{"version":"0.9.0"}');
    expect(migrateStateDir({ home, enabled: true }).status).toBe("migrated");
    expect(fs.readFileSync(path.join(orbit, "window-state.json"), "utf-8")).toBe('{"width":1}');
    expect(fs.readFileSync(path.join(orbit, "version-check.json"), "utf-8")).toBe(
      '{"desktop":true}',
    );
    expect(fs.readFileSync(path.join(orbit, "whats-new-seen.json"), "utf-8")).toBe(
      '{"version":"0.9.0"}',
    );
  });

  it("reports a failure without touching ~/.loom", () => {
    seedLoom();
    put(orbit, "not a directory");
    const result = migrateStateDir({ home, enabled: true });
    expect(result.status).toBe("failed");
    expect(fs.readFileSync(path.join(loom, "config.json")).equals(configBytes)).toBe(true);
    expect(fs.existsSync(path.join(loom, MOVED_MARKER_FILE))).toBe(false);
    expect(resolveStateDir({ home, migrate: true })).toBe(loom);
  });
});

describe("callers follow the resolver", () => {
  beforeEach(() => {
    vi.spyOn(os, "homedir").mockReturnValue(home);
  });

  it("loadConfig/saveConfig use ~/.orbit when it holds the config", async () => {
    put(path.join(loom, "config.json"), JSON.stringify({ testerId: "old" }));
    put(path.join(orbit, "config.json"), JSON.stringify({ testerId: "new" }));
    const { loadConfig, saveConfig } = await import("../shared/loom-config.js");
    const cfg = loadConfig();
    expect(cfg.testerId).toBe("new");
    saveConfig({ ...cfg, testerId: "newer" });
    expect(JSON.parse(fs.readFileSync(path.join(orbit, "config.json"), "utf-8")).testerId).toBe(
      "newer",
    );
    expect(JSON.parse(fs.readFileSync(path.join(loom, "config.json"), "utf-8")).testerId).toBe(
      "old",
    );
  });

  it("saveConfig writes ~/.loom on a fresh machine in this release", async () => {
    const { saveConfig } = await import("../shared/loom-config.js");
    saveConfig({ testerId: "x" });
    expect(fs.existsSync(path.join(loom, "config.json"))).toBe(true);
    expect(fs.existsSync(orbit)).toBe(false);
  });

  it("the CLI update check reads its own cache file in ~/.orbit", async () => {
    put(path.join(orbit, "config.json"));
    // A well-formed entry, so a null read proves the file was never consulted.
    put(
      path.join(orbit, "version-check.json"),
      JSON.stringify({ fetchedAt: Date.now(), latest: "1.0.0", channel: "latest" }),
    );
    const { readCache } = await import("../bin/update-check.js");
    expect(readCache()).toBeNull();
    put(
      path.join(orbit, "cli-version-check.json"),
      JSON.stringify({ fetchedAt: Date.now(), latest: "9.9.9", channel: "latest" }),
    );
    expect(readCache()).toMatchObject({ latest: "9.9.9" });
  });
});
