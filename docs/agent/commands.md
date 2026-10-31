# Tools and slash commands

## Tool reference

Orbit registers a small set of tools at the extension layer:

| Category                     | Tools                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| GTN tutorials                | `gtn_search`, `gtn_fetch`                                                                                                                           |
| Skills                       | `skills_fetch` (SKILL.md / reference docs; `repo: "orbit"` reads staging skills awaiting a permanent home, `repo: "foundry"` bundled Foundry casts) |
| Saved Galaxy output          | `galaxy_read_output` (search/page an oversized Galaxy response held for this session)                                                               |
| Saved MCP output             | `mcp_read_output` (search/page an oversized brc-analytics MCP response pi already saved)                                                            |
| Galaxy invocations           | `galaxy_invocation_record`, `galaxy_invocation_check_all`, `galaxy_invocation_check_one`                                                            |
| Dashboard                    | `dashboard_read`, `dashboard_update`                                                                                                                |
| Multi-agent (experimental)   | `team_dispatch` (gated by `ORBIT_TEAM_DISPATCH=1`)                                                                                                  |
| Session index (experimental) | `chat_search`, `chat_session_context`, `chat_find_tool_calls` (gated by `ORBIT_SESSION_INDEX=1`)                                                    |

The Galaxy tools run in-process through galaxy-ops and are always registered,
under the operations' own names: `search_tools_by_name`, `run_tool`,
`invoke_workflow`, `search_iwc_workflows`, history/dataset operations, etc.
There is no connect step; `/connect` stores the credentials they use.

Pi built-ins (`bash`, `read_file`, `write_file`, `edit_file`, `glob`,
`grep`, `list_files`) are always available.

There are no `analysis_*` plan tools. Plans are markdown sections.

Oversized responses get an automatic bounded preview, and two readers take
its `outputId`: `galaxy_read_output` for Galaxy responses and
`mcp_read_output` for brc-analytics responses, which go through pi's MCP
layer. Both search with a literal `query`, navigate via JSON `pointer`, or
page with `offset`/`limit`. Object previews explicitly omit large/nested
values; follow their pointers for exact fields. Text offsets count
characters, so single-line JSON does not trap the reader at a line-size
limit. Pages are bounded and known secret values are redacted.

Saved Galaxy outputs live in memory for the session only. `mcp_read_output`
also takes an older notice's saved path; only adapter artifacts registered on
the current session branch are readable, including after resume, and
inspection is capped at 32 MB per file. Either kind can be gone: repeat only
a narrower read-only lookup, never a submission just to recover its output.

For installed tools, use `search_tools_by_name` (name, ID, description)
and inspect candidate schemas. Orbit blocks the catalog-wide
`search_tools_by_keywords` schema fan-out before dispatch. Input-datatype-only
matches still require schema inspection; a name search does not prove absence.
Timeouts receive agent-facing recovery guidance. Identical timed-out reads are
held until some other Galaxy call succeeds, which permits one retry; a
successful read allows later polling again. Submissions have unknown outcomes after a timeout
and require Galaxy-state inspection before any retry. The harness does not
automatically replay mutations.

Running/queued dataset and job metadata responses direct the agent to record the
run and yield to the background monitor. The monitor checks every 15 seconds
without model calls. As a fallback, repeated metadata checks of an unfinished
resource wait in the harness for two minutes; Stop cancels the
wait, and a new user request may ask for a fresh check immediately. Terminal
outputs remain available for immediate verification. While an agent turn is
active, Orbit emits a factual progress notification about once a minute if the
assistant has been silent. Orbit displays these in the main chat; they do not
consume model tokens. These updates do not imply that scientific results passed
verification or that a background LLM worker has been started.

Large user-defined tool lists are shown as compact catalogs with names, versions,
Galaxy IDs/UUIDs, containers, and active/hidden flags. Full embedded scripts and
schemas stay in the saved Galaxy response. `galaxy_read_output` searches catalog
metadata and pages the records; a returned `definitionPointer` selects the
chosen tool's full definition. The catalog reports both response size and source
pagination, so a partial page never establishes that no other tools exist.
Saving a large response is normal output handling, not a model context failure.

## Slash commands

| Command                   | What it does                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/notebook`               | View current notebook content                                                                                                                         |
| `/status`                 | Galaxy connection + notebook path summary                                                                                                             |
| `/instructions`           | Show the `ORBIT.md` standing instructions loaded this session (a `LOOM.md` from before the rename is still read); `init` / `init project` creates one |
| `/connect [name]`         | Connect to Galaxy (prompts for credentials, or switches profile)                                                                                      |
| `/profiles`               | List saved Galaxy server profiles                                                                                                                     |
| `/execute` (alias `/run`) | Tell the agent to run the next pending step in the latest plan section                                                                                |
| `/reconcile`              | Check the bound Galaxy history against the notebook: record runs no block claims as unattributed, and fetch details for finished runs now             |
| `/override <step> <why>`  | User-only. Clear the evidence gate for one plan step, with the reason recorded (in the registry when the registry holds the step)                     |
| `/pending`                | List run proposals waiting for approval, and why each is waiting                                                                                      |
| `/approve <proposal-id>`  | User-only. Freeze a `loom_propose` proposal against Galaxy's template and record the approval                                                         |
| `/revoke <proposal-id>`   | User-only. Withdraw an approval                                                                                                                       |
| `/lessons [sub]`          | User-only. The switch for the whole lesson loop: `status`, `on` (asks once), `off`. Off by default; off means no lesson surfaces and no reporting     |
| `/observations [sub]`     | User-only. Show or change Galaxy-failure reporting: `status`, `mode <off\|ask\|auto>`, `sent`, `retract <id>`                                         |
| `/observe [note]`         | User-only. Report something that went wrong, as one generic line. The payload is shown before it is sent                                              |
| `/dashboard [sub]`        | Show the dashboard layout; `preset <name>`, `reset`, `undo` change it. User-only                                                                      |
| `/compact [instructions]` | Compact the conversation to reclaim context; optional summary steer (Orbit defaults to a notebook-aware summary; terminal CLI uses pi's built-in)     |

`/override` is the user's, not yours. Bare `/override` lists the plan
steps the evidence gate is currently holding and the anchor to address
each one by. On a step the registry holds, the clearance is an exception
recorded in the registry for the runs it was held for; a new run on the
step is held again. On the block path it covers one step and the
invocation that was in flight when it was granted, and is spent by the
next write it lets through.

`/approve` and `/revoke` are the user's too. Propose a run with
`loom_propose`, show the table it returns, and ask for `/approve
<proposal-id>`; you can't approve one yourself. With no dialog to confirm in, `/approve` shows the table and wants `--yes` before it records anything. An approval covers exactly
the Spec frozen at approval time, and only in the session that recorded it:
editing the proposal block afterwards revokes it, and after a restart it
comes back restored, not live, until the user approves it again.

`/lessons`, `/observations` and `/observe` are the user's, not yours. The
lesson loop is off until the user runs `/lessons on`; while it is off,
`lessons_search` and `lesson_propose` say so and nothing is reported. Once
on, reporting still starts `off` until they pick a mode. In `ask` the
signature and description are shown to the user in full and
sent only if they confirm; an error line that still looks identifying after
scrubbing is withheld and only the rest is offered. In `auto` no free text is sent at all -- only the
structured fields, never an error line or a description -- and `auto` runs
as `ask` until the user has confirmed its sample payload; `/observe` always
asks first, whatever the mode. Do not offer to file one
for them, do not ask them to switch the mode, and do not treat a tool
failure as a reason to bring it up.

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
