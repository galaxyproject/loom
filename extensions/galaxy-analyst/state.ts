/**
 * Plan state management for Galaxy analysis workflows
 *
 * State is kept in memory during the session and persisted
 * via pi.appendEntry() for recovery after compaction.
 *
 * With notebook integration, state can also be persisted to/loaded from
 * markdown notebook files for cross-session persistence.
 */

import type {
  AnalysisPlan,
  AnalysisStep,
  AnalystState,
  DecisionEntry,
  DecisionType,
  QCCheckpoint,
  CheckpointStatus,
  StepStatus,
  StepResult,
  DatasetReference,
  NotebookSummary,
} from "./types";
import {
  generateNotebook,
  writeNotebook,
  readNotebook,
  updateFrontmatter,
  updateStepBlock,
  appendEvent,
  addStepSection,
  appendGalaxyReference,
  listNotebooks,
  getDefaultNotebookPath,
  fileExists,
} from "./notebook-writer";
import { parseNotebook, notebookToPlan } from "./notebook-parser";

// Generate simple UUIDs (avoiding external dependency for now)
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Module-level state
let state: AnalystState = {
  currentPlan: null,
  recentPlanIds: [],
  galaxyConnected: false,
  currentHistoryId: null,
  notebookPath: null,
  notebookLoaded: false,
};

export function getState(): AnalystState {
  return state;
}

export function resetState(): void {
  state = {
    currentPlan: null,
    recentPlanIds: [],
    galaxyConnected: false,
    currentHistoryId: null,
    notebookPath: null,
    notebookLoaded: false,
  };
}

/**
 * Restore state from a persisted plan (after compaction)
 */
export function restorePlan(plan: AnalysisPlan): void {
  state.currentPlan = plan;
  if (plan.galaxy.historyId) {
    state.currentHistoryId = plan.galaxy.historyId;
  }
}

/**
 * Create a new analysis plan
 */
export function createPlan(params: {
  title: string;
  researchQuestion: string;
  dataDescription: string;
  expectedOutcomes: string[];
  constraints: string[];
}): AnalysisPlan {
  const now = new Date().toISOString();

  const plan: AnalysisPlan = {
    id: generateId(),
    title: params.title,
    created: now,
    updated: now,
    status: 'draft',
    context: {
      researchQuestion: params.researchQuestion,
      dataDescription: params.dataDescription,
      expectedOutcomes: params.expectedOutcomes,
      constraints: params.constraints,
    },
    galaxy: {
      historyId: state.currentHistoryId,
      historyName: null,
      serverUrl: null,
    },
    steps: [],
    decisions: [],
    checkpoints: [],
  };

  state.currentPlan = plan;
  state.recentPlanIds = [plan.id, ...state.recentPlanIds.slice(0, 9)];

  return plan;
}

/**
 * Get current plan
 */
export function getCurrentPlan(): AnalysisPlan | null {
  return state.currentPlan;
}

/**
 * Update plan status
 */
export function setPlanStatus(status: AnalysisPlan['status']): void {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }
  state.currentPlan.status = status;
  state.currentPlan.updated = new Date().toISOString();
}

/**
 * Add a step to the current plan
 */
export function addStep(params: {
  name: string;
  description: string;
  executionType: 'tool' | 'workflow' | 'manual';
  toolId?: string;
  workflowId?: string;
  trsId?: string;
  inputs: Array<{ name: string; description: string; fromStep?: string }>;
  expectedOutputs: string[];
  dependsOn: string[];
}): AnalysisStep {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  const stepNumber = state.currentPlan.steps.length + 1;

  const step: AnalysisStep = {
    id: String(stepNumber),
    name: params.name,
    description: params.description,
    status: 'pending',
    execution: {
      type: params.executionType,
      toolId: params.toolId,
      workflowId: params.workflowId,
      trsId: params.trsId,
    },
    inputs: params.inputs.map(i => ({
      name: i.name,
      description: i.description,
      fromStep: i.fromStep,
    })),
    expectedOutputs: params.expectedOutputs,
    actualOutputs: [],
    dependsOn: params.dependsOn,
  };

  state.currentPlan.steps.push(step);
  state.currentPlan.updated = new Date().toISOString();

  return step;
}

/**
 * Update step status
 */
export function updateStepStatus(
  stepId: string,
  status: StepStatus,
  result?: StepResult
): AnalysisStep {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  const step = state.currentPlan.steps.find(s => s.id === stepId);
  if (!step) {
    throw new Error(`Step ${stepId} not found`);
  }

  step.status = status;
  if (result) {
    step.result = result;
  }
  state.currentPlan.updated = new Date().toISOString();

  return step;
}

