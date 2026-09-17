import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { registerExecutionCommands } from "../extensions/loom/execution-commands";
import {
  getCurrentStepAnchor,
  resetState,
  setCurrentStepAnchor,
  setNotebookPath,
} from "../extensions/loom/state";

let tmpDir: string;
let nbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-execute-command-"));
  nbPath = path.join(tmpDir, "notebook.md");
  resetState();
});

afterEach(() => {
  resetState();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeRunnableNotebook() {
  fs.writeFileSync(
    nbPath,
    `
## Plan A: Smoke [local]

- [ ] 1. **Write config** {#plan-a-step-1} -- create the requested config file
  - Routing: local
  - Tool: file write
  - Verification: read the file back and confirm the requested key is present
`,
    "utf-8",
  );
  setNotebookPath(nbPath);
}

type Handler = (args: string | undefined, ctx: any) => void;

function fakePi() {
  const commands = new Map<string, { handler: Handler }>();
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const sendUserMessage = vi.fn();
  const pi = {
    registerCommand: vi.fn((name: string, command: { handler: Handler }) => {
      commands.set(name, command);
    }),
    on: vi.fn((event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, handler);
    }),
    sendUserMessage,
  };
  return { pi, commands, handlers, sendUserMessage };
}

describe("registerExecutionCommands", () => {
  it("instructs the agent to verify before marking a step complete", async () => {
    writeRunnableNotebook();

    const { pi, commands, sendUserMessage } = fakePi();

    registerExecutionCommands(pi as any);
    await commands.get("execute")!.handler(undefined, { ui: { notify: vi.fn() } });

    const prompt = sendUserMessage.mock.calls[0][0] as string;
    // Async-dominant: Galaxy steps submit and hand control back — no in-turn polling.
    expect(prompt).toContain("Galaxy steps run in the BACKGROUND");
    expect(prompt).toContain("hand control back to the user");
    expect(prompt).toContain("Do NOT sit in this turn polling the invocation to completion");
    // Verify-before-complete still enforced (local now; Galaxy on demand, later).
    expect(prompt).toContain("use the step's `Verification:` sub-bullet");
    expect(prompt).toContain("verification happens");
    expect(prompt).toContain("Write the verification evidence into the notebook");
    expect(prompt).toContain("Only after verification succeeds");
    expect(prompt).toContain("created but not verified");
    expect(prompt).toContain("Do NOT claim the artifact or step is done");
  });

  it("arms the step anchor and goes live when the run starts", async () => {
    writeRunnableNotebook();
    const { pi, commands, handlers } = fakePi();

    registerExecutionCommands(pi as any);
    await commands.get("execute")!.handler(undefined, { ui: { notify: vi.fn() } });

    // Armed, not live: nothing is attributed until a run actually begins.
    expect(getCurrentStepAnchor()).toBeNull();

    await handlers.get("agent_start")!({ type: "agent_start" }, {});
    expect(getCurrentStepAnchor()).toBe("plan-a-step-1");
  });

  it("clears the anchor when the agent run settles, not between turns", async () => {
    writeRunnableNotebook();
    const { pi, commands, handlers } = fakePi();

    registerExecutionCommands(pi as any);
    await commands.get("execute")!.handler(undefined, { ui: { notify: vi.fn() } });
    await handlers.get("agent_start")!({ type: "agent_start" }, {});

    // A multi-turn /execute is the normal case: the model reads the notebook
    // in one turn and submits in the next. Nothing is registered on turn_end,
    // so the anchor is still there for the submitting turn.
    expect(handlers.has("turn_end")).toBe(false);
    expect(getCurrentStepAnchor()).toBe("plan-a-step-1");

    await handlers.get("agent_end")!({ type: "agent_end" }, {});
    expect(getCurrentStepAnchor()).toBeNull();
  });

  it("does not repoint a running run's anchor when /execute is rejected", async () => {
    // pi dispatches the slash command mid-stream but rejects the message it
    // sends, so no run for step 1 ever starts. The anchor belonging to the run
    // that IS going must survive untouched.
    writeRunnableNotebook();
    const { pi, commands, handlers } = fakePi();

    registerExecutionCommands(pi as any);
    await handlers.get("agent_start")!({ type: "agent_start" }, {});
    setCurrentStepAnchor("plan-z-step-9");

    await commands.get("execute")!.handler(undefined, { ui: { notify: vi.fn() } });
    expect(getCurrentStepAnchor()).toBe("plan-z-step-9");

    // And the stranded arm must not be promoted by the next run either.
    await handlers.get("agent_end")!({ type: "agent_end" }, {});
    await handlers.get("agent_start")!({ type: "agent_start" }, {});
    expect(getCurrentStepAnchor()).toBeNull();
  });

  it("drops the armed anchor when the gate soft-fails", async () => {
    // No plan at all: the gate soft-fails, the agent is still sent off, and
    // no step should be attributed the work that follows.
    fs.writeFileSync(nbPath, "# Notes\n\nNothing to run here.\n", "utf-8");
    setNotebookPath(nbPath);

    const { pi, commands, handlers } = fakePi();
    registerExecutionCommands(pi as any);
    await commands.get("execute")!.handler(undefined, { ui: { notify: vi.fn() } });
    await handlers.get("agent_start")!({ type: "agent_start" }, {});

    expect(getCurrentStepAnchor()).toBeNull();
  });
});
