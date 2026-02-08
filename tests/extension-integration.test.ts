/**
 * Integration tests for the Galaxy Analyst extension.
 *
 * Creates a minimal mock ExtensionAPI that captures all registrations,
 * then loads the extension and verifies everything registered correctly.
 * This follows the OpenClaw testing pattern of fake API objects.
 */
import { describe, it, expect } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import galaxyAnalystExtension from "../extensions/galaxy-analyst/index";

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
    sendUserMessage() {},
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

  return { api, tools, commands, handlers, shortcuts, entries };
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

  // Phase 5: Publication
  "publication_init",
  "publication_generate_methods",
  "publication_add_figure",
  "publication_update_figure",
  "publication_recommend_figures",
  "publication_get_status",
];

const EXPECTED_COMMANDS = [
  "plan",
  "plan-decisions",
  "connect",
  "status",
  "notebook",
];

const EXPECTED_EVENTS = [
  "session_start",
  "before_agent_start",
  "turn_end",
  "session_before_compact",
  "session_shutdown",
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

describe("command definitions", () => {
  it("all commands have descriptions and handlers", () => {
    const { api, commands } = createFakeExtensionAPI();
    galaxyAnalystExtension(api);

    for (const [name, cmd] of commands) {
      expect(cmd.description, `Command /${name} should have a description`).toBeTruthy();
      expect(typeof cmd.handler, `Command /${name} should have a handler function`).toBe("function");
    }
  });
});

describe("tool execution", () => {
  it("analysis_plan_create executes and returns plan data", async () => {
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

  it("full lifecycle: create plan → add step → update step → log decision", async () => {
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
