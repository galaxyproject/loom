import { describe, it, expect } from "vitest";
import { validateTeamSpec, ValidationError } from "../extensions/loom/teams/validate";
import type { TeamSpec } from "../extensions/loom/teams/types";

const ok = (): TeamSpec => ({
  description: "find relevant RNA-seq papers",
  roles: [
    { name: "Finder", system_prompt: "find papers" },
    { name: "Validator", system_prompt: "score relevance" },
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
      roles: [...ok().roles, { name: "Extra", system_prompt: "x" }],
    };
    expect(() => validateTeamSpec(bad)).toThrow(/MVP/);
  });

  it("rejects duplicate role names", () => {
    const r = { name: "Same", system_prompt: "x" };
    const bad: TeamSpec = { ...ok(), roles: [r, { ...r }] };
    expect(() => validateTeamSpec(bad)).toThrow(/unique/);
  });

  it("rejects empty role name", () => {
    const bad: TeamSpec = {
      ...ok(),
      roles: [{ name: "", system_prompt: "x" }, ok().roles[1]],
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
