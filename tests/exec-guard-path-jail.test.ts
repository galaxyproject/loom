import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createPathResolver } from "../extensions/loom/exec-guard/path-jail";

let root: string, outside: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loom-jail-root-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loom-jail-out-")));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("createPathResolver", () => {
  it("allows existing files inside a root", () => {
    const f = path.join(root, "a.txt");
    fs.writeFileSync(f, "x");
    expect(createPathResolver([root]).contains(f).inside).toBe(true);
  });
  it("allows not-yet-existing files inside a root (deepest-ancestor realpath)", () => {
    expect(createPathResolver([root]).contains(path.join(root, "sub/new.txt")).inside).toBe(true);
  });
  it("rejects paths outside all roots", () => {
    expect(createPathResolver([root]).contains(path.join(outside, "x.txt")).inside).toBe(false);
  });
  it("rejects .. escapes", () => {
    expect(createPathResolver([root]).contains(path.join(root, "../escape.txt")).inside).toBe(
      false,
    );
  });
  it("rejects symlink escapes", () => {
    const link = path.join(root, "link");
    fs.symlinkSync(outside, link);
    expect(createPathResolver([root]).contains(path.join(link, "x.txt")).inside).toBe(false);
  });
});
