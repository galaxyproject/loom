# Common Mistakes & Pre-Submit Checklist

UDTs are modeled after XML tools, so the most common failures are XML/Cheetah habits leaking in,
plus a few schema-specific traps. Run through this before submitting.

## Checklist

- [ ] Command is under **`shell_command`**, not `command`.
- [ ] Parameters use **`$(inputs.x)`** / **`$(inputs.x.path)`**, not Cheetah `$x` or `#for#`.
- [ ] `container` is a **plain string** of a **real** image (verified biocontainer when possible).
- [ ] Every output has **`from_work_dir`** or **`discover_datasets`** (collections: `discover_datasets`).
- [ ] Outputs are captured by file (`from_work_dir`/`discover_datasets`); there is **no** `$(outputs.X.path)`.
- [ ] Every `$(inputs.X)` reference has a matching declared input named `X`.
- [ ] If `shell_command` runs a script by name (`python script.py`), a `configfiles` entry creates that exact filename -- otherwise inline it with `python -c` / `Rscript -e`.
- [ ] No `min`/`max` on a `data` input (it's already required; use `optional: true` to relax, `multiple: true` for a list).
- [ ] `id` matches `^[a-z][a-z0-9_-]*$`; `name` is at least 5 characters.
- [ ] No rejected fields: `truevalue`, `falsevalue`, `argument`, `parameter_type`, `${on_string}`, `${tool.name}`.
- [ ] Booleans become flags via a ternary, not `truevalue`/`falsevalue`.
- [ ] The parallelism flag's **value** is `$GALAXY_SLOTS` (+ a `resource` requirement), not a hardcoded number -- and not merely echoed to a log while the flag stays a literal.
- [ ] Optional parameters have sensible `value` defaults.
- [ ] Labels and description say what the tool actually does (not "Run the tool").
- [ ] A real `help` block is present (object form `{format, content}`, no `TODO` placeholder).
- [ ] Scalar `text`/`select` values are quoted in `shell_command` (or passed via a configfile) -- they interpolate unquoted.

## Mistakes table

| Mistake | Why it's wrong | Fix |
|---------|----------------|-----|
| `command: ...` | The field is `shell_command`; `command` is rejected (`extra="forbid"`). | Rename to `shell_command`. |
| `$threads`, `#for f in $files#` | Cheetah templating. UDTs use sandboxed ECMAScript. | `$(inputs.threads)`, `$(inputs.files.map(f => f.path).join(' '))`. |
| `'$(inputs.reads)'` for a data input | A data input is an object, not a path. | `'$(inputs.reads.path)'`. |
| `container: {type: docker, image: ...}` | `container` is a plain string. | `container: quay.io/biocontainers/...`. |
| Output written to `'$(inputs.out)'` / a templated output path | UDTs don't pass output paths in; the file is claimed afterward. | Write to a fixed filename, then `from_work_dir: that-file`. |
| `$(outputs.name.path)` in the command | There is no `outputs` object in the template namespace -- only `inputs`. | Write to a fixed filename and claim it with `from_work_dir`/`discover_datasets`. |
| `python script.py` with no `configfiles` entry named `script.py` | The file is never created in the working dir, so the command fails at runtime (lint won't catch it). | Add a `configfiles` entry whose `filename` is exactly `script.py`, or inline the code with `python -c`. |
| Output with neither `from_work_dir` nor `discover_datasets` | `dynamic_tool.output_unclaimed`. | Add one of them. |
| `$(inputs.foo)` but no input `foo` | `dynamic_tool.undeclared_input_ref`. | Declare `foo` or fix the typo. |
| `min: 1` / `max: N` on a `data` input | Dropped from the schema in 26.1 (`extra="forbid"` rejects them); authors used `min: 1` to mean "required," but data inputs already are. | Remove them. Data inputs are required by default (`optional: true` to relax); use `multiple: true` to accept several. |
| `truevalue: --x` / `falsevalue: ""` on a boolean | XML-only fields, rejected. | `value: false` + `$(inputs.x ? '--x' : '')` in the command. |
| `${on_string}`, `${tool.name}` in labels | Cheetah macros; not supported. | Use a plain string label, or `format_source` to inherit. |
| `id: My_Tool` / `id: 2pass` | Must be lowercase and start with a letter (`string_pattern_mismatch`). | `id: my-tool`, `id: two-pass`. |
| Hardcoded `--threads 8` -- even while echoing `$GALAXY_SLOTS` elsewhere | Ignores the job's real allocation; recording the value isn't using it. | Make the flag's value `$GALAXY_SLOTS` (`--threads $GALAXY_SLOTS`) + `resource` `cores_min`. |
| `container: ubuntu:latest` for a bioinformatics tool | Generic image won't have the binary; not reproducible. | Use the tool's biocontainer. |
| Invented image/tag/flags | A guessed container or CLI flag fails at runtime. | Use only images/flags you can verify; otherwise ask. |
| Unescaped literal `$(date)` in the command | Galaxy treats `$(...)` as an expression and errors/misfires. | Escape it: `\$(date)`. |
| `help` omitted, a bare string, or a `TODO` stub | Galaxy wants `{format, content}`; an empty/missing help leaves a documentation-free black box on the tool page. | Write a real help block: 3 short paragraphs (what / inputs+outputs / caveats). |
| Free-text scalar inlined unquoted in `shell_command` | `$(inputs.x)` for `text`/`select` interpolates raw (no `shlex.quote`); spaces/quotes break or inject into the command. | Quote it (`'$(inputs.x)'`) or pass free text via a configfile; fixed `select`/numeric values are safe. |

## Verifying a container (the #1 runtime failure)

A wrong container is the most common way a UDT passes validation and then fails at run time --
schema/lint never check that the image exists. Real case: a plotting UDT declared
`quay.io/biocontainers/seaborn:0.13.2--pyhd8ed1ab_3`, was accepted by `create_user_tool`, and the
job died with `manifest unknown` because that exact build tag didn't exist on quay.

- **Resolve a verified image instead of guessing.** Call `recommend_biocontainer` (Galaxy MCP) with
  the conda packages (`["samtools=1.17", "bwa"]`) and use the `image` it returns, or run
  `mulled-recommend samtools=1.17` in a terminal -- both check quay.io rather than hallucinating.
- **Never guess the biocontainers build suffix** (`--<hash>_<build>`) -- it isn't derivable from the
  version number. Look it up: browse `https://quay.io/repository/biocontainers/<tool>?tab=tags` or
  query `https://quay.io/api/v1/repository/biocontainers/<tool>/tag/?onlyActiveTags=true`.
- **Stdlib-only tool? Skip biocontainers.** Use `python:3.x-slim` (or `busybox` for shell-only) and
  write the logic inline -- there's no third-party tag to get wrong. The seaborn failure above was
  fixed precisely this way: switch to `python:3.11-slim` and emit SVG with the standard library.
- **A clean `validate.py` does not mean the image pulls.** Lint validates the YAML, not the
  registry. Verify the image separately -- `validate.py --check-container`, `recommend_biocontainer`,
  or `mulled-recommend` -- or let the server-create + first run confirm it.

## Clarity pass (what a deterministic validator can't catch)

The schema accepts plenty of unhelpful-but-valid tools. Before finishing, also check:

- `description` states what the tool does, specifically.
- Non-obvious inputs have `help` text; `label`s aren't just the parameter name repeated.
- Common, useful options for the wrapped tool are exposed (e.g. a threads input for an aligner).
- Defaults are sensible so a user can run it without filling in everything.
