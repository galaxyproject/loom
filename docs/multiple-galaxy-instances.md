# Multiple Galaxy instances and Run elsewhere

Orbit can keep several named Galaxy server/account profiles connected at once.
Open **Preferences → Galaxy connections**, select or add a profile, and enter
its URL and API key. The checkbox chooses the default for new work. Save
restarts the brain. Removing a profile pauses monitoring of its runs; it does
not move or delete them. Re-enter the key when changing a profile's server URL.
Connection names are persistent identifiers: add a new profile to rename a connection.

In the CLI, configure the same profiles in `~/.loom/config.json`, or use `/connect`.
Encrypted keys can only be decrypted by Orbit; the CLI accepts plaintext profile
keys or the existing default `GALAXY_URL` / `GALAXY_API_KEY` environment variables.

```json
{
  "galaxy": {
    "active": "us",
    "profiles": {
      "us": { "url": "https://usegalaxy.org", "apiKey": "YOUR_US_KEY" },
      "eu": { "url": "https://usegalaxy.eu", "apiKey": "YOUR_EU_KEY" }
    }
  }
}
```

`galaxy_connections` reports verified accounts and available MCP namespaces.
The default profile uses `mcp__galaxy__…`; other profiles use
`mcp__galaxy_<connection-id>__…`. Loom-native `galaxy_*` tools accept `server_id`.
Use the recorded connection when inspecting existing resources: job, invocation,
history and dataset IDs are scoped to a server and account. Two servers may
return identical IDs. Switching the default never rebinds an existing run.

## Run a queued or failed job elsewhere

1. In **Activity**, choose **Run elsewhere…** on a recorded job or invocation.
2. Select a destination. Loom checks account identity, exact tool versions,
   workflow/UDT definitions, readable inputs and quota before transferring data.
3. Review the accounts, parameters, transfer volume and original-attempt policy.
   By default, destination preparation finishes first, then Loom requests and
   confirms source cancellation before submitting. Keeping both runs active
   requires an explicit overlap choice.
4. Approve the reroute. A new destination history receives only the required
   inputs. Private datasets stream through temporary local storage and an
   authenticated TUS upload; destination bytes are checked with SHA-256.
   Datatype, genome metadata, collection nesting, element order and pairing
   are checked too. Temporary relay files are removed on success or failure.
5. Activity keeps both attempts and links the original to its replacement.
   If the source completes during preparation, Loom stops before submission.
   Replacement outputs still require verification before downstream use.

The same human command is available in the terminal:

```text
/reroute {"kind":"job","id":"ACTUAL_JOB_ID","source":"us"}
/reroute {"kind":"invocation","id":"ACTUAL_INVOCATION_ID","source":"us"}
/reroute status REROUTE_ID
/reroute cancel REROUTE_ID
```

Cancellation stops local staging. A dispatch already accepted remotely remains
recorded; inspect it before cancelling any remote work. Interrupted staging is
never replayed automatically. An interrupted pre-dispatch transaction can be
cancelled by ID and then prepared again after reviewing its destination history.

## Lost responses and restart recovery

A dispatch reservation is persisted **before** submission. If the response is
lost, its phase remains `submission_unknown`, even across restart or a change of
default. A second submission is refused. Inspect the recorded destination history,
then supply its actual run ID:

```text
/reroute reconcile REROUTE_ID DESTINATION_RUN_ID
```

This checks destination account, history, target/version and reconstructed inputs
against the frozen dispatch. It restores the notebook receipt without sending
another submission. An already recorded receipt can be restored with only the
reroute ID. An absent, ambiguous or mismatched receipt stays unresolved. Recovery
of mapped jobs whose individual inputs differ from the original collection needs
manual investigation; do not infer or retry their receipt.

## Current boundaries

- Manual reruns of individual installed-tool/UDT jobs and whole workflow invocations.
  A running process restarts its work; there is no automatic failover, portable
  checkpoint, or partial-workflow continuation.
- Built-in reference indexes and other selected dynamic choices are refused when
  their content cannot be established across servers. Supply explicit reference
  datasets. Matching dbkeys/index labels alone are insufficient.
- Library inputs must first be copied into a history. Composite datasets with
  extra files require an explicit export/import. Tools with bound external
  credentials and workflows with server-specific resource/object-store settings
  require destination preparation.
- The source must remain readable while inputs are copied. All private input
  bytes pass through local disk, requiring free space for the largest dataset;
  checksum verification also reads destination bytes. No public sharing is enabled.
- The existing signed registry records frozen preflight/dispatch details,
  transfer mappings and linked attempts. Typed notebook blocks carry origins,
  relationships and progress; notebook receipts retain checksum evidence.
  Superseded attempts cannot trigger downstream follow-ups or become eligible
  for handoff. Restored approvals and outputs retain the existing verification gates.

## Runtime boundaries

Loom owns routing, HTTP/MCP isolation, capture, polling, reconciliation, transfer
and submission. Orbit only edits profiles, displays records and forwards the
human command. Per-profile async contexts never swap global credentials during
concurrent work. Account checks fail closed when an origin disappears or changes.
Orbit sends decrypted profile keys to the brain over a private inherited pipe.
Each MCP child retrieves only its own key through a local capability broker;
keys do not appear in MCP configuration, notebook blocks, argv or upload URLs.

Verified with two independent local HTTP Galaxy fixtures, real TUS uploads,
checksum failures, lost receipts/restart, nested and paired collections, UDTs,
workflow cancellation, account changes, unreachable origins, and a packaged
Orbit interaction. Public Galaxy server integration still needs validation.
