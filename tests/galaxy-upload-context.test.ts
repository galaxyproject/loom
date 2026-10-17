import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../extensions/loom/config", () => ({
  loadConfig: () => ({ executionMode: "hybrid" }),
}));

import { buildGalaxyContextBlock } from "../extensions/loom/context";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";

let prev: Record<string, string | undefined>;

beforeEach(() => {
  prev = { url: process.env.GALAXY_URL, key: process.env.GALAXY_API_KEY };
  process.env.GALAXY_URL = "https://galaxy.test";
  process.env.GALAXY_API_KEY = "k";
});

afterEach(() => {
  setCapabilityProfile(null);
  process.env.GALAXY_URL = prev.url;
  process.env.GALAXY_API_KEY = prev.key;
});

describe("buildGalaxyContextBlock upload guidance", () => {
  it("steers local uploads to galaxy_upload_local_file when connected", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toContain("galaxy_upload_local_file");
    expect(block).toContain("mcp__galaxy__upload_file_from_url");
    expect(block).toContain("submit compatible accessions in ONE tool call");
    expect(block).toContain("comma-separated string in input|accession");
    expect(block).toContain("reuse verified inputs and wait for matching imports already running");
    expect(block).toContain("single HDA, not a mapped HDCA");
  });

  it("does not name the local upload tool where the profile registers none", () => {
    setCapabilityProfile({ ...profileFromEnv({}), files: false });
    const block = buildGalaxyContextBlock();
    expect(block).not.toContain("galaxy_upload_local_file");
    expect(block).toContain("use the URL upload");
    expect(block).toContain("mcp__galaxy__upload_file_from_url");
  });
});
