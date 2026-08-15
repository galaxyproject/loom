import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  capContent,
  discoverInstructionFiles,
  INSTRUCTIONS_FILENAME,
  MAX_BYTES,
  MAX_FILES,
  MAX_LINES,
  type FsLike,
} from "../extensions/loom/user-instructions";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-instr-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Build a dir under the tmp root, optionally seeding it with a LOOM.md. */
function seed(rel: string, content?: string): string {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (content !== undefined) fs.writeFileSync(path.join(dir, INSTRUCTIONS_FILENAME), content);
  return dir;
}

/** A stub fs whose stat/read behavior the test dictates. */
function stubFs(over: Partial<FsLike>): FsLike {
  return {
    statSync: () => ({ isFile: () => true }),
    openSync: () => 1,
    readSync: () => 0,
    closeSync: () => undefined,
    realpathSync: (p: string) => p,
    ...over,
  };
}

describe("capContent", () => {
  it("leaves a small file alone", () => {
    const { text, truncated } = capContent("Prefer IWC workflows.\n");

    expect(text).toBe("Prefer IWC workflows.");
    expect(truncated).toBe(false);
  });

  it("caps at MAX_LINES and marks the cut", () => {
    const raw = Array.from({ length: MAX_LINES + 50 }, (_, i) => `line ${i}`).join("\n");

    const { text, truncated } = capContent(raw);

    expect(truncated).toBe(true);
    expect(text).toContain("line 0");
    expect(text).toContain(`line ${MAX_LINES - 1}`);
    expect(text).not.toContain(`line ${MAX_LINES}`);
    expect(text).toContain("truncated");
  });

  it("cuts cleanly when the byte cap lands mid-character", () => {
    // The 1-byte prefix is what makes this bite: 8192 is divisible by 4, so
    // 4-byte emoji alone would land exactly on a boundary and never split.
    const raw = "a" + "\u{1F9EC}".repeat(3000);
    expect((MAX_BYTES - 1) % 4).not.toBe(0); // the cut really is mid-codepoint

    const { text, truncated } = capContent(raw);

    expect(truncated).toBe(true);
    expect(text).not.toContain("�");
  });

  it("keeps a replacement character the user actually wrote", () => {
    // U+FFFD is 3 bytes, so this one sits fully inside the cap. An earlier
    // implementation stripped any trailing U+FFFD and silently ate it.
    const raw = "a".repeat(MAX_BYTES - 3) + "�" + "tail";

    const { text, truncated } = capContent(raw);

    expect(truncated).toBe(true);
    expect(text.startsWith("a".repeat(MAX_BYTES - 3) + "�")).toBe(true);
  });
});

describe("an over-cap file always says so", () => {
  // The bug: readBounded stops at the byte cap and decodes back to a codepoint
  // boundary, so the string it hands capContent is usually UNDER MAX_BYTES even
  // though the file was cut. Re-deriving truncation from that string's length
  // reported "not truncated" for 3 of 4 byte alignments and the user silently
  // lost the tail of their file.
  for (const prefix of [0, 1, 2, 3]) {
    it(`reports truncation at byte alignment ${prefix}`, () => {
      const cwd = seed("work", "a".repeat(prefix) + "\u{1F9EC}".repeat(5000));

      const found = discoverInstructionFiles({ cwd, agentDir: seed("agent") });

      expect(found).toHaveLength(1);
      expect(found[0].truncated).toBe(true);
      expect(found[0].content).toContain("truncated by Loom");
    });
  }

  it("does not cry truncation for a file that genuinely fits", () => {
    const cwd = seed("work", "Prefer IWC workflows.");

    const found = discoverInstructionFiles({ cwd, agentDir: seed("agent") });

    expect(found[0].truncated).toBe(false);
    expect(found[0].content).not.toContain("truncated by Loom");
  });

  it("honours an explicit already-truncated signal even for short text", () => {
    const { text, truncated } = capContent("short", true);

    expect(truncated).toBe(true);
    expect(text).toContain("truncated by Loom");
  });
});

