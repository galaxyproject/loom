/**
 * Parser for Galaxy analysis notebooks
 *
 * Notebooks are markdown files with YAML frontmatter and fenced YAML blocks
 * for structured data (steps, events, decisions, checkpoints).
 */

import type {
  AnalysisPlan,
  AnalysisStep,
  DecisionEntry,
  QCCheckpoint,
  PlanStatus,
  StepStatus,
  ExecutionType,
  CheckpointStatus,
  DecisionType,
  DatasetReference,
  StepResult,
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
  steps: ParsedStep[];
  events: ParsedEvent[];
  galaxyReferences: GalaxyReference[];
}

export interface NotebookFrontmatter {
  plan_id: string;
  title: string;
  status: PlanStatus;
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
  };
  inputs: Array<{ name: string; dataset_ids?: string[] }>;
  outputs: Array<{ dataset_id: string; name: string; url?: string }>;
  job_id?: string;
  job_url?: string;
  invocation_id?: string;
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
        else if (key === "created") frontmatter.created = value;
        else if (key === "updated") frontmatter.updated = value;
      }
    }
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
 * Parse a fenced YAML block
 */
function parseYamlBlock(block: string): Record<string, unknown> | null {
  try {
    const lines = block.split("\n");
    const result: Record<string, unknown> = {};
    let currentKey: string | null = null;
    let currentArray: unknown[] | null = null;
    let indent = 0;

    for (const line of lines) {
      // Skip empty lines
      if (!line.trim()) continue;

      // Array item
      const arrayMatch = line.match(/^(\s*)-\s*(.*)$/);
      if (arrayMatch && currentArray !== null) {
        const value = arrayMatch[2].trim();
        // Handle quoted strings
        const unquoted = value.replace(/^["']|["']$/g, "");
        currentArray.push(unquoted || value);
        continue;
      }

      // Key-value pair
      const kvMatch = line.match(/^(\s*)(\w+):\s*(.*)$/);
      if (kvMatch) {
        const [, spaces, key, rawValue] = kvMatch;
        const newIndent = spaces.length;

        // If we were building an array, save it
        if (currentArray !== null && currentKey) {
          result[currentKey] = currentArray;
          currentArray = null;
        }

        // Top-level key
        if (newIndent === 0 || newIndent <= indent) {
          currentKey = key;
          indent = newIndent;

          if (rawValue === "") {
            // Could be start of array or nested object
            currentArray = [];
          } else {
            // Parse value
            const value = rawValue.replace(/^["']|["']$/g, "");
            if (value === "true") result[key] = true;
            else if (value === "false") result[key] = false;
            else if (value === "null") result[key] = null;
            else if (/^\d+$/.test(value)) result[key] = parseInt(value, 10);
            else result[key] = value;
          }
        }
      }
    }

    // Save any remaining array
    if (currentArray !== null && currentKey) {
      result[currentKey] = currentArray;
    }

    return result;
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

      steps.push({
        id: String(stepData.id || ""),
        name: String(stepData.name || ""),
        status: (stepData.status as StepStatus) || "pending",
        description: String(stepData.description || ""),
        execution: {
          type: ((stepData.execution as Record<string, unknown>)?.type as ExecutionType) || "tool",
          tool_id: (stepData.execution as Record<string, unknown>)?.tool_id as string | undefined,
          workflow_id: (stepData.execution as Record<string, unknown>)?.workflow_id as string | undefined,
          trs_id: (stepData.execution as Record<string, unknown>)?.trs_id as string | undefined,
        },
        inputs: (stepData.inputs as Array<{ name: string; dataset_ids?: string[] }>) || [],
        outputs: (stepData.outputs as Array<{ dataset_id: string; name: string; url?: string }>) || [],
        job_id: stepData.job_id as string | undefined,
        job_url: stepData.job_url as string | undefined,
        invocation_id: stepData.invocation_id as string | undefined,
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
 * Parse an entire notebook into structured data
 */
export function parseNotebook(content: string): ParsedNotebook | null {
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) return null;

  return {
    frontmatter,
    researchContext: parseResearchContext(content),
    steps: parseStepBlocks(content),
    events: parseEventBlocks(content),
    galaxyReferences: parseGalaxyReferences(content),
  };
}

/**
 * Convert parsed notebook to AnalysisPlan
 */
export function notebookToPlan(notebook: ParsedNotebook): AnalysisPlan {
  const { frontmatter, researchContext, steps, events } = notebook;

  // Convert parsed steps to AnalysisStep format
  const analysisSteps: AnalysisStep[] = steps.map((step) => ({
    id: step.id,
    name: step.name,
    description: step.description,
    status: step.status,
    execution: {
      type: step.execution.type,
      toolId: step.execution.tool_id,
      workflowId: step.execution.workflow_id,
      trsId: step.execution.trs_id,
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
    result: step.job_id
      ? {
          completedAt: "",
          jobId: step.job_id,
          invocationId: step.invocation_id,
          summary: "",
          qcPassed: null,
        }
      : undefined,
    dependsOn: [],
  }));

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

  return {
    id: frontmatter.plan_id,
    title: frontmatter.title,
    created: frontmatter.created,
    updated: frontmatter.updated,
    status: frontmatter.status,
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
}
