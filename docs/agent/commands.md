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
exposes a **code-mode** surface: three meta-tools -- `search`,
`get_schema`, `run_galaxy_tool` -- that collapse ~40 named tools into
a compact catalog. Discover with `search`, fetch schemas with
`get_schema`, invoke with `run_galaxy_tool({ name, args })`. Underlying
tool names (`get_histories`, `run_tool`, `invoke_workflow`,
`search_iwc_workflows`, `create_user_tool`, etc.) are dispatched by
name. Opt back into the legacy named-tool surface by setting
`galaxy.discoveryMode` to `"full"` in `~/.loom/config.json` (see
`gotchas.md`).

Pi built-ins (`bash`, `read_file`, `write_file`, `edit_file`, `glob`,
`grep`, `list_files`) are always available.

There are no `analysis_*` plan tools. Plans are markdown sections.

## Slash commands

| Command                   | What it does                                                           |
| ------------------------- | ---------------------------------------------------------------------- |
| `/notebook`               | View current notebook content                                          |
| `/status`                 | Galaxy connection + notebook path summary                              |
| `/connect [name]`         | Connect to Galaxy (prompts for credentials, or switches profile)       |
| `/profiles`               | List saved Galaxy server profiles                                      |
| `/execute` (alias `/run`) | Tell the agent to run the next pending step in the latest plan section |
