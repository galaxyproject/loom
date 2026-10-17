import { fail, Outcome, type Context, type AgentTool } from "./tool";
import {
  GTN_BASE,
  GTN_HOST,
  gtnPageText,
  gtnTopics,
  gtnTutorials,
  gtnUrl,
} from "../../../../shared/gtn.js";

// The discovery logic is Orbit's too; what stays here is this shell's transport and envelope.
export { GTN_API, GTN_BASE, GTN_HOST, gtnPageText as stripHtml } from "../../../../shared/gtn.js";
export const FETCH_MAX_CHARS = 40000;

async function gtnSearch(args: { topic?: string; query?: string }, ctx: Context): Promise<Outcome> {
  const { topic, query } = args ?? {};
  const gtn = ctx.web.connect(`${GTN_BASE}/`);

  if (!topic) {
    const listing = gtnTopics(await gtn.get("training-material/api/topics.json"));
    if (!listing) {
      return fail(JSON.stringify({ error: "GTN returned an unexpected topics payload" }));
    }
    return new Outcome(JSON.stringify(listing));
  }

  let data: unknown;
  try {
    data = await gtn.get(`training-material/api/topics/${topic}.json`);
  } catch {
    data = undefined;
  }
  const listing = gtnTutorials(data, query);
  if (!listing) {
    return fail(
      JSON.stringify({
        error: `Topic "${topic}" not found. Use gtn_search with no arguments to list available topics.`,
      }),
    );
  }
  return new Outcome(JSON.stringify(listing));
}

async function gtnFetch(args: { url?: string }, ctx: Context): Promise<Outcome> {
  const url = (args?.url || "").trim();
  if (!url) {
    return fail(JSON.stringify({ error: "A tutorial url is required." }));
  }
  const checked = gtnUrl(url);
  if (checked.problem !== undefined) {
    return fail(JSON.stringify({ error: checked.problem }));
  }
  const parsed = checked.url;

  let page: unknown;
  try {
    const site = ctx.web.connect(`${parsed.origin}/`);
    page = await site.get(`${parsed.pathname}${parsed.search}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(
      JSON.stringify({
        url,
        error: detail,
        hint:
          "Check the url with gtn_search; tutorial paths include the topic, " +
          "and a topic listed in one place may live under another.",
      }),
    );
  }
  const text = gtnPageText(typeof page === "string" ? page : JSON.stringify(page));
  if (text.length > FETCH_MAX_CHARS) {
    return new Outcome(
      JSON.stringify({
        url,
        content: text.slice(0, FETCH_MAX_CHARS),
        truncated: true,
        chars_total: text.length,
        note:
          `Showing the first ${FETCH_MAX_CHARS} of ${text.length} characters. ` +
          "Objectives and the first hands-on sections are here; open the url " +
          "for the rest.",
      }),
    );
  }
  return new Outcome(JSON.stringify({ url, content: text }));
}

/** Galaxy Training Network discovery: `gtn_search` and `gtn_fetch`. */
export function gtnTools(): AgentTool[] {
  return [
    {
      name: "gtn_search",
      description:
        "Browse GTN topics and discover tutorials. Call with no arguments to list all " +
        "topics. Provide a topic ID to list its tutorials. Use query to filter tutorials " +
        "by keyword in their title or objectives. Use this to find tutorial URLs before " +
        "fetching with gtn_fetch.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Topic ID to list tutorials for (e.g., 'transcriptomics', 'introduction')",
          },
          query: {
            type: "string",
            description: "Keyword to filter tutorials by title or objectives (case-insensitive)",
          },
        },
      },
      run: gtnSearch,
    },
    {
      name: "gtn_fetch",
      description:
        "Fetch a Galaxy Training Network (GTN) tutorial page and return its content as " +
        `readable text. Only URLs on ${GTN_HOST} are allowed. Use gtn_search first to ` +
        "discover valid tutorial URLs - do not guess or construct URLs. Use this to read " +
        "tutorial instructions, tool names, parameters, and workflow steps so you can " +
        "follow along and reproduce analyses in Galaxy.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: `URL of the GTN tutorial page (must be on ${GTN_HOST})`,
          },
        },
        required: ["url"],
      },
      run: gtnFetch,
    },
  ];
}
