/**
 * The browser's WebSocket (brief H8). It speaks the browser shell's worker protocol (core's
 * worker.ts WorkerMessage/PageMessage), so the shell runs unchanged over it, with every message from
 * the page naming the conversation it's about. The socket authenticates by the session cookie, only
 * from Orbit's own origin, and checks the conversation belongs to the user on every message.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import type { WorkerMessage } from "../../../core/src/agent/worker";
import type { AuthContext } from "../auth/routes";
import { readCookie, SESSION_COOKIE, sessionOf } from "../auth/routes";
import { findSession } from "../auth/sessions";
import {
  createConversation,
  getConversation,
  titleIfUntitled,
  type ConversationRow,
} from "../dispatch/conversations";
import type { DispatchEvent, Dispatcher } from "../dispatch/dispatcher";
import type { FromWorker } from "../worker/protocol";
import { storedSnapshot } from "./snapshot";

/** What the page sends: the shell's PageMessage, plus the conversation it's for. */
type FromPage =
  | { type: "open"; conversationId: string }
  | { type: "submit"; conversationId: string; text: string }
  | { type: "stop"; conversationId: string }
  | { type: "confirmed"; conversationId: string; id: number; approved: boolean }
  | { type: "reset"; conversationId: string }
  | { type: "switch" | "export" | "saved"; conversationId: string; id: number };

/** Besides the shell's own messages: the conversation the page should move to after a reset. */
export type ToPage = WorkerMessage | { type: "moved"; conversationId: string };

export interface SocketContext {
  readonly auth: AuthContext;
  readonly dispatcher: Dispatcher;
  /** When set, turns are turned away with this notice: the kill switch. */
  readonly turnsDisabled?: string;
  readonly log?: (message: string) => void;
  /** Carries a newly set title to the conversation's Galaxy page, when it already has one. */
  readonly retitlePage?: (conversation: ConversationRow) => Promise<void>;
}

const MAX_MESSAGE_BYTES = 256 * 1024;

export class Sockets {
  readonly #c: SocketContext;
  readonly #server = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  /** Who is watching each conversation. */
  readonly #watching = new Map<string, Set<WebSocket>>();
  /**
   * What a page that just opened a running conversation gets once the worker's snapshot reaches it,
   * or, with `fromStore`, if the worker exits first.
   */
  readonly #afterSnapshot = new Map<WebSocket, (fromStore: boolean) => void>();

  constructor(context: SocketContext) {
    this.#c = context;
  }

