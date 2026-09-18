# Templating: `$(...)` ECMAScript, not Cheetah

UDT commands and config files interpolate parameters with **sandboxed ECMAScript (JavaScript)
expressions inside `$(...)`**. This is the single biggest difference from classic XML tools, which
use Cheetah (`$param`, `#for#`, `#if#`). None of the Cheetah syntax works here.

The sandbox has **no access to the database, filesystem, or network** -- only the `inputs` object
and any helpers you add via a `javascript` requirement's `expression_lib`.

## Referencing inputs

| You want | Write |
|----------|-------|
| A scalar value (integer/float/text/boolean/select) | `$(inputs.count)` |
| A single data file's path | `$(inputs.reads.path)` |
| Multiple data files' paths, space-joined | `$(inputs.datasets.map(d => d.path).join(' '))` |
| A boolean turned into a flag | `$(inputs.trim ? '--trim' : '')` |
| A select value chosen into an option | `$(inputs.mode === 'fast' ? '-x' : '-y')` |

A `data` input is an **object** (a CWL-style File object, not a bare path string) -- you almost
always want `.path`. A `multiple: true` data input is an **array** of those objects; map over it.

```yaml
shell_command: |
  cat $(inputs.datasets.map((input) => input.path).join(' ')) > output.txt
```

## Quoting: scalar values are not auto-quoted

Galaxy substitutes `$(...)` expressions into `shell_command` as **raw text** -- unlike `base_command`
arguments, they are *not* run through `shlex.quote`. So a `text` or `select` value containing a
space, quote, `$`, or other shell metacharacter will break or alter the command (it is also an
injection vector if the value is attacker-controlled).

- **Quote interpolations defensively:** `'$(inputs.reads.path)'`, `'$(inputs.label)'`.
- **For free-form text you don't control, prefer a configfile** -- write the value into a JSON file
  and read it in the command, rather than inlining it (see Config files below).
- **`select` inputs with a fixed option list, and numeric `integer`/`float`, are safe to inline** --
  their values can't contain surprises.
- Data `.path` values are Galaxy-generated and normally clean, but quoting them costs nothing.

## Job resources: `$GALAXY_SLOTS` (a shell variable, not an expression)

The number of CPU cores allocated to the job is exposed as the **shell environment variable**
`$GALAXY_SLOTS` (and memory as `$GALAXY_MEMORY_MB`). Because it has no parentheses, it is **not** a
`$(...)` expression -- it passes through to the shell and expands at runtime. Request cores with a
`resource` requirement:

```yaml
requirements:
  - type: resource
    cores_min: 4
shell_command: |
  seqkit stats --threads $GALAXY_SLOTS '$(inputs.reads.path)' > stats.tsv
```

Use `$GALAXY_SLOTS` for "however many cores the job got" -- this is usually what a user means by
"number of threads." Expose an `integer` input only when the user needs explicit manual control.

**Pass it as the flag's value -- recording it is not using it.** The parallelism flag's argument
must *be* `$GALAXY_SLOTS` (`--threads $GALAXY_SLOTS`, `-@ $GALAXY_SLOTS`, `-p $GALAXY_SLOTS`).
Echoing it to a log, or storing it in a variable you never pass through, does nothing for
parallelism -- a command that prints `$GALAXY_SLOTS` "for debugging" but still runs `--threads 8`
is hardcoded and ignores the real allocation. Wiring it through and logging it are independent: do
the first; the second is optional.

```yaml
# WRONG -- "aware" of the allocation, but the flag is still hardcoded
shell_command: |
  echo "cores: $GALAXY_SLOTS"             # recorded...
  samtools sort -@ 8 -o out.bam in.bam    # ...but ignored -- only 8 threads regardless

# RIGHT -- the flag's value IS the allocation
shell_command: |
  samtools sort -@ $GALAXY_SLOTS -o out.bam in.bam
```

## Escaping: literal shell `$(...)` must be `\$(...)`

Galaxy intercepts `$(...)` as a JavaScript expression. If you need a **literal shell command
substitution** in your command, escape it so Galaxy passes it through:

```yaml
shell_command: |
  echo "Run on \$(date)" > log.txt          # \$(date) -> shell runs `date`
  echo "$(inputs.message)" >> log.txt        # $(inputs.message) -> Galaxy expands the input
```

