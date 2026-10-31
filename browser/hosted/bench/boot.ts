/**
 * Boot timing and memory of the Orbit brain under Node, to its first model request, in
 * worker_threads. Builds the bundle, then runs each (build, N) configuration in a fresh process
 * several times, builds interleaved within each repetition, and prints medians and maxima.
 * See RESULTS-boot.md.
 *
 *   cd browser/hosted && node --import tsx bench/boot.ts [--builds bundle,tsx] [--n 1,4,16] [--runs 5]
 *
 * --gc 1 is the live-heap mode: workers collect garbage before each memory sample, which stalls
 * the sampled request, so read only its memory rows.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

import type { RunConfig, RunReport, WorkerReport } from "./boot-run";
import { inlineGlobs, RAW, rawModule } from "./vite-shims";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOSTED = resolve(HERE, "..");
const REPO = resolve(HOSTED, "..", "..");
const OUT = join(HOSTED, ".scratch", "boot");

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const ALL = [
  "bundle",
  "bundle-min",
  "bundle-ascii",
  "bundle-cache",
  "bundle-min-cache",
  "bundle-ascii-cache",
  "tsx",
] as const;
type Build = (typeof ALL)[number];
const BUILDS = (args.get("builds")?.split(",") ?? ALL) as Build[];
const SIZES = (args.get("n") ?? "1,4,16").split(",").map(Number);
const RUNS = Number(args.get("runs") ?? 5);
const GC = args.get("gc") === "1";

// The galaxy-ops copy extensions/orbit resolves to is the root one; its Node entry gets the
// browser entry in its place, as the test's vi.mock does and the worker bundler's "browser"
// condition would.
const GALAXY_OPS = join(REPO, "node_modules", "@galaxyproject", "galaxy-ops", "dist");
const STUBS = join(HERE, "stubs");

type Entry = "plain" | "min" | "ascii";

interface Built {
  entries: Record<Entry, string>;
  bytes: Record<Entry, number>;
  worker: string;
  runner: string;
  /** The packages that make up the plain bundle, largest first. */
  top: Array<[string, number]>;
}

/**
 * V8 keeps a script's source for its lifetime. On Node's ESM load path it is one byte per
 * character only when the file is entirely ASCII: a single Latin-1 "ä" doubles it as surely as a
 * "≤" does. esbuild's ascii charset escapes strings but leaves regex literals and legal comments
 * alone. A \u escape means the same thing in a string, template, regex or identifier.
 */
const asciiOnly = (source: string) =>
  source.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

