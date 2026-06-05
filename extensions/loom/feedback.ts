import {
  FEEDBACK_ROUTE,
  FEEDBACK_ENDPOINT_URL,
  FEEDBACK_KEY_HEADER,
  SCHEMA_VERSION,
} from "../../shared/feedback-contract.js";
import type { FeedbackPayload, FeedbackSysinfo } from "../../shared/feedback-contract.js";
import { loadConfig, getConfigDir } from "./config.js";
import { loadProfiles } from "./profiles.js";
import { appendFileSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Endpoint base is the shared constant; LOOM_FEEDBACK_URL overrides it for local
// dev (point at http://localhost:8787 while running `wrangler dev`).
const ENDPOINT = (process.env.LOOM_FEEDBACK_URL || FEEDBACK_ENDPOINT_URL) + FEEDBACK_ROUTE;
const TIMEOUT_MS = 10_000;

export interface FeedbackResult {
  ok: boolean;
  status?: number;
  id?: string;
  error?: string;
}

/**
 * Best-effort read of the Loom package version so loom-cli rows carry a build for
 * triage. Resolves the repo-root package.json the same way the brain resolves
 * ../../shared at runtime. Returns undefined if it can't be read (safe fallback).
 */
export function readLoomVersion(): string | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "../../package.json"), "utf-8")) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/** Brain-side sysinfo. No Electron here (the brain is a Node child), no secrets. */
export function buildBrainSysinfo(): FeedbackSysinfo {
  const cfg = loadConfig() as {
    llm?: { active?: string; providers?: Record<string, { model?: string }> };
  };
  const active = cfg.llm?.active;
  return {
    appVersion: readLoomVersion(),
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    llmProvider: active,
    llmModel: active ? cfg.llm?.providers?.[active]?.model : undefined,
    galaxyConfigured: Boolean(loadProfiles().active),
  };
}

export async function submitFeedback(payload: FeedbackPayload): Promise<FeedbackResult> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.LOOM_FEEDBACK_KEY) headers[FEEDBACK_KEY_HEADER] = process.env.LOOM_FEEDBACK_KEY;
    const res = await fetch(ENDPOINT, {
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

/**
 * Durability backstop: when a POST fails, append the payload to a local outbox so
 * the feedback isn't lost. Returns the outbox path on success, null on failure.
 */
export function appendToOutbox(payload: FeedbackPayload): string | null {
  try {
    const outbox = join(getConfigDir(), "feedback-outbox.jsonl");
    appendFileSync(outbox, JSON.stringify(payload) + "\n", "utf-8");
    return outbox;
  } catch {
    return null;
  }
}

export const FEEDBACK_SCHEMA_VERSION = SCHEMA_VERSION;
