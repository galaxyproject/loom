# Browser Validation

How to get actual eyes on a shell/UI change without a human at a desktop.

`docs/terminal-validation.md` covers the CLI path and
`docs/live-validation-checklist.md` covers the product runtime. This one covers
the gap that keeps biting: a change to Orbit's renderer, its status surfaces, or
the shell/brain event plumbing, where "the tests pass" is not the same claim as
"the thing renders". Several PRs have shipped with a "not live-eyeballed" caveat
because the desktop app is awkward to drive; it doesn't have to be.

## Why the web shell counts

`web/server.ts` serves the **same** renderer as Electron (`app/src/renderer/`),
bridged over a WebSocket instead of Electron IPC (`web/orbit-shim.ts` stands in
for the preload bridge). Anything the renderer draws -- chat cards, the footer
status pill, the activity pane, notebook rendering -- is the real thing, and a
browser is scriptable.

**What it proves:** renderer behavior, `shared/` modules, `bin/loom.js`, and the
shape of the events a shell sends.

**What it does not prove:** Electron main-process code (`app/src/main/`) and the
real preload bridge. `AgentManager` in particular is only exercised through unit
tests this way -- the web shell has its own spawn path in `server.ts`. Say so
when you report, rather than implying a desktop run.

It has also caught bugs that reading could not: the multi-argument event
payload bug in #439 was invisible in code review and obvious the moment a status
message rendered as `error,No LLM provider is configured, so the ag`.

## Setup

In a worktree, link the three dependency trees from the root checkout -- **all
three**, `web/` included, or `tsx` won't resolve express/ws:

```bash
ln -s /path/to/loom/node_modules      node_modules
ln -s /path/to/loom/app/node_modules  app/node_modules
ln -s /path/to/loom/web/node_modules  web/node_modules
```

> `.gitignore` has `node_modules/` with a trailing slash, which matches
> directories. These are **symlinks**, so they show up as untracked. Never
> `git add -A` in a worktree; stage explicitly.

## Isolate the config

The web server reads the same `~/.loom/config.json` as Orbit and the CLI, so
point `HOME` somewhere disposable rather than editing your own:

```bash
export SCRATCH=/tmp/loom-eyeball
mkdir -p "$SCRATCH/.loom" "$SCRATCH/.pi/agent"
```

`env -i` is worth it when testing a credential path -- an ambient
`ANTHROPIC_API_KEY` in your shell will otherwise satisfy the brain's preflight
and hide the case you're trying to see.

### Forcing a startup failure

A provider with no key makes the brain exit `EX_CONFIG` (78) on the first
WebSocket connection:

```bash
echo '{"llm":{"active":"anthropic","providers":{"anthropic":{}}}}' \
  > "$SCRATCH/.loom/config.json"
cd web && env -i PATH="$PATH" HOME="$SCRATCH" PORT=3939 npx tsx server.ts
```

### A working provider

The eval matrix's OpenAI-compatible models are the cheapest real LLM to test
against; put `PROXY_URL` / `PROXY_API_KEY` in `evals/.env` as `evals/README.md`
describes. Write a pi `models.json` into `$SCRATCH/.pi/agent/` naming the
provider (copy the shape from `writePiModelsConfig` in `evals/lib/matrix.ts`)
and a matching `llm.active` into `$SCRATCH/.loom/config.json`.

Keep the key out of files: pi interpolates a `$VAR` reference in `models.json`
at request time, so store `"apiKey": "$PROXY_API_KEY"` and pass the real value
in the server's environment.

## Drive it

```bash
agent-browser open http://127.0.0.1:3939
agent-browser snapshot -i                 # refs like @e3
agent-browser click @e3                   # e.g. dismiss the welcome modal
agent-browser fill @e20 "some prompt"
agent-browser press Enter
agent-browser screenshot --full /tmp/shot.png
```

Re-snapshot after anything that changes the DOM; refs are not stable across
navigations. Read the screenshot back -- the point is to look at it.

## Gotchas

- **The footer status pill is not a place to put a message.** It is
  width-capped, writes through `textContent` (newlines collapse to spaces), and
  for an `error` status its tooltip is overridden with "Click to open
  Preferences". Multi-line text belongs in the chat pane via an
  `agent:event` of `type: "error"`.
- **`agent:shell` has no listener.** `appendShellNote()` sends to it and nothing
  subscribes, in either shell.
- **Event ordering matters.** The renderer's chat-error handler resets the badge
  to a bare `error`, so a status message has to be sent _after_ the chat event
  or it gets clobbered.
- **First-run overlay.** With no credential configured the welcome modal covers
  the chat; dismiss it ("Skip -- set up later") before screenshotting.
- **A custom provider keyed from the environment** reads as "no API key" to the
  renderer, which masks config down to a `hasApiKey` boolean. Expect the
  onboarding hint to appear even when the provider works.
