import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pollGalaxyNow, setCaptureTickHook } from "../extensions/orbit/galaxy-poller";
import { resetState, setNotebookPath } from "../extensions/orbit/state";

describe("capture tick hook", () => {
  afterEach(() => {
    setCaptureTickHook(null);
    resetState();
  });

  it("runs once per tick, counting ticks, even on a notebook with nothing in flight", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-poller-hook-"));
    try {
      const nb = path.join(dir, "notebook.md");
      fs.writeFileSync(nb, "# Analysis\n");
      setNotebookPath(nb);
      const seen: number[] = [];
      setCaptureTickHook(async (n) => {
        seen.push(n);
      });
      await pollGalaxyNow();
      await pollGalaxyNow();
      expect(seen).toHaveLength(2);
      expect(seen[1]).toBe(seen[0] + 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a hook that rejects does not take the tick down", async () => {
    setCaptureTickHook(async () => {
      throw new Error("boom");
    });
    await expect(pollGalaxyNow()).resolves.toMatchObject({ transitions: [] });
  });
});