describe("discoverInstructionFiles", () => {
  it("returns nothing when no LOOM.md exists anywhere", () => {
    expect(discoverInstructionFiles({ cwd: seed("work"), agentDir: seed("agent") })).toEqual([]);
  });

  it("finds the global file and tags it global", () => {
    const found = discoverInstructionFiles({
      cwd: seed("work"),
      agentDir: seed("agent", "Prefer IWC workflows.\n"),
    });

    expect(found).toHaveLength(1);
    expect(found[0].scope).toBe("global");
    expect(found[0].content).toBe("Prefer IWC workflows.");
  });

  it("finds a workspace file at the cwd", () => {
    const found = discoverInstructionFiles({
      cwd: seed("work", "Genome build is hg38.\n"),
      agentDir: seed("agent"),
    });

    expect(found).toHaveLength(1);
    expect(found[0].scope).toBe("workspace");
    expect(found[0].content).toBe("Genome build is hg38.");
  });

  it("orders global first, then ancestors outermost to nearest", () => {
    const agentDir = seed("agent", "global pref");
    seed("work", "outer pref");
    const cwd = seed("work/project", "inner pref");

    const found = discoverInstructionFiles({ cwd, agentDir });

    expect(found.map((f) => f.content)).toEqual(["global pref", "outer pref", "inner pref"]);
    expect(found.map((f) => f.scope)).toEqual(["global", "workspace", "workspace"]);
  });

  it("does not list the same file twice when cwd is the agent dir", () => {
    const shared = seed("agent", "only once");

    const found = discoverInstructionFiles({ cwd: shared, agentDir: shared });

    expect(found).toHaveLength(1);
    expect(found[0].scope).toBe("global");
  });

  it("treats an empty or whitespace-only file as absent", () => {
    expect(
      discoverInstructionFiles({ cwd: seed("work", "   \n\n\t\n"), agentDir: seed("agent") }),
    ).toEqual([]);
  });

  it("skips a directory that happens to be named LOOM.md", () => {
    const cwd = seed("work");
    fs.mkdirSync(path.join(cwd, INSTRUCTIONS_FILENAME));

    expect(discoverInstructionFiles({ cwd, agentDir: seed("agent") })).toEqual([]);
  });

  it("sheds the most distant ancestors, never the project's own file", () => {
    // MAX_FILES + 3 nested dirs, each with its own LOOM.md.
    const depth = MAX_FILES + 3;
    let rel = "deep";
    for (let i = 0; i < depth; i++) {
      seed(rel, `level ${i}`);
      rel = path.join(rel, `d${i}`);
    }
    const cwd = path.join(root, rel);
    fs.mkdirSync(cwd, { recursive: true });

    const found = discoverInstructionFiles({ cwd, agentDir: seed("agent") });

    expect(found).toHaveLength(MAX_FILES);
    // The nearest file survives; the outermost levels are the ones dropped.
    expect(found[found.length - 1].content).toBe(`level ${depth - 1}`);
    expect(found.some((f) => f.content === "level 0")).toBe(false);
  });

  it("never asks the filesystem for more than the cap, however big the file is", () => {
    const cwd = seed("work", "x");
    const lengths: number[] = [];
    const fsLike = stubFs({
      readSync: (_fd, buffer, _offset, length) => {
        lengths.push(length);
        buffer.write("Prefer IWC workflows.");
        return 21;
      },
    });

    discoverInstructionFiles({ cwd, agentDir: seed("agent"), fsLike });

    expect(lengths.length).toBeGreaterThan(0);
    for (const len of lengths) expect(len).toBeLessThanOrEqual(MAX_BYTES + 1);
  });

  it("surfaces a read error instead of hiding it", () => {
    // Injected rather than chmod-based: chmod 000 is a no-op for root and
    // meaningless on Windows, and CI runs windows-latest.
    const fsLike = stubFs({
      openSync: () => {
        const err: NodeJS.ErrnoException = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      },
    });

    const found = discoverInstructionFiles({
      cwd: seed("work", "unreadable"),
      agentDir: seed("agent"),
      fsLike,
    });
    const withError = found.filter((f) => f.error);

    expect(withError.length).toBeGreaterThan(0);
    expect(withError[0].error).toContain("EACCES");
    expect(withError[0].content).toBe("");
  });

  it("surfaces a stat error too, rather than mistaking it for a missing file", () => {
    const fsLike = stubFs({
      statSync: () => {
        const err: NodeJS.ErrnoException = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      },
    });

    const found = discoverInstructionFiles({ cwd: seed("work"), agentDir: seed("agent"), fsLike });

    expect(found.length).toBeGreaterThan(0);
    expect(found[0].error).toContain("EACCES");
  });

  it("still treats a genuine ENOENT as simply absent", () => {
    const fsLike = stubFs({
      statSync: () => {
        const err: NodeJS.ErrnoException = new Error("ENOENT: no such file");
        err.code = "ENOENT";
        throw err;
      },
    });

    expect(
      discoverInstructionFiles({ cwd: seed("work"), agentDir: seed("agent"), fsLike }),
    ).toEqual([]);
  });
});
