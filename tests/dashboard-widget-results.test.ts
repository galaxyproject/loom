// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  artifactUrl,
  classifyResult,
  collectResultFiles,
  delimiterFor,
  formatSize,
  matchesGlob,
  parseDelimitedPreview,
  readHead,
  readResultsConfig,
  resultsWidget,
  selectResults,
} from "../app/src/renderer/dashboard/widgets/results.js";
import { DashboardSources } from "../app/src/renderer/dashboard/data-sources.js";
import type { FileNode } from "../app/src/preload/preload.js";
import type { DataSource, WidgetContext } from "../app/src/renderer/dashboard/widget-api.js";

function file(relPath: string, size = 100): FileNode {
  return { name: relPath.split("/").pop() ?? relPath, relPath, type: "file", size };
}

function dir(relPath: string, children: FileNode[]): FileNode {
  return { name: relPath.split("/").pop() ?? relPath, relPath, type: "directory", children };
}

function tree(children: FileNode[]): FileNode {
  return { name: "", relPath: "", type: "directory", children };
}

interface Harness {
  el: HTMLElement;
  header: HTMLElement;
  ctx: WidgetContext;
  sources: DashboardSources;
  setConfig: ReturnType<typeof vi.fn>;
  openFile: ReturnType<typeof vi.fn>;
  cleanups: Array<() => void>;
  /** Push a file listing through the real `files` source. */
  setFiles(root: FileNode | null): Promise<void>;
}

function harness(
  config: Record<string, unknown> = {},
  opts: { available?: boolean; canOpenFiles?: boolean } = {},
): Harness {
  const el = document.createElement("div");
  const header = document.createElement("div");
  document.body.append(el, header);
  let root: FileNode | null = null;
  const sources = new DashboardSources(
    opts.available === false
      ? {}
      : { listFiles: async () => (root ? { ok: true as const, root } : { ok: false as const }) },
  );
  const cleanups: Array<() => void> = [];
  const setConfig = vi.fn();
  const openFile = vi.fn();
  const ctx = {
    panelId: "p",
    config: { ...resultsWidget.defaultConfig, ...config },
    sources: sources.sources,
    header,
    setConfig,
    // Optional on the real context, so the default harness has it and one test
    // takes it away to cover the shell that cannot open anything.
    openFile: opts.canOpenFiles === false ? undefined : openFile,
    fail: vi.fn(),
    onDispose(fn: () => void) {
      cleanups.push(fn);
    },
    subscribe<T>(source: DataSource<T>, listener: (value: T) => void) {
      const off = source.subscribe(listener);
      listener(source.get());
      return off;
    },
  } as unknown as WidgetContext;
  return {
    el,
    header,
    ctx,
    sources,
    setConfig,
    openFile,
    cleanups,
    async setFiles(next) {
      root = next;
      await sources.refreshFiles();
    },
  };
}

/**
 * A fetch that answers with a real byte stream, because that is what Electron's
 * `net.fetch` gives back and therefore the branch of `readHead` that ships. The
 * no-body fallback is covered separately.
 */
function stubFetch(body: string): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        // Two chunks, so the streaming decode is exercised rather than a single
        // read that happens to contain everything.
        const bytes = new TextEncoder().encode(body);
        const half = Math.ceil(bytes.byteLength / 2);
        controller.enqueue(bytes.subarray(0, half));
        controller.enqueue(bytes.subarray(half));
        controller.close();
      },
    }),
  }));
  (globalThis as unknown as { fetch: unknown }).fetch = fn;
  return fn;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
});

