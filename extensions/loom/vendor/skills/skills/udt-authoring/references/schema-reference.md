# UserToolSource Schema Reference

The canonical schema for a UDT is the `UserToolSource` Pydantic model in
`galaxy-tool-util` (`galaxy.tool_util_models`). It is `extra="forbid"`: **any unknown field is
rejected at parse time.** Field names below are exact.

When you submit via `create_user_tool` / `POST /api/unprivileged_tools`, the server validates this
full `UserToolSource`, so everything here applies. (Galaxy's *in-app* authoring agent targets a
slimmed view of the same model that drops the `tests` block to shrink its structured-output schema;
`tests` is optional either way and usually skipped for a first version.)

## Top-level fields

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `class` | **yes** | string | Must be exactly `GalaxyUserTool`. |
| `name` | **yes** | string | Display name; **min length 5**; not blank/whitespace. |
| `container` | **yes** | string | Container image, e.g. `quay.io/biocontainers/seqkit:2.8.2--h9ee0642_0`. A plain **string**, never a dict/list. Not blank. |
| `shell_command` | **yes** | string | Command with `$(...)` expressions. The field is `shell_command`, not `command`. |
| `id` | no (recommended) | string | Pattern `^[a-z][a-z0-9_-]*$`, length 3-255. Lowercase, starts with a letter; hyphens and underscores allowed. |
| `version` | **yes** | string | e.g. `"0.1.0"`. Required on 26.1+ -- a versionless tool fails schema validation with `version: Field required`. Not blank/whitespace; quote it so YAML doesn't read it as a number. |
| `description` | no | string | Short line in the tool menu. |
| `inputs` | no (default `[]`) | list | Input parameters (see below). |
| `outputs` | no (default `[]`) | list | Output definitions (see below). |
| `requirements` | no | list | `javascript` / `resource` / `container` requirements (see below). |
| `configfiles` | no | list | Files written before execution; content supports `$(...)`. |
| `citations` | no | list | `{type: doi|bibtex|reference, content: ...}`. DOIs/bibtex are validated. |
| `license` | no | string | SPDX identifier, e.g. `MIT`. |
| `help` | no (convention: yes) | object | `{format, content}`; `format` is `markdown`/`restructuredtext`/`plain_text`. Rendered under the tool form. Always include one -- see SKILL.md. |
| `tests` | no | list | In-tool tests (inputs/outputs). |
| `profile`, `edam_operations`, `edam_topics`, `xrefs` | no | -- | Metadata; rarely needed for a first version. |

## Input parameter types

Every input has `name` (required) and may have `label`, `help`, `optional` (default `false`).
Beyond those, each type supports:

| `type` | Extra supported fields |
|--------|------------------------|
| `boolean` | `value` (true/false). **No** `truevalue`/`falsevalue` -- turn it into a flag in `shell_command` with a ternary. |
| `integer` | `value` (default), `min`, `max`, `validators` (`in_range`) |
| `float` | `value`, `min`, `max`, `validators` (`in_range`) |
| `text` | `value`, `area` (bool), `validators` (`length`, `regex`, `empty_field`) |
| `select` | `options` (static, non-empty), `multiple`, `validators` (`no_options`) |
| `color` | `value` |
| `data` | `format` (string or list of datatypes), `multiple` |
| `data_collection` | `collection_type` (e.g. `list`, `paired`), `format` |

`select` options are a list of `{label, value, selected}`:

```yaml
- name: mode
  type: select
  options:
    - { label: Fast, value: fast, selected: true }
    - { label: Accurate, value: accurate, selected: false }
```

**Structural groups** (recurse into the leaf types above): `conditional` (has `test_parameter`
and `whens`), `repeat` (has `parameters`, `min`, `max`), `section` (has `parameters`).

**Rejected types** (exist in XML, not in UDT -- parse error): `hidden`, `drill_down`,
`data_column`, `genomebuild`, `group_tag`, `baseurl`, `rules`, `directory`. **Rejected fields on
any parameter:** `truevalue`, `falsevalue`, `argument`, `is_dynamic`, `hidden`, `parameter_type`.

**`min`/`max` on a `data` input are rejected** (dropped from the authoring schema in Galaxy 26.1).
They only ever meant the min/max *number of selected datasets* for a `multiple` input, and the
runtime rejects them on a single one. Authors reached for `min: 1` to mean "required" -- but a
`data` input is already required (add `optional: true` to make it *not* required). Use `multiple:
true` to accept a list; never add `min`/`max` to a data input. (`min`/`max` stay valid on
`integer`/`float`, where they bound the numeric value.)

