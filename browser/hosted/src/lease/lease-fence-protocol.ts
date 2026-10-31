/** The messages between the stale-lease test and its worker, and the scripted prompts they share. */

export interface LeaseWorkerData {
  repo: string;
  dir: string;
  database: string;
  /** The worker has no env, so pg cannot default the role from USER. */
  user: string;
  storeId: string;
  leaseGen: number;
  fatal: boolean;
  conversationId?: string;
  /** Post `ready` with an inspection taken before harness.resume(), and resume only on command. */
  deferResume?: boolean;
  /** Build the fence without an onLost, so the thread exits through LeaseFence's own default. */
  defaultOnLost?: boolean;
}

/**
 * Where a held Galaxy request waits. `outside` the fence, the generation check runs after the
 * lease moves; `inside`, the request has already passed the check, as when Galaxy is slow to answer.
 */
export type HoldAt = "outside" | "inside";

/** Each scripted prompt makes the model call one Galaxy tool, then answer in words. */
export const PROMPTS = {
  read: { text: "READ_H1: show me history h1", callId: "read1" },
  rename: { text: "RENAME_H1: rename history h1", callId: "ren1" },
} as const;

export type ErrorView = { name: string; message: string; chain: string[] };

export type TaskView = {
  id: string;
  kind: string;
  status: string;
  phase: string | undefined;
  scheduler: string;
};
export type ToolResultView = { toolCallId: string; isError: boolean; text: string };
export type Inspection =
  | { ok: true; scheduling: string; tasks: TaskView[]; toolResults: ToolResultView[] }
  | { ok: false; error: ErrorView };

export type ToWorker =
  | { cmd: "submit"; text: string }
  | { cmd: "hold"; method: string; path: string; at: HoldAt }
  | { cmd: "release" }
  | { cmd: "resume" }
  | { cmd: "close" }
  | { cmd: "idle"; rpc: number }
  | { cmd: "inspect"; rpc: number };

export type FromWorker =
  | { type: "ready"; conversationId: string; beforeResume?: Inspection }
  | { type: "galaxy"; method: string; path: string; at: number }
  | { type: "galaxy-refused"; method: string; path: string; error: ErrorView }
  | { type: "held"; method: string; path: string; at: HoldAt }
  | { type: "model"; lastRole: string; at: number }
  | { type: "commit"; seq: number }
  | { type: "commit-rejected"; error: ErrorView; caller: string[] }
  | { type: "lease-lost"; storeId: string; expectedGen: number; currentGen: number }
  | { type: "report"; error: ErrorView }
  | { type: "unhandled"; error: ErrorView }
  /** `admitted` is false when pi-host turned the input away, as it does on a busy conversation. */
  | { type: "submit-settled"; ok: boolean; admitted?: boolean; error?: ErrorView }
  | { type: "event"; event: string; toolCallId: string; toolName: string }
  | { type: "closed"; error?: ErrorView }
  | { type: "rpc"; rpc: number; value: unknown };
