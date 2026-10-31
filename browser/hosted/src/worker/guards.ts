/**
 * The two tool_call guards the worker registers ahead of Orbit's own: a default-deny gate that only
 * lets through the pinned server surface, and a per-run cap on tool calls.
 */
import surface from "../../__surface__/server/tools.json";

/**
 * Tools hosted Orbit doesn't offer. User-defined tools run arbitrary code on Galaxy under the user's
 * account; managing them (listing, deleting) goes with them until live acceptance decides otherwise.
 * The lesson bank and the approval registry are local, per-install stores with no hosted home yet.
 */
export const WITHHELD_TOOLS: ReadonlySet<string> = new Set([
  "create_user_tool",
  "run_user_tool",
  "list_user_tools",
  "delete_user_tool",
  "lesson_propose",
  "lessons_search",
  "loom_propose",
]);

/** The tools a hosted worker may run, from the pinned surface snapshot. */
export const SERVER_TOOLS: ReadonlySet<string> = new Set(surface as string[]);

type Blocked = { block: true; reason: string } | undefined;
type On = (event: string, handler: (event: { toolName: string; source?: string }) => Blocked | void) => void;

/**
 * Block any tool outside the surface. A tool Orbit gains later is refused here until the snapshot
 * that pins it is updated and reviewed, so the server's surface never grows by accident.
 */
export function registerSurfaceGate(on: On, allowed: ReadonlySet<string> = SERVER_TOOLS): void {
  on("tool_call", (event) =>
    allowed.has(event.toolName)
      ? undefined
      : { block: true, reason: `${event.toolName} is not available in hosted Orbit.` },
  );
}

/**
 * Block tool calls past `max` per user message. The count restarts on the user's input, not on
 * agent_start: queued follow-ups continue a run without one, and a run Orbit starts on its own
 * shouldn't get a fresh budget the user never asked for.
 */
export function registerToolCallCap(on: On, max: number): void {
  let calls = 0;
  on("input", (event) => {
    if (event.source !== "extension") calls = 0;
  });
  on("tool_call", () => {
    calls += 1;
    if (calls <= max) return undefined;
    return {
      block: true,
      reason: `This turn has used its ${max} tool calls. Stop calling tools; tell the user what you found and what is left to do.`,
    };
  });
}
