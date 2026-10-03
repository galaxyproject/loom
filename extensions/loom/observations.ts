/**
 * Building and shipping an observation (community knowledge loop, contract C1).
 *
 * Everything that decides WHAT is in the payload lives in this half and is
 * pure given its inputs, so the privacy properties are testable without a
 * session: stage comes from an ordered tool-name table, tool ids and datatypes
 * come from a shape allowlist over the triggering call's arguments (never a
 * deep walk of user data), the server is an exact match against the C7
 * allowlist or "private", and the signature goes through the shared
 * normalizer. The description is validated and dropped on any failure rather
 * than trimmed -- a description that trips a leak pattern is not fixable from
 * here.
 */

import {
  OBSERVATIONS_ROUTE,
  OBSERVATIONS_ENDPOINT_URL,
  OBSERVATION_KEY_HEADER,
  OBSERVATION_MAX_BYTES,
  OBSERVATION_SCHEMA_VERSION,
  PRIVATE_SERVER,
  PUBLIC_GALAXY_SERVERS,
  RETRACT_TOKEN_HEADER,
  DATATYPES_MAX,
  DATATYPE_MAX,
  TOOLS_MAX,
  TOOL_ID_MAX,
  UNKNOWN_SIGNATURE,
  VERSION_MAX,
  capObservation,
  normalizeSignature,
  signatureStageLeaks,
  observationByteLength,
  scanObservationForLeaks,
  textLeaks,
  validateObservation,
} from "../../shared/observation-contract.js";
import type {
  Observation,
  ObservationApp,
  ObservationKind,
  ObservationPlatform,
  ObservationStage,
  ObservationTrigger,
} from "../../shared/observation-contract.js";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { release } from "node:os";
import { getConfigDir } from "./config.js";
import { readLoomVersion } from "./feedback.js";
import { loadProfiles } from "./profiles.js";
import { isWsl } from "../../shared/wsl.js";
import {
  GALAXY_BUILTIN_TOOL_IDS,
  GALAXY_DATATYPES,
  GALAXY_MCP_TOOLS,
} from "./observation-allowlists.js";
import { isDesktopShell, readEnv } from "../../shared/orbit-env.js";

// -----------------------------------------------------------------------------
// Stage
// -----------------------------------------------------------------------------

// Ordered; first match wins. The question each row answers is "what was the
// session trying to do when this call failed", not "what does the tool read",
// which is why a failed galaxy_run_tool is tool-parameterization (the
// submission was refused) rather than job-execution.
const STAGE_RULES: ReadonlyArray<readonly [RegExp, ObservationStage]> = Object.freeze([
  Object.freeze([/^galaxy_(?:upload|download|import)/, "data-acquisition"] as const),
  Object.freeze([/metadata|datatype|dbkey|genome_build/, "metadata-reconciliation"] as const),
  Object.freeze([
    /^galaxy_(?:run_tool|run_user_tool|invoke_workflow|create_user_tool|update_user_tool|get_tool|search_tool|recommend_iwc|search_iwc|get_iwc|get_workflow_input_template)/,
    "tool-parameterization",
  ] as const),
  Object.freeze([/^galaxy_(?:invocation|job|get_job|cancel)/, "job-execution"] as const),
  Object.freeze([
    /^galaxy_(?:get_dataset|get_datasets|get_history|get_histories|list_|create_history|get_collection)/,
    "result-interpretation",
  ] as const),
]);

export function stageForTool(mcpTool: string | undefined): ObservationStage {
  if (!mcpTool) return "unknown";
  for (const [re, stage] of STAGE_RULES) if (re.test(mcpTool)) return stage;
  return "unknown";
}

// -----------------------------------------------------------------------------
// Tool ids and datatypes
// -----------------------------------------------------------------------------

// Every structured field is admitted against a list, not a shape: a shape lets
// any identifier-shaped word through, and a patient code or a person's name is
// as datatype- or tool-id-shaped as `fastqsanger` or `Filter1`. The lists are
// generated from pinned Galaxy and galaxy-mcp releases (see
// observation-allowlists.ts); a name missing from one is dropped, which costs
// signal, never privacy.
//
// A tool id is either a bare id that ships inside Galaxy, or a path on one of
// the PUBLIC toolsheds (host/repos/owner/repo/tool[/version]). The toolshed's
// owner, repo and tool names are public but can't be listed here, so those
// three keep a shape check; the version slot gets a version shape, and an id
// whose version fails it keeps its id and loses the version.
const TOOLSHED_TOOL_ID_RE =
  /^((?:toolshed\.g2\.bx\.psu\.edu|testtoolshed\.g2\.bx\.psu\.edu)\/repos\/\w[\w.+-]*\/\w[\w.+-]*\/\w[\w.+-]*)(?:\/([^/]+))?$/;
