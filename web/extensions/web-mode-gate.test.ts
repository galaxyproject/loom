import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import gate, {
  isPathAllowed,
  shouldBlockTool,
  dropSymlinkedEntries,
  gateMcpProxy,
} from "./web-mode-gate.js";

describe("isPathAllowed", () => {
  const allowlist = ["/tmp/loom-session/notebook.md"];

  it("allows the exact notebook path", () => {
    expect(isPathAllowed("/tmp/loom-session/notebook.md", allowlist)).toBe(true);
  });

  it("rejects sibling files", () => {
    expect(isPathAllowed("/tmp/loom-session/secrets.txt", allowlist)).toBe(false);
  });

  it("rejects parent directory traversal", () => {
    expect(isPathAllowed("/tmp/loom-session/../etc/passwd", allowlist)).toBe(false);
  });

  it("rejects relative path that resolves outside allowlist", () => {
    expect(isPathAllowed("../../etc/passwd", allowlist, "/tmp/loom-session")).toBe(false);
  });

  it("allows relative path to notebook.md when cwd is the session dir", () => {
    expect(isPathAllowed("notebook.md", allowlist, "/tmp/loom-session")).toBe(true);
  });
});

describe("isPathAllowed with real symlinks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "gate-test-")));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("treats a symlink that points at the allowed target as allowed", () => {
    const real = join(tmpDir, "notebook.md");
    writeFileSync(real, "");
    const link = join(tmpDir, "alias.md");
    symlinkSync(real, link);
    expect(isPathAllowed(link, [real])).toBe(true);
  });

  it("rejects a symlink that resolves outside the allowed target", () => {
    writeFileSync(join(tmpDir, "notebook.md"), "");
    writeFileSync(join(tmpDir, "secret.txt"), "");
    const link = join(tmpDir, "alias.md");
    symlinkSync(join(tmpDir, "secret.txt"), link);
    expect(isPathAllowed(link, [join(tmpDir, "notebook.md")])).toBe(false);
  });

  it("rejects access to a sibling reached through a symlinked parent dir", () => {
    const realDir = join(tmpDir, "real-session");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "notebook.md"), "");
    writeFileSync(join(realDir, "secret.txt"), "");
    const linkDir = join(tmpDir, "session");
    symlinkSync(realDir, linkDir);
    // Allowlist points at notebook.md via the symlinked dir; secret.txt
    // is in the same real dir but must still be rejected.
    expect(isPathAllowed(join(linkDir, "secret.txt"), [join(linkDir, "notebook.md")])).toBe(false);
  });

  it("allows a not-yet-existing notebook.md when the parent dir exists", () => {
    // First write to notebook.md: target doesn't exist yet but the cwd does.
    // realResolve should walk up to the (existing) parent and rejoin.
    const target = join(tmpDir, "notebook.md");
    expect(isPathAllowed(target, [target])).toBe(true);
  });

  it("dropSymlinkedEntries drops a symlinked entry, keeps a regular file and a not-yet-existing path", () => {
    const real = join(tmpDir, "notebook.md");
    writeFileSync(real, "");
    const link = join(tmpDir, "linked-notebook.md");
    symlinkSync(real, link); // a notebook.md that is itself a symlink to elsewhere
    const missing = join(tmpDir, "created-lazily.md");
    const kept = dropSymlinkedEntries([real, link, missing]);
    expect(kept).toContain(real); // regular file kept
    expect(kept).toContain(missing); // not-yet-existing kept (created as a real file later)
    expect(kept).not.toContain(link); // symlinked entry dropped
  });
});

