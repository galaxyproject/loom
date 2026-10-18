import { parseRerouteState, type RerouteState } from "./galaxy-reroute-state.js";
/**
 * The approval and attempt registry's schema (design v3 §3), its canonical
 * JSON form, and the parser that is the only way a document from disk or a
 * Page carrier becomes a `Registry`.
 *
 * Deliberately free of anything harness-specific: no pi, no extension state,
 * no environment. The same module has to serve a standalone MCP process later.
 * `tests/registry-no-pi-imports.test.ts` enforces that over the import graph.
 *
 * The parser builds fresh objects field by field rather than casting what it
 * was given. Unknown keys are dropped, so nothing an import smuggles in gets
 * re-signed with this session's key and read back later as its own state.
 */

import { createHash } from "crypto";
import { isUlid } from "./ulid";

// ─────────────────────────────────────────────────────────────────────────────
// Types (v3 §3, names kept exactly)
// ─────────────────────────────────────────────────────────────────────────────

/** A ULID, the same format capture already writes as `attempt_id`. */
export type AttemptId = string;

/** A notebook step anchor, or the literal capture uses for "no step". */
export type StepAnchor = string;

export const CURRENT_REGISTRY_VERSION = 3;

export interface Registry {
  reroutes?: Record<string, RerouteState>;
  version: 3;
  revision: number;
  writer_token: string;
  /** HMAC(session_key, canonical registry without this field). */
  session_sig: string;
  analysis_id: string;
  server_url: string;
  attempts: Record<AttemptId, Attempt>;
  exceptions: Exception[];
  supervision: { active_at_shutdown: AttemptId[]; last_reconcile_at?: string };
  /**
   * Not in v3 §3, which says server-mismatched imports are "quarantined"
   * without saying where. Kept out of `attempts` so nothing that reads
   * attempts can act on them, and persisted so the quarantine survives a save.
   */
  quarantine?: Record<AttemptId, Attempt>;
}

export type AttemptKind = "workflow" | "tool" | "udt" | "upload" | "rerun";

export interface Attempt {
  connection_id?: string;
  account_id?: string;
  superseded_by?: AttemptId;
  attempt_id: AttemptId;
  kind: AttemptKind;
  binding: { step_anchor: StepAnchor | "unattributed"; bound_at: string };
  server_url: string;
  history_id: string;

  approval?: {
    proposal_id: string;
    /** sha256(canonical Spec) */
    spec_revision: string;
    spec_snapshot: Spec;
    status: "live" | "restored" | "revoked";
    by: "user" | "restored";
    at: string;
  };

  reservation?: {
    dispatch_id: string;
    reserved_at: string;
    state: "reserved" | "submitted" | "submission_unknown" | "released";
  };

  submission?: {
    invocation_id?: string;
    job_id?: string;
    dataset_id?: string;
    submitted_at: string;
    submitted_by: "harness" | "agent" | "unknown" | "pre-existing";
    server_verified: boolean;
    check: {
      /**
       * `conformant_by_reconcile`: the run Galaxy reports was re-checked against
       * the frozen Spec in this session. Never written for a by-construction
       * submission, and never carried across an import.
       */
      outcome:
        | "conformant_by_construction"
        | "conformant_by_reconcile"
        | "unchecked"
        | "mismatch"
        | "unverified";
      diff?: Diff[];
      mode: "off" | "warn" | "deny";
    };
    request_digest: string;
    dispatch_recheck: { definition_digest_ok: boolean; template_digest_ok: boolean; at: string };
  };

  provenance?: {
    ref: { kind: "dataset" | "file"; id: string };
    digest: string;
    enrichment: "pending" | "complete" | "unavailable";
    authority: "established" | "historical";
  };

  evaluation?: {
    execution: "success" | "failed" | "unknown";
    conformity: "conformant" | "nonconformant" | "unverified" | "excepted";
    /** `attested`: the user vouched for a result no code checked; never reported as `pass`. */
    predicate_result: "pass" | "fail" | "unevaluable" | "attested";
    assertions: Record<string, "pass" | "fail" | "inconclusive" | "excepted">;
    integrity: "ok" | "unverified_identity" | "render_contradiction" | "effective_contradiction";
    authority: "established" | "historical";
    evaluated_at: string;
  };
  /** Derived (v3 §7). Recomputed on every write; never taken from input. */
  handoff_eligible: boolean;
  rerun_of?: AttemptId[];
}

