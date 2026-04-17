# Multi-Agent Team Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the brain-level `team_dispatch` tool that lets the main Loom agent run a scoped Finder ↔ Validator critic loop in-process and return a structured result.

**Architecture:** All changes are inside `extensions/loom/` (plus one rendering hook in `app/src/renderer/chat/`). A new subdirectory `extensions/loom/teams/` contains types, tool-scoping, critic-response parsing, the dispatcher engine, and the tool registration. The dispatcher spawns sibling Pi.dev `Agent` instances per role, drives the critic loop, and streams per-turn updates through the existing `onUpdate` tool-card channel.

**Tech Stack:** TypeScript, `@mariozechner/pi-agent-core` (Pi.dev Agent / agentLoop), `@mariozechner/pi-coding-agent` (ExtensionAPI / ToolDefinition), `@sinclair/typebox` for tool parameters, `vitest` for tests.

**Branch:** `feat/multi-agent-teams` (this plan is committed on it).

**Spec reference:** `docs/superpowers/specs/2026-04-17-multi-agent-dispatch-design.md`

---

## File Structure

**New files:**

- `extensions/loom/teams/types.ts` — `TeamSpec`, `RoleSpec`, `TeamResult`, `TeamTurn`, `DispatchContext`.
- `extensions/loom/teams/readonly-registry.ts` — curated set of Loom tool names that are read-only, plus Pi built-ins classification.
- `extensions/loom/teams/tool-filter.ts` — `filterToolsForRole(role, registry, readonlyNames)`.
- `extensions/loom/teams/validate.ts` — `validateTeamSpec(spec, registry)`.
- `extensions/loom/teams/critic-parser.ts` — `parseCriticResponse(text)`.
- `extensions/loom/teams/dispatcher.ts` — `runTeamDispatch(spec, deps, signal, onUpdate)`.
- `extensions/loom/teams/tool.ts` — registers the `team_dispatch` Pi tool.
- `tests/team-readonly-registry.test.ts` — verifies every curated name exists in the real tool registry.
- `tests/team-tool-filter.test.ts`
- `tests/team-validate.test.ts`
- `tests/team-critic-parser.test.ts`
- `tests/team-dispatcher.test.ts` — uses a fake runner that doesn't touch Pi.

**Modified files:**

- `extensions/loom/index.ts` — import and invoke `registerTeamTools(pi)` alongside existing registrations.
- `extensions/loom/context.ts` — append system-prompt guidance describing when and how to call `team_dispatch`.
- `app/src/renderer/chat/chat-panel.ts` — special-case `details.kind === "team_dispatch"` to render collapsible per-turn list.

---

### Task 1: Seed the branch — create types

**Files:**
- Create: `extensions/loom/teams/types.ts`

- [ ] **Step 1: Create the types file**

Write to `extensions/loom/teams/types.ts`:

```typescript
/**
 * Public types for the team_dispatch feature.
 * See docs/superpowers/specs/2026-04-17-multi-agent-dispatch-design.md.
 */

export interface TeamSpec {
  description: string;
  roles: RoleSpec[];
  max_rounds?: number;
  model?: string;
}

export interface RoleSpec {
  name: string;
  system_prompt: string;
  tools_read: string[];
  tools_write?: string[];
  model?: string;
}

export interface TeamResult {
  converged: boolean;
  rounds: number;
  final_output: string;
  transcript: TeamTurn[];
  usage: { input_tokens: number; output_tokens: number };
  aborted?: boolean;
  budget_exhausted?: boolean;
  error?: string;
}

export interface TeamTurn {
  round: number;
  role: string;
  content: string;
  tool_calls?: { name: string; args: unknown; result: unknown }[];
  approved?: boolean;
}

/**
 * Side-effect surface the dispatcher needs.
 * Injected so the dispatcher is testable without a real Pi runtime.
 */
export interface DispatchDeps {
  runRoleTurn: (
    role: RoleSpec,
    systemPreamble: string,
    userMessage: string,
    tools: unknown[],
    signal: AbortSignal,
  ) => Promise<RoleTurnResult>;
}

export interface RoleTurnResult {
  content: string;
  tool_calls?: { name: string; args: unknown; result: unknown }[];
  usage: { input_tokens: number; output_tokens: number };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes (nothing imports these types yet).

- [ ] **Step 3: Commit**

```bash
git add extensions/loom/teams/types.ts
git commit -m "teams: add public types for team dispatch"
```

---

### Task 2: Curated read-only registry

**Files:**
- Create: `extensions/loom/teams/readonly-registry.ts`
- Create: `tests/team-readonly-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `tests/team-readonly-registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  READONLY_LOOM_TOOLS,
  READONLY_PI_BUILTINS,
  isReadOnly,
} from "../extensions/loom/teams/readonly-registry";

describe("readonly-registry", () => {
  it("exposes a non-empty curated Loom set", () => {
    expect(READONLY_LOOM_TOOLS.size).toBeGreaterThan(0);
  });

  it("classifies Pi built-ins conservatively", () => {
    expect(READONLY_PI_BUILTINS.has("read_file")).toBe(true);
    expect(READONLY_PI_BUILTINS.has("grep")).toBe(true);
    expect(READONLY_PI_BUILTINS.has("list_files")).toBe(true);
    expect(READONLY_PI_BUILTINS.has("glob")).toBe(true);
    expect(READONLY_PI_BUILTINS.has("bash")).toBe(false);
    expect(READONLY_PI_BUILTINS.has("edit_file")).toBe(false);
    expect(READONLY_PI_BUILTINS.has("write_file")).toBe(false);
  });

  it("isReadOnly returns true for curated and built-in reads, false otherwise", () => {
    expect(isReadOnly("read_file")).toBe(true);
    expect(isReadOnly("bash")).toBe(false);
    expect(isReadOnly("__nonexistent__")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/team-readonly-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the registry**

Write to `extensions/loom/teams/readonly-registry.ts`:

```typescript
/**
 * Curated set of tool names that are "read-only" for team_dispatch purposes:
 * they do not mutate Loom analysis state (plan / notebook / findings /
 * checkpoints / decisions).
 *
 * When a new Loom tool is added, consider whether it belongs here. The
 * team-readonly-registry.test.ts suite enforces that every name here exists
 * in the live tool registry — preventing stale entries.
 */

