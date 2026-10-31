/**
 * The host's settings, all from the environment, checked once at boot. A bad or missing setting
 * stops the host with every problem listed, rather than failing on first use mid-session.
 */
import { parse as parseConnection } from "pg-connection-string";

export interface HostConfig {
  /** Where browsers reach the host; sign-in redirects and cookies are built from it. */
  readonly publicUrl: URL;
  readonly port: number;
  readonly databaseUrl: string;
  readonly galaxyUrl: URL;
  /** Where a user Galaxy doesn't know yet signs in to Galaxy once, linking their Keycloak identity. */
  readonly galaxyLinkUrl: URL;
  readonly oidc: {
    /** The Keycloak realm's issuer URL. */
    readonly issuer: URL;
    readonly clientId: string;
    /** Absent only for a public dev client on a loopback host. */
    readonly clientSecret: string | undefined;
  };
  /** Encrypts refresh tokens at rest (brief decision 8). */
  readonly tokenKey: Buffer;
  readonly model: {
    /** An OpenAI-compatible endpoint (TACC's, or LiteLLM in front of it), on Orbit's one service key (H9). */
    readonly url: URL;
    readonly key: string;
    readonly id: string;
  };
  /** Per user message: model turns, and tool calls (README decision 5). */
  readonly turnLimits: { readonly maxSteps: number; readonly maxToolCalls: number };
  /** When set, every turn is turned away with this notice: the global kill switch. */
  readonly turnsDisabled: string | undefined;
  readonly lease: {
    readonly ttlMs: number;
    readonly renewMs: number;
    readonly maxTurnMs: number;
  };
  /** Idle release of workers, and how long a confirm waits before its conversation pauses. */
  readonly idle: { readonly releaseMs: number; readonly askPauseMs: number };
}

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Orbit can't start:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const isLoopback = (url: URL) => LOOPBACK.has(url.hostname);

/**
 * pg's own reading of a connection string: `postgres://user@/db?host=/socket`, which pg accepts,
 * isn't a valid URL to the WHATWG parser (a user with no host).
 */
