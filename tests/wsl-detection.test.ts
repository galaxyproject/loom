import { describe, it, expect, vi, afterEach } from "vitest";
import { isWsl } from "../shared/wsl.js";
import { buildReportSysinfo } from "../app/src/main/report-sysinfo.js";
import { toFeedbackSysinfo } from "../app/src/renderer/feedback-sysinfo.js";

// Real kernel release strings: WSL2 ships a Microsoft-built kernel, WSL1 fakes
// one, and a native desktop kernel has no "microsoft" anywhere.
const WSL2_RELEASE = "5.15.167.4-microsoft-standard-WSL2";
const WSL1_RELEASE = "4.4.0-19041-Microsoft";
const NATIVE_RELEASE = "6.8.0-45-generic";

// The brain builder reads os.release() directly; this lets a test drive the
// release-only path (WSL env stripped) without a WSL machine.
const osState = vi.hoisted(() => ({ release: "" }));
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, release: () => osState.release || actual.release() };
});

vi.mock("../extensions/loom/config.js", () => ({
  loadConfig: () => ({
    llm: { active: "anthropic", providers: { anthropic: { model: "claude-opus-5" } } },
  }),
  getConfigDir: () => "/tmp/loom-test",
}));
vi.mock("../extensions/loom/profiles.js", () => ({ loadProfiles: () => ({ active: null }) }));

const { buildBrainSysinfo } = await import("../extensions/loom/feedback.js");

/** process.platform is read-only; swap the descriptor and always restore it. */
function withPlatform(platform: string, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  osState.release = "";
});

/** Blank both WSL env vars so detection has to fall through to the release. */
function stripWslEnv(): void {
  vi.stubEnv("WSL_DISTRO_NAME", "");
  vi.stubEnv("WSL_INTEROP", "");
}

describe("isWsl", () => {
  it("detects WSL2 from WSL_DISTRO_NAME", () => {
    expect(
      isWsl({
        platform: "linux",
        env: { WSL_DISTRO_NAME: "Ubuntu-22.04" },
        release: WSL2_RELEASE,
      }),
    ).toBe(true);
  });

  it("detects WSL from WSL_INTEROP alone", () => {
    expect(
      isWsl({ platform: "linux", env: { WSL_INTEROP: "/run/WSL/8_interop" }, release: "" }),
    ).toBe(true);
  });

  it("detects WSL1 and WSL2 from the release string when the env is stripped", () => {
    expect(isWsl({ platform: "linux", env: {}, release: WSL2_RELEASE })).toBe(true);
    expect(isWsl({ platform: "linux", env: {}, release: WSL1_RELEASE })).toBe(true);
  });

  it("is false on native Linux", () => {
    expect(isWsl({ platform: "linux", env: {}, release: NATIVE_RELEASE })).toBe(false);
  });

  it("ignores empty WSL env vars", () => {
    expect(
      isWsl({
        platform: "linux",
        env: { WSL_DISTRO_NAME: "", WSL_INTEROP: "" },
        release: NATIVE_RELEASE,
      }),
    ).toBe(false);
  });

  it("is false on non-Linux platforms even when WSL env leaks in", () => {
    const env = { WSL_DISTRO_NAME: "Ubuntu-22.04", WSL_INTEROP: "/run/WSL/8_interop" };
    expect(isWsl({ platform: "win32", env, release: "10.0.22631" })).toBe(false);
    expect(isWsl({ platform: "darwin", env, release: "24.6.0" })).toBe(false);
  });

  it("tolerates missing inputs", () => {
    expect(isWsl()).toBe(false);
    expect(isWsl({})).toBe(false);
    expect(isWsl({ platform: "linux" })).toBe(false);
  });
});

describe("buildBrainSysinfo (loom-cli)", () => {
  it("reports wsl:true under a WSL-shaped environment", () => {
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu-22.04");
    withPlatform("linux", () => {
      expect(buildBrainSysinfo().wsl).toBe(true);
    });
  });

  it("reports wsl:true from the kernel release when the env is stripped", () => {
    stripWslEnv();
    osState.release = WSL2_RELEASE;
    withPlatform("linux", () => {
      expect(buildBrainSysinfo().wsl).toBe(true);
    });
  });

  it("reports wsl:false on a native Linux kernel", () => {
    stripWslEnv();
    osState.release = NATIVE_RELEASE;
    withPlatform("linux", () => {
      expect(buildBrainSysinfo().wsl).toBe(false);
    });
  });

  it("reports wsl:false off Linux", () => {
    // Platform-gated, so this holds even when the suite itself runs under WSL.
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu-22.04");
    withPlatform("darwin", () => {
      expect(buildBrainSysinfo().wsl).toBe(false);
    });
  });
});

