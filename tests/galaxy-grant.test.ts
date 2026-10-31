/**
 * The `galaxy: "read"` grant (slice 3, decision 8): the brain registers no tool that writes Galaxy
 * or the record. Driven through the whole extension's registration rather than the filter alone,
 * so a writer registered somewhere new shows up here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { allOperations } from "@galaxyproject/galaxy-ops";
import { Type } from "@sinclair/typebox";

import {
  profileFromEnv,
  setCapabilityProfile,
  type CapabilityProfile,
} from "../shared/capability-profile.js";
import { buildReadOnlyGalaxyBlock, ORBIT_WRITING_TOOLS } from "../extensions/orbit/galaxy-grant";
import { createGalaxyOpsToolSource, type GalaxyExtra } from "../extensions/orbit/galaxy-ops-tools";
import { SUBMISSION_TOOLS } from "../extensions/orbit/galaxy-submission";
import {
  registeredGalaxyTools,
  setGalaxyToolSource,
  type GalaxyTool,
} from "../extensions/orbit/galaxy-tool-source";

/**
 * Orbit's own tools a read-only launch keeps, under the profile below. The local ones (bash, the
 * dashboard, the MCP output reader, the lesson bank) stay: the grant is about Galaxy and the
 * record, and only the browser, which has none of them, sets it.
 */
const ORBIT_READERS = [
  "bash",
  "dashboard_read",
  "dashboard_update",
  "ena_runs",
  "gtn_fetch",
  "gtn_search",
  "lesson_propose",
  "lessons_search",
  "mcp_read_output",
  "notebook_list_galaxy_pages",
  "skills_fetch",
];

/** A desktop-like profile with a file surface, so the local upload tool is in play too. */
const BASE: CapabilityProfile = { ...profileFromEnv({}), ui: "desktop" };

/** Every tool the brain registers under `profile`, by name, and the Galaxy ones by definition. */
async function boot(profile: Partial<CapabilityProfile> | null) {
  setCapabilityProfile(profile === null ? null : ({ ...BASE, ...profile } as CapabilityProfile));
  const names: string[] = [];
  const noop = () => undefined;
  const pi = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "registerTool") return (def: { name: string }) => names.push(def.name);
        if (prop === "getAllTools" || prop === "getActiveTools") return () => [];
        if (prop === "events") return { on: noop, emit: noop };
        return noop;
      },
    },
  );
  const mod = await import("../extensions/orbit/index");
  mod.default(pi as never);
  return { names: [...new Set(names)].sort(), galaxy: registeredGalaxyTools() };
}

afterEach(() => {
  setCapabilityProfile(null);
  setGalaxyToolSource(null);
});

describe("a read-only launch", () => {
  it("registers only the Galaxy tools that declare themselves read-only", async () => {
    const { galaxy } = await boot({ galaxy: "read" });
    for (const tool of galaxy) expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    const names = galaxy.map((t) => t.name);
    const writes = allOperations.filter((op) => op.readOnly === false).map((op) => op.name);
    expect(writes.length).toBeGreaterThanOrEqual(13);
    for (const name of [...writes, ...Object.keys(SUBMISSION_TOOLS)]) {
      expect(names, name).not.toContain(name);
    }
    for (const name of ["list_jobs", "get_job_logs", "galaxy_read_output", "get_job_details"]) {
      expect(names, name).toContain(name);
    }
  });

  it("registers none of Orbit's writers, and every Orbit tool it keeps is a known reader", async () => {
    const { names, galaxy } = await boot({ galaxy: "read" });
    const family = new Set(galaxy.map((t) => t.name));
    expect(names.filter((n) => !family.has(n))).toEqual(ORBIT_READERS);
    for (const name of ORBIT_WRITING_TOOLS) expect(names, name).not.toContain(name);
  });

  it("withholds an extra that doesn't say it is read-only, and keeps one that does", async () => {
    const extra = (name: string, annotations?: GalaxyTool["annotations"]) =>
      ({
        name,
        label: name,
        description: `stub ${name}`,
        parameters: Type.Object({}),
        ...(annotations ? { annotations } : {}),
        execute: async () => ({ content: [{ type: "text" as const, text: "{}" }], details: {} }),
      }) as GalaxyExtra;
    setGalaxyToolSource(
      createGalaxyOpsToolSource({
        extras: [extra("probe_unsaid"), extra("probe_reads", { readOnlyHint: true })],
      }),
    );
    setCapabilityProfile({ ...BASE, galaxy: "read" });
    const { registerGalaxyTools } = await import("../extensions/orbit/galaxy-tool-source");
    const family = registerGalaxyTools({ registerTool: () => undefined } as never);
    expect(family.toolName("probe_reads")).toBe("probe_reads");
    expect(family.toolName("probe_unsaid")).toBeUndefined();
  });

  it("says so in the prompt, and only there", () => {
    setCapabilityProfile({ ...BASE, galaxy: "read" });
    expect(buildReadOnlyGalaxyBlock()).toContain("keeps no analysis record");
    setCapabilityProfile({ ...BASE, galaxy: "write" });
    expect(buildReadOnlyGalaxyBlock()).toBe("");
  });
});

describe("a write launch", () => {
  it("registers the same tools whether it says write, says nothing, or env decides", async () => {
    const write = await boot({ galaxy: "write" });
    const { galaxy: _, ...unsaid } = BASE;
    const silent = await boot(unsaid);
    expect(silent.names).toEqual(write.names);
    expect(write.names).toEqual(expect.arrayContaining([...ORBIT_WRITING_TOOLS]));
    expect(write.galaxy.map((t) => t.name)).toContain("run_tool");
    const env = await boot(null);
    // env has no desktop ui, so compare the Galaxy family only.
    expect(env.galaxy.map((t) => t.name)).toEqual(write.galaxy.map((t) => t.name));
  });
});
