/**
 * Custom tool registrations for Galaxy analysis plan management
 *
 * These tools are registered with Pi and available for the LLM to call.
 * They manage the analysis plan state and provide orchestration capabilities.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
} from "./state";
import type { StepStatus, StepResult, DecisionType, CheckpointStatus, DatasetReference } from "./types";
import * as path from "path";

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
      const lines = [
        `✅ Analysis plan created`,
        `   ID: ${result.details?.planId || 'unknown'}`,
      ];
      if (result.details?.notebookPath) {
        lines.push(`   📓 Notebook: ${result.details.notebookPath}`);
      }
      return lines;
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
      const status = result.details?.status;
      const icon = status === 'passed' ? '✅' : status === 'failed' ? '❌' : '⏸️';
      return [`${icon} QC Checkpoint: ${status}`];
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
      if (result.details?.path) {
        return [`📓 Notebook: ${result.details.path}`];
      }
      return ["❌ Notebook creation failed"];
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
      if (result.details?.planId) {
        return [`📓 Loaded notebook: ${result.details.path}`];
      }
      return ["❌ Failed to open notebook"];
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
}
