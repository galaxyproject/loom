/**
 * Integration tests for the Loom extension.
 *
 * Creates a minimal mock ExtensionAPI that captures all registrations,
 * then loads the extension and verifies everything registered correctly.
 * This follows the OpenClaw testing pattern of fake API objects.
 */
import { describe, it, expect } from "vitest";
import { afterEach, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import galaxyAnalystExtension from "../extensions/loom/index";
import { createPlan, getCurrentPlan, resetState } from "../extensions/loom/state";
import { generateNotebook } from "../extensions/loom/notebook-writer";

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: Function;
  renderResult?: Function;
  renderCall?: Function;
}

interface RegisteredCommand {
  description: string;
  handler: Function;
}

/**
 * Create a fake ExtensionAPI that captures all registrations.
 * Follows the OpenClaw pattern for extension testing.
 */
function createFakeExtensionAPI() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, Function[]>();
  const shortcuts = new Map<string, unknown>();
  const entries: unknown[] = [];
  const userMessages: string[] = [];

  const api: ExtensionAPI = {
    on(event: string, handler: Function) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, cmd: RegisteredCommand) {
      commands.set(name, cmd);
    },
    registerShortcut(key: string, shortcut: unknown) {
      shortcuts.set(key, shortcut);
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    sendMessage() {},
    sendUserMessage(message: string) { userMessages.push(message); },
    events: {
      on() {},
      emit() {},
    },
    getActiveTools() { return []; },
    getAllTools() { return []; },
    setActiveTools() {},
    registerFlag() {},
    registerProvider() {},
  } as unknown as ExtensionAPI;

  return { api, tools, commands, handlers, shortcuts, entries, userMessages };
}

const EXPECTED_TOOLS = [
  // Phase 1: Problem Definition
  "research_question_refine",
  "research_add_literature",

  // Phase 2: Data Acquisition
  "data_set_source",
  "data_add_sample",
  "data_add_file",
  "data_link_galaxy",
  "data_generate_samplesheet",
  "data_get_provenance",

  // Phase 3: Analysis (core)
  "analysis_plan_create",
  "analysis_plan_add_step",
  "analysis_plan_update_step",
  "analysis_plan_get",
  "analysis_plan_activate",
  "analysis_plan_summary",
  "analysis_step_log",
  "analysis_checkpoint",

  // Phase management
  "analysis_set_phase",

  // Notebook management
  "analysis_notebook_create",
  "analysis_notebook_open",
  "analysis_notebook_list",

  // Phase 4: Interpretation
  "interpretation_add_finding",
  "interpretation_summarize",

  // Phase 5: Publication
  "publication_init",
  "publication_generate_methods",
  "publication_add_figure",
  "publication_update_figure",
  "publication_recommend_figures",
  "publication_get_status",

  // Workflow Integration
  "workflow_to_plan",
  "workflow_invocation_link",
  "workflow_invocation_check",

  // BRC Catalog Context
  "brc_set_context",

  // GTN Tutorial Discovery
  "gtn_search",
  "gtn_fetch",

  // Tool Version Resolution
  "analysis_resolve_versions",

  // Shell-facing tools (structured widget emitters)
  "report_result",
  "analyze_plan_parameters",
];

const EXPECTED_COMMANDS = [
  "plan",
  "plan-decisions",
  "connect",
  "status",
  "notebook",
  "review",
  "test",
  "execute",
  "run",
];

const EXPECTED_EVENTS = [
  "session_start",
  "before_agent_start",
  "turn_end",
  "session_before_compact",
  "session_shutdown",
  "tool_execution_start",
  "tool_execution_end",
  "tool_result",
];

