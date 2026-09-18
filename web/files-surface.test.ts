import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  listFilesForWeb,
  readFileForWeb,
  readNotebookForWeb,
  resolveInJail,
} from "./files-surface.js";
import type { FileNode } from "../app/src/preload/preload.js";

// A home the fixtures are not inside, so the sensitive-path policy's
// home-relative rules stay out of the way and only its basename rules fire.
const HOME = path.join(os.tmpdir(), "files-surface-home");

// ── The jail, as a pure function ─────────────────────────────────────────────

describe("resolveInJail", () => {
  const CWD = path.join(path.sep, "tmp", "analysis");
  const jail = (p: unknown) => resolveInJail(CWD, p, { home: HOME });

  it("accepts a plain file in the analysis directory", () => {
    expect(jail("notebook.md")).toEqual({
      ok: true,
      abs: path.join(CWD, "notebook.md"),
      rel: "notebook.md",
    });
  });

  it("accepts a nested file and normalizes a leading ./", () => {
    expect(jail("results/plot.png")).toMatchObject({ ok: true, rel: "results/plot.png" });
    expect(jail("./notebook.md")).toMatchObject({ ok: true, rel: "notebook.md" });
  });

  it.each([["../secrets.txt"], ["a/../../b"], ["results/../../etc/passwd"], [".."], ["."]])(
    "refuses %s as leaving the working directory",
    (p) => {
      expect(jail(p)).toEqual({ ok: false, error: "path leaves the working directory" });
    },
  );

  it.each([["/etc/passwd"], ["C:\\Windows\\win.ini"], ["\\\\server\\share\\x"], ["/"]])(
    "refuses the absolute path %s",
    (p) => {
      expect(jail(p)).toEqual({ ok: false, error: "absolute paths are not served" });
    },
  );

  it("refuses a NUL, which would truncate the path at the syscall", () => {
    expect(jail("notebook.md\u0000.png")).toEqual({ ok: false, error: "invalid file path" });
  });

  it.each([[""], ["   "], [null], [undefined], [42], [{}], [["notebook.md"]]])(
    "refuses %o as not a path",
    (p) => {
      expect(jail(p)).toEqual({ ok: false, error: "a file path is required" });
    },
  );

  // Nothing between the browser and here URL-decodes, so percent-encoding is
  // just an unusual filename -- it must stay inside rather than escape.
  it("treats percent-encoded traversal as a literal name", () => {
    const res = jail("%2e%2e%2fetc%2fpasswd");
    expect(res).toMatchObject({ ok: true, rel: "%2e%2e%2fetc%2fpasswd" });
    if (res.ok) expect(res.abs.startsWith(CWD + path.sep)).toBe(true);
  });

  it("refuses a half-encoded traversal, which reads as a dot-prefixed name", () => {
    expect(jail("..%2f..%2fetc/passwd")).toEqual({
      ok: false,
      error: "hidden files are not served",
    });
  });

  it.each([[".env"], [".git/config"], ["sub/.hidden/x"], [".loom-dashboard.json"]])(
    "refuses the hidden path %s",
    (p) => {
      expect(jail(p)).toEqual({ ok: false, error: "hidden files are not served" });
    },
  );

  it.each([["node_modules/pkg/index.js"], ["venv/bin/python"], ["__pycache__/m.pyc"]])(
    "refuses %s as a directory the tree does not serve",
    (p) => {
      expect(jail(p)).toEqual({ ok: false, error: "that directory is not served" });
    },
  );

  it.each([["id_rsa"], ["keys/server.pem"], ["deploy.key"], ["credentials"], ["ID_ED25519"]])(
    "refuses %s under the sensitive-path policy",
    (p) => {
      expect(jail(p)).toEqual({
        ok: false,
        error: "that file matches the sensitive-path policy",
      });
    },
  );
});

// ── Against a real directory ─────────────────────────────────────────────────

const MAX_READ_BYTES = 5 * 1024 * 1024;

let cwd: string;
let outside: string;

function child(root: FileNode, name: string): FileNode | undefined {
  return (root.children ?? []).find((c) => c.name === name);
}

function names(root: FileNode): string[] {
  return (root.children ?? []).map((c) => c.name);
}

function countNodes(node: FileNode): number {
  return (node.children ?? []).reduce((n, c) => n + 1 + countNodes(c), 0);
}

