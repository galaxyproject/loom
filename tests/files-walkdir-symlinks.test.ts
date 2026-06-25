import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

// files-handler.ts imports { ipcMain, BrowserWindow } from "electron" at module
// top-level; stub them since walkDir never calls into electron.
vi.mock("electron", () => ({ ipcMain: {}, BrowserWindow: {} }));

import { walkDir, type FileNode } from "../app/src/main/files-handler.js";

let root: string;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "loom-walkdir-"));

  // A real file and a real directory.
  await fsp.writeFile(path.join(root, "real.txt"), "hello");
  await fsp.mkdir(path.join(root, "realdir"));
  await fsp.writeFile(path.join(root, "realdir", "inner.txt"), "x");

  // A symlink to the file, a symlink to the directory, and a broken symlink.
  await fsp.symlink(path.join(root, "real.txt"), path.join(root, "link-to-file"));
  await fsp.symlink(path.join(root, "realdir"), path.join(root, "link-to-dir"));
  await fsp.symlink(path.join(root, "missing-target"), path.join(root, "broken-link"));
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

function byName(nodes: FileNode[]): Map<string, FileNode> {
  return new Map(nodes.map((n) => [n.name, n]));
}

describe("walkDir symlink handling", () => {
  it("shows a symlink to a file as a file", async () => {
    const nodes = byName(await walkDir(root, "", false, 0));
    const link = nodes.get("link-to-file");
    expect(link).toBeDefined();
    expect(link?.type).toBe("file");
  });

  it("shows a symlink to a directory as a walkable directory", async () => {
    const nodes = byName(await walkDir(root, "", false, 0));
    const link = nodes.get("link-to-dir");
    expect(link).toBeDefined();
    expect(link?.type).toBe("directory");
    expect(link?.children?.some((c) => c.name === "inner.txt")).toBe(true);
  });

  it("still surfaces a broken symlink as a file", async () => {
    const nodes = byName(await walkDir(root, "", false, 0));
    const link = nodes.get("broken-link");
    expect(link).toBeDefined();
    expect(link?.type).toBe("file");
  });
});
