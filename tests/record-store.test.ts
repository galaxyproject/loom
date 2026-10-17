import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  installedRecordStore,
  NotebookChangedError,
  recordStore,
  setRecordStore,
  withRecordCas,
  withRecordLock,
  type RecordStore,
} from "../extensions/loom/record-store";
import { createFileRecordStore } from "../extensions/loom/record-store-file";
import { createPageRecordStore } from "../extensions/loom/record-store-page";
import { setGalaxyTransport } from "../extensions/loom/galaxy-api";

// The contract every backend of the record store keeps. The file harness is the
// desktop's notebook.md; the page harness is a Galaxy page behind a fake
// transport. `perturb` is an out-of-band writer (a bash append, a user edit on
// the Galaxy side) and `remove` deletes the record from under the store.
interface Harness {
  store: RecordStore;
  perturb(content: string): void;
  remove(): void;
  /** Network calls the page harness saw; the file harness has none. */
  calls: string[];
  /** The scratch dir, for the file-only "no stray files" assertion. */
  dir?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(25);
}

const dirs: string[] = [];

function fileHarness(initial?: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), "record-store-"));
  dirs.push(dir);
  const key = join(dir, "notebook.md");
  if (initial !== undefined) writeFileSync(key, initial, "utf-8");
  return {
    store: createFileRecordStore(key),
    perturb: (content) => writeFileSync(key, content, "utf-8"),
    remove: () => rmSync(key),
    calls: [],
    dir,
  };
}

interface PageHarness extends Harness {
  puts: unknown[];
  page: { present: boolean; content: string };
}

function pageHarness(initial?: string): PageHarness {
  const page = { present: initial !== undefined, content: initial ?? "" };
  const calls: string[] = [];
  const puts: unknown[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  setGalaxyTransport({
    credentials: () => ({ url: "https://galaxy.test", apiKey: "k" }),
    fetch: async (url, init) => {
      const method = init.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url !== "https://galaxy.test/api/pages/p1") return json({}, 404);
      if (method === "GET") {
        if (!page.present) return json({ err_msg: "no such page" }, 404);
        // Galaxy renders an empty source as an empty page; `body()` falls through
        // to the render when the editor source is empty, as galaxy-ops does.
        return json({
          id: "p1",
          content_editor: page.content,
          content: page.content ? `<rendered>${page.content}` : "",
        });
      }
      if (method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        page.present = true;
        page.content = body.content;
        return json({ id: "p1" });
      }
      return json({}, 405);
    },
  });
  return {
    store: createPageRecordStore({ key: "/virtual/notebook.md", pageId: "p1" }),
    perturb: (content) => {
      page.present = true;
      page.content = content;
    },
    remove: () => {
      page.present = false;
    },
    calls,
    puts,
    page,
  };
}

