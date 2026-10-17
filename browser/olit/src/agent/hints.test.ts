import { describe, expect, it } from "vitest";

import type { Galaxy } from "@galaxyproject/orbit-browser/agent";

import { catalogMissHint } from "./hints";

function plugins(installed: { name: string; html?: string; tags?: string[] }[]) {
  const asked: string[] = [];
  const galaxy = {
    get: async (path: string) => {
      asked.push(path);
      return installed;
    },
  } as unknown as Galaxy;
  return { galaxy, asked };
}

const VIEWERS = [
  { name: "ngl", html: "NGL Viewer" },
  { name: "molstar", html: "Molstar Viewer" },
  { name: "plotly", html: "Bar, Line and Scatter", tags: ["Plotly", "Chart"] },
  { name: "plotly_box", html: "Box Plot", tags: ["Plotly"] },
  { name: "phylocanvas", html: "Phylogenetic Tree Visualization", tags: ["Tree", "FASTA"] },
  { name: "olit", html: "AI Research Assistant" },
];

describe("catalogMissHint", () => {
  const search = (galaxy: Galaxy, query: string, found: unknown[] = []) =>
    catalogMissHint(galaxy, "search_tools_by_name", { query }, found);

  it("redirects an empty search that names a visualization", async () => {
    const { galaxy } = plugins(VIEWERS);
    for (const query of ["ngl", "molstar structure", "plotly scatter", "plotly box chart"]) {
      const hint = await search(galaxy, query);
      expect(hint, query).toContain(`No Galaxy tool matched '${query}'`);
      expect(hint, query).toContain("installed on this server");
      expect(hint, query).toContain("list_visualizations without a dataset_id");
    }
  });

  it("does not take a title's or a tag's words for a visualization's name", async () => {
    const { galaxy } = plugins(VIEWERS);
    for (const query of [
      "structure viewer",
      "filter fasta by length",
      "build a phylogenetic tree",
      "merge files and count",
    ]) {
      expect(await search(galaxy, query), query).toBeUndefined();
    }
  });

  it("leaves an empty search as it is when Galaxy will not list its plugins", async () => {
    const galaxy = {
      get: async () => {
        throw new Error("HTTP 502: 502 Bad Gateway");
      },
    } as unknown as Galaxy;
    expect(await search(galaxy, "plotly")).toBeUndefined();
  });

  it("redirects a search for a visualization's exact name, whatever tools it matched", async () => {
    const { galaxy } = plugins(VIEWERS);
    const fuzzy = [{ id: "createInterval", name: "Create single interval" }];
    for (const query of ["ngl", "NGL", "plotly_box"]) {
      const hint = await search(galaxy, query, fuzzy);
      expect(hint, query).toContain(`'${query}' is an installed visualization`);
      expect(hint, query).toContain("list_visualizations");
    }
  });

  it("leaves a search that found tools alone unless it is a visualization's exact name", async () => {
    const { galaxy } = plugins(VIEWERS);
    const found = [{ id: "some_tool" }];
    for (const query of ["structure viewer", "plotly scatter", "ngl viewer", "olit", "mol"]) {
      expect(await search(galaxy, query, found), query).toBeUndefined();
    }
  });

  it("never asks about plugins when a search of several words found tools", async () => {
    const { galaxy, asked } = plugins(VIEWERS);
    expect(await search(galaxy, "heatmap viewer", [{ id: "heatmap2" }])).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("says nothing when no visualization is named, nor for this agent", async () => {
    const { galaxy } = plugins(VIEWERS);
    expect(await search(galaxy, "bowtie2")).toBeUndefined();
    expect(await search(galaxy, "research assistant")).toBeUndefined();
  });

  it("reads a keyword search the same way", async () => {
    const { galaxy } = plugins(VIEWERS);
    const hint = await catalogMissHint(
      galaxy,
      "search_tools_by_keywords",
      { keywords: ["plotly"] },
      [],
    );
    expect(hint).toContain("No Galaxy tool matched 'plotly'");
  });

  it("gives a tool that is not a catalog search no hint", async () => {
    const { galaxy, asked } = plugins(VIEWERS);
    expect(await catalogMissHint(galaxy, "get_histories", { query: "plotly" }, [])).toBeUndefined();
    expect(asked).toEqual([]);
  });
});
