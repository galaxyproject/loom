# Tools and slash commands

## Tool reference

Loom registers a small set of tools at the extension layer:

| Category                     | Tools                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| GTN tutorials                | `gtn_search`, `gtn_fetch`                                                                       |
| Skills                       | `skills_fetch` (fetch SKILL.md / reference docs from configured repos)                          |
| Saved MCP output             | `mcp_read_output` (search/page a response already saved by the MCP adapter)                     |
| Galaxy invocations           | `galaxy_invocation_record`, `galaxy_invocation_check_all`, `galaxy_invocation_check_one`        |
| Dashboard                    | `dashboard_read`, `dashboard_update`                                                            |
| Multi-agent (experimental)   | `team_dispatch` (gated by `LOOM_TEAM_DISPATCH=1`)                                               |
| Session index (experimental) | `chat_search`, `chat_session_context`, `chat_find_tool_calls` (gated by `LOOM_SESSION_INDEX=1`) |

Galaxy MCP (separately registered when credentials are present)
provides `galaxy_connect`, `galaxy_search_tools_by_name`,
`galaxy_run_tool`, `galaxy_invoke_workflow`, `galaxy_search_iwc`,
history/dataset operations, etc.

Pi built-ins (`bash`, `read_file`, `write_file`, `edit_file`, `glob`,
`grep`, `list_files`) are always available.

There are no `analysis_*` plan tools. Plans are markdown sections.

Oversized MCP responses get an automatic bounded preview. Use
`mcp_read_output` with the notice's `outputId` (or an older notice's saved
path) to search with a literal `query`, navigate via JSON `pointer`, or page
with `offset`/`limit`. Object previews explicitly omit large/nested values;
follow their pointers for exact fields. Text offsets count characters,
so single-line JSON does not trap the reader at a line-size limit.
Only adapter artifacts registered on the current session branch are readable,
including after resume. Inspection is capped at 32 MB per file; pages are
bounded and known secret values are redacted. Temporary files can expire:
repeat only a narrower read-only lookup, never a submission just to recover
its output.

For installed tools, use `galaxy_search_tools_by_name` (name, ID, description)
and inspect candidate schemas. Loom blocks the catalog-wide
`search_tools_by_keywords` schema fan-out before dispatch. Input-datatype-only
matches still require schema inspection; a name search does not prove absence.
Timeouts receive agent-facing recovery guidance. Identical timed-out reads are
held until one verified adapter reconnect permits a retry; a successful read
allows later polling again. Submissions have unknown outcomes after a timeout
and require Galaxy-state inspection before any retry. The harness does not
automatically replay mutations.

Running/queued dataset and job metadata responses direct the agent to record the
run and yield to the background monitor. The monitor checks every 15 seconds
without model calls. As a fallback, repeated metadata checks of an unfinished
resource wait in the harness for two minutes; Stop cancels the
wait, and a new user request may ask for a fresh check immediately. Terminal
outputs remain available for immediate verification. While an agent turn is
active, Loom emits a factual progress notification about once a minute if the
assistant has been silent. Orbit displays these in the main chat; they do not
consume model tokens. These updates do not imply that scientific results passed
verification or that a background LLM worker has been started.

Large user-defined tool lists are shown as compact catalogs with names, versions,
Galaxy IDs/UUIDs, containers, and active/hidden flags. Full embedded scripts and
schemas stay in the saved MCP response. `mcp_read_output` searches catalog
metadata and pages the records; a returned `definitionPointer` selects the
chosen tool's full definition. The catalog reports both response size and source
pagination, so a partial page never establishes that no other tools exist.
Saving a large response is normal output handling, not a model context failure.

## Slash commands

| Command                   | What it does                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/notebook`               | View current notebook content                                                                                                                     |
| `/status`                 | Galaxy connection + notebook path summary                                                                                                         |
| `/instructions`           | Show the `LOOM.md` standing instructions loaded this session; `init` / `init project` creates one                                                 |
| `/connect [name]`         | Connect to Galaxy (prompts for credentials, or switches profile)                                                                                  |
| `/profiles`               | List saved Galaxy server profiles                                                                                                                 |
| `/execute` (alias `/run`) | Tell the agent to run the next pending step in the latest plan section                                                                            |
| `/override <step> <why>`  | User-only. Clear the evidence gate for one plan step, once, with the reason recorded                                                              |
| `/dashboard [sub]`        | Show the dashboard layout; `preset <name>`, `reset`, `undo` change it. User-only                                                                  |
| `/compact [instructions]` | Compact the conversation to reclaim context; optional summary steer (Orbit defaults to a notebook-aware summary; terminal CLI uses pi's built-in) |

`/override` is the user's, not yours. Bare `/override` lists the plan
steps the evidence gate is currently holding and the anchor to address
each one by. A clearance covers one step and the invocation that was in
flight when it was granted, and is spent by the next write it lets
through.

## The dashboard

The dashboard is the panel layout the researcher sees beside the chat, stored as
`.loom-dashboard.json` in the analysis directory and validated by
`shared/dashboard-contract`. Writing that file is how a layout change reaches a
shell; there is no separate message for it, and in the terminal the write simply
happens with no pane attached.

- `dashboard_read` returns the named dashboards, their panels, which one is on
  screen, and the widget types this build can draw. Read before you write, so
  you use real panel ids.
- `dashboard_update` changes it, either with `actions` (add, remove, update,
  move a panel; create or switch a dashboard) or by replacing the whole document.
  `reason` is required and is recorded on each panel you touch.

Two rules, and they are not negotiable:

1. **Only when the user asks.** Do not add, remove or rearrange panels because a
   run started, because a step failed, or because you think a different view
   would suit them better. Say what you would change and let them ask for it.
2. **A panel the user placed or pinned is not yours.** Those writes are refused
   outright, whether you phrase them as an action or as a whole-document
   replace. Tell the user to change that one in the dashboard's own controls, or
   to type `/dashboard reset`.

`/dashboard` belongs to the user, not to you. It is deterministic, takes no
model turn, and is allowed to discard panels the tools may not -- including
`/dashboard undo`, which puts back whatever the last change replaced.