  /** Take /ws upgrades on `http`. */
  attach(http: Server): void {
    http.on("upgrade", (req, socket, head) => {
      // A malformed request must cost one socket, never the process.
      this.#upgrade(req, socket, head).catch((error: Error) => {
        this.#c.log?.(`upgrade refused: ${error.message}`);
        socket.destroy();
      });
    });
  }

  /** Whether any page has the conversation open; a watched conversation keeps its worker. */
  watched(conversationId: string): boolean {
    return (this.#watching.get(conversationId)?.size ?? 0) > 0;
  }

  /** The dispatcher's events, sent to every page watching the conversation. */
  deliver(conversationId: string, event: FromWorker | DispatchEvent): void {
    const watchers = this.#watching.get(conversationId);
    if (!watchers?.size) return;
    // A worker gone before its snapshot never sends one, and a page waiting on it would never be ready.
    if (event.type === "worker-exit") {
      for (const ws of watchers) {
        const then = this.#afterSnapshot.get(ws);
        this.#afterSnapshot.delete(ws);
        then?.(true);
      }
    }
    const message = this.#translate(conversationId, event);
    if (!message) return;
    const text = JSON.stringify(message);
    const snapshot = message.type === "events" && message.events.some((e) => e.type === "snapshot");
    for (const ws of watchers) {
      ws.send(text);
      const then = snapshot ? this.#afterSnapshot.get(ws) : undefined;
      if (then) {
        this.#afterSnapshot.delete(ws);
        then(false);
      }
    }
  }

  async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const refuse = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://x").pathname;
    } catch {
      return refuse("400 Bad Request");
    }
    if (path !== "/ws") return refuse("404 Not Found");
    // A page on another site can open a WebSocket with the user's cookie; only Orbit's own may.
    if (req.headers.origin !== this.#c.auth.publicUrl.origin) return refuse("403 Forbidden");
    const session = await sessionOf(this.#c.auth, req).catch(() => undefined);
    if (!session) return refuse("401 Unauthorized");
    const sessionId = readCookie(
      req,
      this.#c.auth.publicUrl.protocol === "https:" ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE,
    )!;
    this.#server.handleUpgrade(req, socket, head, (ws) =>
      this.#connected(ws, session.sub, sessionId),
    );
  }

  #connected(ws: WebSocket, sub: string, sessionId: string): void {
    let watching: string | undefined;
    const send = (message: ToPage) => ws.send(JSON.stringify(message));
    const unwatch = () => {
      const left = watching ? this.#watching.get(watching) : undefined;
      if (left?.delete(ws) && left.size === 0) this.#c.dispatcher.unwatched(watching!);
      watching = undefined;
    };
    ws.on("close", () => {
      unwatch();
      this.#afterSnapshot.delete(ws);
    });
    ws.on("message", (raw) => {
      let message: FromPage;
      try {
        message = JSON.parse(String(raw)) as FromPage;
      } catch {
        return;
      }
      // The session is checked on every message, not just at upgrade: signing out (or the session
      // running out) in another tab ends this socket too.
      void findSession(this.#c.auth.pool, sessionId)
        .then((session) => {
          if (session?.sub !== sub) {
            send({ type: "failed", message: "You're signed out. Reload to sign in again." });
            ws.close(4401, "signed out");
            return;
          }
          return this.#handle(
            message,
            sub,
            ws,
            send,
            (then) => (then ? this.#afterSnapshot.set(ws, then) : this.#afterSnapshot.delete(ws)),
            (id) => {
              unwatch();
              watching = id;
              const set = this.#watching.get(id) ?? new Set();
              set.add(ws);
              this.#watching.set(id, set);
            },
          );
        })
        .catch((error: Error) => {
          this.#c.log?.(`socket message failed: ${error.message}`);
          send({ type: "failed", message: "Orbit couldn't do that. Try again in a moment." });
        });
    });
  }

  async #handle(
    message: FromPage,
    sub: string,
    ws: WebSocket,
    send: (message: ToPage) => void,
    afterSnapshot: (then: ((fromStore: boolean) => void) | undefined) => void,
    watch: (conversationId: string) => void,
  ): Promise<void> {
    const { dispatcher } = this.#c;
    if (typeof message?.conversationId !== "string") return;
    // Every message, not just open: a page can name any conversation in any message.
    const conversation = await getConversation(this.#c.auth.pool, message.conversationId);
    if (!conversation || conversation.ownerSub !== sub) {
      send({ type: "failed", message: "That conversation isn't yours, or no longer exists." });
      return;
    }
    const id = conversation.id;
    switch (message.type) {
      case "open": {
        watch(id);
        // Ready and any waiting asks go after the snapshot: a snapshot clears the chat, and with it
        // anything drawn before. A running worker sends its own snapshot, which every watcher redraws
        // from; otherwise the store has everything there is.
        const greet = () => {
          send({ type: "ready", galaxy: "ok" });
          for (const ask of dispatcher.pendingAsks(id)) {
            const shown = this.#translate(id, { type: "ask", id: ask.id, request: ask.request });
            if (shown) send(shown);
          }
        };
        const fromStore = async () => {
          send({ type: "events", events: [await storedSnapshot(this.#c.auth.pool, conversation)] });
          greet();
        };
        if (dispatcher.isLive(id)) {
          afterSnapshot((stale) => {
            if (!stale) return greet();
            fromStore().catch((error: Error) => {
              this.#c.log?.(`snapshot after worker exit failed: ${error.message}`);
              send({
                type: "failed",
                message: "Orbit couldn't load this conversation. Reload to try again.",
              });
            });
          });
          if (dispatcher.snapshot(id)) return;
          afterSnapshot(undefined);
        }
        await fromStore();
        // Paused on a confirm nobody answered: coming back is the answer to wait for, so it asks again.
        // Mid-pause counts too; the row isn't marked until the worker has closed.
        if ((conversation.paused || dispatcher.pausing(id)) && !this.#c.turnsDisabled) await dispatcher.resume(id);
        return;
      }
      case "submit":
        if (this.#c.turnsDisabled) {
          // failed, not a notice: the shell went busy on submit, and only failed or a run's end clears it.
          send({ type: "failed", message: this.#c.turnsDisabled });
          return;
        }
        if (typeof message.text !== "string" || !message.text.trim()) return;
        if (conversation.title === null) {
          const titled = await titleIfUntitled(this.#c.auth.pool, id, message.text);
          // Best effort and not awaited: a page left with its old name isn't worth holding up the turn.
          if (titled?.pageId && this.#c.retitlePage) {
            this.#c
              .retitlePage(titled)
              .catch((error: Error) => this.#c.log?.(`page title for ${id}: ${error.message}`));
          }
        }
        await dispatcher.submit(id, message.text);
        return;
      case "stop":
        dispatcher.stop(id);
        return;
      case "confirmed":
        // Under the kill switch a paused run doesn't go on: a yes counts as a no.
        if (
          dispatcher.answer(
            id,
            Number(message.id),
            message.approved === true && !this.#c.turnsDisabled,
          )
        ) {
          // The same dialog is open in the user's other tabs; it's settled now, so close it there.
          const withdrawn = JSON.stringify({
            type: "withdrawn",
            id: Number(message.id),
          } satisfies ToPage);
          for (const other of this.#watching.get(id) ?? []) if (other !== ws) other.send(withdrawn);
        }
        return;
      case "reset": {
        // A new conversation; the old one stays in the list.
        const fresh = await createConversation(this.#c.auth.pool, sub);
        send({ type: "moved", conversationId: fresh.id });
        return;
      }
      case "switch":
      case "export":
      case "saved":
        send({
          type: "reply",
          id: Number(message.id),
          error: "Hosted Orbit sets the model and keeps conversations itself.",
        });
        return;
    }
  }

  /** The dispatcher's event as the shell's message, or nothing for what the page doesn't show. */
  #translate(conversationId: string, event: FromWorker | DispatchEvent): WorkerMessage | undefined {
    switch (event.type) {
      case "events":
        return { type: "events", events: event.events };
      case "ask":
        if (event.request.kind === "confirm") {
          return {
            type: "confirm",
            id: event.id,
            title: event.request.title,
            message: event.request.message,
          };
        }
        // The shell only has a confirm dialog; anything else goes unanswered rather than hang.
        this.#c.dispatcher.answer(conversationId, event.id, undefined);
        return {
          type: "notice",
          text: "Orbit asked something this page can't show yet, so it went unanswered.",
          level: "warning",
        };
      case "ask-withdrawn":
        return { type: "withdrawn", id: event.id };
      case "notify":
        return { type: "notice", text: event.text, level: event.level };
      case "paused":
        return {
          type: "notice",
          text: "Orbit paused this conversation while it waited for your answer. Open it again or send a message and it will ask again.",
          level: "info",
        };
      case "waiting":
        return {
          type: "notice",
          text: "Waiting for your other conversation's turn to finish.",
          level: "info",
        };
      case "failed":
        return { type: "failed", message: event.message };
      case "worker-exit":
        // A lost lease means another host has the conversation; it says nothing to the user.
        if (event.code === 0 || event.code === 75) return undefined;
        return {
          type: "notice",
          text: "Orbit restarted this conversation; it picks up where it left off.",
          level: "warning",
        };
      default:
        return undefined;
    }
  }
}
