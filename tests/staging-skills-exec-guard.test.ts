/**
 * Staging skills are prose the model copies into `bash` almost verbatim. A
 * command the exec-guard always refuses teaches the model a denial, so every
 * shell example in `skills/` has to clear the catastrophic table -- including
 * after the model joins a backslash continuation onto one line, which it often
 * does.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { classifyBash } from "../extensions/orbit/exec-guard/bash-risk";

const SKILLS_DIR = path.resolve(__dirname, "..", "skills");

function skillFiles(): string[] {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(SKILLS_DIR, d.name, "SKILL.md"))
    .filter((p) => fs.existsSync(p));
}

function shellCommands(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)) {
    const joined = m[1].replace(/\\\n\s*/g, " ");
    for (const line of joined.split("\n")) {
      const cmd = line.trim();
      if (cmd && !cmd.startsWith("#")) out.push(cmd);
    }
  }
  return out;
}

describe("staging skill shell examples", () => {
  const files = skillFiles();

  it("finds at least one staging skill with shell examples", () => {
    expect(files.flatMap((f) => shellCommands(fs.readFileSync(f, "utf-8"))).length).toBeGreaterThan(
      0,
    );
  });

  for (const file of files) {
    it(`${path.relative(SKILLS_DIR, file)} teaches nothing the exec-guard always denies`, () => {
      const refused = shellCommands(fs.readFileSync(file, "utf-8"))
        .map((cmd) => ({ cmd, c: classifyBash(cmd, "/home/u", "/home/u/work") }))
        .filter(({ c }) => c.kind === "catastrophic")
        .map(({ cmd, c }) => `${c.reason}: ${cmd}`);
      expect(refused).toEqual([]);
    });
  }
});