describe("extension loading", () => {
  it("loads without errors", () => {
    const { api } = createFakeExtensionAPI();
    expect(() => galaxyAnalystExtension(api)).not.toThrow();
  });

  it("registers all expected tools", () => {
    const { api, tools } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);
    const registeredNames = Array.from(tools.keys());

    for (const toolName of EXPECTED_TOOLS) {
      expect(
        registeredNames,
        `Tool "${toolName}" should be registered`
      ).toContain(toolName);
    }
  });

  it("does not register unexpected tools", () => {
    const { api, tools } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);
    const registeredNames = Array.from(tools.keys());

    for (const name of registeredNames) {
      expect(
        EXPECTED_TOOLS,
        `Unexpected tool "${name}" was registered`
      ).toContain(name);
    }
  });

  it(`registers exactly ${EXPECTED_TOOLS.length} tools`, () => {
    const { api, tools } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);
    expect(tools.size).toBe(EXPECTED_TOOLS.length);
  });

  it("registers all expected commands", () => {
    const { api, commands } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);
    const registeredCommands = Array.from(commands.keys());

    for (const cmd of EXPECTED_COMMANDS) {
      expect(
        registeredCommands,
        `Command "/${cmd}" should be registered`
      ).toContain(cmd);
    }
  });

  it("registers all expected event handlers", () => {
    const { api, handlers } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);
    const registeredEvents = Array.from(handlers.keys());

    for (const event of EXPECTED_EVENTS) {
      expect(
        registeredEvents,
        `Event handler for "${event}" should be registered`
      ).toContain(event);
    }
  });
});

describe("tool definitions", () => {
  it("all tools have names, labels, descriptions, and parameters", () => {
    const { api, tools } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);

    for (const [name, tool] of tools) {
      expect(tool.name, `Tool ${name} should have a name`).toBeTruthy();
      expect(tool.label, `Tool ${name} should have a label`).toBeTruthy();
      expect(tool.description, `Tool ${name} should have a description`).toBeTruthy();
      expect(tool.parameters, `Tool ${name} should have parameters`).toBeTruthy();
    }
  });

  it("all tools have execute functions", () => {
    const { api, tools } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);

    for (const [name, tool] of tools) {
      expect(
        typeof tool.execute,
        `Tool ${name} execute should be a function`
      ).toBe("function");
    }
  });

  it("tool descriptions are non-trivial", () => {
    const { api, tools } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);

    for (const [name, tool] of tools) {
      expect(
        tool.description.length,
        `Tool ${name} description should be substantial`
      ).toBeGreaterThan(20);
    }
  });

  it("analysis_plan_create has correct parameter schema", () => {
    const { api, tools } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);

    const tool = tools.get("analysis_plan_create");
    expect(tool).toBeTruthy();

    const schema = tool!.parameters as { type: string; properties: Record<string, unknown> };
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeTruthy();
    expect(schema.properties.title).toBeTruthy();
    expect(schema.properties.researchQuestion).toBeTruthy();
    expect(schema.properties.dataDescription).toBeTruthy();
    expect(schema.properties.expectedOutcomes).toBeTruthy();
  });
});

describe("provenance notebook sync", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    resetState();
  });

  it("persists data provenance section after sample and file updates", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "loom-provenance-"));
    process.chdir(tempDir);

    const { api, tools } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);

    await tools.get("analysis_plan_create")!.execute("1", {
      title: "Provenance Sync Test",
      researchQuestion: "Q",
      dataDescription: "D",
      expectedOutcomes: ["O"],
      constraints: [],
    });

    await tools.get("data_set_source")!.execute("2", {
      source: "other",
      accession: "582600",
      downloadDate: "2026-03-31",
    });

    await tools.get("data_add_sample")!.execute("3", {
      id: "mutant",
      name: "mutant",
      condition: "mutant",
    });

    await tools.get("data_add_file")!.execute("4", {
      id: "mutant_R1",
      name: "mutant_R1.fastq",
      type: "fastq",
      format: "fastq",
      readType: "paired",
      pairedWith: "mutant_R2",
    });

    const notebookPath = path.join(tempDir, "provenance-sync-test-notebook.md");
    const notebook = await readFile(notebookPath, "utf8");

    expect(notebook).toContain("## Data Provenance");
    expect(notebook).toContain("**Source**: OTHER");
    expect(notebook).toContain("**Accession**: 582600");
    expect(notebook).toContain("| mutant | mutant | mutant | - | 0 |");
    expect(notebook).toContain("| mutant_R1 | mutant_R1.fastq | fastq | - |");
    expect(notebook).toContain("sample_count: 1");
    expect(notebook).toContain("file_count: 1");
  });
});

