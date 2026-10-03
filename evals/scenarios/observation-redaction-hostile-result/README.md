# observation-redaction-hostile-result

One fixture, replayed in the default `ask` shape -- the one that carries a
signature -- through the real build-and-check path.

The first line is a Galaxy tool error with a researcher's absolute path, a
project directory name, a 32-hex dataset id, a five-digit history number, a
dataset URL and an email address, all on one line -- the normalizer only ever
sees the first line, so putting them on separate lines would prove nothing.
The leak scan is staged: `<url>` and `<email>` first, then the client-side
shapes the later rewrites could hide (hosts, ports, addresses, UUIDs), then the
`<path>`/`<id>`/`<n>` rewrites and the full table over the result. Nothing on
this line survives the rewrites, so it passes, scrubbed.

The second line carries hostile _arguments_: `../../etc/passwd` as a tool id
and `C:/Users/bob` as a datatype. The empty `toolIds` and `datatypes` show the
allowlists dropped both.

Lines three and four repeat the first byte for byte, which takes that signature
to the retry-loop threshold: the loop is reported once, as `retry-loop`, and the
silent occurrence in between stays silent.

The fifth line is a clean failure. The sixth, `Connection to galaxyprod:12345
refused`, is the case the staging exists for: the `<n>` rewrite would turn the
port into `<n>` and hide the host. The early stage catches it, so the signature
is withheld (`signatureWithheld: host-port`) and the report keeps its structured
fields rather than being refused.

No `observation.built` row carries a signature -- it is written before anyone
has consented to anything -- so the exact signatures are pinned by
`tests/evals-scenarios.test.ts` over this same fixture. Nothing is sent: the
replay calls the build step, not the delivery path, so no `observation.sent`,
`observation.queued`, `observation.invalid`, `observation.declined` or
`observation.skipped` row may appear.
