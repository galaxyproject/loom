import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  galaxyCredFingerprint,
  shouldNudgeReconnect,
  fingerprintPath,
  readStoredFingerprint,
  writeStoredFingerprint,
  maybeNudgeGalaxyReconnect,
  recordGalaxyConnected,
} from "../extensions/loom/galaxy-cred-drift.js";

describe("galaxyCredFingerprint", () => {
  it("is stable for the same url+key", () => {
    const a = galaxyCredFingerprint("https://x.galaxyproject.org", "key-A");
    const b = galaxyCredFingerprint("https://x.galaxyproject.org", "key-A");
    expect(a).toBe(b);
  });

  it("changes when the key changes (same url)", () => {
    const a = galaxyCredFingerprint("https://x.galaxyproject.org", "key-A");
    const b = galaxyCredFingerprint("https://x.galaxyproject.org", "key-B");
    expect(a).not.toBe(b);
  });

  it("changes when the url changes (same key)", () => {
    const a = galaxyCredFingerprint("https://a.galaxyproject.org", "key-A");
    const b = galaxyCredFingerprint("https://b.galaxyproject.org", "key-A");
    expect(a).not.toBe(b);
  });

  it("does not embed the raw key (one-way hash)", () => {
    const fp = galaxyCredFingerprint("https://x.galaxyproject.org", "super-secret-key");
    expect(fp).not.toContain("super-secret-key");
  });
});

describe("shouldNudgeReconnect", () => {
  const fpA = galaxyCredFingerprint("https://x.galaxyproject.org", "key-A");
  const fpB = galaxyCredFingerprint("https://x.galaxyproject.org", "key-B");

  it("nudges on a resume when creds changed and a baseline exists", () => {
    expect(shouldNudgeReconnect({ stored: fpA, current: fpB, isResume: true })).toBe(true);
  });

  it("stays quiet on a resume when creds are unchanged", () => {
    expect(shouldNudgeReconnect({ stored: fpA, current: fpA, isResume: true })).toBe(false);
  });

  it("stays quiet on the first resume (no stored baseline)", () => {
    expect(shouldNudgeReconnect({ stored: null, current: fpA, isResume: true })).toBe(false);
  });

  it("stays quiet when galaxy is no longer usable (no current creds)", () => {
    expect(shouldNudgeReconnect({ stored: fpA, current: null, isResume: true })).toBe(false);
  });

  it("stays quiet on a fresh start even if creds changed (greeting handles it)", () => {
    expect(shouldNudgeReconnect({ stored: fpA, current: fpB, isResume: false })).toBe(false);
  });
});

describe("fingerprint persistence", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-creddrift-fp-"));
  });
  afterEach(() => {
    try {
      fs.rmSync(agentDir, { recursive: true, force: true });
    } catch {}
  });

  it("round-trips a fingerprint per cwd", () => {
    const p = fingerprintPath("/Users/me/work/projectA", agentDir);
    expect(readStoredFingerprint(p)).toBeNull();
    writeStoredFingerprint(p, "deadbeef");
    expect(readStoredFingerprint(p)).toBe("deadbeef");
  });

  it("keeps fingerprints for different cwds separate", () => {
    const a = fingerprintPath("/Users/me/work/projectA", agentDir);
    const b = fingerprintPath("/Users/me/work/projectB", agentDir);
    writeStoredFingerprint(a, "fpA");
    writeStoredFingerprint(b, "fpB");
    expect(readStoredFingerprint(a)).toBe("fpA");
    expect(readStoredFingerprint(b)).toBe("fpB");
  });

  it("does not collide cwds that slug to the same segment", () => {
    // Both paths reduce to the slug "tmp-a-b-c" under separator substitution;
    // the full-cwd hash must keep them in distinct files.
    expect(fingerprintPath("/tmp/a-b/c", agentDir)).not.toBe(
      fingerprintPath("/tmp/a/b-c", agentDir),
    );
  });

  it("never writes the raw key to disk", () => {
    const p = fingerprintPath("/Users/me/work/projectA", agentDir);
    writeStoredFingerprint(p, galaxyCredFingerprint("https://x.galaxyproject.org", "leaky-key"));
    expect(fs.readFileSync(p, "utf-8")).not.toContain("leaky-key");
  });
});