/**
 * Add outputs to a step
 */
export function addStepOutputs(stepId: string, outputs: DatasetReference[]): void {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  const step = state.currentPlan.steps.find(s => s.id === stepId);
  if (!step) {
    throw new Error(`Step ${stepId} not found`);
  }

  step.actualOutputs.push(...outputs);
  state.currentPlan.updated = new Date().toISOString();
}

/**
 * Log a decision
 */
export function logDecision(params: {
  stepId: string | null;
  type: DecisionType;
  description: string;
  rationale: string;
  researcherApproved: boolean;
}): DecisionEntry {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  const entry: DecisionEntry = {
    timestamp: new Date().toISOString(),
    stepId: params.stepId,
    type: params.type,
    description: params.description,
    rationale: params.rationale,
    researcherApproved: params.researcherApproved,
  };

  state.currentPlan.decisions.push(entry);
  state.currentPlan.updated = new Date().toISOString();

  return entry;
}

/**
 * Create or update a QC checkpoint
 */
export function setCheckpoint(params: {
  stepId: string;
  name: string;
  criteria: string[];
  status: CheckpointStatus;
  observations: string[];
}): QCCheckpoint {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  // Check if checkpoint already exists for this step
  let checkpoint = state.currentPlan.checkpoints.find(
    c => c.stepId === params.stepId && c.name === params.name
  );

  if (checkpoint) {
    // Update existing
    checkpoint.status = params.status;
    checkpoint.observations = params.observations;
    if (params.status !== 'pending') {
      checkpoint.reviewedAt = new Date().toISOString();
    }
  } else {
    // Create new
    checkpoint = {
      id: `qc-${state.currentPlan.checkpoints.length + 1}`,
      stepId: params.stepId,
      name: params.name,
      criteria: params.criteria,
      status: params.status,
      observations: params.observations,
      reviewedAt: params.status !== 'pending' ? new Date().toISOString() : undefined,
    };
    state.currentPlan.checkpoints.push(checkpoint);
  }

  state.currentPlan.updated = new Date().toISOString();
  return checkpoint;
}

/**
 * Update Galaxy connection state
 */
export function setGalaxyConnection(connected: boolean, historyId?: string, serverUrl?: string): void {
  state.galaxyConnected = connected;

  if (historyId) {
    state.currentHistoryId = historyId;
    if (state.currentPlan) {
      state.currentPlan.galaxy.historyId = historyId;
    }
  }

  if (serverUrl && state.currentPlan) {
    state.currentPlan.galaxy.serverUrl = serverUrl;
  }
}

/**
 * Format plan for context injection (compact summary)
 */
