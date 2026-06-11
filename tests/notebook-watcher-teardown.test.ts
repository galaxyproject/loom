import { afterEach, describe, expect, it, vi } from "vitest";

// Mock chokidar so we can assert watcher open/close without real fs-event
// timing. The bug (#271) is that the notebook FSWatcher is never closed on
// teardown, so it keeps firing and holds the event loop open (--print hangs).
const { watchMock, onMock, closeMock } = vi.hoisted(() => {
  const onMock = vi.fn();
  const closeMock = vi.fn();
  const watchMock = vi.fn(() => ({ on: onMock, close: closeMock }));
  return { watchMock, onMock, closeMock };
});

vi.mock("chokidar", () => ({ default: { watch: watchMock } }));

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetState, setNotebookPath, stopWatchingNotebook } from "../extensions/loom/state";

describe("notebook watcher teardown (#271)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    resetState();
    watchMock.mockClear();
    onMock.mockClear();
    closeMock.mockClear();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function freshNotebook(): string {
    const dir = mkdtempSync(join(tmpdir(), "loom-watcher-"));
    dirs.push(dir);
    const nb = join(dir, "notebook.md");
    writeFileSync(nb, "init", "utf-8");
    return nb;
  }

  it("opens a watcher when a notebook path is set", () => {
    setNotebookPath(freshNotebook());
    expect(watchMock).toHaveBeenCalledTimes(1);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("closes the watcher on stopWatchingNotebook so it stops firing and releases the loop", () => {
    setNotebookPath(freshNotebook());
    stopWatchingNotebook();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("closes the prior watcher before opening a new one (no leak across re-attach)", () => {
    setNotebookPath(freshNotebook());
    setNotebookPath(freshNotebook());
    expect(watchMock).toHaveBeenCalledTimes(2);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