describe("session restore precedence", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    resetState();
  });

  it("keeps the notebook state when both a notebook and stale session entry exist", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "loom-restore-"));
    process.chdir(tempDir);

    resetState();
    const notebookPlan = createPlan({
      title: "Notebook Truth",
      researchQuestion: "Notebook question",
      dataDescription: "Notebook data",
      expectedOutcomes: [],
      constraints: [],
    });
    const notebookPath = path.join(tempDir, "notebook-truth-notebook.md");
    await writeFile(notebookPath, generateNotebook(notebookPlan), "utf-8");

    resetState();

    const { api, handlers } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);

    const notifications: string[] = [];
    const ctx = {
      ui: {
        setToolsExpanded() {},
        notify(message: string) {
          notifications.push(message);
        },
      },
      sessionManager: {
        getEntries() {
          return [{
            type: "custom",
            customType: "galaxy_analyst_plan",
            data: {
              ...notebookPlan,
              title: "Stale Session Entry",
            },
          }];
        },
      },
    };

    const sessionStart = handlers.get("session_start") || [];
    expect(sessionStart).toHaveLength(1);
    await sessionStart[0]({}, ctx);

    expect(getCurrentPlan()?.title).toBe("Notebook Truth");
    expect(notifications).toContain("Loaded notebook: Notebook Truth (0/0 steps)");
    expect(notifications).not.toContain("Restored plan: Stale Session Entry");
  });
});

describe("command definitions", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    resetState();
  });

  it("all commands have descriptions and handlers", () => {
    const { api, commands } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);

    for (const [name, cmd] of commands) {
      expect(cmd.description, `Command /${name} should have a description`).toBeTruthy();
      expect(typeof cmd.handler, `Command /${name} should have a handler function`).toBe("function");
    }
  });

  it("review command delegates execution policy to the brain", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "loom-cmd-"));
    process.chdir(tempDir);
    const { api, commands, tools, userMessages } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);

    await tools.get("analysis_plan_create")!.execute(
      "call-1",
      {
        title: "Review Test",
        researchQuestion: "Q",
        dataDescription: "D",
        expectedOutcomes: [],
        constraints: [],
      },
      undefined, undefined, {} as any,
    );

    await commands.get("review")!.handler("", {
      ui: { notify() {} },
    });

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toContain("The user typed /review.");
    expect(userMessages[0]).toContain("call analyze_plan_parameters");
  });

  it("execute command receives structured saved parameters", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "loom-cmd-"));
    process.chdir(tempDir);
    const { api, commands, tools, userMessages } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);

    await tools.get("analysis_plan_create")!.execute(
      "call-1",
      {
        title: "Execute Test",
        researchQuestion: "Q",
        dataDescription: "D",
        expectedOutcomes: [],
        constraints: [],
      },
      undefined, undefined, {} as any,
    );

    await commands.get("execute")!.handler(JSON.stringify({
      savedParameters: { organism: "hg38", fdr: 0.05 },
    }), {
      ui: { notify() {} },
    });

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toContain("The user typed /execute.");
    expect(userMessages[0]).toContain("\"organism\": \"hg38\"");
    expect(userMessages[0]).toContain("\"fdr\": 0.05");
  });
});

