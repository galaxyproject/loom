---
name: udt-authoring
description: "Use when authoring a Galaxy User-Defined Tool (UDT) -- a `class: GalaxyUserTool` YAML definition that wraps a container and command into a tool a non-admin user creates and runs (e.g. via Galaxy MCP create_user_tool / run_user_tool, or POST /api/unprivileged_tools). Not for classic XML/ToolShed tool wrappers."
metadata:
  surfaces: [loom]
version: 1.1.0
tags: [galaxy, tools, udt, user-defined-tools, custom-tool]
---

# Authoring Galaxy User-Defined Tools (UDTs)

A **User-Defined Tool (UDT)** is a tool that a regular (non-admin) Galaxy user defines in YAML
and runs unprivileged, introduced in Galaxy 25.0. It is declared with `class: GalaxyUserTool` and
validated against the `UserToolSource` schema. This skill is the reference for producing a correct,
lint-clean definition.

## When to Use

- The user wants to wrap a command + container as a runnable Galaxy tool they own.
- Triggers: "make me a Galaxy tool that runs X", "wrap this command as a UDT", "create a custom
  tool", "register a tool in my account".
- You are an external agent (Loom, an MCP client, a notebook) that will create/run the tool via
  `create_user_tool` / `run_user_tool` or `POST /api/unprivileged_tools`.

**When NOT to use:** classic XML / ToolShed tool wrappers (Cheetah templating, `tools-iuc`
submission) -- that is a different format; use the `tool-dev` skill instead. A UDT is **not** XML
and does **not** use Cheetah.

## Mental Model (read this first -- it is where agents go wrong)

A UDT = a **container** + a **`shell_command`** + typed **`inputs`** and **`outputs`**.

- The command lives under **`shell_command`** (NOT `command`).
- Parameters are interpolated with **sandboxed ECMAScript inside `$(...)`** -- NOT Cheetah `$x` and
  NOT `#for#` loops. A data file's path is `$(inputs.name.path)`; a scalar value is
  `$(inputs.name)`.
- The `$(...)` templating sandbox has **no database or filesystem access**. Every UDT **must run in
  a container** (`container:` is a required plain string); whether that container has network access
  is set by the Galaxy admin's job config, not by the tool.
- Every **dataset/collection** output must **claim a file** it produced via `from_work_dir` (one
  file) or `discover_datasets` (many) -- you do not write to a templated output path.
- Scalar `text`/`select` values interpolate into `shell_command` **unquoted** (unlike `base_command`
  args, which are `shlex.quote`d) -- a value with spaces or quotes breaks the command. Quote them,
  or pass free text via a configfile. See `references/templating.md`.

If you find yourself writing `command:`, `$param`, `#for#`, `truevalue:`, or `${on_string}`, stop
-- those are XML/Cheetah habits the schema rejects. See `references/common-mistakes.md`.

## Quick Reference -- minimal valid skeleton

```yaml
class: GalaxyUserTool          # required, exactly this
id: my-tool                    # lowercase, ^[a-z][a-z0-9_-]*$, 3-255 chars (recommended)
version: "0.1.0"               # required -- schema validation rejects a versionless tool
name: My Tool                  # required, min 5 chars
description: One line shown in the tool menu
container: quay.io/biocontainers/seqkit:2.8.2--h9ee0642_0   # required STRING, a real image
shell_command: |
  seqkit stats --tabular '$(inputs.input.path)' > stats.tsv
inputs:
  - name: input
    type: data
    format: fastq
    label: Input sequences
outputs:
  - name: report
    type: data
    format: tabular
    from_work_dir: stats.tsv        # claim the file the command wrote
    label: Sequence statistics
```

Full field list, input/output types, and validator rules: **`references/schema-reference.md`**.
Templating syntax (`$(inputs.x)`, arrays, `$GALAXY_SLOTS`, escaping): **`references/templating.md`**.

## Authoring Workflow

1. **Understand the command.** What binary runs, what inputs it consumes, what files it produces.
2. **Pick a real container** -- this is the #1 cause of runtime failure. Resolve a verified image
   with `recommend_biocontainer` (Galaxy MCP) or the `mulled-recommend` CLI rather than guessing;
   **never invent the `--<hash>_<build>` tag suffix** -- it is not predictable. For stdlib-only
   logic, use an official `python:3.x-slim` image and write the code inline. **Do not invent an
   image or flag you cannot verify** -- ask instead. See "Choosing a Container" below. Lint will
   *not* catch a bad image; the job simply fails to pull it.
3. **Draft the definition** using `references/schema-reference.md`. Reference each input as
   `$(inputs.name.path)` (data) or `$(inputs.name)` (scalar). Write outputs to fixed filenames and
   claim them with `from_work_dir` / `discover_datasets`. Always include a `help` block (convention
   -- see "Write a help block" below).
