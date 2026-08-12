/**
 * Loom-extension-specific tool registrations.
 *
 * Plans, steps, and decisions live as markdown sections inside the project
 * notebook (`notebook.md`) — the agent maintains them via the generic
 * Edit/Write tools. The only tools registered here are:
 *   - GTN tutorial discovery / fetch
 *   - Galaxy invocation tracking (record + poll status from the notebook)
 *   - Galaxy skills fetch (operational know-how from galaxyproject/galaxy-skills)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { getNotebookPath } from "./state";
import {
  readNotebook,
  writeNotebook,
  withNotebookLock,
  findInvocationBlocks,
  upsertInvocationBlock,
  applyInvocationUpdates,
  statNotebook,
  NotebookChangedError,
  type InvocationYaml,
  type InvocationPollUpdate,
} from "./notebook-writer";
import { upsertJobBlock, type JobYaml } from "./galaxy-job-block";
import { getGalaxyConfig, galaxyGet, type GalaxyInvocationResponse } from "./galaxy-api";
import { listEnabledSkillRepos, findSkillRepo } from "./skills";
import { fetchSkillFile, githubRawBase } from "./skills-discovery";
import { parse as parseHtml } from "node-html-parser";

/**
 * Strip a GTN tutorial HTML document down to readable plain text.
 *
 * Replaces the prior regex-based stripper, which could be defeated by
 * malformed HTML (e.g. an unterminated `<script` tag would leak its
 * contents through the `<script>...</script>` regex). Using a real
 * parser closes that gap and is more robust to GTN page-layout drift.
 */
