// Loom used to write its MCP servers into mcp.json for pi-mcp-adapter. The brain
// now registers them with pi's built-in MCP, where a file entry of the same name
// wins over a registration -- a leftover galaxy entry would pin an old profile
// (and the plaintext key earlier versions wrote) indefinitely.
//
// The same file can hold the user's own servers, written for the adapter. pi
// ignores the adapter's fields rather than rejecting them, so a tool the user
// excluded would quietly become callable. Translate what pi can express and
// disable what it can't.

const LEGACY_SERVER_NAMES = ["galaxy", "brc-analytics"];

// Present only on an entry written for pi's built-in MCP, which Loom never did:
// a galaxy or brc-analytics entry carrying one is the user's own override.
const PI_NATIVE_FIELDS = ["exposure", "toolExposure", "enabled", "timeout", "auth"];

// Adapter features with no pi equivalent. Keeping such a server on would drop a
// safeguard (approval prompts) or connect without the configured credentials.
const UNSUPPORTED_FIELDS = [
  "approveTools",
  "bearerTokenStore",
  "requestHeadersCommand",
  "caFile",
  "socket",
];

const ADAPTER_ONLY_FIELDS = [
  ...UNSUPPORTED_FIELDS,
  "directTools",
  "includeTools",
  "excludeTools",
  "bearerToken",
  "bearerTokenEnv",
  "lifecycle",
  "idleTimeout",
  "requestTimeoutMs",
  "exposeResources",
  "toolPrefix",
  "searchKeywords",
  "debug",
  "trace",
  "httpTransport",
  "inheritEnv",
  "literalEnv",
  "pluginDataDir",
];

/** @param {unknown} v */
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** @param {unknown} v @returns {string[]} */
const stringList = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string") : []);

/** @param {Record<string, any>} entry */
function isLoomWritten(entry) {
  return isObject(entry) && !PI_NATIVE_FIELDS.some((f) => f in entry);
}

/**
 * Rewrite one user server's adapter fields into pi's. Returns a notice when the
 * server had to be disabled.
 * @param {string} name
 * @param {Record<string, any>} entry
 * @returns {string | null}
 */
function translateAdapterEntry(name, entry) {
  const unsupported = UNSUPPORTED_FIELDS.filter((f) => {
    const v = entry[f];
    return v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0);
  });

  /** @type {Record<string, string>} */
  const toolExposure = {};
  let exposure;
  const direct = entry.directTools;
  if (direct === true) exposure = "direct";
  else if (direct === "search") exposure = "deferred";
  for (const tool of stringList(direct)) toolExposure[tool] = "direct";

  const include = stringList(entry.includeTools);
  if (include.length > 0) {
    for (const tool of include) toolExposure[tool] ??= exposure ?? "codemode";
    exposure = "hidden";
  }
  for (const tool of stringList(entry.excludeTools)) toolExposure[tool] = "hidden";

  if (exposure) entry.exposure = exposure;
  if (Object.keys(toolExposure).length > 0) entry.toolExposure = toolExposure;
  if (typeof entry.requestTimeoutMs === "number" && entry.requestTimeoutMs > 0) {
    entry.timeout = Math.ceil(entry.requestTimeoutMs / 1000);
  }

  const headers = isObject(entry.headers) ? entry.headers : {};
  const hasAuthHeader = Object.keys(headers).some((h) => h.toLowerCase() === "authorization");
  const token =
    typeof entry.bearerTokenEnv === "string"
      ? `\${${entry.bearerTokenEnv}}`
      : typeof entry.bearerToken === "string"
        ? entry.bearerToken
        : null;
  if (token && !hasAuthHeader) entry.headers = { ...headers, Authorization: `Bearer ${token}` };

  for (const f of ADAPTER_ONLY_FIELDS) delete entry[f];
  // The adapter's auth was a mode string; pi's is an object naming a provider.
  if (typeof entry.auth === "string" || entry.auth === false) delete entry.auth;

  if (unsupported.length === 0) return null;
  entry.enabled = false;
  return (
    `MCP server "${name}" used ${unsupported.join(", ")}, which pi's built-in MCP ` +
    `does not support, so Loom disabled it in mcp.json. Review it and re-enable with /mcp.`
  );
}

/**
 * Remove Loom's own servers and the adapter's settings from a parsed mcp.json,
 * and translate the user's remaining servers to pi's built-in MCP fields.
 * @param {Record<string, any>} config
 * @returns {{ changed: boolean, empty: boolean, removedGalaxy: boolean, notices: string[] }}
 *   `empty` when nothing is left worth keeping.
 */
export function stripLegacyMcpEntries(config) {
  let changed = false;
  let removedGalaxy = false;
  /** @type {string[]} */
  const notices = [];
  const servers = isObject(config.mcpServers) ? config.mcpServers : null;
  if (servers) {
    for (const [name, entry] of Object.entries(servers)) {
      if (LEGACY_SERVER_NAMES.includes(name)) {
        if (!isLoomWritten(entry)) continue;
        delete servers[name];
        changed = true;
        if (name === "galaxy") removedGalaxy = true;
        continue;
      }
      if (!isObject(entry) || !ADAPTER_ONLY_FIELDS.some((f) => f in entry)) continue;
      const notice = translateAdapterEntry(name, entry);
      if (notice) notices.push(notice);
      changed = true;
    }
  }
  if (isObject(config.settings) && "scriptMode" in config.settings) {
    delete config.settings.scriptMode;
    if (Object.keys(config.settings).length === 0) delete config.settings;
    changed = true;
  }
  const otherKeys = Object.keys(config).filter((k) => k !== "mcpServers");
  const empty = otherKeys.length === 0 && Object.keys(servers ?? {}).length === 0;
  return { changed, empty, removedGalaxy, notices };
}
