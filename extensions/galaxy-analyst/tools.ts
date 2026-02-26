/**
 * Custom tool registrations for Galaxy analysis plan management
 *
 * These tools are registered with Pi and available for the LLM to call.
 * They manage the analysis plan state and provide orchestration capabilities.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  createPlan,
  addStep,
  updateStepStatus,
  addStepOutputs,
  logDecision,
  setCheckpoint,
  getCurrentPlan,
  setPlanStatus,
  formatPlanSummary,
  loadNotebook,
  createNotebook,
  findNotebooks,
  getNotebookPath,
  getDefaultPath,
  syncToNotebook,
  // Phase management
  setPhase,
  getPhase,
  // Phase 1: Research question
  setResearchQuestion,
  addLiteratureRef,
  // Phase 2: Data provenance
  setDataProvenance,
  addSample,
  addDataFile,
  updateDataFile,
  // Phase 4: Interpretation
  addFinding,
  setInterpretationSummary,
  getFindings,
  // Phase 5: Publication
  initPublication,
  generateMethods,
  addFigure,
  updateFigure,
} from "./state";
import type {
  StepStatus,
  StepResult,
  DecisionType,
  CheckpointStatus,
  DatasetReference,
  LifecyclePhase,
  DataSource,
  DataFileType,
  FigureType,
  FindingCategory,
} from "./types";
import * as path from "path";
import { ensureGitRepo } from "./git";

export function registerPlanTools(pi: ExtensionAPI): void {

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Create a new analysis plan
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "analysis_plan_create",
    label: "Create Analysis Plan",
    description: `Create a new structured analysis plan. Use this at the start of any analysis
to establish the research question, data context, and expected outcomes. The plan will track
all steps, decisions, and results throughout the analysis.`,
    parameters: Type.Object({
      title: Type.String({
        description: "Brief descriptive title for the analysis"
      }),
      researchQuestion: Type.String({
        description: "The primary research question being investigated"
      }),
      dataDescription: Type.String({
        description: "Description of the input data (type, source, characteristics)"
      }),
      expectedOutcomes: Type.Array(Type.String(), {
        description: "List of expected results or deliverables"
      }),
      constraints: Type.Array(Type.String(), {
        description: "Any constraints (time, resources, methodology requirements)",
        default: []
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const plan = createPlan({
        title: params.title,
        researchQuestion: params.researchQuestion,
        dataDescription: params.dataDescription,
        expectedOutcomes: params.expectedOutcomes,
        constraints: params.constraints || [],
      });

      // Auto-create notebook for the plan
      let notebookPath: string | null = null;
      try {
        const cwd = process.cwd();
        ensureGitRepo(cwd);
        const defaultPath = getDefaultPath(plan.title, cwd);
        await createNotebook(defaultPath, plan);
        notebookPath = defaultPath;
      } catch {
        // Notebook creation is optional, continue without it
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Analysis plan "${plan.title}" created`,
            planId: plan.id,
            status: plan.status,
            notebook: notebookPath,
          }, null, 2),
        }],
        details: { planId: plan.id, notebookPath },
      };
    },
    renderResult: (result) => {
      const d = result.details as { planId?: string; notebookPath?: string } | undefined;
      const lines = [`✅ Analysis plan created`, `   ID: ${d?.planId || 'unknown'}`];
      if (d?.notebookPath) {
        lines.push(`   📓 Notebook: ${d.notebookPath}`);
      }
      return new Text(lines.join('\n'));
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Add a step to the plan
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "analysis_plan_add_step",
    label: "Add Analysis Step",
    description: `Add a new step to the current analysis plan. Each step should represent
a discrete analytical operation (tool execution, workflow invocation, or manual review).`,
    parameters: Type.Object({
      name: Type.String({
        description: "Short name for the step (e.g., 'Quality Assessment')"
      }),
      description: Type.String({
        description: "What this step will accomplish"
      }),
      executionType: Type.Union([
        Type.Literal("tool"),
        Type.Literal("workflow"),
        Type.Literal("manual"),
      ], { description: "How the step will be executed" }),
      toolId: Type.Optional(Type.String({
        description: "Galaxy tool ID if executionType is 'tool'"
      })),
      workflowId: Type.Optional(Type.String({
        description: "Galaxy workflow ID if executionType is 'workflow'"
      })),
      trsId: Type.Optional(Type.String({
        description: "IWC TRS ID if using an IWC workflow"
      })),
      inputs: Type.Array(
        Type.Object({
          name: Type.String(),
          description: Type.String(),
          fromStep: Type.Optional(Type.String()),
        }),
        { description: "Required inputs for this step" }
      ),
      expectedOutputs: Type.Array(Type.String(), {
        description: "Types of outputs expected (e.g., 'FastQC report', 'BAM file')"
      }),
      dependsOn: Type.Array(Type.String(), {
        description: "Step IDs this step depends on",
        default: []
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const step = addStep({
          name: params.name,
          description: params.description,
          executionType: params.executionType,
          toolId: params.toolId,
          workflowId: params.workflowId,
          trsId: params.trsId,
          inputs: params.inputs,
          expectedOutputs: params.expectedOutputs,
          dependsOn: params.dependsOn || [],
        });

        const plan = getCurrentPlan();

        // Sync to notebook
        await syncToNotebook('step_added', { step });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Step "${step.name}" added as step ${step.id}`,
              stepId: step.id,
              totalSteps: plan?.steps.length || 0,
            }, null, 2),
          }],
          details: { stepId: step.id },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Update step status
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "analysis_plan_update_step",
    label: "Update Step Status",
    description: `Update the status of an analysis step. Use this to mark steps as
in_progress when starting, completed when done, or failed if issues occur.`,
    parameters: Type.Object({
      stepId: Type.String({ description: "Step ID to update" }),
      status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed"),
        Type.Literal("skipped"),
        Type.Literal("failed"),
      ], { description: "New status for the step" }),
      summary: Type.Optional(Type.String({
        description: "Summary of results or reason for status change"
      })),
      jobId: Type.Optional(Type.String({
        description: "Galaxy job ID if applicable"
      })),
      invocationId: Type.Optional(Type.String({
        description: "Galaxy workflow invocation ID if applicable"
      })),
      qcPassed: Type.Optional(Type.Boolean({
        description: "Whether QC checks passed (if applicable)"
      })),
      outputs: Type.Optional(Type.Array(
        Type.Object({
          datasetId: Type.String(),
          name: Type.String(),
          datatype: Type.String(),
          size: Type.Optional(Type.Number()),
        }),
        { description: "Output datasets produced" }
      )),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const result: StepResult | undefined = params.summary ? {
          completedAt: new Date().toISOString(),
          jobId: params.jobId,
          invocationId: params.invocationId,
          summary: params.summary,
          qcPassed: params.qcPassed ?? null,
        } : undefined;

        const step = updateStepStatus(
          params.stepId,
          params.status as StepStatus,
          result
        );

        // Add outputs if provided
        if (params.outputs && params.outputs.length > 0) {
          addStepOutputs(params.stepId, params.outputs as DatasetReference[]);
        }

        // Sync to notebook
        await syncToNotebook('step_updated', {
          stepId: params.stepId,
          status: params.status,
          jobId: params.jobId,
          invocationId: params.invocationId,
          outputs: params.outputs,
        });

        // Add Galaxy references for outputs
        const plan = getCurrentPlan();
        if (params.outputs && plan?.galaxy.serverUrl) {
          for (const output of params.outputs) {
            await syncToNotebook('galaxy_ref', {
              resource: output.name,
              id: output.datasetId,
              url: `${plan.galaxy.serverUrl}/datasets/${output.datasetId}`,
            });
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Step ${params.stepId} updated to '${params.status}'`,
              step: {
                id: step.id,
                name: step.name,
                status: step.status,
              },
            }, null, 2),
          }],
          details: { stepId: step.id, status: step.status },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Get current plan
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "analysis_plan_get",
    label: "Get Analysis Plan",
    description: `Retrieve the current analysis plan state. Use this to review the
full plan, check step statuses, or get details for a specific step.`,
    parameters: Type.Object({
      stepId: Type.Optional(Type.String({
        description: "If provided, return details for just this step"
      })),
      includeDecisions: Type.Boolean({
        description: "Include the decision log in the response",
        default: false
      }),
      includeCheckpoints: Type.Boolean({
        description: "Include QC checkpoints in the response",
        default: false
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const plan = getCurrentPlan();

      if (!plan) {
        return {
          content: [{ type: "text", text: "No active analysis plan. Use analysis_plan_create to start one." }],
          details: { hasPlan: false },
        };
      }

      let response: Record<string, unknown>;

      if (params.stepId) {
        const step = plan.steps.find(s => s.id === params.stepId);
        if (!step) {
          return {
            content: [{ type: "text", text: `Step ${params.stepId} not found` }],
            details: { error: true },
          };
        }
        response = { step };
      } else {
        response = {
          id: plan.id,
          title: plan.title,
          status: plan.status,
          created: plan.created,
          updated: plan.updated,
          context: plan.context,
          galaxy: plan.galaxy,
          steps: plan.steps.map(s => ({
            id: s.id,
            name: s.name,
            status: s.status,
            executionType: s.execution.type,
            dependsOn: s.dependsOn,
            hasResult: !!s.result,
          })),
          stepCount: plan.steps.length,
          completedCount: plan.steps.filter(s => s.status === 'completed').length,
        };

        if (params.includeDecisions) {
          response.decisions = plan.decisions;
        }

        if (params.includeCheckpoints) {
          response.checkpoints = plan.checkpoints;
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(response, null, 2),
        }],
        details: { planId: plan.id },
      };
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Log a decision
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "analysis_step_log",
    label: "Log Decision/Observation",
    description: `Log a decision, parameter choice, or observation in the analysis plan.
This maintains a complete audit trail of the analysis process.`,
    parameters: Type.Object({
      stepId: Type.Optional(Type.String({
        description: "Associated step ID, or omit for plan-level decisions"
      })),
      type: Type.Union([
        Type.Literal("parameter_choice"),
        Type.Literal("tool_selection"),
        Type.Literal("plan_modification"),
        Type.Literal("qc_decision"),
        Type.Literal("observation"),
      ], { description: "Type of decision/observation" }),
      description: Type.String({
        description: "What was decided or observed"
      }),
      rationale: Type.String({
        description: "Reasoning behind the decision"
      }),
      researcherApproved: Type.Boolean({
        description: "Whether the researcher approved this decision",
        default: true
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const entry = logDecision({
          stepId: params.stepId || null,
          type: params.type as DecisionType,
          description: params.description,
          rationale: params.rationale,
          researcherApproved: params.researcherApproved ?? true,
        });

        // Sync to notebook
        await syncToNotebook('decision', {
          timestamp: entry.timestamp,
          stepId: entry.stepId,
          type: entry.type,
          description: entry.description,
          rationale: entry.rationale,
          researcherApproved: entry.researcherApproved,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Decision logged",
              entry: {
                timestamp: entry.timestamp,
                type: entry.type,
                stepId: entry.stepId,
              },
            }, null, 2),
          }],
          details: { logged: true },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: QC checkpoint
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "analysis_checkpoint",
    label: "QC Checkpoint",
    description: `Create or update a quality control checkpoint. Use this at key points
in the analysis to validate results before proceeding.`,
    parameters: Type.Object({
      stepId: Type.String({
        description: "Step ID this checkpoint is associated with"
      }),
      name: Type.String({
        description: "Checkpoint name (e.g., 'Post-alignment QC')"
      }),
      criteria: Type.Array(Type.String(), {
        description: "QC criteria to check"
      }),
      status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("passed"),
        Type.Literal("failed"),
        Type.Literal("needs_review"),
      ], { description: "Checkpoint status" }),
      observations: Type.Array(Type.String(), {
        description: "Observations from the QC check",
        default: []
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const checkpoint = setCheckpoint({
          stepId: params.stepId,
          name: params.name,
          criteria: params.criteria,
          status: params.status as CheckpointStatus,
          observations: params.observations || [],
        });

        // Sync to notebook
        await syncToNotebook('checkpoint', {
          id: checkpoint.id,
          stepId: checkpoint.stepId,
          name: checkpoint.name,
          status: checkpoint.status,
          criteria: checkpoint.criteria,
          observations: checkpoint.observations,
          reviewedAt: checkpoint.reviewedAt,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `QC checkpoint "${params.name}" ${params.status}`,
              checkpoint: {
                id: checkpoint.id,
                status: checkpoint.status,
                observations: checkpoint.observations,
              },
            }, null, 2),
          }],
          details: { checkpointId: checkpoint.id, status: checkpoint.status },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
    renderResult: (result) => {
      const d = result.details as { status?: string } | undefined;
      const icon = d?.status === 'passed' ? '✅' : d?.status === 'failed' ? '❌' : '⏸️';
      return new Text(`${icon} QC Checkpoint: ${d?.status}`);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Activate plan
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "analysis_plan_activate",
    label: "Activate Analysis Plan",
    description: `Change the plan status from 'draft' to 'active' when ready to begin execution.
Use this after the plan has been reviewed and approved by the researcher.`,
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        setPlanStatus('active');
        const plan = getCurrentPlan();

        // Sync status change to notebook
        await syncToNotebook('frontmatter', { status: 'active' });

        // Log the activation event
        await syncToNotebook('decision', {
          timestamp: new Date().toISOString(),
          type: 'plan_modification',
          description: 'Plan activated - ready for execution',
          rationale: 'Plan reviewed and approved by researcher',
          researcherApproved: true,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Plan "${plan?.title}" is now active`,
              status: 'active',
            }, null, 2),
          }],
          details: { status: 'active' },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Get plan summary (for quick reference)
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "analysis_plan_summary",
    label: "Get Plan Summary",
    description: `Get a compact summary of the current plan suitable for quick reference.
Shows title, status, steps overview, current step, and recent decisions.`,
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const plan = getCurrentPlan();

      if (!plan) {
        return {
          content: [{ type: "text", text: "No active analysis plan." }],
          details: { hasPlan: false },
        };
      }

      const summary = formatPlanSummary(plan);

      return {
        content: [{ type: "text", text: summary }],
        details: { planId: plan.id },
      };
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Create analysis notebook
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "analysis_notebook_create",
    label: "Create Analysis Notebook",
    description: `Create a persistent notebook file for the current analysis plan.
The notebook is a markdown file that persists the plan, steps, decisions, and results
to disk. This enables resuming analysis across sessions and sharing with collaborators.
Must have an active plan to create a notebook.`,
    parameters: Type.Object({
      path: Type.Optional(Type.String({
        description: "Custom path for the notebook. If not provided, defaults to ./{slug}-notebook.md in current directory"
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const plan = getCurrentPlan();

      if (!plan) {
        return {
          content: [{ type: "text", text: "Error: No active plan. Create a plan first with analysis_plan_create." }],
          details: { error: true },
        };
      }

      // Check if notebook already exists
      const existingPath = getNotebookPath();
      if (existingPath) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              message: `Notebook already exists at ${existingPath}`,
              path: existingPath,
            }, null, 2),
          }],
          details: { path: existingPath, alreadyExists: true },
        };
      }

      try {
        const cwd = process.cwd();
        const notebookPath = params.path || getDefaultPath(plan.title, cwd);
        const absolutePath = path.isAbsolute(notebookPath)
          ? notebookPath
          : path.join(cwd, notebookPath);

        ensureGitRepo(path.dirname(absolutePath));
        await createNotebook(absolutePath, plan);

        // Log the notebook creation event
        await syncToNotebook('decision', {
          timestamp: new Date().toISOString(),
          type: 'observation',
          description: 'Analysis notebook created',
          rationale: 'Persistent storage for analysis state',
          researcherApproved: true,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Notebook created: ${absolutePath}`,
              path: absolutePath,
              planId: plan.id,
            }, null, 2),
          }],
          details: { path: absolutePath },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error creating notebook: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
    renderResult: (result) => {
      const d = result.details as { path?: string } | undefined;
      if (d?.path) {
        return new Text(`📓 Notebook: ${d.path}`);
      }
      return new Text("❌ Notebook creation failed");
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Open existing notebook
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "analysis_notebook_open",
    label: "Open Analysis Notebook",
    description: `Open an existing analysis notebook file and restore its state.
This loads the plan, steps, decisions, and checkpoints from the notebook file,
allowing you to resume a previous analysis session.`,
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the notebook file to open"
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const cwd = process.cwd();
        const notebookPath = path.isAbsolute(params.path)
          ? params.path
          : path.join(cwd, params.path);

        const plan = await loadNotebook(notebookPath);

        if (!plan) {
          return {
            content: [{ type: "text", text: `Error: Could not parse notebook at ${notebookPath}` }],
            details: { error: true },
          };
        }

        ensureGitRepo(path.dirname(notebookPath));

        const completed = plan.steps.filter(s => s.status === 'completed').length;
        const inProgress = plan.steps.find(s => s.status === 'in_progress');

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Notebook loaded: ${plan.title}`,
              path: notebookPath,
              planId: plan.id,
              status: plan.status,
              progress: `${completed}/${plan.steps.length} steps completed`,
              currentStep: inProgress?.name || null,
            }, null, 2),
          }],
          details: { path: notebookPath, planId: plan.id },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error opening notebook: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
    renderResult: (result) => {
      const d = result.details as { planId?: string; path?: string } | undefined;
      if (d?.planId) {
        return new Text(`📓 Loaded notebook: ${d.path}`);
      }
      return new Text("❌ Failed to open notebook");
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: List notebooks in directory
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "analysis_notebook_list",
    label: "List Analysis Notebooks",
    description: `List all analysis notebook files in a directory.
Returns title, status, progress, and last updated time for each notebook found.`,
    parameters: Type.Object({
      directory: Type.Optional(Type.String({
        description: "Directory to search for notebooks. Defaults to current working directory."
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const directory = params.directory || process.cwd();
        const notebooks = await findNotebooks(directory);

        if (notebooks.length === 0) {
          return {
            content: [{ type: "text", text: `No analysis notebooks found in ${directory}` }],
            details: { count: 0 },
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: notebooks.length,
              directory,
              notebooks: notebooks.map(n => ({
                path: n.path,
                title: n.title,
                status: n.status,
                progress: `${n.completedSteps}/${n.stepCount} steps`,
                lastUpdated: n.lastUpdated,
              })),
            }, null, 2),
          }],
          details: { count: notebooks.length },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error listing notebooks: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // PHASE MANAGEMENT TOOLS
  // ═══════════════════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Set lifecycle phase
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "analysis_set_phase",
    label: "Set Lifecycle Phase",
    description: `Move the analysis to a different lifecycle phase. The 5 phases are:
- problem_definition: Refining research question, literature review
- data_acquisition: Finding/importing data, creating samplesheets
- analysis: Executing analysis steps (core workflow)
- interpretation: Reviewing results, biological context
- publication: Preparing methods, figures, data sharing`,
    parameters: Type.Object({
      phase: Type.Union([
        Type.Literal("problem_definition"),
        Type.Literal("data_acquisition"),
        Type.Literal("analysis"),
        Type.Literal("interpretation"),
        Type.Literal("publication"),
      ], { description: "Target lifecycle phase" }),
      reason: Type.Optional(Type.String({
        description: "Reason for phase transition"
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const previousPhase = getPhase();
        setPhase(params.phase as LifecyclePhase);

        await syncToNotebook('phase_change', {
          phase: params.phase,
          previousPhase,
          reason: params.reason,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Phase changed to ${params.phase}`,
              previousPhase,
              currentPhase: params.phase,
            }, null, 2),
          }],
          details: { phase: params.phase },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // PHASE 1: PROBLEM DEFINITION TOOLS
  // ═══════════════════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Refine research question
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "research_question_refine",
    label: "Refine Research Question",
    description: `Refine the research question into a testable hypothesis using the PICO framework.
PICO helps structure the question: Population, Intervention, Comparison, Outcome.`,
    parameters: Type.Object({
      hypothesis: Type.String({
        description: "The refined, testable hypothesis"
      }),
      population: Type.Optional(Type.String({
        description: "PICO: What/who is being studied (e.g., 'breast cancer cell lines')"
      })),
      intervention: Type.Optional(Type.String({
        description: "PICO: Treatment/exposure being tested (e.g., 'drug X treatment')"
      })),
      comparison: Type.Optional(Type.String({
        description: "PICO: Control/alternative (e.g., 'untreated control')"
      })),
      outcome: Type.Optional(Type.String({
        description: "PICO: What we're measuring (e.g., 'gene expression changes')"
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const pico = (params.population || params.intervention || params.outcome) ? {
          population: params.population || '',
          intervention: params.intervention || '',
          comparison: params.comparison,
          outcome: params.outcome || '',
        } : undefined;

        const question = setResearchQuestion({
          hypothesis: params.hypothesis,
          pico,
        });

        await syncToNotebook('frontmatter', {
          hypothesis: params.hypothesis,
        });

        logDecision({
          stepId: null,
          type: 'literature_review',
          description: `Research question refined: ${params.hypothesis}`,
          rationale: pico ? `PICO: ${pico.population} | ${pico.intervention} | ${pico.comparison || 'N/A'} | ${pico.outcome}` : 'Hypothesis refined without PICO structure',
          researcherApproved: true,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Research question refined",
              hypothesis: question.hypothesis,
              pico: question.pico,
            }, null, 2),
          }],
          details: { refined: true },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Add literature reference
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "research_add_literature",
    label: "Add Literature Reference",
    description: `Add a literature reference to support the research question or hypothesis.
Use this when finding relevant papers during literature review.`,
    parameters: Type.Object({
      title: Type.String({
        description: "Paper title"
      }),
      relevance: Type.String({
        description: "Why this paper is relevant to the research"
      }),
      pmid: Type.Optional(Type.String({
        description: "PubMed ID"
      })),
      doi: Type.Optional(Type.String({
        description: "Digital Object Identifier"
      })),
      authors: Type.Optional(Type.Array(Type.String(), {
        description: "Author names"
      })),
      year: Type.Optional(Type.Number({
        description: "Publication year"
      })),
      journal: Type.Optional(Type.String({
        description: "Journal name"
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const ref = addLiteratureRef({
          title: params.title,
          relevance: params.relevance,
          pmid: params.pmid,
          doi: params.doi,
          authors: params.authors,
          year: params.year,
          journal: params.journal,
        });

        await syncToNotebook('literature_ref', {
          title: params.title,
          pmid: params.pmid,
          doi: params.doi,
          relevance: params.relevance,
          addedAt: ref.addedAt,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Literature reference added: ${params.title}`,
              reference: ref,
            }, null, 2),
          }],
          details: { added: true },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // PHASE 2: DATA ACQUISITION TOOLS
  // ═══════════════════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Set data source
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "data_set_source",
    label: "Set Data Source",
    description: `Initialize or update data provenance information. Call this when you know
the source of the data (GEO, SRA, local upload, etc.).`,
    parameters: Type.Object({
      source: Type.Union([
        Type.Literal("geo"),
        Type.Literal("sra"),
        Type.Literal("ena"),
        Type.Literal("arrayexpress"),
        Type.Literal("local"),
        Type.Literal("galaxy_shared"),
        Type.Literal("other"),
      ], { description: "Data source type" }),
      accession: Type.Optional(Type.String({
        description: "Accession number (e.g., GSE12345, SRP123456)"
      })),
      downloadDate: Type.Optional(Type.String({
        description: "When data was downloaded (ISO date)"
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const provenance = setDataProvenance({
          source: params.source as DataSource,
          accession: params.accession,
          downloadDate: params.downloadDate || new Date().toISOString().split('T')[0],
        });

        await syncToNotebook('data_provenance', {
          source: params.source,
          accession: params.accession,
          sampleCount: provenance.samples.length,
          fileCount: provenance.originalFiles.length,
        });

        logDecision({
          stepId: null,
          type: 'data_source_selection',
          description: `Data source set: ${params.source}${params.accession ? ` (${params.accession})` : ''}`,
          rationale: 'Data provenance tracking initialized',
          researcherApproved: true,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Data source set to ${params.source}`,
              provenance,
            }, null, 2),
          }],
          details: { source: params.source },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Add sample
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "data_add_sample",
    label: "Add Sample",
    description: `Add a sample to the data provenance. Use this to track individual samples
with their metadata and associated files.`,
    parameters: Type.Object({
      id: Type.String({
        description: "Sample identifier"
      }),
      name: Type.String({
        description: "Sample name"
      }),
      condition: Type.Optional(Type.String({
        description: "Experimental condition (e.g., 'treated', 'control')"
      })),
      replicate: Type.Optional(Type.Number({
        description: "Replicate number"
      })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.String(), {
        description: "Additional metadata key-value pairs"
      })),
      files: Type.Optional(Type.Array(Type.String(), {
        description: "File IDs associated with this sample"
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        addSample({
          id: params.id,
          name: params.name,
          condition: params.condition,
          replicate: params.replicate,
          metadata: params.metadata || {},
          files: params.files || [],
        });

        const plan = getCurrentPlan();

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Sample "${params.name}" added`,
              sampleCount: plan?.dataProvenance?.samples.length || 0,
            }, null, 2),
          }],
          details: { sampleId: params.id },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Add data file
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "data_add_file",
    label: "Add Data File",
    description: `Add a data file to the provenance. Use this to track original files
with their types and pairing information.`,
    parameters: Type.Object({
      id: Type.String({
        description: "File identifier"
      }),
      name: Type.String({
        description: "File name"
      }),
      type: Type.Union([
        Type.Literal("fastq"),
        Type.Literal("bam"),
        Type.Literal("vcf"),
        Type.Literal("counts"),
        Type.Literal("annotation"),
        Type.Literal("reference"),
        Type.Literal("other"),
      ], { description: "File type" }),
      format: Type.Optional(Type.String({
        description: "File format (e.g., fastq.gz, bam)"
      })),
      size: Type.Optional(Type.Number({
        description: "File size in bytes"
      })),
      readType: Type.Optional(Type.Union([
        Type.Literal("single"),
        Type.Literal("paired"),
      ], { description: "Read type for sequencing data" })),
      pairedWith: Type.Optional(Type.String({
        description: "ID of mate file for paired reads (R1 <-> R2)"
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        addDataFile({
          id: params.id,
          name: params.name,
          type: params.type as DataFileType,
          format: params.format,
          size: params.size,
          readType: params.readType,
          pairedWith: params.pairedWith,
        });

        const plan = getCurrentPlan();

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `File "${params.name}" added`,
              fileCount: plan?.dataProvenance?.originalFiles.length || 0,
            }, null, 2),
          }],
          details: { fileId: params.id },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Link file to Galaxy dataset
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "data_link_galaxy",
    label: "Link File to Galaxy",
    description: `Link a tracked data file to its Galaxy dataset ID after import.
Use this after importing data into Galaxy to maintain the provenance chain.`,
    parameters: Type.Object({
      fileId: Type.String({
        description: "The file ID in our provenance tracking"
      }),
      galaxyDatasetId: Type.String({
        description: "The Galaxy dataset ID"
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const file = updateDataFile(params.fileId, {
          galaxyDatasetId: params.galaxyDatasetId,
        });

        if (!file) {
          return {
            content: [{ type: "text", text: `File ${params.fileId} not found` }],
            details: { error: true },
          };
        }

        // Add Galaxy reference to notebook
        const plan = getCurrentPlan();
        if (plan?.galaxy.serverUrl) {
          await syncToNotebook('galaxy_ref', {
            resource: file.name,
            id: params.galaxyDatasetId,
            url: `${plan.galaxy.serverUrl}/datasets/${params.galaxyDatasetId}`,
          });
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `File "${file.name}" linked to Galaxy dataset ${params.galaxyDatasetId}`,
            }, null, 2),
          }],
          details: { linked: true },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Generate samplesheet
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "data_generate_samplesheet",
    label: "Generate Samplesheet",
    description: `Generate a samplesheet from tracked samples and files. The samplesheet
can be used for nf-core pipelines or Galaxy workflows that need structured input.`,
    parameters: Type.Object({
      format: Type.Union([
        Type.Literal("csv"),
        Type.Literal("tsv"),
      ], { description: "Output format", default: "csv" }),
      columns: Type.Array(Type.String(), {
        description: "Column names to include (e.g., ['sample', 'fastq_1', 'fastq_2', 'condition'])"
      }),
      includeMetadata: Type.Boolean({
        description: "Include sample metadata columns",
        default: true
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const plan = getCurrentPlan();
        if (!plan?.dataProvenance) {
          return {
            content: [{ type: "text", text: "No data provenance set. Use data_set_source first." }],
            details: { error: true },
          };
        }

        const dp = plan.dataProvenance;
        const rows: Record<string, string>[] = [];

        // Build rows from samples
        for (const sample of dp.samples) {
          const row: Record<string, string> = {
            sample: sample.id,
          };

          // Find associated files
          const sampleFiles = dp.originalFiles.filter(f => sample.files.includes(f.id));
          const r1 = sampleFiles.find(f => f.name.includes('_R1') || f.name.includes('_1.'));
          const r2 = sampleFiles.find(f => f.name.includes('_R2') || f.name.includes('_2.'));

          if (r1) row['fastq_1'] = r1.galaxyDatasetId || r1.name;
          if (r2) row['fastq_2'] = r2.galaxyDatasetId || r2.name;

          if (sample.condition) row['condition'] = sample.condition;
          if (sample.replicate !== undefined) row['replicate'] = String(sample.replicate);

          // Include metadata if requested
          if (params.includeMetadata) {
            Object.assign(row, sample.metadata);
          }

          rows.push(row);
        }

        // Store samplesheet
        const samplesheet = {
          format: params.format as 'csv' | 'tsv',
          columns: params.columns,
          rows,
          generatedAt: new Date().toISOString(),
        };
        plan.dataProvenance.samplesheet = samplesheet;
        plan.updated = new Date().toISOString();

        // Generate text representation
        const delimiter = params.format === 'csv' ? ',' : '\t';
        const header = params.columns.join(delimiter);
        const dataRows = rows.map(row =>
          params.columns.map(col => row[col] || '').join(delimiter)
        );
        const content = [header, ...dataRows].join('\n');

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Samplesheet generated with ${rows.length} samples`,
              format: params.format,
              columns: params.columns,
              sampleCount: rows.length,
              content,
            }, null, 2),
          }],
          details: { generated: true, sampleCount: rows.length },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Get data provenance summary
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "data_get_provenance",
    label: "Get Data Provenance",
    description: `Get the current data provenance information including source, samples, files, and samplesheet.`,
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const plan = getCurrentPlan();

      if (!plan?.dataProvenance) {
        return {
          content: [{ type: "text", text: "No data provenance set. Use data_set_source to initialize." }],
          details: { hasProvenance: false },
        };
      }

      const dp = plan.dataProvenance;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            source: dp.source,
            accession: dp.accession,
            downloadDate: dp.downloadDate,
            sampleCount: dp.samples.length,
            fileCount: dp.originalFiles.length,
            samples: dp.samples.map(s => ({
              id: s.id,
              name: s.name,
              condition: s.condition,
              fileCount: s.files.length,
            })),
            files: dp.originalFiles.map(f => ({
              id: f.id,
              name: f.name,
              type: f.type,
              galaxyLinked: !!f.galaxyDatasetId,
            })),
            hasSamplesheet: !!dp.samplesheet,
          }, null, 2),
        }],
        details: { hasProvenance: true },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // PHASE 4: INTERPRETATION TOOLS
  // ═══════════════════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Add a biological finding
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "interpretation_add_finding",
    label: "Add Biological Finding",
    description: `Log a biological finding from the analysis. Use this during the interpretation
phase to record discoveries, observations, and conclusions drawn from the analysis results.
Each finding captures what was found, the supporting evidence, and confidence level.`,
    parameters: Type.Object({
      title: Type.String({
        description: "Brief title for the finding (e.g., 'TP53 pathway upregulated in treated samples')"
      }),
      description: Type.String({
        description: "Detailed description of the finding"
      }),
      evidence: Type.String({
        description: "What data or results support this finding"
      }),
      category: Type.Union([
        Type.Literal("differential_expression"),
        Type.Literal("pathway"),
        Type.Literal("variant"),
        Type.Literal("structural"),
        Type.Literal("functional"),
        Type.Literal("unexpected"),
        Type.Literal("negative"),
        Type.Literal("other"),
      ], { description: "Category of finding" }),
      relatedSteps: Type.Array(Type.String(), {
        description: "Step IDs that produced the evidence for this finding",
        default: []
      }),
      confidence: Type.Union([
        Type.Literal("high"),
        Type.Literal("medium"),
        Type.Literal("low"),
        Type.Literal("uncertain"),
      ], { description: "Confidence level in this finding" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const finding = addFinding({
          title: params.title,
          description: params.description,
          evidence: params.evidence,
          category: params.category as FindingCategory,
          relatedSteps: params.relatedSteps || [],
          confidence: params.confidence as 'high' | 'medium' | 'low' | 'uncertain',
        });

        // Sync to notebook
        await syncToNotebook('interpretation_finding', {
          finding,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Finding "${finding.title}" recorded`,
              findingId: finding.id,
              totalFindings: getFindings().length,
            }, null, 2),
          }],
          details: { findingId: finding.id },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
    renderResult: (result) => {
      const d = result.details as { findingId?: string } | undefined;
      return new Text(`🔬 Finding recorded: ${d?.findingId || 'unknown'}`);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Summarize interpretation
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "interpretation_summarize",
    label: "Summarize Interpretation",
    description: `Set an overall interpretation summary for the analysis. This captures the
high-level conclusions from all findings. Returns the full list of findings for review.`,
    parameters: Type.Object({
      summary: Type.String({
        description: "Overall interpretation summary covering key conclusions from the analysis"
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        setInterpretationSummary(params.summary);
        const findings = getFindings();

        // Sync to notebook
        await syncToNotebook('interpretation_summary', {
          summary: params.summary,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Interpretation summary set",
              summary: params.summary,
              findings: findings.map(f => ({
                id: f.id,
                title: f.title,
                category: f.category,
                confidence: f.confidence,
              })),
              totalFindings: findings.length,
            }, null, 2),
          }],
          details: { findingCount: findings.length },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // PHASE 5: PUBLICATION TOOLS
  // ═══════════════════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Initialize publication prep
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "publication_init",
    label: "Initialize Publication",
    description: `Initialize publication preparation. Call this when starting to prepare
materials for publication.`,
    parameters: Type.Object({
      targetJournal: Type.Optional(Type.String({
        description: "Target journal for submission"
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const pub = initPublication(params.targetJournal);

        await syncToNotebook('publication_update', {
          updateType: 'initialized',
          status: pub.status,
          description: params.targetJournal ? `Target: ${params.targetJournal}` : 'Publication prep started',
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Publication preparation initialized",
              targetJournal: params.targetJournal,
              status: pub.status,
            }, null, 2),
          }],
          details: { initialized: true },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Generate methods section
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "publication_generate_methods",
    label: "Generate Methods",
    description: `Generate a methods section from the completed analysis steps.
Extracts tool IDs, parameters, and creates structured methods text.`,
    parameters: Type.Object({
      includeVersions: Type.Boolean({
        description: "Attempt to include tool versions",
        default: true
      }),
      style: Type.Optional(Type.Union([
        Type.Literal("narrative"),
        Type.Literal("structured"),
      ], { description: "Methods style: narrative prose or structured sections" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const methods = generateMethods();
        const plan = getCurrentPlan();

        await syncToNotebook('publication_update', {
          updateType: 'methods_generated',
          status: plan?.publication?.status,
          description: `${methods.toolVersions.length} tools documented`,
        });

        logDecision({
          stepId: null,
          type: 'publication_choice',
          description: 'Methods section generated from analysis steps',
          rationale: `Extracted ${methods.toolVersions.length} tool references`,
          researcherApproved: true,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Methods section generated",
              generatedAt: methods.generatedAt,
              toolCount: methods.toolVersions.length,
              text: methods.text,
              tools: methods.toolVersions.map(t => ({
                toolId: t.toolId,
                toolName: t.toolName,
                stepId: t.stepId,
              })),
            }, null, 2),
          }],
          details: { generated: true },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Add figure specification
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "publication_add_figure",
    label: "Add Figure",
    description: `Add a figure specification for publication. Use this to track planned
and generated figures.`,
    parameters: Type.Object({
      name: Type.String({
        description: "Figure name (e.g., 'Figure 1: PCA plot')"
      }),
      type: Type.Union([
        Type.Literal("qc_plot"),
        Type.Literal("pca"),
        Type.Literal("heatmap"),
        Type.Literal("volcano"),
        Type.Literal("ma_plot"),
        Type.Literal("pathway"),
        Type.Literal("coverage"),
        Type.Literal("alignment"),
        Type.Literal("custom"),
      ], { description: "Figure type" }),
      dataSource: Type.String({
        description: "Step ID or dataset ID that this figure is based on"
      }),
      description: Type.Optional(Type.String({
        description: "Figure description/caption"
      })),
      suggestedTool: Type.Optional(Type.String({
        description: "Galaxy tool ID for generating this figure"
      })),
      status: Type.Optional(Type.Union([
        Type.Literal("planned"),
        Type.Literal("generated"),
        Type.Literal("finalized"),
      ], { description: "Current figure status" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const figure = addFigure({
          name: params.name,
          type: params.type as FigureType,
          dataSource: params.dataSource,
          description: params.description,
          suggestedTool: params.suggestedTool,
          status: params.status || 'planned',
        });

        await syncToNotebook('publication_update', {
          updateType: 'figure_added',
          figureId: figure.id,
          description: params.name,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Figure "${params.name}" added`,
              figure,
            }, null, 2),
          }],
          details: { figureId: figure.id },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Update figure status
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "publication_update_figure",
    label: "Update Figure",
    description: `Update a figure's status or link it to a Galaxy dataset.`,
    parameters: Type.Object({
      figureId: Type.String({
        description: "Figure ID to update"
      }),
      status: Type.Optional(Type.Union([
        Type.Literal("planned"),
        Type.Literal("generated"),
        Type.Literal("finalized"),
      ], { description: "New status" })),
      galaxyDatasetId: Type.Optional(Type.String({
        description: "Galaxy dataset ID of the generated figure"
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const figure = updateFigure(params.figureId, {
          status: params.status,
          galaxyDatasetId: params.galaxyDatasetId,
        });

        if (!figure) {
          return {
            content: [{ type: "text", text: `Figure ${params.figureId} not found` }],
            details: { error: true },
          };
        }

        await syncToNotebook('publication_update', {
          updateType: 'figure_updated',
          figureId: params.figureId,
          status: params.status,
        });

        // Add Galaxy reference if dataset provided
        if (params.galaxyDatasetId) {
          const plan = getCurrentPlan();
          if (plan?.galaxy.serverUrl) {
            await syncToNotebook('galaxy_ref', {
              resource: figure.name,
              id: params.galaxyDatasetId,
              url: `${plan.galaxy.serverUrl}/datasets/${params.galaxyDatasetId}`,
            });
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Figure "${figure.name}" updated`,
              figure,
            }, null, 2),
          }],
          details: { updated: true },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Recommend figures
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "publication_recommend_figures",
    label: "Recommend Figures",
    description: `Get figure recommendations based on the analysis type and completed steps.
Returns suggested figures with Galaxy tools that can generate them.`,
    parameters: Type.Object({
      analysisType: Type.Optional(Type.Union([
        Type.Literal("rnaseq"),
        Type.Literal("variant_calling"),
        Type.Literal("chipseq"),
        Type.Literal("atacseq"),
        Type.Literal("singlecell"),
        Type.Literal("general"),
      ], { description: "Type of analysis for targeted recommendations" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const plan = getCurrentPlan();
      const analysisType = params.analysisType || 'general';

      // Figure recommendations by analysis type
      const recommendations: Record<string, Array<{name: string; type: FigureType; description: string; tool?: string}>> = {
        rnaseq: [
          { name: 'QC Summary', type: 'qc_plot', description: 'MultiQC report summarizing sample quality', tool: 'multiqc' },
          { name: 'PCA Plot', type: 'pca', description: 'Principal component analysis of samples', tool: 'deseq2' },
          { name: 'Sample Heatmap', type: 'heatmap', description: 'Hierarchical clustering of samples', tool: 'deseq2' },
          { name: 'Volcano Plot', type: 'volcano', description: 'Log fold change vs significance', tool: 'volcanoplot' },
          { name: 'MA Plot', type: 'ma_plot', description: 'Log ratio vs average expression', tool: 'deseq2' },
          { name: 'Gene Expression Heatmap', type: 'heatmap', description: 'Top DE genes across samples', tool: 'heatmap2' },
        ],
        variant_calling: [
          { name: 'QC Summary', type: 'qc_plot', description: 'MultiQC report for alignment and variant QC', tool: 'multiqc' },
          { name: 'Coverage Plot', type: 'coverage', description: 'Read depth across regions of interest' },
          { name: 'Variant Quality Distribution', type: 'qc_plot', description: 'Distribution of variant quality scores' },
          { name: 'Alignment Statistics', type: 'alignment', description: 'Mapping rate, duplication, insert size' },
        ],
        singlecell: [
          { name: 'QC Violin Plots', type: 'qc_plot', description: 'nGenes, nCounts, percent mito per cell' },
          { name: 'UMAP/t-SNE', type: 'pca', description: 'Dimensionality reduction of cells' },
          { name: 'Cluster Markers Heatmap', type: 'heatmap', description: 'Top markers per cluster' },
          { name: 'Cell Type Composition', type: 'custom', description: 'Bar plot of cell type proportions' },
        ],
        general: [
          { name: 'QC Summary', type: 'qc_plot', description: 'MultiQC report', tool: 'multiqc' },
          { name: 'PCA Plot', type: 'pca', description: 'Principal component analysis' },
          { name: 'Heatmap', type: 'heatmap', description: 'Hierarchical clustering visualization' },
        ],
      };

      const figures = recommendations[analysisType] || recommendations.general;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            analysisType,
            completedSteps: plan?.steps.filter(s => s.status === 'completed').length || 0,
            recommendations: figures,
            note: "Use publication_add_figure to add these to your publication plan",
          }, null, 2),
        }],
        details: { recommendationCount: figures.length },
      };
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Get publication status
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "publication_get_status",
    label: "Get Publication Status",
    description: `Get the current publication preparation status including methods, figures, and data sharing info.`,
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const plan = getCurrentPlan();

      if (!plan?.publication) {
        return {
          content: [{ type: "text", text: "Publication preparation not started. Use publication_init first." }],
          details: { hasPublication: false },
        };
      }

      const pub = plan.publication;
      const figureStats = {
        total: pub.figures.length,
        planned: pub.figures.filter(f => f.status === 'planned').length,
        generated: pub.figures.filter(f => f.status === 'generated').length,
        finalized: pub.figures.filter(f => f.status === 'finalized').length,
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: pub.status,
            targetJournal: pub.targetJournal,
            hasMethods: !!pub.methodsDraft,
            methodsToolCount: pub.methodsDraft?.toolVersions.length || 0,
            figures: figureStats,
            figureList: pub.figures.map(f => ({
              id: f.id,
              name: f.name,
              type: f.type,
              status: f.status,
            })),
            supplementaryCount: pub.supplementaryData.length,
            dataSharing: pub.dataSharing,
          }, null, 2),
        }],
        details: { hasPublication: true },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // GTN TUTORIAL DISCOVERY & FETCH
  // ═══════════════════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Search/browse GTN topics and tutorials
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gtn_search",
    label: "Search GTN Tutorials",
    description: `Browse GTN topics and discover tutorials. Call with no arguments to list all
topics. Provide a topic ID to list its tutorials. Use query to filter tutorials by keyword
in their title or objectives. Use this to find tutorial URLs before fetching with gtn_fetch.`,
    parameters: Type.Object({
      topic: Type.Optional(Type.String({
        description: "Topic ID to list tutorials for (e.g., 'transcriptomics', 'introduction')"
      })),
      query: Type.Optional(Type.String({
        description: "Keyword to filter tutorials by title or objectives (case-insensitive)"
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const GTN_API = "https://training.galaxyproject.org/training-material/api";

      try {
        if (!params.topic) {
          // List all topics
          const resp = await fetch(`${GTN_API}/topics.json`, { signal });
          if (!resp.ok) {
            return {
              content: [{ type: "text", text: `Error: GTN API returned HTTP ${resp.status}` }],
              details: { error: true },
            };
          }

          const data = await resp.json() as Record<string, { name: string; title: string; summary: string }>;
          const topics = Object.values(data).map((t) => ({
            name: t.name,
            title: t.title,
            summary: t.summary,
          }));

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                count: topics.length,
                topics,
                hint: "Use gtn_search with a topic name to list its tutorials.",
              }, null, 2),
            }],
            details: { count: topics.length },
          };
        }

        // List tutorials in a topic
        const resp = await fetch(`${GTN_API}/topics/${params.topic}.json`, { signal });
        if (!resp.ok) {
          return {
            content: [{
              type: "text",
              text: `Error: Topic "${params.topic}" not found (HTTP ${resp.status}). Use gtn_search with no arguments to list available topics.`,
            }],
            details: { error: true },
          };
        }

        const topicData = await resp.json() as {
          name: string;
          title: string;
          materials: Array<{
            title: string;
            url: string;
            id: string;
            level: string;
            time_estimation: string;
            objectives: string[];
            key_points: string[];
            tools: string[];
            workflows: unknown[];
          }>;
        };

        let tutorials = (topicData.materials || []).map((m) => ({
          title: m.title,
          url: `https://training.galaxyproject.org${m.url}`,
          id: m.id,
          level: m.level,
          time_estimation: m.time_estimation,
          objectives: m.objectives || [],
        }));

        if (params.query) {
          const q = params.query.toLowerCase();
          tutorials = tutorials.filter((t) =>
            t.title.toLowerCase().includes(q) ||
            t.objectives.some((o) => o.toLowerCase().includes(q))
          );
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              topic: topicData.title,
              count: tutorials.length,
              ...(params.query ? { query: params.query } : {}),
              tutorials,
              hint: "Use gtn_fetch with a tutorial URL to read its full content.",
            }, null, 2),
          }],
          details: { topic: params.topic, count: tutorials.length },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error searching GTN: ${msg}` }],
          details: { error: true },
        };
      }
    },
    renderResult: (result) => {
      const d = result.details as { count?: number; topic?: string; error?: boolean } | undefined;
      if (d?.error) {
        return new Text("❌ GTN search failed");
      }
      if (d?.topic) {
        return new Text(`📚 Found ${d.count || 0} tutorials in "${d.topic}"`);
      }
      return new Text(`📚 Found ${d?.count || 0} GTN topics`);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Fetch GTN tutorial content
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gtn_fetch",
    label: "Fetch GTN Tutorial",
    description: `Fetch a Galaxy Training Network (GTN) tutorial page and return its content as
readable text. Only URLs on training.galaxyproject.org are allowed. Use gtn_search first to
discover valid tutorial URLs — do not guess or construct URLs. Use this to read tutorial
instructions, tool names, parameters, and workflow steps so you can follow along and reproduce
analyses in Galaxy.`,
    parameters: Type.Object({
      url: Type.String({
        description: "URL of the GTN tutorial page (must be on training.galaxyproject.org)"
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const GTN_HOST = "training.galaxyproject.org";

      let parsed: URL;
      try {
        parsed = new URL(params.url);
      } catch {
        return {
          content: [{ type: "text", text: `Error: Invalid URL "${params.url}"` }],
          details: { error: true },
        };
      }

      if (parsed.hostname !== GTN_HOST) {
        return {
          content: [{
            type: "text",
            text: `Error: Only URLs on ${GTN_HOST} are allowed. Got: ${parsed.hostname}`,
          }],
          details: { error: true },
        };
      }

      try {
        const response = await fetch(params.url, { signal });

        if (!response.ok) {
          return {
            content: [{
              type: "text",
              text: `Error: Failed to fetch tutorial (HTTP ${response.status})`,
            }],
            details: { error: true },
          };
        }

        const html = await response.text();

        // Strip blocks that contribute nothing but noise
        const stripped = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[\s\S]*?<\/nav>/gi, '')
          .replace(/<header[\s\S]*?<\/header>/gi, '')
          .replace(/<footer[\s\S]*?<\/footer>/gi, '');

        // Try to extract the main tutorial content area
        let body = stripped;
        const mainMatch = stripped.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i)
          || stripped.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i)
          || stripped.match(/<div[^>]+class="[^"]*tutorial-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
        if (mainMatch) {
          body = mainMatch[1];
        }

        // Remove remaining HTML tags
        let text = body.replace(/<[^>]+>/g, ' ');

        // Decode common HTML entities
        text = text
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, ' ')
          .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));

        // Normalize whitespace
        text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

        return {
          content: [{
            type: "text",
            text,
          }],
          details: { url: params.url, length: text.length },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error fetching tutorial: ${msg}` }],
          details: { error: true },
        };
      }
    },
    renderResult: (result) => {
      const d = result.details as { url?: string; length?: number; error?: boolean } | undefined;
      if (d?.error) {
        return new Text("❌ GTN fetch failed");
      }
      return new Text(`📖 Fetched GTN tutorial (${d?.length || 0} chars)`);
    },
  });
}
