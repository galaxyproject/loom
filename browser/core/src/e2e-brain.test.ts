// @vitest-environment node
/**
 * The e2e tiers' brain check (e2e/brain.cjs), which run-all.sh runs after every stub-backed drive:
 * a flag build that boots the wrong brain must fail the tier, and a drive that never reaches the
 * model must not.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { grade } = createRequire(import.meta.url)("../../e2e/brain.cjs") as {
  grade: (prompts: Array<{ tools?: string[] }>, expected: string) => string[] | null;
};

const BROWSER = [{ tools: ["notebook_resume", "finish", "get_histories"] }];
const ORBIT = [{ tools: ["galaxy_read_output", "galaxy_job_record", "get_histories"] }];
// Read-only grants: the record writers are gone, the marks are not.
const BROWSER_READ = [{ tools: ["finish", "get_histories"] }];
const ORBIT_READ = [{ tools: ["galaxy_read_output", "get_histories"] }];

describe("e2e brain check", () => {
  it("passes each brain on its own tools", () => {
    expect(grade(BROWSER, "browser")).toEqual([]);
    expect(grade(ORBIT, "orbit")).toEqual([]);
    expect(grade(BROWSER_READ, "browser")).toEqual([]);
    expect(grade(ORBIT_READ, "orbit")).toEqual([]);
  });

  it("fails each brain on the other's", () => {
    expect(grade(BROWSER, "orbit")).toEqual([
      "no request declared galaxy_read_output",
      "request 1 declared finish",
      "request 1 declared notebook_resume",
    ]);
    expect(grade(ORBIT, "browser")).toEqual([
      "no request declared finish",
      "request 1 declared galaxy_read_output",
      "request 1 declared galaxy_job_record",
    ]);
  });

  it("says nothing for a drive that sent the model no tools", () => {
    expect(grade([{ tools: [] }, {}], "orbit")).toBeNull();
  });

  it("refuses a brain it doesn't know", () => {
    expect(() => grade(ORBIT, "olit")).toThrow(/browser or orbit/);
  });
});