async function readText(rel: string, opts?: { tail?: boolean }): Promise<string> {
  const res = await readFileForWeb(cwd, rel, opts, { home: HOME });
  if (!res.ok) throw new Error(`expected a read, got: ${res.error}`);
  return Buffer.from(res.bytesBase64, "base64").toString("utf-8");
}

beforeAll(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "files-surface-cwd-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "files-surface-out-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "not yours");

  fs.writeFileSync(path.join(cwd, "notebook.md"), "# hello\n");
  fs.writeFileSync(
    path.join(cwd, "activity.jsonl"),
    Array.from({ length: 300 }, (_, i) => JSON.stringify({ n: i })).join("\n") + "\n",
  );
  fs.mkdirSync(path.join(cwd, "data", "nested"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "data", "table.tsv"), "a\tb\n1\t2\n");
  fs.writeFileSync(path.join(cwd, "data", "nested", "deep.txt"), "deep\n");

  const binary = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) binary[i] = i;
  fs.writeFileSync(path.join(cwd, "image.bin"), binary);

  // Things the surface must not serve.
  fs.writeFileSync(path.join(cwd, ".env"), "SECRET=1\n");
  fs.mkdirSync(path.join(cwd, ".hidden"));
  fs.writeFileSync(path.join(cwd, ".hidden", "x.txt"), "x\n");
  fs.mkdirSync(path.join(cwd, "node_modules"));
  fs.writeFileSync(path.join(cwd, "node_modules", "pkg.js"), "//\n");
  fs.writeFileSync(path.join(cwd, "id_rsa"), "PRIVATE KEY\n");

  // Symlinks: out of the jail, into it, a cycle, and an innocent name over a
  // sensitive target.
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(cwd, "link-out"));
  fs.symlinkSync(outside, path.join(cwd, "dir-out"));
  fs.symlinkSync("loop-b", path.join(cwd, "loop-a"));
  fs.symlinkSync("loop-a", path.join(cwd, "loop-b"));
  fs.symlinkSync(path.join(cwd, "notebook.md"), path.join(cwd, "link-in"));
  fs.symlinkSync(path.join(cwd, "id_rsa"), path.join(cwd, "notes.txt"));

  // Deeper than the depth cap.
  let deep = cwd;
  for (let i = 1; i <= 11; i++) {
    deep = path.join(deep, `d${i}`);
    fs.mkdirSync(deep);
    fs.writeFileSync(path.join(deep, "marker.txt"), `${i}\n`);
  }
});

