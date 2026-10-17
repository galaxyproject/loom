import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { setGalaxyFetchOverride } from "../extensions/loom/galaxy-api";
import { fixtureFetch } from "../extensions/loom/galaxy-fixture";
import { registerGalaxyHistoryGuard } from "../extensions/loom/galaxy-history-guard";
import { registerGalaxyRepeatGuard } from "../extensions/loom/galaxy-repeat-guard";

// Orbit's own refusal texts for its repeated-failure and cross-history guards,
// pinned as Orbit's code writes them. Both guards began as ports of the
// browser's (#567 "Guards"), but Orbit is the base now: when slice 4 deletes
// the browser's copies, its guards.test.ts follows these strings, not the
// other way round.

vi.mock("../extensions/loom/state", () => ({ getNotebookPath: () => null }));

type Handler = (event: unknown, ctx?: unknown) => unknown;

function handlersOf(register: (pi: ExtensionAPI) => void): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  register({ on: (event: string, h: Handler) => handlers.set(event, h) } as never);
  return handlers;
}

const RUN_TOOL = "mcp__galaxy__run_tool";
const ARGS = { history_id: "here", tool_id: "cat1", inputs: { input1: { src: "hda", id: "d1" } } };

beforeEach(() => {
  vi.stubEnv("GALAXY_URL", "https://galaxy.example.org");
  vi.stubEnv("GALAXY_API_KEY", "fixture-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  setGalaxyFetchOverride(null);
});

describe("loom's port of the browser's Galaxy guards", () => {
  it("refuses the 4th identical call after three failures", async () => {
    const on = handlersOf(registerGalaxyRepeatGuard);
    for (let i = 1; i <= 3; i++) {
      expect(
        await on.get("tool_call")!({ toolName: RUN_TOOL, toolCallId: `c${i}`, input: ARGS }),
      ).toBeFalsy();
      await on.get("tool_result")!({
        toolName: RUN_TOOL,
        toolCallId: `c${i}`,
        input: ARGS,
        content: [{ type: "text", text: "HTTP 400: bad input" }],
        isError: true,
      });
    }
    expect(
      await on.get("tool_call")!({ toolName: RUN_TOOL, toolCallId: "c4", input: ARGS }),
    ).toEqual({
      block: true,
      reason:
        `Refused: '${RUN_TOOL}' was already called with these exact arguments 3 times and failed each time. ` +
        "Change the arguments or the approach; resending the same call cannot succeed.",
    });
  });

  it("refuses a run whose input is in another history", async () => {
    setGalaxyFetchOverride(
      fixtureFetch([
        {
          path: "/api/datasets/d1",
          responses: [
            { status: 200, body: { id: "d1", name: "reads.fastq", history_id: "elsewhere" } },
          ],
        },
      ]),
    );
    const on = handlersOf(registerGalaxyHistoryGuard);
    const foreign = [
      { input: "input1", supplied_id: "d1", history_id: "elsewhere", name: "reads.fastq" },
    ];
    expect(
      await on.get("tool_call")!({ toolName: RUN_TOOL, toolCallId: "c1", input: ARGS }),
    ).toEqual({
      block: true,
      reason:
        "Refused: these inputs are in another history, not in history here " +
        `where this job runs: ${JSON.stringify(foreign)}. An id from another history is ` +
        "usually the wrong one: take the input's `id` from get_history_contents for this " +
        "history. If the user does mean that data, say which history it is in and ask them " +
        "to copy it into this one in Galaxy, then use the copy's id.",
    });
  });
});
