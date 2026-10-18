/** Explicit, immutable Galaxy origins. Credentials never cross the shell contract. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { readEnv, envNames } from "../../shared/orbit-env.js";
import { loadConfig } from "./config.js";
import { fetchSameOriginOnly } from "../../shared/redirect-guard.js";

export interface GalaxyConnection {
  id: string;
  name: string;
  url: string;
  apiKey: string;
  mcpServer: string;
  accountId?: string;
  username?: string;
}
export interface GalaxyOrigin {
  galaxyServerUrl: string;
  connectionId?: string;
  accountId?: string;
}
const context = new AsyncLocalStorage<GalaxyConnection>();
let injected: Record<string, string> = {};
const accounts = new Map<
  string,
  { at: number; pending: Promise<{ id: string; username?: string }> }
>();

// Orbit supplies encrypted-profile keys over a one-shot inherited pipe, not
// argv, a plaintext file, or an environment containing every profile's key.
if (readEnv("GALAXY_KEYS_FD")) {
  const descriptor = Number(readEnv("GALAXY_KEYS_FD"));
  for (const name of envNames("GALAXY_KEYS_FD")) delete process.env[name];
  if (descriptor !== 3) throw new Error("Invalid Galaxy credentials descriptor.");
  try {
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length > 1_048_576) throw new Error("Galaxy credential envelope is too large.");
    injected = JSON.parse(bytes.toString("utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}

export function normalizeGalaxyOrigin(value: string): string {
  const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Galaxy origins cannot contain credentials, queries or fragments.");
  const local =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new Error("Galaxy requires HTTPS except on loopback.");
  return url.href.replace(/\/+$/, "");
}

export function galaxyConnectionId(name: string, url: string): string {
  return createHash("sha256")
    .update(`${name}\n${normalizeGalaxyOrigin(url)}`)
    .digest("hex")
    .slice(0, 12);
}

export function listGalaxyConnections(): GalaxyConnection[] {
  const cfg = loadConfig().galaxy;
  const result: GalaxyConnection[] = [];
  const ambientUrl = process.env.GALAXY_URL;
  const ambientKey = process.env.GALAXY_API_KEY;
  for (const [name, profile] of Object.entries(cfg?.profiles ?? {})) {
    let url: string;
    try {
      url = normalizeGalaxyOrigin(profile.url);
    } catch {
      continue;
    }
    const isDefault = name === cfg?.active;
    const key =
      injected[name] ||
      profile.apiKey ||
      (isDefault && ambientUrl && normalizeGalaxyOrigin(ambientUrl) === url
        ? ambientKey
        : undefined);
    if (!key) continue;
    const id = galaxyConnectionId(name, url);
    result.push({ id, name, url, apiKey: key, mcpServer: isDefault ? "galaxy" : `galaxy_${id}` });
  }
  if (ambientUrl && ambientKey && !result.some((c) => c.mcpServer === "galaxy")) {
    const url = normalizeGalaxyOrigin(ambientUrl);
    result.unshift({
      id: galaxyConnectionId("environment", url),
      name: "environment",
      url,
      apiKey: ambientKey,
      mcpServer: "galaxy",
    });
  }
  return result;
}

export function currentGalaxyConnection(): GalaxyConnection | undefined {
  return context.getStore();
}

export function resolveGalaxyConnection(id?: string): GalaxyConnection {
  if (!id && context.getStore()) return context.getStore()!;
  const all = listGalaxyConnections();
  const connection = id
    ? all.find((c) => c.id === id || c.name === id || c.mcpServer === id || c.url === id)
    : all.find((c) => c.mcpServer === "galaxy");
  if (
    id &&
    all.filter((c) => c.url === id).length > 1 &&
    !all.some((c) => c.id === id || c.name === id || c.mcpServer === id)
  )
    throw new Error(
      "This Galaxy URL has multiple configured accounts. Select a connection name or ID.",
    );
  if (!connection)
    throw new Error(
      id
        ? `Galaxy connection "${id}" is unavailable. Check its profile and credentials.`
        : "Galaxy credentials not configured.",
    );
  return connection;
}

export function withGalaxyConnection<T>(connection: GalaxyConnection, work: () => T): T {
  return context.run(connection, work);
}

export async function verifyGalaxyAccount(
  connection: GalaxyConnection,
  signal?: AbortSignal,
  fresh = false,
): Promise<GalaxyConnection> {
  const key = createHash("sha256")
    .update(connection.url)
    .update("\n")
    .update(connection.apiKey)
    .digest("hex");
  const cached = accounts.get(key);
  let pending = !fresh && cached && Date.now() - cached.at < 30_000 ? cached.pending : undefined;
  if (!pending) {
    pending = (async () => {
      const response = await fetchSameOriginOnly(
        `${connection.url}/api/users/current`,
        {
          headers: { "x-api-key": connection.apiKey },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000),
        },
        { serverLabel: "Galaxy", urlSettingLabel: "the Galaxy profile URL" },
      );
      if (!response.ok)
        throw new Error(
          `Cannot verify Galaxy account on ${connection.name}: HTTP ${response.status}.`,
        );
      const user = (await response.json()) as { id?: string; username?: string };
      if (!user.id || typeof user.id !== "string")
        throw new Error("Galaxy did not return an account identity.");
      return {
        id: user.id,
        username: typeof user.username === "string" ? user.username : undefined,
      };
    })();
    accounts.set(key, { at: Date.now(), pending });
    pending.catch(() => accounts.delete(key));
  }
  const account = await pending;
  return { ...connection, accountId: account.id, username: account.username };
}

export async function withGalaxyOrigin<T>(
  origin: GalaxyOrigin,
  work: () => Promise<T>,
): Promise<T> {
  const all = listGalaxyConnections();
  const candidates = origin.connectionId
    ? all.filter(
        (c) =>
          c.id === origin.connectionId &&
          normalizeGalaxyOrigin(c.url) === normalizeGalaxyOrigin(origin.galaxyServerUrl),
      )
    : all.filter(
        (c) => normalizeGalaxyOrigin(c.url) === normalizeGalaxyOrigin(origin.galaxyServerUrl),
      );
  if (candidates.length !== 1)
    throw new Error(
      `The recorded Galaxy origin is unavailable or ambiguous: ${origin.galaxyServerUrl}.`,
    );
  let connection = candidates[0];
  if (origin.accountId) {
    connection = await verifyGalaxyAccount(connection);
    if (connection.accountId !== origin.accountId)
      throw new Error("Galaxy account changed; this attempt belongs to another account.");
  }
  return withGalaxyConnection(connection, work);
}

/** Origin comparison for notebook lookups; never let identical remote IDs collide. */
export function matchesGalaxyOrigin(record: GalaxyOrigin, desired?: GalaxyOrigin): boolean {
  const scope =
    desired ??
    (context.getStore()
      ? {
          galaxyServerUrl: context.getStore()!.url,
          connectionId: context.getStore()!.id,
          accountId: context.getStore()!.accountId,
        }
      : undefined);
  if (!scope) return true;
  if (
    !record.connectionId &&
    !record.accountId &&
    scope.connectionId &&
    listGalaxyConnections().filter((c) => c.url === record.galaxyServerUrl).length > 1
  )
    return false;
  if (record.connectionId && scope.connectionId && record.connectionId !== scope.connectionId)
    return false;
  if (record.accountId && scope.accountId && record.accountId !== scope.accountId) return false;
  if (!record.galaxyServerUrl || !scope.galaxyServerUrl) return !context.getStore();
  try {
    return (
      normalizeGalaxyOrigin(record.galaxyServerUrl) === normalizeGalaxyOrigin(scope.galaxyServerUrl)
    );
  } catch {
    return false;
  }
}

/** Test seam. */
export function setGalaxyCredentialEnvelope(keys: Record<string, string>): void {
  injected = keys;
  accounts.clear();
}
