/**
 * The hosted Orbit service: one process with the HTTP server, the dispatcher and its workers. Every
 * setting comes from the environment (config.ts); the worker bundle and the built page sit next to
 * this file in the image (ORBIT_WORKER_BUNDLE and ORBIT_WEB_ROOT override where).
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { PgBoss } from "pg-boss";

import { connectOidc } from "../auth/oidc";
import type { AuthContext } from "../auth/routes";
import { refreshForUser } from "../auth/sessions";
import { ConfigError, describeConfig, loadConfig } from "../config";
import { migrate } from "../db/migrate";
import { createPool } from "../db/pool";
import { Dispatcher } from "../dispatch/dispatcher";
import { galaxyPageCreator, galaxyPageRetitler } from "../dispatch/pages";
import { endpointModels } from "../model/endpoint";
import { createTokenCache } from "../tokens/token-cache";
import { createHostServer } from "./http";
import { Sockets } from "./socket";

const log = (message: string) => console.log(`[orbit] ${message}`);

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(78);
    }
    throw error;
  }
  console.log(describeConfig(config));

  const pool = createPool({ connectionString: config.databaseUrl, max: 20 }, log);
  await migrate(pool);
  // A short queue cache, so a stately key that just went idle stops being skipped soon after.
  // The monitor fails a dead host's turn job by its heartbeat; the default minute between passes
  // would leave that conversation stuck for up to a minute and a half after a crash.
  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    schedule: false,
    queueCacheIntervalSeconds: 5,
    superviseIntervalSeconds: 10,
    monitorIntervalSeconds: 10,
  });
  boss.on("error", (error: Error) => log(`pg-boss: ${error.message}`));
  await boss.start();

  const oidc = await connectOidc({
    issuer: config.oidc.issuer,
    clientId: config.oidc.clientId,
    clientSecret: config.oidc.clientSecret,
    allowHttp: config.oidc.issuer.protocol === "http:" && ["localhost", "127.0.0.1"].includes(config.oidc.issuer.hostname),
  });
  const tokens = createTokenCache({ refresh: refreshForUser(pool, config.tokenKey, oidc) });
  const auth: AuthContext = {
    pool,
    oidc,
    tokens,
    tokenKey: config.tokenKey,
    publicUrl: config.publicUrl,
    galaxyUrl: config.galaxyUrl,
    galaxyLinkUrl: config.galaxyLinkUrl,
    log,
  };

  // /healthz is open to anyone, so Keycloak is asked at most every ten seconds.
  let keycloak: { at: number; up: Promise<boolean> } | undefined;
  const keycloakUp = () => {
    if (!keycloak || Date.now() - keycloak.at > 10_000) {
      const discovery = new URL(`${config.oidc.issuer.href.replace(/\/$/, "")}/.well-known/openid-configuration`);
      keycloak = {
        at: Date.now(),
        up: fetch(discovery, { signal: AbortSignal.timeout(3000) }).then(
          (r) => r.ok,
          () => false,
        ),
      };
    }
    return keycloak.up;
  };

  let sockets: Sockets | undefined;
  const dispatcher = new Dispatcher({
    pool,
    boss,
    bundle: process.env.ORBIT_WORKER_BUNDLE ?? fileURLToPath(new URL("./worker.mjs", import.meta.url)),
    // A restarted host is a new holder, so its first acquire on every conversation bumps.
    hostId: `${hostname()}/${process.pid}/${randomUUID()}`,
    databaseUrl: config.databaseUrl,
    galaxyUrl: config.galaxyUrl.href,
    lease: config.lease,
    limits: {
      maxTurns: config.turnLimits.maxSteps,
      maxToolCalls: config.turnLimits.maxToolCalls,
      outputBytes: 8 * 1024 * 1024,
    },
    tokens,
    modelFor: endpointModels({ url: config.model.url, key: config.model.key, model: config.model.id }),
    pageFor: galaxyPageCreator({ galaxyUrl: config.galaxyUrl.href, tokens }),
    compileCache: process.env.ORBIT_COMPILE_CACHE ?? fileURLToPath(new URL("./.compile-cache", import.meta.url)),
    onEvent: (id, event) => sockets?.deliver(id, event),
    turnsDisabled: () => config.turnsDisabled,
    idle: config.idle,
    watched: (id) => sockets?.watched(id) ?? false,
    log,
  });
  sockets = new Sockets({
    auth,
    dispatcher,
    turnsDisabled: config.turnsDisabled,
    log,
    retitlePage: galaxyPageRetitler({ galaxyUrl: config.galaxyUrl.href, tokens }),
  });

  const server = createHostServer({
    auth,
    sockets,
    webRoot: process.env.ORBIT_WEB_ROOT ?? fileURLToPath(new URL("./web", import.meta.url)),
    log,
    model: config.model.id,
    health: async () => ({
      postgres: await pool.query("SELECT 1").then(
        () => true,
        () => false,
      ),
      keycloak: await keycloakUp(),
    }),
  });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  await dispatcher.start();
  log(`listening on ${config.port}`);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: closing conversations`);
    // Workers first (pending confirms are asked again on the next start), then the rest, all inside
    // the 45 s compose gives: cut short, a turn job stays active until it expires.
    await dispatcher.shutdown(8_000);
    await boss.stop({ graceful: true, timeout: 8_000 });
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((error: Error) => {
  console.error(`[orbit] failed to start: ${error.stack ?? error.message}`);
  process.exit(1);
});