// 2.2.1+galaxy1, 0.7.17, 1.1.4.post2, 3.0rc1: a release number, optionally
// with galaxy/rc/dev/post-style suffixes. No free-form words.
const TOOLSHED_VERSION_SHAPE =
  /^\d+(?:\.\d+){0,5}(?:[+~_.-]?(?:galaxy|alpha|beta|rc|dev|post|a|b)\d*(?:\.\d+)*){0,2}$/;

function isAdmissibleToolVersion(v: string): boolean {
  // The leak table runs over every string that is sent, so a version it would
  // trip on (0.7.17.4 reads as an IPv4 address) is dropped here rather than
  // taking the whole observation down with it.
  return TOOLSHED_VERSION_SHAPE.test(v) && textLeaks(v).length === 0;
}

/**
 * The admitted form of a model-authored tool id, or null. Bare ids must be
 * Galaxy's own; toolshed ids keep their version only when it is
 * version-shaped.
 */
export function admitToolId(raw: string): string | null {
  const v = String(raw ?? "").trim();
  if (!v || v.length > TOOL_ID_MAX) return null;
  if (GALAXY_BUILTIN_TOOL_IDS.has(v)) return v;
  const m = v.match(TOOLSHED_TOOL_ID_RE);
  if (!m) return null;
  return m[2] !== undefined && isAdmissibleToolVersion(m[2]) ? `${m[1]}/${m[2]}` : m[1];
}

export function isAdmissibleToolId(v: string): boolean {
  return admitToolId(v) === v;
}

// Lower-case spelling -> Galaxy's own spelling, so `BAM` from a model still
// lands on `bam` and an odd-cased real one (if any) keeps its case.
const DATATYPE_BY_LOWER = new Map([...GALAXY_DATATYPES].map((d) => [d.toLowerCase(), d]));

export function admitDatatype(raw: string): string | null {
  const v = String(raw ?? "").trim();
  if (DATATYPE_SENTINELS.has(v) || v.length > DATATYPE_MAX) return null;
  if (GALAXY_DATATYPES.has(v)) return v;
  return DATATYPE_BY_LOWER.get(v.toLowerCase()) ?? null;
}

export function isAdmissibleDatatype(v: string): boolean {
  return !DATATYPE_SENTINELS.has(v) && GALAXY_DATATYPES.has(v);
}

/** galaxy-mcp's real tool names. The proxy shape builds this from model text. */
export function isAdmissibleMcpTool(v: string | undefined): v is string {
  return typeof v === "string" && GALAXY_MCP_TOOLS.has(v);
}

const TOOL_ID_KEYS = ["tool_id", "tool_ids"] as const;
const DATATYPE_KEYS = ["file_type", "ext", "extension", "datatype"] as const;
// Galaxy's "work it out for me" sentinel is not a datatype signal.
const DATATYPE_SENTINELS = new Set(["auto", ""]);

/**
 * Toolshed ids are `<host>/repos/<owner>/<repo>/<tool>/<version>`. Splitting
 * the version off is what lets triage cluster a failure across versions.
 */
export function splitToolId(raw: string): { id: string; version?: string } {
  const t = String(raw ?? "").trim();
  if (!t) return { id: "" };
  const m = t.match(/^(.*\/repos\/[^/]+\/[^/]+\/[^/]+)\/(.+)$/);
  if (m) return { id: m[1], version: m[2] };
  return { id: t };
}

function collectStrings(
  input: Record<string, unknown> | undefined,
  keys: readonly string[],
): string[] {
  if (!input || typeof input !== "object") return [];
  const out: string[] = [];
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const v of value) if (typeof v === "string") out.push(v);
  }
  return out;
}

function dedupeCap(values: string[], max: number): string[] {
  return [...new Set(values)].slice(0, max);
}

function admitted(values: string[], admit: (v: string) => string | null): string[] {
  return values.map(admit).filter((v): v is string => v !== null);
}

export function extractToolIds(input: Record<string, unknown> | undefined): string[] {
  return dedupeCap(admitted(collectStrings(input, TOOL_ID_KEYS), admitToolId), TOOLS_MAX);
}

export function extractDatatypes(input: Record<string, unknown> | undefined): string[] {
  return dedupeCap(admitted(collectStrings(input, DATATYPE_KEYS), admitDatatype), DATATYPES_MAX);
}

// -----------------------------------------------------------------------------
// Server and version
// -----------------------------------------------------------------------------

/**
 * Exact hostname match against the C7 allowlist, else "private". Never a
 * suffix match: `usegalaxy.org.evil.example` and `test.usegalaxy.org` are both
 * private, and so is every institutional mirror and every localhost install.
 */
