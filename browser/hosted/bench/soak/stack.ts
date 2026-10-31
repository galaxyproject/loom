/**
 * The soak harness's service: the built host (dist/host.mjs) as a child process against the dev
 * stack's stand-ins (Keycloak, Galaxy and the scripted model in one), on a fresh orbit_soak_ database.
 * The host can be killed, stopped and started again on the same port and database, which is what the
 * fault scripts need; the stand-ins outlive it, so their request logs span restarts.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { startMockOidc, type MockOidc } from "../../src/auth/mock-oidc";
import { connection, dropDatabase, freshDatabase, testDatabase } from "../../src/test-db";
import { startStandIn, type StandIn } from "../../src/test-stand-in";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOCKET = process.env.PGHOST ?? "/tmp";

export interface StackOptions {
  /** Must start orbit_soak_ (or ORBIT_TEST_DB_PREFIX): the harness drops it when done. */
  readonly database: string;
  readonly port: number;
  /** Access-token lifetime at the stand-in Keycloak; short enough to make the host refresh mid-run. */
  readonly accessTtlS?: number;
  readonly verbose?: boolean;
}

export interface HostRun {
  readonly child: ChildProcess;
  /** ms from spawn to "listening" in the host's log. */
  readonly listeningMs: number;
  readonly exited: Promise<number | null>;
  /** Everything the host has logged since it started. */
  readonly log: string[];
}

export class Stack {
  readonly origin: string;
  readonly pool: pg.Pool;
  host: HostRun | undefined;
  /** Every host log line, across restarts. */
  readonly log: string[] = [];

  private constructor(
    readonly options: StackOptions,
    readonly keycloak: MockOidc,
    readonly standIn: StandIn,
  ) {
    this.origin = `http://127.0.0.1:${options.port}`;
    this.pool = new pg.Pool({ ...connection(options.database), max: 4, application_name: "soak-harness" });
    this.pool.on("error", () => undefined);
  }

  static async start(options: StackOptions): Promise<Stack> {
    if (!options.database.startsWith(testDatabase("orbit_soak_"))) throw new Error(`Refusing database ${options.database}`);
    if (!existsSync(join(ROOT, "dist", "host.mjs"))) throw new Error("No dist/host.mjs: run npm run build first");
    await freshDatabase(options.database);
    const keycloak = await startMockOidc({ clientId: "orbit-dev", accessTtlS: options.accessTtlS });
    const standIn = await startStandIn();
    return new Stack(options, keycloak, standIn);
  }

  /** Start the host and wait until it listens. `env` adds to (or blanks) the usual settings. */
  async startHost(env: Record<string, string | undefined> = {}): Promise<HostRun> {
    if (this.host && this.host.child.exitCode === null && this.host.child.signalCode === null) throw new Error("Host already running");
    const started = performance.now();
    const child = spawn(process.execPath, [join(ROOT, "dist", "host.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        ORBIT_PUBLIC_URL: this.origin,
        ORBIT_PORT: String(this.options.port),
        ORBIT_DATABASE_URL: `postgres://${userInfo().username}@/${this.options.database}?host=${encodeURIComponent(SOCKET)}`,
        ORBIT_GALAXY_URL: this.standIn.origin,
        ORBIT_OIDC_ISSUER: this.keycloak.issuer.href,
        ORBIT_OIDC_CLIENT_ID: "orbit-dev",
        ORBIT_TOKEN_KEY: Buffer.alloc(32, 1).toString("base64"),
        ORBIT_MODEL_URL: this.standIn.origin,
        ORBIT_MODEL_KEY: "sk-soak-service",
        ORBIT_MODEL: "m",
        // A dead host's lease runs out in seconds rather than a minute, so the fault scripts don't idle.
        ORBIT_LEASE_TTL_SECONDS: "10",
        ORBIT_LEASE_RENEW_SECONDS: "3",
        ...env,
      },
    });
    const log: string[] = [];
    let listening!: () => void;
    const up = new Promise<void>((resolve) => (listening = resolve));
    const take = (chunk: Buffer) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        log.push(line);
        this.log.push(line);
        if (this.options.verbose) console.log(`    host| ${line}`);
        if (line.startsWith("[orbit] listening on")) listening();
      }
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    await Promise.race([
      up,
      exited.then((code) => {
        throw new Error(`Host exited with ${code} before listening:\n${log.slice(-20).join("\n")}`);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Host didn't listen within 30 s")), 30_000)),
    ]);
    this.host = { child, listeningMs: performance.now() - started, exited, log };
    return this.host;
  }

  /** Signal the host and wait for it to exit. */
  async stopHost(signal: NodeJS.Signals = "SIGTERM"): Promise<number | null> {
    const host = this.host;
    if (!host || host.child.exitCode !== null || host.child.signalCode !== null) return host?.child.exitCode ?? null;
    host.child.kill(signal);
    return host.exited;
  }

  /** The host process's resident set, in MB (workers are threads, so theirs is in it). */
  hostRssMb(): number | undefined {
    const pid = this.host?.child.pid;
    if (!pid) return undefined;
    try {
      // ps rather than a probe inside the host: nothing in the service changes to be measured.
      const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
      return Number(out.trim()) / 1024;
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    await this.stopHost("SIGTERM").catch(() => undefined);
    await this.pool.end().catch(() => undefined);
    await this.keycloak.close();
    await this.standIn.close();
    await dropDatabase(this.options.database);
  }
}
