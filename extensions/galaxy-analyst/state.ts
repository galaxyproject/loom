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
  BRCContext,
  DecisionEntry,
  DecisionType,
  QCCheckpoint,
  CheckpointStatus,
  StepStatus,
  StepResult,
  DatasetReference,
  NotebookSummary,
  LifecyclePhase,
  ResearchQuestion,
  LiteratureReference,
  DataProvenance,
  SampleInfo,
  DataFile,
  PublicationMaterials,
  FigureSpec,
  MethodsSection,
  ToolVersionInfo,
  BiologicalFinding,
  InterpretationFindings,
  WorkflowStructure,
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
import { commitNotebook, buildCommitMessage, COMMIT_CHANGE_TYPES } from "./git";

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

// Plan change listeners for the UI bridge
type PlanChangeListener = (plan: AnalysisPlan | null) => void;
const planChangeListeners: PlanChangeListener[] = [];

/** Register a callback that fires on every plan mutation. Returns unsubscribe function. */
export function onPlanChange(listener: PlanChangeListener): () => void {
  planChangeListeners.push(listener);
  return () => {
    const idx = planChangeListeners.indexOf(listener);
    if (idx >= 0) planChangeListeners.splice(idx, 1);
  };
}

function notifyPlanChange(): void {
  for (const listener of planChangeListeners) {
    listener(state.currentPlan);
  }
}

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
  notifyPlanChange();
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
  phase?: LifecyclePhase;
}): AnalysisPlan {
  const now = new Date().toISOString();

  const plan: AnalysisPlan = {
    id: generateId(),
    title: params.title,
    created: now,
    updated: now,
    status: 'draft',
    phase: params.phase || 'problem_definition',
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
  notifyPlanChange();

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
  notifyPlanChange();
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
  notifyPlanChange();

  return step;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow Integration State Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a workflow step to the plan, populated from WorkflowStructure metadata.
 */
export function addWorkflowStep(params: {
  name?: string;
  description?: string;
  workflowId: string;
  trsId?: string;
  workflowStructure: WorkflowStructure;
  dependsOn?: string[];
}): AnalysisStep {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  const ws = params.workflowStructure;
  const stepNumber = state.currentPlan.steps.length + 1;

  const step: AnalysisStep = {
    id: String(stepNumber),
    name: params.name || ws.name,
    description: params.description || ws.annotation || `Run workflow: ${ws.name}`,
    status: 'pending',
    execution: {
      type: 'workflow',
      workflowId: params.workflowId,
      trsId: params.trsId,
    },
    inputs: ws.inputLabels.map(label => ({
      name: label,
      description: `Workflow input: ${label}`,
    })),
    expectedOutputs: ws.outputLabels.length > 0 ? ws.outputLabels : [`Workflow outputs from ${ws.name}`],
    actualOutputs: [],
    workflowStructure: ws,
    dependsOn: params.dependsOn || [],
  };

  state.currentPlan.steps.push(step);
  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();

  return step;
}

/**
 * Link a Galaxy invocation to a workflow step, marking it in-progress.
 */
export function linkInvocation(stepId: string, invocationId: string): AnalysisStep {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  const step = state.currentPlan.steps.find(s => s.id === stepId);
  if (!step) {
    throw new Error(`Step ${stepId} not found`);
  }

  step.status = 'in_progress';
  step.result = {
    completedAt: '',
    invocationId,
    summary: '',
    qcPassed: null,
  };
  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();

  return step;
}

/**
 * Get all in-progress workflow steps that have linked invocations.
 */
export function getWorkflowSteps(): AnalysisStep[] {
  if (!state.currentPlan) return [];

  return state.currentPlan.steps.filter(s =>
    s.execution.type === 'workflow' &&
    s.status === 'in_progress' &&
    s.result?.invocationId
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BRC Catalog Context State Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set the BRC organism on the active plan
 */
export function setBRCOrganism(organism: BRCContext['organism']): void {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }
  if (!state.currentPlan.brcContext) {
    state.currentPlan.brcContext = {};
  }
  state.currentPlan.brcContext.organism = organism;
  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();
}

/**
 * Set the BRC assembly on the active plan
 */
export function setBRCAssembly(assembly: BRCContext['assembly']): void {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }
  if (!state.currentPlan.brcContext) {
    state.currentPlan.brcContext = {};
  }
  state.currentPlan.brcContext.assembly = assembly;
  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();
}

/**
 * Set the BRC workflow selection on the active plan
 */
export function setBRCWorkflow(params: { category: string; iwcId: string; name: string }): void {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }
  if (!state.currentPlan.brcContext) {
    state.currentPlan.brcContext = {};
  }
  state.currentPlan.brcContext.analysisCategory = params.category;
  state.currentPlan.brcContext.workflowIwcId = params.iwcId;
  state.currentPlan.brcContext.workflowName = params.name;
  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();
}

/**
 * Get the current BRC context from the active plan
 */
export function getBRCContext(): BRCContext | null {
  return state.currentPlan?.brcContext || null;
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
  notifyPlanChange();

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
  notifyPlanChange();
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
  notifyPlanChange();

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
  notifyPlanChange();
  return checkpoint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase Management Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set the current lifecycle phase
 */
export function setPhase(phase: LifecyclePhase): void {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }
  state.currentPlan.phase = phase;
  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();
}

/**
 * Get the current lifecycle phase
 */
export function getPhase(): LifecyclePhase | null {
  return state.currentPlan?.phase || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Research Question Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set or update the structured research question
 */
export function setResearchQuestion(question: Partial<ResearchQuestion>): ResearchQuestion {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  const now = new Date().toISOString();
  const existing = state.currentPlan.researchQuestion;

  state.currentPlan.researchQuestion = {
    rawQuestion: question.rawQuestion || existing?.rawQuestion || state.currentPlan.context.researchQuestion,
    hypothesis: question.hypothesis || existing?.hypothesis,
    pico: question.pico || existing?.pico,
    literatureRefs: question.literatureRefs || existing?.literatureRefs || [],
    refinedAt: question.hypothesis ? now : existing?.refinedAt,
  };

  state.currentPlan.updated = now;
  notifyPlanChange();
  return state.currentPlan.researchQuestion;
}

/**
 * Add a literature reference
 */
export function addLiteratureRef(ref: Omit<LiteratureReference, 'addedAt'>): LiteratureReference {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  if (!state.currentPlan.researchQuestion) {
    state.currentPlan.researchQuestion = {
      rawQuestion: state.currentPlan.context.researchQuestion,
      literatureRefs: [],
    };
  }

  const literatureRef: LiteratureReference = {
    ...ref,
    addedAt: new Date().toISOString(),
  };

  state.currentPlan.researchQuestion.literatureRefs.push(literatureRef);
  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();

  return literatureRef;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Data Provenance Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize or update data provenance
 */
export function setDataProvenance(provenance: Partial<DataProvenance>): DataProvenance {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  const existing = state.currentPlan.dataProvenance;

  state.currentPlan.dataProvenance = {
    source: provenance.source || existing?.source || 'local',
    accession: provenance.accession || existing?.accession,
    downloadDate: provenance.downloadDate || existing?.downloadDate,
    samples: provenance.samples || existing?.samples || [],
    originalFiles: provenance.originalFiles || existing?.originalFiles || [],
    samplesheet: provenance.samplesheet || existing?.samplesheet,
    importHistory: provenance.importHistory || existing?.importHistory,
  };

  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();
  return state.currentPlan.dataProvenance;
}

/**
 * Add a sample to data provenance
 */
export function addSample(sample: SampleInfo): void {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  if (!state.currentPlan.dataProvenance) {
    state.currentPlan.dataProvenance = {
      source: 'local',
      samples: [],
      originalFiles: [],
    };
  }

  state.currentPlan.dataProvenance.samples.push(sample);
  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();
}

/**
 * Add a data file to provenance
 */
export function addDataFile(file: DataFile): void {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  if (!state.currentPlan.dataProvenance) {
    state.currentPlan.dataProvenance = {
      source: 'local',
      samples: [],
      originalFiles: [],
    };
  }

  state.currentPlan.dataProvenance.originalFiles.push(file);
  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();
}

/**
 * Update a data file (e.g., add Galaxy dataset ID after import)
 */
export function updateDataFile(fileId: string, updates: Partial<DataFile>): DataFile | null {
  if (!state.currentPlan?.dataProvenance) {
    return null;
  }

  const file = state.currentPlan.dataProvenance.originalFiles.find(f => f.id === fileId);
  if (!file) {
    return null;
  }

  Object.assign(file, updates);
  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();
  return file;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: Interpretation Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a biological finding
 */
export function addFinding(finding: Omit<BiologicalFinding, 'id' | 'addedAt'>): BiologicalFinding {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  if (!state.currentPlan.interpretation) {
    state.currentPlan.interpretation = { findings: [] };
  }

  const fullFinding: BiologicalFinding = {
    ...finding,
    id: `finding-${state.currentPlan.interpretation.findings.length + 1}`,
    addedAt: new Date().toISOString(),
  };

  state.currentPlan.interpretation.findings.push(fullFinding);
  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();

  return fullFinding;
}

/**
 * Set overall interpretation summary
 */
export function setInterpretationSummary(summary: string): void {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  if (!state.currentPlan.interpretation) {
    state.currentPlan.interpretation = { findings: [] };
  }

  state.currentPlan.interpretation.summary = summary;
  state.currentPlan.interpretation.summarizedAt = new Date().toISOString();
  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();
}

/**
 * Get current findings
 */
export function getFindings(): BiologicalFinding[] {
  return state.currentPlan?.interpretation?.findings || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: Publication Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize publication materials
 */
export function initPublication(targetJournal?: string): PublicationMaterials {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  state.currentPlan.publication = {
    targetJournal,
    figures: [],
    supplementaryData: [],
    status: 'not_started',
  };

  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();
  return state.currentPlan.publication;
}

/**
 * Generate methods section from plan execution
 */
export function generateMethods(): MethodsSection {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  const now = new Date().toISOString();

  // Extract tool versions from completed steps
  const toolVersions: ToolVersionInfo[] = state.currentPlan.steps
    .filter(s => s.status === 'completed' && s.execution.toolId)
    .map(s => ({
      toolId: s.execution.toolId!,
      toolName: s.name,
      version: 'version_to_be_fetched', // Will be updated by tool call
      stepId: s.id,
      parameters: s.execution.parameters,
    }));

  // Generate methods text
  const lines: string[] = [];
  lines.push(`Analysis was performed using Galaxy (${state.currentPlan.galaxy.serverUrl || 'usegalaxy.org'}).`);
  lines.push('');

  for (const step of state.currentPlan.steps.filter(s => s.status === 'completed')) {
    lines.push(`**${step.name}**: ${step.description}`);
    if (step.execution.toolId) {
      lines.push(`Tool: ${step.execution.toolId}`);
    }
    lines.push('');
  }

  const methods: MethodsSection = {
    text: lines.join('\n'),
    toolVersions,
    generatedAt: now,
    lastUpdated: now,
  };

  if (!state.currentPlan.publication) {
    initPublication();
  }
  state.currentPlan.publication!.methodsDraft = methods;
  state.currentPlan.updated = now;
  notifyPlanChange();

  return methods;
}

/**
 * Add a figure specification
 */
export function addFigure(figure: Omit<FigureSpec, 'id'>): FigureSpec {
  if (!state.currentPlan) {
    throw new Error("No active plan");
  }

  if (!state.currentPlan.publication) {
    initPublication();
  }

  const figureSpec: FigureSpec = {
    ...figure,
    id: `fig-${state.currentPlan.publication!.figures.length + 1}`,
  };

  state.currentPlan.publication!.figures.push(figureSpec);
  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();

  return figureSpec;
}

/**
 * Update figure status
 */
export function updateFigure(figureId: string, updates: Partial<FigureSpec>): FigureSpec | null {
  if (!state.currentPlan?.publication) {
    return null;
  }

  const figure = state.currentPlan.publication.figures.find(f => f.id === figureId);
  if (!figure) {
    return null;
  }

  Object.assign(figure, updates);
  state.currentPlan.updated = new Date().toISOString();
  notifyPlanChange();
  return figure;
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

  if (state.currentPlan) {
    notifyPlanChange();
  }
}

/**
 * Format plan for context injection (compact summary)
 */
export function formatPlanSummary(plan: AnalysisPlan): string {
  const lines: string[] = [];

  // Phase indicator
  const phaseLabels: Record<LifecyclePhase, string> = {
    'problem_definition': '📋 Problem Definition',
    'data_acquisition': '📥 Data Acquisition',
    'analysis': '🔬 Analysis',
    'interpretation': '💡 Interpretation',
    'publication': '📄 Publication',
  };

  // Header
  lines.push(`**${plan.title}** [${plan.status}]`);
  lines.push(`Phase: ${phaseLabels[plan.phase]}`);
  lines.push(`Research: ${plan.context.researchQuestion}`);

  // Hypothesis if refined (Phase 1)
  if (plan.researchQuestion?.hypothesis) {
    lines.push(`Hypothesis: ${plan.researchQuestion.hypothesis}`);
  }

  // Data source (Phase 2)
  if (plan.dataProvenance) {
    const dp = plan.dataProvenance;
    if (dp.accession) {
      lines.push(`Data: ${dp.source.toUpperCase()} ${dp.accession} (${dp.samples.length} samples)`);
    } else {
      lines.push(`Data: ${dp.source} (${dp.samples.length} samples, ${dp.originalFiles.length} files)`);
    }
  }

  // Galaxy context
  if (plan.galaxy.historyId) {
    lines.push(`History: ${plan.galaxy.historyName || plan.galaxy.historyId}`);
  }

  // Notebook path
  if (state.notebookPath) {
    lines.push(`Notebook: ${state.notebookPath}`);
  }

  // Steps overview (Phase 3)
  if (plan.steps.length > 0) {
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
  }

  // Current step details
  const currentStep = plan.steps.find(s => s.status === 'in_progress');
  if (currentStep) {
    lines.push('');
    lines.push(`**Current: ${currentStep.name}**`);
    lines.push(currentStep.description);
  }

  // Interpretation findings (Phase 4)
  if (plan.interpretation) {
    const findings = plan.interpretation.findings;
    if (findings.length > 0) {
      lines.push('');
      lines.push(`**Interpretation:** ${findings.length} finding(s)`);
      if (plan.interpretation.summary) {
        lines.push(`Summary: ${plan.interpretation.summary.slice(0, 80)}...`);
      }
    }
  }

  // Publication status (Phase 5)
  if (plan.publication) {
    const pub = plan.publication;
    lines.push('');
    lines.push(`**Publication:** ${pub.status.replace('_', ' ')}`);
    if (pub.figures.length > 0) {
      const done = pub.figures.filter(f => f.status === 'finalized').length;
      lines.push(`Figures: ${done}/${pub.figures.length} finalized`);
    }
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
  commitNotebook(filePath, "Create analysis notebook");

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
  changeType:
    | 'frontmatter'
    | 'step_added'
    | 'step_updated'
    | 'decision'
    | 'checkpoint'
    | 'galaxy_ref'
    | 'phase_change'
    | 'literature_ref'
    | 'data_provenance'
    | 'publication_update'
    | 'interpretation_finding'
    | 'interpretation_summary'
    | 'brc_context_updated',
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

      case 'phase_change':
        content = updateFrontmatter(content, 'phase', String(data.phase));
        content = appendEvent(content, {
          type: 'event',
          timestamp: new Date().toISOString(),
          data: {
            description: `Phase changed to ${data.phase}`,
            previous_phase: data.previousPhase,
            new_phase: data.phase,
          },
        });
        break;

      case 'literature_ref':
        content = appendEvent(content, {
          type: 'event',
          timestamp: String(data.addedAt || new Date().toISOString()),
          data: {
            description: `Literature reference added: ${data.title}`,
            pmid: data.pmid,
            doi: data.doi,
            relevance: data.relevance,
          },
        });
        break;

      case 'data_provenance':
        if (state.currentPlan) {
          content = generateNotebook(state.currentPlan);
        }
        content = appendEvent(content, {
          type: 'event',
          timestamp: new Date().toISOString(),
          data: {
            description: `Data provenance updated`,
            source: data.source,
            accession: data.accession,
            sample_count: data.sampleCount,
            file_count: data.fileCount,
          },
        });
        break;

      case 'publication_update':
        content = appendEvent(content, {
          type: 'event',
          timestamp: new Date().toISOString(),
          data: {
            description: `Publication ${data.updateType}: ${data.description || ''}`,
            status: data.status,
            figure_id: data.figureId,
          },
        });
        break;

      case 'interpretation_finding': {
        const finding = data.finding as BiologicalFinding;
        content = appendEvent(content, {
          type: 'event',
          timestamp: finding.addedAt,
          data: {
            description: `Finding: ${finding.title}`,
            category: finding.category,
            confidence: finding.confidence,
            evidence: finding.evidence,
          },
        });
        break;
      }

      case 'interpretation_summary':
        content = appendEvent(content, {
          type: 'event',
          timestamp: new Date().toISOString(),
          data: {
            description: `Interpretation summary set`,
            summary: data.summary,
          },
        });
        break;

      case 'brc_context_updated':
        if (state.currentPlan) {
          content = generateNotebook(state.currentPlan);
        }
        break;
    }

    await writeNotebook(state.notebookPath, content);

    if (COMMIT_CHANGE_TYPES.has(changeType)) {
      commitNotebook(state.notebookPath, buildCommitMessage(changeType, data));
    }
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
