/**
 * Type definitions for Galaxy analysis plan state management
 *
 * Supports 5-phase research lifecycle:
 * Phase 1: Problem Definition (research question, literature)
 * Phase 2: Data Acquisition (public data, local upload, samplesheets)
 * Phase 3: Analysis Execution (current core functionality)
 * Phase 4: Interpretation (biological context, pathway analysis)
 * Phase 5: Publication Preparation (methods, figures, data sharing)
 */

/**
 * Research lifecycle phase
 */
export type LifecyclePhase =
  | 'problem_definition'
  | 'data_acquisition'
  | 'analysis'
  | 'interpretation'
  | 'publication';

/**
 * Research question structure (Phase 1)
 * Uses PICO framework for structured hypothesis
 */
export interface ResearchQuestion {
  rawQuestion: string;          // Original question from researcher
  hypothesis?: string;          // Refined testable hypothesis
  pico?: {
    population: string;         // What/who is being studied
    intervention: string;       // Treatment/exposure
    comparison?: string;        // Control/alternative
    outcome: string;            // What we're measuring
  };
  literatureRefs: LiteratureReference[];
  refinedAt?: string;           // When hypothesis was refined
}

export interface LiteratureReference {
  pmid?: string;
  doi?: string;
  title: string;
  authors?: string[];
  year?: number;
  journal?: string;
  relevance: string;            // Why this paper is relevant
  addedAt: string;
}

/**
 * Data provenance tracking (Phase 2)
 */
export interface DataProvenance {
  source: DataSource;
  accession?: string;           // GEO/SRA accession
  downloadDate?: string;
  samples: SampleInfo[];
  originalFiles: DataFile[];
  samplesheet?: Samplesheet;
  importHistory?: string;       // Galaxy history where data was imported
}

export type DataSource =
  | 'geo'                       // NCBI GEO
  | 'sra'                       // NCBI SRA
  | 'ena'                       // European Nucleotide Archive
  | 'arrayexpress'              // ArrayExpress
  | 'local'                     // User uploaded
  | 'galaxy_shared'             // Shared Galaxy data
  | 'other';

export interface SampleInfo {
  id: string;
  name: string;
  condition?: string;
  replicate?: number;
  metadata: Record<string, string>;
  files: string[];              // Associated file IDs
}

export interface DataFile {
  id: string;
  name: string;
  type: DataFileType;
  format?: string;              // Detected format (fastq.gz, bam, etc.)
  size?: number;
  readType?: 'single' | 'paired';
  pairedWith?: string;          // ID of mate file for paired reads
  galaxyDatasetId?: string;     // Galaxy dataset ID after import
}

export type DataFileType =
  | 'fastq'
  | 'bam'
  | 'vcf'
  | 'counts'
  | 'annotation'
  | 'reference'
  | 'other';

export interface Samplesheet {
  format: 'csv' | 'tsv';
  columns: string[];
  rows: Record<string, string>[];
  generatedAt: string;
  galaxyDatasetId?: string;
}

/**
 * Publication materials (Phase 5)
 */
export interface PublicationMaterials {
  targetJournal?: string;
  methodsDraft?: MethodsSection;
  figures: FigureSpec[];
  supplementaryData: SupplementaryItem[];
  dataSharing?: DataSharingInfo;
  status: PublicationStatus;
}

export type PublicationStatus =
  | 'not_started'
  | 'drafting'
  | 'ready_for_review'
  | 'submitted';

export interface MethodsSection {
  text: string;
  toolVersions: ToolVersionInfo[];
  generatedAt: string;
  lastUpdated: string;
}

export interface ToolVersionInfo {
  toolId: string;
  toolName: string;
  version: string;
  stepId?: string;
  parameters?: Record<string, unknown>;
}

export interface FigureSpec {
  id: string;
  name: string;
  type: FigureType;
  dataSource: string;           // Step ID or dataset ID
  status: 'planned' | 'generated' | 'finalized';
  galaxyDatasetId?: string;
  description?: string;
  suggestedTool?: string;       // Galaxy tool for generating
}

