import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../extensions/loom/config", () => ({
  loadConfig: () => ({ executionMode: "hybrid" }),
}));

import { buildGalaxyContextBlock } from "../extensions/loom/context";

let prev: Record<string, string | undefined>;

beforeEach(() => {
  prev = { url: process.env.GALAXY_URL, key: process.env.GALAXY_API_KEY };
  process.env.GALAXY_URL = "https://galaxy.test";
  process.env.GALAXY_API_KEY = "k";
});

afterEach(() => {
  process.env.GALAXY_URL = prev.url;
  process.env.GALAXY_API_KEY = prev.key;
});

describe("buildGalaxyContextBlock upload guidance", () => {
  it("steers local uploads to galaxy_upload_local_file when connected", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toContain("galaxy_upload_local_file");
    expect(block).toContain("galaxy_upload_file_from_url");
  });
});