export function formatPlanSummary(plan: AnalysisPlan): string {
  const lines: string[] = [];

  // Header
  lines.push(`**${plan.title}** [${plan.status}]`);
  lines.push(`Research: ${plan.context.researchQuestion}`);

  // Galaxy context
  if (plan.galaxy.historyId) {
    lines.push(`History: ${plan.galaxy.historyName || plan.galaxy.historyId}`);
  }

  // Notebook path
  if (state.notebookPath) {
    lines.push(`Notebook: ${state.notebookPath}`);
  }

  // Steps overview
  lines.push('');
  lines.push('**Steps:**');
  for (const step of plan.steps) {
    const icon = {
      'pending': '⬜',
      'in_progress': '🔄',
      'completed': '✅',
      'skipped': '⏭️',
      'failed': '❌',
    }[step.status];
    lines.push(`${icon} ${step.id}. ${step.name}`);
  }

  // Current step details
  const currentStep = plan.steps.find(s => s.status === 'in_progress');
  if (currentStep) {
    lines.push('');
    lines.push(`**Current: ${currentStep.name}**`);
    lines.push(currentStep.description);
  }

  // Recent decisions (last 3)
  if (plan.decisions.length > 0) {
    lines.push('');
    lines.push('**Recent Decisions:**');
    const recent = plan.decisions.slice(-3);
    for (const d of recent) {
      const truncated = d.description.length > 60
        ? d.description.slice(0, 60) + '...'
        : d.description;
      lines.push(`- [${d.type}] ${truncated}`);
    }
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Notebook Integration Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the current notebook path
 */
export function getNotebookPath(): string | null {
  return state.notebookPath;
}

/**
 * Set the notebook path
 */
export function setNotebookPath(path: string | null): void {
  state.notebookPath = path;
  state.notebookLoaded = path !== null;
}

/**
 * Check if notebook is loaded
 */
export function isNotebookLoaded(): boolean {
  return state.notebookLoaded;
}

/**
 * Load a notebook from file and restore state
 */
export async function loadNotebook(filePath: string): Promise<AnalysisPlan | null> {
  try {
    const content = await readNotebook(filePath);
    const parsed = parseNotebook(content);

    if (!parsed) {
      return null;
    }

    const plan = notebookToPlan(parsed);
    state.currentPlan = plan;
    state.notebookPath = filePath;
    state.notebookLoaded = true;

    // Sync Galaxy state
    if (plan.galaxy.historyId) {
      state.currentHistoryId = plan.galaxy.historyId;
    }

    return plan;
  } catch (error) {
    console.error("Failed to load notebook:", error);
    return null;
  }
}

/**
 * Create a new notebook file from current plan
 */
export async function createNotebook(
  filePath: string,
  plan?: AnalysisPlan
): Promise<string> {
  const targetPlan = plan || state.currentPlan;
  if (!targetPlan) {
    throw new Error("No plan to save");
  }

  const content = generateNotebook(targetPlan);
  await writeNotebook(filePath, content);

  state.notebookPath = filePath;
  state.notebookLoaded = true;

  return filePath;
}

/**
 * Save current plan to notebook file
 */
export async function saveNotebook(): Promise<void> {
  if (!state.notebookPath || !state.currentPlan) {
    return;
  }

  const content = generateNotebook(state.currentPlan);
  await writeNotebook(state.notebookPath, content);
}

/**
 * Sync a specific change to the notebook file
 * This is more efficient than regenerating the entire notebook
 */
export async function syncToNotebook(
  changeType: 'frontmatter' | 'step_added' | 'step_updated' | 'decision' | 'checkpoint' | 'galaxy_ref',
  data: Record<string, unknown>
): Promise<void> {
  if (!state.notebookPath) {
    return;
  }

  try {
    let content = await readNotebook(state.notebookPath);

    switch (changeType) {
      case 'frontmatter':
        for (const [field, value] of Object.entries(data)) {
          content = updateFrontmatter(content, field, String(value));
        }
        break;

      case 'step_added':
        if (data.step) {
          content = addStepSection(content, data.step as AnalysisStep);
        }
        break;

      case 'step_updated':
        if (data.stepId) {
          content = updateStepBlock(content, String(data.stepId), {
            status: data.status as string | undefined,
            jobId: data.jobId as string | undefined,
            invocationId: data.invocationId as string | undefined,
            outputs: data.outputs as DatasetReference[] | undefined,
          });
        }
        break;

      case 'decision':
        content = appendEvent(content, {
          type: 'decision',
          timestamp: String(data.timestamp || new Date().toISOString()),
          data: {
            step_id: data.stepId,
            type: data.type,
            description: data.description,
            rationale: data.rationale,
            researcher_approved: data.researcherApproved,
          },
        });
        break;

      case 'checkpoint':
        content = appendEvent(content, {
          type: 'checkpoint',
          timestamp: String(data.reviewedAt || new Date().toISOString()),
          data: {
            id: data.id,
            step_id: data.stepId,
            name: data.name,
            status: data.status,
            criteria: data.criteria,
            observations: data.observations,
          },
        });
        break;

      case 'galaxy_ref':
        content = appendGalaxyReference(content, {
          resource: String(data.resource),
          id: String(data.id),
          url: String(data.url),
        });
        break;
    }

    await writeNotebook(state.notebookPath, content);
  } catch (error) {
    console.error("Failed to sync to notebook:", error);
  }
}

/**
 * Find notebooks in a directory
 */
export async function findNotebooks(directory: string): Promise<NotebookSummary[]> {
  const paths = await listNotebooks(directory);
  const summaries: NotebookSummary[] = [];

  for (const filePath of paths) {
    try {
      const content = await readNotebook(filePath);
      const parsed = parseNotebook(content);

      if (parsed) {
        summaries.push({
          path: filePath,
          title: parsed.frontmatter.title,
          status: parsed.frontmatter.status,
          stepCount: parsed.steps.length,
          completedSteps: parsed.steps.filter(s => s.status === 'completed').length,
          lastUpdated: parsed.frontmatter.updated,
        });
      }
    } catch {
      // Skip files that can't be parsed
    }
  }

  return summaries;
}

/**
 * Generate default notebook path for a plan
 */
export function getDefaultPath(title: string, directory: string): string {
  return getDefaultNotebookPath(title, directory);
}

/**
 * Check if a notebook file exists
 */
export async function notebookExists(filePath: string): Promise<boolean> {
  return await fileExists(filePath);
}
