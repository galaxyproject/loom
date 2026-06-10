import { describe, it, expect, afterEach } from "vitest";
import { getGalaxyConfig } from "../extensions/loom/galaxy-api";

describe("getGalaxyConfig", () => {
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  afterEach(() => {
    if (origUrl !== undefined) process.env.GALAXY_URL = origUrl;
    else delete process.env.GALAXY_URL;
    if (origKey !== undefined) process.env.GALAXY_API_KEY = origKey;
    else delete process.env.GALAXY_API_KEY;
  });

  it("returns null when env vars missing", () => {
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    expect(getGalaxyConfig()).toBeNull();
  });

  it("returns null when only URL is set", () => {
    process.env.GALAXY_URL = "https://usegalaxy.org";
    delete process.env.GALAXY_API_KEY;
    expect(getGalaxyConfig()).toBeNull();
  });

  it("returns config when env vars set", () => {
    process.env.GALAXY_URL = "https://usegalaxy.org/";
    process.env.GALAXY_API_KEY = "test-key-123";

    const config = getGalaxyConfig();
    expect(config).not.toBeNull();
    expect(config!.url).toBe("https://usegalaxy.org");
    expect(config!.apiKey).toBe("test-key-123");
  });

  it("strips trailing slashes from URL", () => {
    process.env.GALAXY_URL = "https://usegalaxy.org///";
    process.env.GALAXY_API_KEY = "key";

    const config = getGalaxyConfig();
    expect(config!.url).toBe("https://usegalaxy.org");
  });

  it("prepends https:// when the URL is scheme-less", () => {
    // Config profiles / env often store the host without a scheme
    // ("test.galaxyproject.org/"), which fetch() cannot parse.
    process.env.GALAXY_URL = "test.galaxyproject.org/";
    process.env.GALAXY_API_KEY = "key";

    const config = getGalaxyConfig();
    expect(config!.url).toBe("https://test.galaxyproject.org");
  });

  it("preserves an explicit http:// scheme", () => {
    process.env.GALAXY_URL = "http://localhost:8080/";
    process.env.GALAXY_API_KEY = "key";

    const config = getGalaxyConfig();
    expect(config!.url).toBe("http://localhost:8080");
  });
});
