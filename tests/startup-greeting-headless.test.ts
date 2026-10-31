import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { sendStartupGreeting } from "../extensions/orbit/session-lifecycle";

/**
 * #424 through the real Pi session: with Galaxy credentials usable, the
 * startup greeting is a model turn. Print/json mode binds extensions with no
 * UI and prompts straight after session_start, so a greeting turn still in
 * flight made that prompt fail with "Agent is already processing".
 */
async function boot(withUI: boolean, prompt?: string) {
  const dir = mkdtempSync(join(tmpdir(), "orbit-greeting-headless-"));
  const prompts: string[] = [];
  let dispose: (() => void) | undefined;
  try {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const greet = (pi: ExtensionAPI) => {
      pi.on("session_start", async (_event, ctx) => sendStartupGreeting(pi, ctx));
      pi.on("message_end", async (event) => {
        const msg = event.message;
        if (msg.role !== "user") return;
        prompts.push(
          typeof msg.content === "string"
            ? msg.content
            : msg.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n"),
        );
      });
    };
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [greet],
      systemPrompt: "Startup greeting fixture.",
    });
    await loader.reload();
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(dir, "models-cache.json"),
      refreshOnCreate: false,
    });
    runtime.registerProvider("greeting-fixture", {
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
      // Answer on a later tick, like a real provider, so a greeting turn is
      // still streaming when the next prompt arrives.
      streamSimple: (model) => {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "ALPHATAU" }],
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
          stopReason: "stop",
          timestamp: Date.now(),
        };
        setTimeout(() => {
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        }, 20);
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
      model: runtime.getModel("greeting-fixture", "fixture"),
      thinkingLevel: "off",
      tools: [],
    });
    dispose = () => session.dispose();
    if (withUI) {
      const uiContext = new Proxy({} as Record<string, unknown>, {
        get: (t, p) => (p in t ? t[p as string] : () => undefined),
      }) as unknown as ExtensionUIContext;
      await session.bindExtensions({ uiContext });
    } else {
      // What runPrintMode does for `--mode json`: no uiContext.
      await session.bindExtensions({ mode: "json" });
    }
    if (prompt !== undefined) await session.prompt(prompt);
    await new Promise((r) => setTimeout(r, 50));
    await session.waitForIdle();
    return { prompts };
  } finally {
    dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("startup greeting vs a headless prompt (#424)", () => {
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let sandboxHome: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    sandboxHome = mkdtempSync(join(tmpdir(), "orbit-greeting-home-"));
    mkdirSync(join(sandboxHome, ".orbit"), { recursive: true });
    process.env.HOME = sandboxHome;
    process.env.USERPROFILE = sandboxHome;
    process.env.GALAXY_URL = "https://example-fake-galaxy.invalid";
    process.env.GALAXY_API_KEY = "dummy-fake-key-0000000000000000";
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  it("json mode with Galaxy configured runs the user's prompt and nothing else", async () => {
    const { prompts } = await boot(false, "Reply with exactly one word: ALPHATAU.");
    expect(prompts).toEqual(["Reply with exactly one word: ALPHATAU."]);
  }, 20_000);

  it("a shell with a UI still gets the greeting turn", async () => {
    const { prompts } = await boot(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Galaxy credentials are configured");
  }, 20_000);
});