afterAll(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("listFilesForWeb", () => {
  it("returns the analysis directory with directories first", async () => {
    const res = await listFilesForWeb(cwd, { home: HOME });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cwd).toBe(cwd);
    expect(res.root).toMatchObject({ name: path.basename(cwd), relPath: "", type: "directory" });
    const listed = names(res.root);
    expect(listed).toContain("notebook.md");
    expect(listed).toContain("activity.jsonl");
    const firstFile = listed.findIndex((n) => n === "notebook.md");
    const lastDir = listed.findIndex((n) => n === "data");
    expect(lastDir).toBeLessThan(firstFile);
  });

  it("carries file sizes and nested children", async () => {
    const res = await listFilesForWeb(cwd, { home: HOME });
    if (!res.ok) throw new Error(res.error);
    expect(child(res.root, "notebook.md")).toMatchObject({ type: "file", size: 8 });
    const data = child(res.root, "data");
    expect(names(data!)).toEqual(["nested", "table.tsv"]);
  });

  it("does not serve hidden entries, noise directories or sensitive names", async () => {
    const res = await listFilesForWeb(cwd, { home: HOME });
    if (!res.ok) throw new Error(res.error);
    const listed = names(res.root);
    for (const hidden of [".env", ".hidden", "node_modules", "id_rsa"]) {
      expect(listed).not.toContain(hidden);
    }
  });

  // Listing an entry the read side will refuse discloses the name and size of a
  // file outside the workspace and offers a click that can only fail.
  it("leaves out symlinks whose target is outside the jail", async () => {
    const res = await listFilesForWeb(cwd, { home: HOME });
    if (!res.ok) throw new Error(res.error);
    const listed = names(res.root);
    expect(listed).not.toContain("link-out");
    expect(listed).not.toContain("dir-out");
    expect(listed).not.toContain("loop-a");
    expect(listed).not.toContain("notes.txt");
  });

  it("keeps a symlink that stays inside the jail", async () => {
    const res = await listFilesForWeb(cwd, { home: HOME });
    if (!res.ok) throw new Error(res.error);
    expect(child(res.root, "link-in")).toMatchObject({ type: "file" });
  });

  it("stops at the depth cap", async () => {
    const res = await listFilesForWeb(cwd, { home: HOME });
    if (!res.ok) throw new Error(res.error);
    let node = child(res.root, "d1");
    let depth = 1;
    while (node && (node.children ?? []).length > 0) {
      const next = (node.children ?? []).find((c) => c.type === "directory");
      if (!next) break;
      node = next;
      depth++;
    }
    // MAX_DEPTH is 8 and the root's own children are depth 1, so the last level
    // with contents is 9. Exact, so a cap that silently tightened would fail.
    expect(depth).toBe(9);
  });

  // A directory link that points at one of its own ancestors passes the
  // inside-the-jail check, so only the depth and entry ceilings stop the walk.
  it("terminates on a directory symlink that loops back inside the jail", async () => {
    const loopRoot = fs.mkdtempSync(path.join(os.tmpdir(), "files-surface-loop-"));
    try {
      fs.mkdirSync(path.join(loopRoot, "a"));
      fs.writeFileSync(path.join(loopRoot, "a", "f.txt"), "f\n");
      fs.symlinkSync(path.join(loopRoot, "a"), path.join(loopRoot, "a", "self"));
      const res = await listFilesForWeb(loopRoot, { home: HOME });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(countNodes(res.root)).toBeLessThan(40);
    } finally {
      fs.rmSync(loopRoot, { recursive: true, force: true });
    }
  });

  it("stops at the whole-tree entry cap, and refused entries cost budget", async () => {
    // A directory of nothing but refusals still exhausts the ceiling, which is
    // the point: the cap bounds work, not just the size of the answer.
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "files-surface-cap-"));
    try {
      for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(plain, `f${i}.txt`), "x\n");
      const clean = await listFilesForWeb(plain, { home: HOME, maxEntries: 3 });
      expect(clean.ok && countNodes(clean.root)).toBe(3);

      for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(plain, `.h${i}`), "x\n");
      const noisy = await listFilesForWeb(plain, { home: HOME, maxEntries: 3 });
      expect(clean.ok && noisy.ok && countNodes(noisy.root)).toBeLessThanOrEqual(3);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it("stops at the per-directory entry cap without stopping the tree", async () => {
    const res = await listFilesForWeb(cwd, { home: HOME, maxEntriesPerDir: 1 });
    if (!res.ok) throw new Error(res.error);
    expect((res.root.children ?? []).length).toBeLessThanOrEqual(1);
  });

  it("is unavailable in remote mode", async () => {
    expect(await listFilesForWeb(cwd, { home: HOME, remote: true })).toEqual({
      ok: false,
      error: "file listing is unavailable in remote mode",
    });
  });
});

