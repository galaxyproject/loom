/**
 * `skills_fetch` driven through its real registration, not through the helpers.
 *
 * The two things worth checking here only exist at that level: which source wins
 * when a name is both reserved and configured, and whether a bundled read really
 * makes no network call. A helper-level test agrees with itself about both.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GALAXY } from "./galaxy-family-fixture";
import { setVendorSkillsSource, vendorSkillsDir } from "../extensions/orbit/vendor-skills";

interface ToolDef {
  name: string;
  execute: (
    callId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[]; details?: Record<string, unknown> }>;
}

let tmp: string;
let fetchSpy: ReturnType<typeof vi.fn>;

function writeConfig(repos: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.join(tmp, ".loom"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".loom", "config.json"),
    JSON.stringify({ skills: { repos } }),
    "utf-8",
  );
}

async function skillsFetch(): Promise<ToolDef> {
  const tools: ToolDef[] = [];
  const api = {
    registerTool: (def: ToolDef) => tools.push(def),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
  };
  const { registerPlanTools } = await import("../extensions/orbit/tools");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPlanTools(api as any, GALAXY);
  return tools.find((t) => t.name === "skills_fetch")!;
}

const call = (tool: ToolDef, params: Record<string, unknown>) =>
  tool.execute("id", params, new AbortController().signal, () => {}, {});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-fetch-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmp);
  fetchSpy = vi.fn(async () => new Response("LIVE CONTENT", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  setVendorSkillsSource(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const DEFAULT_REPO = {
  name: "galaxy-skills",
  url: "https://github.com/galaxyproject/galaxy-skills",
  branch: "main",
  enabled: true,
};

describe("skills_fetch source selection", () => {
  it("reads a default repo from the package and makes no request", async () => {
    writeConfig([DEFAULT_REPO]);
    const res = await call(await skillsFetch(), { path: "skills/udt-authoring/SKILL.md" });
    expect(res.content[0].text).toContain("GalaxyUserTool");
    expect(res.details).toMatchObject({ bundled: true, repo: "galaxy-skills" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("goes to the network the moment the same repo names another branch", async () => {
    writeConfig([{ ...DEFAULT_REPO, branch: "wip" }]);
    const res = await call(await skillsFetch(), { path: "skills/udt-authoring/SKILL.md" });
    expect(res.content[0].text).toBe("LIVE CONTENT");
    expect(fetchSpy).toHaveBeenCalled();
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/wip/");
  });

  it("does not answer for another repo's files", async () => {
    // A cast is not part of galaxy-skills. Fetched, this path is a 404; bundled,
    // it has to be a miss too, or the same call means different things.
    writeConfig([DEFAULT_REPO]);
    const res = await call(await skillsFetch(), { path: "debug-galaxy-workflow-output/SKILL.md" });
    expect(res.details?.error).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves the reserved name from the package when nobody has configured it", async () => {
    writeConfig([DEFAULT_REPO]);
    const res = await call(await skillsFetch(), {
      repo: "foundry",
      path: "debug-galaxy-workflow-output/SKILL.md",
    });
    expect(res.details).toMatchObject({ bundled: true, repo: "foundry" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets an explicitly configured repo win the reserved name", async () => {
    // Somebody who adds a repo called "foundry" on a branch has asked for that
    // branch. Answering from the package would hand them content from somewhere
    // else entirely and never say so.
    writeConfig([
      DEFAULT_REPO,
      {
        name: "foundry",
        url: "https://github.com/galaxyproject/foundry",
        branch: "wip",
        enabled: true,
      },
    ]);
    const res = await call(await skillsFetch(), {
      repo: "foundry",
      path: "debug-galaxy-workflow-output/SKILL.md",
    });
    expect(res.content[0].text).toBe("LIVE CONTENT");
    expect(fetchSpy).toHaveBeenCalled();
    expect(String(fetchSpy.mock.calls[0][0])).toContain("galaxyproject/foundry");
  });

  it("serves Orbit's staging skills from the package when nobody has configured the name", async () => {
    writeConfig([DEFAULT_REPO]);
    const res = await call(await skillsFetch(), {
      repo: "orbit",
      path: "skills/galaxy-data-libraries/SKILL.md",
    });
    expect(res.content[0].text).toContain("name: galaxy-data-libraries");
    expect(res.details).toMatchObject({ bundled: true, repo: "orbit" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not let the staging repo name reach the galaxy-skills mirror under the shared prefix", async () => {
    writeConfig([DEFAULT_REPO]);
    const res = await call(await skillsFetch(), {
      repo: "orbit",
      path: "skills/udt-authoring/SKILL.md",
    });
    expect(res.details?.error).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets a configured repo named orbit win over the package", async () => {
    writeConfig([
      DEFAULT_REPO,
      {
        name: "orbit",
        url: "https://github.com/galaxyproject/orbit",
        branch: "wip",
        enabled: true,
      },
    ]);
    const res = await call(await skillsFetch(), {
      repo: "orbit",
      path: "skills/galaxy-data-libraries/SKILL.md",
    });
    expect(res.content[0].text).toBe("LIVE CONTENT");
    expect(String(fetchSpy.mock.calls[0][0])).toContain("galaxyproject/orbit/wip/");
  });

  it("says plainly when the build ships nothing under a reserved name", async () => {
    // A package built before any staging skill existed, or one whose local
    // plugin was dropped: the reserved name must not fall through to the network.
    const read = (name: string) =>
      JSON.parse(fs.readFileSync(path.join(vendorSkillsDir(), name), "utf-8"));
    const manifest = read("_manifest.json");
    const catalog = read("_catalog.json");
    delete catalog.orbit;
    setVendorSkillsSource({
      catalog,
      manifest: {
        ...manifest,
        plugins: manifest.plugins.filter((p: { repo?: string }) => p.repo !== "orbit"),
        files: manifest.files.filter((f: { plugin: string }) => f.plugin !== "orbit-skills"),
      },
      read: (target) => {
        try {
          return fs.readFileSync(path.join(vendorSkillsDir(), target), "utf-8");
        } catch {
          return null;
        }
      },
    });
    writeConfig([DEFAULT_REPO]);
    const res = await call(await skillsFetch(), {
      repo: "orbit",
      path: "skills/galaxy-data-libraries/SKILL.md",
    });
    expect(res.content[0].text).toContain('ships nothing under "orbit"');
    expect(res.details?.error).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not let the reserved name reach the skills mirror", async () => {
    writeConfig([DEFAULT_REPO]);
    const res = await call(await skillsFetch(), {
      repo: "foundry",
      path: "skills/udt-authoring/SKILL.md",
    });
    expect(res.details?.error).toBe(true);
  });
});