A plain shell variable like `$GALAXY_SLOTS`, `$HOME`, or `$PWD` (no parentheses) needs **no**
escaping -- only the parenthesized `$(...)` form collides with the expression syntax.

## Helper functions via `expression_lib`

For logic too awkward to inline, add ECMAScript 5.1 functions in a `javascript` requirement and
call them inside `$(...)`:

```yaml
requirements:
  - type: javascript
    expression_lib:
      - |
        function pick(cond, a, b) { return cond ? a : b; }
shell_command: |
  tool $(pick(inputs.fast, '--fast', '--accurate')) '$(inputs.reads.path)' > out.txt
```

`expression_lib` and the `javascript` requirement are accepted by the UDT schema and wired up at
runtime, but they aren't covered by the official UDT docs -- confirm on your target server before
relying on them.

## Running a script

You have three ways to run script logic. Pick one and complete it fully -- a `shell_command` that
*names* a script file with nothing that creates it is the most common broken-but-lint-clean tool
(the file won't exist at runtime, and lint can't catch it).

**1. One-liner: inline it with `python -c` / `Rscript -e`.** Self-contained, nothing else to
declare; reference inputs directly:

```yaml
container: quay.io/biocontainers/pandas:2.1.1
shell_command: >-
  python -c "import pandas as pd; d = pd.read_csv('$(inputs.table.path)', sep='\t');
  d.describe().to_csv('summary.tsv', sep='\t')"
```

**2. A few lines: embed it with a quoted heredoc.** Reference inputs with `$(inputs.x)` inside.
Galaxy expands the `$(...)` expressions **before** the shell runs, so a quoted heredoc (`<<'PY'`)
is correct -- it stops the shell from re-expanding things, while Galaxy has already substituted the
inputs:

```yaml
container: python:3.11-slim          # an inline Python script needs only a base Python image
shell_command: |
  python <<'PY'
  import csv
  table = '$(inputs.table.path)'      # Galaxy substitutes the path before the shell sees this
  column = '$(inputs.column)'
  with open(table) as fh:
      rows = list(csv.DictReader(fh, delimiter='\t'))
  with open('out.txt', 'w') as out:
      out.write(str(len(rows)))
  PY
inputs:
  - { name: table, type: data }
  - { name: column, type: text }
outputs:
  - { name: out, type: data, format: txt, from_work_dir: out.txt }
```

Two reminders inside a heredoc: Galaxy still scans the whole `shell_command` for `$(inputs.X)`
references (so they count toward `dynamic_tool.undeclared_input_ref`), and a **literal** shell
command substitution like `$(date)` must still be escaped as `\$(date)`.

## Config files

`configfiles` content uses the same `$(...)` rules and is written to disk before the command runs:

```yaml
configfiles:
  - name: params
    filename: params.json
    content: |
      {"min_depth": $(inputs.min_dp), "input": "$(inputs.vcf.path)"}
    eval_engine: ecmascript
shell_command: |
  mytool --config params.json > out.txt
```

Input references inside a configfile count toward `dynamic_tool.undeclared_input_ref`, same as in
`shell_command`.

**3. Longer script: put it in a `configfiles` entry and run that file by name.** The file is
materialized in the working directory at `filename`, so `shell_command` runs it by that name:

```yaml
configfiles:
  - filename: script.py
    content: |
      import pandas as pd
      df = pd.read_csv("$(inputs.table.path)", sep="\t")
      df.describe().to_csv("summary.tsv", sep="\t")
shell_command: python script.py
```

> **CRITICAL:** if `shell_command` runs a script by name (`python script.py`), you **must** include
> a `configfiles` entry whose `filename` is exactly that name. `python script.py` with no configfile
> that creates it is broken -- the file won't exist at runtime, and neither lint nor `create_user_tool`
> will catch it. If you don't want a configfile, inline the script with `python -c` (option 1) instead.

**Don't interpolate a free-text input straight into script *source*.** Inlining `$(inputs.name)`
into Python/R code (heredoc or configfile) has the same problem as inlining it into `shell_command`:
a quote, backslash, or newline in a `text`/`select` value breaks the script or injects code. Data
`.path` values are Galaxy-generated and safe to inline; user-controlled text is not. For text, write
it to a JSON configfile with `$(JSON.stringify(inputs.name))` (which safely encodes any string) and
read it back as data in the script -- see `examples/08-configfile-script.yml`.
