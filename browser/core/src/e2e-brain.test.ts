// @vitest-environment node
/**
 * The e2e tiers' brain check (e2e/brain.cjs), which run-all.sh runs after every stub-backed drive:
 * a build that boots something other than Orbit's brain must fail the tier, and a drive that never
 * reaches the model must not.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { grade } = createRequire(import.meta.url)("../../e2e/brain.cjs") as {
  grade: (prompts: Array<{ tools?: string[] }>) => string[] | null;
};

const ORBIT = [{ tools: ["galaxy_read_output", "galaxy_job_record", "get_histories"] }];
// Read-only grants: the record writers are gone, the mark is not.
const ORBIT_READ = [{ tools: ["galaxy_read_output", "get_histories"] }];
const BROWSER = [{ tools: ["notebook_resume", "finish", "get_histories"] }];

describe("e2e brain check", () => {
  it("passes Orbit's brain on its own tools", () => {
    expect(grade(ORBIT)).toEqual([]);
    expect(grade(ORBIT_READ)).toEqual([]);
  });

  it("fails the browser brain's old tools", () => {
    expect(grade(BROWSER)).toEqual([
      "no request declared galaxy_read_output",
      "request 1 declared finish",
      "request 1 declared notebook_resume",
    ]);
  });

  it("says nothing for a drive that sent the model no tools", () => {
    expect(grade([{ tools: [] }, {}])).toBeNull();
  });
});
