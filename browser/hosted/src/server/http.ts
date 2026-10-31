/** The host's one HTTP server: health, sign-in, the conversation list, the WebSocket and the shell. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { handleAuth, sessionOf, type AuthContext } from "../auth/routes";
import { createConversation, listConversations } from "../dispatch/conversations";
import type { Sockets } from "./socket";
import { serveStatic } from "./static";

export interface HostServerOptions {
  readonly auth: AuthContext;
  readonly sockets: Sockets;
  /** The built shell; absent in tests that only talk to the API. */
  readonly webRoot?: string;
  /** Whether Postgres and Keycloak answer, for /healthz. */
  readonly health: () => Promise<Record<string, boolean>>;
  readonly log?: (message: string) => void;
  /** The model every conversation runs on, for the page to name. */
  readonly model?: string;
}

/** Who Galaxy says the user is, for the page's masthead; nothing when Galaxy can't say. */
async function galaxyUser(auth: AuthContext, sub: string): Promise<{ username?: string; email?: string }> {
  try {
    const token = await auth.tokens.token(sub);
    const response = await fetch(new URL("/api/users/current", auth.galaxyUrl), {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return {};
    const body = (await response.json()) as { username?: unknown; email?: unknown };
    return {
      ...(typeof body.username === "string" && { username: body.username }),
      ...(typeof body.email === "string" && { email: body.email }),
    };
  } catch {
    return {};
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function createHostServer(options: HostServerOptions): Server {
  const { auth } = options;
  const server = createServer((req, res) => {
    handle(req, res).catch((error: Error) => {
      options.log?.(`request ${req.method} ${req.url} failed: ${error.message}`);
      if (!res.headersSent) json(res, 500, { error: "Something went wrong." });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", auth.publicUrl).pathname;
    if (path === "/healthz") {
      const checks = await options.health();
      json(res, Object.values(checks).every(Boolean) ? 200 : 503, checks);
      return;
    }
    if (path.startsWith("/auth/") && (await handleAuth(auth, req, res))) return;
    if (path.startsWith("/api/")) {
      const session = await sessionOf(auth, req);
      if (!session) return json(res, 401, { error: "Not signed in.", login: "/auth/login" });
      if (path === "/api/me" && req.method === "GET") {
        return json(res, 200, {
          sub: session.sub,
          galaxyUrl: auth.galaxyUrl.href,
          model: options.model,
          ...(await galaxyUser(auth, session.sub)),
        });
      }
      if (path === "/api/conversations" && req.method === "GET") {
        const rows = await listConversations(auth.pool, session.sub);
        return json(res, 200, rows.map((c) => ({ id: c.id, title: c.title, lastActiveAt: c.lastActiveAt })));
      }
      if (path === "/api/conversations" && req.method === "POST") {
        // A cross-site form can't create conversations for the user.
        if (req.headers.origin !== auth.publicUrl.origin) return json(res, 403, { error: "Not from Orbit." });
        const created = await createConversation(auth.pool, session.sub);
        return json(res, 201, { id: created.id });
      }
      return json(res, 404, { error: "Not found." });
    }
    if (options.webRoot && (await serveStatic(options.webRoot, req, res))) return;
    json(res, 404, { error: "Not found." });
  }

  options.sockets.attach(server);
  return server;
}