## Output types

Every output has `name` and `type`. **A dataset output must declare `from_work_dir` OR
`discover_datasets`; a collection output must declare `discover_datasets`.** Omitting both is the
`dynamic_tool.output_unclaimed` error.

**Dataset output** (`type: data`):

| Field | Notes |
|-------|-------|
| `from_work_dir` | Relative path to the file your command wrote, e.g. `out.vcf`. |
| `format` | Datatype, e.g. `vcf`, `tabular`, `bam`. |
| `format_source` | Copy the format from a named input instead of hardcoding. |
| `metadata_source` | Copy metadata from a named input. |
| `label` | History display name. |
| `discover_datasets` | Alternative to `from_work_dir` for pattern-matched files. |

**Collection output** (`type: collection`): `collection_type` (`list`, `paired`, ...) plus
`discover_datasets` (required). Discovery is either a `pattern` or `tool_provided_metadata`. On
Galaxy 26.1+ every discovery field except the pattern has a sensible default, so a minimal entry
validates -- you only supply `pattern`:

```yaml
outputs:
  - name: parts
    type: collection
    collection_type: list
    discover_datasets:
      - pattern: 'part_(?P<designation>.+)\.txt'   # named groups: designation, ext, dbkey
```

Add a field only to override its default. The ones you'll actually reach for: `directory` (search
a subdir instead of the job root), `format`, `visible`, `recurse`, `sort_key` (`filename` | `name` |
`designation` | `dbkey`), `sort_comp` (`lexical` | `numeric`). That's the common subset, not the
full list -- `discover_via`, `match_relative_path`, `assign_primary_output` and `sort_reverse` are
also accepted; consult the model for the rest. The descriptor is `extra="forbid"`, so a mistyped key
(`patern`) or an XML-only one (`sort_by`, `dbkey`) is rejected, not silently ignored.

> **Server-version note.** The minimal one-field form needs Galaxy 26.1+; older servers required
> every field spelled out. To stay compatible with an older Galaxy, write the fully-specified form
> -- `discover_via: pattern` plus `directory`, `format`, `visible`, `recurse`,
> `match_relative_path`, `assign_primary_output`, `sort_key`, `sort_comp` alongside `pattern` --
> which still validates everywhere.

**Only `data` and `collection` outputs are usable.** They capture files into the history -- write
your result to a file and claim it. The scalar output types (`text`/`integer`/`float`/`boolean`) do
exist in the authoring model, and on 26.1 a named one validates without `hidden`, so `validate.py`
will pass a tool that declares one. It still won't *run*: the YAML tool parser accepts only `data`
and `collection` and raises `Unknown output_type [integer] encountered` on anything else. A clean
validation is not a green light here -- use `data` or `collection`.

## Requirements

Prefer the top-level `container:` field for the image -- it is required, and a `requirements:` entry
of `type: container` does **not** satisfy it. The `requirements` list is for:

```yaml
requirements:
  - type: resource          # request cores/ram; exposes $GALAXY_SLOTS at runtime
    cores_min: 4
  - type: javascript        # helper functions usable inside $(...)
    expression_lib:
      - |
        function basename(p) { return p.split('/').pop(); }
```

`resource` supports `cores_min`/`cores_max`, `ram_min`/`ram_max`, `tmpdir_*`, GPU fields, and
`timelimit`. A `container` requirement also exists but the top-level `container` field is the
idiomatic choice.

## The four semantic validators (stable error codes)

Beyond type/shape checks, `UserToolSource` runs these. Error `code`s are stable across releases:

| Code | Rule |
|------|------|
| `dynamic_tool.blank_string` | `name` and `version` must not be empty/whitespace. |
| `dynamic_tool.blank_container` | `container` must not be empty/whitespace. |
| `dynamic_tool.undeclared_input_ref` | Every `inputs.X` referenced in `shell_command` or a configfile must be a declared input. References resolve against the **top-level** name (a conditional's `inputs.cond.test_parameter` resolves via `cond`). |
| `dynamic_tool.output_unclaimed` | Each dataset output needs `from_work_dir` or `discover_datasets`; each collection output needs `discover_datasets`. |

`id` violations surface as Pydantic's `string_pattern_mismatch`; a too-short `name` as
`string_too_short`.
