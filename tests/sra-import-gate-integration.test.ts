import { describe, expect, it, vi } from "vitest";
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
import { registerSraImportGate } from "../extensions/loom/sra-import-gate";

// Real Pi event ordering matters: all sibling calls must be visible to the
// gate BEFORE the first tool executes. A mock that calls hooks in our preferred
// order would not establish that. Only the model and Galaxy tool are fixtures.
describe("SRA gate through the Pi runtime", () => {
  it("blocks the entire fan-out and lets the agent correct it to one submission", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-sra-gate-runtime-"));
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
        extensionFactories: [registerSraImportGate],
        systemPrompt: "SRA gate test fixture.",
      });
      await loader.reload();
      const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(dir, "models-cache.json"),
        refreshOnCreate: false,
      });
      const runs = Array.from({ length: 7 }, (_, i) => `SRR${17449121 - i}`);
      const inputsFor = (accession: string) => ({
        history_id: "fixture-history",
        tool_id: "fasterq_dump",
        inputs: { "input|input_select": "accession_number", "input|accession": accession },
      });
      const execute = vi.fn(async (_id: string, _args: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text: "fixture submitted" }],
      }));
      const errors: string[] = [];
      let turns = 0;
      runtime.registerProvider("sra-gate-fixture", {
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
          if (turn === 1) {
            for (const message of context.messages) {
              if (message.role === "toolResult" && message.isError) {
                errors.push(
                  message.content
                    .filter((c) => c.type === "text")
                    .map((c) => c.text)
                    .join("\n"),
                );
              }
            }
          }
          const content: AssistantMessage["content"] =
            turn === 0
              ? runs.map((run, i) => ({
                  type: "toolCall",
                  id: `single-${i}`,
                  name: "mcp__galaxy__run_tool",
                  arguments: inputsFor(run),
                }))
              : turn === 1
                ? [
                    {
                      type: "toolCall",
                      id: "batch",
                      name: "mcp__galaxy__run_tool",
                      arguments: inputsFor(runs.join(",")),
                    },
                  ]
                : [{ type: "text", text: "Submitted one batch." }];
          const message: AssistantMessage = {
            role: "assistant",
            content,
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
            stopReason: turn < 2 ? "toolUse" : "stop",
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
        model: runtime.getModel("sra-gate-fixture", "fixture"),
        thinkingLevel: "off",
        tools: ["mcp__galaxy__run_tool"],
        customTools: [
          {
            name: "mcp__galaxy__run_tool",
            label: "Fixture Galaxy run",
            description: "Test-only Galaxy submission",
            parameters: Type.Object({
              history_id: Type.String(),
              tool_id: Type.String(),
              inputs: Type.Record(Type.String(), Type.Unknown()),
            }),
            execute,
          },
        ],
      });
      dispose = () => session.dispose();
      await session.bindExtensions({});
      await session.prompt("Import these seven SRA runs together.");
      expect(turns).toBe(3);
      expect(errors).toHaveLength(7);
      expect(errors.every((text) => text.includes("Batch SRA imports before submission"))).toBe(
        true,
      );
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][1]).toMatchObject(inputsFor(runs.join(",")));
    } finally {
      dispose?.();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