function stripGtnHtml(html: string): string {
  const root = parseHtml(html, {
    blockTextElements: { script: false, style: false, noscript: false, code: true, pre: true },
  });
  // Drop chrome we don't want in the agent's context.
  for (const sel of ["script", "style", "nav", "header", "footer", "aside", "noscript"]) {
    for (const el of root.querySelectorAll(sel)) el.remove();
  }
  // Pick the most-specific body region available.
  const body =
    root.querySelector("main") ||
    root.querySelector("article") ||
    root.querySelector(".tutorial-content") ||
    root.querySelector("body") ||
    root;
  let text = body.textContent || "";
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

export function registerPlanTools(pi: ExtensionAPI): void {
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
      topic: Type.Optional(
        Type.String({
          description: "Topic ID to list tutorials for (e.g., 'transcriptomics', 'introduction')",
        }),
      ),
      query: Type.Optional(
        Type.String({
          description: "Keyword to filter tutorials by title or objectives (case-insensitive)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const GTN_API = "https://training.galaxyproject.org/training-material/api";

      try {
        if (!params.topic) {
          const resp = await fetch(`${GTN_API}/topics.json`, { signal });
          if (!resp.ok) {
            return {
              content: [{ type: "text", text: `Error: GTN API returned HTTP ${resp.status}` }],
              details: { error: true },
            };
          }

          const data = (await resp.json()) as Record<
            string,
            { name: string; title: string; summary: string }
          >;
          const topics = Object.values(data).map((t) => ({
            name: t.name,
            title: t.title,
            summary: t.summary,
          }));

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    count: topics.length,
                    topics,
                    hint: "Use gtn_search with a topic name to list its tutorials.",
                  },
                  null,
                  2,
                ),
              },
            ],
            details: { count: topics.length },
          };
        }

        const resp = await fetch(`${GTN_API}/topics/${params.topic}.json`, { signal });
        if (!resp.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Topic "${params.topic}" not found (HTTP ${resp.status}). Use gtn_search with no arguments to list available topics.`,
              },
            ],
            details: { error: true },
          };
        }

        const topicData = (await resp.json()) as {
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
          tutorials = tutorials.filter(
            (t) =>
              t.title.toLowerCase().includes(q) ||
              t.objectives.some((o) => o.toLowerCase().includes(q)),
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  topic: topicData.title,
                  count: tutorials.length,
                  ...(params.query ? { query: params.query } : {}),
                  tutorials,
                  hint: "Use gtn_fetch with a tutorial URL to read its full content.",
                },
                null,
                2,
              ),
            },
          ],
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
        description: "URL of the GTN tutorial page (must be on training.galaxyproject.org)",
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
          content: [
            {
              type: "text",
              text: `Error: Only URLs on ${GTN_HOST} are allowed. Got: ${parsed.hostname}`,
            },
          ],
          details: { error: true },
        };
      }

      try {
        const response = await fetch(params.url, { signal });

        if (!response.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Failed to fetch tutorial (HTTP ${response.status})`,
              },
            ],
            details: { error: true },
          };
        }

        const html = await response.text();
        const text = stripGtnHtml(html);

        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Fetch a SKILL.md or reference doc from a configured skills repo
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "skills_fetch",
    label: "Fetch Skill",
    description: `Fetch operational know-how from a configured skills repo. The
system prompt's "Skills repositories" section lists the available repos and the
canonical paths inside each. Results are cached locally for 24h. If \`repo\` is
omitted, the first enabled repo is used (typically \`galaxy-skills\`).`,
    parameters: Type.Object({
      repo: Type.Optional(
        Type.String({
          description:
            "Name of the skills repo to fetch from (e.g. 'galaxy-skills'). " +
            "Omit to use the default (first enabled repo).",
        }),
      ),
      path: Type.String({
        description:
          "Relative path inside the repo, e.g. 'collection-manipulation/SKILL.md', " +
          "'galaxy-integration/mcp-reference/gotchas.md'.",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const repo = findSkillRepo(params.repo);
      if (!repo) {
        const enabled =
          listEnabledSkillRepos()
            .map((r) => r.name)
            .join(", ") || "(none)";
        return {
          content: [
            {
              type: "text",
              text: params.repo
                ? `Error: Skills repo "${params.repo}" is not configured or is disabled. Enabled: ${enabled}.`
                : `Error: No skills repos are enabled. Configure one in Preferences → Skills.`,
            },
          ],
          details: { error: true },
        };
      }

      const cleanPath = params.path.replace(/^\/+/, "").replace(/\\/g, "/");
      if (cleanPath.includes("..") || cleanPath === "") {
        return {
          content: [{ type: "text", text: `Error: Invalid skill path "${params.path}"` }],
          details: { error: true },
        };
      }

      const rawBase = githubRawBase(repo.url, repo.branch);
      if (!rawBase) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Repo URL "${repo.url}" must be a GitHub repo (https://github.com/<owner>/<repo>).`,
            },
          ],
          details: { error: true },
        };
      }

      const res = await fetchSkillFile(repo, cleanPath, signal);
      if (!res.ok) {
        if (res.status) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Error: Failed to fetch "${cleanPath}" from ${repo.name} (HTTP ${res.status}). ` +
                  `Check the path against the skills router in the system prompt.`,
              },
            ],
            details: { error: true, repo: repo.name, path: cleanPath },
          };
        }
        return {
          content: [{ type: "text", text: `Error fetching skill: ${res.error}` }],
          details: { error: true, repo: repo.name, path: cleanPath },
        };
      }
      return {
        content: [{ type: "text", text: res.text }],
        details: { repo: repo.name, path: cleanPath, length: res.text.length, cached: res.cached },
      };
    },
    renderResult: (result) => {
      const d = result.details as
        | { repo?: string; path?: string; length?: number; cached?: boolean; error?: boolean }
        | undefined;
      if (d?.error) return new Text("❌ Skill fetch failed");
      const tag = d?.cached ? "(cached)" : "(fetched)";
      return new Text(`📘 ${d?.repo}/${d?.path} ${tag} (${d?.length || 0} chars)`);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Record a Galaxy invocation in the notebook
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "galaxy_invocation_record",
    label: "Record Galaxy Invocation",
    description: `Record a Galaxy workflow invocation in the project notebook so its progress
can be tracked. Call right after invoking a workflow via Galaxy MCP (galaxy_invoke_workflow).
Writes a fenced \`loom-invocation\` YAML block at the end of the notebook. Polling later
(galaxy_invocation_check_all / galaxy_invocation_check_one) updates the block in place.`,
    parameters: Type.Object({
      invocationId: Type.String({
        description: "Galaxy invocation ID returned from galaxy_invoke_workflow",
      }),
      notebookAnchor: Type.String({
        description: "Stable anchor where this invocation lives, e.g. 'plan-1-step-3'",
      }),
      label: Type.String({
        description: "Human-readable description for status display, e.g. 'BWA alignment'",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const notebookPath = getNotebookPath();
      if (!notebookPath) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ success: false, error: "No notebook open." }) },
          ],
          details: { error: true } as Record<string, unknown>,
        };
      }

      const cfg = getGalaxyConfig();
      const galaxyServerUrl = cfg?.url || "";

      try {
        const inv: InvocationYaml = {
          invocationId: params.invocationId,
          galaxyServerUrl,
          notebookAnchor: params.notebookAnchor,
          label: params.label,
          submittedAt: new Date().toISOString(),
          status: "in_progress",
        };
        await withNotebookLock(notebookPath, async () => {
          const content = await readNotebook(notebookPath);
          const updated = upsertInvocationBlock(content, inv);
          await writeNotebook(notebookPath, updated);
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  invocationId: inv.invocationId,
                  notebookAnchor: inv.notebookAnchor,
                  label: inv.label,
                  status: inv.status,
                  message: `Recorded invocation ${inv.invocationId} (${inv.label}) at ${inv.notebookAnchor}.`,
                },
                null,
                2,
              ),
            },
          ],
          details: { invocationId: inv.invocationId, notebookAnchor: inv.notebookAnchor } as Record<
            string,
            unknown
          >,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: msg }) }],
          details: { error: true } as Record<string, unknown>,
        };
      }
    },
    renderResult: (result) => {
      const d = result.details as
        { invocationId?: string; notebookAnchor?: string; error?: boolean } | undefined;
      if (d?.error) return new Text("❌ Failed to record invocation");
      return new Text(`🔗 Invocation ${d?.invocationId} → ${d?.notebookAnchor}`);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Record a Galaxy tool run (job) in the notebook
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "galaxy_job_record",
    label: "Record Galaxy Job",
    description: `Record a Galaxy TOOL run in the project notebook so its progress is tracked in
the background. Call right after submitting a tool via Galaxy MCP (galaxy_run_tool), the same way
galaxy_invocation_record is called after invoking a workflow. Without this the run is invisible to
the background poller: nothing advances its status and nothing notifies anyone when it finishes.
Writes a fenced \`loom-job\` YAML block; the poller updates it in place.`,
    parameters: Type.Object({
      jobId: Type.String({ description: "Galaxy job ID returned from galaxy_run_tool" }),
      notebookAnchor: Type.String({
        description: "Stable anchor where this run lives, e.g. 'plan-1-step-3'",
      }),
      label: Type.String({
        description: "Human-readable description for status display, e.g. 'BWA alignment'",
      }),
      toolId: Type.Optional(
        Type.String({ description: "Galaxy tool id, e.g. 'bwa_mem' — shown if no label fits" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const notebookPath = getNotebookPath();
      if (!notebookPath) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ success: false, error: "No notebook open." }) },
          ],
          details: { error: true } as Record<string, unknown>,
        };
      }

      const cfg = getGalaxyConfig();
      try {
        const job: JobYaml = {
          jobId: params.jobId,
          galaxyServerUrl: cfg?.url || "",
          notebookAnchor: params.notebookAnchor,
          label: params.label,
          toolId: params.toolId,
          submittedAt: new Date().toISOString(),
          status: "in_progress",
        };
        await withNotebookLock(notebookPath, async () => {
          const content = await readNotebook(notebookPath);
          await writeNotebook(notebookPath, upsertJobBlock(content, job));
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  jobId: job.jobId,
                  notebookAnchor: job.notebookAnchor,
                  label: job.label,
                  status: job.status,
                  message: `Recorded job ${job.jobId} (${job.label}) at ${job.notebookAnchor}. The background poller will advance it and notify on completion.`,
                },
                null,
                2,
              ),
            },
          ],
          details: { jobId: job.jobId, notebookAnchor: job.notebookAnchor } as Record<
            string,
            unknown
          >,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: msg }) }],
          details: { error: true } as Record<string, unknown>,
        };
      }
    },
    renderResult: (result) => {
      const d = result.details as { jobId?: string; notebookAnchor?: string; error?: boolean } | undefined;
      if (d?.error) return new Text("❌ Failed to record job");
      return new Text(`🔗 Job ${d?.jobId} → ${d?.notebookAnchor}`);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Poll all in-flight invocations and update notebook YAML
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "galaxy_invocation_check_all",
    label: "Check All Galaxy Invocations",
    description: `Scan the notebook for in-flight loom-invocation blocks, poll Galaxy for each,
and apply deterministic state transitions (all-jobs-ok → completed, any-error → failed,
otherwise still in_progress). Updates the YAML blocks in place. Returns a summary list.`,
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, _ctx) {
      return await checkInvocations(undefined, signal);
    },
    renderResult: (result) => {
      const d = result.details as { checked?: number; error?: boolean } | undefined;
      if (d?.error) return new Text("❌ Invocation check failed");
      return new Text(`🔍 Checked ${d?.checked || 0} invocation(s)`);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Poll one invocation by id
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "galaxy_invocation_check_one",
    label: "Check Galaxy Invocation",
    description: `Poll a single Galaxy invocation by id. Same auto-transition rules as
galaxy_invocation_check_all. Errors if the invocation isn't recorded in the notebook.`,
    parameters: Type.Object({
      invocationId: Type.String({ description: "Galaxy invocation ID to check" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      return await checkInvocations(params.invocationId, signal);
    },
    renderResult: (result) => {
      const d = result.details as { checked?: number; error?: boolean } | undefined;
      if (d?.error) return new Text("❌ Invocation check failed");
      return new Text(`🔍 Checked ${d?.checked || 0} invocation(s)`);
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: shared poll loop for the two check tools
// ─────────────────────────────────────────────────────────────────────────────

interface CheckResultEntry {
  invocationId: string;
  notebookAnchor: string;
  label: string;
  invocationState: string;
  jobSummary: { ok: number; running: number; queued: number; error: number; other: number };
  autoAction?: string;
}

interface CheckInvocationsResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

export async function checkInvocations(
  specificId: string | undefined,
  signal?: AbortSignal,
): Promise<CheckInvocationsResult> {
  const notebookPath = getNotebookPath();
  if (!notebookPath) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ success: false, error: "No notebook open." }),
        },
      ],
      details: { error: true } as Record<string, unknown>,
    };
  }

  if (!getGalaxyConfig()) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ success: false, error: "Galaxy credentials not configured." }),
        },
      ],
      details: { error: true } as Record<string, unknown>,
    };
  }

  // Phase 1 — decide what to poll. Read under the lock so we see any Loom
  // write (a just-finished invocation_record) whole, but hold it only for the
  // read: there is no network I/O in here.
  const blocks = await withNotebookLock(notebookPath, async () =>
    findInvocationBlocks(await readNotebook(notebookPath)),
  );

  let toCheck: InvocationYaml[];
  if (specificId) {
    const found = blocks.find((b) => b.invocationId === specificId);
    if (!found) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: `Invocation ${specificId} not found in notebook.`,
            }),
          },
        ],
        details: { error: true } as Record<string, unknown>,
      };
    }
    toCheck = [found];
  } else {
    toCheck = blocks.filter((b) => b.status === "in_progress");
  }

  if (toCheck.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            results: [],
            message: "No in-progress invocations.",
          }),
        },
      ],
      details: { checked: 0 } as Record<string, unknown>,
    };
  }

  // Phase 2 — talk to Galaxy with no lock held and nothing pinned in memory
  // about the notebook. These GETs are the slow part (one round trip per
  // in-flight invocation); before #391 they sat between the read and the write,
  // so every notebook write the agent made meanwhile was overwritten by a
  // seconds-stale snapshot. Errors stay per-block: a 502 on one invocation must
  // not cost the others their update.
  const results: CheckResultEntry[] = [];
  const updates: InvocationPollUpdate[] = [];

  for (const block of toCheck) {
    try {
      const inv = await galaxyGet<GalaxyInvocationResponse>(
        `/invocations/${block.invocationId}`,
        signal,
      );

      const summary = { ok: 0, running: 0, queued: 0, error: 0, other: 0 };
      let totalJobs = 0;
      let completedSteps = 0;
      for (const invStep of inv.steps) {
        let stepJobs = 0;
        let stepOk = 0;
        for (const job of invStep.jobs) {
          stepJobs++;
          totalJobs++;
          if (job.state === "ok") {
            summary.ok++;
            stepOk++;
          } else if (job.state === "running") summary.running++;
          else if (job.state === "queued" || job.state === "new" || job.state === "waiting")
            summary.queued++;
          else if (job.state === "error" || job.state === "deleted") summary.error++;
          else summary.other++;
        }
        if (stepJobs > 0 && stepJobs === stepOk) completedSteps++;
      }

      let autoAction: string | undefined;
      let transition: InvocationPollUpdate["transition"];

      if (summary.error === 0 && summary.running === 0 && summary.queued === 0 && summary.ok > 0) {
        transition = {
          status: "completed",
          summary: `Workflow completed: ${summary.ok} jobs succeeded`,
        };
        autoAction = "completed";
      } else if (summary.error > 0) {
        transition = {
          status: "failed",
          summary: `Workflow failed: ${summary.error} job(s) errored, ${summary.ok} succeeded`,
        };
        autoAction = "failed";
      }

      // Always update the block — even if the rolled-up status didn't
      // change, the per-poll counters (and last_polled_at) did, and the
      // renderer wants those for the live progress bar. Status and summary
      // ride along only on a transition, so a no-op poll can't overwrite an
      // edit the agent made to the block while we were talking to Galaxy.
      updates.push({
        invocationId: block.invocationId,
        totalSteps: inv.steps.length,
        completedSteps,
        totalJobs,
        completedJobs: summary.ok,
        failedJobs: summary.error,
        lastPolledAt: new Date().toISOString(),
        transition,
      });

      results.push({
        invocationId: block.invocationId,
        notebookAnchor: block.notebookAnchor,
        label: block.label,
        invocationState: inv.state,
        jobSummary: summary,
        autoAction,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({
        invocationId: block.invocationId,
        notebookAnchor: block.notebookAnchor,
        label: block.label,
        invocationState: "error_checking",
        jobSummary: { ok: 0, running: 0, queued: 0, error: 0, other: 0 },
        autoAction: `check_error: ${msg}`,
      });
    }
  }

  // Phase 3 — persist. The lock still keeps two Loom writers from losing each
  // other's updates, but the guarantee now comes from re-reading inside it
  // rather than from having held it across the poll: whoever gets the lock
  // second folds their blocks into content that already contains the first
  // writer's. A write that loses to an outside writer between our read and our
  // rename fails the stamp check and is retried against fresh content rather
  // than silently overwriting it.
  if (updates.length > 0) {
    const transitioned = await withNotebookLock(notebookPath, () =>
      persistInvocationUpdates(notebookPath, updates),
    );
    // A transition we didn't actually record isn't news. The poller turns
    // "completed"/"failed" straight into a user-facing toast, so leaving the
    // flag on a block that was deleted mid-poll — or that another poller had
    // already advanced — would announce a state change nothing wrote.
    for (const entry of results) {
      const announced = entry.autoAction === "completed" || entry.autoAction === "failed";
      if (announced && !transitioned.has(entry.invocationId)) entry.autoAction = undefined;
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ success: true, checked: results.length, results }, null, 2),
      },
    ],
    // Expose the per-invocation results so the background poller can fire a
    // completion notification for any invocation that just reached a terminal
    // state (autoAction "completed"/"failed"). The agent-facing summary already
    // travels in `content`; this is for the headless poller path.
    details: { checked: results.length, results } as Record<string, unknown>,
  };
}

