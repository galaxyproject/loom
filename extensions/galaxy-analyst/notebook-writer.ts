/**
 * Writer for Galaxy analysis notebooks
 *
 * Handles creating and updating notebook files with proper formatting.
 * Uses append-only strategy for execution log, in-place updates for frontmatter and steps.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type {
  AnalysisPlan,
  AnalysisStep,
  DecisionEntry,
  QCCheckpoint,
  DatasetReference,
  StepResult,
  LifecyclePhase,
  ResearchQuestion,
  DataProvenance,
  PublicationMaterials,
  InterpretationFindings,
  BiologicalFinding,
} from "./types";

/**
 * Generate slug from title for default filename
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Phase label mapping
 */
const phaseLabels: Record<LifecyclePhase, string> = {
  'problem_definition': 'Problem Definition',
  'data_acquisition': 'Data Acquisition',
  'analysis': 'Analysis',
  'interpretation': 'Interpretation',
  'publication': 'Publication',
};

/**
 * Generate complete notebook content from an AnalysisPlan
 */
export function generateNotebook(plan: AnalysisPlan): string {
  const lines: string[] = [];

  // Frontmatter
  lines.push("---");
  lines.push(`plan_id: "${plan.id}"`);
  lines.push(`title: "${plan.title}"`);
  lines.push(`status: ${plan.status}`);
  lines.push(`phase: ${plan.phase}`);
  lines.push(`created: "${plan.created}"`);
  lines.push(`updated: "${plan.updated}"`);
  lines.push("");
  lines.push("galaxy:");
  lines.push(`  server_url: "${plan.galaxy.serverUrl || ""}"`);
  lines.push(`  history_id: "${plan.galaxy.historyId || ""}"`);
  lines.push(`  history_name: "${plan.galaxy.historyName || ""}"`);
  if (plan.galaxy.serverUrl && plan.galaxy.historyId) {
    lines.push(
      `  history_url: "${plan.galaxy.serverUrl}/histories/view?id=${plan.galaxy.historyId}"`
    );
  } else {
    lines.push(`  history_url: ""`);
  }
  lines.push("---");
  lines.push("");

  // Title
  lines.push(`# ${plan.title}`);
  lines.push("");

  // Phase indicator
  lines.push(`**Current Phase**: ${phaseLabels[plan.phase]}`);
  lines.push("");

  // Research Context
  lines.push("## Research Context");
  lines.push("");
  lines.push(`**Research Question**: ${plan.context.researchQuestion}`);

  // Hypothesis if refined (Phase 1)
  if (plan.researchQuestion?.hypothesis) {
    lines.push(`**Hypothesis**: ${plan.researchQuestion.hypothesis}`);
    if (plan.researchQuestion.pico) {
      const pico = plan.researchQuestion.pico;
      lines.push("");
      lines.push("**PICO Framework**:");
      lines.push(`- Population: ${pico.population}`);
      lines.push(`- Intervention: ${pico.intervention}`);
      if (pico.comparison) lines.push(`- Comparison: ${pico.comparison}`);
      lines.push(`- Outcome: ${pico.outcome}`);
    }
  }

  lines.push(`**Data Description**: ${plan.context.dataDescription}`);
  lines.push(
    `**Expected Outcomes**: ${plan.context.expectedOutcomes.join(", ")}`
  );
  if (plan.context.constraints.length > 0) {
    lines.push(`**Constraints**: ${plan.context.constraints.join(", ")}`);
  }
  lines.push("");

  // Literature references (Phase 1)
  if (plan.researchQuestion?.literatureRefs && plan.researchQuestion.literatureRefs.length > 0) {
    lines.push("### Literature Background");
    lines.push("");
    for (const ref of plan.researchQuestion.literatureRefs) {
      const citation = ref.pmid ? `PMID: ${ref.pmid}` : ref.doi ? `DOI: ${ref.doi}` : '';
      lines.push(`- **${ref.title}**${ref.year ? ` (${ref.year})` : ''}`);
      if (citation) lines.push(`  ${citation}`);
      lines.push(`  *Relevance*: ${ref.relevance}`);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");

  // Data Provenance (Phase 2)
  if (plan.dataProvenance) {
    lines.push("## Data Provenance");
    lines.push("");
    const dp = plan.dataProvenance;
    lines.push(`**Source**: ${dp.source.toUpperCase()}`);
    if (dp.accession) lines.push(`**Accession**: ${dp.accession}`);
    if (dp.downloadDate) lines.push(`**Download Date**: ${dp.downloadDate}`);
    lines.push("");

    if (dp.samples.length > 0) {
      lines.push("### Samples");
      lines.push("");
      lines.push("| ID | Name | Condition | Replicate | Files |");
      lines.push("|-----|------|-----------|-----------|-------|");
      for (const s of dp.samples) {
        lines.push(`| ${s.id} | ${s.name} | ${s.condition || '-'} | ${s.replicate ?? '-'} | ${s.files.length} |`);
      }
      lines.push("");
    }

    if (dp.originalFiles.length > 0) {
      lines.push("### Files");
      lines.push("");
      lines.push("| ID | Name | Type | Galaxy ID |");
      lines.push("|-----|------|------|-----------|");
      for (const f of dp.originalFiles) {
        lines.push(`| ${f.id} | ${f.name} | ${f.type} | ${f.galaxyDatasetId || '-'} |`);
      }
      lines.push("");
    }

    if (dp.samplesheet) {
      lines.push("### Samplesheet");
      lines.push("");
      lines.push(`Generated: ${dp.samplesheet.generatedAt}`);
      lines.push(`Format: ${dp.samplesheet.format}`);
      lines.push(`Columns: ${dp.samplesheet.columns.join(', ')}`);
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  // Analysis Plan section
  lines.push("## Analysis Plan");
  lines.push("");

  // Steps
  for (const step of plan.steps) {
    lines.push(`### Step ${step.id}: ${step.name}`);
    lines.push("");
    lines.push("```yaml");
    lines.push("step:");
    lines.push(`  id: "${step.id}"`);
    lines.push(`  name: "${step.name}"`);
    lines.push(`  status: ${step.status}`);
    lines.push("  execution:");
    lines.push(`    type: ${step.execution.type}`);
    if (step.execution.toolId) {
      lines.push(`    tool_id: "${step.execution.toolId}"`);
    }
    if (step.execution.workflowId) {
      lines.push(`    workflow_id: "${step.execution.workflowId}"`);
    }
    if (step.execution.trsId) {
      lines.push(`    trs_id: "${step.execution.trsId}"`);
    }

    if (step.inputs.length > 0) {
      lines.push("  inputs:");
      for (const input of step.inputs) {
        lines.push(`    - name: "${input.name}"`);
        if (input.datasetId) {
          lines.push(`      dataset_ids: ["${input.datasetId}"]`);
        }
      }
    }

    if (step.actualOutputs.length > 0) {
      lines.push("  outputs:");
      for (const output of step.actualOutputs) {
        lines.push(`    - dataset_id: "${output.datasetId}"`);
        lines.push(`      name: "${output.name}"`);
      }
    }

    if (step.result?.jobId) {
      lines.push(`  job_id: "${step.result.jobId}"`);
    }
    if (step.result?.invocationId) {
      lines.push(`  invocation_id: "${step.result.invocationId}"`);
    }

    lines.push("```");
    lines.push("");
    lines.push(`**Purpose**: ${step.description}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  // Interpretation (Phase 4)
  if (plan.interpretation && (plan.interpretation.findings.length > 0 || plan.interpretation.summary)) {
    lines.push("## Interpretation");
    lines.push("");

    if (plan.interpretation.summary) {
      lines.push(`**Summary**: ${plan.interpretation.summary}`);
      lines.push("");
    }

    if (plan.interpretation.findings.length > 0) {
      lines.push("### Findings");
      lines.push("");

      for (const finding of plan.interpretation.findings) {
        const badge = `\`${finding.category}\``;
        const conf = `\`${finding.confidence}\``;
        lines.push(`#### ${finding.id}: ${finding.title}`);
        lines.push("");
        lines.push(`${badge} ${conf}`);
        lines.push("");
        lines.push(finding.description);
        lines.push("");
        lines.push(`**Evidence**: ${finding.evidence}`);
        if (finding.relatedSteps.length > 0) {
          lines.push(`**Related steps**: ${finding.relatedSteps.join(', ')}`);
        }
        lines.push(`*Added: ${finding.addedAt}*`);
        lines.push("");
      }
    }

    lines.push("---");
    lines.push("");
  }

  // Execution Log section
  lines.push("## Execution Log");
  lines.push("");
  lines.push("<!-- Append-only: new entries added at bottom -->");
  lines.push("");

  // Add existing decisions as events
  for (const decision of plan.decisions) {
    const date = new Date(decision.timestamp).toISOString().split("T")[0];
    const time = new Date(decision.timestamp).toISOString().split("T")[1].slice(0, 5);
    lines.push(`### ${date} ${time} - Decision: ${decision.type}`);
    lines.push("");
    lines.push("```yaml");
    lines.push("decision:");
    lines.push(`  timestamp: "${decision.timestamp}"`);
    if (decision.stepId) {
      lines.push(`  step_id: "${decision.stepId}"`);
    }
    lines.push(`  type: ${decision.type}`);
    lines.push(`  description: "${escapeYamlString(decision.description)}"`);
    lines.push(`  rationale: "${escapeYamlString(decision.rationale)}"`);
    lines.push(`  researcher_approved: ${decision.researcherApproved}`);
    lines.push("```");
    lines.push("");
  }

  // Add existing checkpoints
  for (const checkpoint of plan.checkpoints) {
    const timestamp = checkpoint.reviewedAt || new Date().toISOString();
    const date = timestamp.split("T")[0];
    const time = timestamp.split("T")[1].slice(0, 5);
    lines.push(`### ${date} ${time} - QC Checkpoint: ${checkpoint.name}`);
    lines.push("");
    lines.push("```yaml");
    lines.push("checkpoint:");
    lines.push(`  id: "${checkpoint.id}"`);
    lines.push(`  step_id: "${checkpoint.stepId}"`);
    lines.push(`  name: "${checkpoint.name}"`);
    lines.push(`  status: ${checkpoint.status}`);
    if (checkpoint.criteria.length > 0) {
      lines.push("  criteria:");
      for (const c of checkpoint.criteria) {
        lines.push(`    - "${escapeYamlString(c)}"`);
      }
    }
    if (checkpoint.observations.length > 0) {
      lines.push("  observations:");
      for (const o of checkpoint.observations) {
        lines.push(`    - "${escapeYamlString(o)}"`);
      }
    }
    lines.push("```");
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  // Galaxy References table
  lines.push("## Galaxy References");
  lines.push("");
  lines.push("| Resource | ID | URL |");
  lines.push("|----------|-----|-----|");

  if (plan.galaxy.historyId && plan.galaxy.serverUrl) {
    const historyUrl = `${plan.galaxy.serverUrl}/histories/view?id=${plan.galaxy.historyId}`;
    lines.push(
      `| History | ${plan.galaxy.historyId} | [View](${historyUrl}) |`
    );
  }

  // Add dataset references from step outputs
  for (const step of plan.steps) {
    for (const output of step.actualOutputs) {
      if (output.datasetId && plan.galaxy.serverUrl) {
        const datasetUrl = `${plan.galaxy.serverUrl}/datasets/${output.datasetId}`;
        lines.push(
          `| ${output.name} | ${output.datasetId} | [View](${datasetUrl}) |`
        );
      }
    }
  }

  lines.push("");

  // Publication Materials (Phase 5)
  if (plan.publication) {
    lines.push("---");
    lines.push("");
    lines.push("## Publication Materials");
    lines.push("");

    const pub = plan.publication;
    lines.push(`**Status**: ${pub.status.replace('_', ' ')}`);
    if (pub.targetJournal) {
      lines.push(`**Target Journal**: ${pub.targetJournal}`);
    }
    lines.push("");

    // Methods section
    if (pub.methodsDraft) {
      lines.push("### Methods Draft");
      lines.push("");
      lines.push(`*Generated: ${pub.methodsDraft.generatedAt}*`);
      lines.push("");
      lines.push(pub.methodsDraft.text);
      lines.push("");

      if (pub.methodsDraft.toolVersions.length > 0) {
        lines.push("#### Tool Versions");
        lines.push("");
        lines.push("| Tool | Version | Step |");
        lines.push("|------|---------|------|");
        for (const t of pub.methodsDraft.toolVersions) {
          lines.push(`| ${t.toolName} | ${t.version} | ${t.stepId || '-'} |`);
        }
        lines.push("");
      }
    }

    // Figures
    if (pub.figures.length > 0) {
      lines.push("### Figures");
      lines.push("");
      lines.push("| ID | Name | Type | Status | Dataset ID |");
      lines.push("|-----|------|------|--------|------------|");
      for (const f of pub.figures) {
        lines.push(`| ${f.id} | ${f.name} | ${f.type} | ${f.status} | ${f.galaxyDatasetId || '-'} |`);
      }
      lines.push("");

      // Figure details
      for (const f of pub.figures) {
        if (f.description) {
          lines.push(`**${f.id}: ${f.name}**`);
          lines.push(f.description);
          if (f.suggestedTool) {
            lines.push(`*Suggested tool: ${f.suggestedTool}*`);
          }
          lines.push("");
        }
      }
    }

    // Supplementary data
    if (pub.supplementaryData.length > 0) {
      lines.push("### Supplementary Data");
      lines.push("");
      lines.push("| ID | Name | Type | Description |");
      lines.push("|-----|------|------|-------------|");
      for (const s of pub.supplementaryData) {
        lines.push(`| ${s.id} | ${s.name} | ${s.type} | ${s.description} |`);
      }
      lines.push("");
    }

    // Data sharing
    if (pub.dataSharing) {
      const ds = pub.dataSharing;
      lines.push("### Data Sharing");
      lines.push("");
      lines.push(`**Repository**: ${ds.repository || 'Not selected'}`);
      lines.push(`**Status**: ${ds.status.replace('_', ' ')}`);
      if (ds.accession) {
        lines.push(`**Accession**: ${ds.accession}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Escape special characters for YAML string
 */
function escapeYamlString(str: string): string {
  return str.replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Update frontmatter field in notebook content
 */
export function updateFrontmatter(
  content: string,
  field: string,
  value: string
): string {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return content;

  let frontmatter = frontmatterMatch[1];

  // Handle nested galaxy fields
  if (field.startsWith("galaxy.")) {
    const subfield = field.replace("galaxy.", "");
    const regex = new RegExp(`(^\\s{2}${subfield}:\\s*).*$`, "m");
    if (frontmatter.match(regex)) {
      frontmatter = frontmatter.replace(regex, `$1"${value}"`);
    }
  } else {
    const regex = new RegExp(`(^${field}:\\s*).*$`, "m");
    if (frontmatter.match(regex)) {
      frontmatter = frontmatter.replace(regex, `$1"${value}"`);
    }
  }

  // Always update the updated timestamp
  if (field !== "updated") {
    const now = new Date().toISOString();
    frontmatter = frontmatter.replace(
      /^(updated:\s*).*$/m,
      `$1"${now}"`
    );
  }

  return content.replace(/^---\n[\s\S]*?\n---/, `---\n${frontmatter}\n---`);
}

/**
 * Update a step block in notebook content
 */
export function updateStepBlock(
  content: string,
  stepId: string,
  updates: {
    status?: string;
    jobId?: string;
    invocationId?: string;
    outputs?: DatasetReference[];
  }
): string {
  // Find the step block
  const stepRegex = new RegExp(
    `(\`\`\`yaml\\nstep:\\n\\s+id: "${stepId}"[\\s\\S]*?)(\`\`\`)`,
    "m"
  );
  const match = content.match(stepRegex);
  if (!match) return content;

  let block = match[1];

  // Update status
  if (updates.status) {
    block = block.replace(/(\n\s+status:\s*)\S+/, `$1${updates.status}`);
  }

  // Add or update job_id
  if (updates.jobId) {
    if (block.includes("job_id:")) {
      block = block.replace(/(\n\s+job_id:\s*)"[^"]*"/, `$1"${updates.jobId}"`);
    } else {
      block = block.replace(/(\`\`\`)$/, `  job_id: "${updates.jobId}"\n$1`);
    }
  }

  // Add or update invocation_id
  if (updates.invocationId) {
    if (block.includes("invocation_id:")) {
      block = block.replace(
        /(\n\s+invocation_id:\s*)"[^"]*"/,
        `$1"${updates.invocationId}"`
      );
    } else {
      block = block.replace(
        /(\`\`\`)$/,
        `  invocation_id: "${updates.invocationId}"\n$1`
      );
    }
  }

  // Add outputs
  if (updates.outputs && updates.outputs.length > 0) {
    // Check if outputs section exists
    if (block.includes("outputs:")) {
      // Find outputs section and append
      const outputsRegex = /(\n\s+outputs:\n)([\s\S]*?)(\n\s+\w+:|$)/;
      const outputsMatch = block.match(outputsRegex);
      if (outputsMatch) {
        let outputsSection = outputsMatch[2];
        for (const output of updates.outputs) {
          outputsSection += `    - dataset_id: "${output.datasetId}"\n`;
          outputsSection += `      name: "${output.name}"\n`;
        }
        block = block.replace(outputsRegex, `$1${outputsSection}$3`);
      }
    } else {
      // Add new outputs section before closing
      let outputsYaml = "  outputs:\n";
      for (const output of updates.outputs) {
        outputsYaml += `    - dataset_id: "${output.datasetId}"\n`;
        outputsYaml += `      name: "${output.name}"\n`;
      }
      block = block + outputsYaml;
    }
  }

  // Update timestamp
  const now = new Date().toISOString();
  content = updateFrontmatter(content, "updated", now);

  return content.replace(stepRegex, block + match[2]);
}

/**
 * Append an event to the Execution Log section
 */
export function appendEvent(
  content: string,
  event: {
    type: "event" | "decision" | "checkpoint";
    timestamp: string;
    data: Record<string, unknown>;
  }
): string {
  const { type, timestamp, data } = event;
  const date = timestamp.split("T")[0];
  const time = timestamp.split("T")[1].slice(0, 5);

  let title = "";
  if (type === "decision") {
    title = `Decision: ${data.type || "observation"}`;
  } else if (type === "checkpoint") {
    title = `QC Checkpoint: ${data.name || "checkpoint"}`;
  } else {
    title = `Event: ${data.description || "event"}`;
  }

  const lines: string[] = [];
  lines.push(`### ${date} ${time} - ${title}`);
  lines.push("");
  lines.push("```yaml");
  lines.push(`${type}:`);
  lines.push(`  timestamp: "${timestamp}"`);

  for (const [key, value] of Object.entries(data)) {
    if (key === "timestamp") continue;
    if (Array.isArray(value)) {
      lines.push(`  ${key}:`);
      for (const item of value) {
        lines.push(`    - "${escapeYamlString(String(item))}"`);
      }
    } else if (typeof value === "boolean") {
      lines.push(`  ${key}: ${value}`);
    } else if (typeof value === "number") {
      lines.push(`  ${key}: ${value}`);
    } else if (value !== null && value !== undefined) {
      lines.push(`  ${key}: "${escapeYamlString(String(value))}"`);
    }
  }

  lines.push("```");
  lines.push("");

  const eventBlock = lines.join("\n");

  // Find the Execution Log section and append before the ---
  const logSectionRegex = /(## Execution Log\n[\s\S]*?)(---\n\n## Galaxy References)/;
  const match = content.match(logSectionRegex);

  if (match) {
    return content.replace(logSectionRegex, `$1${eventBlock}$2`);
  }

  // Fallback: append before Galaxy References
  const galaxyRefRegex = /(---\n\n## Galaxy References)/;
  if (content.match(galaxyRefRegex)) {
    return content.replace(galaxyRefRegex, `${eventBlock}$1`);
  }

  // Last fallback: append at end
  return content + "\n" + eventBlock;
}

/**
 * Append a Galaxy reference to the references table
 */
export function appendGalaxyReference(
  content: string,
  ref: { resource: string; id: string; url: string }
): string {
  const tableRow = `| ${ref.resource} | ${ref.id} | [View](${ref.url}) |`;

  // Find the Galaxy References table
  const tableRegex = /(## Galaxy References\n\n\| Resource[\s\S]*?)(\n\n|$)/;
  const match = content.match(tableRegex);

  if (match) {
    // Check if this reference already exists
    if (content.includes(`| ${ref.id} |`)) {
      return content;
    }
    return content.replace(tableRegex, `$1\n${tableRow}$2`);
  }

  return content;
}

/**
 * Add a new step section to the notebook
 */
export function addStepSection(content: string, step: AnalysisStep): string {
  const lines: string[] = [];

  lines.push(`### Step ${step.id}: ${step.name}`);
  lines.push("");
  lines.push("```yaml");
  lines.push("step:");
  lines.push(`  id: "${step.id}"`);
  lines.push(`  name: "${step.name}"`);
  lines.push(`  status: ${step.status}`);
  lines.push("  execution:");
  lines.push(`    type: ${step.execution.type}`);
  if (step.execution.toolId) {
    lines.push(`    tool_id: "${step.execution.toolId}"`);
  }
  if (step.execution.workflowId) {
    lines.push(`    workflow_id: "${step.execution.workflowId}"`);
  }
  if (step.execution.trsId) {
    lines.push(`    trs_id: "${step.execution.trsId}"`);
  }

  if (step.inputs.length > 0) {
    lines.push("  inputs:");
    for (const input of step.inputs) {
      lines.push(`    - name: "${input.name}"`);
    }
  }

  lines.push("```");
  lines.push("");
  lines.push(`**Purpose**: ${step.description}`);
  lines.push("");

  const stepSection = lines.join("\n");

  // Insert before "---" that precedes "## Execution Log"
  const executionLogRegex = /(---\n\n## Execution Log)/;
  const match = content.match(executionLogRegex);

  if (match) {
    return content.replace(executionLogRegex, `${stepSection}$1`);
  }

  // Fallback: insert before Execution Log heading
  const logHeadingRegex = /(## Execution Log)/;
  if (content.match(logHeadingRegex)) {
    return content.replace(logHeadingRegex, `${stepSection}---\n\n$1`);
  }

  // Last fallback: append before end
  return content + "\n" + stepSection;
}

/**
 * Write notebook to file
 */
export async function writeNotebook(
  filePath: string,
  content: string
): Promise<void> {
  await fs.writeFile(filePath, content, "utf-8");
}

/**
 * Read notebook from file
 */
export async function readNotebook(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf-8");
}

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List notebook files in a directory
 */
export async function listNotebooks(directory: string): Promise<string[]> {
  try {
    const files = await fs.readdir(directory);
    return files
      .filter((f) => f.endsWith("-notebook.md"))
      .map((f) => path.join(directory, f));
  } catch {
    return [];
  }
}

/**
 * Generate default notebook path from plan title
 */
export function getDefaultNotebookPath(title: string, directory: string): string {
  const slug = slugify(title);
  return path.join(directory, `${slug}-notebook.md`);
}
