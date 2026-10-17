import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  appendActivityEvent,
  getActivityEvents,
  loadActivityLog,
  onActivityChange,
  resetActivity,
} from "../extensions/loom/activity";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";

const event = {
  timestamp: "2026-10-16T00:00:00.000Z",
  kind: "test.event",
  source: "test",
  payload: { n: 1 },
};

describe("activity log under a page notebook", () => {
  let dir: string;
  afterEach(() => {
    setCapabilityProfile(null);
    resetActivity();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the in-memory mirror and its listeners, and writes no file", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-activity-page-"));
    setCapabilityProfile({ ...profileFromEnv({}), notebook: "page" });
    let fired = 0;
    const off = onActivityChange(() => void fired++);
    try {
      expect(appendActivityEvent(dir, event)).toBeNull();
    } finally {
      off();
    }
    expect(fired).toBe(1);
    expect(getActivityEvents()).toEqual([event]);
    expect(fs.existsSync(path.join(dir, "activity.jsonl"))).toBe(false);
  });

  it("hydrates nothing from disk even when a file happens to be there", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-activity-page-"));
    fs.writeFileSync(path.join(dir, "activity.jsonl"), JSON.stringify(event) + "\n");
    setCapabilityProfile({ ...profileFromEnv({}), notebook: "page" });
    loadActivityLog(dir);
    expect(getActivityEvents()).toEqual([]);
    // The file backend is untouched: the same call with no profile reads it.
    setCapabilityProfile(null);
    loadActivityLog(dir);
    expect(getActivityEvents()).toEqual([event]);
  });

  it("still writes the sidecar for a file notebook", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-activity-page-"));
    expect(appendActivityEvent(dir, event)).toBe(path.join(dir, "activity.jsonl"));
    expect(fs.readFileSync(path.join(dir, "activity.jsonl"), "utf-8")).toBe(
      JSON.stringify(event) + "\n",
    );
  });
});
