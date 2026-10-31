/** What the host and a conversation's worker say to each other over the worker's port. */
import type { AgentEvent } from "@earendil-works/pi-durable";

import type { AskAnswer, AskRequest } from "../../../core/src/agent/pi-host";
import type { TokenFailure } from "./galaxy-fetch";

/**
 * The host's answer to a token request: the user's access token, or why there isn't one. `lease`
 * means the worker's generation is no longer current, which the worker treats as a lost lease.
 */
export type TokenAnswer =
  | { readonly token: string }
  | { readonly failure: TokenFailure | { readonly kind: "lease"; readonly message: string } };

/**
 * A worker exits with this when pi-durable poisons its session (a commit failed after storage took
 * it), which only a reopen clears; the host treats it as a crash and resumes on a fresh worker.
 */
export const SESSION_POISONED_EXIT_CODE = 70;

export interface WorkerData {
  /** The pi-durable store this conversation lives in, and the lease generation the worker holds. */
  readonly storeId: string;
  readonly leaseGen: number;
  /** The conversation to reopen; absent for a new one. */
  readonly conversationId?: string;
  /** Postgres, as a connection string. A credential: it travels here, never in the environment. */
  readonly database: string;
  readonly galaxyUrl: string;
  /** The Galaxy page holding the conversation's record. */
  readonly pageId: string;
  readonly model: {
    readonly baseUrl: string;
    readonly id: string;
    readonly apiKey: string;
    /** Whose turn this is, sent as each model request's `user` so an endpoint that logs it (LiteLLM's spend log) can account per user. */
    readonly user: string;
  };
  readonly limits: {
    /** Model turns per run (pi-durable's maxTurns). */
    readonly maxTurns: number;
    /**
     * Tool calls per user message; past it, calls are blocked with a reason the model reads. Runs
     * Orbit starts itself (an auto-resume follow-up) count against the last user message's budget.
     */
    readonly maxToolCalls: number;
    /** Bytes the spilled-output ring may hold. */
    readonly outputBytes: number;
  };
  /** V8's compile cache directory, which the image's worker loader turns on before the bundle loads. */
  readonly compileCache?: string;
  /** Tests only: report every filesystem and child_process call the worker makes. */
  readonly traceReaches?: boolean;
}

export type ToWorker =
  | { readonly cmd: "submit"; readonly text: string }
  | { readonly cmd: "answer"; readonly id: number; readonly value: AskAnswer }
  /** The user's Stop: abort the run; a pending confirm is withdrawn and its call not run. */
  | { readonly cmd: "stop" }
  /** Post a fresh snapshot of the conversation, for a browser that just connected. */
  | { readonly cmd: "snapshot" }
  | ({ readonly cmd: "token"; readonly id: number } & TokenAnswer)
  | { readonly cmd: "close" }
  /**
   * Idle release: close as `close` does, but only at a quiet point (nothing asking, no unfinished
   * task); otherwise say `not-quiet` and carry on.
   */
  | { readonly cmd: "release" };

export type FromWorker =
  | {
      readonly type: "ready";
      readonly conversationId: string;
      /** A run interrupted earlier (a crash, a restart) picked up again on open; it ends in `settled`. */
      readonly resuming: boolean;
      readonly tools: readonly string[];
      /** The names in the worker's environment, so the host can check nothing leaked in. */
      readonly env: readonly string[];
    }
  | { readonly type: "ask"; readonly id: number; readonly request: AskRequest }
  | { readonly type: "ask-withdrawn"; readonly id: number }
  /** pi-durable's conversation events, from a snapshot on: what the browser draws. */
  | { readonly type: "events"; readonly events: readonly AgentEvent[] }
  /** The worker needs the user's access token for a Galaxy request. */
  | { readonly type: "token"; readonly id: number }
  | { readonly type: "notify"; readonly text: string; readonly level: "info" | "warning" | "error" }
  /** Whether a submitted input was taken; a conversation busy with an Orbit follow-up refuses it. */
  | { readonly type: "submitted"; readonly admitted: boolean }
  /** A run has finished and the conversation is idle until the next input. */
  | { readonly type: "settled"; readonly aborted: boolean }
  | { readonly type: "report"; readonly message: string }
  | { readonly type: "reach"; readonly api: string }
  | { readonly type: "closed"; readonly error?: string }
  /** A release refused: the conversation has work in hand, so the worker stays. */
  | { readonly type: "not-quiet" };
