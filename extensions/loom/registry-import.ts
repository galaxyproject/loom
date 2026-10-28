/**
 * The import rule (registry design v3 §10), applied to every registry this
 * session did not sign: a file from an earlier session or a clean clone, a
 * carrier another session wrote, or something hand-made.
 *
 * Consent is session-scoped, so nothing that arrives from outside the session
 * keeps any authority it claims. Approvals and exceptions become `restored`,
 * submission checks become `unchecked`, provenance and evaluations become
 * `historical`, and Galaxy's confirmation of the run is forgotten until
 * reconcile asks again. Attempts recorded against another server are moved to
 * `quarantine`. The result can then be re-established in-session, never
 * inherited.
 *
 * Pure: takes a parsed registry, returns a new one.
 */

import {
  normalizeServerUrl,
  type Attempt,
  type AttemptId,
  type Exception,
  type Registry,
} from "./registry-schema";

export interface ImportResult {
  registry: Registry;
  quarantined: AttemptId[];
}

function downgradeAttempt(a: Attempt): Attempt {
  const out: Attempt = structuredClone(a);
  if (out.approval) {
    // `revoked` is already ineligible and says more than `restored` does.
    if (out.approval.status !== "revoked") out.approval.status = "restored";
    out.approval.by = "restored";
  }
  if (out.submission) {
    out.submission.check = { outcome: "unchecked", mode: out.submission.check.mode };
    out.submission.server_verified = false;
  }
  if (out.provenance) out.provenance.authority = "historical";
  if (out.evaluation) out.evaluation.authority = "historical";
  out.handoff_eligible = false;
  return out;
}

function downgradeException(x: Exception): Exception {
  return { ...x, by: "restored" };
}

/**
 * Downgrade `imported` for use by a session talking to `serverUrl`. The caller
 * owns revision, writer token and signature; this only touches content.
 */
export function applyImportRule(
  imported: Registry,
  serverUrl: string,
  serverUrls: readonly string[] = [serverUrl],
): ImportResult {
  const ours = normalizeServerUrl(serverUrl);
  const allowed = new Set(serverUrls.map(normalizeServerUrl));
  const attempts: Record<AttemptId, Attempt> = {};
  const quarantine: Record<AttemptId, Attempt> = {};
  const quarantined: AttemptId[] = [];

  const place = (a: Attempt) => {
    const downgraded = downgradeAttempt(a);
    const specServer = a.approval?.spec_snapshot.server_url;
    const sameServer =
      allowed.has(normalizeServerUrl(a.server_url)) &&
      (specServer === undefined ||
        normalizeServerUrl(specServer) === normalizeServerUrl(a.server_url));
    if (sameServer) {
      attempts[a.attempt_id] = downgraded;
    } else {
      quarantine[a.attempt_id] = downgraded;
      quarantined.push(a.attempt_id);
    }
  };
  for (const a of Object.values(imported.attempts)) place(a);
  // Already-quarantined attempts stay there even if the server now matches: a
  // quarantine is lifted by a deliberate act, not by switching profiles.
  for (const a of Object.values(imported.quarantine ?? {})) {
    quarantine[a.attempt_id] = downgradeAttempt(a);
  }

  const registry: Registry = {
    ...imported,
    server_url: ours,
    attempts,
    exceptions: imported.exceptions.map(downgradeException),
    supervision: structuredClone(imported.supervision),
  };
  if (Object.keys(quarantine).length > 0) registry.quarantine = quarantine;
  else delete registry.quarantine;
  return { registry, quarantined };
}
