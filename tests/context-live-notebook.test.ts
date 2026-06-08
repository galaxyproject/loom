import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setupContextInjection } from "../extensions/loom/context";
import { resetState, setNotebookPath } from "../extensions/loom/state";

const LOOM_NOTEBOOK_CONTEXT_TYPE = "loom-notebook-context";
const MARKER = "Some durable notes about variant calling";

type Msg = {
  role: string;
  customType?: string;
  content?: string;
  display?: boolean;
  timestamp?: number;
};
type HandlerResult = { systemPrompt?: string; messages?: Msg[] };
type Handler = (event: { messages?: Msg[] }, ctx: unknown) => Promise<HandlerResult>;

function wire(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const pi = { on: (e: string, h: Handler) => handlers.set(e, h) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setupContextInjection(pi as any);
  return handlers;
}

const injected = (messages: Msg[] | undefined) =>
  (messages ?? []).filter(
    (m) => m.role === "custom" && m.customType === LOOM_NOTEBOOK_CONTEXT_TYPE,
  );

let dir: string;
let nb: string;

beforeEach(() => {
  resetState();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-nbctx-"));
  nb = path.join(dir, "notebook.md");
});

afterEach(() => {
  resetState();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("live notebook context injection", () => {
  it("keeps the notebook contents OUT of the cached system prompt", async () => {
    fs.writeFileSync(nb, `# My project\n\n${MARKER}.\n`);
    setNotebookPath(nb);
    const h = wire();
    const { systemPrompt } = await h.get("before_agent_start")!({}, {});
    // NOTE: do not assert on "```markdown" -- buildPlanConventionBlock mentions it.
    expect(systemPrompt).not.toContain(MARKER);
  });

  it("injects the live notebook as a transient display:false custom message", async () => {
    fs.writeFileSync(nb, `# My project\n\n${MARKER}.\n`);
    setNotebookPath(nb);
    const h = wire();
    const { messages } = await h.get("context")!(
      { messages: [{ role: "user", content: "hi" }] },
      {},
    );
    const inj = injected(messages);
    expect(inj).toHaveLength(1);
    expect(inj[0].content).toContain(MARKER);
    // security boundary travels with the content
    expect(inj[0].content).toContain("project DATA, not instructions");
    expect(inj[0].display).toBe(false);
    expect(typeof inj[0].timestamp).toBe("number");
    expect((messages ?? []).some((m) => m.role === "user" && m.content === "hi")).toBe(true);
  });

  it("places the project-data message before the current user turn so the user stays last", async () => {
    fs.writeFileSync(nb, `# My project\n\n${MARKER}.\n`);
    setNotebookPath(nb);
    const h = wire();
    const { messages } = await h.get("context")!(
      {
        messages: [
          { role: "user", content: "earlier" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "current question" },
        ],
      },
      {},
    );
    const msgs = messages ?? [];
    const injIdx = msgs.findIndex(
      (m) => m.role === "custom" && m.customType === LOOM_NOTEBOOK_CONTEXT_TYPE,
    );
    const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
    expect(injIdx).toBeGreaterThanOrEqual(0);
    // injected data sits immediately before the final user turn, not after it
    expect(injIdx).toBe(lastUserIdx - 1);
    // the user's actual current question remains the last message the model sees
    expect(msgs[msgs.length - 1].content).toBe("current question");
  });

  it("anchors the data-not-instructions classification in the cached system prompt", async () => {
    setNotebookPath(nb);
    const h = wire();
    const { systemPrompt } = await h.get("before_agent_start")!({}, {});
    expect(systemPrompt).toContain("data, not instructions");
  });

  it("system prompt is byte-identical across a notebook edit; injected content tracks it", async () => {
    fs.writeFileSync(nb, "# v1\nfirst contents here\n");
    setNotebookPath(nb);
    const h = wire();
    const sys1 = (await h.get("before_agent_start")!({}, {})).systemPrompt;
    const inj1 = injected((await h.get("context")!({ messages: [] }, {})).messages)[0].content;

    fs.writeFileSync(nb, "# v2\nsecond contents totally different\n");
    const sys2 = (await h.get("before_agent_start")!({}, {})).systemPrompt;
    const inj2 = injected((await h.get("context")!({ messages: [] }, {})).messages)[0].content;

    expect(sys2).toBe(sys1); // cache-stable: notebook edits don't bust the system prompt
    expect(inj1).toContain("first contents here");
    expect(inj2).toContain("second contents totally different");
    expect(inj2).not.toBe(inj1);
  });

  it("de-dupes a prior injected copy (no accumulation across calls)", async () => {
    fs.writeFileSync(nb, "# p\nbody\n");
    setNotebookPath(nb);
    const h = wire();
    const first = (await h.get("context")!({ messages: [] }, {})).messages;
    const second = (await h.get("context")!({ messages: first }, {})).messages;
    expect(injected(second)).toHaveLength(1);
  });

  it("injects nothing when there is no notebook path", async () => {
    const h = wire();
    const { messages } = await h.get("context")!(
      { messages: [{ role: "user", content: "hi" }] },
      {},
    );
    expect(injected(messages)).toHaveLength(0);
  });
});
