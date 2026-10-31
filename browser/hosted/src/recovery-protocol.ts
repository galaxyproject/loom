/** The messages between the recovery test and its worker, and the scripted call they share. */
import type { AskAnswer, AskRequest } from "../../core/src/agent/pi-host";

export interface RecoveryWorkerData {
  repo: string;
  /** Where Orbit's side files land; also the page record store's key directory. */
  dir: string;
  store: string;
  /** Reopen this conversation; absent on a first boot. */
  conversationId?: string;
}

/** Per-boot knobs the test passes beside workerData. */
export interface BootOptions {
  /**
   * Set ORBIT_FRESH_SESSION=1 in the worker's env. Orbit skips its startup greeting only on that
   * or on process.argv --continue; it ignores the session_start reason, so this is the one lever
   * a host has today to stop a reopen from sending the greeting again.
   */
  freshSession?: boolean;
}

/** The prompt the scripted model answers with the destructive call. */
export const DELETE_PROMPT = "DELETE_H1: delete history h1";
export const DELETE_CALL_ID = "del1";

export type ToWorker =
  | { cmd: "submit"; text: string }
  | { cmd: "answer"; id: number; outcome: "resolve"; value: AskAnswer }
  | { cmd: "answer"; id: number; outcome: "reject"; message: string }
  | { cmd: "close" }
  | { cmd: "idle"; rpc: number }
  | { cmd: "inspect"; rpc: number };

export type ToolResultView = {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
};
export type Inspection = {
  scheduling: string;
  tasks: Array<{ kind: string; status: string; phase: string | undefined; scheduler: string }>;
  toolResults: ToolResultView[];
};

export type FromWorker =
  | { type: "ready"; conversationId: string }
  | { type: "ask"; id: number; request: AskRequest; hasSignal: boolean }
  | { type: "ask-withdrawn"; id: number }
  /** The invocation signal pi-host hands the gate as ctx.signal, seen from a tool_call handler. */
  | { type: "call-signal"; toolCallId: string; present: boolean; aborted: boolean }
  | { type: "call-signal-aborted"; toolCallId: string }
  | { type: "galaxy"; method: string; path: string; body: string | undefined }
  /** A model request; lastText is the start of the newest message, enough to tell the greeting. */
  | { type: "model"; lastRole: string; lastText: string }
  | { type: "event"; event: string; toolCallId: string; toolName: string }
  | { type: "note"; note: string }
  | { type: "report"; message: string }
  | { type: "close-called" }
  | { type: "closed"; error?: string }
  | { type: "rpc"; rpc: number; value: unknown };