export function resolveObservationServer(url: string | undefined): string {
  const raw = String(url ?? "").trim();
  if (!raw) return PRIVATE_SERVER;
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return PRIVATE_SERVER;
  }
  return PUBLIC_GALAXY_SERVERS.includes(host) ? host : PRIVATE_SERVER;
}

/**
 * The server this session is actually pointed at. GALAXY_URL is the live
 * answer -- /connect and switchProfile publish the active profile into it --
 * but a session whose active profile carries an encrypted-only key can have a
 * configured profile and no env URL, and reading that as "private" would
 * mislabel a public server. The profile's URL is not a secret.
 */
export function currentGalaxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GALAXY_URL) return env.GALAXY_URL;
  const { active, profiles } = loadProfiles();
  return active ? profiles[active]?.url : undefined;
}

// Nothing in the brain asks Galaxy for its version, and adding a probe is its
// own change with its own auth question. What we can have for free is the
// version galaxy-mcp already reports on a successful connect -- shape-checked
// hard (a release number, optionally devN/rcN/postN, nothing free-form that
// could carry a site name), so a hostile or absent value just leaves the field
// off. It is remembered against the server it came from, so switching servers
// mid-session can't label one server's failure with another's version.
const GALAXY_VERSION_SHAPE = /^\d{2}\.\d{1,2}(?:\.\d{1,3})?(?:\.?(?:dev|rc|post)\d{1,3})?$/;
let galaxyVersion: { version: string; url: string | undefined } | undefined;

export function recordGalaxyVersionFromConnect(resultText: string | undefined): void {
  if (!resultText) return;
  const m = resultText.match(/"version"\s*:\s*"([^"]{1,40})"/);
  if (m && GALAXY_VERSION_SHAPE.test(m[1])) {
    galaxyVersion = { version: m[1], url: currentGalaxyUrl() };
  }
}

export function getGalaxyVersion(): string | undefined {
  if (!galaxyVersion || galaxyVersion.url !== currentGalaxyUrl()) return undefined;
  return galaxyVersion.version;
}

export function resetGalaxyVersion(): void {
  galaxyVersion = undefined;
}

// -----------------------------------------------------------------------------
// Build
// -----------------------------------------------------------------------------

export interface ObservationFacts {
  kind: ObservationKind;
  trigger: ObservationTrigger;
  /** Overrides the tool-name table when the trigger knows better. */
  stage?: ObservationStage;
  mcpTool?: string;
  toolIds: string[];
  datatypes: string[];
  /** Raw error/outcome text; normalized here, never stored raw. */
  rawSignature: string;
  description?: string;
}

export interface ObservationEnvelope {
  id: string;
  clientTs: string;
  app: ObservationApp;
  version: string;
  platform: ObservationPlatform;
  wsl?: boolean;
  installToken: string;
  server: string;
  galaxyVersion?: string;
}

const PLATFORMS = new Set<ObservationPlatform>(["darwin", "linux", "win32"]);

/**
 * What a payload may carry. `full` is the `ask` shape: the normalized signature
 * and the description, which a human reads in the confirm before anything
 * goes. `structured` is the `auto` shape and carries no free text at all --
 * with nobody reading it first, no pattern table is trusted to have caught
 * every name or data value an error message can quote.
 */
export type ObservationShape = "full" | "structured";

export function shapeForMode(mode: "ask" | "auto"): ObservationShape {
  return mode === "auto" ? "structured" : "full";
}

export function buildObservation(
  facts: ObservationFacts,
  env: ObservationEnvelope,
  shape: ObservationShape,
): Observation {
  const freeText = shape === "full";
  const mcpTool = isAdmissibleMcpTool(facts.mcpTool) ? facts.mcpTool : undefined;
  const candidate = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    id: env.id,
    clientTs: env.clientTs,
    client: {
      app: env.app,
      version: env.version,
      platform: env.platform,
      ...(env.wsl === true ? { wsl: true } : {}),
    },
    installToken: env.installToken,
    kind: facts.kind,
    stage: facts.stage ?? stageForTool(mcpTool),
    trigger: facts.trigger,
    // Re-admitted here as well as in the extractors: facts can arrive from a
    // caller that never went through them.
    tools: admitted(facts.toolIds, admitToolId).map(splitToolId),
    ...(mcpTool ? { mcpTool } : {}),
    datatypes: admitted(facts.datatypes, admitDatatype),
    signature: freeText ? normalizeSignature(facts.rawSignature) : UNKNOWN_SIGNATURE,
    galaxy: {
      server: env.server,
      ...(env.galaxyVersion ? { version: env.galaxyVersion } : {}),
    },
    description: freeText ? (facts.description ?? "") : "",
  };

  const capped = capObservation(candidate);
  // A description that can't pass is dropped whole. Trimming it would be
  // guessing at which half was the leak, and an empty description still leaves
  // a usable structured observation. Scanned uncapped as well as capped: the
  // cap can cut a hostname down to something no rule recognises.
  if (capped.description) {
    const probe = validateObservation({ ...capped, description: "" });
    const full = validateObservation(capped);
    const leaky =
      textLeaks(capped.description).length > 0 || textLeaks(candidate.description).length > 0;
    if ((!full.ok || leaky) && probe.ok) return { ...capped, description: "" };
  }
  return capped;
}