describe("tool execution", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    resetState();
  });

  it("analysis_plan_create executes and returns plan data", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "loom-tool-"));
    process.chdir(tempDir);
    const { api, tools } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);

    const tool = tools.get("analysis_plan_create")!;
    const result = await tool.execute(
      "call-1",
      {
        title: "Integration Test Plan",
        researchQuestion: "Does the extension work?",
        dataDescription: "Test data",
        expectedOutcomes: ["Working extension"],
        constraints: [],
      },
      undefined, // signal
      undefined, // onUpdate
      {} as any, // ctx
    );

    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(true);
    expect(parsed.planId).toBeTruthy();
    expect(parsed.message).toContain("Integration Test Plan");
  });

  it("analysis_plan_get returns plan details after creation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "loom-tool-"));
    process.chdir(tempDir);
    const { api, tools } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);

    // First create a plan
    await tools.get("analysis_plan_create")!.execute(
      "call-1",
      {
        title: "Get Test",
        researchQuestion: "Q",
        dataDescription: "D",
        expectedOutcomes: [],
        constraints: [],
      },
      undefined, undefined, {} as any,
    );

    // Then get it
    const result = await tools.get("analysis_plan_get")!.execute(
      "call-2", {}, undefined, undefined, {} as any,
    );

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Get Test");
  });

  it("analysis_set_phase rejects invalid lifecycle jumps", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "loom-tool-"));
    process.chdir(tempDir);
    const { api, tools } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);

    await tools.get("analysis_plan_create")!.execute(
      "call-1",
      {
        title: "Phase Test",
        researchQuestion: "Q",
        dataDescription: "D",
        expectedOutcomes: [],
        constraints: [],
      },
      undefined, undefined, {} as any,
    );

    await tools.get("analysis_set_phase")!.execute(
      "call-2",
      { phase: "data_acquisition" },
      undefined, undefined, {} as any,
    );

    const result = await tools.get("analysis_set_phase")!.execute(
      "call-3",
      { phase: "analysis" },
      undefined, undefined, {} as any,
    );

    expect((result.content[0] as { text: string }).text).toContain(
      "Cannot move to analysis until data provenance is tracked or data is in Galaxy"
    );
    expect(result.details.error).toBe(true);
  });

  it("full lifecycle: create plan → add step → update step → log decision", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "loom-tool-"));
    process.chdir(tempDir);
    const { api, tools } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);

    // Create plan
    const createResult = await tools.get("analysis_plan_create")!.execute(
      "c1",
      { title: "Lifecycle Test", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] },
      undefined, undefined, {} as any,
    );
    const planData = JSON.parse((createResult.content[0] as { text: string }).text);
    expect(planData.success).toBe(true);

    // Add step
    const addStepResult = await tools.get("analysis_plan_add_step")!.execute(
      "c2",
      { name: "FastQC", description: "QC check", executionType: "tool", inputs: [], expectedOutputs: [], dependsOn: [] },
      undefined, undefined, {} as any,
    );
    const stepData = JSON.parse((addStepResult.content[0] as { text: string }).text);
    expect(stepData.success).toBe(true);
    expect(stepData.stepId).toBe("1");

    // Update step status
    const updateResult = await tools.get("analysis_plan_update_step")!.execute(
      "c3",
      { stepId: "1", status: "in_progress" },
      undefined, undefined, {} as any,
    );
    const updateData = JSON.parse((updateResult.content[0] as { text: string }).text);
    expect(updateData.success).toBe(true);

    // Log decision
    const logResult = await tools.get("analysis_step_log")!.execute(
      "c4",
      { stepId: "1", type: "parameter_choice", description: "Default params", rationale: "Good defaults", researcherApproved: true },
      undefined, undefined, {} as any,
    );
    const logData = JSON.parse((logResult.content[0] as { text: string }).text);
    expect(logData.success).toBe(true);

    // Verify final state
    const getResult = await tools.get("analysis_plan_get")!.execute(
      "c5", {}, undefined, undefined, {} as any,
    );
    const planText = (getResult.content[0] as { text: string }).text;
    expect(planText).toContain("FastQC");
    expect(planText).toContain("in_progress");
  });
});
