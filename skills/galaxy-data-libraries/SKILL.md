---
name: galaxy-data-libraries
description: Use when data lives in a Galaxy data library rather than a history (a named library, or a folder id starting with F) -- walk folders, get dataset ids, run tools on library datasets in place, import only when needed.
metadata:
  surfaces: [loom]
  # Staging in Orbit; this is where it should end up.
  proposed_home: galaxy-skills
user_invocable: true
---

# Galaxy Data Libraries

A data library is a server-side folder tree an admin or project has published: reference data,
challenge data, a consortium's release. The files are already on the server, often in large
numbers, and nobody should upload or download them to use them. This skill is how to find them and
hand them to tools without copying.

## Which tool does what

galaxy-ops has no library operations yet, so **listing** uses the REST API through `bash` + `curl`.
Everything after that goes through the normal in-process tools:

| Step                                    | How                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| List libraries, walk folders, find ids  | `curl` (below)                                                                    |
| Run a tool on a library dataset         | `run_tool` with `{"src": "ldda", "id": ...}`                                      |
| Bring a dataset into a history          | `curl` POST (below), then the usual history tools                                 |
| Look at a dataset, run a workflow on it | Import it first, then `get_dataset_details` / `invoke_workflow` with `src: "hda"` |

If this shell has no `bash`, stop and tell the user: they can browse the library in the Galaxy UI
(Libraries in the top menu) and import what they need into a history, and you take it from there.

## curl conventions

```bash
curl -s -H "x-api-key: $GALAXY_API_KEY" "$GALAXY_URL/api/libraries"
```

- Use `$GALAXY_URL` and `$GALAXY_API_KEY` from the environment. Never paste the key into a command,
  the notebook or chat.
- Public libraries also answer without the key; restricted ones need it. When a library the user
  can see in the UI comes back missing or 403, the key is the first suspect.
- Use `jq` to print only the fields you need; folder listings are verbose. Without `jq`, save the
  response with `-o` and read the file with `python3`. Never pipe `curl` into `python3` (or any
  interpreter): Orbit's command guard refuses that outright, whatever the approval mode.

## Ids: the part that goes wrong

| Thing                             | Looks like         | Where it comes from                               |
| --------------------------------- | ------------------ | ------------------------------------------------- |
| Library                           | 16 hex chars       | `GET /api/libraries` -> `id`                      |
| Folder                            | `F` + 16 hex chars | library `root_folder_id`, or a folder item's `id` |
| Library dataset (`ld`)            | 16 hex chars       | a file item's `id`                                |
| Library dataset instance (`ldda`) | 16 hex chars       | a file item's `ldda_id`                           |

A file in a folder listing has **two** ids. They are often equal, but they are different objects and
can differ, so always take the one the consumer asks for:

- `run_tool` inputs want the **`ldda_id`**: `{"src": "ldda", "id": "<ldda_id>"}`.
- Importing into a history wants the **`id`** (the `ld`).

The folder endpoint needs the `F`. Without it Galaxy answers "Invalid library folder ID".

## Walk a library

```bash
# Libraries, with the folder to start from
curl -s -H "x-api-key: $GALAXY_API_KEY" "$GALAXY_URL/api/libraries" \
  | jq -r '.[] | [.id, .root_folder_id, .name] | @tsv'

# The same without jq: save it, then read the file
curl -s -H "x-api-key: $GALAXY_API_KEY" "$GALAXY_URL/api/libraries" -o libraries.json
python3 -c 'import json; [print(l["id"], l["root_folder_id"], l["name"]) for l in json.load(open("libraries.json"))]'

# One folder's contents
curl -s -H "x-api-key: $GALAXY_API_KEY" \
  "$GALAXY_URL/api/folders/F0123456789abcdef/contents?limit=100&offset=0"
```

The folder response is `{"metadata": {...}, "folder_contents": [...]}`:

- Each item has `type` (`"folder"` or `"file"`), `name` and `id`. File items also carry `ldda_id`,
  `file_ext`, `file_size` (human-readable), `raw_size` (bytes) and `state`.
- `metadata.total_rows` is the true count. **The default page is only 10 items**, so a folder that
  looks like it holds 10 files may hold hundreds. Pass `limit`, and page with `offset` until you
  have `total_rows`.
- `search_text=<substring>` filters by name on the server. Use it rather than paging through a
  folder of hundreds of files to find one.
