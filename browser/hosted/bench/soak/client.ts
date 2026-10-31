/**
 * A simulated user: signs in through the host's real /auth/login, the stand-in Keycloak and
 * /auth/callback, then talks to the host over /ws as the page does. A Tab is one open page; a user
 * can hold several on one conversation.
 */
import { WebSocket } from "ws";

import type { ToPage } from "../../src/server/socket";
import type { Stack } from "./stack";

type Received = ToPage & { at: number };

let signingIn = Promise.resolve();

export class User {
  cookie = "";
  constructor(
    readonly stack: Stack,
    readonly sub: string,
  ) {}

  /** The authorization-code flow, one user at a time: the stand-in signs in whoever it was last told. */
  async signIn(): Promise<void> {
    const turn = signingIn.then(() => this.#signIn());
    signingIn = turn.catch(() => undefined);
    await turn;
  }

  async #signIn(): Promise<void> {
    const { stack } = this;
    stack.keycloak.user = this.sub;
    const login = await fetch(`${stack.origin}/auth/login`, { redirect: "manual" });
    const signin = cookiesOf(login);
    const authorize = await fetch(login.headers.get("location")!, { redirect: "manual" });
    const callback = await fetch(authorize.headers.get("location")!, { redirect: "manual", headers: { cookie: signin } });
    if (callback.status !== 302) throw new Error(`Sign-in for ${this.sub} failed: ${callback.status} ${await callback.text()}`);
    this.cookie = cookiesOf(callback);
    if (!this.cookie.includes("orbit_session=")) throw new Error(`No session cookie for ${this.sub}`);
  }

  async api(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.stack.origin}${path}`, {
      ...init,
      headers: { cookie: this.cookie, origin: this.stack.origin, ...(init.headers as Record<string, string>) },
    });
  }

  async newConversation(): Promise<string> {
    const response = await this.api("/api/conversations", { method: "POST" });
    if (response.status !== 201) throw new Error(`Creating a conversation for ${this.sub}: ${response.status}`);
    return ((await response.json()) as { id: string }).id;
  }

  async tab(conversationId: string): Promise<Tab> {
    const tab = new Tab(this, conversationId);
    await tab.opened;
    tab.send({ type: "open" });
    return tab;
  }
}

/** Only the name=value of each Set-Cookie, ignoring cleared ones. */
function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

export class Tab {
  readonly received: Received[] = [];
  readonly ws: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<void>;
  /** Confirms answered by this tab, by id. */
  readonly answered = new Set<number>();
  #listeners = new Set<() => void>();

  constructor(
    readonly user: User,
    readonly conversationId: string,
  ) {
    this.ws = new WebSocket(`${user.stack.origin.replace("http", "ws")}/ws`, {
      headers: { cookie: user.cookie, origin: user.stack.origin },
    });
    this.ws.on("message", (raw) => {
      this.received.push({ ...(JSON.parse(String(raw)) as ToPage), at: performance.now() });
      for (const listener of [...this.#listeners]) listener();
    });
    // A socket that never opens (the host is down) still has to settle both.
    this.ws.on("error", () => undefined);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      this.ws.once("error", reject);
    });
    this.closed = new Promise((resolve) => this.ws.once("close", () => resolve()));
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ conversationId: this.conversationId, ...message }));
  }

  submit(text: string): void {
    this.send({ type: "submit", text });
  }

  confirm(id: number, approved: boolean): void {
    this.answered.add(id);
    this.send({ type: "confirmed", id, approved });
  }

  close(): void {
    this.ws.close();
  }

  /** Wait until `test` holds over what's been received, starting from index `from`. */
  async until<T>(test: (messages: Received[]) => T | undefined, timeoutMs = 30_000, from = 0): Promise<T> {
    const check = () => test(this.received.slice(from));
    const now = check();
    if (now !== undefined && now !== false) return now;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#listeners.delete(listener);
        const last = this.received.slice(-5).map((m) => (m.type === "notice" ? `notice "${m.text}"` : m.type === "failed" ? `failed "${m.message}"` : m.type));
        reject(new Error(`Timed out on ${this.user.sub}'s tab: ${last.join(", ")}`));
      }, timeoutMs);
      const listener = () => {
        const got = check();
        if (got === undefined || got === false) return;
        clearTimeout(timer);
        this.#listeners.delete(listener);
        resolve(got);
      };
      this.#listeners.add(listener);
    });
  }

  confirmsShown(): Array<{ id: number; title: string; at: number }> {
    return this.received.flatMap((m) => (m.type === "confirm" ? [{ id: m.id, title: m.title, at: m.at }] : []));
  }
}
