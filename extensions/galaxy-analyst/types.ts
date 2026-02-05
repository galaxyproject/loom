/**
 * Type definitions for Galaxy analysis plan state management
 */

export interface AnalysisPlan {
  id: string;
  title: string;
  created: string;      // ISO timestamp
  updated: string;      // ISO timestamp
  status: PlanStatus;

  // Research context
  context: {
    researchQuestion: string;
    dataDescription: string;
    expectedOutcomes: string[];
    constraints: string[];
  };

  // Galaxy connection context
  galaxy: {
    historyId: string | null;
    historyName: string | null;
    serverUrl: string | null;
  };

  // Analysis workflow
  steps: AnalysisStep[];
  decisions: DecisionEntry[];
  checkpoints: QCCheckpoint[];
}

export type PlanStatus = 'draft' | 'active' | 'completed' | 'abandoned';

export interface AnalysisStep {
  id: string;
  name: string;
  description: string;
  status: StepStatus;

  // What will be executed
  execution: {
    type: ExecutionType;
    toolId?: string;
    workflowId?: string;
    trsId?: string;         // IWC TRS ID if from IWC
    parameters?: Record<string, unknown>;
  };

  // Inputs and outputs
  inputs: StepInput[];
  expectedOutputs: string[];
  actualOutputs: DatasetReference[];

  // Results
  result?: StepResult;

  // Dependencies
  dependsOn: string[];
}

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';
export type ExecutionType = 'tool' | 'workflow' | 'manual';

export interface StepInput {
  name: string;
  datasetId?: string;
  fromStep?: string;
  description: string;
}

export interface DatasetReference {
  datasetId: string;
  name: string;
  datatype: string;
  size?: number;
}

export interface StepResult {
  completedAt: string;
  jobId?: string;
  invocationId?: string;
  summary: string;
  qcPassed: boolean | null;
}

export interface DecisionEntry {
  timestamp: string;
  stepId: string | null;
  type: DecisionType;
  description: string;
  rationale: string;
  researcherApproved: boolean;
}

export type DecisionType =
  | 'parameter_choice'
  | 'tool_selection'
  | 'plan_modification'
  | 'qc_decision'
  | 'observation';

export interface QCCheckpoint {
  id: string;
  stepId: string;
  name: string;
  criteria: string[];
  status: CheckpointStatus;
  observations: string[];
  reviewedAt?: string;
}

export type CheckpointStatus = 'pending' | 'passed' | 'failed' | 'needs_review';

/**
 * Extension state (in-memory, persisted via appendEntry)
 */
export interface AnalystState {
  currentPlan: AnalysisPlan | null;
  recentPlanIds: string[];
  galaxyConnected: boolean;
  currentHistoryId: string | null;

  // Notebook state
  notebookPath: string | null;
  notebookLoaded: boolean;
}

/**
 * Notebook-specific types for file persistence
 */
export interface NotebookMetadata {
  planId: string;
  title: string;
  status: PlanStatus;
  created: string;
  updated: string;
  filePath: string;
}

export interface NotebookEvent {
  type: 'plan_created' | 'step_added' | 'step_updated' | 'decision_logged' | 'checkpoint_created';
  timestamp: string;
  description: string;
  details?: Record<string, unknown>;
}

export interface NotebookSummary {
  path: string;
  title: string;
  status: PlanStatus;
  stepCount: number;
  completedSteps: number;
  lastUpdated: string;
}
