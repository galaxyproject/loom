import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Orbit's prompt was only ever pinned by toContain checks, so a wording move in
// one block went unseen in review. This golden is the whole assembled prompt,
// with everything that varies by machine pinned: config, env, date, cwd.
const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock("../extensions/loom/config", () => ({ loadConfig: loadConfigMock }));

import { DEFAULT_SKILLS } from "../shared/loom-config.js";
import { setupContextInjection } from "../extensions/loom/context";
import { setGalaxyFetchOverride } from "../extensions/loom/galaxy-api";
import { fixtureFetch } from "../extensions/loom/galaxy-fixture";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

let workspace: string;
let agentDir: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loom-prompt-surface-"));
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-prompt-agent-"));
  loadConfigMock.mockReturnValue({
    llm: { active: "anthropic", providers: { anthropic: { model: "claude-test-model" } } },
    skills: { repos: [...DEFAULT_SKILLS] },
  });
  // Whatever the developer's shell exports must not leak into the golden.
  for (const name of Object.keys(process.env)) {
    if (/^(ORBIT|LOOM|GALAXY)_/.test(name)) vi.stubEnv(name, undefined);
  }
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 11, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setGalaxyFetchOverride(null);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(agentDir, { recursive: true, force: true });
});

async function systemPrompt(): Promise<string> {
  const handlers = new Map<string, Handler>();
  setupContextInjection({ on: (event: string, h: Handler) => handlers.set(event, h) } as never);
  const ctx = {
    cwd: workspace,
    model: { id: "claude-test-model", provider: "anthropic" },
    ui: { notify: () => {} },
  };
  const result = (await handlers.get("before_agent_start")!({}, ctx)) as { systemPrompt: string };
  return result.systemPrompt;
}

describe("Orbit's assembled system prompt", () => {
  it("with Galaxy disconnected", async () => {
    await expect(await systemPrompt()).toMatchFileSnapshot(
      "__surface__/system-prompt-disconnected.txt",
    );
  });

  it("with Galaxy connected", async () => {
    vi.stubEnv("GALAXY_URL", "https://galaxy.example.org");
    vi.stubEnv("GALAXY_API_KEY", "fixture-key");
    // Any Galaxy call the prompt path makes is answered here, never by a server.
    setGalaxyFetchOverride(fixtureFetch([]));
    await expect(await systemPrompt()).toMatchFileSnapshot(
      "__surface__/system-prompt-connected.txt",
    );
  });
});
