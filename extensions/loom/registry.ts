/**
 * The approval and attempt registry: the harness-owned record that binds what
 * the user approved to what the harness submitted and to what came back.
 * Registry design v3 is the authority (`docs/architecture.md` will say so once
 * the registry is wired in); this module implements §2, §3 and §10.
 *
 * What it guarantees here, and only here:
 *
 * - Every write is signed with a key generated when the store is constructed
 *   and held only in this object's memory. A document whose signature verifies
 *   with that key is this session's own state; anything else is an import and
 *   goes through the import rule, which strips every approval, exception,
 *   check and authority it claims.
 * - `revision` only goes up. An own-signed document older than what the store
 *   already holds is a replay and is ignored.
 * - One writer at a time, fenced by the lock token.
 * - `handoff_eligible` is recomputed on every write and never read from input.
 *
 * No harness coupling: the analysis directory, clock and filesystem come in
 * through the constructor, and nothing here imports pi or extension state.
 * `tests/registry-no-pi-imports.test.ts` holds that line.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { randomBytes, randomHex } from "../../shared/random.js";
import * as path from "path";
import { computeHandoffEligible } from "./registry-eligibility";
import { applyImportRule } from "./registry-import";
import { RegistryLock, renameReplacing, type LockRecord, type RegistryFs } from "./registry-lock";
import {
  CURRENT_REGISTRY_VERSION,
  DIGEST_RE,
  MAX_REGISTRY_REVISION,
  RegistryFormatError,
  assertNoDuplicateKeys,
  canonicalJson,
  migrateToCurrent,
  normalizeServerUrl,
  parseRegistry,
  sha256Hex,
  type AttemptId,
  type Registry,
} from "./registry-schema";
import { ulid } from "./ulid";

export * from "./registry-schema";
export { computeHandoffEligible } from "./registry-eligibility";
export { applyImportRule } from "./registry-import";
export { STALE_LOCK_MS, type RegistryFs, type LockRecord } from "./registry-lock";
export type { Submitter, SubmitOutcome, TemplateSnapshot } from "./registry-submitter";

/** Writes an imported registry must still have room for. */
const REVISION_HEADROOM = 2 ** 20;

/** Past this, a registry file or carrier is rejected unread. */
export const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;

export const STATE_DIR = path.join(".loom", "state");

export interface RegistryStoreOptions {
  analysisDir: string;
  /** The Galaxy server this session talks to; attempts for any other are quarantined. */
  serverUrl: string;
  sessionId: string;
  fs: RegistryFs;
  /** Milliseconds since the epoch. */
  clock: () => number;
  pid?: number;
  /** Used only when there is nothing to load. Defaults to a fresh ULID. */
  analysisId?: string;
  /** Defaults to `process.platform`; decides whether a busy rename is retried. */
  platform?: NodeJS.Platform;
}

export type LoadOutcome =
  | { kind: "empty" }
  | { kind: "own"; revision: number }
  | { kind: "stale"; revision: number; current: number }
  | { kind: "imported"; revision: number; quarantined: AttemptId[] }
  /** A foreign document arrived while this session holds its own signed state. */
  | { kind: "ignored"; reason: string }
  | { kind: "rejected"; reason: string };

export class RegistryReadOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryReadOnlyError";
  }
}

export class RegistryFencedError extends RegistryReadOnlyError {
  constructor(holder: LockRecord | null) {
    super(
      holder
        ? `registry lock was taken over by session ${holder.session_id} (pid ${holder.pid}); reopened read-only`
        : "registry lock is gone; reopened read-only",
    );
    this.name = "RegistryFencedError";
  }
}

export class RegistryStore {
  readonly stateDir: string;
  readonly registryPath: string;
  readonly lockPath: string;
  readonly templatesDir: string;
  readonly serverUrl: string;
  /** Human-readable things the session should be told about. */
  readonly notices: string[] = [];

  // Private class field: not enumerable, not reachable by JSON.stringify,
  // structuredClone, or anything that walks the object's own keys.
  readonly #sessionKey: Uint8Array = randomBytes(32);
  readonly #fs: RegistryFs;
  readonly #clock: () => number;
  readonly #pid: number;
  readonly #platform: NodeJS.Platform;
  readonly #lock: RegistryLock;
  #mode: "writer" | "read-only" = "read-only";
  #registry: Registry;
  /** Whether what we hold was signed by this session (written or verified). */
  #ownState = false;