describe("classifyResult", () => {
  it("reads the last extension of a multi-dot name", () => {
    expect(classifyResult("results.deseq2.shrunk.tsv")).toBe("table");
    expect(classifyResult("figures/volcano.v2.final.png")).toBe("image");
    expect(classifyResult("run.2026-09-18.log")).toBe("document");
  });

  it("treats .tabular as a table, not a binary blob", () => {
    // loom#269: a last-extension allowlist is the only thing keeping Galaxy's
    // own tabular datatype out of the "cannot preview" bucket.
    expect(classifyResult("counts.tabular")).toBe("table");
    expect(classifyResult("counts.tab")).toBe("table");
  });

  it("does not claim to read a compressed table", () => {
    expect(classifyResult("counts.tsv.gz")).toBe("other");
    expect(classifyResult("reads.fastq.bz2")).toBe("other");
  });

  it("classifies svg as an image and pdf as a document", () => {
    expect(classifyResult("plot.svg")).toBe("image");
    expect(classifyResult("report.pdf")).toBe("document");
  });

  it("is case-insensitive and safe on a name with no extension", () => {
    expect(classifyResult("PLOT.PNG")).toBe("image");
    expect(classifyResult("Snakefile")).toBe("other");
    expect(classifyResult(".hidden")).toBe("other");
  });
});

