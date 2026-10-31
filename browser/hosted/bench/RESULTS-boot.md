# Boot timing and memory: the Orbit brain under Node, to its first model request

Step 0 of the hosted-service plan asks how long a worker takes from start to the first model request, and how much memory it holds once it gets there. The answer sets how eagerly the host releases idle workers (key decision 9). It does not change the architecture.

This bench boots Orbit the way `core/src/agent/pi-host.orbit.test.ts` does, but outside vitest and inside `node:worker_threads`. It runs one conversation per worker and 1, 4 or 16 workers at once, and every worker sends one user message.

## Headline

Measured on an Apple M4 Pro (14 cores, 24 GB, macOS 26 / Darwin 25.6.0) with Node v24.21.0. Each configuration ran 5 times, each run in a fresh process, with the builds interleaved within each repetition. The figures are medians over every worker, with the maximum in brackets. The machine was not quiet: a browser held one core at about 95% throughout, and the load average was 2.5 at the start.

| build | N | spawn -> first model request | module load | process RSS growth / N | live V8 heap / worker |
|---|---|---|---|---|---|
| esbuild bundle (plain, 17.2 MB) | 1 | 324 ms (327) | 255 ms | 162 MB | 35 MB |
| | 4 | 337 ms (355) | 266 ms | 155 MB | |
| | 16 | 539 ms (767) | 417 ms | 133 MB | 35 MB |
| bundle, minified + V8 compile cache | 1 | 217 ms (222) | 149 ms | 120 MB | 34 MB |
| | 4 | 227 ms (230) | 157 ms | 110 MB | |
| | 16 | 366 ms (434) | 245 ms | 94 MB | 34 MB |
| bundle, minified + ASCII-only + compile cache | 1 | 207 ms (216) | 141 ms | 116 MB | 34 MB |
| | 4 | 218 ms (226) | 149 ms | 106 MB | |
| | 16 | 356 ms (404) | 234 ms | 80 MB | 33-34 MB |
| unbundled, tsx | 1 | 932 ms (946) | 793 ms | 235 MB | 97 MB |
| | 4 | 1.01 s (1.04) | 852 ms | 222 MB | |
| | 16 | 2.28 s (2.48) | 1.90 s | 184 MB | 97-98 MB |

The live-heap column comes from a separate run (`--gc 1`, 3 runs, N = 1 and 16) in which each worker collects garbage before sampling. The timed run samples without a collection, so its heapUsed (41-47 MB bundled, 121-123 MB under tsx) is an upper bound that includes garbage.

What this says:

- **Module load is nearly all of the boot.** Once the modules are in, Orbit takes about 25 ms to install its seams, register extensions/loom on pi-host, open the harness, create and attach the conversation, and run session_start. The greeting request goes out about 25 ms after that. A warm turn (submit to the request leaving) takes about 8 ms.
- **A cold worker is about 0.2-0.3 s from start to its first model request, and stays under 1 s with 16 starting at once.** That held in every run here and in the earlier sequential run. Next to model latency it is small. Releasing idle workers eagerly costs the user little, so key decision 9 can lean towards releasing.
- **Memory per worker is about 80-160 MB of process RSS, depending on the build and N.** The live V8 heap is about 34-35 MB of that, and external memory (almost all of it the bundle's source text, which V8 keeps for the script's lifetime) another 14-40 MB. The RSS line is the growth in process RSS divided by N, so it includes per-isolate overhead and allocator slack, and it falls as N grows because the process's fixed costs are shared.
- **Ship the bundle minified with the compile cache.** Together they take about 40 MB of RSS off each worker; either alone saves next to nothing (finding 2). ASCII escaping adds a further 4-14 MB.
- **Run the bundle, not tsx.** Unbundled, a worker takes three to four times as long to load and holds about three times the live heap, because each worker compiles the TypeScript itself.

How much to trust each number: the N = 1 and N = 4 figures move by a few percent between invocations, and the cache / no-cache split is large and stable. The N = 16 figures are not stable between invocations. The same builds measured sequentially (one build after another, an earlier version of this bench) gave medians 15-60% higher than the interleaved run above: plain bundle 846 ms against 539 ms, bundle-cache 435 against 378 ms, tsx 2.71 against 2.28 s. A reviewer's rerun fell in between. Read N = 16 as a range, and do not rank builds that differ by less than about 30% at that size. Within this run, the per-run medians of the plain bundle at N = 16 spread from 519 to 671 ms.

