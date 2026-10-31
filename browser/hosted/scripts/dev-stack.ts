/**
 * The whole service on this machine against stand-ins: a Keycloak (signs in "dev-user" at once, as
 * the public orbit-dev client), a model endpoint and Galaxy, and a fresh database. Runs the built
 * host (npm run build first) on http://127.0.0.1:7878 until interrupted.
 *
 *   cd browser/hosted && node --import tsx scripts/dev-stack.ts
 *
 * ORBIT_MODEL_URL, ORBIT_MODEL_KEY and ORBIT_MODEL, when set, point it at a real model instead (TACC's
 * endpoint directly, or LiteLLM).
 */
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startMockOidc } from "../src/auth/mock-oidc";
import { freshDatabase } from "../src/test-db";
import { startStandIn } from "../src/test-stand-in";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE = "orbit_hosted_dev";
const SOCKET = process.env.PGHOST ?? "/tmp";

await freshDatabase(DATABASE);
const keycloak = await startMockOidc({ clientId: "orbit-dev" });
keycloak.user = "dev-user";
const standIn = await startStandIn();

// ORBIT_HOST_BUNDLE runs a copy elsewhere, e.g. to check dist/ needs nothing beside it.
const host = spawn(
  process.execPath,
  [process.env.ORBIT_HOST_BUNDLE ?? join(ROOT, "dist", "host.mjs")],
  {
    stdio: "inherit",
    env: {
      PATH: process.env.PATH,
      ORBIT_PUBLIC_URL: "http://127.0.0.1:7878",
      ORBIT_PORT: "7878",
      ORBIT_DATABASE_URL: `postgres://${userInfo().username}@/${DATABASE}?host=${encodeURIComponent(SOCKET)}`,
      ORBIT_GALAXY_URL: standIn.origin,
      ORBIT_OIDC_ISSUER: keycloak.issuer.href,
      ORBIT_OIDC_CLIENT_ID: "orbit-dev",
      ORBIT_TOKEN_KEY: Buffer.alloc(32, 1).toString("base64"),
      // A real model when these are set (e.g. TACC's proxy); the stand-in's scripted one otherwise.
      ORBIT_MODEL_URL: process.env.ORBIT_MODEL_URL ?? standIn.origin,
      ORBIT_MODEL_KEY: process.env.ORBIT_MODEL_KEY ?? "sk-dev-service",
      ORBIT_MODEL: process.env.ORBIT_MODEL ?? "m",
    },
  },
);
console.log(`stand-ins: Keycloak ${keycloak.issuer.href}, model/Galaxy ${standIn.origin}`);
const stop = () => {
  host.kill("SIGTERM");
  host.once("exit", () => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
host.once("exit", (code) => process.exit(code ?? 1));
