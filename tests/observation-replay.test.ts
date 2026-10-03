import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DRY_RUN_INSTALL_TOKEN,
  isObservationReplayEnabled,
  parseObservationReplayFile,
  resolveObservationReplayPath,
} from "../extensions/loom/observation-replay.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-obs-replay-"));
  delete process.env.ORBIT_OBSERVATION_REPLAY;
  delete process.env.LOOM_OBSERVATION_REPLAY;
});

afterEach(() => {
  delete process.env.ORBIT_OBSERVATION_REPLAY;
  delete process.env.LOOM_OBSERVATION_REPLAY;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("isObservationReplayEnabled", () => {
  it("is off unless a file is named, under either spelling", () => {
    expect(isObservationReplayEnabled()).toBe(false);
    process.env.LOOM_OBSERVATION_REPLAY = "observations.jsonl";
    expect(isObservationReplayEnabled()).toBe(true);
    delete process.env.LOOM_OBSERVATION_REPLAY;
    process.env.ORBIT_OBSERVATION_REPLAY = "observations.jsonl";
    expect(isObservationReplayEnabled()).toBe(true);
  });

  it("is off for a blank value", () => {
    process.env.ORBIT_OBSERVATION_REPLAY = "   ";
    expect(isObservationReplayEnabled()).toBe(false);
  });
});

describe("parseObservationReplayFile", () => {
  it("skips blank and malformed lines and entries with no tool", () => {
    const entries = parseObservationReplayFile(
      [
        '{"tool":"galaxy_run_tool","text":"boom","isError":true}',
        "",
        "{ broken",
        '{"text":"no tool here"}',
        '{"tool":"galaxy_invoke_workflow","args":{"tool_id":"Filter1"},"text":"bang"}',
      ].join("\n"),
    );
    expect(entries).toHaveLength(2);
    expect(entries[1].args).toEqual({ tool_id: "Filter1" });
  });
});

describe("resolveObservationReplayPath", () => {
  it("resolves inside the session directory", () => {
    fs.writeFileSync(path.join(tmp, "observations.jsonl"), "", "utf-8");
    expect(resolveObservationReplayPath(tmp, "observations.jsonl")).toBe(
      fs.realpathSync(path.join(tmp, "observations.jsonl")),
    );
  });

  it("refuses a path that escapes, including through a symlink", () => {
    expect(resolveObservationReplayPath(tmp, "../outside.jsonl")).toBeNull();
    expect(resolveObservationReplayPath(tmp, "/etc/hosts")).toBeNull();
    const outside = path.join(os.tmpdir(), `loom-obs-outside-${process.pid}.jsonl`);
    fs.writeFileSync(outside, "", "utf-8");
    try {
      fs.symlinkSync(outside, path.join(tmp, "link.jsonl"));
      expect(resolveObservationReplayPath(tmp, "link.jsonl")).toBeNull();
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

describe("DRY_RUN_INSTALL_TOKEN", () => {
  it("is a valid-shaped token that is obviously not a real one", () => {
    expect(DRY_RUN_INSTALL_TOKEN).toMatch(/^[0-9a-f]{32}$/);
    expect(DRY_RUN_INSTALL_TOKEN).toBe("0".repeat(32));
  });
});