async function build(): Promise<Built> {
  mkdirSync(OUT, { recursive: true });
  const redirect: esbuild.Plugin = {
    name: "worker-redirects",
    setup(b) {
      b.onResolve({ filter: /^(chokidar|better-sqlite3)$/ }, (a) => ({
        path: join(STUBS, `${a.path}.ts`),
      }));
      b.onResolve({ filter: /^@galaxyproject\/galaxy-ops$/ }, async (a) => {
        if (a.pluginData === "inner") return undefined;
        const r = await b.resolve(a.path, {
          kind: a.kind,
          resolveDir: a.resolveDir,
          importer: a.importer,
          pluginData: "inner",
        });
        return r.path === join(GALAXY_OPS, "index.js")
          ? { path: join(GALAXY_OPS, "index.browser.js") }
          : r;
      });
      b.onResolve({ filter: RAW }, (a) => ({
        path: resolve(a.resolveDir, a.path.replace(RAW, "")),
        namespace: "raw",
      }));
      b.onLoad({ filter: /.*/, namespace: "raw" }, (a) => ({
        contents: rawModule(a.path),
        loader: "js",
      }));
      b.onLoad({ filter: /\/core\/src\/agent\/skills\.ts$/ }, (a) => ({
        contents: inlineGlobs(readFileSync(a.path, "utf8"), dirname(a.path)),
        loader: "ts",
      }));
    },
  };
  // CommonJS packages inside an ESM bundle still call require for Node's builtins. No __dirname
  // here: Orbit's own ESM modules declare one at top level, which shares the bundle's scope.
  const banner = [
    'import { createRequire as __bootRequire } from "node:module";',
    "const require = __bootRequire(import.meta.url);",
  ].join("\n");
  const common: esbuild.BuildOptions = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
    banner: { js: banner },
  };
  const orbit = { ...common, entryPoints: [join(HERE, "orbit-entry.ts")], plugins: [redirect] };
  const entries: Record<Entry, string> = {
    plain: join(OUT, "orbit-entry.mjs"),
    min: join(OUT, "orbit-entry.min.mjs"),
    ascii: join(OUT, "orbit-entry.ascii.mjs"),
  };
  const plain = await esbuild.build({ ...orbit, outfile: entries.plain, metafile: true });
  await esbuild.build({ ...orbit, outfile: entries.min, minify: true });
  const ascii = await esbuild.build({
    ...orbit,
    minify: true,
    legalComments: "none",
    write: false,
    outfile: entries.ascii,
  });
  writeFileSync(entries.ascii, asciiOnly(ascii.outputFiles[0].text));
  const worker = join(OUT, "boot-worker.mjs");
  await esbuild.build({ ...common, entryPoints: [join(HERE, "boot-worker.ts")], outfile: worker });
  const runner = join(OUT, "boot-run.mjs");
  await esbuild.build({ ...common, entryPoints: [join(HERE, "boot-run.ts")], outfile: runner });

  const byPackage = new Map<string, number>();
  for (const [input, { bytesInOutput }] of Object.entries(
    Object.values(plain.metafile.outputs)[0].inputs,
  )) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input);
    const key = m ? m[1] : (/^(?:\.\.\/)*([^/]+(?:\/[^/]+)?)/.exec(input)?.[1] ?? input);
    byPackage.set(key, (byPackage.get(key) ?? 0) + bytesInOutput);
  }
  const top = [...byPackage].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const bytes = Object.fromEntries(
    Object.entries(entries).map(([k, f]) => [k, statSync(f).size]),
  ) as Record<Entry, number>;
  return { entries, bytes, worker, runner, top };
}

