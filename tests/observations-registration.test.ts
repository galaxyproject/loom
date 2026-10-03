import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const indexPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "extensions",
  "loom",
  "index.ts",
);
// Comments stripped, so a mention of a register call in prose can't satisfy
// (or spoil) the ordering check.
const source = fs
  .readFileSync(indexPath, "utf-8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

describe("observation collector registration", () => {
  it("registers the triggers and the commands", () => {
    expect(source).toContain("registerObservationTriggers(pi)");
    expect(source).toContain("registerObservationsCommand(pi)");
  });

  it("registers the triggers AFTER secret redaction", () => {
    // pi runs tool_result handlers in registration order and each sees the
    // previous one's rewrite, so reading the result before redaction would put
    // an API key one normalization away from the wire.
    const redaction = source.indexOf("registerSecretRedaction(pi)");
    const triggers = source.indexOf("registerObservationTriggers(pi)");
    expect(redaction).toBeGreaterThan(-1);
    expect(triggers).toBeGreaterThan(redaction);
    // And unconditionally: nothing between them can return early or branch the
    // trigger registration away.
    const between = source.slice(redaction, triggers);
    expect(between).not.toMatch(/\breturn\b|\bif\s*\(/);
    expect(source.match(/registerObservationTriggers\(pi\)/g)).toHaveLength(1);
  });
});

describe("docs", () => {
  const docsPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "docs",
    "agent",
    "commands.md",
  );
  const docs = fs.readFileSync(docsPath, "utf-8");

  it("lists both commands and says they belong to the user", () => {
    expect(docs).toContain("/observations");
    expect(docs).toContain("/observe");
    expect(docs).toMatch(/`\/observations` and `\/observe` are the user's/);
  });
});