// Integration: maybeNudgeGalaxyReconnect reads the live env (GALAXY_URL/KEY),
// compares against the per-cwd baseline in the sandboxed agent dir, nudges via
// a fake pi, and always refreshes the baseline. Mirrors the startup-greeting
// dispatch tests: sandbox HOME + PI_CODING_AGENT_DIR so nothing leaks to disk.
describe("maybeNudgeGalaxyReconnect (dispatch)", () => {
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let sandboxHome: string;
  let agentDir: string;
  const cwd = "/Users/me/work/projectA";

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-creddrift-"));
    agentDir = path.join(sandboxHome, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    process.env.HOME = sandboxHome;
    process.env.USERPROFILE = sandboxHome;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    } catch {}
  });

  function pi() {
    return { sendUserMessage: vi.fn() } as { sendUserMessage: ReturnType<typeof vi.fn> };
  }

  it("first resume writes a baseline and does not nudge", () => {
    process.env.GALAXY_URL = "https://x.galaxyproject.org";
    process.env.GALAXY_API_KEY = "key-A";
    const fake = pi();
    maybeNudgeGalaxyReconnect(fake as never, { isResume: true, cwd });
    expect(fake.sendUserMessage).not.toHaveBeenCalled();
    expect(readStoredFingerprint(fingerprintPath(cwd, agentDir))).toBe(
      galaxyCredFingerprint("https://x.galaxyproject.org", "key-A"),
    );
  });

  it("nudges on a resume after the key changed but does NOT advance the baseline", () => {
    const fpPath = fingerprintPath(cwd, agentDir);
    writeStoredFingerprint(fpPath, galaxyCredFingerprint("https://x.galaxyproject.org", "key-A"));
    process.env.GALAXY_URL = "https://x.galaxyproject.org";
    process.env.GALAXY_API_KEY = "key-B";
    const fake = pi();
    maybeNudgeGalaxyReconnect(fake as never, { isResume: true, cwd });
    expect(fake.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(fake.sendUserMessage.mock.calls[0][0]).toContain("galaxy_connect");
    // Baseline stays at key-A until a confirmed connect, so a crash or an
    // ignored nudge leaves the next resume free to nudge again.
    expect(readStoredFingerprint(fpPath)).toBe(
      galaxyCredFingerprint("https://x.galaxyproject.org", "key-A"),
    );
  });

  it("does not nudge on a resume when the key is unchanged", () => {
    writeStoredFingerprint(
      fingerprintPath(cwd, agentDir),
      galaxyCredFingerprint("https://x.galaxyproject.org", "key-A"),
    );
    process.env.GALAXY_URL = "https://x.galaxyproject.org";
    process.env.GALAXY_API_KEY = "key-A";
    const fake = pi();
    maybeNudgeGalaxyReconnect(fake as never, { isResume: true, cwd });
    expect(fake.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not nudge on a non-resume start even when the key changed", () => {
    writeStoredFingerprint(
      fingerprintPath(cwd, agentDir),
      galaxyCredFingerprint("https://x.galaxyproject.org", "key-A"),
    );
    process.env.GALAXY_URL = "https://x.galaxyproject.org";
    process.env.GALAXY_API_KEY = "key-B";
    const fake = pi();
    maybeNudgeGalaxyReconnect(fake as never, { isResume: false, cwd });
    expect(fake.sendUserMessage).not.toHaveBeenCalled();
    // session_start never overwrites an existing baseline; only a confirmed
    // connect does. So it stays at key-A here.
    expect(readStoredFingerprint(fingerprintPath(cwd, agentDir))).toBe(
      galaxyCredFingerprint("https://x.galaxyproject.org", "key-A"),
    );
  });

  it("does not nudge when galaxy is not configured (no env creds)", () => {
    const fake = pi();
    maybeNudgeGalaxyReconnect(fake as never, { isResume: true, cwd });
    expect(fake.sendUserMessage).not.toHaveBeenCalled();
  });

  it("recordGalaxyConnected advances the baseline to the current env creds", () => {
    writeStoredFingerprint(
      fingerprintPath(cwd, agentDir),
      galaxyCredFingerprint("https://x.galaxyproject.org", "key-A"),
    );
    process.env.GALAXY_URL = "https://x.galaxyproject.org";
    process.env.GALAXY_API_KEY = "key-B";
    recordGalaxyConnected(cwd);
    expect(readStoredFingerprint(fingerprintPath(cwd, agentDir))).toBe(
      galaxyCredFingerprint("https://x.galaxyproject.org", "key-B"),
    );
  });

  it("recordGalaxyConnected is a no-op when galaxy creds are absent", () => {
    recordGalaxyConnected(cwd);
    expect(readStoredFingerprint(fingerprintPath(cwd, agentDir))).toBeNull();
  });
});