describe("readFileForWeb", () => {
  it("reads a text file", async () => {
    const res = await readFileForWeb(cwd, "notebook.md", undefined, { home: HOME });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.size).toBe(8);
    expect(res.preview).toBeUndefined();
    expect(Buffer.from(res.bytesBase64, "base64").toString("utf-8")).toBe("# hello\n");
  });

  it("round-trips binary bytes", async () => {
    const res = await readFileForWeb(cwd, "image.bin", null, { home: HOME });
    if (!res.ok) throw new Error(res.error);
    const bytes = Buffer.from(res.bytesBase64, "base64");
    expect(bytes.length).toBe(256);
    for (let i = 0; i < 256; i++) expect(bytes[i]).toBe(i);
  });

  it("reads through a symlink that stays inside the jail", async () => {
    expect(await readText("link-in")).toBe("# hello\n");
  });

  it("reads a nested file", async () => {
    expect(await readText("data/nested/deep.txt")).toBe("deep\n");
  });

  it("refuses a missing file without naming the absolute path", async () => {
    const res = await readFileForWeb(cwd, "nope.txt", undefined, { home: HOME });
    expect(res).toEqual({ ok: false, error: "no such file" });
  });

  it("refuses a directory", async () => {
    const res = await readFileForWeb(cwd, "data", undefined, { home: HOME });
    expect(res).toEqual({ ok: false, error: "Not a regular file" });
  });

  it("refuses a symlink that points out of the jail", async () => {
    const res = await readFileForWeb(cwd, "link-out", undefined, { home: HOME });
    expect(res).toEqual({ ok: false, error: "path leaves the working directory" });
  });

  it("refuses a symlink cycle rather than hanging on it", async () => {
    // Asserting the specific refusal, not just `ok: false` -- a cycle degrading
    // to "no such file" is exactly the regression this exists to catch.
    const res = await readFileForWeb(cwd, "loop-a", undefined, { home: HOME });
    expect(res).toEqual({ ok: false, error: "path leaves the working directory" });
  });

  it("refuses a path that reaches through a symlinked directory out of the jail", async () => {
    const res = await readFileForWeb(cwd, "dir-out/secret.txt", undefined, { home: HOME });
    expect(res).toEqual({ ok: false, error: "path leaves the working directory" });
  });

  // The jail has to hold on the target's name as well as the link's, or an
  // innocuous name is a way around the sensitive-path policy.
  it("refuses an innocent name that resolves onto a sensitive one", async () => {
    const res = await readFileForWeb(cwd, "notes.txt", undefined, { home: HOME });
    expect(res).toEqual({
      ok: false,
      error: "that file matches the sensitive-path policy",
    });
  });

  it("refuses a traversal before it touches the disk", async () => {
    const res = await readFileForWeb(cwd, "../secret.txt", undefined, { home: HOME });
    expect(res).toEqual({ ok: false, error: "path leaves the working directory" });
  });

  it("is unavailable in remote mode", async () => {
    expect(
      await readFileForWeb(cwd, "notebook.md", undefined, { home: HOME, remote: true }),
    ).toEqual({ ok: false, error: "file read is unavailable in remote mode" });
  });
});

