/**
 * Galaxy API helper for authenticated calls from the extension process.
 *
 * Uses the same env-var pattern as the rest of the extension (GALAXY_URL, GALAXY_API_KEY).
 * Provides typed wrappers for the specific endpoints used by workflow integration tools.
 */

import type { WorkflowStructure } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Galaxy API response types
// ─────────────────────────────────────────────────────────────────────────────

export interface GalaxyWorkflowStep {
  id: string;
  type: string;
  tool_id: string | null;
  label?: string;
  annotation?: string;
  input_connections: Record<string, unknown>;
  workflow_outputs?: Array<{ label?: string; output_name: string }>;
}

export interface GalaxyWorkflowResponse {
  id: string;
  name: string;
  annotation?: string;
  version: number;
  steps: Record<string, GalaxyWorkflowStep>;
}

export interface GalaxyInvocationStepJob {
  id: string;
  state: string;
  tool_id: string;
}

export interface GalaxyInvocationStep {
  id: string;
  order_index: number;
  state: string | null;
  jobs: GalaxyInvocationStepJob[];
}

export interface GalaxyInvocationResponse {
  id: string;
  state: string;
  workflow_id: string;
  history_id: string;
  steps: GalaxyInvocationStep[];
}

/**
 * Subset of GET /api/jobs/{jobId} we actually read.
 * tool_version lives at the top level per Galaxy's Job.to_dict().
 */
export interface GalaxyJobDetailsResponse {
  id: string;
  state: string;
  tool_id: string;
  tool_version: string;
  params?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export interface GalaxyConfig {
  url: string;
  apiKey: string;
}

export function getGalaxyConfig(): GalaxyConfig | null {
  const url = process.env.GALAXY_URL;
  const apiKey = process.env.GALAXY_API_KEY;
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/+$/, ''), apiKey };
}

// ─────────────────────────────────────────────────────────────────────────────
// Authenticated fetch
// ─────────────────────────────────────────────────────────────────────────────

export async function galaxyGet<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
  const config = getGalaxyConfig();
  if (!config) throw new Error("Galaxy credentials not configured (GALAXY_URL, GALAXY_API_KEY)");

  const url = `${config.url}/api${path}`;
  const resp = await fetch(url, {
    headers: { 'x-api-key': config.apiKey },
    signal,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Galaxy API ${resp.status}: ${body || resp.statusText}`);
  }

  return resp.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow structure extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a short human-readable name from a Galaxy tool ID.
 * "toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2/2.2.1" → "hisat2"
 * "upload1" → "upload1"
 */
function shortToolName(toolId: string): string {
  const parts = toolId.split('/');
  // Toolshed IDs: .../repos/owner/repo/tool/version → use the tool name (second to last)
  if (parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return toolId;
}

/**
 * Fetch job details from Galaxy. Returns the full response; callers typically
 * only need `tool_version`.
 */
export async function galaxyGetJobDetails(
  jobId: string,
  signal?: AbortSignal,
): Promise<GalaxyJobDetailsResponse> {
  return galaxyGet<GalaxyJobDetailsResponse>(`/jobs/${encodeURIComponent(jobId)}`, signal);
}

export function extractWorkflowStructure(wf: GalaxyWorkflowResponse): WorkflowStructure {
  const steps = Object.values(wf.steps);

  // Input steps have type "data_input", "data_collection_input", or "parameter_input"
  const inputSteps = steps.filter(s =>
    s.type === 'data_input' || s.type === 'data_collection_input' || s.type === 'parameter_input'
  );

  // Tool steps have a non-null tool_id and are not input/pause steps
  const toolSteps = steps.filter(s =>
    s.tool_id && s.type === 'tool'
  );

  // Collect labeled outputs from all steps
  const outputLabels: string[] = [];
  for (const step of steps) {
    if (step.workflow_outputs) {
      for (const wo of step.workflow_outputs) {
        if (wo.label) outputLabels.push(wo.label);
      }
    }
  }

  return {
    name: wf.name,
    annotation: wf.annotation || undefined,
    version: wf.version,
    toolIds: toolSteps.map(s => s.tool_id!),
    toolNames: toolSteps.map(s => shortToolName(s.tool_id!)),
    inputLabels: inputSteps.map(s => s.label || s.annotation || `Input ${s.id}`),
    outputLabels,
    stepCount: steps.length,
  };
}