afterEach(() => {
  setGalaxyTransport(null);
  setRecordStore(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.each([
  { name: "file", make: fileHarness },
  { name: "page", make: pageHarness },
])("record store contract ($name)", ({ name, make }) => {
  it("reports an absent record as null and refuses to read it", async () => {
    const h = make();
    expect(await h.store.stat()).toBeNull();
    if (name === "file") {
      await expect(h.store.read()).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(h.store.read()).rejects.toMatchObject({ status: 404 });
    }
  });

  it("reads an empty record with a version that agrees with stat()", async () => {
    const h = make("");
    const snap = await h.store.read();
    expect(snap.content).toBe("");
    expect(typeof snap.version).toBe("string");
    expect(snap.version).not.toBe("");
    expect(await h.store.stat()).toBe(snap.version);
  });

  it("round-trips a write and moves the version", async () => {
    const h = make("");
    const before = await h.store.stat();
    await h.store.write("a\n");
    expect((await h.store.read()).content).toBe("a\n");
    expect(await h.store.stat()).not.toBe(before);
  });

  it("lands a guarded write when the version still matches", async () => {
    const h = make("a");
    await h.store.write("b", (await h.store.stat())!);
    expect((await h.store.read()).content).toBe("b");
  });

  it("refuses a guarded write after an out-of-band change and leaves the record alone", async () => {
    const h = make("a");
    const old = (await h.store.stat())!;
    // A different length than "a": the file version must move on size, not only
    // on the timestamps, so this holds on coarse-mtime filesystems too.
    h.perturb("xx");
    await expect(h.store.write("c", old)).rejects.toBeInstanceOf(NotebookChangedError);
    expect((await h.store.read()).content).toBe("xx");
    if (h.dir) expect(readdirSync(h.dir)).toEqual(["notebook.md"]);
  });

  it("refuses a guarded write once the record is gone", async () => {
    const h = make("a");
    const old = (await h.store.stat())!;
    h.remove();
    await expect(h.store.write("r", old)).rejects.toBeInstanceOf(NotebookChangedError);
  });

  describe("withRecordCas", () => {
    it("returns apply's result and writes its content", async () => {
      const h = make("one\n");
      const result = await withRecordCas(h.store, (content) => ({
        content: content + "two\n",
        result: 42,
      }));
      expect(result).toBe(42);
      expect((await h.store.read()).content).toBe("one\ntwo\n");
    });

    it("retries against fresh content when a writer lands mid-update", async () => {
      const h = make("one\n");
      let calls = 0;
      const seen: string[] = [];
      const result = await withRecordCas(h.store, (content) => {
        seen.push(content);
        if (calls++ === 0) h.perturb("one\nstranger\n");
        return { content: content + "mine\n", result: "ok" };
      });
      expect(result).toBe("ok");
      expect(seen).toEqual(["one\n", "one\nstranger\n"]);
      expect((await h.store.read()).content).toBe("one\nstranger\nmine\n");
    });

    it("gives up after three attempts on a record that never settles", async () => {
      const h = make("one\n");
      let n = 0;
      // Each perturbation is a different length from the last (and from the
      // original), for the same reason as the guarded-write case above.
      const moved = (i: number) => `moved ${"!".repeat(i + 1)}\n`;
      await expect(
        withRecordCas(h.store, (content) => {
          h.perturb(moved(n++));
          return { content: content + "mine\n", result: null };
        }),
      ).rejects.toBeInstanceOf(NotebookChangedError);
      expect(n).toBe(3);
      expect((await h.store.read()).content).toBe(moved(2));
    });

    it("lets apply throw to abandon the update, touching nothing", async () => {
      const h = make("one\n");
      await expect(
        withRecordCas(h.store, () => {
          throw new Error("nope");
        }),
      ).rejects.toThrow("nope");
      expect((await h.store.read()).content).toBe("one\n");
    });

    it("surfaces a missing record as the backend's own error, not a race", async () => {
      const h = make();
      const failure = await withRecordCas(h.store, (content) => ({ content, result: null })).catch(
        (e) => e,
      );
      expect(failure).not.toBeInstanceOf(NotebookChangedError);
      if (name === "file") expect(failure).toMatchObject({ code: "ENOENT" });
      else expect(failure).toMatchObject({ status: 404 });
    });
  });

  describe("withRecordLock", () => {
    it("serializes two overlapping read-modify-writes so both land", async () => {
      const h = make("");
      const rmw = (line: string) =>
        withRecordLock(h.store.key, async () => {
          const { content } = await h.store.read();
          await sleep(10);
          await h.store.write(content + line + "\n");
        });
      await Promise.all([rmw("a"), rmw("b")]);
      expect((await h.store.read()).content).toBe("a\nb\n");
    });

    it("releases the chain when work throws", async () => {
      const h = make("");
      await expect(
        withRecordLock(h.store.key, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      await withRecordLock(h.store.key, async () => h.store.write("after\n"));
      expect((await h.store.read()).content).toBe("after\n");
    });
  });

  describe("onChange", () => {
    it("reports the store's own write, then nothing after unsubscribe", async () => {
      const h = make("");
      const seen: string[] = [];
      const off = h.store.onChange((content) => seen.push(content));
      await h.store.write("w");
      await until(() => seen.length > 0, 2000);
      expect(seen).toEqual(["w"]);
      off();
      off();
      await h.store.write("after");
      await sleep(700);
      expect(seen).toEqual(["w"]);
    });
  });

  it("names itself", () => {
    const h = make("");
    expect(h.store.kind).toBe(name);
    expect(typeof h.store.key).toBe("string");
    if (name === "file") expect(h.store.label).toBe(h.store.key);
    else expect(h.store.label).toBe("Galaxy page p1");
  });
});

describe("file record store", () => {
  it("ensure() creates an empty record once", async () => {
    const h = fileHarness();
    expect(await h.store.ensure()).toBe(true);
    expect(await h.store.ensure()).toBe(false);
    expect((await h.store.read()).content).toBe("");
  });

  it("ensure() creates the target of a dangling notebook.md symlink and keeps the link", async () => {
    const h = fileHarness();
    const target = join(h.dir!, "real.md");
    symlinkSync(target, h.store.key);
    expect(await h.store.stat()).toBeNull();
    expect(await h.store.ensure()).toBe(true);
    expect(lstatSync(h.store.key).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("");
    expect(await h.store.ensure()).toBe(false);
    expect((await h.store.read()).content).toBe("");
  });
});

describe("page record store", () => {
  it("ensure() never creates a page and makes no network call", async () => {
    const h = pageHarness();
    expect(await h.store.ensure()).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("treats a transport failure as absent on stat() and surfaces it from read()", async () => {
    const h = pageHarness("src");
    const outage = new Error("galaxy unreachable");
    setGalaxyTransport({
      credentials: () => ({ url: "https://galaxy.test", apiKey: "k" }),
      fetch: async () => {
        throw outage;
      },
    });
    // A page that cannot be reached looks deleted to stat(); callers that act on
    // "absent" (init gate, drift revocation) do so on an outage as well.
    expect(await h.store.stat()).toBeNull();
    await expect(h.store.read()).rejects.toBe(outage);
    await expect(h.store.write("w", "deadbeef")).rejects.toBeInstanceOf(NotebookChangedError);
    const failure = await withRecordCas(h.store, (content) => ({ content, result: null })).catch(
      (e) => e,
    );
    expect(failure).toBe(outage);
  });

  it("writes markdown as the agent and reads the editor source over the render", async () => {
    const h = pageHarness("src");
    expect((await h.store.read()).content).toBe("src");
    await h.store.write("next");
    expect(h.puts).toEqual([{ content: "next", content_format: "markdown", edit_source: "agent" }]);
  });
});

describe("record store registry", () => {
  beforeEach(() => setRecordStore(null));

  it("resolves the installed store by key and a file store for any other key", () => {
    const page = createPageRecordStore({ key: "/virtual/notebook.md", pageId: "p1" });
    setRecordStore(page);
    expect(installedRecordStore()).toBe(page);
    expect(recordStore(page.key)).toBe(page);
    expect(recordStore("/elsewhere/notebook.md").kind).toBe("file");
    setRecordStore(null);
    expect(recordStore(page.key).kind).toBe("file");
  });
});