const VERSIONS = {
  appVersion: "0.5.1",
  electronVersion: "38.0.0",
  nodeVersion: "22.19.0",
  chromeVersion: "140.0.0",
};

const CFG = {
  llm: { active: "anthropic", providers: { anthropic: { model: "claude-opus-5" } } },
  galaxy: { active: "main" },
};

describe("buildReportSysinfo (orbit main)", () => {
  it("flags WSL from the env", () => {
    const info = buildReportSysinfo({
      ...VERSIONS,
      platform: "linux",
      arch: "x64",
      env: { WSL_DISTRO_NAME: "Ubuntu-22.04" },
      release: WSL2_RELEASE,
    });
    expect(info.wsl).toBe(true);
  });

  it("flags WSL from the release string when the env is stripped", () => {
    const info = buildReportSysinfo({
      ...VERSIONS,
      platform: "linux",
      arch: "x64",
      env: {},
      release: WSL2_RELEASE,
    });
    expect(info.wsl).toBe(true);
  });

  it("does not flag native Linux, and passes the rest of the envelope through", () => {
    const info = buildReportSysinfo({
      ...VERSIONS,
      platform: "linux",
      arch: "x64",
      env: {},
      release: NATIVE_RELEASE,
    });
    expect(info).toEqual({ ...VERSIONS, platform: "linux", arch: "x64", wsl: false });
  });
});

describe("toFeedbackSysinfo (orbit)", () => {
  const envelope = { ...VERSIONS, platform: "linux", arch: "x64", wsl: true };

  it("carries wsl through from the main-process envelope", () => {
    expect(toFeedbackSysinfo(envelope, CFG).wsl).toBe(true);
    expect(toFeedbackSysinfo({ ...envelope, wsl: false }, CFG).wsl).toBe(false);
  });

  it("still maps the rest of the envelope", () => {
    const info = toFeedbackSysinfo(envelope, CFG);
    expect(info).toMatchObject({
      appVersion: "0.5.1",
      platform: "linux",
      arch: "x64",
      electron: "38.0.0",
      chrome: "140.0.0",
      node: "22.19.0",
      llmProvider: "anthropic",
      llmModel: "claude-opus-5",
      galaxyConfigured: true,
    });
  });
});

// The point of the shared helper: a WSL box must not report as WSL in one shell
// and native Linux in the other. Drive the same environment through both real
// builders rather than a hand-written envelope.
describe("both shells agree", () => {
  const wslEnv = { WSL_DISTRO_NAME: "Ubuntu-22.04" };

  function orbitWsl(env: Record<string, string>, release: string, platform = "linux") {
    const envelope = buildReportSysinfo({ ...VERSIONS, platform, arch: "x64", env, release });
    return toFeedbackSysinfo(envelope, CFG).wsl;
  }

  it("both report WSL under a WSL-shaped environment", () => {
    vi.stubEnv("WSL_DISTRO_NAME", wslEnv.WSL_DISTRO_NAME);
    osState.release = WSL2_RELEASE;
    withPlatform("linux", () => {
      expect(orbitWsl(wslEnv, WSL2_RELEASE)).toBe(true);
      expect(buildBrainSysinfo().wsl).toBe(true);
    });
  });

  it("both fall back to the kernel release when the env is stripped", () => {
    stripWslEnv();
    osState.release = WSL2_RELEASE;
    withPlatform("linux", () => {
      expect(orbitWsl({}, WSL2_RELEASE)).toBe(true);
      expect(buildBrainSysinfo().wsl).toBe(true);
    });
  });

  it("neither reports WSL off Linux", () => {
    vi.stubEnv("WSL_DISTRO_NAME", wslEnv.WSL_DISTRO_NAME);
    osState.release = WSL2_RELEASE;
    withPlatform("darwin", () => {
      expect(orbitWsl(wslEnv, "24.6.0", "darwin")).toBe(false);
      expect(buildBrainSysinfo().wsl).toBe(false);
    });
  });
});
