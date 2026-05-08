import { describe, it, expect } from "vitest";
import { runTeamDispatch } from "../extensions/loom/teams/dispatcher";
import type { TeamSpec, RoleTurnResult, DispatchDeps } from "../extensions/loom/teams/types";

function spec(overrides: Partial<TeamSpec> = {}): TeamSpec {
  return {
    description: "find relevant papers",
    roles: [
      { name: "Finder", system_prompt: "find" },
      { name: "Validator", system_prompt: "validate" },
    ],
    max_rounds: 5,
    ...overrides,
  };
}

function deps(script: Record<string, string[]>): DispatchDeps {
  const callIndex: Record<string, number> = { Finder: 0, Validator: 0 };
  return {
    runRoleTurn: async (role, _preamble, _user, _signal): Promise<RoleTurnResult> => {
      const idx = callIndex[role.name]++;
      const content = script[role.name]?.[idx] ?? "";
      return { content, usage: { input_tokens: 10, output_tokens: 10 } };
    },
  };
}

describe("runTeamDispatch", () => {
  it("converges when the validator approves round 1", async () => {
    const r = await runTeamDispatch(
      spec(),
      deps({
        Finder: ["initial proposal"],
        Validator: ['{"approved": true, "critique": "great"}'],
      }),
      new AbortController().signal,
    );
    expect(r.converged).toBe(true);
    expect(r.rounds).toBe(1);
    expect(r.final_output).toBe("initial proposal");
    expect(r.transcript).toHaveLength(2);
  });

  it("converges on round 3 of 5", async () => {
    const r = await runTeamDispatch(
      spec(),
      deps({
        Finder: ["p1", "p2", "p3"],
        Validator: [
          '{"approved": false, "critique": "needs X"}',
          '{"approved": false, "critique": "still missing Y"}',
          '{"approved": true,  "critique": "ok"}',
        ],
      }),
      new AbortController().signal,
    );
    expect(r.converged).toBe(true);
    expect(r.rounds).toBe(3);
    expect(r.final_output).toBe("p3");
    expect(r.transcript).toHaveLength(6);
  });

  it("returns best-so-far when max_rounds is hit without approval", async () => {
    const r = await runTeamDispatch(
      spec({ max_rounds: 2 }),
      deps({
        Finder: ["p1", "p2"],
        Validator: [
          '{"approved": false, "critique": "bad"}',
          '{"approved": false, "critique": "still bad"}',
        ],
      }),
      new AbortController().signal,
    );
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
      runRoleTurn: async (_role, _p, _u, signal) => {
        if (signal.aborted) {
          const err: any = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        ac.abort(); // abort after the first turn completes
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