describe("shouldBlockTool", () => {
  it("blocks bash unconditionally", () => {
    const result = shouldBlockTool(
      "bash",
      { command: "ls" },
      ["/tmp/loom-session/notebook.md"],
      "/tmp/loom-session",
    );
    expect(result).toEqual({ block: true, reason: expect.stringContaining("bash") });
  });

  it("blocks edit outside allowlist", () => {
    const result = shouldBlockTool(
      "edit",
      { path: "/etc/passwd" },
      ["/tmp/loom-session/notebook.md"],
      "/tmp/loom-session",
    );
    expect(result?.block).toBe(true);
  });

  it("permits edit on notebook.md", () => {
    const result = shouldBlockTool(
      "edit",
      { path: "/tmp/loom-session/notebook.md" },
      ["/tmp/loom-session/notebook.md"],
      "/tmp/loom-session",
    );
    expect(result).toBeUndefined();
  });

  it("permits curated brain tools (galaxy_invocation_record)", () => {
    const result = shouldBlockTool(
      "galaxy_invocation_record",
      { foo: "bar" },
      ["/tmp/loom-session/notebook.md"],
      "/tmp/loom-session",
    );
    expect(result).toBeUndefined();
  });

  it("blocks grep unconditionally", () => {
    const result = shouldBlockTool(
      "grep",
      { pattern: "API_KEY", path: "/proc/self/environ" },
      ["/tmp/loom-session/notebook.md"],
      "/tmp/loom-session",
    );
    expect(result).toEqual({ block: true, reason: expect.stringContaining("grep") });
  });

  it("blocks find unconditionally", () => {
    const result = shouldBlockTool(
      "find",
      { path: "/", name: "*.env" },
      ["/tmp/loom-session/notebook.md"],
      "/tmp/loom-session",
    );
    expect(result).toEqual({ block: true, reason: expect.stringContaining("find") });
  });

  it("blocks ls unconditionally", () => {
    const result = shouldBlockTool(
      "ls",
      { path: "/etc" },
      ["/tmp/loom-session/notebook.md"],
      "/tmp/loom-session",
    );
    expect(result).toEqual({ block: true, reason: expect.stringContaining("ls") });
  });

  const allowlist = ["/tmp/loom-session/notebook.md"];
  const cwd = "/tmp/loom-session";

  // Default-DENY allowlist: the curated remote surface passes through.
  it.each([
    "galaxy_run_tool",
    "galaxy_connect",
    "brc_analytics_get_genome",
    "gtn_search",
    "gtn_fetch",
    "notebook_push_to_galaxy",
    "skills_fetch",
  ])("permits curated remote-surface tool %s", (toolName) => {
    expect(shouldBlockTool(toolName, { foo: "bar" }, allowlist, cwd)).toBeUndefined();
  });

  // Egress, experiments, and unknown/future tools are denied by default --
  // this is the whole point of inverting the denylist to an allowlist.
  it.each([
    "fetch_content",
    "web_search",
    "code_search",
    "get_search_content",
    "team_dispatch",
    "chat_search",
    "some_future_tool",
    "glob",
  ])("denies non-surface tool %s by default", (toolName) => {
    const result = shouldBlockTool(toolName, { url: "http://169.254.169.254/" }, allowlist, cwd);
    expect(result).toEqual({ block: true, reason: expect.stringContaining(toolName) });
  });

  // pi's file tools render with file_path ?? path; the jail must honor both.
  it("path-gates edit emitted with file_path (outside allowlist -> blocked)", () => {
    const result = shouldBlockTool("edit", { file_path: "/etc/passwd" }, allowlist, cwd);
    expect(result?.block).toBe(true);
  });

  it("permits edit emitted with file_path on notebook.md", () => {
    const result = shouldBlockTool(
      "edit",
      { file_path: "/tmp/loom-session/notebook.md" },
      allowlist,
      cwd,
    );
    expect(result).toBeUndefined();
  });

  it("blocks a path-gated tool emitted with no path or file_path", () => {
    const result = shouldBlockTool("write", { content: "x" }, allowlist, cwd);
    expect(result?.block).toBe(true);
  });
});

