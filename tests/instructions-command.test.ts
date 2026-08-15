import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  AUTHORING_GUIDANCE,
  ensureInstructionsFile,
  formatInstructionsListing,
  registerInstructionsCommand,
} from "../extensions/loom/instructions-command";
import {
  buildUserInstructionsBlock,
  buildWorkspaceInstructionsContext,
  discoverInstructionFiles,
  INSTRUCTIONS_FILENAME,
  type InstructionFile,
} from "../extensions/loom/user-instructions";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-instr-cmd-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("formatInstructionsListing", () => {
  it("says plainly when nothing is loaded, and where to start", () => {
    const out = formatInstructionsListing([]);

    expect(out).toContain("No standing instructions");
    expect(out).toContain("/instructions init");
  });

  it("lists each file with its scope, path and line count", () => {
    const files: InstructionFile[] = [
      {
        scope: "global",
        path: "/home/me/.pi/agent/LOOM.md",
        content: "Prefer IWC workflows.\nUse HISAT2, not bowtie.",
        truncated: false,
      },
      {
        scope: "workspace",
        path: "/home/me/work/rnaseq/LOOM.md",
        content: "Genome build is hg38.",
        truncated: false,
      },
    ];

    const out = formatInstructionsListing(files);

    expect(out).toContain("Global");
    expect(out).toContain("/home/me/.pi/agent/LOOM.md");
    expect(out).toContain("(2 lines)");
    expect(out).toContain("Project");
    expect(out).toContain("/home/me/work/rnaseq/LOOM.md");
    expect(out).toContain("(1 line)");
    expect(out).toContain("Prefer IWC workflows.");
    expect(out).toContain("Genome build is hg38.");
  });

  it("explains the lower authority of a project file when one is listed", () => {
    const out = formatInstructionsListing([
      { scope: "workspace", path: "/w/LOOM.md", content: "hg38", truncated: false },
    ]);

    expect(out).toContain("cannot grant permissions");
  });

  it("does not lecture about project files when only a global one is loaded", () => {
    const out = formatInstructionsListing([
      { scope: "global", path: "/g/LOOM.md", content: "hg38", truncated: false },
    ]);

    expect(out).not.toContain("cannot grant permissions");
  });

  it("says when a file was truncated rather than hiding the cut", () => {
    const out = formatInstructionsListing([
      { scope: "global", path: "/g/LOOM.md", content: "x", truncated: true },
    ]);

    expect(out.toLowerCase()).toContain("truncated");
  });

  it("reports a read error instead of pretending the file is absent", () => {
    const out = formatInstructionsListing([
      {
        scope: "workspace",
        path: "/w/LOOM.md",
        content: "",
        truncated: false,
        error: "Error: EACCES: permission denied",
      },
    ]);

    expect(out).toContain("/w/LOOM.md");
    expect(out).toContain("EACCES");
  });
});

describe("ensureInstructionsFile", () => {
  it("creates the file when it is missing", () => {
    const target = path.join(root, "nested", INSTRUCTIONS_FILENAME);

    const result = ensureInstructionsFile(target);

    expect(result.created).toBe(true);
    expect(result.error).toBeUndefined();
    expect(fs.existsSync(target)).toBe(true);
  });

  it("never clobbers a file the user already wrote", () => {
    const target = path.join(root, INSTRUCTIONS_FILENAME);
    fs.writeFileSync(target, "Prefer IWC workflows.");

    const result = ensureInstructionsFile(target);

    expect(result.created).toBe(false);
    expect(fs.readFileSync(target, "utf-8")).toBe("Prefer IWC workflows.");
  });

  it("reports a write failure rather than throwing into the command handler", () => {
    // A path whose parent is a FILE cannot be mkdir'd -- portable failure.
    const blocker = path.join(root, "blocker");
    fs.writeFileSync(blocker, "not a directory");

    const result = ensureInstructionsFile(path.join(blocker, INSTRUCTIONS_FILENAME));

    expect(result.created).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("the registered command", () => {
  type Notify = { text: string; level: string };

  function install(): { run: (args?: string) => Promise<void>; sent: Notify[] } {
    const sent: Notify[] = [];
    let handler: ((args: string | undefined, ctx: unknown) => Promise<void>) | undefined;
    const pi = {
      registerCommand: (
        name: string,
        spec: { handler: (args: string | undefined, ctx: unknown) => Promise<void> },
      ) => {
        if (name === "instructions") handler = spec.handler;
      },
    };
    registerInstructionsCommand(pi as never);
    const ctx = {
      ui: { notify: (text: string, level: string) => void sent.push({ text, level }) },
    };
    return { run: (args?: string) => handler!(args, ctx), sent };
  }

  it("registers under the name /instructions", () => {
    expect(() => install()).not.toThrow();
  });

  it("reports the files it finds for the real cwd", async () => {
    const cwd = path.join(root, "work");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, INSTRUCTIONS_FILENAME), "Genome build is hg38.");
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));

    const { run, sent } = install();
    await run();

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Genome build is hg38.");
    expect(sent[0].text).toContain("Project");
  });

  it("rejects an unknown subcommand with usage rather than doing something", async () => {
    const { run, sent } = install();
    await run("delete everything");

    expect(sent[0].level).toBe("warning");
    expect(sent[0].text).toContain("Usage:");
  });

  it("creates the project file on `init project` and says where it went", async () => {
    const cwd = path.join(root, "work");
    fs.mkdirSync(cwd, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    const { run, sent } = install();
    await run("init project");

    const target = path.join(cwd, INSTRUCTIONS_FILENAME);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toBe("");
    expect(sent[0].text).toContain(target);
    expect(sent[0].text).toContain("HISAT2"); // the guidance, not the file
  });
});

describe("a freshly initialized file changes nothing", () => {
  // The bug this guards: seeding the file with '#'-prefixed example lines and
  // calling them comments. Markdown has no comment syntax, so the loader would
  // have injected them as live preferences the moment the user ran init.
  it("contributes no system prompt block and no context message", () => {
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "work");
    fs.mkdirSync(cwd, { recursive: true });
    ensureInstructionsFile(path.join(agentDir, INSTRUCTIONS_FILENAME));
    ensureInstructionsFile(path.join(cwd, INSTRUCTIONS_FILENAME));

    expect(discoverInstructionFiles({ cwd, agentDir })).toEqual([]);
    expect(buildUserInstructionsBlock({ cwd, agentDir })).toBe("");
    expect(buildWorkspaceInstructionsContext({ cwd, agentDir })).toBe("");
  });

  it("keeps the example preferences in the terminal guidance, not on disk", () => {
    const target = path.join(root, INSTRUCTIONS_FILENAME);
    ensureInstructionsFile(target);

    expect(fs.readFileSync(target, "utf-8")).toBe("");
    expect(AUTHORING_GUIDANCE).toContain("HISAT2");
  });
});
