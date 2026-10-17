import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setConfigSource } from "../shared/config-source.js";
import { DEFAULT_SKILLS, loadConfig, saveConfig } from "../shared/loom-config.js";

// HOME at an empty temp dir, so the file path has nothing to read and the two
// backends start from the same nothing.
let home: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "loom-config-source-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  setConfigSource(null);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("loadConfig over a config source", () => {
  it("normalises what the shell supplies exactly as it normalises the file", () => {
    const fromFile = loadConfig();
    setConfigSource({ load: () => ({}) });
    const fromSource = loadConfig();
    expect(fromSource).toEqual(fromFile);
    expect(fromSource.skills?.repos).toEqual(DEFAULT_SKILLS);
    expect(fromSource.executionMode).toBe("cloud");
    expect(fromSource.guardian).toEqual({
      enabled: true,
      dangerouslyBypassPermissions: false,
      trustedWorkspaces: [],
      extraWorkspaceRoots: [],
      consentAcknowledged: null,
      sandbox: false,
    });
    expect(fromSource.updateCheck).toBe(true);
    expect(fromSource.ui?.theme).toBe("dark");
  });

  it("applies the same migrations to a source's legacy shape", () => {
    setConfigSource({
      load: () => ({ llm: { provider: "openai", apiKey: "sk-legacy-0000000000" } }) as never,
    });
    expect(loadConfig().llm).toEqual({
      active: "openai",
      providers: { openai: { apiKey: "sk-legacy-0000000000" } },
    });
  });

  it("hands every caller a copy, so a writer mutating the result cannot change the source", () => {
    const raw = { testerId: "t-1", experiments: { autoResume: false } };
    setConfigSource({ load: () => raw });
    const cfg = loadConfig();
    cfg.testerId = "changed";
    cfg.experiments!.autoResume = true;
    expect(raw).toEqual({ testerId: "t-1", experiments: { autoResume: false } });
    expect(loadConfig().testerId).toBe("t-1");
  });

  it("touches no file while a source is installed", () => {
    setConfigSource({ load: () => ({ lessons: { enabled: false } }) });
    const existsSync = vi.spyOn(fs, "existsSync");
    const readFileSync = vi.spyOn(fs, "readFileSync");
    try {
      expect(loadConfig().lessons?.enabled).toBe(false);
      expect(existsSync).not.toHaveBeenCalled();
      expect(readFileSync).not.toHaveBeenCalled();
    } finally {
      existsSync.mockRestore();
      readFileSync.mockRestore();
    }
  });

  it("puts the file back when the source is cleared", () => {
    setConfigSource({ load: () => ({ testerId: "from-shell" }) });
    expect(loadConfig().testerId).toBe("from-shell");
    setConfigSource(null);
    expect(loadConfig().testerId).toBeUndefined();
  });
});

describe("saveConfig over a config source", () => {
  it("refuses when the shell offers no save, so nothing is written anywhere", () => {
    setConfigSource({ load: () => ({}) });
    expect(() => saveConfig(loadConfig())).toThrow(/supplied by the shell/);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("forwards to the shell's save when it offers one", () => {
    const saved: unknown[] = [];
    setConfigSource({ load: () => ({}), save: (config) => void saved.push(config) });
    const cfg = loadConfig();
    cfg.testerId = "t-2";
    saveConfig(cfg);
    expect(saved).toEqual([cfg]);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