// The `mcp` proxy gateway is the only path to the curated MCP servers on a
// cold-cache container (every fresh remote launch). It must reach galaxy /
// brc-analytics but stay default-deny for any other server.
describe("gateMcpProxy / mcp proxy gating", () => {
  it("allows a tool call scoped to a curated server", () => {
    expect(gateMcpProxy({ tool: "run_tool", args: "{}", server: "galaxy" })).toBeUndefined();
    expect(gateMcpProxy({ tool: "get_assemblies", server: "brc-analytics" })).toBeUndefined();
  });

  it("blocks a tool call to a non-curated server", () => {
    const r = gateMcpProxy({ tool: "exfiltrate", server: "evil" });
    expect(r).toMatchObject({ block: true, reason: expect.stringContaining("evil") });
  });

  it("blocks a tool call with no server (target unverifiable -> default deny)", () => {
    const r = gateMcpProxy({ tool: "run_tool", args: "{}" });
    expect(r).toMatchObject({ block: true, reason: expect.stringContaining("server") });
  });

  it("allows read-only discovery ops (no tool call)", () => {
    expect(gateMcpProxy({ search: "fastqc" })).toBeUndefined();
    expect(gateMcpProxy({ describe: "run_tool" })).toBeUndefined();
    expect(gateMcpProxy({ server: "galaxy" })).toBeUndefined(); // list a server's tools
    expect(gateMcpProxy({ action: "ui-messages" })).toBeUndefined();
    expect(gateMcpProxy({})).toBeUndefined(); // status
  });

  it("gates connect to curated servers only", () => {
    expect(gateMcpProxy({ connect: "galaxy" })).toBeUndefined();
    expect(gateMcpProxy({ connect: "evil" })).toMatchObject({ block: true });
  });

  it("a tool call wins over connect (server gating applies, not connect)", () => {
    // proxy dispatch checks `tool` before `connect`; a curated connect must
    // not smuggle a call to an unverified server.
    expect(gateMcpProxy({ tool: "run_tool", connect: "galaxy" })).toMatchObject({ block: true });
  });

  it("is wired through shouldBlockTool", () => {
    expect(
      shouldBlockTool("mcp", { tool: "run_tool", server: "galaxy" }, [], "/tmp/loom-session"),
    ).toBeUndefined();
    expect(
      shouldBlockTool("mcp", { tool: "run_tool", server: "evil" }, [], "/tmp/loom-session"),
    ).toMatchObject({ block: true });
    // bare proxy (status) is allowed; default-deny no longer swallows `mcp`
    expect(shouldBlockTool("mcp", {}, [], "/tmp/loom-session")).toBeUndefined();
  });
});

// Exercise the actual registered extension, not just the pure helpers: proves
// it wires a tool_call handler, parses LOOM_NOTEBOOK_ALLOWLIST the way
// server.ts writes it, and returns pi's {block:true} shape. In remote mode this
// gate is the SOLE tool_call authority (web/server.ts sets LOOM_LOCAL_EXEC=off,
// so the brain skips its exec-guard), so it must be self-sufficient -- a sibling
// write in the session dir has to be blocked by the gate alone.
describe("web-mode-gate registration (default export)", () => {
  const NOTEBOOK = "/tmp/loom-session/notebook.md";
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.LOOM_NOTEBOOK_ALLOWLIST;
    process.env.LOOM_NOTEBOOK_ALLOWLIST = NOTEBOOK;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LOOM_NOTEBOOK_ALLOWLIST;
    else process.env.LOOM_NOTEBOOK_ALLOWLIST = savedEnv;
  });

  type ToolEvent = { toolName: string; input: Record<string, unknown> };

  function loadHandler(): (event: ToolEvent) => Promise<unknown> {
    let handler: ((event: ToolEvent) => Promise<unknown>) | undefined;
    const fakePi = {
      on: (event: string, h: (event: ToolEvent) => Promise<unknown>) => {
        if (event === "tool_call") handler = h;
      },
    };
    gate(fakePi as unknown as Parameters<typeof gate>[0]);
    if (!handler) throw new Error("gate did not register a tool_call handler");
    return handler;
  }

  it("wires tool_call, parses the env allowlist, and enforces the boundary end-to-end", async () => {
    const handler = loadHandler();
    // default-deny: local exec + egress blocked
    expect(await handler({ toolName: "bash", input: { command: "ls" } })).toMatchObject({
      block: true,
    });
    expect(
      await handler({ toolName: "fetch_content", input: { url: "http://169.254.169.254/" } }),
    ).toMatchObject({ block: true });
    // writes confined to the env-provided notebook allowlist; a sibling in the
    // session dir is blocked by the gate alone (no exec-guard in remote)
    expect(await handler({ toolName: "edit", input: { path: NOTEBOOK } })).toBeUndefined();
    expect(
      await handler({ toolName: "write", input: { path: "/tmp/loom-session/secret.txt" } }),
    ).toMatchObject({ block: true });
    // curated remote surface passes through
    expect(await handler({ toolName: "galaxy_run_tool", input: {} })).toBeUndefined();
  });
});
