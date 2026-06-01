import { describe, it, expect } from "vitest";
import {
  isSensitivePath,
  isProtectedWritePath,
} from "../extensions/loom/exec-guard/sensitive-read";

const HOME = "/home/alice";
describe("isSensitivePath", () => {
  it("flags ssh, aws, gcloud, netrc, env, loom config", () => {
    for (const p of [
      "/home/alice/.ssh/id_rsa",
      "/home/alice/.aws/credentials",
      "/home/alice/.config/gcloud/access_tokens.db",
      "/home/alice/.netrc",
      "/home/alice/project/.env",
      "/home/alice/.loom/config.json",
    ])
      expect(isSensitivePath(p, HOME), p).toBe(true);
  });
  it("flags key/pem files anywhere", () => {
    expect(isSensitivePath("/home/alice/project/server.key", HOME)).toBe(true);
    expect(isSensitivePath("/tmp/foo.pem", HOME)).toBe(true);
  });
  it("flags macOS keychains", () => {
    expect(isSensitivePath("/home/alice/Library/Keychains/login.keychain-db", HOME)).toBe(true);
    expect(isSensitivePath("/home/alice/Library/Keychains/x.keychain", HOME)).toBe(true);
  });
  it("allows ordinary project files", () => {
    expect(isSensitivePath("/home/alice/project/notebook.md", HOME)).toBe(false);
    expect(isSensitivePath("/home/alice/project/data/reads.fastq", HOME)).toBe(false);
  });
});

describe("isProtectedWritePath", () => {
  it("flags writes under .git or .loom", () => {
    expect(isProtectedWritePath("/home/alice/project/.git/hooks/pre-commit")).toBe(true);
    expect(isProtectedWritePath("/home/alice/project/.git/config")).toBe(true);
    expect(isProtectedWritePath("/home/alice/project/.loom/config.json")).toBe(true);
  });
  it("allows ordinary project writes", () => {
    expect(isProtectedWritePath("/home/alice/project/notebook.md")).toBe(false);
    expect(isProtectedWritePath("/home/alice/project/src/main.py")).toBe(false);
    // not fooled by a substring -- only a real path segment counts
    expect(isProtectedWritePath("/home/alice/project/gitignore.md")).toBe(false);
  });
});
