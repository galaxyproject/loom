/**
 * A stand-in Keycloak for the tests: discovery, authorize (signs in whoever `user` names, at once),
 * token with PKCE and one-time refresh tokens as our realms rotate them, revocation, end-session and
 * JWKS. `down` makes the token endpoint fail the way an unreachable Keycloak does.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

export interface MockOidc {
  readonly issuer: URL;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  /** Who /authorize signs in. */
  user: string;
  down: boolean;
  /** Refresh grants Keycloak has answered, successful or not. */
  refreshes: number;
  /** End every session of a user, as an admin would. */
  revokeUser(sub: string): void;
  isRevoked(refreshToken: string): boolean;
  close(): Promise<void>;
}

export async function startMockOidc(
  options: { clientId?: string; clientSecret?: string; accessTtlS?: number } = {},
): Promise<MockOidc> {
  const clientId = options.clientId ?? "orbit";
  const accessTtl = options.accessTtlS ?? 300;
  const clientSecret = options.clientSecret;
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { challenge: string; sub: string; redirectUri: string }>();
  const refreshTokens = new Map<string, { sub: string; used: boolean; revoked: boolean }>();
  let server: Server;
  let issuer: URL;

  const sign = (claims: Record<string, unknown>, ttl: number) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(issuer.href)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(privateKey);

  const issue = async (sub: string) => {
    const refresh = randomBytes(24).toString("base64url");
    refreshTokens.set(refresh, { sub, used: false, revoked: false });
    return {
      access_token: await sign({ sub, aud: "galaxy-api", azp: clientId }, accessTtl),
      id_token: await sign({ sub, aud: clientId }, accessTtl),
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: accessTtl,
      refresh_expires_in: 1800,
    };
  };

  const mock: MockOidc = {
    get issuer() {
      return issuer;
    },
    clientId,
    clientSecret,
    user: "user-1",
    down: false,
    refreshes: 0,
    revokeUser(sub) {
      for (const record of refreshTokens.values()) if (record.sub === sub) record.revoked = true;
    },
    isRevoked: (token) => refreshTokens.get(token)?.revoked === true,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  server = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const at = (name: string) => `${issuer.href}/${name}`;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const path = url.pathname.slice(issuer.pathname.length);

    if (path === "/.well-known/openid-configuration") {
      return send(200, {
        issuer: issuer.href,
        authorization_endpoint: at("auth"),
        token_endpoint: at("token"),
        revocation_endpoint: at("revoke"),
        end_session_endpoint: at("logout"),
        jwks_uri: at("certs"),
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (path === "/certs") return send(200, { keys: [jwk] });
    if (path === "/auth") {
      const code = randomBytes(16).toString("base64url");
      const redirectUri = url.searchParams.get("redirect_uri")!;
      codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", sub: mock.user, redirectUri });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (path === "/token") {
      if (mock.down) return send(503, { error: "temporarily_unavailable" });
      const basic = req.headers.authorization?.startsWith("Basic ")
        ? Buffer.from(req.headers.authorization.slice(6), "base64").toString("utf8").split(":").map(decodeURIComponent)
        : undefined;
      const id = basic?.[0] ?? form.get("client_id");
      const secret = basic?.[1] ?? form.get("client_secret") ?? undefined;
      if (id !== clientId || secret !== clientSecret) return send(401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        const record = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!record || record.challenge !== challenge || record.redirectUri !== form.get("redirect_uri")) {
          return send(400, { error: "invalid_grant" });
        }
        return send(200, await issue(record.sub));
      }
      if (form.get("grant_type") === "refresh_token") {
        mock.refreshes += 1;
        const record = refreshTokens.get(form.get("refresh_token") ?? "");
        if (!record || record.used || record.revoked) return send(400, { error: "invalid_grant", error_description: "Token is not active" });
        record.used = true;
        return send(200, await issue(record.sub));
      }
      return send(400, { error: "unsupported_grant_type" });
    }
    if (path === "/revoke") {
      const record = refreshTokens.get(form.get("token") ?? "");
      if (record) record.revoked = true;
      res.writeHead(200);
      return res.end();
    }
    send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // No trailing slash, as Keycloak's issuer has none: discovery compares it exactly.
  issuer = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/realms/test`);
  return mock;
}