export interface Spec {
  target: {
    kind: "workflow" | "tool" | "udt";
    workflow_id?: string;
    tool_id?: string;
    tool_uuid?: string;
    /** Always resolved at approval, never "unpinned". */
    version: string;
    definition_digest?: string;
  };
  server_url: string;
  history_id: string;
  inputs: Array<{ slot: string; src: "hda" | "hdca" | "ldda"; id: string; required: boolean }>;
  overrides: Array<{ param: string; value: unknown; rationale: string }>;
  template_ref: { digest: string; fetched_at: string; version: string };
  predicate: Predicate;
  assertions: Array<{ id: string; definition_digest: string; definition: unknown }>;
}

export type Predicate =
  | { kind: "exists_with_ext"; ext: string; min_count?: number }
  | { kind: "count_eq"; ext?: string; count: number }
  | { kind: "assertions_pass"; ids: string[] }
  | { kind: "manual" };

export interface Exception {
  id: string;
  attempt_id: AttemptId;
  spec_revision: string;
  scope: "submission_check" | "evidence_gate" | "manual_attestation";
  /** evidence_gate only: the one assertion this waives. */
  assertion_id?: string;
  by: "user" | "restored";
  at: string;
  reason: string;
}

export type Diff = { path: string; approved: unknown; observed: unknown };

