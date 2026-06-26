import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  initSessionArtifacts,
  onNotebookChange,
  reemitNotebookIfChanged,
  resetState,
  setNotebookPath,
  stopWatchingNotebook,
} from "../extensions/loom/state";

// #253: a bash write to notebook.md is missed by the single-file chokidar
// watcher -- an atomic temp-and-rename save (`sed -i`, editors) swaps the
// inode, and even a plain truncate can race the watcher's awaitWriteFinish
// window -- so the Notebook panel goes stale until the next `/notebook`. The
// tool_execution_end hook re-syncs by calling reemitNotebookIfChanged(), which
// must emit once when the file's content actually changed and stay quiet
// otherwise.
describe("reemitNotebookIfChanged (#253 notebook panel re-sync)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    resetState();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshSession(): { dir: string; seen: string[]; unsub: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "loom-reemit-"));
    dirs.push(dir);
    initSessionArtifacts(dir); // creates notebook.md, emits the initial "" once
    // These tests exercise reemitNotebookIfChanged() in isolation; drop the real
    // chokidar watcher so a late awaitWriteFinish callback can't append to `seen`
    // and make exact-array assertions flaky. reemit reads state.notebookPath
    // directly, so it still works with the watcher stopped.
    stopWatchingNotebook();
    const seen: string[] = [];
    const unsub = onNotebookChange((content) => seen.push(content));
    return { dir, seen, unsub };
  }

  it("emits once when notebook.md changed out of band", () => {
    const { dir, seen, unsub } = freshSession();

    writeFileSync(join(dir, "notebook.md"), "# Results\n", "utf-8");
    expect(reemitNotebookIfChanged()).toBe(true);

    expect(seen).toEqual(["# Results\n"]);
    unsub();
  });

  it("does not emit when notebook.md is unchanged", () => {
    const { seen, unsub } = freshSession();

    expect(reemitNotebookIfChanged()).toBe(false);
    expect(seen).toEqual([]);
    unsub();
  });

  it("does not re-emit the same change on a second call", () => {
    const { dir, seen, unsub } = freshSession();

    writeFileSync(join(dir, "notebook.md"), "# Results\n", "utf-8");
    expect(reemitNotebookIfChanged()).toBe(true);
    expect(reemitNotebookIfChanged()).toBe(false);

    expect(seen).toEqual(["# Results\n"]);
    unsub();
  });

  it("returns false when there is no active notebook", () => {
    resetState();
    expect(reemitNotebookIfChanged()).toBe(false);
  });

  it("emits on an inode-replacing write even when size and mtime are unchanged", () => {
    const { dir, seen, unsub } = freshSession();
    const nb = join(dir, "notebook.md");
    // Pin a fixed mtime so a mtime+size-only guard would treat the replacement
    // as identical -- this is the watcher-evading write #253 is really about.
    const fixed = new Date(1700000000000);

    writeFileSync(nb, "AAAA", "utf-8");
    utimesSync(nb, fixed, fixed);
    expect(reemitNotebookIfChanged()).toBe(true);
    expect(seen).toEqual(["AAAA"]);

    // Atomic temp-and-rename: new inode, same byte length, restored mtime.
    const tmp = join(dir, ".notebook.md.tmp");
    writeFileSync(tmp, "BBBB", "utf-8");
    renameSync(tmp, nb);
    utimesSync(nb, fixed, fixed);
    expect(statSync(nb).size).toBe(4); // same size as before

    seen.length = 0;
    expect(reemitNotebookIfChanged()).toBe(true);
    expect(seen).toEqual(["BBBB"]);
    unsub();
  });

  it("does not let a throwing listener break the caller or starve other listeners", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { dir, unsub } = freshSession();
      const unsubBad = onNotebookChange(() => {
        throw new Error("listener boom");
      });
      const seen: string[] = [];
      const unsubGood = onNotebookChange((content) => seen.push(content));

      writeFileSync(join(dir, "notebook.md"), "# After throw\n", "utf-8");

      // The tool_execution_end hook calls reemit; a misbehaving subscriber must
      // not throw out of it, and the well-behaved subscriber must still fire.
      expect(() => reemitNotebookIfChanged()).not.toThrow();
      expect(seen).toEqual(["# After throw\n"]);
      expect(errSpy).toHaveBeenCalled();

      unsubBad();
      unsubGood();
      unsub();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("re-emits when the notebook path switches to a same-content file", () => {
    const { unsub } = freshSession(); // notebook.md == ""
    unsub();

    const dir2 = mkdtempSync(join(tmpdir(), "loom-reemit-alt-"));
    dirs.push(dir2);
    const nb2 = join(dir2, "notebook.md");
    writeFileSync(nb2, "", "utf-8"); // identical content ("") to the first notebook

    setNotebookPath(nb2);
    stopWatchingNotebook();
    const seen: string[] = [];
    const unsub2 = onNotebookChange((content) => seen.push(content));

    // A new notebook that happens to share the old one's content must still
    // emit so the panel/header re-sync to the new file.
    expect(reemitNotebookIfChanged()).toBe(true);
    expect(seen).toEqual([""]);
    unsub2();
  });
});
