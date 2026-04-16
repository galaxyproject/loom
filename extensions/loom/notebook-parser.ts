/**
 * Parser for Galaxy analysis notebooks
 *
 * Notebooks are markdown files with YAML frontmatter and fenced YAML blocks
 * for structured data (steps, events, decisions, checkpoints).
 */

import type {
  AnalysisPlan,
  AnalysisStep,
  BRCContext,
  DecisionEntry,
  QCCheckpoint,
  PlanStatus,
  StepStatus,
  ExecutionType,
  CheckpointStatus,
  DecisionType,
  DatasetReference,
  StepResult,
  LifecyclePhase,
  ResearchQuestion,
  LiteratureReference,
  DataProvenance,
  PublicationMaterials,
  InterpretationFindings,
  BiologicalFinding,
  FindingCategory,
  WorkflowStructure,
  ReportedResult,
} from "./types";

/**
 * Parsed notebook structure
 */
export interface ParsedNotebook {
  frontmatter: NotebookFrontmatter;
  researchContext: {
    researchQuestion: string;
    dataDescription: string;
    expectedOutcomes: string[];
    constraints: string[];
  };
  brcContext?: BRCContext;
  steps: ParsedStep[];
  events: ParsedEvent[];
  galaxyReferences: GalaxyReference[];
  interpretation?: InterpretationFindings;
  dataProvenance?: DataProvenance;
  researchQuestionDetails?: ResearchQuestion;
  publication?: PublicationMaterials;
  reportedResults?: ReportedResult[];
}

export interface NotebookFrontmatter {
  plan_id: string;
  title: string;
  status: PlanStatus;
  phase: LifecyclePhase;
  created: string;
  updated: string;
  galaxy: {
    server_url: string | null;
    history_id: string | null;
    history_name: string | null;
    history_url: string | null;
  };
}

export interface ParsedStep {
  id: string;
  name: string;
  status: StepStatus;
  description: string;
  execution: {
    type: ExecutionType;
    tool_id?: string;
    workflow_id?: string;
    trs_id?: string;
    parameters?: Record<string, unknown>;
  };
  inputs: Array<{ name: string; dataset_ids?: string[] }>;
  outputs: Array<{ dataset_id: string; name: string; url?: string }>;
  job_id?: string;
  job_url?: string;
  invocation_id?: string;
  completed_at?: string;
  summary?: string;
  qc_passed?: boolean | null;
  workflow_structure?: {
    step_count: number;
    tools?: string[];
    inputs?: string[];
    outputs?: string[];
  };
}

export interface ParsedEvent {
  type: "event" | "decision" | "checkpoint";
  timestamp: string;
  data: Record<string, unknown>;
}

export interface GalaxyReference {
  resource: string;
  id: string;
  url: string;
}

/**
 * Parse YAML frontmatter from notebook content
 */
export function parseFrontmatter(content: string): NotebookFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const frontmatter: Partial<NotebookFrontmatter> = {
    galaxy: {
      server_url: null,
      history_id: null,
      history_name: null,
      history_url: null,
    },
  };

  // Parse YAML manually (avoiding external dependency)
  const lines = yaml.split("\n");
  let inGalaxy = false;

  for (const line of lines) {
    if (line.startsWith("#")) continue;

    if (line.match(/^galaxy:\s*$/)) {
      inGalaxy = true;
      continue;
    }

    if (inGalaxy && line.match(/^\s{2}\w/)) {
      const galaxyMatch = line.match(/^\s{2}(\w+):\s*"?([^"]*)"?\s*$/);
      if (galaxyMatch) {
        const [, key, value] = galaxyMatch;
        const galaxyKey = key as keyof NotebookFrontmatter["galaxy"];
        if (frontmatter.galaxy && galaxyKey in frontmatter.galaxy) {
          (frontmatter.galaxy as Record<string, string | null>)[galaxyKey] =
            value || null;
        }
      }
    } else {
      inGalaxy = false;
      const lineMatch = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
      if (lineMatch) {
        const [, key, value] = lineMatch;
        if (key === "plan_id") frontmatter.plan_id = value;
        else if (key === "title") frontmatter.title = value;
        else if (key === "status")
          frontmatter.status = value as PlanStatus;
        else if (key === "phase")
          frontmatter.phase = value as LifecyclePhase;
        else if (key === "created") frontmatter.created = value;
        else if (key === "updated") frontmatter.updated = value;
      }
    }
  }

  // Default phase to 'analysis' for backwards compatibility
  if (!frontmatter.phase) {
    frontmatter.phase = 'analysis';
  }

  if (
    frontmatter.plan_id &&
    frontmatter.title &&
    frontmatter.status &&
    frontmatter.created &&
    frontmatter.updated
  ) {
    return frontmatter as NotebookFrontmatter;
  }

  return null;
}

