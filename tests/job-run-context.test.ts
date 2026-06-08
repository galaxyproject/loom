import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock("../extensions/loom/config", () => ({ loadConfig: loadConfigMock }));

import {
  buildVerificationDisciplineBlock,
  buildGalaxyContextBlock,
} from "../extensions/loom/context";

// #210: a galaxy_run_tool job that fails immediately wasn't surfaced in chat
// because the agent read the "Started tool" submission as success. The prompt
// must teach that submission != completion for single tool runs.

describe("buildVerificationDisciplineBlock — single tool run (#210)", () => {
  it("teaches that a submitted tool run still needs a terminal-state check", () => {
    const ctx = buildVerificationDisciplineBlock();
    expect(ctx).toContain("galaxy_run_tool");
    expect(ctx).toContain("submitted");
    expect(ctx).toContain("galaxy_get_job_details");
    expect(ctx).toContain("output dataset id");
    expect(ctx).toContain("report the failure");
  });
});

describe("buildGalaxyContextBlock — running a single tool (#210)", () => {
  const savedUrl = process.env.GALAXY_URL;
  const savedKey = process.env.GALAXY_API_KEY;

  beforeEach(() => {
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue({});
    process.env.GALAXY_URL = "https://usegalaxy.org";
    process.env.GALAXY_API_KEY = "k-testtesttest";
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.GALAXY_URL;
    else process.env.GALAXY_URL = savedUrl;
    if (savedKey === undefined) delete process.env.GALAXY_API_KEY;
    else process.env.GALAXY_API_KEY = savedKey;
  });

  it("warns that a single tool run returns a submitted job, not a finished run", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toContain("galaxy_run_tool");
    expect(block).toContain("submitted");
    expect(block).toContain("galaxy_get_job_details");
    expect(block).toContain("output dataset id");
  });
});
