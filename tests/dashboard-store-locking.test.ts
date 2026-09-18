import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import {
  DASHBOARD_FILENAME,
  createDefaultDashboardDocument,
  parseDashboardDocument,
} from "../shared/dashboard-contract.js";
import {
  replaceDashboardDocument,
  resetDashboardUndo,
  undoDashboardChange,
  updateDashboardDocument,
} from "../extensions/loom/dashboard-store";

/**
 * The layout file has three writers and one in-process lock. `updateDashboard-
 * Document` takes it; `replaceDashboardDocument` and `undoDashboardChange` used
 * not to, which meant either of them could land between an update's revision
 * check and its rename -- the exact window the compare-and-swap exists to close,
 * surviving in the two paths whose job is to be the escape hatch out of a bad
 * file.
 *
 * Real directories and real files. What makes these deterministic is the lock
 * itself: the queue runs in call order, so the second caller sees the first
 * caller's bytes. Without it the two interleave and the assertions below fail.
 */
describe("dashboard-store write serialization", () => {
  let dir: string;
  let layoutPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-dashboard-lock-"));
    layoutPath = join(dir, DASHBOARD_FILENAME);
    setNotebookPath(join(dir, "notebook.md"));
    resetDashboardUndo();
  });

  afterEach(() => {
    resetState();
    resetDashboardUndo();
    rmSync(dir, { recursive: true, force: true });
  });

  function titleOnDisk(): string {
    const parsed = parseDashboardDocument(readFileSync(layoutPath, "utf-8"));
    return parsed.document.dashboards[0].title;
  }

  function withTitle(title: string) {
    const doc = createDefaultDashboardDocument();
    doc.dashboards[0].title = title;
    return doc;
  }

  /**
   * One interleaving is not a measurement. Unlocked, the reset race is won by
   * the update most of the time but not every time -- an independent reviewer
   * measured 98 in 100 and a single-shot assertion caught it about one run in
   * two. Repeating it turns "it happened to pass" into a number: pre-fix these
   * fail within the first few trials, post-fix all TRIALS pass.
   */
  const TRIALS = 40;

  it("does not let a reset land inside an update's check-then-rename", async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      await updateDashboardDocument((current) => {
        current.dashboards[0].title = "original";
        return { ok: true, document: current };
      });

      // Started on the same tick, which is the shape the reviewer reproduced: a
      // user typing `/dashboard reset` while a tool call is already in flight.
      const [reset, update] = await Promise.all([
        replaceDashboardDocument(withTitle("reset")),
        updateDashboardDocument((current) => {
          current.dashboards[0].title = `${current.dashboards[0].title}+edited`;
          return { ok: true, document: current };
        }),
      ]);

      expect(reset.ok).toBe(true);
      expect(update.ok).toBe(true);
      // The update ran second, so it edited the reset document rather than the
      // pre-reset one. Unlocked, it reads "original", and the reset it reported
      // as written is nowhere on disk -- two successes, one of them a lie.
      expect(titleOnDisk()).toBe("reset+edited");
    }
  });

  it("does not let an undo and an update both write from the same revision", async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      resetDashboardUndo();
      await updateDashboardDocument((current) => {
        current.dashboards[0].title = "first";
        return { ok: true, document: current };
      });
      await updateDashboardDocument((current) => {
        current.dashboards[0].title = "second";
        return { ok: true, document: current };
      });

      const [undone, update] = await Promise.all([
        undoDashboardChange(),
        updateDashboardDocument((current) => {
          current.dashboards[0].title = `${current.dashboards[0].title}+edited`;
          return { ok: true, document: current };
        }),
      ]);

      expect(undone).toMatchObject({ ok: true, restored: "previous" });
      expect(update.ok).toBe(true);
      // Undo ran first and put "first" back, so the edit is on top of that.
      // Unlocked, both compare-and-swaps pass against the same revision -- undo
      // reports the restore and the update writes over it from the stale read.
      expect(titleOnDisk()).toBe("first+edited");
    }
  });
});