/**
 * Parse a scalar YAML value string into a JS value
 */
function parseYamlValue(raw: string): unknown {
  const value = raw.replace(/^["']|["']$/g, "");
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

/**
 * Parse a fenced YAML block with nested objects and arrays.
 * Handles the subset of YAML used by our notebook format:
 * scalar values, nested objects (via indentation), and arrays (via - prefix).
 */
function parseYamlBlock(block: string): Record<string, unknown> | null {
  try {
    const lines = block.split("\n");

    // Stack tracks nested objects: each entry is [indent, target-object]
    const root: Record<string, unknown> = {};
    const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [
      { indent: -1, obj: root },
    ];
    let currentArray: { key: string; parent: Record<string, unknown>; items: unknown[] } | null = null;

    for (const line of lines) {
      if (!line.trim()) continue;

      // Array item: "  - value" or "  - key: value"
      const arrayMatch = line.match(/^(\s*)-\s*(.*)$/);
      if (arrayMatch) {
        const value = arrayMatch[2].trim();
        if (currentArray) {
          // Check if array item is a key-value pair (e.g., "- name: foo")
          const kvInArray = value.match(/^(\w+):\s*(.+)$/);
          if (kvInArray) {
            const itemObj: Record<string, unknown> = {};
            itemObj[kvInArray[1]] = parseYamlValue(kvInArray[2]);
            // Peek ahead for continuation of this object (multi-line array items)
            currentArray.items.push(itemObj);
          } else {
            currentArray.items.push(parseYamlValue(value));
          }
        }
        continue;
      }

      // Key-value pair
      const kvMatch = line.match(/^(\s*)(\w+):\s*(.*)$/);
      if (kvMatch) {
        const [, spaces, key, rawValue] = kvMatch;
        const indent = spaces.length;

        // Flush any pending array
        if (currentArray) {
          currentArray.parent[currentArray.key] = currentArray.items;
          currentArray = null;
        }

        // Pop stack back to the right nesting level
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
          stack.pop();
        }

        const target = stack[stack.length - 1].obj;

        if (rawValue === "" || rawValue.trim() === "") {
          // Could be nested object or array — create object optimistically.
          // If the next line starts with "- ", parseArray handling will convert it.
          const child: Record<string, unknown> = {};
          target[key] = child;
          stack.push({ indent, obj: child });

          // Peek: if next non-empty line starts with "- ", treat as array
          const nextIdx = lines.indexOf(line) + 1;
          for (let i = nextIdx; i < lines.length; i++) {
            const nextLine = lines[i];
            if (!nextLine.trim()) continue;
            if (nextLine.match(/^\s*-\s/)) {
              // It's an array, not an object
              delete target[key];
              stack.pop();
              currentArray = { key, parent: target, items: [] };
            }
            break;
          }
        } else {
          target[key] = parseYamlValue(rawValue);
        }
      }
    }

    // Flush any remaining array
    if (currentArray) {
      currentArray.parent[currentArray.key] = currentArray.items;
    }

    return root;
  } catch {
    return null;
  }
}

/**
 * Find and parse all step blocks in notebook
 */
export function parseStepBlocks(content: string): ParsedStep[] {
  const steps: ParsedStep[] = [];
  const stepRegex = /```yaml\n(step:[\s\S]*?)```/g;

  let match;
  while ((match = stepRegex.exec(content)) !== null) {
    const block = match[1];
    const parsed = parseYamlBlock(block);

    if (parsed && parsed.step) {
      // The step data might be nested or flat depending on format
      const stepData = (parsed.step as Record<string, unknown>) || parsed;

      // Parse workflow_structure if present
      let workflowStructure: ParsedStep['workflow_structure'] | undefined;
      if (stepData.workflow_structure) {
        const ws = stepData.workflow_structure as Record<string, unknown>;
        workflowStructure = {
          step_count: Number(ws.step_count) || 0,
          tools: ws.tools as string[] | undefined,
          inputs: ws.inputs as string[] | undefined,
          outputs: ws.outputs as string[] | undefined,
        };
      }

      const executionData = (stepData.execution as Record<string, unknown>) || {};
      let parameters: Record<string, unknown> | undefined;
      if (typeof executionData.parameters === "string" && executionData.parameters.length > 0) {
        try {
          parameters = JSON.parse(executionData.parameters) as Record<string, unknown>;
        } catch {
          // Bad JSON — drop rather than crash
        }
      } else if (executionData.parameters && typeof executionData.parameters === "object") {
        parameters = executionData.parameters as Record<string, unknown>;
      }

      const qcPassedRaw = stepData.qc_passed;
      const qcPassed =
        typeof qcPassedRaw === "boolean"
          ? qcPassedRaw
          : qcPassedRaw === null
          ? null
          : undefined;

      steps.push({
        id: String(stepData.id || ""),
        name: String(stepData.name || ""),
        status: (stepData.status as StepStatus) || "pending",
        description: String(stepData.description || ""),
        execution: {
          type: (executionData.type as ExecutionType) || "tool",
          tool_id: executionData.tool_id as string | undefined,
          workflow_id: executionData.workflow_id as string | undefined,
          trs_id: executionData.trs_id as string | undefined,
          parameters,
        },
        inputs: (stepData.inputs as Array<{ name: string; dataset_ids?: string[] }>) || [],
        outputs: (stepData.outputs as Array<{ dataset_id: string; name: string; url?: string }>) || [],
        job_id: stepData.job_id as string | undefined,
        job_url: stepData.job_url as string | undefined,
        invocation_id: stepData.invocation_id as string | undefined,
        completed_at: stepData.completed_at as string | undefined,
        summary: stepData.summary as string | undefined,
        qc_passed: qcPassed,
        workflow_structure: workflowStructure,
      });
    }
  }

  return steps;
}

/**
 * Find and parse all event/decision/checkpoint blocks in notebook
 */
export function parseEventBlocks(content: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const eventRegex = /```yaml\n((event|decision|checkpoint):[\s\S]*?)```/g;

  let match;
  while ((match = eventRegex.exec(content)) !== null) {
    const block = match[1];
    const type = match[2] as "event" | "decision" | "checkpoint";
    const parsed = parseYamlBlock(block);

    if (parsed) {
      const data = (parsed[type] as Record<string, unknown>) || parsed;
      events.push({
        type,
        timestamp: String(data.timestamp || new Date().toISOString()),
        data,
      });
    }
  }

  return events;
}

/**
 * Extract a section by heading
 */
export function getSection(content: string, heading: string): string | null {
  // Escape special regex characters in heading
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = content.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * Parse the Research Context section
 */
export function parseResearchContext(content: string): ParsedNotebook["researchContext"] {
  const section = getSection(content, "Research Context");
  const result = {
    researchQuestion: "",
    dataDescription: "",
    expectedOutcomes: [] as string[],
    constraints: [] as string[],
  };

  if (!section) return result;

  // Parse **Field**: Value format
  const questionMatch = section.match(/\*\*Research Question\*\*:\s*([^\n]+)/);
  if (questionMatch) result.researchQuestion = questionMatch[1].trim();

  const dataMatch = section.match(/\*\*Data Description\*\*:\s*([^\n]+)/);
  if (dataMatch) result.dataDescription = dataMatch[1].trim();

  const outcomesMatch = section.match(/\*\*Expected Outcomes\*\*:\s*([^\n]+)/);
  if (outcomesMatch) {
    result.expectedOutcomes = outcomesMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const constraintsMatch = section.match(/\*\*Constraints\*\*:\s*([^\n]+)/);
  if (constraintsMatch) {
    result.constraints = constraintsMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return result;
}

/**
 * Parse Galaxy References table
 */
export function parseGalaxyReferences(content: string): GalaxyReference[] {
  const section = getSection(content, "Galaxy References");
  if (!section) return [];

  const references: GalaxyReference[] = [];
  const rowRegex = /\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*\[View\]\(([^)]+)\)\s*\|/g;

  let match;
  while ((match = rowRegex.exec(section)) !== null) {
    references.push({
      resource: match[1].trim(),
      id: match[2].trim(),
      url: match[3].trim(),
    });
  }

  return references;
}

/**
 * Parse the Interpretation section
 */
export function parseInterpretation(content: string): InterpretationFindings | undefined {
  const section = getSection(content, "Interpretation");
  if (!section) return undefined;

  const findings: BiologicalFinding[] = [];

  // Parse summary
  const summaryMatch = section.match(/\*\*Summary\*\*:\s*([^\n]+)/);
  const summary = summaryMatch ? summaryMatch[1].trim() : undefined;

  // Parse findings: #### finding-N: Title
  const findingRegex = /####\s+(finding-\d+):\s*([^\n]+)\n\n`([^`]+)`\s+`([^`]+)`\n\n([\s\S]*?)(?=####\s+finding-|\n---\n|$)/g;
  let match;
  while ((match = findingRegex.exec(section)) !== null) {
    const [, id, title, category, confidence, body] = match;

    const evidenceMatch = body.match(/\*\*Evidence\*\*:\s*([^\n]+)/);
    const stepsMatch = body.match(/\*\*Related steps\*\*:\s*([^\n]+)/);
    const addedMatch = body.match(/\*Added:\s*([^*]+)\*/);

    // Description is everything before **Evidence**
    const descEnd = body.indexOf('**Evidence**');
    const description = descEnd > 0 ? body.slice(0, descEnd).trim() : body.trim();

    findings.push({
      id,
      title: title.trim(),
      description,
      evidence: evidenceMatch ? evidenceMatch[1].trim() : '',
      category: category as FindingCategory,
      relatedSteps: stepsMatch ? stepsMatch[1].split(',').map(s => s.trim()) : [],
      confidence: confidence as 'high' | 'medium' | 'low' | 'uncertain',
      addedAt: addedMatch ? addedMatch[1].trim() : new Date().toISOString(),
    });
  }

  if (findings.length === 0 && !summary) return undefined;

  return { findings, summary };
}

/**
 * Parse the authoritative publication_json block from the Publication Materials section.
 * Covers methods draft, figures, supplementary data, and data sharing info.
 */
export function parsePublicationMaterials(content: string): PublicationMaterials | undefined {
  const section = getSection(content, "Publication Materials");
  if (!section) return undefined;

  const match = section.match(/publication_json:\s*'([\s\S]*?)'\s*\n/);
  if (!match) return undefined;

  try {
    const json = match[1].replace(/''/g, "'");
    return JSON.parse(json) as PublicationMaterials;
  } catch {
    return undefined;
  }
}

/**
 * Parse the authoritative research_question_json block from the Research Context
 * section. Returns hypothesis, PICO, and literature references that the markdown
 * rendering shows but does not preserve in parse-friendly form.
 */
export function parseResearchQuestionDetails(content: string): ResearchQuestion | undefined {
  const section = getSection(content, "Research Context");
  if (!section) return undefined;

  const match = section.match(/research_question_json:\s*'([\s\S]*?)'\s*\n/);
  if (!match) return undefined;

  try {
    const json = match[1].replace(/''/g, "'");
    return JSON.parse(json) as ResearchQuestion;
  } catch {
    return undefined;
  }
}

/**
 * Parse the Data Provenance YAML block (authoritative) from the Data Provenance section.
 * The block is a single `provenance_json: '<json>'` line to bypass nested-array
 * limits of the handwritten YAML parser.
 */
export function parseDataProvenance(content: string): DataProvenance | undefined {
  const section = getSection(content, "Data Provenance");
  if (!section) return undefined;

  const match = section.match(/provenance_json:\s*'([\s\S]*?)'\s*\n/);
  if (!match) return undefined;

  try {
    const json = match[1].replace(/''/g, "'");
    const dp = JSON.parse(json) as DataProvenance;
    return dp;
  } catch {
    return undefined;
  }
}

/**
 * Parse the BRC Catalog Context section
 */
export function parseBRCContext(content: string): BRCContext | undefined {
  // Look for ### BRC Catalog Context heading within the Research Context section or standalone
  const sectionMatch = content.match(/### BRC Catalog Context\n\n([\s\S]*?)(?=\n###|\n---|\n## |$)/);
  if (!sectionMatch) return undefined;

  const section = sectionMatch[1];
  const brc: BRCContext = {};

  // Parse organism: **Organism**: Species (taxonomy: ID, CommonName)
  const orgMatch = section.match(/\*\*Organism\*\*:\s*([^(]+)\(taxonomy:\s*(\d+)(?:,\s*([^)]+))?\)/);
  if (orgMatch) {
    brc.organism = {
      species: orgMatch[1].trim(),
      taxonomyId: orgMatch[2].trim(),
    };
    if (orgMatch[3]) {
      brc.organism.commonName = orgMatch[3].trim();
    }
  }

  // Parse assembly: **Assembly**: GCF_xxx (flags)
  const asmMatch = section.match(/\*\*Assembly\*\*:\s*(\S+)(?:\s*\(([^)]+)\))?/);
  if (asmMatch) {
    const flags = asmMatch[2] || '';
    brc.assembly = {
      accession: asmMatch[1],
      species: brc.organism?.species || '',
      isReference: flags.includes('reference'),
      hasGeneAnnotation: flags.includes('has gene annotation'),
    };
  }

  // Parse category: **Analysis category**: VALUE
  const catMatch = section.match(/\*\*Analysis category\*\*:\s*(.+)/);
  if (catMatch) {
    brc.analysisCategory = catMatch[1].trim();
  }

  // Parse workflow: **Workflow**: Name (iwcId)
  const wfMatch = section.match(/\*\*Workflow\*\*:\s*(.+)\s+\(([^)]+)\)/);
  if (wfMatch) {
    brc.workflowName = wfMatch[1].trim();
    brc.workflowIwcId = wfMatch[2].trim();
  }

  // Only return if we found at least one field
  if (brc.organism || brc.assembly || brc.analysisCategory || brc.workflowIwcId) {
    return brc;
  }
  return undefined;
}

/**
 * Parse the authoritative results_json block (written anywhere after the
 * steps section). Bypasses the handwritten YAML parser's limits via JSON.
 */
export function parseReportedResults(content: string): ReportedResult[] | undefined {
  const match = content.match(/results_json:\s*'([\s\S]*?)'\s*\n/);
  if (!match) return undefined;

  try {
    const json = match[1].replace(/''/g, "'");
    return JSON.parse(json) as ReportedResult[];
  } catch {
    return undefined;
  }
}

/**
 * Parse an entire notebook into structured data
 */
export function parseNotebook(content: string): ParsedNotebook | null {
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) return null;

  return {
    frontmatter,
    researchContext: parseResearchContext(content),
    brcContext: parseBRCContext(content),
    steps: parseStepBlocks(content),
    events: parseEventBlocks(content),
    galaxyReferences: parseGalaxyReferences(content),
    interpretation: parseInterpretation(content),
    dataProvenance: parseDataProvenance(content),
    researchQuestionDetails: parseResearchQuestionDetails(content),
    publication: parsePublicationMaterials(content),
    reportedResults: parseReportedResults(content),
  };
}

/**
 * Convert parsed notebook to AnalysisPlan
 */
export function notebookToPlan(notebook: ParsedNotebook): AnalysisPlan {
  const { frontmatter, researchContext, steps, events } = notebook;

  // Convert parsed steps to AnalysisStep format
  const analysisSteps: AnalysisStep[] = steps.map((step) => {
    // Reconstruct WorkflowStructure from parsed data
    let workflowStructure: WorkflowStructure | undefined;
    if (step.workflow_structure) {
      const ws = step.workflow_structure;
      workflowStructure = {
        name: step.name,
        version: 0,
        toolIds: [],
        toolNames: ws.tools || [],
        inputLabels: ws.inputs || [],
        outputLabels: ws.outputs || [],
        stepCount: ws.step_count,
      };
    }

    const hasResult =
      step.job_id ||
      step.invocation_id ||
      step.completed_at ||
      step.summary ||
      step.qc_passed !== undefined;

    const result: StepResult | undefined = hasResult
      ? {
          completedAt: step.completed_at || "",
          jobId: step.job_id,
          invocationId: step.invocation_id,
          summary: step.summary || "",
          qcPassed: step.qc_passed === undefined ? null : step.qc_passed,
        }
      : undefined;

    return {
      id: step.id,
      name: step.name,
      description: step.description,
      status: step.status,
      execution: {
        type: step.execution.type,
        toolId: step.execution.tool_id,
        workflowId: step.execution.workflow_id,
        trsId: step.execution.trs_id,
        parameters: step.execution.parameters,
      },
      inputs: step.inputs.map((i) => ({
        name: i.name,
        description: "",
        datasetId: i.dataset_ids?.[0],
      })),
      expectedOutputs: [],
      actualOutputs: step.outputs.map((o) => ({
        datasetId: o.dataset_id,
        name: o.name,
        datatype: "",
      })),
      result,
      workflowStructure,
      dependsOn: [],
    };
  });

  // Convert events to decisions and checkpoints
  const decisions: DecisionEntry[] = [];
  const checkpoints: QCCheckpoint[] = [];

  for (const event of events) {
    if (event.type === "decision") {
      decisions.push({
        timestamp: event.timestamp,
        stepId: String(event.data.step_id || null),
        type: (event.data.type as DecisionType) || "observation",
        description: String(event.data.description || ""),
        rationale: String(event.data.rationale || ""),
        researcherApproved: Boolean(event.data.researcher_approved ?? true),
      });
    } else if (event.type === "checkpoint") {
      checkpoints.push({
        id: String(event.data.id || ""),
        stepId: String(event.data.step_id || ""),
        name: String(event.data.name || ""),
        criteria: (event.data.criteria as string[]) || [],
        status: (event.data.status as CheckpointStatus) || "pending",
        observations: (event.data.observations as string[]) || [],
        reviewedAt: event.timestamp,
      });
    }
  }

  const plan: AnalysisPlan = {
    id: frontmatter.plan_id,
    title: frontmatter.title,
    created: frontmatter.created,
    updated: frontmatter.updated,
    status: frontmatter.status,
    phase: frontmatter.phase,
    context: {
      researchQuestion: researchContext.researchQuestion,
      dataDescription: researchContext.dataDescription,
      expectedOutcomes: researchContext.expectedOutcomes,
      constraints: researchContext.constraints,
    },
    galaxy: {
      historyId: frontmatter.galaxy.history_id,
      historyName: frontmatter.galaxy.history_name,
      serverUrl: frontmatter.galaxy.server_url,
    },
    steps: analysisSteps,
    decisions,
    checkpoints,
  };

  if (notebook.brcContext) {
    plan.brcContext = notebook.brcContext;
  }

  if (notebook.interpretation) {
    plan.interpretation = notebook.interpretation;
  }

  if (notebook.dataProvenance) {
    plan.dataProvenance = notebook.dataProvenance;
  }

  if (notebook.researchQuestionDetails) {
    plan.researchQuestion = notebook.researchQuestionDetails;
  }

  if (notebook.publication) {
    plan.publication = notebook.publication;
  }

  if (notebook.reportedResults && notebook.reportedResults.length > 0) {
    plan.results = notebook.reportedResults;
  }

  return plan;
}