Prior measurement, module load only: about 26 MB heap, 80-135 MB RSS per worker, 0.19 s cold (0.9 s with 32 workers at once). These numbers go further, to the first model request, with Orbit registered, a conversation open and a 93 KiB request built, so the larger live heap (34-35 MB) is expected. The RSS range matches.

## How to run it

```sh
cd browser/hosted && node --import tsx bench/boot.ts
# options: --builds bundle,bundle-min,bundle-ascii,bundle-cache,bundle-min-cache,bundle-ascii-cache,tsx
#          --n 1,4,16  --runs 5  --gc 1 (live-heap mode: memory rows only, timings not comparable)
```

The full run (7 builds × 3 sizes × 5 runs) takes a little over a minute on this machine. It needs no database or network: the model endpoint is a local stub, and Galaxy is an in-process transport. Build output, the V8 compile cache and the raw per-worker marks (`results-<timestamp>.json`) go to `browser/hosted/.scratch/boot/`. The console output for the figures above is in `.scratch/boot/full-run.txt` and `.scratch/boot/gc-run.txt`. That directory is **not** git-ignored at the moment (see Findings).

## What is measured

Files under `bench/`:

- `orbit-entry.ts` -- the test's boot path without vitest. It statically imports pi-durable, pi-host, `model`/`providers`/`runtime`, extensions/loom and the seam modules, so importing it is the module-load phase. `boot()` then runs the same sequence as the test's `beforeAll`:
  - set the browser capability profile (`shell: false, files: false, notebook: "page", network: true, mcpServers: false, ui: "worker"`);
  - install the config, instruction, vendor-skills, Galaxy-transport, page-record-store and galaxy-ops tool-source seams (the shell's three extras are stubs);
  - `createPiHost`, `loom(host.api)`, `seal()`;
  - `createRegistry().install`, `agentModels().connect(resolve({ ai_base_url: <stub> }))`, `Harness.open(new MemoryStorage(), { …, onReport })`, `createConversation`, `host.attach`. As in the test, `onReport` sends harness faults into the notes as `handler-error`, so they show in each build's check line;
  - `host.start("startup")` and `harness.resume()`. Galaxy credentials are configured, so the greeting is a model turn, and that turn sends the first request;
  - once the greeting has settled, `host.submit(<one user message>)` and wait for it.
- `boot-worker.ts` -- the worker script. It has no Orbit imports, so its first line marks the end of thread and isolate startup. It stubs `child_process` with the test's answers and counts the calls, installs the Node module hooks (unbundled run only), then `import()`s the entry.
- `boot-run.ts` -- one measured configuration in a fresh process: the stub OpenAI-compatible endpoint (it streams `fake-model.ts`'s `text("ok")` and records when each worker's requests arrive, telling the workers apart by API key), an RSS sampler, and N workers started together. Workers get `env: { HOME, USERPROFILE, PI_CODING_AGENT_DIR }` and nothing else, as the plan specifies.
- `boot.ts` -- builds the bundles with esbuild, does one warm-up run per build, then runs every (build, N) configuration `--runs` times, rotating the build order in each repetition so that drift on the machine spreads over all builds. It prints the tables.
- `vite-shims.ts`, `vite-env.d.ts`, `stubs/` -- the Node stand-ins for what Vite and the test's `vi.mock` supply (see Findings). The chokidar and better-sqlite3 stand-ins count every property read, call and construction on a ledger that the worker reports.

Phases (all marks are `performance.timeOrigin + performance.now()`, so marks from different threads line up):

| phase | from -> to |
|---|---|
| thread start | main thread before `new Worker` -> the worker's first line |
| module load | worker's first line -> `import()` of the entry resolved |
| host/harness open | -> seams installed -> host registered and sealed -> harness opened, conversation attached -> session_start and resume |
| first request | resume -> the stub endpoint receives the greeting request |
| user message | `host.submit` -> the stub receives the request carrying it |

Memory:

- **heapUsed / heapTotal / external** are the worker's own `process.memoryUsage()`, taken inside its fetch wrapper when the first model request leaves. They are per-isolate figures. In the timed run they are sampled without a collection, so heapUsed is an upper bound. In `--gc 1` mode the runner process starts with `--expose-gc` (a process-wide V8 flag, so the workers' isolates get `gc()` too) and each worker collects before sampling; that stalls the sampled request, so that mode's timings are not used.
- Alongside them, `v8.getHeapCodeStatistics()` (script source held outside the heap, bytecode) and `v8.getHeapSpaceStatistics()` (used bytes per space).
- **RSS** is process-wide even inside a worker. The figure reported is the process RSS when the last worker's first request reached the stub, minus the process's RSS before any worker started (59 MB: Node, the stub server and the sampler), divided by N. A 5 ms sampler also records the peak over the run.