// A write only loses the stamp check when someone else wrote in the microseconds
// between our read and our rename; three attempts is far more than convergence
// needs, and bounding it keeps a pathological writer from spinning us.
const MAX_PERSIST_ATTEMPTS = 3;

/**
 * Read -> fold in the polled blocks -> write, retrying against fresh content if
 * the notebook changed under us. Call with the notebook lock held. Returns the
 * invocation ids whose status this call actually changed on disk.
 *
 * The stamp is taken *before* the read on purpose. Stamping afterwards would
 * let a write that landed between the read and the stat look unchanged — the
 * exact clobber this is here to stop — whereas stamping first can only ever
 * cost us a spurious retry.
 */
async function persistInvocationUpdates(
  notebookPath: string,
  updates: InvocationPollUpdate[],
): Promise<Set<string>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_PERSIST_ATTEMPTS; attempt++) {
    const stamp = await statNotebook(notebookPath);
    // Read regardless of the stat, so a notebook that's actually gone or
    // unreadable fails with its own ENOENT/EACCES instead of being dressed up
    // as a race.
    const fresh = await readNotebook(notebookPath);
    // Readable but unstattable: without a stamp there's no compare-and-swap,
    // and an unguarded whole-file write is the thing #391 is about. Treat it as
    // a lost race rather than quietly downgrading to one.
    if (!stamp) {
      lastError = new NotebookChangedError(notebookPath);
      continue;
    }
    const { content, applied, transitioned } = applyInvocationUpdates(fresh, updates);
    // Every block was deleted or already has a newer poll on disk — nothing to
    // write, so don't rewrite the file (and don't risk a race) for no change.
    if (applied.length === 0) return new Set();
    try {
      await writeNotebook(notebookPath, content, stamp);
      return new Set(transitioned);
    } catch (error) {
      if (!(error instanceof NotebookChangedError)) throw error;
      lastError = error;
    }
  }
  // Surface it: the poller's catch drops the tick (so no completion toast fires
  // for a transition we failed to record) and the next tick re-polls.
  throw lastError;
}
