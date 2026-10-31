# Layout

browser/ is an npm workspace of two packages and a test flavor. `@galaxyproject/orbit-browser`
(core/) is Orbit's shell for the browser: the agent in a worker, its providers, the chat and
artifact panes, and the Galaxy transport. `@galaxyproject/olit` (olit/) is the flavor that makes it
a Galaxy visualization plugin, and is what Galaxy installs. bare/ is a private flavor that adds
nothing, so the core is also tested as something other than Olit. The workspace root holds the
shared tooling and runs lint, its own scripts' tests and the e2e drives itself.
It forwards `build`, `dev`, `preview`, `build:session`, `test:watch` and `test:ui` to olit,
`build:pyodide` to core, and `test:unit` and `typecheck` to all three; `test`
chains all of the checks.

The agent worker runs Orbit's brain (`extensions/orbit/` at the repo root) on `pi-host.ts`, through
`core/src/agent/orbit/`. Everything else in `core/src/agent/` is shell support: the runtime and its
storage, Python, the browser's own tools, the page protocol, and Headless for Node. Brain behavior
(prompt text, guards, Galaxy tool handling, notebook and record semantics) goes in
`extensions/orbit/` and `shared/`, with what is browser-only layered on top of Orbit's. The repo's
`CLAUDE.md` and `docs/architecture.md` ("Browser shell") have the rule.

```
package.json              private workspace root: shared dev tooling, scripts that forward
tsconfig.base.json        compiler options both packages extend
scripts/ e2e/             tooling, the e2e stub and runner, and the bare flavor's drive
dist/session.mjs          the Node build of the agent (npm run build:session)

core/                     @galaxyproject/orbit-browser, TypeScript source behind package exports
  vite.ts                   the Vite preset a flavor builds with: proxies, defines, worker, Pyodide
  scripts/install_assets.js the orbit-browser-assets bin a flavor's build runs first: fetches
                            Pyodide's wheels into temp/
  pyodide.requirements.txt  the Python packages run_python loads
  src/index.ts              the page entry: mountOrbitBrowser and what a page needs
  src/shell.ts              mounts Orbit's ChatPanel, starts the flavor's worker, drives the chat
  src/layout.ts artifact-pane.ts usage-bar.ts retry-notice.ts   the pane's parts
  src/config.ts credentials*.ts   what the agent is handed, and by whom
  src/transcript.ts         the chat drawn from the conversation's events
  src/chat-markdown.ts      the chat's markdown: the model's raw HTML as text, images only from Galaxy
  src/artifacts/            artifact kinds (kinds.ts), the pane's renderers (index.ts), mermaid
  src/node.ts               the Node entry: Headless, describe, runNodeSession
  src/agent/                the agent worker: Orbit's brain on pi-host, and the shell around it
    index.ts                  the agent entry a flavor extends
    worker.ts client.ts       the page protocol and startAgentWorker, and the page's handle on it
    pi-host.ts                pi-coding-agent's ExtensionAPI over pi-durable, which Orbit runs on
    orbit/                    Orbit's brain in the worker:
      boot.ts                   the seams and the brain on pi-host
      worker.ts                 the page protocol, with pi's session lifecycle per conversation
      browser-env.ts            what the worker takes from a browser: postMessage, OPFS, Pyodide
      watch.ts                  one durable task per conversation, driving Orbit's poller
      ledger.ts                 the submission ledger in a file beside the store
      adapter.ts layers.ts      the browser's own tools and layers on top of Orbit's
      grants.ts skills.ts       the page's grant as Orbit's profile; Orbit's vendored skills
      skills-node.ts            the same skills read through the bundler, for Node
      env.ts shims/             the Node globals and modules Orbit imports, for a worker
    runtime.ts                the harness: conversations per history, model, compaction, Stop,
                              save and open
    documents.ts              state beside the transcript: binding, follow-up policy, sessions
    storage.ts                SQLite in the browser's private file system, one tab at a time
    headless.ts node-session.ts   the worker in-process under Node: one conversation over JSON
                              lines, for the eval harness
    saved.ts                  a conversation as a saved document
    tool.ts tools.ts          a browser tool, and the AgentFlavor seam
    records.ts                a history's earlier records, to continue a session from
    model.ts providers.ts     the model endpoint, its registry, its rate limit
    galaxy.ts galaxy-extras.ts   Galaxy REST and other hosts as a call's `web`; download_dataset,
                              upload_file and recommend_biocontainer
    tables.ts                 Galaxy's tabular, csv and tsv: header, column names and types
    python.ts python-realm.js python-node.ts   `run_python` and the realm Pyodide runs in
    processes/                deterministic procedures (lineage_report, organize_datasets)
    describe.ts               what the agent publishes about itself, for an outside evaluator

olit/                     @galaxyproject/olit: files ["static"]
  public/olit.xml           plugin manifest: data sources, ai_prompt, capabilities
  vite.config.ts            the core's preset; builds static/ (olit.xml, index.js, index.css,
                            the worker chunk, pyodide/)
  vite.config.session.ts    the Node build, into dist/session.mjs (the root copies it to ../dist)
  src/main.ts               reads data-incoming and mounts the shell with Olit's options
  src/worker.ts             the worker entry: startAgentWorker(olitFlavor)
  src/incoming.ts seed-dataset.ts saved-session.ts   launching on a dataset, saving as a visualization
  src/artifacts/            vega-lite and visualization kinds (kinds.ts) and renderers
  src/agent/flavor.ts       olitFlavor
  src/agent/layout.ts       olitLayout: where --describe finds Olit, and olit.xml's ai_prompt
  src/agent/node.ts         the Node entry: runNodeSession(olitFlavor, olitLayout)
  src/agent/visualizations.ts visualization-inputs.ts vega.ts hints.ts   the visualization tools
  e2e/                      the Playwright drives that mount the Olit plugin (helpers from ../e2e)
  src/agent/prompt.ts       the starting-dataset section
  src/agent/skills/         own/visualization, offered beside Orbit's vendored skills

bare/                     @galaxyproject/orbit-browser-bare, private: the core with nothing added
  src/main.ts src/worker.ts   mountOrbitBrowser with only the required options; startAgentWorker({})
  src/surface.test.ts       what the core alone sends a model, pinned in src/__surface__/
```

