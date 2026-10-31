// @vitest-environment node
import { describe, expect, it } from "vitest";

import { orbitGrant, UnmappableGrant } from "./grants";

describe("orbitGrant", () => {
  it.each([
    [["llm", "local", "read", "write"], { galaxy: "write", python: true }],
    [["llm", "read", "write"], { galaxy: "write", python: false }],
    [["llm", "read"], { galaxy: "read", python: false }],
    [["llm", "local", "read"], { galaxy: "read", python: true }],
  ])("maps %j", (capabilities, grant) => {
    expect(orbitGrant(capabilities)).toEqual(grant);
  });

  it.each([
    [["local", "read", "write"], /"llm"/],
    [["llm", "local", "write"], /"read"/],
    [["llm", "read", "admin"], /admin/],
    [[], /"llm"/],
  ])("refuses %j", (capabilities, reason) => {
    expect(() => orbitGrant(capabilities)).toThrow(UnmappableGrant);
    expect(() => orbitGrant(capabilities)).toThrow(reason);
  });
});