describe("matchesGlob", () => {
  it("matches the file name when the pattern has no slash", () => {
    expect(matchesGlob("*.png", "figures/volcano.png")).toBe(true);
    expect(matchesGlob("*.png", "figures/volcano.svg")).toBe(false);
  });

  it("matches the whole path when the pattern has a slash", () => {
    expect(matchesGlob("figures/*.png", "figures/volcano.png")).toBe(true);
    expect(matchesGlob("figures/*.png", "figures/sub/volcano.png")).toBe(false);
    expect(matchesGlob("figures/**/*.png", "figures/sub/deep/volcano.png")).toBe(true);
  });

  it("lets ** stand in for no directory at all", () => {
    expect(matchesGlob("**/*.png", "volcano.png")).toBe(true);
  });

  it("expands braces and honours ?", () => {
    expect(matchesGlob("*.{png,svg}", "plot.svg")).toBe(true);
    expect(matchesGlob("*.{png,svg}", "plot.pdf")).toBe(false);
    expect(matchesGlob("plot?.png", "plot1.png")).toBe(true);
    expect(matchesGlob("plot?.png", "plot12.png")).toBe(false);
  });

  it("treats a dot as a literal", () => {
    expect(matchesGlob("a.png", "axpng")).toBe(false);
  });

  it("matches everything for an empty pattern", () => {
    expect(matchesGlob("", "anything.bam")).toBe(true);
    expect(matchesGlob("   ", "anything.bam")).toBe(true);
  });

  it("does not hide every result behind an unterminated brace", () => {
    expect(matchesGlob("{png", "{png")).toBe(true);
    expect(matchesGlob("{png", "plot.png")).toBe(false);
  });

  it("answers a pathological pattern instantly instead of freezing the renderer", () => {
    // These shapes took four to five seconds each against a regex built from
    // the same dialect, on the renderer's own thread, once per file.
    const name = "GSM123456_sample_control_rep1_counts_matrix_aaaaaaaaaaaaaaa.tsv";
    const started = Date.now();
    expect(matchesGlob(`${"**".repeat(12)}x`, name)).toBe(false);
    expect(matchesGlob(`${"*a".repeat(12)}*b`, "a".repeat(60))).toBe(false);
    expect(matchesGlob(`${"**/".repeat(12)}x`, name)).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("stops expanding braces long before they become a payload", () => {
    const started = Date.now();
    // Six groups of four is 4096 patterns if nothing stops it.
    expect(matchesGlob(`${"{a,b,c,d}".repeat(6)}.png`, "plot.png")).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
  });
});

describe("collectResultFiles", () => {
  it("flattens the tree and skips directories", () => {
    const files = collectResultFiles(
      tree([file("plot.png"), dir("figures", [file("figures/volcano.svg")])]),
    );
    expect(files.map((f) => f.relPath)).toEqual(["plot.png", "figures/volcano.svg"]);
  });

  it("skips the workspace's own bookkeeping at the root only", () => {
    const files = collectResultFiles(
      tree([
        file("notebook.md"),
        file("activity.jsonl"),
        dir("reports", [file("reports/notebook.md")]),
      ]),
    );
    expect(files.map((f) => f.relPath)).toEqual(["reports/notebook.md"]);
  });

  it("survives a null root and a file with no size", () => {
    expect(collectResultFiles(null)).toEqual([]);
    const [only] = collectResultFiles(
      tree([{ name: "x.png", relPath: "x.png", type: "file" } as FileNode]),
    );
    expect(only.size).toBeNull();
  });
});

describe("selectResults", () => {
  const files = collectResultFiles(
    tree([
      file("notes.txt"),
      file("run.bam"),
      file("counts.tsv"),
      dir("figures", [file("figures/volcano.png")]),
      file("heatmap.svg"),
    ]),
  );

  it("puts plots first, then tables, then documents", () => {
    const { shown } = selectResults(files, { limit: 10 });
    expect(shown.map((f) => f.relPath)).toEqual([
      "heatmap.svg",
      "figures/volcano.png",
      "counts.tsv",
      "notes.txt",
      "run.bam",
    ]);
  });

  it("reports the total behind the cut", () => {
    const { shown, total } = selectResults(files, { limit: 2 });
    expect(shown).toHaveLength(2);
    expect(total).toBe(5);
  });

  it("narrows by glob and counts only what matched", () => {
    const { shown, total } = selectResults(files, { glob: "*.{png,svg}", limit: 10 });
    expect(shown.map((f) => f.name)).toEqual(["heatmap.svg", "volcano.png"]);
    expect(total).toBe(2);
  });

  it("clamps a hostile limit", () => {
    // More files than either bound, so the assertions are about the clamp and
    // not about the fixture running out.
    const many = collectResultFiles(
      tree(Array.from({ length: 200 }, (_, i) => file(`plot-${String(i).padStart(3, "0")}.png`))),
    );
    expect(selectResults(many, { limit: 0 }).shown).toHaveLength(8);
    expect(selectResults(many, { limit: -3 }).shown).toHaveLength(8);
    expect(selectResults(many, { limit: Number.NaN }).shown).toHaveLength(8);
    expect(selectResults(many, { limit: 1e9 }).shown).toHaveLength(60);
    expect(selectResults(many, { limit: 3 }).total).toBe(200);
  });
});

describe("parseDelimitedPreview", () => {
  const opts = { delimiter: "\t", maxRows: 2, maxCols: 3 };

  it("takes the first row as headers and caps the rest", () => {
    const preview = parseDelimitedPreview("a\tb\n1\t2\n3\t4\n5\t6\n", opts);
    expect(preview?.headers).toEqual(["a", "b"]);
    expect(preview?.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(preview?.moreRows).toBe(true);
  });

  it("caps columns and says how many it dropped", () => {
    const preview = parseDelimitedPreview("a\tb\tc\td\te\n1\t2\t3\t4\t5\n", opts);
    expect(preview?.headers).toEqual(["a", "b", "c"]);
    expect(preview?.rows).toEqual([["1", "2", "3"]]);
    expect(preview?.extraColumns).toBe(2);
  });

  it("drops the final line when the text was cut at a byte budget", () => {
    // `3\t` is half a row of numbers and reads exactly like a whole one.
    const preview = parseDelimitedPreview("a\tb\n1\t2\n3\t", { ...opts, partial: true });
    expect(preview?.rows).toEqual([["1", "2"]]);
    expect(preview?.moreRows).toBe(true);
  });

  it("honours quoted csv fields", () => {
    const preview = parseDelimitedPreview('gene,note\nTP53,"tumour, suppressor"\n', {
      delimiter: ",",
      maxRows: 2,
      maxCols: 3,
    });
    expect(preview?.rows).toEqual([["TP53", "tumour, suppressor"]]);
  });

  it("unescapes a doubled quote inside a quoted field", () => {
    const preview = parseDelimitedPreview('a\n"say ""hi"""\n', {
      delimiter: ",",
      maxRows: 2,
      maxCols: 3,
    });
    expect(preview?.rows).toEqual([['say "hi"']]);
  });

  it("truncates a cell that is a wall of text", () => {
    const preview = parseDelimitedPreview(`h\n${"x".repeat(500)}\n`, opts);
    expect(preview?.rows[0][0].length).toBeLessThan(80);
    expect(preview?.rows[0][0].endsWith("...")).toBe(true);
  });

  it("does not turn the first row of a headerless table into column names", () => {
    // BED, GTF and most Galaxy .tabular output have no header row.
    const preview = parseDelimitedPreview("chrM\t101\t340\nchrM\t902\t1104\n", opts);
    expect(preview?.headers).toBeNull();
    expect(preview?.rows).toEqual([
      ["chrM", "101", "340"],
      ["chrM", "902", "1104"],
    ]);
  });

  it("still finds a header when the file has one", () => {
    const preview = parseDelimitedPreview("chrom\tstart\tend\nchrM\t101\t340\n", opts);
    expect(preview?.headers).toEqual(["chrom", "start", "end"]);
    expect(preview?.rows).toEqual([["chrM", "101", "340"]]);
  });

  it("counts a headerless table's rows against the cap correctly", () => {
    const preview = parseDelimitedPreview("1\t1\n2\t2\n3\t3\n4\t4\n", opts);
    expect(preview?.headers).toBeNull();
    // maxRows is 2, and the row that would have been the header is data here.
    expect(preview?.rows).toHaveLength(2);
    expect(preview?.moreRows).toBe(true);
  });

  it("skips blank lines and returns null for nothing usable", () => {
    expect(parseDelimitedPreview("\n\n  \n", opts)).toBeNull();
    expect(parseDelimitedPreview("", opts)).toBeNull();
    expect(parseDelimitedPreview("a\tb\n", opts)?.rows).toEqual([]);
  });
});

describe("small helpers", () => {
  it("formats a size the way the file pane does", () => {
    expect(formatSize(12)).toBe("12 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSize(-1)).toBe("");
  });

  it("picks the delimiter from the extension", () => {
    expect(delimiterFor("x.csv")).toBe(",");
    expect(delimiterFor("x.tsv")).toBe("\t");
    expect(delimiterFor("x.tabular")).toBe("\t");
  });

  it("jails and encodes an artifact url", () => {
    expect(artifactUrl("figures/volcano plot.png")).toBe(
      "orbit-artifact://cwd/figures/volcano%20plot.png",
    );
    expect(artifactUrl("../../etc/passwd")).toBe("");
    // A colon is legal in a POSIX file name and must not read as a scheme.
    expect(artifactUrl("run:1.png")).toBe("orbit-artifact://cwd/run%3A1.png");
    expect(artifactUrl("plot.png", 42)).toBe("orbit-artifact://cwd/plot.png?v=42");
  });

  it("coerces a config written by hand or by a model", () => {
    expect(readResultsConfig({} as never)).toEqual({
      mode: "gallery",
      path: "",
      glob: "",
      limit: 8,
    });
    expect(
      readResultsConfig({ mode: "banana", path: 7, glob: null, limit: "12" } as never),
    ).toEqual({ mode: "gallery", path: "", glob: "", limit: 8 });
    expect(readResultsConfig({ mode: "pinned", limit: 1e9 } as never).limit).toBe(60);
  });
});

describe("readHead", () => {
  it("stops pulling once it has the bytes it will show", async () => {
    const chunk = new TextEncoder().encode("x".repeat(1024));
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    (globalThis as unknown as { fetch: unknown }).fetch = async () => ({ ok: true, body: stream });

    const head = await readHead("orbit-artifact://cwd/big.tsv", 4096, new AbortController().signal);
    expect(head?.truncated).toBe(true);
    expect(head?.text.length).toBe(4096);
    // The stream would happily produce forever; we took five chunks and stopped.
    expect(pulled).toBeLessThan(8);
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  it("returns null rather than throwing when the shell cannot serve the scheme", async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(
      await readHead("orbit-artifact://cwd/x.tsv", 16, new AbortController().signal),
    ).toBeNull();
  });

  it("falls back to text() for a small response with no body", async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
      ok: true,
      body: null,
      headers: { get: () => "8" },
      text: async () => "a\tb\n1\t2\n",
    });
    const head = await readHead("orbit-artifact://cwd/x.tsv", 4096, new AbortController().signal);
    expect(head).toEqual({ text: "a\tb\n1\t2\n", truncated: false });
  });

  it("will not materialise a huge body to slice a head out of it", async () => {
    // The whole promise of this function is that it does not read more than it
    // shows. The fallback cannot stream, so against a 200 MB table the only
    // options are the whole file or nothing -- and the caller draws a plain row
    // on nothing, which costs a preview rather than the main thread.
    const text = vi.fn(async () => "x".repeat(200_000_000));
    (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
      ok: true,
      body: null,
      headers: { get: () => String(200_000_000) },
      text,
    });
    expect(
      await readHead("orbit-artifact://cwd/big.tsv", 4096, new AbortController().signal),
    ).toBeNull();
    expect(text).not.toHaveBeenCalled();
  });

  it("will not read a body-less response that declares no length at all", async () => {
    const text = vi.fn(async () => "a\tb\n");
    (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
      ok: true,
      body: null,
      headers: { get: () => null },
      text,
    });
    expect(
      await readHead("orbit-artifact://cwd/x.tsv", 4096, new AbortController().signal),
    ).toBeNull();
    expect(text).not.toHaveBeenCalled();
  });

  it("does not call a whole body truncated because it exactly fills the budget", async () => {
    const body = new TextEncoder().encode("abcd");
    (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
    });
    // Exactly the budget. Calling this truncated costs the caller its last row.
    const head = await readHead("orbit-artifact://cwd/x.tsv", 4, new AbortController().signal);
    expect(head).toEqual({ text: "abcd", truncated: false });
  });

  it("returns null on a non-ok response", async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = async () => ({ ok: false, body: null });
    expect(
      await readHead("orbit-artifact://cwd/x.tsv", 16, new AbortController().signal),
    ).toBeNull();
  });
});