export const READONLY_LOOM_TOOLS: ReadonlySet<string> = new Set([
  // Plan reads
  "analysis_plan_summary",
  "analysis_plan_decisions",
  // Interpretation reads
  "interpretation_list_findings",
  // Workflow reads
  "workflow_invocation_check",
  // BRC reads
  "brc_context_view",
  // Notebook reads (if present; keep conservative)
  "analysis_notebook_open",
]);

/**
 * Pi.dev built-in tools classified as read-only.
 * Conservative: bash, edit_file, write_file are NOT read-only.
 */
export const READONLY_PI_BUILTINS: ReadonlySet<string> = new Set([
  "read_file",
  "grep",
  "list_files",
  "glob",
]);

export function isReadOnly(toolName: string): boolean {
  return READONLY_LOOM_TOOLS.has(toolName) || READONLY_PI_BUILTINS.has(toolName);
}
```

Note: the concrete Loom tool names above are illustrative starting points. The live sweep of registered names happens in Task 10's verification step; adjust `READONLY_LOOM_TOOLS` there if some of these names don't exist or if obvious readers are missing.

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/team-readonly-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/loom/teams/readonly-registry.ts tests/team-readonly-registry.test.ts
git commit -m "teams: curated readonly-tool registry"
```

---

### Task 3: Tool-scoping filter

**Files:**
- Create: `extensions/loom/teams/tool-filter.ts`
- Create: `tests/team-tool-filter.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `tests/team-tool-filter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { filterToolsForRole, FilterError } from "../extensions/loom/teams/tool-filter";
import type { RoleSpec } from "../extensions/loom/teams/types";

type FakeTool = { name: string };

const registry = new Map<string, FakeTool>([
  ["read_file",               { name: "read_file" }],
  ["grep",                    { name: "grep" }],
  ["bash",                    { name: "bash" }],
  ["analysis_plan_summary",   { name: "analysis_plan_summary" }],
  ["analysis_plan_create",    { name: "analysis_plan_create" }],
]);

const isReadOnly = (name: string) =>
  new Set(["read_file", "grep", "analysis_plan_summary"]).has(name);

