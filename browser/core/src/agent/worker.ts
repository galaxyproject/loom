/**
 * The agent worker's protocol with the page, and its entry: the worker runs Orbit's brain
 * (orbit/worker.ts), with what a flavor adds to the shell.
 */
import type { AgentEvent, ConversationId } from "@earendil-works/pi-durable";

import type { GalaxyStatus } from "./galaxy-status";
import type { Placement, RuntimeConfig } from "./runtime";
import type { SessionDocument } from "./saved";
import type { RecordSummary } from "./records";
import type { AgentFlavor } from "./tools";
import type { Settled } from "./orbit/watch";
import { browserEnv } from "./orbit/browser-env";
import { startOrbitWorker } from "./orbit/worker";

export interface OpenRequest {
  pyodideURL: string;
  config: RuntimeConfig;
  placement: Placement;
  /** A saved session the page was opened on. */
  saved?: { id: string; document: SessionDocument };
  /** Take the conversation over from the tab that has it open. */
  steal?: boolean;
}

/** Why follow-ups are waiting for the user, when they are. */
export type Waiting = "paused" | "capped" | undefined;

export type WorkerMessage =
  /** Another tab has this conversation open. */
  | { type: "waiting" }
  /** Another tab took the conversation over. */
  | { type: "lost" }
  | {
      type: "ready";
      /** Which brain answers: Orbit's, the only one. */
      brain?: "orbit";
      unkept?: string;
      galaxy: GalaxyStatus;
      galaxyProblem?: string;
      /** Why the history's earlier records could not be looked up. */
      recordsProblem?: string;
    }
  /** No session kept here, but the launch history has records of this brand to choose from. */
  | { type: "recoverable"; records: RecordSummary[] }
  | { type: "events"; events: readonly AgentEvent[] }
  /** Galaxy work the conversation watched has settled. */
  | { type: "settled"; settled: Settled }
  | { type: "held"; held: Waiting }
  | { type: "confirm"; id: number; title: string; message: string }
  /** A confirmation the agent no longer waits on. */
  | { type: "withdrawn"; id: number }
  | { type: "reply"; id: number; value?: unknown; error?: string }
  /** The page's message started no run (a slash command): nothing is busy. */
  | { type: "quiet" }
  /** Something the brain told the user outside a turn: a slash command's answer, a notice. */
  | {
      type: "notice";
      level: "info" | "warning" | "error";
      text: string;
      conversationId?: ConversationId;
    }
  | { type: "failed"; message: string };

export type PageMessage =
  | { type: "open"; request: OpenRequest }
  | { type: "submit"; text: string }
  | { type: "stop" }
  | { type: "confirmed"; id: number; approved: boolean }
  | { type: "reset" }
  | { type: "switch"; id: number; config: Partial<RuntimeConfig> }
  | { type: "export"; id: number; title: string }
  | { type: "saved"; id: number; savedId: string; document: SessionDocument }
  /** Continue the session whose record is `pageId`, or start a new one. */
  | { type: "recover"; pageId?: string };

/** Run this worker as the agent, with what `agentFlavor` adds to it. */
export function startAgentWorker(agentFlavor: AgentFlavor): void {
  const receive = startOrbitWorker(agentFlavor, browserEnv);
  self.onmessage = (event: MessageEvent<PageMessage>) => receive(event.data);
}