4. **Self-review** against `references/common-mistakes.md` (it doubles as a checklist).
5. **Validate** (see below) and iterate on real errors.
6. **Create + run.** Hand the validated definition to `create_user_tool`, then `run_user_tool`
   (this skill stops at a valid definition -- the run/invocation loop is the caller's job).

## Choosing a Container

The container is the part most likely to pass validation but fail at run time, because nothing in
the schema or lint checks that the image actually exists or pulls. A real example: a plotting UDT
that declared `quay.io/biocontainers/seaborn:0.13.2--pyhd8ed1ab_3` was accepted by
`create_user_tool`, then the job died with `manifest unknown` -- that exact build tag did not exist
on quay. Guard against it:

- **Resolve a verified image instead of guessing one -- do this first.** If a
  `recommend_biocontainer` tool is available (Galaxy MCP), call it with the conda packages your
  command needs -- e.g. `["samtools=1.17", "bwa"]` -- and use the `image` it returns. It's resolved
  and checked against quay.io rather than hallucinated, so it can't invent a nonexistent tag. A
  single package yields a single-package image; several yield a mulled-v2 image. The returned
  `match_quality` tells you whether the exact version matched (`exact_version`) or only the name did
  (`name_only`, newest tag used), and `verified` confirms the tag is actually built. Only auto-apply
  an `exact_version` result; if it comes back `name_only` and the exact version matters, review the
  substituted tag before using it. From a terminal,
  the same resolver is the **`mulled-recommend`** CLI in `galaxy-tool-util`:
  `mulled-recommend samtools=1.17`, `mulled-recommend --json "bwa,samtools"`.
- **If you must pick by hand, don't guess the biocontainers build suffix** (`--<hash>_<build>`). It
  is not derivable from the version. Look up the real tag: browse
  `https://quay.io/repository/biocontainers/<tool>?tab=tags` or query
  `https://quay.io/api/v1/repository/biocontainers/<tool>/tag/?onlyActiveTags=true`.
- **For a stdlib-only tool, skip biocontainers entirely.** Use an official base image like
  `python:3.11-slim` (or `busybox` for shell-only) and write the logic inline (see the heredoc
  pattern in `references/templating.md`). The seaborn failure above was fixed exactly this way:
  switch to `python:3.11-slim` and emit SVG with the standard library, no third-party image to get
  wrong. (A bare language image ships no third-party libraries -- `python:3.13` cannot `import
  pandas` -- so this is only for genuinely stdlib-only logic; otherwise resolve a package image
  above.)
- **Never invent an image, tag, or CLI flag you can't verify** -- resolve it (above) or ask the user
  rather than guessing.

## Write a `help` block (convention)

`help` is schema-optional, but **always include a real one**. Galaxy renders it under the parameter
form on the tool page, so a UDT without help is a black box to anyone -- including the same user
weeks later -- who opens it. The wire shape is an object, not a bare string:

```yaml
help:
  format: markdown        # markdown | restructuredtext | plain_text
  content: |
    Cuts a single column from a tab-separated file.

    **Inputs**
    - `input`: TSV file (with or without header).
    - `column`: 1-based column index.

    **Outputs**
    - `output`: TSV with only the selected column, in input row order.

    Header lines are not auto-detected; the column index applies to every row.
```

Three short paragraphs is enough: what the tool does, its inputs/outputs, and any caveat (resource
limits, expected file shape, non-obvious behavior). Don't ship a `TODO` placeholder -- an empty or
stub `help` is no better than none. If help genuinely isn't worth writing (a one-off throwaway), say
so and confirm with the user before creating the tool.

## Validating a Definition

Validation logic is pure Python in `galaxy-tool-util` -- the same code the server runs -- so you can
check offline before submitting. Three tiers, weakest to strongest:

1. **Local** (fast, offline, side-effect-free): `python scripts/validate.py my-tool.yml`. Needs
   `pip install 'galaxy-tool-util>=26.1'`. Catches structural errors, the four semantic validators, and
   lint warnings. Use this whenever a Python env is available (terminal, CI). See `scripts/`.
   **Version-sensitive:** the installed galaxy-tool-util *is* the schema, and the 26.1 behaviors this
   skill describes (data inputs rejecting `min`/`max`, a minimal `discover_datasets`,
   `--check-container`) need galaxy-tool-util **26.1+** -- so install
   `pip install 'galaxy-tool-util>=26.1'`. On an older install the same file validates against the
   older schema, which is a different answer, not a wrong one: if your target server is older, that
   *is* the schema you're writing against. Either way the server create (tier 3) is the final word.
2. **`planemo lint`** -- not available yet (planemo does not lint UDTs as of this writing). It
   already depends on `galaxy-tool-util`, so teaching it to lint a `GalaxyUserTool` YAML would be a
   small addition, and it's the natural future home for tier 1. Down the road `scripts/validate.py`
   should migrate to `planemo lint <tool>.yml`, so authors get this check through the standard Galaxy
   tool CLI instead of a bundled script. Until that lands, use tier 1.
3. **Server create** -- `create_user_tool` / `POST /api/unprivileged_tools` runs the same lint and
   confirms *this server* accepts it (needs `enable_beta_tool_formats` + the Custom Tool Execution
   role). This is the final word, and the practical gate for environments without Python (e.g.
   Loom): submit, then iterate on the returned errors.

> **Lint-clean is necessary but not sufficient.** Neither validate.py nor the server's create lint
> checks that the command actually succeeds. The one thing you *can* check ahead of time is the
> container: a nonexistent tag (`manifest unknown` at run time) is the most common real-world UDT
> failure, so resolve a verified image with `recommend_biocontainer` / `mulled-recommend` (see
> "Choosing a Container") -- or run `validate.py --check-container` to test the tag you already have.
> Beyond that, validation can't see runtime JS-expression errors, shell quoting, the server's
> role/config gates, or whether the command produces the declared outputs -- only running the tool
> does.

## Iterating & Cleanup

There is no in-place update API -- every `create_user_tool` call makes a **new** tool. When you
iterate, bump `version` (e.g. `0.1.0` -> `0.2.0`); Galaxy keeps every prior version under the user's
account. Heavy iteration accumulates stale versions, so once a design stabilizes, offer to deactivate
the superseded ones with `delete_user_tool` -- it marks the tool inactive (hidden from the toolbox),
not a hard delete; the records remain.

## Limitations

UDTs deliberately can't reach several things classic tools can (per the Galaxy docs):

- **No reference data** -- no built-in genome indexes or `.loc` files.
- **No metadata files** -- e.g. a BAM index (`.bai`) isn't available; if the command needs one, build
  it inside the `shell_command` or take it as an explicit `data` input.
- **No `extra_files` directory** -- composite / extra-file outputs aren't supported.

Design around these: pass whatever the tool needs as an explicit input, and generate any side files
inside the container.

## Common Patterns

| Goal | shell_command snippet |
|------|-----------------------|
| Single data file path | `tool '$(inputs.reads.path)'` |
| Scalar value | `tool --count $(inputs.count)` |
| Multiple data files | `cat $(inputs.datasets.map(d => d.path).join(' ')) > out.txt` |
| Boolean as a flag | `tool $(inputs.verbose ? '--verbose' : '')` |
| Use the job's allocated cores | `tool --threads $GALAXY_SLOTS` (+ a `resource` requirement, `cores_min`) |
| Capture one output file | declare output with `from_work_dir: out.txt` |
| Capture many outputs | declare output `type: collection` with `discover_datasets` |
| Run a non-trivial inline script | `python <<'PY'` ... `PY` heredoc; reference inputs as `$(inputs.x)` inside (see `references/templating.md`) |

See `examples/` for eight complete, validated UDTs spanning these patterns.

## Troubleshooting

| Symptom / error code | Cause | Fix |
|----------------------|-------|-----|
| `dynamic_tool.output_unclaimed` | Output has no `from_work_dir`/`discover_datasets` | Write to a fixed filename and claim it |
| `dynamic_tool.undeclared_input_ref` | `$(inputs.X)` with no input named `X` | Declare the input or fix the name |
| `dynamic_tool.blank_container` | `container` empty / missing | Set a real container image string |
| `string_pattern_mismatch` on `id` | Uppercase, leading digit, spaces | Use `^[a-z][a-z0-9_-]*$` |
| extra-field rejection | XML-ism like `truevalue`, `command`, `${on_string}` | Remove it -- schema is `extra="forbid"` |
| `manifest unknown` / `Unable to find image` at **run** time | Container tag doesn't exist on the registry | Resolve a verified image with `recommend_biocontainer` / `mulled-recommend` (or `python:3.x-slim` for stdlib tools) -- lint can't catch this |
| HTTP 403 "not allowed to run unprivileged" | The admin's job routing (TPV) rejects `tool_type_user_defined` by default | Not fixable client-side -- the admin must add a destination/routing rule for user-defined tools |
| `help` rejected at create | `help` sent as a bare string | Use the object form: `help: {format, content}` |

Full list with the why behind each: `references/common-mistakes.md`.

## Resources

- `references/schema-reference.md` -- every `UserToolSource` field, input/output types, validators
- `references/templating.md` -- the `$(...)` ECMAScript model, arrays, `$GALAXY_SLOTS`, escaping
- `references/common-mistakes.md` -- pre-submit self-review checklist
- `scripts/validate.py` -- offline validate + lint via `galaxy-tool-util`
- `examples/` -- eight complete UDTs, simple to complex (incl. inline-script and configfile-script `python:slim` tools)
- Galaxy docs: [User-Defined Tools](https://docs.galaxyproject.org/en/master/admin/user_defined_tools.html)
- For classic XML tools instead: the `tool-dev` skill.
