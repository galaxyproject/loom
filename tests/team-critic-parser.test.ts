import { describe, it, expect } from "vitest";
import { parseCriticResponse } from "../extensions/loom/teams/critic-parser";

describe("parseCriticResponse", () => {
  it("parses bare JSON on one line", () => {
    const r = parseCriticResponse('{"approved": true, "critique": "looks good"}');
    expect(r).toEqual({ approved: true, critique: "looks good" });
  });

  it("parses JSON at end of a longer response", () => {
    const text =
      "Here is my reasoning.\nThe proposal misses X.\n" +
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
