import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Scenario } from "../evals/lib/types";

const __filename2 = fileURLToPath(import.meta.url);
const scenariosDir = path.resolve(path.dirname(__filename2), "..", "evals", "scenarios");

function loadScenario(name: string): Scenario {
  return JSON.parse(
    fs.readFileSync(path.join(scenariosDir, name, "scenario.json"), "utf-8"),
  ) as Scenario;
}

describe("evals scenarios: every scenario.json parses with required fields", () => {
  const dirs = fs
    .readdirSync(scenariosDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const dir of dirs) {
    it(`${dir} has name, tier, inputs, assertions`, () => {
      const s = loadScenario(dir);
      expect(typeof s.name).toBe("string");
      expect([1, 2]).toContain(s.tier);
      expect(Array.isArray(s.inputs)).toBe(true);
      expect(s.assertions).toBeTruthy();
    });
  }

  it("rnaseq routes galaxy/hybrid and names a known RNA-seq tool", () => {
    const s = loadScenario("plan-creation-rnaseq");
    expect(s.assertions.plan?.routingIn).toEqual(["galaxy", "hybrid"]);
    expect(s.assertions.plan?.mentionsOneOf).toContain("HISAT2");
  });

  it("pharmacogenomics routes local/hybrid (consumer data stays off public Galaxy)", () => {
    const s = loadScenario("plan-creation-pharmacogenomics");
    expect(s.assertions.plan?.routingIn).toEqual(["local", "hybrid"]);
  });
});