function parseDatabaseUrl(raw: string): ReturnType<typeof parseConnection> | undefined {
  if (!/^postgres(ql)?:\/\//.test(raw)) return undefined;
  try {
    return parseConnection(raw);
  } catch {
    return undefined;
  }
}

/** Read and check every setting, throwing a ConfigError that lists all the problems at once. */
export function loadConfig(env: Record<string, string | undefined> = process.env): HostConfig {
  const problems: string[] = [];
  const value = (name: string): string | undefined => {
    const raw = env[name]?.trim();
    return raw ? raw : undefined;
  };
  const required = (name: string): string | undefined => {
    const raw = value(name);
    if (raw === undefined) problems.push(`${name} is not set`);
    return raw;
  };
  const url = (name: string, raw: string | undefined): URL | undefined => {
    if (raw === undefined) return undefined;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed;
    } catch {
      // Reported below.
    }
    problems.push(`${name} is not an http(s) URL`);
    return undefined;
  };
  const seconds = (name: string, fallback: number): number => {
    const raw = value(name);
    if (raw === undefined) return fallback * 1000;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      problems.push(`${name} must be a positive number of seconds`);
      return fallback * 1000;
    }
    return n * 1000;
  };

  const publicUrl = url("ORBIT_PUBLIC_URL", required("ORBIT_PUBLIC_URL"));
  // The session cookie is Secure and the sign-in redirect carries a code, so anything but a
  // developer's own machine needs TLS.
  if (publicUrl && publicUrl.protocol !== "https:" && !isLoopback(publicUrl)) {
    problems.push("ORBIT_PUBLIC_URL must be https unless it is localhost");
  }

  const portRaw = value("ORBIT_PORT");
  const port = portRaw === undefined ? 7878 : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    problems.push("ORBIT_PORT must be a port number");

  const databaseUrl = required("ORBIT_DATABASE_URL");
  if (databaseUrl !== undefined && !parseDatabaseUrl(databaseUrl)) {
    problems.push("ORBIT_DATABASE_URL must be a postgres:// URL");
  }

  const galaxyUrl = url("ORBIT_GALAXY_URL", required("ORBIT_GALAXY_URL"));
  // Users' tokens go to Galaxy and the service key to the model endpoint: never in clear beyond this machine.
  const secure = (name: string, at: URL | undefined) => {
    if (at && at.protocol !== "https:" && !isLoopback(at))
      problems.push(`${name} must be https unless it is localhost`);
  };
  secure("ORBIT_GALAXY_URL", galaxyUrl);
  const galaxyLinkUrl = url("ORBIT_GALAXY_LINK_URL", value("ORBIT_GALAXY_LINK_URL"));
  const issuer = url("ORBIT_OIDC_ISSUER", required("ORBIT_OIDC_ISSUER"));
  const clientId = required("ORBIT_OIDC_CLIENT_ID");
  const clientSecret = value("ORBIT_OIDC_CLIENT_SECRET");
  // A public client is the dev setup (orbit-dev); a deployed host signs in as the confidential client.
  if (clientSecret === undefined && publicUrl && !isLoopback(publicUrl)) {
    problems.push(
      "ORBIT_OIDC_CLIENT_SECRET is not set; only a localhost host may use a public client",
    );
  }

  const tokenKeyRaw = required("ORBIT_TOKEN_KEY");
  const tokenKey = tokenKeyRaw === undefined ? Buffer.alloc(0) : Buffer.from(tokenKeyRaw, "base64");
  if (tokenKeyRaw !== undefined && tokenKey.length !== 32) {
    problems.push("ORBIT_TOKEN_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  }

  const modelUrl = url("ORBIT_MODEL_URL", required("ORBIT_MODEL_URL"));
  secure("ORBIT_MODEL_URL", modelUrl);
  const modelKey = required("ORBIT_MODEL_KEY");
  const modelId = required("ORBIT_MODEL");
  const count = (name: string, fallback: number): number => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) problems.push(`${name} must be a positive whole number`);
    return n;
  };
  const turnsDisabled = value("ORBIT_TURNS_DISABLED");
  const maxSteps = count("ORBIT_MAX_STEPS", 40);
  const maxToolCalls = count("ORBIT_MAX_TOOL_CALLS", 60);

  const ttlMs = seconds("ORBIT_LEASE_TTL_SECONDS", 60);
  const renewMs = seconds("ORBIT_LEASE_RENEW_SECONDS", 15);
  const maxTurnMs = seconds("ORBIT_MAX_TURN_SECONDS", 30 * 60);
  // Renewing at most every half TTL leaves one missed renewal before the lease can be taken.
  if (renewMs * 2 > ttlMs)
    problems.push("ORBIT_LEASE_RENEW_SECONDS must be at most half of ORBIT_LEASE_TTL_SECONDS");
  // A worker costs about 100 MB and a cold start under a second (bench/soak), so idle ones go soon.
  const releaseMs = seconds("ORBIT_IDLE_RELEASE_SECONDS", 10 * 60);
  // Decision 17: a confirm unanswered for ten minutes pauses its conversation and frees the worker.
  const askPauseMs = seconds("ORBIT_ASK_PAUSE_SECONDS", 10 * 60);

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    publicUrl: publicUrl!,
    port,
    databaseUrl: databaseUrl!,
    galaxyUrl: galaxyUrl!,
    galaxyLinkUrl: galaxyLinkUrl ?? new URL("/login/start", galaxyUrl!),
    oidc: { issuer: issuer!, clientId: clientId!, clientSecret },
    tokenKey,
    model: { url: modelUrl!, key: modelKey!, id: modelId! },
    turnsDisabled,
    turnLimits: { maxSteps, maxToolCalls },
    lease: { ttlMs, renewMs, maxTurnMs },
    idle: { releaseMs, askPauseMs },
  };
}

/** The settings for the boot log. Secrets are named as set or not, never shown. */
export function describeConfig(config: HostConfig): string {
  // loadConfig already checked it parses.
  const db = parseDatabaseUrl(config.databaseUrl)!;
  const where = `${db.host || "local socket"}${db.port ? `:${db.port}` : ""}/${db.database ?? ""}`;
  const secs = (ms: number) => `${ms / 1000} s`;
  const lines = [
    ["public URL", `${config.publicUrl.origin} (listening on ${config.port})`],
    ["database", `${where} (password ${db.password ? "set" : "not set"})`],
    ["Galaxy", `${config.galaxyUrl.origin} (account link at ${config.galaxyLinkUrl.href})`],
    [
      "sign-in",
      `${config.oidc.issuer.href} as ${config.oidc.clientId} (client secret ${config.oidc.clientSecret ? "set" : "not set, public client"})`,
    ],
    ["token key", "set"],
    ["model", `${config.model.id} via ${config.model.url.origin} (service key set)`],
    [
      "turns",
      `${config.turnsDisabled ? `DISABLED: ${config.turnsDisabled}` : "enabled"}, at most ${config.turnLimits.maxSteps} steps and ${config.turnLimits.maxToolCalls} tool calls each`,
    ],
    [
      "leases",
      `${secs(config.lease.ttlMs)} TTL, renewed every ${secs(config.lease.renewMs)}, turns end after ${secs(config.lease.maxTurnMs)}`,
    ],
    [
      "workers",
      `released after ${secs(config.idle.releaseMs)} quiet with no page open; an unanswered confirm pauses after ${secs(config.idle.askPauseMs)}`,
    ],
  ];
  return ["Orbit host configuration:", ...lines.map(([k, v]) => `  ${k!.padEnd(11)} ${v}`)].join(
    "\n",
  );
}
