import { net } from "electron";
import {
  FEEDBACK_ROUTE,
  FEEDBACK_ENDPOINT_URL,
  FEEDBACK_KEY_HEADER,
} from "../../../shared/feedback-contract.js";
import type { FeedbackPayload } from "../../../shared/feedback-contract.js";

// Endpoint is resolved in main (like the GitHub/releases URLs) so a compromised
// renderer can't redirect it. LOOM_FEEDBACK_URL overrides the base for local dev.
const ENDPOINT = (process.env.LOOM_FEEDBACK_URL || FEEDBACK_ENDPOINT_URL) + FEEDBACK_ROUTE;
const TIMEOUT_MS = 10_000;

export interface FeedbackResult {
  ok: boolean;
  status?: number;
  id?: string;
  error?: string;
}

export async function postFeedback(payload: FeedbackPayload): Promise<FeedbackResult> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.LOOM_FEEDBACK_KEY) headers[FEEDBACK_KEY_HEADER] = process.env.LOOM_FEEDBACK_KEY;
    const res = await net.fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    return { ok: res.ok, status: res.status, id: data.id, error: data.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