  constructor(opts: RegistryStoreOptions) {
    this.stateDir = path.join(opts.analysisDir, STATE_DIR);
    this.registryPath = path.join(this.stateDir, "registry.json");
    this.lockPath = path.join(this.stateDir, "lock");
    this.templatesDir = path.join(this.stateDir, "templates");
    this.serverUrl = normalizeServerUrl(opts.serverUrl);
    this.#fs = opts.fs;
    this.#clock = opts.clock;
    this.#pid = opts.pid ?? process.pid;
    this.#platform = opts.platform ?? process.platform;
    this.#lock = new RegistryLock(
      this.lockPath,
      opts.fs,
      opts.clock,
      this.#pid,
      opts.sessionId,
      this.#platform,
    );
    this.#registry = this.emptyRegistry(opts.analysisId ?? ulid(opts.clock()));
  }

  get mode(): "writer" | "read-only" {
    return this.#mode;
  }

  /** A deep copy of the current registry. Mutating it changes nothing. */
  snapshot(): Registry {
    return structuredClone(this.#registry);
  }

  newAttemptId(): AttemptId {
    return ulid(this.#clock());
  }

  /** Take the writer lock (or open read-only), then load what is on disk. */
  open(): LoadOutcome {
    this.#fs.mkdirSync(this.stateDir, { recursive: true });
    const lock = this.#lock.acquire();
    if (lock.mode === "writer") {
      this.#mode = "writer";
      if (lock.tookOverFrom) {
        this.notices.push(
          `Took over a stale registry lock from session ${lock.tookOverFrom.session_id} (pid ${lock.tookOverFrom.pid}).`,
        );
      }
    } else {
      this.#mode = "read-only";
      this.notices.push(
        `Another live session (${lock.holder.session_id}, pid ${lock.holder.pid}) holds the registry; opened read-only.`,
      );
    }
    return this.load();
  }

  /** Re-read the registry file and ingest it. */
  load(): LoadOutcome {
    if (!this.#fs.existsSync(this.registryPath)) return { kind: "empty" };
    let text: string;
    try {
      text = this.#fs.readFileSync(this.registryPath, "utf-8");
    } catch (err) {
      return this.reject(`could not read registry.json: ${(err as Error).message}`, true);
    }
    return this.ingestText(text, true);
  }

  /**
   * Ingest a serialised registry from any source: the file, or a decoded Page
   * carrier. `fromFile` only decides whether a rejected document is moved
   * aside on disk.
   */
  ingestText(text: string, fromFile = false): LoadOutcome {
    if (Buffer.byteLength(text, "utf-8") > MAX_REGISTRY_BYTES) {
      return this.reject(`registry is larger than ${MAX_REGISTRY_BYTES} bytes`, fromFile);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
      assertNoDuplicateKeys(text);
    } catch (err) {
      return this.reject(`registry is not valid JSON: ${(err as Error).message}`, fromFile);
    }

    // Verify against exactly what was signed, before parsing drops anything.
    if (this.verifies(raw)) {
      let own: Registry;
      try {
        own = parseRegistry(raw);
      } catch (err) {
        return this.reject(`own registry failed validation: ${(err as Error).message}`, fromFile);
      }
      // Equal counts as stale when what we hold came from an import: the
      // import carried the revision forward, so an own copy at that number
      // predates it.
      const current = this.#registry.revision;
      if (own.revision < current || (own.revision === current && !this.#ownState && current > 0)) {
        this.notices.push(
          `Ignored an older copy of this session's registry (revision ${own.revision}, current ${this.#registry.revision}).`,
        );
        return { kind: "stale", revision: own.revision, current: this.#registry.revision };
      }
      this.#registry = this.withDerived(own);
      this.#ownState = true;
      return { kind: "own", revision: own.revision };
    }

    // Replacing this session's own state with a foreign document would let
    // whoever wrote it wipe live approvals (agy's carrier-wipe). How a foreign
    // Page carrier merges into live state is the pull-merge rule's job; until
    // then it is refused. A read-only session has no state of its own, but
    // what it holds is what the writer wrote, and a carrier mustn't replace
    // that either: only the file, which is the writer's, may.
    if ((this.#ownState && this.#mode === "writer") || (!fromFile && this.#mode !== "writer")) {
      const reason =
        this.#mode === "writer"
          ? "a registry this session did not write arrived while it holds its own"
          : "a carrier can't replace the registry in a read-only session";
      this.notices.push(`Ignored ${reason}.`);
      return { kind: "ignored", reason };
    }

    let imported: Registry;
    try {
      imported = parseRegistry(migrateToCurrent(raw));
    } catch (err) {
      return this.reject((err as Error).message, fromFile);
    }
    // Leave room to keep counting: a document at the ceiling would make every
    // later write fail validation.
    if (imported.revision > MAX_REGISTRY_REVISION - REVISION_HEADROOM) {
      return this.reject("revision too close to the ceiling to keep writing", fromFile);
    }
    const { registry, quarantined } = applyImportRule(imported, this.serverUrl);
    // Keep revisions monotonic across the import, so an older own copy that
    // turns up later still reads as stale.
    registry.revision = Math.max(imported.revision, this.#registry.revision);
    this.#registry = this.withDerived(registry);
    this.notices.push(
      `Imported a registry this session did not write: approvals and exceptions are restored, not live; checks, provenance and evaluations must be re-established.` +
        (quarantined.length > 0
          ? ` ${quarantined.length} attempt(s) from another Galaxy server were quarantined.`
          : ""),
    );
    this.#ownState = false;
    if (this.#mode === "writer") {
      try {
        this.persist();
      } catch (err) {
        // Fenced mid-import: `becomeFenced()` already reloaded read-only.
        if (!(err instanceof RegistryFencedError)) throw err;
      }
    }
    return { kind: "imported", revision: this.#registry.revision, quarantined };
  }

  /**
   * The one way to change the registry. `mutate` edits a draft; the result is
   * validated, its derived fields recomputed, its revision bumped, signed, and
   * written atomically -- or nothing changes.
   */
  update(mutate: (draft: Registry) => void): Registry {
    this.assertWriter();
    const draft = structuredClone(this.#registry);
    mutate(draft);
    let next: Registry;
    try {
      next = parseRegistry({ ...draft, version: CURRENT_REGISTRY_VERSION });
    } catch (err) {
      throw new RegistryFormatError(`refusing to write: ${(err as Error).message}`);
    }
    for (const a of Object.values(next.attempts)) {
      if (normalizeServerUrl(a.server_url) !== this.serverUrl) {
        throw new RegistryFormatError(
          `refusing to write: attempt ${a.attempt_id} is for ${a.server_url}, not ${this.serverUrl}`,
        );
      }
    }
    next.server_url = this.serverUrl;
    next.analysis_id = this.#registry.analysis_id;
    // Revision, token and signature belong to persist(), not to the caller.
    next.revision = this.#registry.revision;
    const previous = this.#registry;
    this.#registry = this.withDerived(next);
    try {
      this.persist();
    } catch (err) {
      // A fence already reloaded the new writer's state; don't paper over it.
      if (!(err instanceof RegistryFencedError)) this.#registry = previous;
      throw err;
    }
    return this.snapshot();
  }

  /**
   * Freeze a template or definition body under `templates/<digest>.json`.
   * Content-addressed and write-once: the file's bytes are the canonical JSON
   * whose sha256 is its name, and an existing file is never rewritten.
   */
  putTemplate(body: unknown): string {
    this.assertWriter();
    const text = canonicalJson(body);
    const digest = sha256Hex(text);
    const file = path.join(this.templatesDir, `${digest}.json`);
    if (this.#fs.existsSync(file)) {
      if (sha256Hex(this.#fs.readFileSync(file, "utf-8")) !== digest) {
        throw new RegistryFormatError(`template ${digest} on disk does not match its name`);
      }
      return digest;
    }
    this.#fs.mkdirSync(this.templatesDir, { recursive: true });
    this.writeAtomic(file, text);
    return digest;
  }

  /** A frozen template by digest, or undefined if missing or altered. */
  getTemplate(digest: string): unknown {
    if (!DIGEST_RE.test(digest)) return undefined;
    const file = path.join(this.templatesDir, `${digest}.json`);
    if (!this.#fs.existsSync(file)) return undefined;
    const text = this.#fs.readFileSync(file, "utf-8");
    if (sha256Hex(text) !== digest) {
      this.notices.push(`Template ${digest} was altered on disk and is being ignored.`);
      return undefined;
    }
    return JSON.parse(text);
  }

  /** Refresh the lock heartbeat; drops to read-only if the lock was taken. */
  heartbeat(): boolean {
    if (this.#mode !== "writer") return false;
    if (this.#lock.heartbeat()) return true;
    this.becomeFenced();
    return false;
  }

  close(): void {
    this.#lock.release();
    this.#mode = "read-only";
  }

  // ───────────────────────────────────────────────────────────────────────────

  private emptyRegistry(analysisId: string): Registry {
    return {
      version: CURRENT_REGISTRY_VERSION,
      revision: 0,
      writer_token: "",
      session_sig: "",
      analysis_id: analysisId,
      server_url: this.serverUrl,
      attempts: {},
      exceptions: [],
      supervision: { active_at_shutdown: [] },
    };
  }

  private sign(doc: Record<string, unknown>): string {
    const { session_sig: _omit, ...rest } = doc;
    return createHmac("sha256", this.#sessionKey)
      .update(canonicalJson(rest), "utf-8")
      .digest("hex");
  }

  private verifies(raw: unknown): boolean {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const doc = raw as Record<string, unknown>;
    if (typeof doc.session_sig !== "string" || !/^[0-9a-f]{64}$/.test(doc.session_sig)) {
      return false;
    }
    let expected: string;
    try {
      expected = this.sign(doc);
    } catch {
      return false;
    }
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(doc.session_sig, "hex"));
  }

  private withDerived(reg: Registry): Registry {
    for (const a of Object.values(reg.attempts)) {
      a.handoff_eligible = computeHandoffEligible(a, reg.exceptions);
    }
    for (const a of Object.values(reg.quarantine ?? {})) a.handoff_eligible = false;
    return reg;
  }

  private assertWriter(): void {
    if (this.#mode !== "writer") {
      throw new RegistryReadOnlyError("registry is open read-only in this session");
    }
    if (!this.#lock.stillHeld()) throw this.becomeFenced();
  }

  /** Drop to read-only after losing the lock; the caller decides whether to throw. */
  private becomeFenced(): RegistryFencedError {
    const holder = this.#lock.read();
    this.#lock.relinquish();
    this.#mode = "read-only";
    this.#ownState = false;
    const err = new RegistryFencedError(holder);
    this.notices.push(err.message);
    // Reload what the new writer has, read-only. Its signature isn't ours, so
    // this is an import like any other.
    this.load();
    return err;
  }

  private persist(): void {
    const token = this.#lock.heldToken;
    if (token === null || !this.#lock.stillHeld()) throw this.becomeFenced();
    const reg = this.#registry;
    reg.revision += 1;
    reg.writer_token = token as string;
    reg.session_sig = "";
    reg.session_sig = this.sign(reg as unknown as Record<string, unknown>);
    this.writeAtomic(this.registryPath, `${canonicalJson(reg)}\n`);
    this.#ownState = true;
  }

  private writeAtomic(file: string, text: string): void {
    const tmp = `${file}.${this.#pid}.${randomHex(6)}.tmp`;
    this.#fs.writeFileSync(tmp, text, { flag: "wx" });
    renameReplacing(this.#fs, tmp, file, this.#platform);
  }

  private reject(reason: string, fromFile: boolean): LoadOutcome {
    this.notices.push(
      (this.#ownState && this.#mode === "writer") || !fromFile
        ? `Registry ${fromFile ? "file" : "carrier"} rejected (${reason}); keeping what this session holds.`
        : `Registry rejected (${reason}); starting with an empty registry.`,
    );
    if (fromFile && this.#mode === "writer" && this.#fs.existsSync(this.registryPath)) {
      // Keep the evidence; the next write would otherwise overwrite it.
      const aside = `${this.registryPath}.rejected-${this.#clock()}`;
      try {
        this.#fs.renameSync(this.registryPath, aside);
      } catch {
        // leave it; the next write replaces it
      }
    }
    if ((this.#ownState && this.#mode === "writer") || !fromFile) {
      // The file was damaged under us, or a carrier didn't parse: what we hold
      // stays. A rejected carrier must never be a way to clear the registry.
      return { kind: "rejected", reason };
    }
    const empty = this.emptyRegistry(this.#registry.analysis_id);
    // Never let a rejection reset the revision: that would re-open replay.
    empty.revision = this.#registry.revision;
    this.#registry = empty;
    this.#ownState = false;
    return { kind: "rejected", reason };
  }
}