## How a flavor extends the core

A flavor imports the core only through its package exports (`.`, `/agent`, `/artifacts`,
`/worker`, `/node`, `/vite`, and `/testing` for its tests), never a path inside it, so it can move
to another repository and consume the published package. The rule lives in the core's `/testing`
export (`flavorTrespasses`), and each flavor's boundary test runs it over its own folder.
`olit/src/boundary.test.ts` also checks that the core's own source names none of Olit's tools, and `core/src/boundary.test.ts` keeps the core from importing any flavor in the
workspace or anything only a visualization flavor needs.

A flavor says who it is with a `Brand`, the same one on its `AgentFlavor` and on
`mountOrbitBrowser`, since the page reads what the worker keeps under it. Its prompt sections
go right after the identity line, as the flavor's own terms, or after Orbit's prompt
(`promptSections`), which is how Olit's Visualization term reaches the prompt without the core
naming `list_visualizations`.

bare/ is the second flavor a change to the core has to keep working. Its surface snapshot is what
every flavor inherits from the core, so a core change to the prompt or the tools shows there as
well as in Olit's, and anything Olit-specific that lands in the core shows up in a flavor that has
none of it. `e2e/bare-drive.cjs` mounts it on the current history with no session store.

- **Agent.** `AgentFlavor` (`/agent`) adds tools (registered after Orbit's, so they take
  `{{artifact}}` tokens and count as the agent's own), skill files offered beside Orbit's vendored
  skills, notes on Galaxy results, prompt sections (right after the identity line, as terms, or
  after Orbit's prompt), and artifact kinds. The flavor's worker entry calls
  `startAgentWorker(flavor)`; the Node entry calls `runNodeSession(flavor, layout)`.
- **Artifacts.** A kind augments `ArtifactKinds` (`/artifacts`) and is registered with how it is
  written into a page. Each realm keeps its own registry, so the worker registers the flavor's
  kinds and the page registers them again through `mountOrbitBrowser`'s `artifactKinds`; pass the
  same constant to both, since a kind the page doesn't know is dropped from what it shows. The
  page refuses to mount when a kind it knows has no renderer, or a renderer names a kind it
  doesn't know.
- **Page.** `mountOrbitBrowser(container, options)` takes the flavor's `createWorker`, its kinds and
  renderers, a `launch` callback (where the conversation starts and what to say about it; the
  default is Galaxy's current history), and an optional `sessions` store, without which there is
  no Save button. A flavor Galaxy hosts as a visualization plugin passes `galaxyChatUrl`, the AI
  proxy Galaxy serves it at `api/plugins/<name>`; that makes the keyless "galaxy" provider the
  first-launch default. Without it the picker offers every other provider and has to be answered.

The core ships as TypeScript source, so a flavor builds it with Vite: `?raw` and
`import.meta.glob` imports, the `process.env.*` defines and the `app/src/renderer` import all
assume that. Vite externalizes bare imports when it bundles a config file, which would hand the
linked `vite.ts` to Node as is, so olit's scripts load their config with `--configLoader runner`.

## Not split yet

What still ties the two packages to this workspace, and why each waits:

- **Publishing the core.** It imports Orbit's chat UI from `app/src/renderer` and ships TypeScript
  source, so it stays `private` for now. The plan is to publish it as a pre-built bundle that
  inlines the chat UI at build time, rather than publishing the renderer as a package of its own:
  the renderer is built for Orbit's shells, not as a reusable component, and a package would make
  its internals a public API. That means Vite library mode with one entry per export plus a
  `style.css`, and export conditions so this workspace keeps resolving TypeScript source while
  npm consumers get `dist/`. The handle `mountOrbitBrowser` returns is just `dispose()`, so no
  renderer type reaches the published declarations. Two things the bundle has to account for:
  - `--describe` reads the core's `src/agent/**` (exported symbols) from the installed package and
    Orbit's vendored skills and manifest from the repo, so the bundle either keeps shipping those
    (a `files` entry) or describe's data gets generated at the core's build time. A flavor still
    lays its own sources out as `src/agent/*.ts`.
  - The core reads build-time `process.env.*` defines (`credentials`, `build_commit`/`build_built`,
    the `llm_*` dev overrides) that the preset's `defines()` injects into the flavor's build. A
    pre-built bundle can't carry those: building them in would stamp the core's commit into every
    saved session and freeze the dev settings, and leaving them in throws on `process`. So they
    become `mountOrbitBrowser` options (a build stamp, the credentials mode, the dev model
    overrides), with the build stamp handed to the worker in its open request.
- **Durable format names that still say olit.** A flavor names itself with a `Brand` (`{ id,
  name }`, on `AgentFlavor` and `mountOrbitBrowser`; `DEFAULT_BRAND` is Orbit), and everything
  that tells flavors apart follows it: the identity line, the follow-up mark, the tag on result
  notes, the misroute refusal, run_python's description, the extension name, describe's `agent`
  and `runner`, the target a flavor's own skills are offered under (`skills/own/<skill>` becomes
  `skills/<id>-<skill>`), the record page's title and slug (`<id>-orbit-<session>`), the OPFS pool, the per-user database
  and its tab lock, the browser storage keys, and the page's messages. Olit's brand reproduces
  its old names exactly. What doesn't follow it is the durable format inside each brand's own
  database and saved documents: the document kinds `olit.binding`, `olit.follow-ups` and
  `olit.sessions`, the watch task `olit.galaxy-watch`, and the `olit_session` marker on a saved
  session. They can't collide across flavors, which never share a database or a session store,
  and renaming them would orphan every conversation Olit has kept, so they change only with a
  migration.
- **One mount per document.** The shell puts its theme on the root element and the pane's state
  on body, sizes the pane from the window, injects fixed ids and configures the shared `marked`.
  Scoping all of that to the container is a follow-up; until then a host that needs the shell
  inside a larger page mounts it in an iframe.
- **Shared config.** Both packages extend `tsconfig.base.json` and use the root's Prettier config;
  a flavor that leaves takes a copy.

## Where tooling belongs

Tooling lives flat in `scripts/`, one file per job, named `<verb>_<subject>` so an `ls` groups the
verbs and the name says when it runs. The extension follows what the script has to load, not which
side of olit it serves: the core's `scripts/install_pyodide.js` is JavaScript because it fetches
through node. A script
a package's own build needs lives in that package instead, so the package builds wherever it goes:
the core's `scripts/` fetches what it ships, and a flavor's `build` runs `orbit-browser-assets`
before Vite.

If another repo names a path, it is not tooling but an interface. The `agents` repo builds
`dist/session.mjs` (`npm run build:session`) and drives it, asks it to `--describe --root .`
itself from browser/, and asks it to `settle`, waiting for submitted work and the runs its
follow-ups start; it reads the entries pi-durable appended. `olit/src/agent/describe.test.ts` pins
what `--describe` returns, and `olit/src/agent/surface.test.ts` pins what the agent sends a model.

## Vendored integrity

The skills the agent offers are Orbit's vendored tree, `extensions/orbit/vendor/skills/`, read by the
worker (`core/src/agent/orbit/skills.ts`, bodies fetched beside the bundle) and by the session
bundle (`skills-node.ts`, through the bundler); the browser keeps no copy of its own. Bumping
`scripts/skills.manifest.json` at the repo root and running `npm run sync:skills` moves Orbit and
the browser together, and `npm run check:skills` there is the drift gate.

Orbit's chat UI is not copied: it is imported from `app/src/renderer` in this repo.

The Orbit seam registry, which tracks what Olit's prompts and tools carry from Orbit, lives in the
`agents` repo and reads what the session's `--describe` publishes.

One gate. Every tool declares a capability (`llm`, `local`, `read`, `write`); a session advertises
only the tools its grant covers, and a process is gated on the strongest capability it declares.
The browser grants all four; the eval harness narrows the grant per scenario.
