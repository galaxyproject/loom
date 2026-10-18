/** Signed registry state for an explicitly approved cross-instance rerun. */
export const REROUTE_PHASES = [
  "prepared",
  "staging",
  "ready",
  "cancelling",
  "submitting",
  "submission_unknown",
  "submitted",
  "failed",
  "cancelled",
] as const;
export interface RerouteState {
  id: string;
  source_attempt: string;
  destination_attempt: string;
  source_connection: string;
  destination_connection: string;
  source_account: string;
  destination_account: string;
  source_kind: "job" | "invocation";
  source_id: string;
  plan_digest: string;
  phase: (typeof REROUTE_PHASES)[number];
  created_at: string;
  updated_at: string;
  history_id?: string;
  approved_at?: string;
  allow_overlap?: boolean;
  dispatch_digest?: string;
  receipt?: { invocation_id?: string; job_ids?: string[] };
  error?: string;
  /** Verified dataset/collection mapping. Source IDs are scoped by source_connection. */
  mapping: Record<string, { id: string; src: "hda" | "hdca"; sha256?: string }>;
}

export function parseRerouteState(raw: unknown): RerouteState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid reroute state.");
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [
    "id",
    "source_attempt",
    "destination_attempt",
    "source_connection",
    "destination_connection",
    "source_account",
    "destination_account",
    "source_id",
    "plan_digest",
    "created_at",
    "updated_at",
  ]) {
    if (typeof obj[key] !== "string" || !obj[key] || /[\u0000-\u001f]/.test(obj[key] as string))
      throw new Error(`Invalid reroute ${key}.`);
    out[key] = obj[key];
  }
  if (!/^[a-f0-9]{64}$/.test(obj.plan_digest as string))
    throw new Error("Invalid reroute plan digest.");
  if (!["job", "invocation"].includes(obj.source_kind as string))
    throw new Error("Invalid reroute kind.");
  if (!(REROUTE_PHASES as readonly unknown[]).includes(obj.phase))
    throw new Error("Invalid reroute phase.");
  out.source_kind = obj.source_kind;
  out.phase = obj.phase;
  for (const key of ["history_id", "error", "approved_at"]) {
    if (obj[key] !== undefined) {
      if (typeof obj[key] !== "string") throw new Error(`Invalid reroute ${key}.`);
      out[key] = (obj[key] as string).slice(0, 2000);
    }
  }
  if (obj.allow_overlap !== undefined) {
    if (typeof obj.allow_overlap !== "boolean") throw new Error("Invalid overlap choice.");
    out.allow_overlap = obj.allow_overlap;
  }
  if (obj.dispatch_digest !== undefined) {
    if (typeof obj.dispatch_digest !== "string" || !/^[a-f0-9]{64}$/.test(obj.dispatch_digest))
      throw new Error("Invalid dispatch digest.");
    out.dispatch_digest = obj.dispatch_digest;
  }
  if (obj.receipt !== undefined) {
    const r = obj.receipt as RerouteState["receipt"];
    if (
      !r ||
      typeof r !== "object" ||
      (typeof r.invocation_id !== "string" &&
        !(
          Array.isArray(r.job_ids) &&
          r.job_ids.length &&
          r.job_ids.every((id) => typeof id === "string")
        ))
    )
      throw new Error("Invalid receipt.");
    out.receipt = r.invocation_id ? { invocation_id: r.invocation_id } : { job_ids: r.job_ids };
  }
  if (!obj.mapping || typeof obj.mapping !== "object" || Array.isArray(obj.mapping))
    throw new Error("Invalid reroute mapping.");
  out.mapping = Object.fromEntries(
    Object.entries(obj.mapping).map(([key, value]) => {
      if (!value || typeof value !== "object") throw new Error("Invalid mapped input.");
      const item = value as Record<string, unknown>;
      if (typeof item.id !== "string" || !["hda", "hdca"].includes(item.src as string))
        throw new Error("Invalid mapped input.");
      if (
        item.sha256 !== undefined &&
        (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256))
      )
        throw new Error("Invalid input checksum.");
      return [key, { id: item.id, src: item.src, ...(item.sha256 ? { sha256: item.sha256 } : {}) }];
    }),
  );
  return out as unknown as RerouteState;
}