// ─────────────────────────────────────────────────────────────────────────────
// Canonical JSON and digests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON with object keys sorted at every level and `undefined` members dropped.
 * The one serialisation everything here hashes or signs, so two processes that
 * hold the same value always agree on its digest. Throws on anything JSON
 * can't represent faithfully rather than letting it coerce to `null` or `{}`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number`);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalJson: not a plain object`);
      }
      const rec = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(rec).sort()) {
        if (rec[key] === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${canonicalJson(rec[key])}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: cannot serialise a ${typeof value}`);
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** `spec_revision`: sha256 of the canonical Spec (v3 §5). */
export function specRevision(spec: Spec): string {
  return sha256Hex(canonicalJson(spec));
}

export const DIGEST_RE = /^[0-9a-f]{64}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Strict parsing
// ─────────────────────────────────────────────────────────────────────────────

export class RegistryFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryFormatError";
  }
}

/**
 * Throw if any JSON object in `text` repeats a key. `JSON.parse` silently keeps
 * the last one, which would let a file carry two different attempts under one
 * id and have us sign whichever happened to come second. Assumes `text` has
 * already parsed as JSON.
 */
export function assertNoDuplicateKeys(text: string): void {
  const stack: Array<Set<string> | null> = [];
  let expectKey = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.has(key)) throw new RegistryFormatError(`duplicate key "${key}"`);
        top.add(key);
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (c === "[") {
      stack.push(null);
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === ",") {
      expectKey = stack[stack.length - 1] != null;
    }
    i++;
  }
}

const MAX_STRING = 4096;

function fail(path: string, what: string): never {
  throw new RegistryFormatError(`${path}: ${what}`);
}

function rec(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail(path, "expected an object");
  return v as Record<string, unknown>;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, "expected an array");
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string") fail(path, "expected a string");
  if (v.length > MAX_STRING) fail(path, "string too long");
  return v;
}

function optStr(v: unknown, path: string): string | undefined {
  return v === undefined ? undefined : str(v, path);
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") fail(path, "expected a boolean");
  return v;
}

/**
 * Ceiling on `registry.revision`. Every write adds one, so a file claiming a
 * revision near MAX_SAFE_INTEGER would push the next write past it, and every
 * write after that would fail validation -- a registry nobody can record into.
 * 2^48 is far beyond any real session's writes.
 */
export const MAX_REGISTRY_REVISION = 2 ** 48;

function count(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    fail(path, "expected a non-negative integer");
  }
  return v;
}

function revisionCount(v: unknown): number {
  const n = count(v, "registry.revision");
  if (n > MAX_REGISTRY_REVISION) fail("registry.revision", "is too large to keep incrementing");
  return n;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    fail(path, `expected one of ${allowed.join(", ")}`);
  }
  return v as T;
}

/**
 * A string that becomes an object key somewhere. `__proto__` as a key is
 * silently swallowed by plain-object assignment, so a result recorded under it
 * would vanish; refuse it outright.
 */
function keyStr(v: unknown, path: string): string {
  const s = str(v, path);
  if (s === "__proto__") fail(path, "reserved key");
  return s;
}

function attemptId(v: unknown, path: string): AttemptId {
  const s = str(v, path);
  if (!isUlid(s)) fail(path, "not an attempt id");
  return s;
}

function digest(v: unknown, path: string): string {
  const s = str(v, path);
  if (!DIGEST_RE.test(s)) fail(path, "not a sha256 hex digest");
  return s;
}

/** Any JSON value, re-serialised to prove it is one. */
function jsonValue(v: unknown, path: string): unknown {
  try {
    return JSON.parse(canonicalJson(v));
  } catch {
    fail(path, "not a JSON value");
  }
}

function parsePredicate(v: unknown, path: string): Predicate {
  const o = rec(v, path);
  const kind = oneOf(o.kind, ["exists_with_ext", "count_eq", "assertions_pass", "manual"], path);
  switch (kind) {
    case "exists_with_ext": {
      const p: Predicate = { kind, ext: str(o.ext, `${path}.ext`) };
      if (o.min_count !== undefined) p.min_count = count(o.min_count, `${path}.min_count`);
      return p;
    }
    case "count_eq": {
      const p: Predicate = { kind, count: count(o.count, `${path}.count`) };
      if (o.ext !== undefined) p.ext = str(o.ext, `${path}.ext`);
      return p;
    }
    case "assertions_pass": {
      const ids = arr(o.ids, `${path}.ids`).map((x, i) => str(x, `${path}.ids[${i}]`));
      // v3 §7: never vacuous.
      if (ids.length === 0) fail(`${path}.ids`, "assertions_pass needs at least one id");
      return { kind, ids };
    }
    case "manual":
      return { kind };
  }
}

export function parseSpec(v: unknown, path = "spec"): Spec {
  const o = rec(v, path);
  const t = rec(o.target, `${path}.target`);
  const version = str(t.version, `${path}.target.version`);
  if (version === "" || version === "unpinned") {
    fail(`${path}.target.version`, "a Spec's version is always resolved");
  }
  const target: Spec["target"] = {
    kind: oneOf(t.kind, ["workflow", "tool", "udt"], `${path}.target.kind`),
    version,
  };
  if (t.workflow_id !== undefined)
    target.workflow_id = str(t.workflow_id, `${path}.target.workflow_id`);
  if (t.tool_id !== undefined) target.tool_id = str(t.tool_id, `${path}.target.tool_id`);
  if (t.tool_uuid !== undefined) target.tool_uuid = str(t.tool_uuid, `${path}.target.tool_uuid`);
  if (t.definition_digest !== undefined) {
    target.definition_digest = digest(t.definition_digest, `${path}.target.definition_digest`);
  }
  const tr = rec(o.template_ref, `${path}.template_ref`);
  const assertions = arr(o.assertions, `${path}.assertions`).map((a, i) => {
    const ap = `${path}.assertions[${i}]`;
    const ao = rec(a, ap);
    return {
      id: keyStr(ao.id, `${ap}.id`),
      definition_digest: digest(ao.definition_digest, `${ap}.definition_digest`),
      definition: jsonValue(ao.definition, `${ap}.definition`),
    };
  });
  const predicate = parsePredicate(o.predicate, `${path}.predicate`);
  if (predicate.kind === "assertions_pass") {
    const known = new Set(assertions.map((a) => a.id));
    for (const id of predicate.ids) {
      if (!known.has(id)) fail(`${path}.predicate.ids`, `"${id}" is not a frozen assertion`);
    }
  }
  return {
    target,
    server_url: str(o.server_url, `${path}.server_url`),
    history_id: str(o.history_id, `${path}.history_id`),
    inputs: arr(o.inputs, `${path}.inputs`).map((x, i) => {
      const ip = `${path}.inputs[${i}]`;
      const io = rec(x, ip);
      return {
        slot: str(io.slot, `${ip}.slot`),
        src: oneOf(io.src, ["hda", "hdca", "ldda"], `${ip}.src`),
        id: str(io.id, `${ip}.id`),
        required: bool(io.required, `${ip}.required`),
      };
    }),
    overrides: arr(o.overrides, `${path}.overrides`).map((x, i) => {
      const op = `${path}.overrides[${i}]`;
      const oo = rec(x, op);
      return {
        param: str(oo.param, `${op}.param`),
        value: jsonValue(oo.value, `${op}.value`),
        rationale: str(oo.rationale, `${op}.rationale`),
      };
    }),
    template_ref: {
      digest: digest(tr.digest, `${path}.template_ref.digest`),
      fetched_at: str(tr.fetched_at, `${path}.template_ref.fetched_at`),
      version: str(tr.version, `${path}.template_ref.version`),
    },
    predicate,
    assertions,
  };
}

function parseAttempt(v: unknown, path: string): Attempt {
  const o = rec(v, path);
  const b = rec(o.binding, `${path}.binding`);
  const attempt: Attempt = {
    attempt_id: attemptId(o.attempt_id, `${path}.attempt_id`),
    kind: oneOf(o.kind, ["workflow", "tool", "udt", "upload", "rerun"], `${path}.kind`),
    binding: {
      step_anchor: str(b.step_anchor, `${path}.binding.step_anchor`),
      bound_at: str(b.bound_at, `${path}.binding.bound_at`),
    },
    server_url: str(o.server_url, `${path}.server_url`),
    history_id: str(o.history_id, `${path}.history_id`),
    // Derived; whatever the input said is irrelevant. The store recomputes it.
    handoff_eligible: false,
  };

  if (o.approval !== undefined) {
    const p = `${path}.approval`;
    const a = rec(o.approval, p);
    attempt.approval = {
      proposal_id: str(a.proposal_id, `${p}.proposal_id`),
      spec_revision: digest(a.spec_revision, `${p}.spec_revision`),
      spec_snapshot: parseSpec(a.spec_snapshot, `${p}.spec_snapshot`),
      status: oneOf(a.status, ["live", "restored", "revoked"], `${p}.status`),
      by: oneOf(a.by, ["user", "restored"], `${p}.by`),
      at: str(a.at, `${p}.at`),
    };
    // Coherence, not authentication: a revision that doesn't hash the snapshot
    // it sits beside was edited by hand, and there is no telling which half.
    if (specRevision(attempt.approval.spec_snapshot) !== attempt.approval.spec_revision) {
      fail(`${p}.spec_revision`, "does not match spec_snapshot");
    }
  }

  if (o.reservation !== undefined) {
    const p = `${path}.reservation`;
    const r = rec(o.reservation, p);
    attempt.reservation = {
      dispatch_id: str(r.dispatch_id, `${p}.dispatch_id`),
      reserved_at: str(r.reserved_at, `${p}.reserved_at`),
      state: oneOf(
        r.state,
        ["reserved", "submitted", "submission_unknown", "released"],
        `${p}.state`,
      ),
    };
  }

  if (o.submission !== undefined) {
    const p = `${path}.submission`;
    const s = rec(o.submission, p);
    const c = rec(s.check, `${p}.check`);
    const d = rec(s.dispatch_recheck, `${p}.dispatch_recheck`);
    const check: NonNullable<Attempt["submission"]>["check"] = {
      outcome: oneOf(
        c.outcome,
        [
          "conformant_by_construction",
          "conformant_by_reconcile",
          "unchecked",
          "mismatch",
          "unverified",
        ],
        `${p}.check.outcome`,
      ),
      mode: oneOf(c.mode, ["off", "warn", "deny"], `${p}.check.mode`),
    };
    if (c.diff !== undefined) {
      check.diff = arr(c.diff, `${p}.check.diff`).map((x, i) => {
        const dp = `${p}.check.diff[${i}]`;
        const dobj = rec(x, dp);
        return {
          path: str(dobj.path, `${dp}.path`),
          approved: jsonValue(dobj.approved, `${dp}.approved`),
          observed: jsonValue(dobj.observed, `${dp}.observed`),
        };
      });
    }
    attempt.submission = {
      invocation_id: optStr(s.invocation_id, `${p}.invocation_id`),
      job_id: optStr(s.job_id, `${p}.job_id`),
      dataset_id: optStr(s.dataset_id, `${p}.dataset_id`),
      submitted_at: str(s.submitted_at, `${p}.submitted_at`),
      submitted_by: oneOf(
        s.submitted_by,
        ["harness", "agent", "unknown", "pre-existing"],
        `${p}.submitted_by`,
      ),
      server_verified: bool(s.server_verified, `${p}.server_verified`),
      check,
      request_digest: str(s.request_digest, `${p}.request_digest`),
      dispatch_recheck: {
        definition_digest_ok: bool(
          d.definition_digest_ok,
          `${p}.dispatch_recheck.definition_digest_ok`,
        ),
        template_digest_ok: bool(d.template_digest_ok, `${p}.dispatch_recheck.template_digest_ok`),
        at: str(d.at, `${p}.dispatch_recheck.at`),
      },
    };
    for (const k of ["invocation_id", "job_id", "dataset_id"] as const) {
      if (attempt.submission[k] === undefined) delete attempt.submission[k];
    }
  }

  if (o.provenance !== undefined) {
    const p = `${path}.provenance`;
    const pv = rec(o.provenance, p);
    const ref = rec(pv.ref, `${p}.ref`);
    attempt.provenance = {
      ref: {
        kind: oneOf(ref.kind, ["dataset", "file"], `${p}.ref.kind`),
        id: str(ref.id, `${p}.ref.id`),
      },
      digest: str(pv.digest, `${p}.digest`),
      enrichment: oneOf(pv.enrichment, ["pending", "complete", "unavailable"], `${p}.enrichment`),
      authority: oneOf(pv.authority, ["established", "historical"], `${p}.authority`),
    };
  }

  if (o.evaluation !== undefined) {
    const p = `${path}.evaluation`;
    const e = rec(o.evaluation, p);
    const assertions: Record<string, "pass" | "fail" | "inconclusive" | "excepted"> = {};
    for (const [k, val] of Object.entries(rec(e.assertions, `${p}.assertions`))) {
      assertions[keyStr(k, `${p}.assertions key`)] = oneOf(
        val,
        ["pass", "fail", "inconclusive", "excepted"],
        `${p}.assertions.${k}`,
      );
    }
    attempt.evaluation = {
      execution: oneOf(e.execution, ["success", "failed", "unknown"], `${p}.execution`),
      conformity: oneOf(
        e.conformity,
        ["conformant", "nonconformant", "unverified", "excepted"],
        `${p}.conformity`,
      ),
      predicate_result: oneOf(
        e.predicate_result,
        ["pass", "fail", "unevaluable", "attested"],
        `${p}.predicate_result`,
      ),
      assertions,
      integrity: oneOf(
        e.integrity,
        ["ok", "unverified_identity", "render_contradiction", "effective_contradiction"],
        `${p}.integrity`,
      ),
      authority: oneOf(e.authority, ["established", "historical"], `${p}.authority`),
      evaluated_at: str(e.evaluated_at, `${p}.evaluated_at`),
    };
  }

  if (o.connection_id !== undefined)
    attempt.connection_id = str(o.connection_id, `${path}.connection_id`);
  if (o.account_id !== undefined) attempt.account_id = str(o.account_id, `${path}.account_id`);
  if (o.superseded_by !== undefined)
    attempt.superseded_by = attemptId(o.superseded_by, `${path}.superseded_by`);
  if (o.rerun_of !== undefined) {
    attempt.rerun_of = arr(o.rerun_of, `${path}.rerun_of`).map((x, i) =>
      attemptId(x, `${path}.rerun_of[${i}]`),
    );
  }
  return attempt;
}

function parseException(v: unknown, path: string): Exception {
  const o = rec(v, path);
  const x: Exception = {
    id: str(o.id, `${path}.id`),
    attempt_id: attemptId(o.attempt_id, `${path}.attempt_id`),
    spec_revision: digest(o.spec_revision, `${path}.spec_revision`),
    scope: oneOf(
      o.scope,
      ["submission_check", "evidence_gate", "manual_attestation"],
      `${path}.scope`,
    ),
    by: oneOf(o.by, ["user", "restored"], `${path}.by`),
    at: str(o.at, `${path}.at`),
    reason: str(o.reason, `${path}.reason`),
  };
  if (o.assertion_id !== undefined) {
    if (x.scope !== "evidence_gate")
      fail(`${path}.assertion_id`, "only an evidence_gate names one");
    x.assertion_id = keyStr(o.assertion_id, `${path}.assertion_id`);
  }
  return x;
}

function parseAttemptMap(v: unknown, path: string, seen: Set<string>): Record<AttemptId, Attempt> {
  const out: Record<AttemptId, Attempt> = {};
  for (const [key, value] of Object.entries(rec(v, path))) {
    const attempt = parseAttempt(value, `${path}.${key}`);
    if (attempt.attempt_id !== key) fail(`${path}.${key}`, "keyed under a different id");
    if (seen.has(key)) fail(`${path}.${key}`, "duplicate attempt id");
    seen.add(key);
    out[key] = attempt;
  }
  return out;
}

/**
 * Parse a current-version registry document. Throws `RegistryFormatError` on
 * anything malformed; returns a fresh object holding only known fields.
 */
export function parseRegistry(v: unknown): Registry {
  const o = rec(v, "registry");
  if (o.version !== CURRENT_REGISTRY_VERSION) fail("registry.version", "expected 3");
  const seen = new Set<string>();
  const attempts = parseAttemptMap(o.attempts, "registry.attempts", seen);
  const quarantine =
    o.quarantine === undefined
      ? undefined
      : parseAttemptMap(o.quarantine, "registry.quarantine", seen);
  const exceptions = arr(o.exceptions, "registry.exceptions").map((x, i) =>
    parseException(x, `registry.exceptions[${i}]`),
  );
  const exceptionIds = new Set<string>();
  for (const ex of exceptions) {
    if (exceptionIds.has(ex.id)) fail("registry.exceptions", `duplicate exception id "${ex.id}"`);
    exceptionIds.add(ex.id);
  }
  const sup = rec(o.supervision, "registry.supervision");
  const supervision: Registry["supervision"] = {
    active_at_shutdown: arr(sup.active_at_shutdown, "registry.supervision.active_at_shutdown").map(
      (x, i) => attemptId(x, `registry.supervision.active_at_shutdown[${i}]`),
    ),
  };
  if (sup.last_reconcile_at !== undefined) {
    supervision.last_reconcile_at = str(
      sup.last_reconcile_at,
      "registry.supervision.last_reconcile_at",
    );
  }
  const registry: Registry = {
    version: CURRENT_REGISTRY_VERSION,
    revision: revisionCount(o.revision),
    writer_token: str(o.writer_token, "registry.writer_token"),
    session_sig: str(o.session_sig, "registry.session_sig"),
    analysis_id: str(o.analysis_id, "registry.analysis_id"),
    server_url: str(o.server_url, "registry.server_url"),
    attempts,
    exceptions,
    supervision,
  };
  if (o.reroutes !== undefined) {
    const routes = rec(o.reroutes, "registry.reroutes");
    registry.reroutes = Object.fromEntries(
      Object.entries(routes).map(([key, value]) => {
        const route = parseRerouteState(value);
        if (route.id !== key) fail("registry.reroutes", "reroute identity mismatch");
        return [key, route];
      }),
    );
  }
  if (quarantine !== undefined) registry.quarantine = quarantine;
  return registry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Migrations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upgrades keyed by the version they read: `MIGRATIONS[3]` would turn a v3
 * document into v4. Empty while v3 is the only version. A migrated document is
 * always an import -- its signature was over the old shape -- so a migration
 * never has to preserve anything the import rule downgrades anyway.
 */
export const MIGRATIONS: Readonly<
  Record<number, (doc: Record<string, unknown>) => Record<string, unknown>>
> = {};

/** Bring a parsed document up to the current version, or throw. */
export function migrateToCurrent(
  doc: unknown,
  migrations: Readonly<
    Record<number, (d: Record<string, unknown>) => Record<string, unknown>>
  > = MIGRATIONS,
): unknown {
  let current = rec(doc, "registry");
  for (let steps = 0; steps < 64; steps++) {
    const version = current.version;
    if (version === CURRENT_REGISTRY_VERSION) return current;
    if (typeof version !== "number" || !Number.isSafeInteger(version)) {
      fail("registry.version", "missing or not an integer");
    }
    if (version > CURRENT_REGISTRY_VERSION) {
      fail("registry.version", `written by a newer Loom (version ${version})`);
    }
    const step = migrations[version];
    if (!step) fail("registry.version", `no migration from version ${version}`);
    current = rec(step(current), "registry");
    if (current.version === version) fail("registry.version", "migration did not advance");
  }
  fail("registry.version", "migration chain too long");
}

/** Normalise a Galaxy server url for comparison: scheme defaulted, no trailing slash, lowercase. */
export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "").toLowerCase();
  if (trimmed === "") return "";
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}
