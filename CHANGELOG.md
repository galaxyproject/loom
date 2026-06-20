# Changelog

Notable, user-facing changes to Loom and Orbit. Each release lists a short set of
highlights; the full commit-level notes live on the GitHub release pages. Add a
new `## [<version>] - <date>` block with a `### Highlights` list at release time.

## [0.5.1] - 2026-06-20

### Highlights

- Destructive Galaxy deletes now ask first: deleting or purging a history, dataset, or collection prompts for confirmation before anything is removed (and the web shell blocks it outright)
- Require the Galaxy MCP 1.9 server (up from 1.8): the agent can now work with Galaxy Pages -- creating, reading, and updating the notebook and report documents that pair an analysis with its narrative -- plus reliability fixes for workflow invocation and Galaxy auth
- The text-selection Copy button stays put within the chat panel instead of drifting into the sidebar on wide or scrollable messages

## [0.5.0] - 2026-06-19

### Highlights

- Orbit now runs on Windows as a remote-only desktop build, and a containerized `LOOM_MODE=remote` web shell brings Orbit to the browser
- Galaxy data and jobs move faster: jobs run in the background by default and notify you when they finish, large local files upload over a native resumable path (no more MCP timeouts), and remote data is fetched server-side by URL instead of round-tripping through your machine
- Galaxy connection state is now reflected live in the footer, reconnects when your credentials change, and surfaces the connected user plus a history panel even for env-driven sessions
- The skills router is generated from skill frontmatter tags instead of a hardcoded list, and surfaces the udt-authoring skill for writing Galaxy user-defined tools
- Stability and polish: Orbit no longer crashes when reopened, opaque "unknown error" provider messages are humanized (and a transient API failure now flags that the task was left incomplete), plus File-pane and chat fixes -- the Copy button stays put mid-stream, relative images and .tabular/fastq datatypes preview correctly, and the active analysis directory persists across restarts

## [0.4.1] - 2026-06-11

### Highlights

- Require the Galaxy MCP 1.8 server (up from 1.6): workflow runs now validate inputs against the tool's datatypes before submitting -- catching datatype and collection mismatches early -- with input templates and run guidance to go with them
- User-defined tools run again on Galaxy 26.0 servers

## [0.4.0] - 2026-06-11

### Highlights

- Export any conversation to Markdown, copy a single message, or select-and-copy straight from the chat
- A cold session can now discover and resume a Galaxy notebook, and Page sync round-trips through Galaxy-flavored Markdown
- Stuck "thinking" turns recover or abort cleanly, resumed sessions and single tool runs record their history correctly, and `--print` exits instead of hanging
- The terminal hides the model's thinking by default, `/cost` renders locally instead of billing the model, and `/tester-id` sets your tester ID without editing config
- Tighter safety: config.json API keys stay out of provider logs, out-of-workspace reads are gated, and retired models are gone from the picker

## [0.3.1] - 2026-06-04

### Highlights

- Connect any OpenAI-compatible model endpoint, with a one-click Jetstream preset
- Orbit shows how full the context window is, right in the footer
- Lower per-turn token use, plus `/compact` to trim conversation history on demand

## [0.3.0] - 2026-06-03

### Highlights

- Orbit updates itself in place on macOS; the CLI now tells you when a new version is out (and `loom update` to get it)
- Claude Opus 4.8 is available, with corrected pricing
- `/orbit` hands a running CLI session off to the Orbit desktop app

## [0.2.0] - 2026-06-02

### Highlights

- The agent's file writes are confined to your analysis directory by default, with an opt-in bash sandbox and a local-execution approval gate
- Send feedback straight from Orbit or with `/feedback`

## [0.1.1] - 2026-05-29

### Highlights

- Signed and notarized macOS builds