- `metadata.full_path` gives the breadcrumb of `[folder_id, name]` pairs back to the library root.

Walk only as deep as the question needs. A large library can have thousands of files, so summarise
what you find (counts per folder, a few example names) rather than listing everything.

## Use a dataset in place

```text
run_tool({
  "toolId": "Show beginning1",
  "historyId": "<history id>",
  "inputs": {"input": {"src": "ldda", "id": "<ldda_id>"}, "lineNum": 10}
})
```

Galaxy adds the library dataset to the target history as a new item, without copying the bytes,
and the job's output lands after it. Expect one extra history item per library input. That is
normal, not a duplicate upload.

**Several library datasets into one `multiple: true` input:** wrap the list, as in
`{"tars": {"values": [{"src": "ldda", "id": "..."}, {"src": "ldda", "id": "..."}]}}` for an input
named `tars` (use the tool's own input name). A bare list
of `ldda` references is rejected before any job is created, with `'LibraryDatasetDatasetAssociation'
object has no attribute 'auto_propagated_tags'`. Bare lists of `hda` references are fine, so
importing first also works.

**Workflows:** Galaxy accepts `ldda` inputs to a workflow, but `invoke_workflow`'s input check only
accepts `hda`/`hdca` and rejects the run. Import the dataset into the history first (below) and pass
the resulting `hda`.

## Import into a history

Import when a workflow needs the dataset, when the user wants it in the history, or before
`get_dataset_details`, which reads history datasets:

```bash
# One dataset: content is the file item's `id` (the ld), not its ldda_id
curl -s -X POST -H "x-api-key: $GALAXY_API_KEY" -H "Content-Type: application/json" \
  -d '{"type": "dataset", "source": "library", "content": "<ld id>"}' \
  "$GALAXY_URL/api/histories/<history id>/contents"

# A whole folder, recursively: content is the F-prefixed folder id
curl -s -X POST -H "x-api-key: $GALAXY_API_KEY" -H "Content-Type: application/json" \
  -d '{"type": "dataset", "source": "library_folder", "content": "F0123456789abcdef"}' \
  "$GALAXY_URL/api/histories/<history id>/contents"
```

Check the `name` in the response matches the file you meant. A mixed-up id is not always an
error (see Troubleshooting).

An import links the existing dataset, so it is instant and its state is `ok` at once, whatever the
size. It costs no quota or disk. It does add history items, though: importing a folder of hundreds of
files makes a history nobody can navigate. Import the few files a step needs, and confirm with the
user before importing a whole folder.

## Large files

Library datasets are often big: a 40 MB manifest, multi-gigabyte archives. Don't pull one into the
conversation.

- **Tables and manifests:** import, then `get_dataset_details` for a preview, or run Galaxy tools
  (Select first, Cut, Filter, Count, Group) to summarise them. The summary lands in the history, and
  that is the record.
- **Archives and images:** run tools on them in place. Never download them locally.

## Troubleshooting

| Symptom                                                                             | Likely cause                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library missing from `/api/libraries`, or 403 on a folder                           | No key, or the user lacks access to a restricted library                                                                                                                                                      |
| "Invalid library folder ID"                                                         | Folder id sent without its leading `F`                                                                                                                                                                        |
| "'content' id of lda or hda is missing"                                             | Import POST without `content`                                                                                                                                                                                 |
| An import brought in a file you never asked for                                     | A folder id was sent with `source: "library"`. Galaxy does not reject it: it drops the `F` and imports whatever dataset has that number. Use `library_folder` for folders, and check the imported item's name |
| A folder seems to hold exactly 10 files                                             | You read only the default page; check `metadata.total_rows`                                                                                                                                                   |
| `'LibraryDatasetDatasetAssociation' object has no attribute 'auto_propagated_tags'` | A bare list of `ldda` refs in a multiple input; wrap it as `{"values": [...]}`                                                                                                                                |
| `invoke_workflow` rejects an `ldda` input                                           | Known limit of the input check; import first and pass the `hda`                                                                                                                                               |

## Related

- `galaxy-mcp-reference` (galaxy-skills) for history, tool and workflow operations in general.
- Galaxy API source: [folder contents](https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/webapps/galaxy/api/folder_contents.py),
  [history import from a library](https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/webapps/galaxy/services/history_contents.py).