export interface ObservationProblems {
  /** Wire-validator errors, `field:reason`. */
  errors: string[];
  /** Leak-table hits, `field:pattern`. Names only, never a value. */
  leaks: string[];
}

/**
 * The builder's admission rules, re-applied to a finished observation. The
 * builder only ever produces admissible fields, so on its output this is
 * empty; it is here for the payloads that did not come straight from the
 * builder -- an outbox row read back from disk is local, editable, and
 * re-sent without a fresh confirm.
 */
function admissionProblems(obs: Observation): string[] {
  const out: string[] = [];
  const tools: unknown[] = Array.isArray(obs.tools) ? obs.tools : [];
  tools.forEach((t, i) => {
    const ref = (t ?? {}) as { id?: unknown; version?: unknown };
    const joined =
      typeof ref.id !== "string"
        ? undefined
        : ref.version === undefined
          ? ref.id
          : typeof ref.version === "string"
            ? `${ref.id}/${ref.version}`
            : undefined;
    if (joined === undefined || !isAdmissibleToolId(joined)) out.push(`tools[${i}]:not-allowed`);
  });
  if (obs.mcpTool !== undefined && !isAdmissibleMcpTool(obs.mcpTool)) {
    out.push("mcpTool:not-allowed");
  }
  const datatypes: unknown[] = Array.isArray(obs.datatypes) ? obs.datatypes : [];
  datatypes.forEach((d, i) => {
    if (typeof d !== "string" || !isAdmissibleDatatype(d)) out.push(`datatypes[${i}]:not-allowed`);
  });
  const version = obs.galaxy?.version;
  if (
    version !== undefined &&
    !(typeof version === "string" && GALAXY_VERSION_SHAPE.test(version))
  ) {
    out.push("galaxy.version:not-allowed");
  }
  return out;
}

/**
 * Everything that stops a built observation from going as built. `rawSignature`
 * is the text the signature was built from, passed only for the `full` shape:
 * the staged scan (signatureStageLeaks) runs over it, reported as
 * `signature.staged:<pattern>`, because the normalizer and the cap can each
 * erase a shape the final scan would have caught. buildCheckedObservation
 * turns any signature problem into a withheld signature rather than a refusal.
 */
export function observationProblems(
  obs: Observation,
  raw: { rawSignature?: string } = {},
): ObservationProblems {
  const validity = validateObservation(obs);
  const errors = [...(validity.ok ? [] : validity.errors), ...admissionProblems(obs)];
  const leaks = scanObservationForLeaks(obs);
  if (raw.rawSignature !== undefined) {
    for (const name of signatureStageLeaks(raw.rawSignature)) {
      leaks.push(`signature.staged:${name}`);
    }
  }
  return { errors, leaks };
}

export interface CheckedObservation extends ObservationProblems {
  obs: Observation;
  /**
   * Pattern names that made the signature unsendable, when it was withheld
   * and the rest kept. Empty when nothing was withheld.
   */
  withheld: string[];
}

const isSignatureProblem = (p: string): boolean => /^signature[.:]/.test(p);
const patternOf = (p: string): string => p.slice(p.lastIndexOf(":") + 1);

/**
 * Build and check in one step. In the `full` (ask) shape a signature that
 * trips the staged scan, or the validator, is WITHHELD rather than refusing
 * the observation: it becomes `unknown` and everything else -- the structured
 * fields and a description that passed on its own -- is checked again and
 * kept, so the user still decides on what is left. Anything else that fails
 * still fails.
 */
export function buildCheckedObservation(
  facts: ObservationFacts,
  env: ObservationEnvelope,
  shape: ObservationShape,
): CheckedObservation {
  const obs = buildObservation(facts, env, shape);
  if (shape !== "full") return { obs, ...observationProblems(obs), withheld: [] };
  const first = observationProblems(obs, { rawSignature: facts.rawSignature });
  const signatureProblems = [...first.errors, ...first.leaks].filter(isSignatureProblem);
  if (signatureProblems.length === 0) return { obs, ...first, withheld: [] };
  const kept = { ...obs, signature: UNKNOWN_SIGNATURE };
  return {
    obs: kept,
    ...observationProblems(kept),
    withheld: [...new Set(signatureProblems.map(patternOf))],
  };
}