describe("filterToolsForRole", () => {
  it("includes read-only tools from tools_read", () => {
    const role: RoleSpec = {
      name: "Finder",
      system_prompt: "x",
      tools_read: ["read_file", "grep"],
    };
    const out = filterToolsForRole(role, registry, isReadOnly);
    expect(out.map((t) => t.name).sort()).toEqual(["grep", "read_file"]);
  });

  it("rejects tools_read entries that are not read-only", () => {
    const role: RoleSpec = {
      name: "Finder",
      system_prompt: "x",
      tools_read: ["bash"],
    };
    expect(() => filterToolsForRole(role, registry, isReadOnly))
      .toThrow(FilterError);
  });

  it("rejects unknown tool names", () => {
    const role: RoleSpec = {
      name: "Finder",
      system_prompt: "x",
      tools_read: ["nope"],
    };
    expect(() => filterToolsForRole(role, registry, isReadOnly))
      .toThrow(/nope/);
  });

  it("includes tools_write without readonly constraint", () => {
    const role: RoleSpec = {
      name: "Recorder",
      system_prompt: "x",
      tools_read: [],
      tools_write: ["analysis_plan_create"],
    };
    const out = filterToolsForRole(role, registry, isReadOnly);
    expect(out.map((t) => t.name)).toEqual(["analysis_plan_create"]);
  });

  it("de-duplicates when a tool appears in both lists", () => {
    const role: RoleSpec = {
      name: "Mixed",
      system_prompt: "x",
      tools_read: ["read_file"],
      tools_write: ["read_file"],
    };
    const out = filterToolsForRole(role, registry, isReadOnly);
    expect(out.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("returns empty list when role has no declared tools", () => {
    const role: RoleSpec = {
      name: "Pure",
      system_prompt: "x",
      tools_read: [],
    };
    expect(filterToolsForRole(role, registry, isReadOnly)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/team-tool-filter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the filter**

Write to `extensions/loom/teams/tool-filter.ts`:

```typescript
import type { RoleSpec } from "./types";

export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterError";
  }
}

export function filterToolsForRole<T>(
  role: RoleSpec,
  registry: Map<string, T>,
  isReadOnly: (name: string) => boolean,
): T[] {
  const out = new Map<string, T>();

  for (const name of role.tools_read) {
    const tool = registry.get(name);
    if (!tool) {
      throw new FilterError(
        `Role "${role.name}": tools_read references unknown tool "${name}"`,
      );
    }
    if (!isReadOnly(name)) {
      throw new FilterError(
        `Role "${role.name}": tools_read includes "${name}" which is not read-only. ` +
        `Move it to tools_write if an explicit mutation grant is intended.`,
      );
    }
    out.set(name, tool);
  }

  for (const name of role.tools_write ?? []) {
    const tool = registry.get(name);
    if (!tool) {
      throw new FilterError(
        `Role "${role.name}": tools_write references unknown tool "${name}"`,
      );
    }
    out.set(name, tool);
  }

  return Array.from(out.values());
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/team-tool-filter.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add extensions/loom/teams/tool-filter.ts tests/team-tool-filter.test.ts
git commit -m "teams: filterToolsForRole with read/write separation"
```

---

### Task 4: Team-spec validator

**Files:**
- Create: `extensions/loom/teams/validate.ts`
- Create: `tests/team-validate.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `tests/team-validate.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateTeamSpec, ValidationError } from "../extensions/loom/teams/validate";
import type { TeamSpec } from "../extensions/loom/teams/types";

const ok = (): TeamSpec => ({
  description: "find relevant RNA-seq papers",
  roles: [
    { name: "Finder",    system_prompt: "find papers",    tools_read: [] },
    { name: "Validator", system_prompt: "score relevance", tools_read: [] },
  ],
});

describe("validateTeamSpec", () => {
  it("accepts a well-formed 2-role spec", () => {
    expect(() => validateTeamSpec(ok())).not.toThrow();
  });

  it("rejects fewer than 2 roles", () => {
    const bad: TeamSpec = { ...ok(), roles: [ok().roles[0]] };
    expect(() => validateTeamSpec(bad)).toThrow(ValidationError);
  });

  it("rejects more than 2 roles (MVP)", () => {
    const bad: TeamSpec = {
      ...ok(),
      roles: [...ok().roles, { name: "Extra", system_prompt: "x", tools_read: [] }],
    };
    expect(() => validateTeamSpec(bad)).toThrow(/MVP/);
  });

  it("rejects duplicate role names", () => {
    const r = { name: "Same", system_prompt: "x", tools_read: [] };
    const bad: TeamSpec = { ...ok(), roles: [r, { ...r }] };
    expect(() => validateTeamSpec(bad)).toThrow(/unique/);
  });

  it("rejects empty role name", () => {
    const bad: TeamSpec = {
      ...ok(),
      roles: [{ name: "", system_prompt: "x", tools_read: [] }, ok().roles[1]],
    };
    expect(() => validateTeamSpec(bad)).toThrow(/name/);
  });

  it("accepts max_rounds in [1,20]", () => {
    expect(() => validateTeamSpec({ ...ok(), max_rounds: 1 })).not.toThrow();
    expect(() => validateTeamSpec({ ...ok(), max_rounds: 20 })).not.toThrow();
  });

  it("rejects max_rounds out of range", () => {
    expect(() => validateTeamSpec({ ...ok(), max_rounds: 0 })).toThrow(ValidationError);
    expect(() => validateTeamSpec({ ...ok(), max_rounds: 21 })).toThrow(ValidationError);
  });

  it("rejects empty description", () => {
    expect(() => validateTeamSpec({ ...ok(), description: "" })).toThrow(/description/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/team-validate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the validator**

Write to `extensions/loom/teams/validate.ts`:

```typescript
import type { TeamSpec } from "./types";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function validateTeamSpec(spec: TeamSpec): void {
  if (!spec.description || spec.description.trim().length === 0) {
    throw new ValidationError("TeamSpec.description must be a non-empty string");
  }

  const roles = spec.roles;
  if (!Array.isArray(roles) || roles.length < 2) {
    throw new ValidationError("TeamSpec.roles must contain at least 2 roles");
  }
  if (roles.length > 2) {
    throw new ValidationError(
      "TeamSpec.roles contains more than 2 roles; >2 roles is not implemented in this MVP",
    );
  }

  const seen = new Set<string>();
  for (const role of roles) {
    if (typeof role.name !== "string" || role.name.trim().length === 0) {
      throw new ValidationError("Every RoleSpec must have a non-empty name");
    }
    if (seen.has(role.name)) {
      throw new ValidationError(`RoleSpec.name must be unique; duplicate: "${role.name}"`);
    }
    seen.add(role.name);
  }

  const max = spec.max_rounds;
  if (max !== undefined) {
    if (!Number.isInteger(max) || max < 1 || max > 20) {
      throw new ValidationError("TeamSpec.max_rounds must be an integer in [1, 20]");
    }
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/team-validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/loom/teams/validate.ts tests/team-validate.test.ts
git commit -m "teams: validateTeamSpec"
```

---

### Task 5: Critic-response parser

**Files:**
- Create: `extensions/loom/teams/critic-parser.ts`
- Create: `tests/team-critic-parser.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `tests/team-critic-parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseCriticResponse } from "../extensions/loom/teams/critic-parser";

describe("parseCriticResponse", () => {
  it("parses bare JSON on one line", () => {
    const r = parseCriticResponse('{"approved": true, "critique": "looks good"}');
    expect(r).toEqual({ approved: true, critique: "looks good" });
  });

  it("parses JSON at end of a longer response", () => {
    const text = "Here is my reasoning.\nThe proposal misses X.\n" +
                 '{"approved": false, "critique": "misses X"}';
    const r = parseCriticResponse(text);
    expect(r).toEqual({ approved: false, critique: "misses X" });
  });

  it("takes the LAST well-formed JSON when multiple are present", () => {
    const text =
      '{"approved": false, "critique": "first"}\n' +
      "after second thought...\n" +
      '{"approved": true, "critique": "actually yes"}';
    const r = parseCriticResponse(text);
    expect(r).toEqual({ approved: true, critique: "actually yes" });
  });

  it("falls back to approved=false, critique=full text when no JSON", () => {
    const r = parseCriticResponse("no json here at all");
    expect(r).toEqual({ approved: false, critique: "no json here at all" });
  });

  it("falls back when JSON is malformed", () => {
    const r = parseCriticResponse('ok then {"approved": "truthy"}');
    // missing required fields → fallback
    expect(r.approved).toBe(false);
    expect(r.critique.length).toBeGreaterThan(0);
  });

  it("tolerates whitespace and trailing punctuation around the JSON line", () => {
    const r = parseCriticResponse('   {"approved": true, "critique": "ok"}   ');
    expect(r).toEqual({ approved: true, critique: "ok" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/team-critic-parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

Write to `extensions/loom/teams/critic-parser.ts`:

```typescript
export interface CriticVerdict {
  approved: boolean;
  critique: string;
}

/**
 * Extract the last well-formed `{approved, critique}` JSON object from a
 * critic response. Falls back to `{approved: false, critique: <input>}` if
 * no valid object is found.
 */
export function parseCriticResponse(text: string): CriticVerdict {
  const matches = findJsonObjects(text);
  for (let i = matches.length - 1; i >= 0; i--) {
    const raw = matches[i];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isValidVerdict(parsed)) {
        return { approved: parsed.approved, critique: parsed.critique };
      }
    } catch {
      // try the next earlier candidate
    }
  }
  return { approved: false, critique: text };
}

function isValidVerdict(v: unknown): v is CriticVerdict {
  return (
    typeof v === "object" &&
    v !== null &&
    "approved" in v &&
    typeof (v as CriticVerdict).approved === "boolean" &&
    "critique" in v &&
    typeof (v as CriticVerdict).critique === "string"
  );
}

/**
 * Scan `text` for substrings that start with `{` and are balanced with their
 * closing `}`. Ignores braces inside double-quoted strings.
 */
function findJsonObjects(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") { i++; continue; }
    const end = scanBalancedBrace(text, i);
    if (end < 0) { i++; continue; }
    out.push(text.slice(i, end + 1));
    i = end + 1;
  }
  return out;
}

function scanBalancedBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (c === "\\") { escaped = true; continue; }
      if (c === '"')  { inString = false; continue; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/team-critic-parser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/loom/teams/critic-parser.ts tests/team-critic-parser.test.ts
git commit -m "teams: parseCriticResponse with fallback"
```

---

### Task 6: Dispatcher critic loop (stub-injected runner)

**Files:**
- Create: `extensions/loom/teams/dispatcher.ts`
- Create: `tests/team-dispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `tests/team-dispatcher.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { runTeamDispatch } from "../extensions/loom/teams/dispatcher";
import type {
  TeamSpec,
  RoleTurnResult,
  DispatchDeps,
} from "../extensions/loom/teams/types";

function spec(overrides: Partial<TeamSpec> = {}): TeamSpec {
  return {
    description: "find relevant papers",
    roles: [
      { name: "Finder",    system_prompt: "find",    tools_read: [] },
      { name: "Validator", system_prompt: "validate", tools_read: [] },
    ],
    max_rounds: 5,
    ...overrides,
  };
}

function deps(script: Record<string, string[]>): DispatchDeps {
  const callIndex: Record<string, number> = { Finder: 0, Validator: 0 };
  return {
    runRoleTurn: async (role, _preamble, _user, _tools, _signal): Promise<RoleTurnResult> => {
      const idx = callIndex[role.name]++;
      const content = script[role.name]?.[idx] ?? "";
      return { content, usage: { input_tokens: 10, output_tokens: 10 } };
    },
  };
}

describe("runTeamDispatch", () => {
  it("converges when the validator approves round 1", async () => {
    const r = await runTeamDispatch(spec(), deps({
      Finder:    ["initial proposal"],
      Validator: ['{"approved": true, "critique": "great"}'],
    }), new AbortController().signal);
    expect(r.converged).toBe(true);
    expect(r.rounds).toBe(1);
    expect(r.final_output).toBe("initial proposal");
    expect(r.transcript).toHaveLength(2);
  });

  it("converges on round 3 of 5", async () => {
    const r = await runTeamDispatch(spec(), deps({
      Finder:    ["p1", "p2", "p3"],
      Validator: [
        '{"approved": false, "critique": "needs X"}',
        '{"approved": false, "critique": "still missing Y"}',
        '{"approved": true,  "critique": "ok"}',
      ],
    }), new AbortController().signal);
    expect(r.converged).toBe(true);
    expect(r.rounds).toBe(3);
    expect(r.final_output).toBe("p3");
    expect(r.transcript).toHaveLength(6);
  });

  it("returns best-so-far when max_rounds is hit without approval", async () => {
    const r = await runTeamDispatch(spec({ max_rounds: 2 }), deps({
      Finder:    ["p1", "p2"],
      Validator: [
        '{"approved": false, "critique": "bad"}',
        '{"approved": false, "critique": "still bad"}',
      ],
    }), new AbortController().signal);
    expect(r.converged).toBe(false);
    expect(r.rounds).toBe(2);
    expect(r.final_output).toBe("p2");
    expect(r.transcript).toHaveLength(4);
  });

  it("surfaces a role-turn error and returns gracefully", async () => {
    const ac = new AbortController();
    const deps: DispatchDeps = {
      runRoleTurn: async (role) => {
        if (role.name === "Validator") {
          throw new Error("provider 500");
        }
        return { content: "proposal", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    const r = await runTeamDispatch(spec(), deps, ac.signal);
    expect(r.converged).toBe(false);
    expect(r.error).toMatch(/provider 500/);
    expect(r.transcript.some((t) => t.role === "Finder")).toBe(true);
  });

  it("returns aborted=true when the signal fires mid-run", async () => {
    const ac = new AbortController();
    const deps: DispatchDeps = {
      runRoleTurn: async (_role, _p, _u, _t, signal) => {
        if (signal.aborted) {
          const err: any = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        ac.abort();  // abort after the first turn completes
        return { content: "p", usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
    const r = await runTeamDispatch(spec(), deps, ac.signal);
    expect(r.aborted).toBe(true);
    expect(r.converged).toBe(false);
  });

  it("halts with budget_exhausted when cumulative tokens exceed ceiling", async () => {
    const deps: DispatchDeps = {
      runRoleTurn: async () => ({
        content: "proposal",
        usage: { input_tokens: 200_000, output_tokens: 200_000 },
      }),
    };
    const r = await runTeamDispatch(
      spec({ max_rounds: 5 }),
      deps,
      new AbortController().signal,
      undefined,
      { tokenCeiling: 300_000 },
    );
    expect(r.budget_exhausted).toBe(true);
    expect(r.converged).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/team-dispatcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the dispatcher**

Write to `extensions/loom/teams/dispatcher.ts`:

```typescript
import { validateTeamSpec } from "./validate";
import { parseCriticResponse } from "./critic-parser";
import type {
  DispatchDeps,
  TeamResult,
  TeamSpec,
  TeamTurn,
} from "./types";

export interface DispatchOptions {
  tokenCeiling?: number;   // default 300_000
}

export type OnTurnUpdate = (snapshot: {
  round: number;
  max_rounds: number;
  current_role: string;
  turns: TeamTurn[];
}) => void;

const DEFAULT_TOKEN_CEILING = 300_000;

/**
 * Run the two-role critic loop to completion.
 * `deps.runRoleTurn` is injected so this function is unit-testable without
 * a real Pi runtime.
 */
export async function runTeamDispatch(
  spec: TeamSpec,
  deps: DispatchDeps,
  signal: AbortSignal,
  onTurn?: OnTurnUpdate,
  options: DispatchOptions = {},
): Promise<TeamResult> {
  validateTeamSpec(spec);

  const tokenCeiling = options.tokenCeiling ?? DEFAULT_TOKEN_CEILING;
  const maxRounds = spec.max_rounds ?? 5;
  const [proposer, critic] = spec.roles;
  const transcript: TeamTurn[] = [];
  let totalUsage = { input_tokens: 0, output_tokens: 0 };
  let currentProposal = "";
  let currentCritique: string | null = null;
  let round = 0;

  try {
    for (round = 1; round <= maxRounds; round++) {
      // --- Proposer turn ---
      if (signal.aborted) return aborted(transcript, round, currentProposal, totalUsage);
      const proposerInput = renderProposerInput(spec.description, currentCritique);
      const proposerPreamble = buildPreamble(spec, proposer, "proposer");
      const proposerResult = await deps.runRoleTurn(
        proposer, proposerPreamble, proposerInput, /* tools */ [], signal,
      );
      currentProposal = proposerResult.content;
      transcript.push({
        round, role: proposer.name, content: currentProposal,
        tool_calls: proposerResult.tool_calls,
      });
      totalUsage = add(totalUsage, proposerResult.usage);
      onTurn?.({ round, max_rounds: maxRounds, current_role: proposer.name, turns: transcript });

      if (exceedsCeiling(totalUsage, tokenCeiling)) {
        return budgetExhausted(transcript, round, currentProposal, totalUsage);
      }

      // --- Critic turn ---
      if (signal.aborted) return aborted(transcript, round, currentProposal, totalUsage);
      const criticInput = renderCriticInput(spec.description, currentProposal);
      const criticPreamble = buildPreamble(spec, critic, "critic");
      const criticResult = await deps.runRoleTurn(
        critic, criticPreamble, criticInput, /* tools */ [], signal,
      );
      const verdict = parseCriticResponse(criticResult.content);
      transcript.push({
        round, role: critic.name, content: criticResult.content,
        tool_calls: criticResult.tool_calls, approved: verdict.approved,
      });
      totalUsage = add(totalUsage, criticResult.usage);
      onTurn?.({ round, max_rounds: maxRounds, current_role: critic.name, turns: transcript });

      if (verdict.approved) {
        return {
          converged: true,
          rounds: round,
          final_output: currentProposal,
          transcript,
          usage: totalUsage,
        };
      }
      if (exceedsCeiling(totalUsage, tokenCeiling)) {
        return budgetExhausted(transcript, round, currentProposal, totalUsage);
      }
      currentCritique = verdict.critique;
    }

    return {
      converged: false,
      rounds: maxRounds,
      final_output: currentProposal,
      transcript,
      usage: totalUsage,
    };
  } catch (err) {
    if (isAbortError(err) || signal.aborted) {
      return aborted(transcript, round, currentProposal, totalUsage);
    }
    return {
      converged: false,
      rounds: round,
      final_output: currentProposal,
      transcript,
      usage: totalUsage,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- helpers ------------------------------------------------------------

function renderProposerInput(description: string, priorCritique: string | null): string {
  if (priorCritique === null) {
    return `Team task: ${description}\n\nProduce your first proposal.`;
  }
  return (
    `Team task: ${description}\n\n` +
    `The critic raised the following issues with your previous proposal:\n${priorCritique}\n\n` +
    `Produce a revised proposal that addresses them.`
  );
}

function renderCriticInput(description: string, proposal: string): string {
  return (
    `Team task: ${description}\n\n` +
    `Proposer output:\n${proposal}\n\n` +
    `Critique the proposal. End your response with a JSON line of shape ` +
    `{"approved": boolean, "critique": string}.`
  );
}

function buildPreamble(spec: TeamSpec, role: { system_prompt: string }, kind: "proposer" | "critic"): string {
  const teamContext =
    `You are one role in a two-agent team collaborating on the task: "${spec.description}". ` +
    `Respond only from your role's perspective.`;
  const criticContract = kind === "critic"
    ? ` When you have finished critiquing, finish your response with a JSON line: ` +
      `{"approved": boolean, "critique": "one paragraph"}.`
    : "";
  return `${teamContext}${criticContract}\n\n${role.system_prompt}`;
}

function add(a: { input_tokens: number; output_tokens: number }, b: { input_tokens: number; output_tokens: number }) {
  return { input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens };
}

function exceedsCeiling(u: { input_tokens: number; output_tokens: number }, ceiling: number): boolean {
  return u.input_tokens + u.output_tokens > ceiling;
}

function aborted(transcript: TeamTurn[], round: number, finalOutput: string, usage: { input_tokens: number; output_tokens: number }): TeamResult {
  return { converged: false, aborted: true, rounds: round, final_output: finalOutput, transcript, usage };
}

function budgetExhausted(transcript: TeamTurn[], round: number, finalOutput: string, usage: { input_tokens: number; output_tokens: number }): TeamResult {
  return { converged: false, budget_exhausted: true, rounds: round, final_output: finalOutput, transcript, usage };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message.toLowerCase().includes("abort"));
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/team-dispatcher.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: all tests pass (existing suite + the 4 new team test files).

- [ ] **Step 6: Commit**

```bash
git add extensions/loom/teams/dispatcher.ts tests/team-dispatcher.test.ts
git commit -m "teams: dispatcher critic loop with stub-injected runner"
```

---

### Task 7: Pi runner binding and `team_dispatch` tool

**Files:**
- Create: `extensions/loom/teams/tool.ts`
- Modify: `extensions/loom/index.ts` (add one import + one call)

This task binds `runRoleTurn` to Pi.dev's real Agent runtime and exposes `team_dispatch` as a registered tool. Because the Pi Agent API shape is runtime-verified, the implementer must consult the current type definitions at:

- `node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts` (Agent constructor, state, subscribe)
- `node_modules/@mariozechner/pi-agent-core/dist/agent-loop.d.ts` (`runAgentLoop` signature)
- `node_modules/@mariozechner/pi-agent-core/dist/types.d.ts` (AgentContext, AgentMessage)
- `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:299` (ExtensionContext, AgentToolUpdateCallback)

The abstraction boundary is `runRoleTurn` — its signature is fixed by `DispatchDeps` in `types.ts`. Only this function touches Pi internals; the rest of the feature is already tested.

- [ ] **Step 1: Write the tool registration scaffold**

Write to `extensions/loom/teams/tool.ts`:

```typescript
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { runTeamDispatch } from "./dispatcher";
import { validateTeamSpec } from "./validate";
import { filterToolsForRole, FilterError } from "./tool-filter";
import { isReadOnly } from "./readonly-registry";
import type {
  DispatchDeps,
  RoleTurnResult,
  TeamSpec,
} from "./types";

const RoleSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  system_prompt: Type.String({ minLength: 1 }),
  tools_read: Type.Array(Type.String()),
  tools_write: Type.Optional(Type.Array(Type.String())),
  model: Type.Optional(Type.String()),
});

const TeamSpecSchema = Type.Object({
  description: Type.String({ minLength: 1 }),
  roles: Type.Array(RoleSchema, { minItems: 2, maxItems: 2 }),
  max_rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  model: Type.Optional(Type.String()),
});

export function registerTeamTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "team_dispatch",
    label: "Dispatch specialist team",
    description:
      "Run a two-role critic loop (proposer → critic) to converge on a result. " +
      "Use when the user asks for a 'team' to handle a bounded sub-task such as " +
      "literature review or cross-checking findings. Returns the final converged " +
      "output; the main agent is responsible for persisting anything useful via " +
      "existing tools (e.g., interpretation_add_finding, analysis_plan_log_decision).",
    parameters: TeamSpecSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const spec = params as TeamSpec;

      // 1. Spec validation (fail fast).
      try {
        validateTeamSpec(spec);
      } catch (err) {
        return errorResult(err);
      }

      // 2. Per-role tool filtering — validates tool names and read-only constraint.
      const registry = buildToolRegistry(ctx);
      const perRoleTools: unknown[][] = [];
      try {
        for (const role of spec.roles) {
          perRoleTools.push(filterToolsForRole(role, registry, isReadOnly));
        }
      } catch (err) {
        if (err instanceof FilterError) return errorResult(err);
        throw err;
      }

      // 3. Build dependency bag with real Pi agent binding.
      const deps: DispatchDeps = {
        runRoleTurn: async (role, preamble, userMessage, _tools, runSignal): Promise<RoleTurnResult> => {
          return await runPiAgentTurn({
            ctx,
            model: role.model ?? spec.model,
            systemPrompt: preamble,
            userMessage,
            tools: perRoleTools[spec.roles.indexOf(role)],
            signal: runSignal,
          });
        },
      };

      // 4. Drive the loop. Forward progress updates to the tool card.
      const abort = signal ?? new AbortController().signal;
      const result = await runTeamDispatch(spec, deps, abort, (snapshot) => {
        onUpdate?.({
          summary:
            `Round ${snapshot.round}/${snapshot.max_rounds} — ${snapshot.current_role} responding…`,
          details: {
            kind: "team_dispatch",
            spec: {
              description: spec.description,
              roles: spec.roles.map((r) => ({ name: r.name, model: r.model ?? spec.model })),
            },
            turns: snapshot.turns,
          },
        });
      });

      // 5. Final tool-card summary.
      const finalSummary = result.converged
        ? `Team converged in ${result.rounds} round${result.rounds === 1 ? "" : "s"}`
        : result.aborted
          ? `Team aborted after ${result.rounds} round${result.rounds === 1 ? "" : "s"}`
          : result.budget_exhausted
            ? `Team halted on token budget after ${result.rounds} round${result.rounds === 1 ? "" : "s"}`
            : result.error
              ? `Team errored after ${result.rounds} round${result.rounds === 1 ? "" : "s"}: ${result.error}`
              : `Team did not converge (${result.rounds}/${spec.max_rounds ?? 5} rounds — best-so-far returned)`;

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {
          kind: "team_dispatch",
          spec: {
            description: spec.description,
            roles: spec.roles.map((r) => ({ name: r.name, model: r.model ?? spec.model })),
          },
          turns: result.transcript,
          summary: finalSummary,
        },
      };
    },
    renderResult: (result) => {
      const d = result.details as { summary?: string } | undefined;
      return new Text(d?.summary ?? "team_dispatch finished");
    },
  });
}

/** Construct the tool registry the dispatcher hands to `filterToolsForRole`. */
function buildToolRegistry(ctx: ExtensionContext): Map<string, unknown> {
  // Implementer: extract the live registry from ctx. Based on the current
  // ExtensionContext shape this may be ctx.tools, ctx.registry.tools, or
  // retrieved via ctx.sessionManager — inspect pi-coding-agent's types.d.ts
  // and write a one-line accessor here. The return type is Map<name, tool>.
  // If an accessor does not exist yet, request one upstream or construct
  // the map from pi.listTools()/pi.getTool() equivalents.
  throw new Error(
    "buildToolRegistry not implemented — see pi-coding-agent types.d.ts and bind here",
  );
}

/** Run a single Pi Agent turn for one role. */
async function runPiAgentTurn(args: {
  ctx: ExtensionContext;
  model: string | undefined;
  systemPrompt: string;
  userMessage: string;
  tools: unknown[];
  signal: AbortSignal;
}): Promise<RoleTurnResult> {
  // Implementer: instantiate a fresh `Agent` from @mariozechner/pi-agent-core
  // with:
  //   - initialState.tools  = args.tools
  //   - sessionId           = a stable per-team id (e.g., parent session + role)
  //   - streamFn / getApiKey= reuse ctx's equivalents so API keys are resolved
  // Send one user message (args.userMessage) with system prompt (args.systemPrompt),
  // drive it via runAgentLoop, collect:
  //   - final assistant text       -> content
  //   - tool calls made this turn  -> tool_calls
  //   - cumulative usage           -> usage
  // Return the RoleTurnResult.
  throw new Error(
    "runPiAgentTurn not implemented — see pi-agent-core agent.d.ts/agent-loop.d.ts",
  );
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }, null, 2) }],
    details: { kind: "team_dispatch", error: message, summary: `team_dispatch failed: ${message}` },
  };
}
```

- [ ] **Step 2: Implement the two `throw` stubs**

Open `node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts`, `agent-loop.d.ts`, and `types.d.ts`. Also open `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts` and look at `ExtensionContext` (line ~1..80 of that file) plus how existing Loom tools access tool listings.

Replace the body of `buildToolRegistry(ctx)` with the actual accessor, and the body of `runPiAgentTurn(args)` with an `Agent`-based implementation that:

1. Creates a fresh `Agent` with `initialState.tools = args.tools`, reusing the ambient `streamFn` / `getApiKey` / transport from `ctx` if available.
2. Constructs the prompt messages: one system message (`args.systemPrompt`) and one user message (`args.userMessage`).
3. Runs `runAgentLoop(prompts, agentContext, config, emit, args.signal)` — subscribe via `emit` to capture tool calls made by the role.
4. Extracts the final assistant text, tool_calls, and aggregated usage from the returned messages / events.

If the implementer cannot determine an API detail from the type files, they should not guess. Instead: add a focused `Task 7a` to this plan asking the user for guidance, and keep the dispatcher unit tests (Task 6) green in the meantime.

- [ ] **Step 3: Register in the extension**

In `extensions/loom/index.ts`, add an import near the other tool imports:

```typescript
import { registerTeamTools } from "./teams/tool";
```

And inside the `galaxyAnalystExtension(pi)` function, after `registerExecutionCommands(pi)`:

```typescript
  registerTeamTools(pi);
```

- [ ] **Step 4: Typecheck + full test suite**

Run:
```bash
npm run typecheck
npm test
```
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/loom/teams/tool.ts extensions/loom/index.ts
git commit -m "teams: register team_dispatch tool bound to Pi Agent"
```

---

### Task 8: Main-agent system-prompt guidance

**Files:**
- Modify: `extensions/loom/context.ts` (append to the no-active-plan and active-plan prompt sections)

- [ ] **Step 1: Locate the injection points**

Open `extensions/loom/context.ts`. In the `setupContextInjection(pi)` function there are two `systemPrompt:` string returns — one for "No active plan" and one for "Active plan". Both should reference the new `team_dispatch` tool.

- [ ] **Step 2: Append team-dispatch guidance to both prompts**

Add this block to both system prompts (insert before the closing backtick):

```text

## Team dispatch (for specialist sub-tasks)

When the user describes a short-lived specialist team (e.g., "start a team
for literature review — one finds papers, one validates"), use the
`team_dispatch` tool. The tool runs a two-role critic loop (proposer →
critic) and returns the converged result. You — not the team — are the
sole writer to the plan/notebook; after the tool returns, persist anything
useful via the appropriate existing tools (e.g., `interpretation_add_finding`,
`analysis_plan_log_decision`).

Composing the TeamSpec:
- Two roles are required. The first role proposes; the last role critiques
  and must end its turn with a JSON line {"approved": bool, "critique": string}.
- `tools_read` must only contain read-only tool names. If you want a role
  to mutate analysis state, put the specific tool name in `tools_write`
  — this is a deliberate opt-in.
- `max_rounds` defaults to 5 if omitted.

Confirmation heuristic: if the user's request gives concrete roles, task
framing, and tool preferences, dispatch without asking. If the request is
vague (e.g., "use a team"), propose the TeamSpec in chat and ask the user
to approve or edit it first.
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add extensions/loom/context.ts
git commit -m "teams: system-prompt guidance for team_dispatch"
```

---

### Task 9: Orbit renderer — collapsible team card

**Files:**
- Modify: `app/src/renderer/chat/chat-panel.ts`

The existing tool-card renderer displays tool `details` generically. We add a special branch for `details.kind === "team_dispatch"` that shows a collapsible summary with per-turn rows.

- [ ] **Step 1: Locate the tool-card render path**

Open `app/src/renderer/chat/chat-panel.ts`. Search for where tool `details` are rendered (likely a function that renders the details payload as JSON or a code block today).

- [ ] **Step 2: Add the team-card branch**

Add a rendering helper:

```typescript
function renderTeamDispatchCard(details: any): HTMLElement {
  const { spec, turns = [], summary } = details;
  const wrapper = document.createElement("div");
  wrapper.className = "team-dispatch-card";

  const header = document.createElement("button");
  header.className = "team-dispatch-header";
  header.type = "button";
  const roleLabels = (spec?.roles ?? []).map((r: any) => r.name).join(" × ");
  header.textContent = `${roleLabels || "Team"} — ${summary ?? `${turns.length} turn(s)`}`;

  const body = document.createElement("div");
  body.className = "team-dispatch-body hidden";

  for (const t of turns) {
    const row = document.createElement("div");
    row.className = "team-turn";
    const meta = document.createElement("div");
    meta.className = "team-turn-meta";
    const approvedMark = t.approved === true ? " ✓" : t.approved === false ? " ✗" : "";
    meta.textContent = `Round ${t.round} — ${t.role}${approvedMark}`;
    const content = document.createElement("pre");
    content.className = "team-turn-content";
    content.textContent = t.content ?? "";
    row.appendChild(meta);
    row.appendChild(content);
    body.appendChild(row);
  }

  header.addEventListener("click", () => body.classList.toggle("hidden"));
  wrapper.appendChild(header);
  wrapper.appendChild(body);
  return wrapper;
}
```

Wire it into the existing details-rendering branch so that when `details?.kind === "team_dispatch"` we return `renderTeamDispatchCard(details)` instead of the default rendering.

- [ ] **Step 3: Add minimal CSS**

Append to `app/src/renderer/styles.css`:

```css
.team-dispatch-card { margin: 6px 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.team-dispatch-header { width: 100%; text-align: left; background: var(--bg-hover); border: none; color: var(--text); padding: 6px 10px; cursor: pointer; font: inherit; }
.team-dispatch-body { padding: 6px 10px; background: var(--bg-surface); }
.team-dispatch-body.hidden { display: none; }
.team-turn { margin: 6px 0; }
.team-turn-meta { font-size: 11px; color: var(--text-dim); font-family: var(--font); }
.team-turn-content { white-space: pre-wrap; font: inherit; margin: 2px 0 8px; }
```

- [ ] **Step 4: Typecheck (renderer)**

Run: `cd app && npx tsc --noEmit`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer/chat/chat-panel.ts app/src/renderer/styles.css
git commit -m "orbit: collapsible team_dispatch card in chat panel"
```

---

### Task 10: Readonly-registry live-verification test and manual smoke

**Files:**
- Modify: `tests/team-readonly-registry.test.ts` — add a live-registry assertion.

- [ ] **Step 1: Add the live-registry test**

Append to `tests/team-readonly-registry.test.ts`:

```typescript
import galaxyAnalystExtension from "../extensions/loom";

describe("readonly-registry live coverage", () => {
  it("every curated Loom name is registered by the extension", () => {
    const seenNames = new Set<string>();
    const fakePi: any = {
      on: () => {},
      registerTool: (def: any) => seenNames.add(def.name),
      registerCommand: () => {},
      listResources: () => [],
      // Pi surface methods that might be called during init:
      addResource: () => {},
    };
    galaxyAnalystExtension(fakePi);

    for (const name of READONLY_LOOM_TOOLS) {
      expect(seenNames, `${name} in registry`).toContain(name);
    }
  });
});
```

If the test fails, the curated list has drifted. Either remove the missing entry from `READONLY_LOOM_TOOLS` or add the missing tool upstream. Do NOT add fakes to make the test pass.

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/team-readonly-registry.test.ts`
Expected: PASS. If it fails, the curated list names a tool that doesn't exist — fix `READONLY_LOOM_TOOLS` in `extensions/loom/teams/readonly-registry.ts`, not the test.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 4: Manual smoke test (Orbit)**

Restart Orbit:

```bash
pkill -9 -f "electron/dist/electron" 2>/dev/null; sleep 1
cd app && npm start -- -- --no-sandbox
```

In the Orbit window:

1. Confirm the app launches and the agent reaches "Ready".
2. Send: "Start a two-agent team for a mini literature review on Pasilla knockdown in Drosophila. One finds papers, the other validates."
3. Verify a `team_dispatch` tool card appears in the chat.
4. Expand the card: per-round turns are visible with Finder/Validator labels.
5. Final summary reads "Team converged in N rounds" OR "Team did not converge (5/5 rounds — best-so-far returned)".
6. Nothing is written to the notebook by the team. After the tool returns, the main agent may choose to log findings — that's expected.

If step 2's response does not use `team_dispatch`, check the system-prompt guidance in `extensions/loom/context.ts` and verify the model sees it.

- [ ] **Step 5: Commit**

```bash
git add tests/team-readonly-registry.test.ts
git commit -m "teams: live-registry verification for curated readonly list"
```

---

### Task 11: PR readiness

**Files:**
- None (repository hygiene only)

- [ ] **Step 1: Review the diff against `main`**

Run: `git log --oneline main..HEAD`
Expected: 10+ focused commits on `feat/multi-agent-teams`.

- [ ] **Step 2: Rebase-squash if the commit history is too noisy**

Only if you want to clean history — otherwise leave as-is for bisectability:

```bash
git rebase -i main   # or --interactive, squash TDD test/impl pairs
```

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/multi-agent-teams
```

- [ ] **Step 4: Confirm push**

Run: `git status`
Expected: "Your branch is up to date with 'origin/feat/multi-agent-teams'."

The branch is ready for a draft PR against `dannon/loom` whenever the user wants to open it (mirroring the pattern used for the earlier PRs #9 / #10). Do not open the PR as part of plan execution — the user controls PR creation.

---

## Execution notes

- **Single-writer stays intact** — the dispatcher writes nothing to the plan / notebook / findings; only the main agent does, through existing tools.
- **Spec ambiguity escape hatch** — Task 7 calls out that if the Pi Agent API cannot be bound from the type files alone, the implementer adds `Task 7a` asking the user for guidance rather than guessing. Tasks 1-6 remain testable independently so forward progress is not blocked.
- **No upstream API changes** — the feature lives entirely inside this fork; a future upstream PR would need the `dannon/loom` maintainer's agreement on the single-writer architecture (see spec §1).
- **Token ceiling is a hard safety net** — even if the critic never approves and `max_rounds` is large, the dispatcher halts on cumulative usage > 300k (configurable). Revisit the ceiling after observing real-world runs.
