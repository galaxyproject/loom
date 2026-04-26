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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getNotebookPath } from "./state";
import {
  readNotebook,
  writeNotebook,
  findInvocationBlocks,
  upsertInvocationBlock,
  type InvocationYaml,
} from "./notebook-writer";
import {
  getGalaxyConfig,
  galaxyGet,
  type GalaxyInvocationResponse,
} from "./galaxy-api";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

        const stripped = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[\s\S]*?<\/nav>/gi, '')
          .replace(/<header[\s\S]*?<\/header>/gi, '')
          .replace(/<footer[\s\S]*?<\/footer>/gi, '');

        let body = stripped;
        const mainMatch = stripped.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i)
          || stripped.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i)
          || stripped.match(/<div[^>]+class="[^"]*tutorial-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
        if (mainMatch) {
          body = mainMatch[1];
        }

        let text = body.replace(/<[^>]+>/g, ' ');

        text = text
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, ' ')
          .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));

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

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: Fetch a galaxy-skills SKILL.md or reference doc
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "galaxy_skills_fetch",
    label: "Fetch Galaxy Skill",
    description: `Fetch operational know-how from the curated galaxyproject/galaxy-skills
repo. Pass a relative path inside the repo, e.g. \`collection-manipulation/SKILL.md\` or
\`galaxy-integration/mcp-reference/gotchas.md\`. The system prompt's "Galaxy skills" section
lists the available skill paths and when to use each. Results are cached locally for 24h.`,
    parameters: Type.Object({
      path: Type.String({
        description:
          "Relative path inside galaxy-skills, e.g. 'collection-manipulation/SKILL.md', " +
          "'galaxy-integration/mcp-reference/SKILL.md', 'galaxy-integration/mcp-reference/gotchas.md'.",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const cleanPath = params.path.replace(/^\/+/, "").replace(/\\/g, "/");
      // Reject path traversal so a malformed path can't escape the repo / cache.
      if (cleanPath.includes("..") || cleanPath === "") {
        return {
          content: [{ type: "text", text: `Error: Invalid skill path "${params.path}"` }],
          details: { error: true },
        };
      }

      const cacheDir = path.join(os.homedir(), ".loom", "cache", "galaxy-skills");
      const cachePath = path.join(cacheDir, cleanPath);
      const ttlMs = 24 * 60 * 60 * 1000;
      try {
        const stat = fs.statSync(cachePath);
        if (Date.now() - stat.mtimeMs < ttlMs) {
          const cached = fs.readFileSync(cachePath, "utf-8");
          return {
            content: [{ type: "text", text: cached }],
            details: { path: cleanPath, length: cached.length, cached: true },
          };
        }
      } catch {
        // No cache hit (file missing or stat failed) — fall through to fetch.
      }

      const url = `https://raw.githubusercontent.com/galaxyproject/galaxy-skills/main/${cleanPath}`;
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) {
          return {
            content: [{
              type: "text",
              text: `Error: Failed to fetch "${cleanPath}" (HTTP ${response.status}). ` +
                `Check the path against the galaxy-skills router in the system prompt.`,
            }],
            details: { error: true, path: cleanPath },
          };
        }
        const text = await response.text();

        try {
          fs.mkdirSync(path.dirname(cachePath), { recursive: true });
          fs.writeFileSync(cachePath, text, "utf-8");
        } catch (err) {
          console.error("[galaxy_skills_fetch] cache write failed:", err);
        }

        return {
          content: [{ type: "text", text }],
          details: { path: cleanPath, length: text.length, cached: false },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error fetching skill: ${msg}` }],
          details: { error: true, path: cleanPath },
        };
      }
    },
    renderResult: (result) => {
      const d = result.details as { path?: string; length?: number; cached?: boolean; error?: boolean } | undefined;
      if (d?.error) return new Text("❌ Galaxy skill fetch failed");
      const tag = d?.cached ? "(cached)" : "(fetched)";
      return new Text(`📘 ${d?.path} ${tag} (${d?.length || 0} chars)`);
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
          content: [{ type: "text", text: JSON.stringify({ success: false, error: "No notebook open." }) }],
          details: { error: true } as Record<string, unknown>,
        };
      }

      const cfg = getGalaxyConfig();
      const galaxyServerUrl = cfg?.url || "";

      try {
        const content = await readNotebook(notebookPath);
        const inv: InvocationYaml = {
          invocationId: params.invocationId,
          galaxyServerUrl,
          notebookAnchor: params.notebookAnchor,
          label: params.label,
          submittedAt: new Date().toISOString(),
          status: "in_progress",
        };
        const updated = upsertInvocationBlock(content, inv);
        await writeNotebook(notebookPath, updated);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              invocationId: inv.invocationId,
              notebookAnchor: inv.notebookAnchor,
              label: inv.label,
              status: inv.status,
              message: `Recorded invocation ${inv.invocationId} (${inv.label}) at ${inv.notebookAnchor}.`,
            }, null, 2),
          }],
          details: { invocationId: inv.invocationId, notebookAnchor: inv.notebookAnchor } as Record<string, unknown>,
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
      const d = result.details as { invocationId?: string; notebookAnchor?: string; error?: boolean } | undefined;
      if (d?.error) return new Text("❌ Failed to record invocation");
      return new Text(`🔗 Invocation ${d?.invocationId} → ${d?.notebookAnchor}`);
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

async function checkInvocations(specificId: string | undefined, signal?: AbortSignal) {
  const notebookPath = getNotebookPath();
  if (!notebookPath) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "No notebook open." }) }],
      details: { error: true } as Record<string, unknown>,
    };
  }

  if (!getGalaxyConfig()) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Galaxy credentials not configured." }) }],
      details: { error: true } as Record<string, unknown>,
    };
  }

  let content = await readNotebook(notebookPath);
  let blocks = findInvocationBlocks(content);

  let toCheck: InvocationYaml[];
  if (specificId) {
    const found = blocks.find((b) => b.invocationId === specificId);
    if (!found) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: `Invocation ${specificId} not found in notebook.` }) }],
        details: { error: true } as Record<string, unknown>,
      };
    }
    toCheck = [found];
  } else {
    toCheck = blocks.filter((b) => b.status === "in_progress");
  }

  if (toCheck.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ success: true, results: [], message: "No in-progress invocations." }),
      }],
      details: { checked: 0 } as Record<string, unknown>,
    };
  }

  const results: CheckResultEntry[] = [];

  for (const block of toCheck) {
    try {
      const inv = await galaxyGet<GalaxyInvocationResponse>(
        `/invocations/${block.invocationId}`,
        signal,
      );

      const summary = { ok: 0, running: 0, queued: 0, error: 0, other: 0 };
      for (const invStep of inv.steps) {
        for (const job of invStep.jobs) {
          if (job.state === "ok") summary.ok++;
          else if (job.state === "running") summary.running++;
          else if (job.state === "queued" || job.state === "new" || job.state === "waiting") summary.queued++;
          else if (job.state === "error" || job.state === "deleted") summary.error++;
          else summary.other++;
        }
      }

      let autoAction: string | undefined;
      let nextStatus: InvocationYaml["status"] = block.status;
      let nextSummary = block.summary;

      if (summary.error === 0 && summary.running === 0 && summary.queued === 0 && summary.ok > 0) {
        nextStatus = "completed";
        nextSummary = `Workflow completed: ${summary.ok} jobs succeeded`;
        autoAction = "completed";
      } else if (summary.error > 0) {
        nextStatus = "failed";
        nextSummary = `Workflow failed: ${summary.error} job(s) errored, ${summary.ok} succeeded`;
        autoAction = "failed";
      }

      if (nextStatus !== block.status || nextSummary !== block.summary) {
        const updated: InvocationYaml = { ...block, status: nextStatus, summary: nextSummary };
        content = upsertInvocationBlock(content, updated);
      }

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

  // Persist any status updates back to the file in one write.
  await writeNotebook(notebookPath, content);

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ success: true, checked: results.length, results }, null, 2),
    }],
    details: { checked: results.length } as Record<string, unknown>,
  };
}
