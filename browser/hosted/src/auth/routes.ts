/**
 * Sign-in over HTTP (brief H6): the backend-for-frontend pattern BRC Analytics uses. The host runs the
 * authorization code flow with PKCE against Keycloak and keeps the tokens; the browser only ever holds
 * an HttpOnly session cookie.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";

import type { TokenCache } from "../tokens/token-cache";
import type { Oidc } from "./oidc";
import { seal, unseal } from "./seal";
import { createSession, endSession, findSession, type Session } from "./sessions";

// __Host- on https, so a sibling *.galaxyproject.org host can't plant either cookie for this one.
export const SESSION_COOKIE = "orbit_session";
const SIGNIN_COOKIE = "orbit_signin";
const cookieName = (context: AuthContext, name: string) => (context.publicUrl.protocol === "https:" ? `__Host-${name}` : name);
const SIGNIN_PURPOSE = "orbit sign-in";
const SIGNIN_TTL_S = 600;

export interface AuthContext {
  readonly pool: Pool;
  readonly oidc: Oidc;
  readonly tokens: TokenCache;
  readonly tokenKey: Buffer;
  readonly publicUrl: URL;
  readonly galaxyUrl: URL;
  /** Where an unlinked user signs in to Galaxy once, so Galaxy learns their Keycloak identity. */
  readonly galaxyLinkUrl: URL;
  /** Tests stand in for Galaxy's account check. */
  readonly fetch?: typeof fetch;
  readonly log?: (message: string) => void;
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join("="));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function cookie(context: AuthContext, name: string, value: string, attrs: { maxAge?: number }): string {
  return [
    `${cookieName(context, name)}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(context.publicUrl.protocol === "https:" ? ["Secure"] : []),
    ...(attrs.maxAge === undefined ? [] : [`Max-Age=${attrs.maxAge}`]),
  ].join("; ");
}

/** The signed-in user behind a request's session cookie, if any. */
export async function sessionOf(context: AuthContext, req: IncomingMessage): Promise<Session | undefined> {
  const id = readCookie(req, cookieName(context, SESSION_COOKIE));
  return id ? findSession(context.pool, id) : undefined;
}

function redirect(res: ServerResponse, location: string, status = 302, cookies: string[] = []): void {
  res.writeHead(status, { location, "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) });
  res.end();
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

/**
 * Only a path on this host, so a crafted return can't bounce a fresh session somewhere else, and
 * nothing that could break out of the Location header.
 */
const safeReturn = (raw: string | null) =>
  raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\") && !/[^\x21-\x7e]/.test(raw) ? raw : "/";

/** Handle the /auth routes; false for anything else. */
export async function handleAuth(context: AuthContext, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", context.publicUrl);
  const redirectUri = new URL("/auth/callback", context.publicUrl).href;

  if (req.method === "GET" && url.pathname === "/auth/login") {
    let begun;
    try {
      begun = await context.oidc.begin(redirectUri);
    } catch {
      plain(res, 503, "The sign-in service couldn't be reached. Try again in a minute.");
      return true;
    }
    const pending = JSON.stringify({
      state: begun.state,
      verifier: begun.verifier,
      back: safeReturn(url.searchParams.get("return")),
      // Checked at the callback: a planted or replayed sign-in state stops working after ten minutes.
      exp: Date.now() + SIGNIN_TTL_S * 1000,
    });
    const box = seal(context.tokenKey, pending, SIGNIN_PURPOSE).toString("base64url");
    redirect(res, begun.url.href, 302, [cookie(context, SIGNIN_COOKIE, box, { maxAge: SIGNIN_TTL_S })]);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/callback") {
    const clear = cookie(context, SIGNIN_COOKIE, "", { maxAge: 0 });
    const box = readCookie(req, cookieName(context, SIGNIN_COOKIE));
    const opened = box ? unseal(context.tokenKey, Buffer.from(box, "base64url"), SIGNIN_PURPOSE) : undefined;
    const pending = opened ? (JSON.parse(opened) as { state: string; verifier: string; back: string; exp: number }) : undefined;
    if (!pending || !(pending.exp > Date.now())) {
      res.setHeader("set-cookie", [clear]);
      plain(res, 400, "That sign-in link has expired. Start again from Orbit.");
      return true;
    }
    let tokens;
    try {
      // Built on the public URL, never the Host header, so the redirect_uri matches what Keycloak has.
      tokens = await context.oidc.finish(new URL(url.pathname + url.search, context.publicUrl), pending);
    } catch {
      res.setHeader("set-cookie", [clear]);
      plain(res, 400, "Sign-in didn't complete. Start again from Orbit.");
      return true;
    }
    const sessionId = await createSession(context.pool, context.tokenKey, tokens);
    const back = (await linkedToGalaxy(context, tokens.sub, tokens.accessToken)) ? pending.back : "/auth/link";
    redirect(res, back, 302, [
      clear,
      cookie(context, SESSION_COOKIE, sessionId, {}),
    ]);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/link") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(linkPage(context));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/logout") {
    // A cross-site form can't sign the user out.
    if (req.headers.origin !== context.publicUrl.origin) {
      plain(res, 403, "Sign out from Orbit itself.");
      return true;
    }
    const id = readCookie(req, cookieName(context, SESSION_COOKIE));
    const ended = id ? await endSession(context.pool, context.tokenKey, context.oidc, id) : undefined;
    if (ended) context.tokens.forget(ended.sub);
    redirect(res, context.oidc.endSessionUrl(new URL("/", context.publicUrl).href).href, 303, [
      cookie(context, SESSION_COOKIE, "", { maxAge: 0 }),
    ]);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/me") {
    const session = await sessionOf(context, req);
    if (!session) {
      plain(res, 401, "Not signed in.");
      return true;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ sub: session.sub }));
    return true;
  }

  return false;
}

/**
 * Whether Galaxy knows this Keycloak identity yet. Galaxy maps `sub` to an account through its own
 * OIDC login and refuses a token it can't map, so a user who has never signed in to Galaxy through
 * Keycloak is sent there once. Only that refusal means unlinked: any other failure -- unreachable,
 * a 5xx, some other 401 -- isn't something signing in to Galaxy would fix, so the sign-in goes
 * ahead and the first Galaxy call reports it as the Galaxy error it is.
 */
async function linkedToGalaxy(context: AuthContext, sub: string, accessToken: string): Promise<boolean> {
  const fetchImpl = context.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(new URL("/api/users/current", context.galaxyUrl), {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "manual",
    });
  } catch (error) {
    context.log?.(`account link check: Galaxy unreachable (${(error as Error).message}); letting ${sub} in`);
    return true;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const unmapped = response.status === 401 && unmappedToken(text);
    // Galaxy's answer here is what decides who gets the link page, so it's worth seeing.
    const said = text.slice(0, 200).replace(/\s+/g, " ");
    context.log?.(
      `account link check for ${sub}: Galaxy answered ${response.status} ${said}${unmapped ? "" : `; letting ${sub} in`}`,
    );
    return !unmapped;
  }
  const body = (await response.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id === "string") {
    await context.pool.query("UPDATE orbit_users SET galaxy_user_id = $2 WHERE sub = $1", [sub, body.id]);
  } else {
    // An anonymous answer means no Galaxy OIDC backend would decode the token at all -- configuration,
    // not a missing link.
    context.log?.(`account link check for ${sub}: Galaxy answered as anonymous; letting ${sub} in`);
  }
  return true;
}

/**
 * Galaxy's refusal of a token it decoded but couldn't match to a user (authnz
 * `_match_access_token_to_user_in_provider`). Its other bearer-token 401s carry different words.
 */
function unmappedToken(body: string): boolean {
  try {
    const message = (JSON.parse(body) as { err_msg?: unknown }).err_msg;
    return typeof message === "string" && message.startsWith("Cannot locate user");
  } catch {
    return false;
  }
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function linkPage(context: AuthContext): string {
  const galaxy = escape(context.galaxyUrl.host);
  return `<!doctype html><meta charset="utf-8"><title>Link your Galaxy account</title>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">
<h1>One more step</h1>
<p>${galaxy} doesn't know your account yet. Sign in to Galaxy once with the same login, then come back to Orbit.</p>
<p><a href="${escape(context.galaxyLinkUrl.href)}">Sign in to ${galaxy}</a></p>
<p><a href="/auth/login">I've done that, back to Orbit</a></p>
</body>`;
}
