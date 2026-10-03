import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { convertMcpResult } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/tools.js";
import { registerMcpOutputRecovery } from "../extensions/loom/mcp-output";
import { registerMcpRecovery } from "../extensions/loom/mcp-recovery";

// pi's real MCP truncation + real Pi event dispatch and tool continuation.
// Only the model and Galaxy responses are fixtures; no network or paid calls.
describe("MCP recovery through the Pi runtime", () => {
  it("continues from a blocked expensive search, a huge result and a timeout in one user turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-mcp-runtime-"));
    const artifacts: string[] = [];
    let dispose: (() => void) | undefined;
    try {
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
      const loader = new DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [registerMcpOutputRecovery, registerMcpRecovery],
        systemPrompt: "MCP recovery test fixture.",
      });
      await loader.reload();
      const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(dir, "models-cache.json"),
        refreshOnCreate: false,
      });
      let turns = 0;
      let expensiveCalls = 0;
      const historyLimits: number[] = [];
      const observed: Record<string, unknown>[] = [];
      const script = [
        { name: "mcp__galaxy__search_tools_by_keywords", arguments: { keywords: ["tissue"] } },
        { name: "mcp__galaxy__get_tool_panel", arguments: {} },
        { name: "mcp_read_output", arguments: { outputId: "call-1", query: "TISSUE" } },
        { name: "mcp__galaxy__get_histories", arguments: { limit: 100 } },
        { name: "mcp__galaxy__get_histories", arguments: { limit: 5 } },
        { name: "mcp_read_output", arguments: { outputId: "unknown" } },
        { name: "mcp_read_output", arguments: { outputId: "call-1", pointer: "/data/1/id" } },
      ];
      runtime.registerProvider("mcp-recovery-fixture", {
        api: "openai-completions",
        apiKey: "fixture-key",
        baseUrl: "http://fixture.invalid",
        models: [
          {
            id: "fixture",
            name: "Fixture",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768,
            maxTokens: 4096,
          },
        ],
        streamSimple: (model, context) => {
          const stream = createAssistantMessageEventStream();
          const turn = turns++;
          const last = context.messages.at(-1);
          if (last?.role === "toolResult")
            observed.push({
              text: last.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n"),
              isError: last.isError,
            });
          const message: AssistantMessage = {
            role: "assistant",
            content:
              turn < script.length
                ? [{ type: "toolCall", id: `call-${turn}`, ...script[turn] }]
                : [{ type: "text", text: "Fixture recovery finished." }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: turn < script.length ? "toolUse" : "stop",
            timestamp: Date.now(),
          };
          stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
          stream.end(message);
          return stream;
        },
      });
      const { session } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        settingsManager,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(dir),
        modelRuntime: runtime,
        model: runtime.getModel("mcp-recovery-fixture", "fixture"),
        thinkingLevel: "off",
        tools: [
          "mcp__galaxy__search_tools_by_keywords",
          "mcp__galaxy__get_tool_panel",
          "mcp__galaxy__get_histories",
          "mcp_read_output",
        ],
        customTools: [
          {
            name: "mcp__galaxy__search_tools_by_keywords",
            label: "Fixture slow discovery",
            description: "Fixture",
            parameters: Type.Object({ keywords: Type.Array(Type.String()) }),
            async execute() {
              expensiveCalls++;
              return { content: [{ type: "text", text: "should not execute" }], details: {} };
            },
          },
          {
            name: "mcp__galaxy__get_tool_panel",
            label: "Fixture catalog",
            description: "Fixture",
            parameters: Type.Object({}),
            async execute() {
              const raw = JSON.stringify({
                success: true,
                data: [
                  { id: "irrelevant", description: "x".repeat(2_400_000) },
                  { id: "fixture-tissue-id", name: "TISSUE" },
                ],
              });
              const result = await convertMcpResult("galaxy", "get_tool_panel", {
                content: [{ type: "text", text: raw }],
              });
              artifacts.push((result.details as { fullOutputPath: string }).fullOutputPath);
              return { content: result.content, details: result.details };
            },
          },
          {
            name: "mcp__galaxy__get_histories",
            label: "Fixture histories",
            description: "Fixture",
            parameters: Type.Object({ limit: Type.Number() }),
            async execute(_id, args) {
              historyLimits.push(args.limit);
              if (args.limit === 100) throw new Error("Failed to call tool: Request timed out");
              return {
                content: [{ type: "text", text: '{"success":true,"data":[]}' }],
                details: {},
              };
            },
          },
        ],
      });
      dispose = () => session.dispose();
      await session.bindExtensions({});
      await session.prompt("Find the fixture tool and recent histories.");
      expect(turns).toBe(8);
      expect(expensiveCalls).toBe(0);
      expect(historyLimits).toEqual([100, 5]);
      expect(observed[0]).toMatchObject({
        isError: true,
        text: expect.stringContaining("mcp__galaxy__search_tools_by_name"),
      });
      expect(observed[1]).toMatchObject({
        isError: false,
        text: expect.stringContaining("mcp_read_output"),
      });
      expect(Buffer.byteLength(String(observed[1].text))).toBeLessThan(16_384);
      expect(observed[2].text).toContain("fixture-tissue-id");
      expect(observed[3]).toMatchObject({
        isError: true,
        text: expect.stringContaining("Narrow or paginate"),
      });
      expect(observed[4].isError).toBe(false);
      expect(observed[5]).toMatchObject({
        isError: true,
        text: expect.stringContaining("Unknown MCP outputId"),
      });
      expect(observed[6]).toMatchObject({
        isError: false,
        text: expect.stringContaining("fixture-tissue-id"),
      });
    } finally {
      dispose?.();
      // Files directly in $TMPDIR: remove each, never their directory.
      for (const path of artifacts) rmSync(path, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
