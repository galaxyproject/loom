// Galaxy tool names the observation allowlist carries beyond galaxy-ops'
// allOperations. These are the Python galaxy-mcp server's names that galaxy-ops
// has no operation for -- its connect tool and the three meta-tools of its code
// discovery mode. The desktop still reaches Galaxy through that server by
// default, so dropping them would silently strip its observations of these
// calls. 2e retires the Python server and empties this list.
//
// Shared by scripts/gen-observation-allowlists.mjs and the test that checks the
// generated list against the installed galaxy-ops.
export const GALAXY_ALLOWLIST_EXTRA_NAMES = Object.freeze([
  "connect",
  "search",
  "get_schemas",
  "run_galaxy_tool",
]);
