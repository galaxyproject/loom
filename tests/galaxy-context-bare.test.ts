import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// context.ts reads identity facts from loadConfig(); control it so the blocks
// are deterministic regardless of the dev machine's real ~/.loom/config.json.
const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock("../extensions/loom/config", () => ({ loadConfig: loadConfigMock }));

import {
  buildGalaxyContextBlock,
  buildTesterIdBlock,
  setupContextInjection,
} from "../extensions/loom/context";
import {
  registerGalaxyTools,
  setGalaxyToolSource,
  type GalaxyTool,
} from "../extensions/loom/galaxy-tool-source";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";

const stub = (name: string): GalaxyTool => ({
  name,
  label: name,
  description: `stub ${name}`,
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "{}" }], details: {} }),
});

let agentDir: string;

beforeEach(() => {
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue({ executionMode: "hybrid", testerId: "orbit-007" });
  vi.stubEnv("GALAXY_URL", "https://galaxy.test");
  vi.stubEnv("GALAXY_API_KEY", "k");
  setCapabilityProfile({ ...profileFromEnv({}), galaxyTools: "bare" });
  setGalaxyToolSource({
    tools: () => [stub("recommend_iwc_workflows"), stub("get_user"), stub("upload_file_from_url")],
  });
  registerGalaxyTools({ registerTool: () => {} } as unknown as ExtensionAPI);
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-context-bare-"));
});

afterEach(() => {
  setCapabilityProfile(null);
  setGalaxyToolSource(null);
  vi.unstubAllEnvs();
  fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("the Galaxy prompt under a bare family", () => {
  it("names Galaxy tools bare and drops the MCP re-bind steer", () => {
    const block = buildGalaxyContextBlock();
    expect(block).not.toContain("mcp__galaxy__");
    expect(block).not.toContain("/mcp reconnect galaxy");
    expect(block).not.toContain("### If a Galaxy tool reports it's not connected");
    expect(block).toContain("Galaxy is connected.");
    expect(block).toContain("### Resuming existing Galaxy work");
    expect(block).toContain("recommend_iwc_workflows");
  });

  it("de-routes the tester ID away from the bare get_user", () => {
    const block = buildTesterIdBlock();
    expect(block).toContain("`get_user`");
    expect(block).not.toContain("mcp__galaxy__");
  });

  it("the whole system prompt has no MCP spelling and the in-process recovery section", async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    setupContextInjection({ on: (e: string, h: never) => handlers.set(e, h) } as never);
    const result = (await handlers.get("before_agent_start")!(
      {},
      { cwd: agentDir, model: { id: "m" }, ui: { notify: () => {} } },
    )) as { systemPrompt: string };
    expect(result.systemPrompt).not.toContain("mcp_read_output");
    expect(result.systemPrompt).not.toContain("mcp__galaxy__");
    expect(result.systemPrompt).toContain("### Slow Galaxy requests");
    expect(result.systemPrompt).toContain("Do not repeatedly call\nget_dataset_details,");
  });
});
