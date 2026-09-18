/**
 * The layout file against a real filesystem.
 *
 * `dashboard-persistence.test.ts` drives the renderer against a fake shell, so
 * every guarantee the shells are supposed to provide could be deleted with a
 * green suite: a reviewer removed the symlink guard, the compare-and-swap and
 * the size cap from both handlers, separately, and all sixteen tests still
 * passed. These are the tests that fail when that happens -- real directories,
 * real symlinks, real concurrent writes, no mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  casWriteLayoutFile,
  readLayoutFile,
  withLayoutLock,
} from "../shared/dashboard-layout-store.js";
import { dashboardRevision, DASHBOARD_MAX_BYTES } from "../shared/dashboard-contract.js";

let dir: string;
let file: string;
let outside: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "layout-store-"));
  file = path.join(dir, ".loom-dashboard.json");
  outside = path.join(dir, "victim.txt");
  fs.writeFileSync(outside, "DO NOT TOUCH\n");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readLayoutFile", () => {
  it("reports no file rather than an error when there is none", async () => {
    expect(await readLayoutFile(file, DASHBOARD_MAX_BYTES)).toEqual({
      ok: true,
      raw: null,
      revision: null,
    });
  });

  it("reads a file and its revision", async () => {
    fs.writeFileSync(file, "{}\n");
    const res = await readLayoutFile(file, DASHBOARD_MAX_BYTES);
    expect(res).toEqual({ ok: true, raw: "{}\n", revision: dashboardRevision("{}\n") });
  });

  it("refuses a live symlink", async () => {
    fs.symlinkSync(outside, file);
    const res = await readLayoutFile(file, DASHBOARD_MAX_BYTES);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/symlink/);
  });

  it("refuses a DANGLING symlink, which the two shells used to disagree about", async () => {
    // `existsSync` follows the link, so the web shell called this "no file yet"
    // and replaced it, while the desktop lstat'd and refused. Same answer now.
    fs.symlinkSync(path.join(dir, "nothing-here"), file);
    const res = await readLayoutFile(file, DASHBOARD_MAX_BYTES);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/symlink/);
  });

  it("refuses a directory at the filename", async () => {
    fs.mkdirSync(file);
    const res = await readLayoutFile(file, DASHBOARD_MAX_BYTES);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not a regular file/);
  });

  it("refuses an oversized file without reading it into memory", async () => {
    const fd = fs.openSync(file, "w");
    try {
      fs.ftruncateSync(fd, DASHBOARD_MAX_BYTES + 1);
    } finally {
      fs.closeSync(fd);
    }
    const res = await readLayoutFile(file, DASHBOARD_MAX_BYTES);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/larger than/);
  });
});

describe("casWriteLayoutFile", () => {
  it("writes when there is no file and the caller expected none", async () => {
    const res = await casWriteLayoutFile(file, "A\n", null, DASHBOARD_MAX_BYTES);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("A\n");
  });

  it("refuses a stale revision and hands back what is actually there", async () => {
    fs.writeFileSync(file, "CURRENT\n");
    const res = await casWriteLayoutFile(file, "MINE\n", "not-the-revision", DASHBOARD_MAX_BYTES);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.conflict).toBe(true);
      expect(res.raw).toBe("CURRENT\n");
      expect(res.revision).toBe(dashboardRevision("CURRENT\n"));
    }
    expect(fs.readFileSync(file, "utf8")).toBe("CURRENT\n");
  });

  it("writes unconditionally when no base revision is given", async () => {
    fs.writeFileSync(file, "CURRENT\n");
    const res = await casWriteLayoutFile(file, "FORCED\n", undefined, DASHBOARD_MAX_BYTES);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("FORCED\n");
  });

  it("refuses to write through a symlink and leaves the target alone", async () => {
    fs.symlinkSync(outside, file);
    const res = await casWriteLayoutFile(file, "EVIL\n", undefined, DASHBOARD_MAX_BYTES);
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("DO NOT TOUCH\n");
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it("refuses a payload over the cap", async () => {
    const res = await casWriteLayoutFile(
      file,
      "x".repeat(DASHBOARD_MAX_BYTES + 1),
      null,
      DASHBOARD_MAX_BYTES,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/larger than/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("leaves no scratch file behind", async () => {
    await casWriteLayoutFile(file, "A\n", null, DASHBOARD_MAX_BYTES);
    expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  // The finding. Two writers read the same revision and both saved against it;
  // both passed the check, both reported success, and the second silently
  // replaced the first. Reproduced three times out of three before the fix.
  it("lets exactly one of two saves based on the same revision win", async () => {
    fs.writeFileSync(file, "R0\n");
    const base = dashboardRevision("R0\n");

    const [a, b] = await Promise.all([
      casWriteLayoutFile(file, "WRITER-A\n", base, DASHBOARD_MAX_BYTES),
      casWriteLayoutFile(file, "WRITER-B\n", base, DASHBOARD_MAX_BYTES),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as { conflict?: boolean }).conflict).toBe(true);

    // And the file holds the winner's bytes, whole.
    const onDisk = fs.readFileSync(file, "utf8");
    expect(["WRITER-A\n", "WRITER-B\n"]).toContain(onDisk);
    expect(onDisk).toBe(winners[0].ok ? "WRITER-A\n" : onDisk);
  });

  it("holds under many concurrent writers, losing none of the winners' bytes", async () => {
    fs.writeFileSync(file, "R0\n");
    const base = dashboardRevision("R0\n");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        casWriteLayoutFile(file, `W${i}\n`, base, DASHBOARD_MAX_BYTES),
      ),
    );
    // Exactly one can be based on R0.
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const winner = results.findIndex((r) => r.ok);
    expect(fs.readFileSync(file, "utf8")).toBe(`W${winner}\n`);
  });

  it("a chain of saves each based on the previous one all land, in order", async () => {
    let revision: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res = await casWriteLayoutFile(file, `S${i}\n`, revision, DASHBOARD_MAX_BYTES);
      expect(res.ok, `save ${i}`).toBe(true);
      if (res.ok) revision = res.revision;
    }
    expect(fs.readFileSync(file, "utf8")).toBe("S9\n");
  });
});

describe("withLayoutLock", () => {
  it("serializes work on one path", async () => {
    const order: string[] = [];
    const slow = async (tag: string, ms: number): Promise<void> => {
      order.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}:end`);
    };
    await Promise.all([
      withLayoutLock(file, () => slow("a", 20)),
      withLayoutLock(file, () => slow("b", 1)),
    ]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("does not wedge the queue when one caller throws", async () => {
    await expect(withLayoutLock(file, () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(withLayoutLock(file, () => Promise.resolve("fine"))).resolves.toBe("fine");
  });

  it("does not serialize unrelated paths against each other", async () => {
    const other = path.join(dir, "other.json");
    let released = (): void => {};
    const blocked = withLayoutLock(file, () => new Promise<void>((r) => (released = r)));
    // A different path must not be stuck behind the one that is still running.
    await expect(withLayoutLock(other, () => Promise.resolve("through"))).resolves.toBe("through");
    released();
    await blocked;
  });
});
