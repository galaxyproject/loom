import type { Galaxy } from "@galaxyproject/orbit-browser/agent";

import { NOT_OFFERED } from "./visualizations";

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Searches over the tool catalog, which holds no visualizations. */
export const CATALOG_SEARCHES = new Set(["search_tools_by_name", "search_tools_by_keywords"]);

type Plugin = { name?: string; html?: string; tags?: string[] | null };

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

/** The installed visualizations Olit offers, by name; none when Galaxy will not list them. */
async function offeredPlugins(galaxy: Galaxy): Promise<string[]> {
  let installed: Plugin[];
  try {
    installed = (await galaxy.get("api/plugins")) || [];
  } catch {
    return [];
  }
  return installed
    .map((plugin) => plugin.name ?? "")
    .filter((plugin) => plugin && !NOT_OFFERED.has(plugin));
}

/**
 * Whether a search names an installed visualization: every word of a plugin's name is in it.
 * Titles and tags share words with tools ("fasta", "tree"), so they do not count.
 */
function namesVisualization(plugins: string[], query: string): boolean {
  const wanted = words(query);
  return plugins.some((plugin) => {
    const name = words(plugin);
    return wanted.size > 0 && name.size > 0 && [...name].every((w) => wanted.has(w));
  });
}

export async function catalogMissHint(
  galaxy: Galaxy,
  name: string,
  args: Record<string, unknown>,
  data: unknown,
): Promise<string | undefined> {
  if (!CATALOG_SEARCHES.has(name)) {
    return undefined;
  }
  const empty =
    !data || (Array.isArray(data) && !data.length) || (isRow(data) && !Object.keys(data).length);
  const query = (args.query as string) || ((args.keywords as string[]) || []).join(" ");
  // A plugin's name is one word, so a search of several that found tools names none.
  if (!empty && /\s/.test(query.trim())) {
    return undefined;
  }
  const plugins = await offeredPlugins(galaxy);
  if (!empty) {
    // A plugin's own name is a visualization whatever tools share letters with it ("ngl" in "single").
    const exact = plugins.some((plugin) => plugin.toLowerCase() === query.trim().toLowerCase());
    return exact
      ? `[olit] '${query}' is an installed visualization, not a Galaxy tool, so the tools this ` +
          "search matched only share letters with it. Visualizations are not in the tool catalog: " +
          "list_visualizations without a dataset_id lists what this server has and the datatypes each renders."
      : undefined;
  }
  if (!namesVisualization(plugins, query)) {
    return undefined;
  }
  return (
    `[olit] No Galaxy tool matched '${query}', which names a visualization installed on this ` +
    "server. Visualizations are not in the tool catalog: list_visualizations without a " +
    "dataset_id lists them and the datatypes each renders."
  );
}