const WITHHELD_PHRASES: Record<string, string> = {
  url: "a URL",
  "scheme-url": "a URL",
  email: "an address",
  "user-at-host": "an address",
  hostname: "a host name",
  "host-port": "a host name",
  ipv4: "a network address",
  ipv6: "a network address",
  "home-path": "a path",
  "windows-path": "a path",
  "tilde-path": "a path",
  "tilde-user": "a path",
  "path-separator": "a path",
  "long-hex": "an id",
  uuid: "an id",
  "galaxy-id-phrase": "an id",
  "id-phrase": "an id",
  "non-ascii": "non-ASCII text",
};

/** The one-line reason the confirm shows when the error text was withheld. */
export function withheldReason(names: string[]): string {
  const phrases = [...new Set(names.map((n) => WITHHELD_PHRASES[n] ?? "something identifying"))];
  const list =
    phrases.length <= 1
      ? (phrases[0] ?? "something identifying")
      : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
  return `error text withheld: it contained ${list}`;
}

/** The impure half: who and where this install is. No secrets, no hostname. */
export function collectObservationEnvelope(installToken: string): ObservationEnvelope {
  const platform = process.platform as ObservationPlatform;
  return {
    id: crypto.randomUUID(),
    clientTs: new Date().toISOString(),
    app: isDesktopShell() ? "orbit" : "loom-cli",
    version: readLoomVersion() ?? "0.0.0",
    platform: PLATFORMS.has(platform) ? platform : "linux",
    ...(isWsl({ platform: process.platform, env: process.env, release: release() })
      ? { wsl: true }
      : {}),
    installToken,
    server: resolveObservationServer(currentGalaxyUrl()),
    ...(getGalaxyVersion() ? { galaxyVersion: getGalaxyVersion() } : {}),
  };
}

// -----------------------------------------------------------------------------
// Transport
// -----------------------------------------------------------------------------

// ORBIT_OBSERVATIONS_URL points this at `wrangler dev` for local work, the same
// way LOOM_FEEDBACK_URL does for /feedback.
function endpointBase(): string {
  return readEnv("OBSERVATIONS_URL") || OBSERVATIONS_ENDPOINT_URL;
}

const TIMEOUT_MS = 10_000;

export const OUTBOX_FILE = "observations-outbox.jsonl";
export const SENT_LOG_FILE = "observations-sent.jsonl";
export const TOKEN_STORE_FILE = "observations-tokens.json";

export function observationsFilePath(name: string): string {
  return join(getConfigDir(), name);
}

export interface SubmitObservationResult {
  ok: boolean;
  status?: number;
  id?: string;
  retractToken?: string;
  error?: string;
  /** Field names only -- the route never echoes a rejected value. */
  errors?: string[];
  /**
   * Whether the outbox should keep this for later. A transport failure, a 429
   * and a 503 (the route exists but isn't configured yet) are all "try again";
   * a 400 or a 401 would fail identically forever, so queuing them would just
   * grow a file nobody can drain.
   */
  queueable: boolean;
}

// The intake route answers 500 when the id already exists (a primary-key
// collision), which a resend of the same observation can never get past. So a
// 500 gets a small bounded retry here, in case it was a blip, and then counts as
// permanent -- queuing it would loop the outbox on a row that is already there
// or never will be.
const ATTEMPTS_ON_500 = 2;

function queueableStatus(status: number): boolean {
  return status === 429 || (status > 500 && status < 600);
}

export async function submitObservation(obs: Observation): Promise<SubmitObservationResult> {
  if (observationByteLength(obs) > OBSERVATION_MAX_BYTES) {
    return { ok: false, error: "observation exceeds the intake size cap", queueable: false };
  }
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = readEnv("FEEDBACK_KEY");
    if (key) headers[OBSERVATION_KEY_HEADER] = key;
    let res: Response | undefined;
    for (let attempt = 1; attempt <= ATTEMPTS_ON_500; attempt++) {
      res = await fetch(endpointBase() + OBSERVATIONS_ROUTE, {
        method: "POST",
        headers,
        body: JSON.stringify(obs),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // A redirect would replay the body and the shared key to wherever it
        // points. The route never redirects, so one is a refusal, not a hop.
        redirect: "manual",
      });
      if (res.status !== 500) break;
      if (attempt < ATTEMPTS_ON_500) await res.body?.cancel().catch(() => {});
    }
    if (!res) throw new Error("no response");
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      id?: string;
      retractToken?: string;
      error?: string;
      errors?: string[];
    };
    return {
      ok: res.ok,
      status: res.status,
      id: data.id,
      retractToken: data.retractToken,
      error: data.error,
      errors: data.errors,
      queueable: res.ok ? false : queueableStatus(res.status),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      queueable: true,
    };
  }
}

export interface RetractResult {
  ok: boolean;
  status?: number;
  /** A 404 means the row is not there, which is the outcome the user wanted. */
  alreadyGone: boolean;
  error?: string;
}

