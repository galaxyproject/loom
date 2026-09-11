# Tools and slash commands

## Tool reference

Loom registers a small set of tools at the extension layer:

| Category                     | Tools                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| GTN tutorials                | `gtn_search`, `gtn_fetch`                                                                       |
| Skills                       | `skills_fetch` (fetch SKILL.md / reference docs from configured repos)                          |
| Galaxy invocations           | `galaxy_invocation_record`, `galaxy_invocation_check_all`, `galaxy_invocation_check_one`        |
| Multi-agent (experimental)   | `team_dispatch` (gated by `LOOM_TEAM_DISPATCH=1`)                                               |
| Session index (experimental) | `chat_search`, `chat_session_context`, `chat_find_tool_calls` (gated by `LOOM_SESSION_INDEX=1`) |

Galaxy MCP (separately registered when credentials are present)
provides `galaxy_connect`, `galaxy_search_tools_by_name`,
`galaxy_run_tool`, `galaxy_invoke_workflow`, `galaxy_search_iwc`,
history/dataset operations, etc.

Pi built-ins (`bash`, `read_file`, `write_file`, `edit_file`, `glob`,
`grep`, `list_files`) are always available.

There are no `analysis_*` plan tools. Plans are markdown sections.

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
| `/compact [instructions]` | Compact the conversation to reclaim context; optional summary steer (Orbit defaults to a notebook-aware summary; terminal CLI uses pi's built-in) |

`/override` is the user's, not yours. Bare `/override` lists the plan
steps the evidence gate is currently holding and the anchor to address
each one by. A clearance covers one step and the invocation that was in
flight when it was granted, and is spent by the next write it lets
through.
