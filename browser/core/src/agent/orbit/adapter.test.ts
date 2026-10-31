// @vitest-environment node
/**
 * The browser's tools as Orbit tools (slice 3, commit 14): what each declares, that its context
 * is the conversation the call runs in at that moment, and that the Galaxy extras go through
 * Orbit's wrap and, for upload_file, the submission ledger.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";

// Capture installs the ledger's dispatch pins when it loads, as it does when the brain registers.
import "../../../../../extensions/orbit/galaxy-submission-capture";
import { setNotebookPath, resetState } from "../../../../../extensions/orbit/state";
import {
  setSubmissionLedger,
  submissionLedger,
} from "../../../../../extensions/orbit/submission-ledger";
import { Outcome, type AgentTool, type Artifact, type Binding } from "../tool";
import { adaptTool, galaxyExtras, granted, type ShellToolHost } from "./adapter";

const conv = (n: number) => n as unknown as ConversationId;

/** A host whose bound conversation, bindings and artifacts the test moves between calls. */
function host(start = 1) {
  const bindings = new Map<ConversationId, Binding>([
    [conv(1), { historyId: "h1" }],
    [conv(2), { historyId: "h2" }],
  ]);
  const artifacts = new Map<ConversationId, Artifact[]>([
    [conv(1), [{ kind: "vega", title: "one" } as unknown as Artifact]],
  ]);
  const rebound: Array<[ConversationId, Binding]> = [];
  const state = { current: conv(start) as ConversationId | undefined };
  const h: ShellToolHost = {
    clients: () => ({
      galaxy: {} as never,
      web: {} as never,
      ops: {} as never,
      python: {} as never,
    }),
    conversation: () => state.current,
    binding: async (id) => ({ ...(bindings.get(id) ?? {}) }),
    rebind: async (id, b) => void rebound.push([id, b]),
    artifacts: async (id) => artifacts.get(id) ?? [],
  };
  return { h, state, rebound };
}

const echo: AgentTool = {
  name: "echo_history",
  description: "says which history",
  parameters: { type: "object", properties: {} },
  capability: "read",
  run: async (_args, ctx) => ({
    history: ctx.binding.historyId,
    prior: ctx.artifacts.prior.length,
  }),
};

const run = (tool: ReturnType<typeof adaptTool>, args: Record<string, unknown> = {}) =>
  tool.execute("call-1", args, undefined, undefined, undefined as never);

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("");

afterEach(() => {
  setSubmissionLedger(null);
  resetState();
});

describe("a browser tool as an Orbit tool", () => {
  it("declares read-only unless it needs write, and destructive when it says so", () => {
    const { h } = host();
    expect(adaptTool(echo, h).annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(adaptTool({ ...echo, capability: "write", destructive: true }, h).annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(
      adaptTool({ ...echo, capability: "local", requires: ["local", "write"] }, h).annotations
        ?.readOnlyHint,
    ).toBe(false);
  });

  it("reads the conversation the call runs in when it runs, not when it was registered", async () => {
    const { h, state } = host();
    const tool = adaptTool(echo, h);
    expect(textOf(await run(tool))).toBe(JSON.stringify({ data: { history: "h1", prior: 1 } }));
    state.current = conv(2);
    expect(textOf(await run(tool))).toBe(JSON.stringify({ data: { history: "h2", prior: 0 } }));
  });

  it("keeps a binding the tool changed, for that conversation", async () => {
    const { h, rebound } = host();
    const tool = adaptTool(
      {
        ...echo,
        run: async (_args, ctx) => {
          ctx.binding.pageId = "p9";
          return "made the page";
        },
      },
      h,
    );
    expect(textOf(await run(tool))).toBe("made the page");
    // Only what changed: the history it read stays as whoever last wrote it left it.
    expect(rebound).toEqual([[conv(1), { pageId: "p9" }]]);
    // A tool that changes nothing writes nothing.
    await run(adaptTool(echo, h));
    expect(rebound).toHaveLength(1);
  });

  it("carries a refusal, a throw and a produced artifact as the browser brain does", async () => {
    const { h } = host();
    const refused = await run(
      adaptTool({ ...echo, run: async () => new Outcome("no", true, "capability") }, h),
    );
    expect(refused).toMatchObject({
      isError: true,
      details: { refused: true, guard: "capability" },
    });
    const thrown = await run(
      adaptTool(
        {
          ...echo,
          run: async () => {
            throw new Error("kaboom");
          },
        },
        h,
      ),
    );
    expect(thrown.isError).toBe(true);
    expect(textOf(thrown)).toBe("Tool 'echo_history' raised: kaboom");
    const chart = { kind: "vega", title: "counts", spec: {} } as unknown as Artifact;
    const made = await run(adaptTool({ ...echo, run: async () => ({ artifact: chart }) }, h));
    expect(made.details).toEqual({ artifacts: [chart] });
    expect(JSON.parse(textOf(made))).toEqual({
      data: { artifact: { kind: "vega", title: "counts" } },
    });
  });

  it("says so when no conversation is open", async () => {
    const { h, state } = host();
    state.current = undefined;
    const result = await run(adaptTool(echo, h));
    expect(result.isError).toBe(true);
  });
});

describe("the grant and the extras", () => {
  it("registers a tool only when the grant covers what it needs", () => {
    const python = { ...echo, capability: "local" as const };
    const organize = { ...echo, requires: ["local", "write"] as const } as unknown as AgentTool;
    expect(granted(python, ["llm", "read", "local"])).toBe(true);
    expect(granted(python, ["llm", "read"])).toBe(false);
    expect(granted(organize, ["llm", "read", "local"])).toBe(false);
    expect(granted(organize, ["llm", "read", "local", "write"])).toBe(true);
  });

  it("leaves out an extra the galaxy-ops entry already has, and wraps the rest", async () => {
    const { h } = host();
    const download = { ...echo, name: "download_dataset" };
    const upload = { ...echo, name: "upload_file", capability: "write" as const };
    const extras = galaxyExtras([download, upload], h, ["upload_file"]);
    expect(extras.map((t) => t.name)).toEqual(["download_dataset"]);
    const result = await run(extras[0]);
    expect(result.details).toMatchObject({ galaxy: { tool: "download_dataset" } });
  });

  it("records an upload_file submission in the ledger before it runs", async () => {
    const { h } = host();
    setNotebookPath("/orbit/1/notebook.md");
    let seenAtRun: unknown[] = [];
    const upload: AgentTool = {
      ...echo,
      name: "upload_file",
      capability: "write",
      run: async () => {
        seenAtRun = await submissionLedger().open("/orbit/1/notebook.md");
        return { jobs: [{ id: "aaaa000000000001" }], outputs: [] };
      },
    };
    const [extra] = galaxyExtras([upload], h, []);
    await run(extra, { path: "out.csv", history_id: "h1" });
    expect(seenAtRun).toMatchObject([{ toolName: "upload_file", state: "dispatched" }]);
    expect(await submissionLedger().open("/orbit/1/notebook.md")).toMatchObject([
      { state: "responded" },
    ]);
  });
});