function once(runner: string, config: Omit<RunConfig, "dir">): RunReport {
  const dir = realpathSync(mkdtempSync(join(os.tmpdir(), "orbit-boot-")));
  try {
    // cwd is the run's own directory: state.ts and friends write beside process.cwd(), and a
    // worker thread cannot chdir, so every worker in this process shares it. --expose-gc is a
    // process-wide V8 flag, so it reaches the workers' isolates from here.
    const out = spawnSync(
      process.execPath,
      [...(config.gc ? ["--expose-gc"] : []), runner, JSON.stringify({ ...config, dir })],
      { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 },
    );
    const line = out.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    if (!line) throw new Error(`run failed (status ${out.status}):\n${out.stderr.slice(-4000)}`);
    return JSON.parse(line.slice("RESULT ".length)) as RunReport;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const max = (xs: number[]) => Math.max(...xs);
const min = (xs: number[]) => Math.min(...xs);
const ms = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x.toFixed(0)} ms`);
const mb = (x: number) => `${(x / 1024 / 1024).toFixed(0)} MB`;
const mb1 = (x: number) => `${(x / 1024 / 1024).toFixed(1)} MB`;

/** Durations between two marks, over every worker that reached both. */
function span(
  workers: WorkerReport[],
  from: keyof WorkerReport["marks"],
  to: keyof WorkerReport["marks"],
) {
  return workers.flatMap((w) => {
    const a = w.marks[from];
    const b = w.marks[to];
    return a === undefined || b === undefined ? [] : [b - a];
  });
}

const ROWS: Array<[string, keyof WorkerReport["marks"], keyof WorkerReport["marks"]]> = [
  ["thread start (spawn -> first line)", "spawn", "workerStart"],
  ["module load (import of the entry)", "workerStart", "loaded"],
  ["  seams installed", "loaded", "seams"],
  ["  host + extensions/orbit registered", "seams", "registered"],
  ["  Harness.open + conversation + attach", "registered", "opened"],
  ["  session_start + resume", "opened", "started"],
  ["host/harness open (sum of the four)", "loaded", "started"],
  ["first request (resume -> stub arrival)", "started", "firstArrival"],
  ["TOTAL spawn -> first model request", "spawn", "firstArrival"],
  ["user message (submit -> stub arrival)", "submit", "userArrival"],
  ["spawn -> user message at the stub", "spawn", "userArrival"],
];

const sum = (records: Array<Record<string, number> | undefined>) => {
  const out: Record<string, number> = {};
  for (const r of records) for (const [k, v] of Object.entries(r ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
};

function summarise(build: string, n: number, reports: RunReport[]) {
  const workers = reports.flatMap((r) => r.workers);
  const ok = workers.filter((w) => w.ok);
  const lines = [
    `\n### ${build}, N = ${n}  (${reports.length} runs, ${ok.length}/${workers.length} workers ok)`,
  ];
  const failed = workers.find((w) => !w.ok);
  if (failed) lines.push(`first failure: ${failed.error}\n${failed.stderr ?? ""}`);
  lines.push("| phase | median | max |", "|---|---|---|");
  for (const [label, from, to] of ROWS) {
    const xs = span(ok, from, to);
    if (xs.length) lines.push(`| ${label} | ${ms(median(xs))} | ${ms(max(xs))} |`);
  }
  const first = ok.flatMap((w) => (w.mem?.first ? [w.mem.first] : []));
  const row = (label: string, xs: number[], f = mb) => {
    if (xs.length) lines.push(`| ${label} | ${f(median(xs))} | ${f(max(xs))} |`);
  };
  row(
    "V8 heapUsed per worker at first request",
    first.map((m) => m.heapUsed),
  );
  row(
    "V8 heapTotal per worker at first request",
    first.map((m) => m.heapTotal),
  );
  row(
    "external per worker at first request",
    first.map((m) => m.external),
  );
  row(
    "  script source (v8 code statistics)",
    first.flatMap((m) => (m.code ? [m.code.source] : [])),
    mb1,
  );
  row(
    "  bytecode + metadata (in heap)",
    first.flatMap((m) => (m.code ? [m.code.bytecode] : [])),
    mb1,
  );
  row(
    "  old_space used",
    first.flatMap((m) => (m.spaces ? [m.spaces.old_space] : [])),
    mb1,
  );
  row(
    "  code_space used",
    first.flatMap((m) => (m.spaces ? [m.spaces.code_space] : [])),
    mb1,
  );
  row(
    "  large_object_space used",
    first.flatMap((m) => (m.spaces ? [m.spaces.large_object_space] : [])),
    mb1,
  );
  row(
    "V8 heapUsed per worker after the user turn",
    ok.map((w) => w.mem!.end.heapUsed),
  );
  const perWorker = reports.flatMap((r) =>
    r.rssAtFirst ? [(r.rssAtFirst - r.baselineRss) / n] : [],
  );
  row("process RSS growth / N, at the last first request", perWorker);
  row(
    "peak process RSS growth / N",
    reports.map((r) => (r.peakRss - r.baselineRss) / n),
  );
  lines.push(
    `| baseline process RSS (stub server, no workers) | ${mb(median(reports.map((r) => r.baselineRss)))} | |`,
  );
  // One run's median per repetition: how far the headline moves between repetitions.
  const perRun = reports.flatMap((r) => {
    const xs = span(
      r.workers.filter((w) => w.ok),
      "spawn",
      "firstArrival",
    );
    return xs.length ? [median(xs)] : [];
  });
  if (perRun.length > 1) {
    lines.push(
      `\nspawn -> first request, per-run medians: ${ms(min(perRun))} to ${ms(max(perRun))} over ${perRun.length} runs`,
    );
  }
  const requests = ok.map((w) => w.requests ?? 0);
  const submitted = ok.filter((w) => w.submitted).length;
  const bytes = ok.flatMap((w) => (w.firstBytes ? [w.firstBytes] : []));
  const prompt = ok.filter((w) => w.orbitPrompt).length;
  lines.push(
    `first request body: median ${(median(bytes) / 1024).toFixed(0)} KiB, Orbit's system prompt in ${prompt}/${ok.length}; notes (all workers): ${JSON.stringify(sum(ok.map((w) => w.notes)))}`,
  );
  const errors = ok.flatMap((w) => w.errors ?? []);
  if (errors.length) lines.push(`handler errors (first): ${errors[0]}`);
  lines.push(
    `model requests per worker: ${[...new Set(requests)].join(", ")}; user message accepted by ${submitted}/${ok.length}; child_process calls (all workers): ${JSON.stringify(sum(ok.map((w) => w.calls)))}; chokidar/better-sqlite3 stand-in touches (all workers): ${JSON.stringify(sum(ok.map((w) => w.inert)))}`,
  );
  return lines.join("\n");
}

