import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { buildSandboxConfig, hostFromUrl } from "../extensions/loom/sandbox/sandbox-config";

describe("hostFromUrl", () => {
  it("extracts the host and tolerates junk", () => {
    expect(hostFromUrl("https://usegalaxy.org/")).toBe("usegalaxy.org");
    expect(hostFromUrl("https://my.galaxy.example:8080/x")).toBe("my.galaxy.example");
    expect(hostFromUrl(undefined)).toBeUndefined();
    expect(hostFromUrl("not a url")).toBeUndefined();
  });

  it("extracts the host from a scheme-less URL (the form config/env often supply)", () => {
    expect(hostFromUrl("usegalaxy.org")).toBe("usegalaxy.org");
    expect(hostFromUrl("test.galaxyproject.org/")).toBe("test.galaxyproject.org");
    expect(hostFromUrl("my.galaxy.example:8080/x")).toBe("my.galaxy.example");
  });

  it("keeps a loopback http host (the one non-https scheme Galaxy permits)", () => {
    expect(hostFromUrl("http://127.0.0.1:8080")).toBe("127.0.0.1");
  });

  it("ignores non-http(s) schemes so they can't seed the network allowlist", () => {
    // Galaxy speaks http(s); ftp:// / file:// (even with a host) must not allowlist one.
    expect(hostFromUrl("ftp://x.org")).toBeUndefined();
    expect(hostFromUrl("file://evil.example/etc/passwd")).toBeUndefined();
  });

  it("yields no host for empty or unparseable input", () => {
    expect(hostFromUrl("")).toBeUndefined();
    expect(hostFromUrl("   ")).toBeUndefined();
  });
});

describe("buildSandboxConfig", () => {
  const base = { cwd: "/home/alice/project", tmpDir: "/tmp" };

  it("allows writing the workspace, tmp, and .loom", () => {
    const fs = buildSandboxConfig(base).filesystem!;
    expect(fs.allowWrite).toContain("/home/alice/project");
    expect(fs.allowWrite).toContain("/tmp");
    // buildSandboxConfig derives this entry with path.join, so match the same way
    // (avoids a POSIX-vs-Windows separator mismatch in CI).
    expect(fs.allowWrite).toContain(path.join("/home/alice/project", ".loom"));
  });

  it("denies reading the credential set", () => {
    const fs = buildSandboxConfig(base).filesystem!;
    expect(fs.denyRead).toEqual(
      expect.arrayContaining(["~/.ssh", "~/.aws", "~/.loom/config.json", "~/Library/Keychains"]),
    );
  });

  it("denies writing secret files even inside the workspace", () => {
    const fs = buildSandboxConfig(base).filesystem!;
    expect(fs.denyWrite).toEqual(expect.arrayContaining([".env", "*.pem", "*.key"]));
  });

  it("network: deny-all bash by default, allowlisting the Galaxy host when known", () => {
    expect(buildSandboxConfig(base).network!.allowedDomains).toEqual([]);
    const c = buildSandboxConfig({ ...base, galaxyUrl: "https://usegalaxy.org" });
    expect(c.network!.allowedDomains).toContain("usegalaxy.org");
  });

  it("allowlists the Galaxy host even when the configured URL is scheme-less", () => {
    const c = buildSandboxConfig({ ...base, galaxyUrl: "usegalaxy.org" });
    expect(c.network!.allowedDomains).toContain("usegalaxy.org");
  });

  it("includes extra write roots and extra allowed domains", () => {
    const c = buildSandboxConfig({
      ...base,
      extraWriteRoots: ["/data/shared"],
      extraAllowedDomains: ["pypi.org"],
    });
    expect(c.filesystem!.allowWrite).toContain("/data/shared");
    expect(c.network!.allowedDomains).toContain("pypi.org");
  });
});