describe("results widget", () => {
  it("keeps the type, label and config shape the registry and presets expect", () => {
    expect(resultsWidget.type).toBe("results");
    expect(resultsWidget.label).toBe("Results");
    expect(resultsWidget.defaultConfig).toEqual({ mode: "gallery", path: "", glob: "", limit: 8 });
  });

  it("says it is still looking before the shell has answered", async () => {
    const h = harness({}, { available: false });
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("plot.png")]));
    // A desktop workspace can take a moment to walk, and "this shell cannot
    // list the analysis folder" is the wrong thing to say while it does.
    expect(h.el.querySelector(".dash-results-empty")?.textContent).toContain("Looking for");
    expect(h.el.querySelector("img")).toBeNull();
  });

  it("says what it actually knows once waiting has not helped", () => {
    vi.useFakeTimers();
    try {
      const h = harness({}, { available: false });
      resultsWidget.mount(h.el, h.ctx);
      vi.advanceTimersByTime(2000);
      const text = h.el.querySelector(".dash-results-empty")?.textContent ?? "";
      expect(text).toContain("Nothing has been listed for this analysis");
      // Not "this shell cannot list the analysis folder": the same window's
      // File pane lists it, and a directory with nothing in it yet looks
      // exactly like a shell with no listing from in here.
      expect(text).not.toContain("cannot list the analysis folder");
      expect(h.el.querySelector("img")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes back to looking when the listing is reset for a new analysis", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      resultsWidget.mount(h.el, h.ctx);
      // Spend the first grace period, so the latch is the thing under test
      // rather than a timer that has not fired yet.
      vi.advanceTimersByTime(2000);
      await h.setFiles(tree([file("plot.png")]));
      expect(h.el.querySelector("img")).not.toBeNull();

      // What /new and every cwd switch do. The grace used to be a one-way
      // latch, so the reset went straight to a claim about the shell on a
      // window that had just finished listing a folder.
      h.sources.reset();
      expect(h.el.querySelector(".dash-results-empty")?.textContent).toContain("Looking for");

      vi.advanceTimersByTime(2000);
      expect(h.el.querySelector(".dash-results-empty")?.textContent).toContain(
        "Nothing has been listed",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains an empty workspace", async () => {
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([]));
    expect(h.el.querySelector(".dash-results-empty")?.textContent).toContain("Nothing to show yet");
  });

  it("names the glob when nothing matches it", async () => {
    const h = harness({ glob: "*.png" });
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("counts.tsv")]));
    expect(h.el.querySelector(".dash-results-empty")?.textContent).toContain("*.png");
  });

  it("renders an svg through <img> and never inline", async () => {
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("heatmap.svg", 2048)]));
    const img = h.el.querySelector("img");
    expect(img?.getAttribute("src")).toBe("orbit-artifact://cwd/heatmap.svg?v=2048.0");
    // An svg is a script carrier; nothing here may become markup.
    expect(h.el.querySelector("svg")).toBeNull();
    expect(h.el.querySelector(".dash-results-name")?.textContent).toBe("heatmap.svg");
  });

  it("falls back to a named row when the image will not load", async () => {
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("plot.png", 10)]));
    const img = h.el.querySelector("img");
    img?.dispatchEvent(new Event("error"));
    expect(h.el.querySelector("img")).toBeNull();
    expect(h.el.querySelector(".dash-results-name")?.textContent).toBe("plot.png");
  });

  it("does not try to thumbnail an image bigger than it will show", async () => {
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("huge.png", 40 * 1024 * 1024)]));
    expect(h.el.querySelector("img")).toBeNull();
    expect(h.el.querySelector(".dash-results-meta")?.textContent).toBe("40 MB");
  });

  it("draws the head of a table and puts cell text through textContent", async () => {
    stubFetch("gene\tpadj\nTP53\t0.001\n<script>x</script>\t0.02\n");
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("counts.tsv", 64)]));
    await new Promise((r) => setTimeout(r, 0));
    const headers = [...h.el.querySelectorAll("th")].map((c) => c.textContent);
    expect(headers).toEqual(["gene", "padj"]);
    const firstCells = [...h.el.querySelectorAll("tbody tr")[0].querySelectorAll("td")];
    expect(firstCells.map((c) => c.textContent)).toEqual(["TP53", "0.001"]);
    expect(h.el.querySelector("script")).toBeNull();
    expect(h.el.textContent).toContain("<script>x</script>");
  });

  it("still names a table whose contents cannot be read", async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("counts.tsv", 64)]));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.el.querySelector("table")).toBeNull();
    expect(h.el.querySelector(".dash-results-name")?.textContent).toBe("counts.tsv");
  });

  it("shows any other file as a named row with its size", async () => {
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("aligned.bam", 3 * 1024 * 1024)]));
    expect(h.el.querySelector("img")).toBeNull();
    expect(h.el.querySelector("table")).toBeNull();
    expect(h.el.querySelector(".dash-results-name")?.textContent).toBe("aligned.bam");
    expect(h.el.querySelector(".dash-results-caption")?.textContent).toContain("3.0 MB");
  });

  it("counts what it had to leave out", async () => {
    const h = harness({ limit: 1 });
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("a.png"), file("b.png"), file("c.png")]));
    expect(h.header.textContent).toContain("1 of 3");
  });

  it("updates the count when the files behind the cut change", async () => {
    const h = harness({ limit: 1 });
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("a.png"), file("b.png"), file("c.png")]));
    expect(h.header.textContent).toContain("1 of 3");
    await h.setFiles(tree([file("a.png"), file("b.png"), file("c.png"), file("d.png")]));
    // The one panel it shows is unchanged; the sentence about the rest is not.
    expect(h.header.textContent).toContain("1 of 4");
  });

  it("does not offer a row count when the budget left it no whole row", async () => {
    // Header, then one row so wide the read stops inside it. Dropping that
    // half-row leaves nothing to count, and "first 0 rows" is not a sentence.
    stubFetch(`gene\tpadj\n${"x".repeat(40000)}`);
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("counts.tsv", 40012)]));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.el.querySelector("th")?.textContent).toBe("gene");
    expect(h.el.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(h.el.querySelector(".dash-results-note")).toBeNull();
  });

  it("pins the panel to one file when its pin button is pressed", async () => {
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([dir("figures", [file("figures/volcano.png")])]));
    const pin = h.el.querySelector<HTMLButtonElement>(".dash-results-pin");
    pin?.click();
    expect(h.setConfig).toHaveBeenCalledWith({ mode: "pinned", path: "figures/volcano.png" });
  });

  it("waits for a pinned file that has not been written yet", async () => {
    const h = harness({ mode: "pinned", path: "figures/volcano.png" });
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("counts.tsv")]));
    expect(h.el.querySelector(".dash-results-empty")?.textContent).toContain("figures/volcano.png");
    expect(h.el.querySelector("table")).toBeNull();
  });

  it("shows only the pinned file, with a way back", async () => {
    const h = harness({ mode: "pinned", path: "figures/volcano.png" });
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(
      tree([file("counts.tsv"), dir("figures", [file("figures/volcano.png", 512)])]),
    );
    expect(h.el.querySelectorAll(".dash-results-entry")).toHaveLength(1);
    expect(h.el.querySelector("img")?.getAttribute("src")).toContain("figures/volcano.png");
    expect(h.el.querySelector(".dash-results-pin")).toBeNull();
    const back = [...h.header.querySelectorAll("button")].find((b) => b.textContent === "show all");
    expect(back?.hidden).toBe(false);
    back?.click();
    expect(h.setConfig).toHaveBeenCalledWith({ mode: "gallery", path: "" });
  });

  it("gives a pinned table more of itself than a gallery entry gets", async () => {
    const body = ["a\tb\tc"];
    for (let i = 0; i < 12; i++) body.push(`${i}\t${i}\t${i}`);
    stubFetch(`${body.join("\n")}\n`);

    const gallery = harness();
    resultsWidget.mount(gallery.el, gallery.ctx);
    await gallery.setFiles(tree([file("counts.tsv", 64)]));
    await new Promise((r) => setTimeout(r, 0));
    expect(gallery.el.querySelectorAll("tbody tr")).toHaveLength(4);

    const pinned = harness({ mode: "pinned", path: "counts.tsv" });
    resultsWidget.mount(pinned.el, pinned.ctx);
    await pinned.setFiles(tree([file("counts.tsv", 64)]));
    await new Promise((r) => setTimeout(r, 0));
    expect(pinned.el.querySelectorAll("tbody tr")).toHaveLength(10);
  });

  it("leaves the gallery alone when a files refresh changes nothing", async () => {
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("plot.png", 10)]));
    const first = h.el.querySelector("img");
    await h.setFiles(tree([file("plot.png", 10)]));
    // Same element, not a replacement: a rebuild would flicker the thumbnail
    // and re-fetch every table on each files:changed burst.
    expect(h.el.querySelector("img")).toBe(first);
  });

  it("redraws when a plot is overwritten in place", async () => {
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("plot.png", 10)]));
    await h.setFiles(tree([file("plot.png", 99)]));
    expect(h.el.querySelector("img")?.getAttribute("src")).toBe(
      "orbit-artifact://cwd/plot.png?v=99.0",
    );
  });

  it("offers a plot back to the disk when the workspace has moved under it", async () => {
    // A file listing carries no mtime, so a plot regenerated at the same
    // dimensions from new data is byte-for-byte the same size and both the
    // redraw signature and the cache-buster stay put. Nothing in the widget can
    // see the rewrite, so the image is re-fetched on a slow tick instead.
    vi.useFakeTimers();
    try {
      const h = harness();
      resultsWidget.mount(h.el, h.ctx);
      await h.setFiles(tree([file("plot.png", 4096)]));
      const img = h.el.querySelector("img");
      const before = img?.getAttribute("src");
      expect(before).toBe("orbit-artifact://cwd/plot.png?v=4096.0");

      // The same listing again: nothing has moved, so nothing is re-fetched.
      vi.advanceTimersByTime(60_000);
      expect(h.el.querySelector("img")?.getAttribute("src")).toBe(before);

      // Now a listing arrives that says exactly the same thing -- same name,
      // same byte count, which is the whole point -- so the panel does not
      // redraw, and the tick offers the file back to the disk instead.
      await h.setFiles(tree([file("plot.png", 4096)]));
      vi.advanceTimersByTime(60_000);
      const after = h.el.querySelector("img")?.getAttribute("src");
      expect(after).not.toBe(before);
      expect(after).toContain("orbit-artifact://cwd/plot.png?v=");
      // In place, so the thumbnail is not torn down and rebuilt under a reader.
      expect(h.el.querySelector("img")).toBe(img);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops re-checking images once the panel is gone", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const dispose = resultsWidget.mount(h.el, h.ctx);
      await h.setFiles(tree([file("plot.png", 4096)]));
      const img = h.el.querySelector("img") as HTMLImageElement;
      h.cleanups.forEach((fn) => fn());
      dispose?.();
      vi.advanceTimersByTime(1000);
      await h.setFiles(tree([file("plot.png", 4096)]));
      const src = img.getAttribute("src");
      vi.advanceTimersByTime(120_000);
      expect(img.getAttribute("src")).toBe(src);
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws a file it could not measure as a row rather than an uncapped image", async () => {
    // files-handler leaves the size undefined whenever stat throws -- a broken
    // symlink, or a file racing the write creating it. That is the one kind of
    // file we know least about, so it must not be the one that skips the cap.
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([{ name: "plot.png", relPath: "plot.png", type: "file" }]));
    expect(h.el.querySelector("img")).toBeNull();
    expect(h.el.querySelector(".dash-results-name")?.textContent).toBe("plot.png");
  });

  it("does not render a filename in an order nobody wrote it in", async () => {
    // The log panel strips these and the gallery did not, which is one surface
    // with two answers. A right-to-left override in a filename makes
    // `a<RLO>gnp.exe` read as `a...exe.png` in every browser, and textContent
    // does not help: the override applies to text, not to markup.
    const hostile = `a\u202egnp.exe`;
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([{ name: hostile, relPath: hostile, type: "file", size: 12 }]));
    const shown = h.el.querySelector(".dash-results-name");
    expect(shown?.textContent).not.toContain("\u202e");
    expect(shown?.getAttribute("title") ?? "").not.toContain("\u202e");
    // The name is still recognisable, minus the character that lied about it.
    expect(shown?.textContent).toContain("gnp.exe");
  });

  it("does not hand back the raw name when nothing readable survives the strip", async () => {
    // `safeName(x) || x` reads like a safe fallback and is the opposite: a name
    // made entirely of overrides strips to blank and the `||` reaches for the
    // one string the fence exists for.
    const hostile = "\u202e\u202d\u2066";
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([{ name: hostile, relPath: hostile, type: "file", size: 12 }]));
    const shown = h.el.querySelector(".dash-results-name");
    expect(shown?.textContent).toBe("(unnamed file)");
    expect(shown?.getAttribute("title")).not.toContain("\u202e");
  });

  it("leaves the spaces in a filename alone, including the ones at the ends", async () => {
    // The title is the path a reader hovers to copy, so it has to be the path
    // that is on disk. Tidying whitespace is the log panel's concern, not a
    // safety property, and a doubled space in a filename is part of the name.
    const odd = " plot  v2 .png ";
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([{ name: odd, relPath: odd, type: "file", size: 12 }]));
    expect(h.el.querySelector(".dash-results-name")?.getAttribute("title")).toBe(`Open ${odd}`);
  });

  it("opens the file when its name is clicked", async () => {
    const h = harness();
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([dir("figures", [file("figures/volcano.png")])]));
    const open = h.el.querySelector<HTMLButtonElement>(".dash-results-open");
    expect(open?.textContent).toBe("volcano.png");
    open?.click();
    expect(h.openFile).toHaveBeenCalledWith("figures/volcano.png");
  });

  it("draws a plain caption, not a dead button, where the shell cannot open files", async () => {
    const h = harness({}, { canOpenFiles: false });
    resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("plot.png")]));
    expect(h.el.querySelector(".dash-results-open")).toBeNull();
    const name = h.el.querySelector(".dash-results-name");
    expect(name?.tagName).toBe("SPAN");
    expect(name?.textContent).toBe("plot.png");
  });

  it("clears itself and drops its cleanup on dispose", async () => {
    const h = harness();
    const dispose = resultsWidget.mount(h.el, h.ctx);
    await h.setFiles(tree([file("plot.png")]));
    expect(h.cleanups.length).toBeGreaterThan(0);
    for (const fn of h.cleanups) fn();
    dispose?.();
    expect(h.el.textContent).toBe("");
    expect(h.el.classList.contains("dash-results")).toBe(false);
  });
});