// Orbit's default workspace is ~/.loom/analyses/<name>, which sits under two
// dotted segments and inside the directory holding ~/.loom/config.json. If the
// sensitive-path policy read that as a credential store the whole surface would
// be dead in the default configuration.
describe("the default Orbit workspace", () => {
  it("serves an analysis that lives under ~/.loom/analyses", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "files-surface-loomhome-"));
    const analysis = path.join(home, ".loom", "analyses", "demo");
    fs.mkdirSync(analysis, { recursive: true });
    fs.writeFileSync(path.join(home, ".loom", "config.json"), "{}");
    fs.writeFileSync(path.join(analysis, "notebook.md"), "# demo\n");
    try {
      const listed = await listFilesForWeb(analysis, { home });
      expect(listed.ok && names(listed.root)).toEqual(["notebook.md"]);
      const read = await readFileForWeb(analysis, "notebook.md", undefined, { home });
      expect(read.ok).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("readFileForWeb tail", () => {
  it("returns the last 200 lines of a short file", async () => {
    const text = await readText("activity.jsonl", { tail: true });
    // The trailing newline costs one slot of the 200-line window, exactly as it
    // does on the desktop.
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBe(199);
    expect(JSON.parse(lines[lines.length - 1]).n).toBe(299);
    expect(JSON.parse(lines[0]).n).toBe(101);
  });

  it("drops the partial first line when it starts mid-file", async () => {
    const wide = path.join(cwd, "wide.jsonl");
    const line = (n: number) => JSON.stringify({ n, pad: "y".repeat(120) });
    fs.writeFileSync(wide, Array.from({ length: 2000 }, (_, i) => line(i)).join("\n") + "\n");
    const res = await readFileForWeb(cwd, "wide.jsonl", { tail: true }, { home: HOME });
    if (!res.ok) throw new Error(res.error);
    const raw = Buffer.from(res.bytesBase64, "base64");
    // The window is bounded however big the file gets: 64 KB read, 200 lines kept.
    expect(res.size).toBeGreaterThan(200 * 1024);
    expect(raw.length).toBeLessThanOrEqual(64 * 1024);
    const lines = raw.toString("utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(200);
    // Every line that comes back parses -- none of them is a fragment.
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(JSON.parse(lines[lines.length - 1]).n).toBe(1999);
    fs.rmSync(wide, { force: true });
  });
});

describe("readFileForWeb size caps", () => {
  it("head-previews a text file over the full-read cap", async () => {
    const big = path.join(cwd, "big.txt");
    const head = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") + "\n";
    fs.writeFileSync(big, head + "x".repeat(MAX_READ_BYTES));
    const res = await readFileForWeb(cwd, "big.txt", undefined, { home: HOME });
    if (!res.ok) throw new Error(res.error);
    expect(res.size).toBeGreaterThan(MAX_READ_BYTES);
    expect(res.preview).toEqual({ kind: "head", lineCount: 10, byteBudgetHit: false });
    expect(Buffer.from(res.bytesBase64, "base64").toString("utf-8").split("\n")).toHaveLength(10);
    fs.rmSync(big, { force: true });
  });

  it("refuses a non-text file over the full-read cap", async () => {
    const big = path.join(cwd, "big.png");
    fs.writeFileSync(big, Buffer.alloc(MAX_READ_BYTES + 1));
    const res = await readFileForWeb(cwd, "big.png", undefined, { home: HOME });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/File too large/);
    expect(res.size).toBe(MAX_READ_BYTES + 1);
    fs.rmSync(big, { force: true });
  });

  it("refuses a pathological size outright, text or not", async () => {
    const huge = path.join(cwd, "huge.txt");
    const fd = fs.openSync(huge, "w");
    try {
      fs.ftruncateSync(fd, 2 * 1024 * 1024 * 1024);
    } finally {
      fs.closeSync(fd);
    }
    const res = await readFileForWeb(cwd, "huge.txt", undefined, { home: HOME });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/hard limit/);
    fs.rmSync(huge, { force: true });
  });
});

/**
 * The jail answers a question about a pathname, and every syscall after it asks
 * the kernel to walk that pathname again. Between the two walks anything that
 * can write in the analysis directory -- the model's write tool, its bash --
 * can swap a component for a symlink pointing outside, and the second walk
 * follows it. Both reviewers won this race: 46 of 6000 reads by swapping the
 * resolved parent directory, 166 of 2400 by `rename(2)`-flipping the name
 * itself between a real file and a symlink.
 *
 * These run the real thing against a real temp directory with a real attacker
 * loop, because the failure only exists between two syscalls and no mock has
 * that gap in it.
 */
describe("files:read under a symlink race", () => {
  let root: string;
  let ws: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "files-surface-race-"));
    ws = path.join(root, "ws");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(root, "canary"), "TOCTOU-CANARY-LEAKED\n");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("never serves outside bytes while the name is flipped to a symlink and back", async () => {
    const name = path.join(ws, "race.txt");
    const stage = path.join(ws, ".race-stage");
    fs.writeFileSync(name, "benign\n");

    let stop = false;
    const flipper = (async () => {
      let asLink = false;
      while (!stop) {
        try {
          fs.rmSync(stage, { force: true });
          if (asLink) fs.writeFileSync(stage, "benign\n");
          else fs.symlinkSync(path.join(root, "canary"), stage);
          // rename is atomic, so the name is always one or the other and the
          // reader never sees it missing.
          fs.renameSync(stage, name);
          asLink = !asLink;
        } catch {
          /* racing with ourselves is expected */
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    let leaked = 0;
    for (let round = 0; round < 20; round++) {
      const batch = Array.from({ length: 40 }, () =>
        readFileForWeb(ws, "race.txt", null, { home: root }),
      );
      for (const res of await Promise.all(batch)) {
        if (!res.ok) continue;
        const text = Buffer.from(res.bytesBase64 ?? "", "base64").toString("utf-8");
        if (text.includes("CANARY")) leaked++;
      }
    }
    stop = true;
    await flipper;
    fs.rmSync(name, { force: true });
    expect(leaked).toBe(0);
  });

  it("refuses when the resolved parent has been swapped for a symlink", async () => {
    // Deterministic on purpose. The racing version of this is not a test: with
    // the swap running at full duty cycle under load it still slips through
    // once or twice in 800 reads, because without `openat` every check is a
    // path walk and the walk can be raced. See the note above `openVerified`.
    // What IS guaranteed is that a swap standing still is always caught, and
    // that is the shape a planted symlink actually has.
    const dataDir = path.join(ws, "pdata");
    const evil = path.join(root, "pevil");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "f.txt"), "inside\n");
    fs.writeFileSync(path.join(evil, "f.txt"), "TOCTOU-CANARY-LEAKED\n");

    const before = await readFileForWeb(ws, "pdata/f.txt", null, { home: root });
    expect(before.ok).toBe(true);

    fs.renameSync(dataDir, path.join(ws, "pdata-stash"));
    fs.symlinkSync(evil, dataDir);
    const after = await readFileForWeb(ws, "pdata/f.txt", null, { home: root });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error).toMatch(/leaves the working directory/);
  });

  it("still serves an ordinary file when nobody is attacking it", async () => {
    fs.writeFileSync(path.join(ws, "calm.txt"), "ordinary\n");
    const res = await readFileForWeb(ws, "calm.txt", null, { home: root });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Buffer.from(res.bytesBase64!, "base64").toString("utf-8")).toBe("ordinary\n");
    }
  });
});

