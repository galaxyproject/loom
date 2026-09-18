# Contributing to Loom & Orbit

**Loom** is the agent brain -- a [Pi.dev](https://pi.dev) extension in
[`extensions/loom/`](extensions/loom/). **Orbit** ([`app/`](app/)) is an
Electron desktop shell around it. There is also a browser shell
([`web/`](web/)) and a plain CLI (`bin/loom.js`). All four run the _same_
brain, so a change to `extensions/loom/` shows up everywhere at once.

## Just want to try it?

You don't need any of this. Download an installer from the
[Releases page](https://github.com/galaxyproject/loom/releases) --
[`INSTALL.md`](INSTALL.md) has per-platform steps -- or install the CLI:

```bash
npm install -g @galaxyproject/loom
loom
```

Then tell us what broke. There's a **Feedback** button inside Orbit, or file an
[issue](https://github.com/galaxyproject/loom/issues). Useful bug reports
include your OS and version, the Orbit/Loom version, which LLM provider and
model you were on, and what you expected instead. If the agent did something
odd, paste the relevant chunk of the conversation -- the `notebook.md` section
it wrote is often more informative than a screenshot.

## Developer setup

You need **Node 22.19+** (see [`.nvmrc`](.nvmrc)), **git**, and
[**uv**](https://docs.astral.sh/uv/) on `PATH` (Galaxy MCP runs through it).

```bash
# macOS
brew install node git uv

# Ubuntu/Debian
sudo apt install -y git curl build-essential
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && source ~/.bashrc && nvm install --lts
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Then:

```bash
git clone https://github.com/galaxyproject/loom.git
cd loom
npm install
cd app && npm install      # needed even if you never touch Orbit -- see below
```

**There is no build step.** `extensions/loom/` is TypeScript that Pi loads
directly, and `shared/` is hand-written JS with checked-in `.d.ts` files.
`tsc` is configured `noEmit` -- it only typechecks. Edit a file, restart, done.

Windows: Orbit ships native but remote-only (no local bash). For local
execution, develop inside WSL2 --
`curl -fsSL https://raw.githubusercontent.com/galaxyproject/loom/main/scripts/setup-wsl.sh | bash`.

## Run it

Three shells, one brain. Pick whichever matches what you're changing:

```bash
node bin/loom.js           # CLI, from the repo root
cd app && npm start        # Orbit desktop
cd web && npm install && npm run dev   # browser at localhost:3000
```

**For UI work, use the web shell.** Orbit's Electron renderer has HMR disabled
on purpose, so the desktop loop means restarting the app on every change. The
web server ([`web/README.md`](web/README.md)) serves the _same_ renderer with
hot reload against the _same_ brain. It's a single-user dev convenience with no
authentication -- keep it on a network you trust.

First run needs an LLM API key. Orbit's welcome screen will ask; the CLI reads
`~/.loom/config.json`. Anthropic, OpenAI, Google, or a local Ollama/LiteLLM
endpoint all work. Galaxy is optional -- plenty of the codebase is reachable
without a server configured.

## The check loop

The full suite is 175 files and ~2000 tests, and it runs in about five seconds.
Run it constantly.

```bash
npm test                        # vitest, whole suite
npm run test:watch              # or leave it running
npx vitest run tests/foo.test.ts    # one file
npm run typecheck               # tsc --noEmit, brain side
cd app && npx tsc --noEmit      # Orbit side -- it imports brain modules and breaks when their types drift
npm run lint                    # eslint
npm run format                  # prettier --write
```

A husky pre-commit hook runs prettier and eslint over staged files, so
formatting mostly takes care of itself.

> **Install `app/` deps before running root `npm test`.**
> `tests/agent-manager.test.ts` imports through `app/src/main/agent.ts` into
> `electron`, which only lives in `app/node_modules`. Without it you get an
> unhelpful `ERR_MODULE_NOT_FOUND`.

Before opening a PR, run what CI runs (see
[`.github/workflows/build.yml`](.github/workflows/build.yml), which does this on
Linux, macOS, and Windows):

```bash
npm run check:versions        # root and app/ must resolve the same pi version
npm run typecheck
npm run check:skills          # extensions/loom/vendor/ is generated -- this catches hand-edits
cd app && npx tsc --noEmit && cd ..
npm test
npm run smoke:pack            # packs the tarball and installs it WITHOUT the lockfile
```

That last one reaches the network on purpose. It resolves dependencies the way
a user's `npm i -g` does rather than the way our pinned tree does, and it has
caught real breakage that every lockfile-pinned check sailed past.

## Tests passing is not the same as it working

A green suite does not tell you a status pill rendered, a toast fired, or a
notebook round-tripped. Three runbooks cover the gap:

- [`docs/browser-validation.md`](docs/browser-validation.md) -- driving the web
  shell with `agent-browser` to get actual eyes on a renderer or shell-event
  change, including how to force a failure path.
- [`docs/terminal-validation.md`](docs/terminal-validation.md) -- the CLI and
  extension runtime path, without launching Orbit.
- [`docs/live-validation-checklist.md`](docs/live-validation-checklist.md) --
  end-to-end product runtime against a real Galaxy.

There are also end-to-end Playwright tests (`cd app && npm run test:e2e`) and
model-in-the-loop scenario evals (`npm run evals`, see
[`evals/README.md`](evals/README.md)) that spawn a real Loom against fixture
directories and assert on the JSON event stream.

## Where things live

| Path               | What it is                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `extensions/loom/` | The brain -- system-prompt context, Galaxy invocation tracking, skills, slash commands, session lifecycle |
| `app/`             | Orbit, the Electron shell (`src/main/`, `src/renderer/`)                                                  |
| `web/`             | Browser shell and dev server with HMR                                                                     |
| `bin/loom.js`      | CLI entry point                                                                                           |
| `shared/`          | Contracts crossing the brain/shell boundary -- committed JS + `.d.ts`                                     |
| `tests/`           | Vitest suite for brain, shell, and shared code                                                            |
| `evals/`           | Scenario evals that run a real model                                                                      |
| `docs/`            | Architecture, validation runbooks, agent guidance                                                         |

Four conventions worth knowing before you move code around:

- **The brain stays shell-neutral.** Orbit- or web-specific behavior belongs in
  the shell, not in `extensions/loom/`.
- **Orbit stays a shell**, not a second brain.
- **Cross-boundary contracts go in `shared/`**, not duplicated payload logic on
  each side.
- **`extensions/loom/vendor/` is generated.** Edit
  `scripts/skills.manifest.json` and run `npm run sync:skills`.

## Sending a pull request

Fork, branch, and open a PR against `main` on
[`galaxyproject/loom`](https://github.com/galaxyproject/loom). Keep commits
focused -- one logical change each. CI runs the full check sequence on all three
platforms and packages the Electron app; a red run there is usually something
real, with the occasional exception of `smoke:pack` going red because a
dependency published something broken.

Say in the PR description how you verified the change, and be specific about
what you _didn't_ verify. "Tests pass, not live-eyeballed in Orbit" is a
genuinely useful sentence and saves a reviewer the guess.

## Further reading

- [`README.md`](README.md) -- product and runtime overview, configuration,
  commands, tool reference
- [`docs/architecture.md`](docs/architecture.md) -- Loom, Orbit, shared
  contracts, session lifecycle
- [`AGENTS.md`](AGENTS.md) and [`docs/agent/`](docs/agent/) -- how the agent is
  instructed to behave: notebook schema, Galaxy routing, gotchas
- [`RELEASING.md`](RELEASING.md) -- how a release gets cut

Loom is MIT licensed. By contributing, you agree your work ships under the
same terms.