const built = await build();
const require = createRequire(import.meta.url);
const tsx = pathToFileURL(require.resolve("tsx")).href;
const CACHE = join(OUT, "compile-cache");
rmSync(CACHE, { recursive: true, force: true });
const bundled = (entry: Entry, cache = false): Omit<RunConfig, "dir" | "n"> => ({
  worker: built.worker,
  entry: built.entries[entry],
  execArgv: [],
  ...(cache ? { compileCache: CACHE } : {}),
  repo: REPO,
  gc: GC,
});
const configs: Record<Build, Omit<RunConfig, "dir" | "n">> = {
  bundle: bundled("plain"),
  "bundle-min": bundled("min"),
  "bundle-ascii": bundled("ascii"),
  "bundle-cache": bundled("plain", true),
  "bundle-min-cache": bundled("min", true),
  "bundle-ascii-cache": bundled("ascii", true),
  tsx: {
    worker: join(HERE, "boot-worker.ts"),
    entry: join(HERE, "orbit-entry.ts"),
    execArgv: ["--import", tsx],
    redirects: {
      chokidar: join(STUBS, "chokidar.ts"),
      "better-sqlite3": join(STUBS, "better-sqlite3.ts"),
      [pathToFileURL(join(GALAXY_OPS, "index.js")).href]: join(GALAXY_OPS, "index.browser.js"),
    },
    repo: REPO,
    gc: GC,
  },
};

const header = [
  `machine: ${os.cpus()[0].model}, ${os.cpus().length} cores, ${mb(os.totalmem())}, ${os.platform()} ${os.release()}; load average at start ${os
    .loadavg()
    .map((l) => l.toFixed(1))
    .join(" ")}`,
  `node ${process.version}; bundle sizes: ${Object.entries(built.bytes)
    .map(([k, b]) => `${k} ${(b / 1024 / 1024).toFixed(1)} MB`)
    .join(", ")}`,
  `largest inputs of the plain bundle: ${built.top
    .map(([k, b]) => `${k} ${(b / 1024 / 1024).toFixed(1)} MB`)
    .join(", ")}`,
  `${RUNS} runs per configuration, each in a fresh process, builds interleaved within each run index, after one N = 1 warm-up per build${GC ? "; LIVE-HEAP MODE: gc() before every memory sample, timings not comparable" : ""}`,
];
console.log(header.join("\n"));
const all: Record<string, RunReport[]> = {};
// The warm-up fills tsx's transform cache and V8's compile cache, so every measured run sees
// what a long-lived host starting another worker sees. It is not a cold deploy: the OS page cache
// is already warm (esbuild just wrote each bundle, and two builds share a file), so its time is
// "empty compile/transform cache, warm page cache".
const warm: string[] = [];
for (const b of BUILDS) {
  const cold = once(built.runner, { ...configs[b], n: 1 });
  all[`${b}:warmup`] = [cold];
  const coldTotal = span(cold.workers, "spawn", "firstArrival")[0];
  const coldLoad = span(cold.workers, "workerStart", "loaded")[0];
  warm.push(
    `${b}: module load ${coldLoad === undefined ? "n/a" : ms(coldLoad)}, spawn -> first request ${coldTotal === undefined ? "n/a" : ms(coldTotal)}`,
  );
}
console.log(
  `\nwarm-up runs (empty compile/transform cache, warm OS page cache):\n${warm.join("\n")}`,
);
// Builds rotate within each repetition, so machine drift or heat spreads over every build
// instead of landing on whichever ran last.
for (const n of SIZES) {
  for (let r = 0; r < RUNS; r++) {
    const order = BUILDS.map((_, i) => BUILDS[(i + r) % BUILDS.length]);
    for (const b of order) (all[`${b}:${n}`] ??= []).push(once(built.runner, { ...configs[b], n }));
  }
}
for (const b of BUILDS) {
  console.log(`\n## ${b}`);
  for (const n of SIZES) console.log(summarise(b, n, all[`${b}:${n}`]));
}
const file = join(
  OUT,
  `results-${GC ? "gc-" : ""}${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);
writeFileSync(file, JSON.stringify({ header, runs: all }, null, 2));
console.log(`\nraw marks: ${file}`);