Each check passed in every run (80/80 workers at N = 16, every build): the first request carried Orbit's whole system prompt (a sentence `shared/prompt-blocks.js` owns, as the test checks), each worker made exactly 2 model requests (greeting and user turn), the user message was accepted, and pi-host's notes were the same in every worker (`{"silent":1,"dropped":3}`, with no `handler-error` from pi-host or from the harness's `onReport`). Orbit made no `child_process` calls, and nothing touched the chokidar or better-sqlite3 stand-ins: the ledger stayed empty in every worker. A positive control (`.scratch/boot/ledger-check.ts`, driving each stand-in directly) shows the ledger records reads, calls and constructions.

## The builds

| build | what it is | entry size |
|---|---|---|
| `bundle` | esbuild, `platform: node`, ESM, everything bundled, `createRequire` banner | 17.2 MB |
| `bundle-min` | the same, minified | 8.2 MB |
| `bundle-ascii` | minified, legal comments dropped, every remaining non-ASCII character `\u`-escaped | 8.2 MB |
| `bundle-cache` | `bundle` with `module.enableCompileCache()` in the worker | 17.2 MB |
| `bundle-min-cache` | `bundle-min` with the compile cache (the control that separates minification from ASCII) | 8.2 MB |
| `bundle-ascii-cache` | `bundle-ascii` with the compile cache | 8.2 MB |
| `tsx` | unbundled: workers start with `--import tsx`; an in-thread `module.registerHooks` adds the redirects and Vite shims | -- |

The largest inputs to the plain bundle, with both copies of each package added together (see finding 3): `@earendil-works/pi-ai` 2.0 MB, `@google/genai` 1.7 MB, `openai` 1.5 MB, `@anthropic-ai/sdk` 1.3 MB, `@galaxyproject/galaxy-ops` 1.1 MB, `undici` 1.1 MB, `@earendil-works/pi-coding-agent` 0.9 MB, typebox 0.9 MB, extensions/loom 0.9 MB, zod 0.8 MB, `node-forge` 0.6 MB and `google-auth-library` 0.5 MB.

Summary by build, medians (max), spawn -> first model request / RSS growth per worker. For N = 16, the range of the five per-run medians follows in square brackets.

| build | N = 1 | N = 4 | N = 16 |
|---|---|---|---|
| bundle | 324 ms (327) / 162 MB | 337 ms (355) / 155 MB | 539 ms (767) [519-671] / 133 MB |
| bundle-min | 305 ms (324) / 159 MB | 327 ms (333) / 150 MB | 524 ms (592) [503-539] / 143 MB |
| bundle-ascii | 310 ms (322) / 155 MB | 324 ms (331) / 145 MB | 510 ms (606) [506-518] / 125 MB |
| bundle-cache | 221 ms (222) / 161 MB | 234 ms (238) / 151 MB | 378 ms (461) [368-384] / 116 MB |
| bundle-min-cache | 217 ms (222) / 120 MB | 227 ms (230) / 110 MB | 366 ms (434) [356-382] / 94 MB |
| bundle-ascii-cache | 207 ms (216) / 116 MB | 218 ms (226) / 106 MB | 356 ms (404) [347-376] / 80 MB |
| tsx | 932 ms (946) / 235 MB | 1.01 s (1.04) / 222 MB | 2.28 s (2.48) [2.22-2.32 s] / 184 MB |

The warm-up run is each build's first worker with an empty V8 compile cache (and, for tsx, an empty transform cache), but with a warm OS page cache: esbuild had just written every bundle, and `bundle-ascii` and `bundle-ascii-cache` share a file. It is not a cold-deploy figure; this bench never measured one. Spawn to first request in the warm-up was 281-320 ms for the bundles and 1.00 s for tsx. Every measured run comes after a warm-up, which is what a long-lived host starting yet another worker sees.

### Full phase tables

The plain bundle:

| phase | N = 1 | N = 4 | N = 16 |
|---|---|---|---|
| thread start | 15 ms (16) | 16 ms (17) | 28 ms (41) |
| module load | 255 ms (258) | 266 ms (282) | 417 ms (688) |
| · seams installed | 9 ms (10) | 10 ms (12) | 12 ms (39) |
| · host + extensions/loom registered | 7 ms (8) | 8 ms (8) | 9 ms (36) |
| · Harness.open + conversation + attach | 5 ms (5) | 5 ms (5) | 5 ms (46) |
| · session_start + resume | 6 ms (6) | 5 ms (7) | 7 ms (29) |
| host/harness open (total) | 27 ms (28) | 28 ms (31) | 47 ms (82) |
| first request | 27 ms (28) | 27 ms (29) | 39 ms (71) |
| **spawn -> first model request** | **324 ms (327)** | **337 ms (355)** | **539 ms (767)** |
| user message (submit -> stub) | 9 ms (9) | 8 ms (9) | 9 ms (25) |
| heapUsed at first request, no GC (upper bound) | 42 MB (42) | 42 MB (48) | 43 MB (51) |
| live heap at first request (`--gc 1`) | 35 MB | | 35 MB |
| external at first request | 40 MB (40) | 40 MB (40) | 40 MB (57) |
| · of which script source | 39.8 MB | 39.8 MB | 39.8 MB |
| RSS growth / N at first requests | 162 MB (162) | 155 MB (156) | 133 MB (144) |
| peak RSS growth / N | 168 MB (186) | 165 MB (166) | 142 MB (146) |

Minified, with the compile cache:

| phase | N = 1 | N = 4 | N = 16 |
|---|---|---|---|
| thread start | 16 ms (16) | 16 ms (16) | 30 ms (61) |
| module load | 149 ms (153) | 157 ms (163) | 245 ms (307) |
| host/harness open (total) | 25 ms (26) | 25 ms (28) | 45 ms (83) |
| first request | 27 ms (27) | 28 ms (30) | 44 ms (76) |
| **spawn -> first model request** | **217 ms (222)** | **227 ms (230)** | **366 ms (434)** |
| heapUsed at first request, no GC | 41 MB (41) | 41 MB (42) | 40 MB (45) |
| live heap at first request (`--gc 1`) | 34 MB | | 34 MB |
| external at first request | 30 MB (30) | 30 MB (30) | 22 MB (30) |
| · of which script source | 21.9 MB | 21.9 MB | 21.9 MB |
| RSS growth / N at first requests | 120 MB (120) | 110 MB (111) | 94 MB (99) |
| peak RSS growth / N | 124 MB (138) | 115 MB (116) | 100 MB (103) |

Minified, ASCII-only, with the compile cache:

| phase | N = 1 | N = 4 | N = 16 |
|---|---|---|---|
| thread start | 15 ms (16) | 16 ms (17) | 31 ms (46) |
| module load | 141 ms (145) | 149 ms (155) | 234 ms (292) |
| host/harness open (total) | 25 ms (27) | 27 ms (29) | 44 ms (77) |
| first request | 26 ms (28) | 27 ms (29) | 40 ms (78) |
| **spawn -> first model request** | **207 ms (216)** | **218 ms (226)** | **356 ms (404)** |
| user message (submit -> stub) | 7 ms (8) | 8 ms (10) | 10 ms (36) |
| heapUsed at first request, no GC | 47 MB (47) | 46 MB (46) | 46 MB (47) |
| live heap at first request (`--gc 1`) | 34 MB | | 33 MB (34) |
| external at first request | 14 MB (14) | 14 MB (14) | 14 MB (14) |
| · of which script source | 13.6 MB | 13.6 MB | 13.6 MB |
| RSS growth / N at first requests | 116 MB (117) | 106 MB (108) | 80 MB (83) |
| peak RSS growth / N | 119 MB (130) | 112 MB (114) | 90 MB (91) |

Unbundled under tsx:

| phase | N = 1 | N = 4 | N = 16 |
|---|---|---|---|
| thread start (includes `--import tsx`) | 32 ms (35) | 33 ms (35) | 64 ms (160) |
| module load | 793 ms (810) | 852 ms (874) | 1.90 s (2.26) |
| host/harness open (total) | 31 ms (33) | 33 ms (39) | 68 ms (168) |
| first request | 76 ms (78) | 92 ms (103) | 191 ms (430) |
| **spawn -> first model request** | **932 ms (946)** | **1.01 s (1.04)** | **2.28 s (2.48)** |
| heapUsed at first request, no GC | 123 MB (138) | 121 MB (128) | 121 MB (151) |
| live heap at first request (`--gc 1`) | 97 MB | | 97 MB (98) |
| RSS growth / N at first requests | 235 MB (267) | 222 MB (237) | 184 MB (187) |

Under tsx the first request takes 76-191 ms rather than about 27 ms, presumably because modules that Orbit imports lazily during its first turn are compiled then. That cause is inferred, not measured.

## Findings

For the plan and for the code. None of these were changed here.

1. **A bundle is the deployment shape, and the V8 compile cache is cheap to add.** `module.enableCompileCache(dir)` in each worker, pointed at a directory shared by the worker pool, cuts module load from about 255 ms to about 150 ms at N = 1, and the N = 16 total from about 540 ms to about 370 ms (in the earlier sequential run, 846 to 435 ms). The cache has to be written by one warm-up boot (or at image build time) and must be invalidated with the bundle.
2. **Minification and the compile cache save memory only together; ASCII escaping adds a little.** At N = 1, RSS growth per worker is 162 MB for the plain bundle, 159 MB minified, 161 MB with the cache alone, and 120 MB minified with the cache. Neither change does it alone. The `bundle-min-cache` control shows the drop does not need ASCII escaping, which an earlier version of this write-up credited with it. The same split shows with nothing booted but the import (`.scratch/boot/interaction/probe.mjs`, 3 fresh processes each): RSS growth 158 MB minified against 116 MB minified with the cache, and 160 against 156 MB for the plain bundle.
   The likely mechanism, partly measured: without a cache V8 parses and compiles the whole bundle, and the transient parser and compiler memory is malloc'd outside the heap. `v8.getHeapStatistics().peak_malloced_memory` after the import is 62 MB for either minified bundle without the cache and 7 MB with it, which matches the roughly 42 MB RSS saving: the allocator keeps the freed pages resident. That does not explain the plain bundle, whose peak also falls with the cache (36 to 7 MB) while its RSS falls only 4 MB. Why the plain bundle keeps its RSS is unexplained.
   ASCII escaping on its own is a source-text saving. V8 keeps each script's source for its lifetime, and on Node's ESM load path at one byte per character only when the file is entirely ASCII. A single non-ASCII character, even a Latin-1 one, doubles it (a reviewer's probe: a 17.8 MB module holds 34 MB external all-ASCII, 51 MB with one `ä` or one `≤` appended; I reproduced it). esbuild's default `charset: ascii` escapes strings but leaves regex literals and legal comments alone: the minified bundle has `±≤≥≠≈∈→⇒∞∫∑√` in a regex, two U+2014 in regexes, and `ä` in fetch-blob's licence comment. Escaping them takes the minified bundle's source from 21.9 to 13.6 MB per worker, and RSS from 120 to 116 MB at N = 1 and 94 to 80 MB at N = 16. Recommend shipping minified with the compile cache, and the ASCII pass as a small extra. The `\u`-escape pass in `boot.ts` is a quick hack: it would also change the text of a `String.raw` template. The production build should do it more carefully (esbuild `legalComments: "none"`, and a check that fails the build on any byte above 0x7f).
3. **The bundle carries two copies of pi-ai and its provider SDKs, about 5 MB of 18 MB.** Core resolves packages from `browser/node_modules` and extensions/loom from the root `node_modules`, and the two trees hold separate copies. Both copies of these packages end up in the bundle: `@earendil-works/pi-ai`, `@google/genai` (0.9 MB each), `openai` (0.8 MB each), `@anthropic-ai/sdk` (0.7 MB each), typebox, yaml, `google-auth-library`, `ws`, zod, `@galaxyproject/galaxy-ops`, and about 25 smaller ones. Counting the smaller copy of each, that is 4.95 MB of the 18.0 MB bundle, measured from esbuild's per-module path comments. The vitest run loads both copies too. Some of the pairs are different versions, not just different copies: pi-ai is 1.0.4 in `browser/node_modules` and 1.1.0 at the root, and galaxy-ops is 0.3.2-ops.3 (the fork) against 0.3.1. `openai`, `@google/genai` and `@anthropic-ai/sdk` are the same versions in both trees. A bundler alias for those would only save bytes, but unifying pi-ai or galaxy-ops picks one version for both core and extensions/loom, so it is a dependency change to test against both, not a bundler setting. Two copies of pi-ai can also mean two module-level registries and two `instanceof` identities; whether that matters to Orbit was not checked. Separately, pi-ai statically imports the Google and Anthropic SDKs (`dist/api/google-*.js`, `anthropic-messages.js`), although hosted Orbit only talks to an OpenAI-compatible LiteLLM endpoint (key decision 3). Lazy provider imports, upstream in pi-ai, would remove a few more MB from every worker's parse.
4. **A worker thread cannot `chdir`, and nothing on this path needed it.** The test calls `process.chdir(tmp)`, with the comment "state.ts, registry.ts and activity.ts write beside process.cwd()". In `worker_threads`, `process.chdir` throws, so every worker in a process shares one cwd. The bench gives each worker its own `HOME` and host `cwd` and runs each process in a fresh temp directory. A check run with N = 2 left **no files at all** in that directory or in the workers' directories: under the browser profile with the page record store, boot, the greeting and one turn wrote nothing to disk. extensions/loom still reads `process.cwd()` at 13 sites in 10 files (`session-lifecycle.ts`, `context.ts`, `dashboard-store.ts`, `user-instructions.ts`, `lessons/user-dir.ts`, `sandbox/index.ts`, `session-index/tools.ts`, and others). In a process shared by many tenants, any of them that a later turn reaches would see the host's cwd, not the conversation's. They should be audited, or routed through `ctx.cwd`, before milestone 0. That is a correctness question, not a performance one.
5. **Two Vite-only constructs are on the boot path.** `core/src/agent/skills.ts` uses an eager `import.meta.glob("./skills/**/*", { query: "?raw" })`, and `core/src/agent/python.ts` imports `./python-realm.js?raw`. Node, esbuild and tsx all need a shim for them; `vite-shims.ts` inlines both the way Vite would. The hosted build will need the same. Alternatively, core could move them behind a seam, as the vendor skills already are.
6. **Three module substitutions from the test carry over to the Node bundle.** The root galaxy-ops Node entry is swapped for its browser entry, and `chokidar` and `better-sqlite3` are replaced with inert stand-ins. The bench's stand-ins keep a ledger, and it stayed empty in every worker of every run: on this path (boot, greeting, one turn) Orbit never read a property of either, let alone called one. Later turns were not covered. The conformance test asserts the same with its own recording proxy. A native addon has no place in a worker bundle, so the hosted build needs these same substitutions. Without them the bundle pulls in the native `better-sqlite3` through `session-index/db.ts`.
7. **Orbit made no `child_process` calls on this path.** The test still stubs git's answers, but under this profile the boot, greeting and user turn never reached them.
8. **The greeting is the first model request, and it is 93 KiB.** With Galaxy credentials present, `session_start` sends a greeting turn whose request carries Orbit's whole system prompt and tool list. Every new hosted conversation pays for that in tokens before the user types anything, which matters for the per-user LiteLLM budget (key decision 3).
9. **`browser/hosted/.scratch/` is not git-ignored.** The bench writes about 40 MB there (bundles, the compile cache and results). It needs a `.gitignore` entry before anything in `browser/hosted` is committed.

## Limits

- `MemoryStorage`, not Postgres: harness open will be slower against the Postgres store and pg-boss, and that is measured separately. The model stub replies instantly; real model latency comes on top of every number here.
- The host wires no `ask`, as in the test, so `hasUI` is false. Hosted wires `ask` (decision 21); that should not change boot cost, but it was not measured.
- These timings come from one laptop that was not quiet (a browser process at about 95% of one core, load average 2.5 at the start and about 15 at the end of the run, which is the bench's own workers). The OS page cache was warm throughout. N = 16 varies by 15-60% between invocations (see the headline). On a smaller server N = 16 will be slower, because 16 workers compiling at once compete for cores (this machine has 14).
- The RSS figures are process-level differences divided by N. Memory the allocator has freed but kept counts towards them, so they are an upper-bound estimate of each worker's resident memory, not an exact figure. Finding 2 shows how much of that slack depends on the build.
- One conversation per worker with one short turn. Heap growth over a long conversation is not covered.
