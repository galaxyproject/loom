import { describe, expect, it } from "vitest";
import { shouldRefreshOpenFile } from "../app/src/renderer/files/file-change-match.js";

/**
 * Issue #313: with a file open in the File-tab editor, creating or modifying any
 * *unrelated* file in the project popped the "This file changed on disk" banner
 * over the open file. The watcher sent a bare `files:changed` with no payload, so
 * the renderer re-read the open file on every event; a dirty editor always differs
 * from disk, so the stale banner fired even though the open file never changed.
 *
 * The fix threads the set of changed paths through the event and only refreshes the
 * open file when one of them matches it. `shouldRefreshOpenFile` is that pure gate.
 */
describe("shouldRefreshOpenFile", () => {
  it("does not refresh when no file is open", () => {
    expect(shouldRefreshOpenFile(null, ["README.md"])).toBe(false);
    expect(shouldRefreshOpenFile(null, null)).toBe(false);
  });

  it("refreshes when the open file's exact path is among the changed paths", () => {
    expect(shouldRefreshOpenFile("README.md", ["README.md"])).toBe(true);
    expect(shouldRefreshOpenFile("docs/notes.md", ["src/a.ts", "docs/notes.md"])).toBe(true);
  });

  it("does not refresh when only unrelated files changed (#313)", () => {
    expect(shouldRefreshOpenFile("README.md", ["test"])).toBe(false);
    expect(shouldRefreshOpenFile("docs/notes.md", ["src/a.ts", "src/b.ts"])).toBe(false);
  });

  it("does not refresh when nothing nameable changed (empty set)", () => {
    expect(shouldRefreshOpenFile("README.md", [])).toBe(false);
  });

  it("refreshes conservatively when the changed set is unknown (null)", () => {
    // The watcher couldn't name the changed file(s) for this batch, so we can't
    // prove the open file is unaffected -- err toward a refresh, never a miss.
    expect(shouldRefreshOpenFile("README.md", null)).toBe(true);
  });

  it("normalizes backslash separators so a Windows relative path matches", () => {
    expect(shouldRefreshOpenFile("docs/notes.md", ["docs\\notes.md"])).toBe(true);
  });

  it("normalizes a leading ./ on a changed path", () => {
    expect(shouldRefreshOpenFile("README.md", ["./README.md"])).toBe(true);
  });

  it("does not match a same-named file in a different directory", () => {
    expect(shouldRefreshOpenFile("a/foo.txt", ["b/foo.txt"])).toBe(false);
  });

  it("normalizes a leading ./ on the open path too", () => {
    expect(shouldRefreshOpenFile("./README.md", ["README.md"])).toBe(true);
  });

  it("treats an empty open path as nothing open", () => {
    expect(shouldRefreshOpenFile("", ["README.md"])).toBe(false);
  });
});