export async function retractObservation(id: string, retractToken: string): Promise<RetractResult> {
  try {
    const headers: Record<string, string> = { [RETRACT_TOKEN_HEADER]: retractToken };
    const key = readEnv("FEEDBACK_KEY");
    if (key) headers[OBSERVATION_KEY_HEADER] = key;
    const res = await fetch(`${endpointBase()}${OBSERVATIONS_ROUTE}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
    });
    await res.json().catch(() => ({}));
    // Idempotent by contract: a repeat retract is a 404, and reporting that as
    // a failure would push the user into retrying something already done.
    if (res.status === 404) return { ok: true, status: 404, alreadyGone: true };
    return { ok: res.ok, status: res.status, alreadyGone: false };
  } catch (err) {
    return {
      ok: false,
      alreadyGone: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// -----------------------------------------------------------------------------
// Local logs
// -----------------------------------------------------------------------------

function appendLine(name: string, value: unknown, mode?: number): string | null {
  try {
    const dir = getConfigDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    appendFileSync(file, JSON.stringify(value) + "\n", { encoding: "utf-8", mode: mode ?? 0o644 });
    if (mode !== undefined) {
      try {
        chmodSync(file, mode);
      } catch {
        /* perm-tightening is best-effort */
      }
    }
    return file;
  } catch {
    return null;
  }
}

// Two processes can share one ~/.loom -- Orbit and a CLI session, or two CLI
// sessions -- so the outbox is guarded by lock files, not just by the fact that
// one process's sync code can't interleave with itself.
//
// The FILE lock is short and synchronous: it covers one append, one read, or
// one rewrite. The DRAIN lock is long: it is held for a whole drain, across the
// POSTs, so two drains can never both read a row and both send it, and a
// cancel can never remove a row that a drain is sending right now.
const FILE_LOCK_WAIT_MS = 2000;
const FILE_LOCK_STALE_MS = 30_000;
// Longer than the slowest possible drain: OUTBOX_DRAIN_MAX rows, two attempts
// each, each bounded by TIMEOUT_MS.
const DRAIN_LOCK_STALE_MS = 15 * 60_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The lock is written in full under a private name and then hard-linked into
// place, so it never exists empty: a creator that wrote the pid after an
// exclusive open left a moment where a reader saw "" and judged it stale.
function tryCreateLock(lockPath: string): boolean {
  const tmp = `${lockPath}.${process.pid}.new`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    linkSync(tmp, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Remove a lock judged stale, but only if it is still the one that was judged.
 * It is renamed aside first (only one process can win that), and if what was
 * renamed turns out to be someone's fresh lock it is linked back.
 */
function removeStaleLock(lockPath: string, judged: string): void {
  const claim = `${lockPath}.${process.pid}.claim`;
  try {
    renameSync(lockPath, claim);
  } catch {
    return;
  }
  let now = "";
  try {
    now = readFileSync(claim, "utf-8");
  } catch {
    /* treat as changed */
  }
  if (now !== judged) {
    try {
      linkSync(claim, lockPath);
    } catch {
      /* a new lock already exists; leave it */
    }
  }
  rmSync(claim, { force: true });
}

function lockAgeMs(lockPath: string): number {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

/** Run `fn` holding `lockPath`, or return undefined if it can't be had in time. */
function withFileLock<T>(lockPath: string, fn: () => T): { value: T } | undefined {
  const deadline = Date.now() + FILE_LOCK_WAIT_MS;
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    while (!tryCreateLock(lockPath)) {
      // A holder that died mid-section leaves its lock behind. The sections
      // are milliseconds long, so one this old is not anyone's.
      if (lockAgeMs(lockPath) > FILE_LOCK_STALE_MS) {
        let judged = "";
        try {
          judged = readFileSync(lockPath, "utf-8");
        } catch {
          continue;
        }
        removeStaleLock(lockPath, judged);
        continue;
      }
      if (Date.now() > deadline) return undefined;
      sleepSync(20);
    }
  } catch {
    return undefined;
  }
  try {
    return { value: fn() };
  } finally {
    rmSync(lockPath, { force: true });
  }
}

/** Write via a per-process temp file and rename, so no reader sees half a file. */
function writeFileAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, contents, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function outboxPath(): string {
  return observationsFilePath(OUTBOX_FILE);
}

function outboxLockPath(): string {
  return `${outboxPath()}.lock`;
}

function readOutboxLines(): string[] {
  const file = outboxPath();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim());
}

function outboxRowId(line: string): string | undefined {
  try {
    const id = (JSON.parse(line) as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Rewrite the outbox without the rows `drop` picks out. Caller holds the file lock. */
function rewriteOutboxWithout(drop: (line: string) => boolean): number {
  const remaining = readOutboxLines().filter((l) => !drop(l));
  writeFileAtomic(outboxPath(), remaining.map((l) => l + "\n").join(""));
  return remaining.length;
}

let drainingHere = false;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireDrainLock(): boolean {
  if (drainingHere) return false;
  const lockPath = `${outboxPath()}.drain`;
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (tryCreateLock(lockPath)) {
        drainingHere = true;
        return true;
      }
      let content: string | undefined;
      try {
        content = readFileSync(lockPath, "utf-8");
      } catch {
        continue; // vanished between the two calls; try again
      }
      const holder = Number.parseInt(content, 10);
      const age = lockAgeMs(lockPath);
      // An unreadable pid is only abandoned once it is clearly not mid-write.
      const stale =
        Number.isInteger(holder) && holder > 0
          ? !pidAlive(holder) || age > DRAIN_LOCK_STALE_MS
          : age > FILE_LOCK_STALE_MS;
      if (!stale) return false;
      removeStaleLock(lockPath, content);
    }
  } catch {
    return false;
  }
  return false;
}

function releaseDrainLock(): void {
  drainingHere = false;
  rmSync(`${outboxPath()}.drain`, { force: true });
}

/**
 * Durability backstop: a POST that could succeed later is kept for the next
 * drain. Returns the file path, or null when it could not be written -- the
 * caller has to say so, because the user was about to be told it was saved.
 */
export function appendToObservationOutbox(obs: Observation): string | null {
  try {
    const done = withFileLock(outboxLockPath(), () => {
      const file = outboxPath();
      // 0600: this file carries the install token, which is the thing that
      // ties rows together. Nothing else in it is sensitive, but that is enough.
      appendFileSync(file, JSON.stringify(obs) + "\n", { encoding: "utf-8", mode: 0o600 });
      try {
        chmodSync(file, 0o600);
      } catch {
        /* perm-tightening is best-effort */
      }
      return file;
    });
    return done?.value ?? null;
  } catch {
    return null;
  }
}

export type OutboxRemoval = "removed" | "absent" | "busy" | "failed";

/**
 * Take a queued observation out before it is ever sent. Refused while a drain
 * is running, since that drain may already be sending this very row.
 */
export function removeFromObservationOutbox(id: string): OutboxRemoval {
  if (!acquireDrainLock()) return "busy";
  try {
    const done = withFileLock(outboxLockPath(), () => {
      if (!readOutboxLines().some((l) => outboxRowId(l) === id)) return "absent" as const;
      rewriteOutboxWithout((l) => outboxRowId(l) === id);
      return "removed" as const;
    });
    return done?.value ?? "failed";
  } catch {
    return "failed";
  } finally {
    releaseDrainLock();
  }
}

export const OUTBOX_DRAIN_MAX = 10;

export interface OutboxDrainCounts {
  sent: number;
  kept: number;
  dropped: number;
  /** Present when a row went but its retract token could not be saved. */
  unretractable?: number;
}

/**
 * Retry what the outbox holds, oldest first, at most OUTBOX_DRAIN_MAX per call.
 * Each row is re-checked before it goes, with the same rules the builder
 * applies -- the file is local, could have been edited, and its rows go
 * without a fresh confirm -- and anything that fails, or that the route now
 * refuses for good, is dropped rather than kept to fail forever. Only
 * queueable failures stay.
 *
 * The rewrite removes rows by id, never by position, so a row appended or
 * removed by someone else while the POSTs were in flight is left as it is. If
 * another drain is already running (here or in another process sharing this
 * state dir), this one does nothing.
 */
export async function drainObservationOutbox(
  submit: (obs: Observation) => Promise<SubmitObservationResult>,
  /**
   * Asked again before every row, not once per drain: a drain can run for
   * minutes on a slow network, and collection may be turned off meanwhile.
   */
  stillCollecting: () => boolean,
): Promise<OutboxDrainCounts> {
  const counts: OutboxDrainCounts = { sent: 0, kept: 0, dropped: 0 };
  if (!existsSync(outboxPath())) return counts;
  if (!acquireDrainLock()) return counts;
  try {
    const lines = withFileLock(outboxLockPath(), readOutboxLines)?.value ?? [];
    if (lines.length === 0) return counts;

    // Settled rows: sent, or dropped for good. Matched by id; a line too
    // broken to carry an id is matched by its exact text.
    const doneIds = new Set<string>();
    const doneLines = new Set<string>();
    const settle = (line: string, id: string | undefined): void => {
      if (id) doneIds.add(id);
      else doneLines.add(line);
    };

    let unreachable = false;
    for (const [i, line] of lines.entries()) {
      // Past the per-drain cap, once the route has proved unreachable this
      // round, or once collection has been turned off, the rest just wait: on
      // a black-holed network each try costs the full timeout, and this runs
      // before the turn's own prompts appear.
      if (i >= OUTBOX_DRAIN_MAX || unreachable || !stillCollecting()) break;
      const id = outboxRowId(line);
      if (id && doneIds.has(id)) continue;
      let obs: Observation;
      try {
        obs = JSON.parse(line) as Observation;
      } catch {
        settle(line, undefined);
        counts.dropped += 1;
        continue;
      }
      const problems = observationProblems(obs);
      if (problems.errors.length > 0 || problems.leaks.length > 0) {
        settle(line, id);
        counts.dropped += 1;
        continue;
      }
      const res = await submit(obs);
      if (res.ok) {
        if (res.retractToken && !saveRetractToken(obs.id, res.retractToken)) {
          counts.unretractable = (counts.unretractable ?? 0) + 1;
        }
        appendSentLog(sentLogEntryFor(obs, "sent"));
        settle(line, id);
        counts.sent += 1;
      } else if (res.queueable) {
        if (res.status === undefined) unreachable = true;
      } else {
        settle(line, id);
        counts.dropped += 1;
      }
    }

    const rewritten = withFileLock(outboxLockPath(), () =>
      rewriteOutboxWithout((l) => doneLines.has(l) || doneIds.has(outboxRowId(l) ?? "")),
    );
    // Couldn't take the lock to rewrite: the settled rows stay in the file and
    // a sent one may go again next time. Leaving them is the safe failure; a
    // rewrite without the lock could drop a row someone just appended.
    counts.kept = rewritten?.value ?? readOutboxLines().length;
    return counts;
  } finally {
    releaseDrainLock();
  }
}

export interface ObservationSentEntry {
  at: string;
  id: string;
  status: "sent" | "queued" | "retracted" | "cancelled";
  kind: string;
  stage: string;
  trigger: string;
  signature: string;
  tools: string[];
  mcpTool?: string;
  datatypes: string[];
  server: string;
  description: string;
}

/**
 * The readable "what have I sent" row. Deliberately carries neither the
 * install token nor the retract token, so `/observations sent` can show the
 * log without handing either one over.
 */
export function sentLogEntryFor(
  obs: Observation,
  status: ObservationSentEntry["status"],
): ObservationSentEntry {
  return {
    at: new Date().toISOString(),
    id: obs.id,
    status,
    kind: obs.kind,
    stage: obs.stage,
    trigger: obs.trigger,
    signature: obs.signature,
    tools: obs.tools.map((t) => t.id),
    ...(obs.mcpTool ? { mcpTool: obs.mcpTool } : {}),
    datatypes: obs.datatypes,
    server: obs.galaxy.server,
    description: obs.description,
  };
}

export function appendSentLog(entry: ObservationSentEntry): string | null {
  // 0600 like the outbox. The rows hold no token, but what an install has
  // reported is the user's business, not every local process's.
  return appendLine(SENT_LOG_FILE, entry, 0o600);
}

export function readSentLog(): ObservationSentEntry[] {
  const file = observationsFilePath(SENT_LOG_FILE);
  if (!existsSync(file)) return [];
  const out: ObservationSentEntry[] = [];
  try {
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ObservationSentEntry);
      } catch {
        // Skip, same as the activity log's own hydrate.
      }
    }
  } catch {
    return out;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Retract tokens
// -----------------------------------------------------------------------------

function readTokenStore(): Record<string, string> {
  const file = observationsFilePath(TOKEN_STORE_FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupt store costs the ability to retract older rows, which is better
    // than throwing out of a command the user is standing in front of.
    return {};
  }
}

function tokenStorePath(): string {
  return observationsFilePath(TOKEN_STORE_FILE);
}

/**
 * Read-modify-write under a lock, written via temp + rename: a crash mid-write
 * would otherwise leave a truncated store, which reads back as empty and loses
 * every retract token at once. False when the change could not be saved.
 */
function updateTokenStore(change: (store: Record<string, string>) => void): boolean {
  try {
    const done = withFileLock(`${tokenStorePath()}.lock`, () => {
      const store = readTokenStore();
      change(store);
      writeFileAtomic(tokenStorePath(), JSON.stringify(store, null, 2) + "\n");
      return true;
    });
    return done?.value === true;
  } catch {
    return false;
  }
}

/**
 * The Worker returns a retract token once, so it has to be kept to make
 * `/observations retract` possible. Kept out of the sent log and listed in the
 * exec-guard's credential stores so the agent can never read it. False when it
 * could not be written, which the caller tells the user about: without it the
 * row can't be retracted.
 */
export function saveRetractToken(id: string, token: string): boolean {
  return updateTokenStore((store) => {
    store[id] = token;
  });
}

export function readRetractToken(id: string): string | undefined {
  const token = readTokenStore()[id];
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

export function forgetRetractToken(id: string): boolean {
  if (!(id in readTokenStore())) return true;
  return updateTokenStore((store) => {
    delete store[id];
  });
}
