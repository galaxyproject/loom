/**
 * One measured configuration, in a process of its own so each starts cold: the stub model
 * endpoint, N workers started together, and the process RSS around them. boot.ts runs this once
 * per (build, N, run) and reads the RESULT line it prints.
 */
import { mkdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { now, type Marks } from "./clock";
import type { WorkerData } from "./boot-worker";
import type { BootResult } from "./orbit-entry";

export interface RunConfig {
  n: number;
  /** The worker script: the built .mjs, or boot-worker.ts under tsx. */
  worker: string;
  entry: string;
  execArgv: string[];
  redirects?: Record<string, string>;
  compileCache?: string;
  repo: string;
  /** Per-worker directories go under here; it is also this process's cwd. */
  dir: string;
  /** Live-heap mode: this process runs with --expose-gc and workers collect before sampling. */
  gc?: boolean;
}

export interface WorkerReport {
  ok: boolean;
  marks: Marks;
  mem?: BootResult["mem"];
  requests?: number;
  notes?: Record<string, number>;
  /** The first request's body size, and whether it carried Orbit's whole system prompt. */
  firstBytes?: number;
  orbitPrompt?: boolean;
  submitted?: boolean;
  calls?: Record<string, number>;
  /** Touches of the chokidar and better-sqlite3 stand-ins; empty means Orbit never drove them. */
  inert?: Record<string, number>;
  errors?: string[];
  error?: string;
  stderr?: string;
}

export interface RunReport {
  n: number;
  baselineRss: number;
  /** Process RSS when the last worker's first request reached the stub. */
  rssAtFirst?: number;
  peakRss: number;
  workers: WorkerReport[];
}

const MESSAGE = "hello from the boot bench";

/** What fake-model.ts's text("ok") streams: an OpenAI-compatible reply in two chunks. */
const REPLY =
  [
    { choices: [{ index: 0, delta: { content: "ok" } }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  ]
    .map((c) => `data: ${JSON.stringify(c)}\n\n`)
    .join("") + "data: [DONE]\n\n";

async function run(config: RunConfig): Promise<RunReport> {
  const workers: WorkerReport[] = Array.from({ length: config.n }, () => ({
    ok: false,
    marks: {},
  }));
  let firsts = 0;
  let rssAtFirst: number | undefined;

  const server = http.createServer((req, res) => {
    const arrived = now();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const key = /Bearer w(\d+)/.exec(req.headers.authorization ?? "")?.[1];
      const w = key === undefined ? undefined : workers[Number(key)];
      if (w) {
        if (w.marks.firstArrival === undefined) {
          w.marks.firstArrival = arrived;
          const body = Buffer.concat(chunks);
          w.firstBytes = body.length;
          // A sentence shared/prompt-blocks.js owns, as the conformance test checks it.
          w.orbitPrompt = body.includes("Compaction (shrinking the");
          if (++firsts === config.n) rssAtFirst = process.memoryUsage.rss();
        } else if (w.marks.userArrival === undefined && Buffer.concat(chunks).includes(MESSAGE)) {
          w.marks.userArrival = arrived;
        }
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(REPLY);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const llm = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  const baselineRss = process.memoryUsage.rss();
  let peakRss = baselineRss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  }, 5);

  const threads: Worker[] = [];
  const done = workers.map(
    (report, i) =>
      new Promise<void>((settle) => {
        const dir = join(config.dir, `w${i}`);
        mkdirSync(dir, { recursive: true });
        const data: WorkerData = {
          entry: config.entry,
          redirects: config.redirects,
          compileCache: config.compileCache,
          options: {
            repo: config.repo,
            dir,
            llm,
            key: `w${i}`,
            message: MESSAGE,
            gc: config.gc,
          },
        };
        report.marks.spawn = now();
        const worker = new Worker(config.worker, {
          workerData: data,
          execArgv: config.execArgv,
          // The plan's worker starts with nothing from the host's environment.
          env: { HOME: dir, USERPROFILE: dir, PI_CODING_AGENT_DIR: join(dir, ".pi", "agent") },
          stdout: true,
          stderr: true,
        });
        threads.push(worker);
        const stderr: string[] = [];
        worker.stdout.resume();
        worker.stderr.on("data", (c: Buffer) => stderr.push(c.toString()));
        const timer = setTimeout(() => {
          report.error = "timed out after 120 s";
          settle();
        }, 120_000);
        worker.on(
          "message",
          (m: {
            ok: boolean;
            result?: BootResult;
            marks?: Marks;
            error?: string;
            calls?: Record<string, number>;
            inert?: Record<string, number>;
          }) => {
            clearTimeout(timer);
            // The stub's arrival marks live on this side; the worker's own marks win otherwise.
            const arrivals = {
              firstArrival: report.marks.firstArrival,
              userArrival: report.marks.userArrival,
            };
            report.ok = m.ok;
            report.marks = { ...report.marks, ...(m.result?.marks ?? m.marks), ...arrivals };
            report.mem = m.result?.mem;
            report.requests = m.result?.requests;
            report.notes = m.result?.notes;
            report.submitted = m.result?.submitted;
            report.calls = m.calls;
            report.inert = m.inert;
            report.errors = m.result?.errors;
            report.error = m.error;
            if (!m.ok) report.stderr = stderr.join("").slice(-4000);
            settle();
          },
        );
        worker.on("error", (e) => {
          clearTimeout(timer);
          report.error = e.stack ?? String(e);
          report.stderr = stderr.join("").slice(-4000);
          settle();
        });
      }),
  );
  await Promise.all(done);
  clearInterval(sampler);
  await Promise.all(threads.map((t) => t.terminate()));
  server.close();
  return { n: config.n, baselineRss, rssAtFirst, peakRss, workers };
}

const config = JSON.parse(process.argv[2]) as RunConfig;
const report = await run(config);
process.stdout.write(`RESULT ${JSON.stringify(report)}\n`);
// A stray handle from a terminated worker must not hold the next run back.
process.exit(0);