export type FigureType =
  | 'qc_plot'
  | 'pca'
  | 'heatmap'
  | 'volcano'
  | 'ma_plot'
  | 'pathway'
  | 'coverage'
  | 'alignment'
  | 'custom';

export interface SupplementaryItem {
  id: string;
  name: string;
  type: 'table' | 'file' | 'dataset';
  description: string;
  galaxyDatasetId?: string;
  exportFormat?: string;
}

export interface DataSharingInfo {
  repository?: 'geo' | 'zenodo' | 'figshare' | 'other';
  accession?: string;
  submissionDate?: string;
  status: 'not_started' | 'preparing' | 'submitted' | 'public';
  preparedFiles: string[];
}

/**
 * Interpretation findings (Phase 4)
 */
export interface InterpretationFindings {
  findings: BiologicalFinding[];
  summary?: string;
  summarizedAt?: string;
}

export interface BiologicalFinding {
  id: string;
  title: string;
  description: string;
  evidence: string;
  category: FindingCategory;
  relatedSteps: string[];
  confidence: 'high' | 'medium' | 'low' | 'uncertain';
  addedAt: string;
}

export type FindingCategory =
  | 'differential_expression'
  | 'pathway'
  | 'variant'
  | 'structural'
  | 'functional'
  | 'unexpected'
  | 'negative'
  | 'other';

/**
 * BRC catalog context — organism, assembly, and workflow selections
 * from the BRC Analytics MCP server
 */
export interface BRCContext {
  organism?: {
    species: string;
    taxonomyId: string;
    commonName?: string;
  };
  assembly?: {
    accession: string;
    species: string;
    isReference: boolean;
    hasGeneAnnotation: boolean;
    geneModelUrl?: string;
  };
  analysisCategory?: string;
  workflowIwcId?: string;
  workflowName?: string;
}

/**
 * Workflow structure metadata fetched from Galaxy API
 */
export interface WorkflowStructure {
  name: string;
  annotation?: string;
  version: number;
  toolIds: string[];       // full Galaxy tool IDs
  toolNames: string[];     // human-readable short names
  inputLabels: string[];   // workflow input step labels
  outputLabels: string[];  // labeled workflow outputs
  stepCount: number;
}

/**
 * Main analysis plan with 5-phase lifecycle support
 */
export interface AnalysisPlan {
  id: string;
  title: string;
  created: string;      // ISO timestamp
  updated: string;      // ISO timestamp
  status: PlanStatus;

  // Current lifecycle phase
  phase: LifecyclePhase;

  // Research context (Phase 1 - Problem Definition)
  context: {
    researchQuestion: string;
    dataDescription: string;
    expectedOutcomes: string[];
    constraints: string[];
  };

  // Structured research question (Phase 1)
  researchQuestion?: ResearchQuestion;

  // Data provenance (Phase 2 - Data Acquisition)
  dataProvenance?: DataProvenance;

  // BRC catalog context (organism, assembly, workflow selections)
  brcContext?: BRCContext;

  // Galaxy connection context
  galaxy: {
    historyId: string | null;
    historyName: string | null;
    serverUrl: string | null;
  };

  // Analysis workflow (Phase 3)
  steps: AnalysisStep[];
  decisions: DecisionEntry[];
  checkpoints: QCCheckpoint[];

  // Interpretation findings (Phase 4)
  interpretation?: InterpretationFindings;

  // Publication materials (Phase 5)
  publication?: PublicationMaterials;
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
    toolVersion?: string;   // resolved from Galaxy job details after completion
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

  // Workflow metadata (when executionType is 'workflow')
  workflowStructure?: WorkflowStructure;

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
  | 'observation'
  | 'data_source_selection'     // Phase 2
  | 'literature_review'         // Phase 1
  | 'interpretation'            // Phase 4
  | 'publication_choice';       // Phase 5

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