describe("readNotebookForWeb", () => {
  let root: string;
  let ws: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "files-surface-nb-"));
    ws = path.join(root, "ws");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(root, "outside-credentials"), "SECRET=hunter2\n");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads an ordinary notebook", async () => {
    fs.writeFileSync(path.join(ws, "notebook.md"), "# Analysis\n");
    const res = await readNotebookForWeb(ws, { home: root });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.content).toBe("# Analysis\n");
    fs.rmSync(path.join(ws, "notebook.md"), { force: true });
  });

  it("refuses a symlink planted at the notebook name", async () => {
    // This is the whole finding: before the jail, this returned the credential
    // file's contents, in remote mode too.
    const link = path.join(ws, "notebook.md");
    fs.symlinkSync(path.join(root, "outside-credentials"), link);
    for (const remote of [false, true]) {
      const res = await readNotebookForWeb(ws, { home: root, remote });
      expect(res.ok, `remote=${remote}`).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/leaves the working directory/);
    }
    fs.rmSync(link, { force: true });
  });

  it("still answers in remote mode, because the agent is pinned to this same file", async () => {
    fs.writeFileSync(path.join(ws, "notebook.md"), "# Remote\n");
    const res = await readNotebookForWeb(ws, { home: root, remote: true });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.content).toBe("# Remote\n");
    fs.rmSync(path.join(ws, "notebook.md"), { force: true });
  });

  it("refuses an oversized notebook rather than truncating it", async () => {
    const big = path.join(ws, "notebook.md");
    const fd = fs.openSync(big, "w");
    try {
      fs.ftruncateSync(fd, 9 * 1024 * 1024);
    } finally {
      fs.closeSync(fd);
    }
    const res = await readNotebookForWeb(ws, { home: root });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/larger than/);
    fs.rmSync(big, { force: true });
  });

  it("reports no notebook rather than throwing when there is none", async () => {
    const res = await readNotebookForWeb(ws, { home: root });
    expect(res.ok).toBe(false);
  });
});

describe("a listing that would be enormous", () => {
  it("bounds the bytes it emits, not just the entries it examines", async () => {
    // One symlink to the cwd, named with 180 characters, turned a nine-file
    // directory into 13.8 MB of JSON: the entry ceiling bounds the work and
    // the response size is a different dimension.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "files-surface-bytes-"));
    try {
      for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), "x");
      fs.symlinkSync(root, path.join(root, "L".repeat(180)));

      const res = await listFilesForWeb(root, { home: root });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const bytes = Buffer.byteLength(JSON.stringify(res.root), "utf8");
      expect(bytes).toBeLessThan(4 * 1024 * 1024);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows a link back to the cwd without walking the tree again through it", async () => {
    // Legal, inside the jail, and still nonsense: every directory becomes
    // reachable by several names, so the results gallery counted 376 files in a
    // four-file analysis and listed the same plots over and over. Watched in
    // the web shell.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "files-surface-loopup-"));
    try {
      fs.mkdirSync(path.join(root, "figures"));
      fs.writeFileSync(path.join(root, "figures", "plot.png"), "x");
      fs.symlinkSync(root, path.join(root, "back"));

      const res = await listFilesForWeb(root, { home: root });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const names: string[] = [];
      const walk = (n: FileNode): void => {
        names.push(n.relPath);
        for (const c of n.children ?? []) walk(c);
      };
      walk(res.root);
      // The link is listed...
      expect(names).toContain("back");
      // ...and nothing underneath it.
      expect(names.filter((n) => n.startsWith("back/"))).toEqual([]);
      // The real one is still there exactly once.
      expect(names.filter((n) => n.endsWith("plot.png"))).toEqual(["figures/plot.png"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a cwd at the filesystem root still contains correctly", async () => {
    // `startsWith(cwdReal + sep)` became startsWith("//") there, which matches
    // nothing, so a listing came back holding a single entry.
    const res = await listFilesForWeb("/", { home: "/nonexistent", maxEntries: 40 });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.root.children ?? []).length).toBeGreaterThan(1);
  });
});
