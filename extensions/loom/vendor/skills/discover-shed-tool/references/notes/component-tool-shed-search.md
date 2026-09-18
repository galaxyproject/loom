---
type: research
tags:
  - target/galaxy
component: "Tool Shed Search and Indexing"
status: draft
created: 2026-04-30
revised: 2026-05-03
revision: 2
summary: "Tool Shed's Whoosh repo/tool search and partial GA4GH TRS v2, indexed from hg-walked metadata with no auto-refresh on upload"
related_notes:
  - "galaxy-tool-summary-input-source"
  - "tool-search"
  - "tool-versions"
  - "tool-revisions"
  - "discover-shed-tool"
---

# Galaxy Tool Shed — Search, Indexing, and TRS APIs: Current State

## 1. Architecture primer

The Galaxy Tool Shed is a standalone web application that hosts and serves Galaxy tool wrappers (XML tool definitions plus helper files) to Galaxy servers for installation. Its server code lives under `lib/tool_shed/` in the Galaxy monorepo, sharing model/security/tool-parsing libraries with Galaxy itself but running as its own FastAPI application (`lib/tool_shed/webapp/fast_app.py`, with route modules under `lib/tool_shed/webapp/api2/`). The legacy web framework is almost gone — only `lib/tool_shed/webapp/controllers/hg.py` survives, because the Tool Shed also serves each repository's Mercurial working copy over HTTP for `hg clone`.

A **repository** is the unit of distribution in the Tool Shed: it is a named, owned Mercurial repository (the Tool Shed still runs on `hg`, not `git` — see `mercurial` imports in `lib/tool_shed/util/shed_index.py:4` and `lib/tool_shed/managers/repositories.py:471` onward). A repository has a `name`, an owner (`User.username`), a `type` (e.g. `unrestricted`, `repository_suite_definition`, `tool_dependency_definition` — see `lib/tool_shed/repository_types/`), optional `description`/`long_description`/`homepage_url`/`remote_repository_url`, and a set of categories associated via `RepositoryCategoryAssociation` (`lib/tool_shed/webapp/model/__init__.py`). A repository is indexed/installable only if `deleted=false`, `deprecated=false`, and it is not a `tool_dependency_definition` (see `get_repositories_for_indexing` at `lib/tool_shed/util/shed_index.py:202-212`).

A **tool** is one XML file *inside* a repository's working tree at some revision. The Tool Shed finds tools by walking the repository filesystem and loading XML with `galaxy.tool_util.loader_directory.load_tool_elements_from_path` (`lib/tool_shed/util/shed_index.py:181-198`). Tools are identified by three things that vary across contexts:
- Tool XML `id` attribute (e.g. `bwa_wrapper`) — not globally unique.
- Tool XML `version` attribute.
- The GUID assembled by the Tool Shed as `<host>/repos/<owner>/<name>/<tool_id>/<version>` (see `decode_identifier` in `lib/tool_shed_client/trs_util.py:17-19`).

Revisions/changesets are Mercurial changeset hashes. Each repository has a full changelog; only *some* changesets have a `RepositoryMetadata` row (those that contain installable tools — the Tool Shed regenerates metadata on upload in `upload_tar_and_set_metadata` at `lib/tool_shed/managers/repositories.py:741-803`). `RepositoryMetadata.metadata` is a JSON blob with keys including `tools`, `tool_dependencies`, `repository_dependencies`, `workflows`, `datatypes`, `data_manager` (see `_has_galaxy_utilities` at `lib/tool_shed/managers/repositories.py:904-939`). Only repository changesets that produced a `RepositoryMetadata` row with `downloadable=True` are returned by `get_ordered_installable_revisions` (`lib/tool_shed/managers/repositories.py:415-433`), which is the canonical list of revision hashes a client can install.

## 2. The two Tool Shed search APIs

Both surfaces are backed by **Whoosh** indexes on disk, configured by `whoosh_index_dir` (default `database/toolshed_whoosh_indexes`, `lib/galaxy/config/schemas/tool_shed_config_schema.yml:104`) and gated by `toolshed_search_on` (default `true`, same file:93). One directory holds the repository index; a `tools/` subdirectory holds the tool index (`_get_or_create_index` at `lib/tool_shed/util/shed_index.py:31-37`).

### 2a. Repository search

- **Endpoint**: `GET /api/repositories?q=<term>&page=<n>&page_size=<n>` — `lib/tool_shed/webapp/api2/repositories.py:130-159`. When `q` is present, the endpoint delegates to `search()` (`lib/tool_shed/managers/repositories.py:110-157`) and returns a `RepositorySearchResults`. When `q` is absent, the same endpoint does a plain SQL listing (see §7); `q` and `filter` are mutually exclusive (`api2/repositories.py:150-153`).
- **Implementation**: `RepoSearch` in `lib/tool_shed/webapp/search/repo_search.py:74-215`.
- **Schema fields** (`repo_search.py:27-41`): `id` (NUMERIC, stored), `name` (TEXT, boost 1.7), `description` (TEXT, boost 1.5), `long_description` (TEXT), `homepage_url` (TEXT), `remote_repository_url` (TEXT), `repo_owner_username` (TEXT), `categories` (KEYWORD, comma-separated), plus stored-only `times_downloaded`, `approved`, `last_updated`, `repo_lineage`, `full_last_updated`.
- **Querying**: `MultifieldParser` over `name, description, long_description, homepage_url, remote_repository_url, repo_owner_username, categories` (`repo_search.py:112-123`). The raw term is **lowercased** and wrapped as `*term*` (`repo_search.py:87, 130`) — everything becomes a prefix+suffix wildcard query.
- **Ranking**: Custom `RepoWeighting(BM25F)` multiplies the BM25F score by `times_downloaded/100` (with a minimum of 1) and doubles it when `approved == "yes"` (`repo_search.py:44-71`). Per-field B-values are configurable via options `repo_name_boost`, `repo_description_boost`, etc., collected into a `Boosts` namedtuple in `managers/repositories.py:133-153`.
- **Filters**: GitHub-style reserved filters `category:`/`c:` and `owner:`/`o:` are pre-parsed out of the query string (`repo_search.py:168-215`; supports single-quoted multi-word values). Unknown filter names fall through as literal text.
- **Pagination**: `page` and `page_size` are real; `searcher.search_page` returns `total_results`, `page`, `page_size` and a `hits` list. Missing pages raise `404 ObjectNotFound` (`repo_search.py:138-139`).
- **Response shape**: `RepositorySearchResults` (`lib/tool_shed_client/schema/__init__.py:407-412`) = `{total_results: str, page: str, page_size: str, hostname: str, hits: [{score, repository: RepositorySearchResult}]}`. Note: the numeric fields are serialized as strings. `RepositorySearchResult` exposes `id` (encoded), `name`, `repo_owner_username`, `description`, `long_description`, `remote_repository_url`, `homepage_url`, `last_update`, `full_last_updated`, `repo_lineage` (stringified list of `rev:hash`), `approved`, `times_downloaded`, `categories` (comma-joined string).

### 2b. Tool search

- **Endpoint**: `GET /api/tools?q=<term>&page=<n>&page_size=<n>` — `lib/tool_shed/webapp/api2/tools.py:68-80`.
- **Implementation**: `ToolSearch` in `lib/tool_shed/webapp/search/tool_search.py:34-92`.
- **Schema fields** (`tool_search.py:21-31`): `name`, `description`, `owner`, `id` (TEXT — NOT `ID`, despite the name), `help`, `version`, `repo_name`, `repo_owner_username`, `repo_id` (Whoosh `ID`, used to delete-by-repo when reindexing).
- **Querying**: `MultifieldParser(["name", "description", "help", "repo_owner_username"])` (`tool_search.py:62`). Again the term is wrapped as `*term*` (`tool_search.py:64`). There is no lowercasing step in the tool search (compare `repo_search.py:87`).
- **Ranking**: Plain `BM25F` with configurable field weights `tool_name_boost` (1.2), `tool_description_boost` (0.6), `tool_help_boost` (0.4), `tool_repo_owner_username_boost` (0.3) — see `managers/tools.py:67-75`. No popularity/certification modifier.
- **Pagination**: same as repo search.
- **Response shape**: `{total_results, page, page_size, hostname, hits: [{tool: {id, repo_owner_username, repo_name, name, description}, matched_terms: {...}, score}]}` (`tool_search.py:74-88`).

Notably: the tool search index stores `id`, `version`, `help`, `owner` but the JSON hit dict only exposes `id, repo_owner_username, repo_name, name, description` (plus matched-terms and score). There is no changeset/revision information in hits — the tool index is revision-agnostic; it indexes whatever tools happen to be present on the current filesystem snapshot of the repo (see §2c).

### 2c. Index build

Both indexes are built by the same function, `build_index()` in `lib/tool_shed/util/shed_index.py:40-91`:

1. Open SQLAlchemy session, select repos via `get_repositories_for_indexing` (sorted by `update_time DESC`, excluding deleted/deprecated/tool_dependency_definition).
2. For each repo, open its Mercurial repo, walk `hg_repo.changelog` to build `repo_lineage` (a stringified Python list of `<num>:<hash>`), then walk the filesystem under `<file_path>/<hash_dir>/repo_<id>/` and call `load_one_dir` on each subdirectory, parsing every `<tool>` element it finds.
3. Incremental logic: if the repo's document is already in the index and `full_last_updated` matches, the loop **breaks** (not continues) — relying on the descending sort by update time (`shed_index.py:65-67`). This is why freshness is fragile: any bug that prevents a re-add causes the crawler to stop.
4. Tool documents are replaced atomically per repo: `tool_index_writer.delete_by_term("repo_id", repo_id)` followed by one add per tool (`shed_index.py:75-82`).
5. Category names are lowercased and joined by commas (`shed_index.py:101-105`).

Indexing entry points:
- Script: `scripts/tool_shed/build_ts_whoosh_index.py` — the documented "run this manually" path, called out in docstrings at `managers/repositories.py:111-117` and `managers/tools.py:43-50`.
- Admin API: `PUT /api/tools/build_search_index` (`api2/tools.py:82-102`, `require_admin=True`) returns `BuildSearchIndexResponse{repositories_indexed, tools_indexed}`.

There is **no automatic trigger** on upload — indexes are stale until rebuilt.

## 3. TRS (GA4GH Tool Registry Service) API

Implemented in `lib/tool_shed/webapp/api2/tools.py:104-143` and `lib/tool_shed/managers/trs.py`.

Endpoints:
- `GET /api/ga4gh/trs/v2/service-info` → `Service` (`api2/tools.py:104-106`, `managers/trs.py:37-67`). Reports organization, `type={group: org.ga4gh, artifact: trs, version: 2.1.0}`, service version = Galaxy `VERSION`.
- `GET /api/ga4gh/trs/v2/toolClasses` → list with one entry: `ToolClass(id="galaxy_tool", name="Galaxy Tool", description="Galaxy XML Tools")` (`managers/trs.py:70-71`).
- `GET /api/ga4gh/trs/v2/tools` → **always returns `[]`** (`api2/tools.py:116-121`). The method has a TODO comment acknowledging it should query the DB; currently listing all tools via TRS is not implemented.
- `GET /api/ga4gh/trs/v2/tools/{tool_id}` → `Tool`. The `tool_id` is the Tool Shed's TRS-encoded identifier: `<owner>~<repo>~<tool_id>` (encoding defined by `encode_identifier`/`decode_identifier` in `lib/tool_shed_client/trs_util.py:17-24`). The `~`→`/` substitution is a workaround for FastAPI path-param decoding issues, per the comment at `trs_util.py:11-15`.
- `GET /api/ga4gh/trs/v2/tools/{tool_id}/versions` → `list[ToolVersion]`, implemented as `get_tool(...).versions` (`api2/tools.py:138-143`).

**Construction of the TRS Tool response** (`managers/trs.py:121-151`):

```
Tool(
  id = trs_tool_id,                      # owner~repo~tool_id form
  aliases = [guid],                      # single-element list with Galaxy-style GUID
  url = "https://<host>/repos/<owner>/<repo>",
  toolclass = ToolClass(id="galaxy_tool", ...),
  organization = <owner username>,
  versions = [ ToolVersion(...) for each version across installable revisions ]
)
```

And each `ToolVersion` is (`managers/trs.py:134-143`):

```
ToolVersion(
  author = [repo_owner],     # owner username, not tool author
  containerfile = False,     # always False
  descriptor_type = [GALAXY],
  id = <tool_version_string>,
  url = <same as Tool.url>,   # TODO comment — not a version-specific URL
  verified = False,           # always False
)
```

Versions are collected by iterating installable revisions of the repo, loading each `RepositoryMetadata.metadata["tools"]`, and accumulating the set of `version` strings (`managers/trs.py:84-97`, `get_repository_metadata_by_tool_version`). If the same `version` string appears in multiple changesets, the last one seen wins (it's a `dict` keyed by version, `trs.py:96`).

**Deviations / omissions from the TRS 2.1 spec**:
- `GET /tools` is stubbed to `[]`.
- `name`, `description`, `meta_version`, `has_checker`, `checker_url` on `Tool`: not populated.
- `ToolVersion.name`, `meta_version`, `images`, `descriptor_type_version`, `signed`, `verified_source`, `included_apps`: not populated.
- `ToolVersion.author` is set to the *repository owner username*, not the tool's `<citations>`/`<requirements>` author.
- `ToolVersion.url` is the same as `Tool.url` (explicit TODO at `trs.py:134`).
- No checksum endpoint (`/tools/{id}/versions/{v}/{type}/descriptor`, `/tests`, `/containerfile`, `/files`) is implemented.
- No pagination headers (TRS uses `Link` / `next_page` for the list endpoint, which is stubbed).

## 4. Galaxy's own tool search (for contrast)

Galaxy's installed-toolbox search lives in `lib/galaxy/tools/search/__init__.py` (`ToolBoxSearch`, `ToolPanelViewSearch`). It is Whoosh-based, but very different:

- Per-**panel-view** index directory: each tool panel view gets its own index, so search results respect the current view (`__init__.py:100-127`).
- Much richer schema (`__init__.py:144-199`): `id_exact` (NGRAMWORDS), `name_exact` (TEXT with `IDTokenizer`), `stub` (parsed GUID), `section`, `edam_operations`, `edam_topics`, `repository`, `owner`, `description` (StemmingAnalyzer), `help`, `labels`, plus `name` as either NGRAMWORDS (configurable `tool_enable_ngram_search`) or plain TEXT.
- Indexed from the running `ToolBox`/`ToolCache` on reload, not from disk crawling — so it is always in sync with installed tools.
- Uses a `MultiWeighting` with `BM25F` + `Frequency` and has EDAM ontology fields that are *actually analyzed*.
- Exposed via `GET /api/tools?q=<term>` (`lib/galaxy/webapps/galaxy/api/tools.py:529-572`) which delegates to `service._search(q, view)`. Returns a flat list of tool IDs, not scored hits.
- Reserved query `ilovegalaxy` / "favorites" short-circuits to the user's favorited tool list (`tools.py:552-559`).

The two search surfaces exist because they answer different questions: Galaxy's searches *installed* tools for a logged-in user session (respects tool panel views, EDAM, user favorites); the Tool Shed's searches *installable* tools/repositories across the whole shed catalog. The Tool Shed's schema is substantially poorer (no EDAM, no stem analyzer, no panel context) and its index is not automatically refreshed.

## 5. Repository vs. tool as a search unit

The Tool Shed exposes both because they describe different things:

- A **repository** is what an admin actually *installs*. Installation is a `(name, owner, changeset_revision)` triple (`get_install_info` at `lib/tool_shed/managers/repositories.py:342-403`). Repositories group files that must travel together: tool XML + test data + tool-data tables + data managers + datatypes + workflows + dependency declarations (`_has_galaxy_utilities`, `managers/repositories.py:904-939`). Discovery by repository is the right answer to "I want a package named X by owner Y" and is how the Tool Shed UI and `ephemeris`/`planemo` install flows work.
- A **tool** is a single `<tool>` element. A single repository can contain many tools (loader walks the whole tree — `shed_index.py:142-149`); one "logical tool" (by XML `id`) can exist at many versions within one repository (each `<tool version=...>` in different changesets → multiple entries in `RepositoryMetadata.metadata["tools"]`); and the same XML `id` can be wrapped and published in **multiple independent repositories** owned by different users, with no referential link between them. Repository-level search cannot answer "find me any tool that runs BWA".

Tool identity, concretely:
- At parse time: `(tool_id, tool_version)` from the XML.
- At shed storage: `GUID = <tool_shed_host>/repos/<owner>/<repo>/<tool_id>/<version>` (unique). This is what Galaxy stores as `Tool.id` after installation.
- At TRS: `<owner>~<repo>~<tool_id>`, with `version` as a separate path segment. Note that the TRS `tool_id` does **not** include the shed host or the repo's tool XML version.
- In the tool search index: only `id` (the XML id, non-unique), `repo_name`, `repo_owner_username`, `repo_id` — no changeset, no GUID field stored directly. Two different repos exposing a tool with XML id `bwa` collapse into two hits distinguishable only by `repo_name` + `repo_owner_username`.

Implication: if you search the tool index and get a hit with `id=bwa_wrapper`, `repo_name=bwa`, `repo_owner_username=devteam`, you still need a separate call — typically `GET /api/repositories/get_ordered_installable_revisions?owner=devteam&name=bwa` (`api2/repositories.py:270-281`) — to learn which changesets actually contain that tool, and then `GET /api/repositories/get_repository_revision_install_info` (`api2/repositories.py:194-212`) to get the `valid_tools` list for a specific revision. The TRS endpoints (`/api/ga4gh/trs/v2/tools/{owner~repo~tool_id}`) give you the per-version list but require you to already know the TRS id.

Revisions also muddy tool identity: a tool's XML `version` string *usually* bumps between changesets, but there is no invariant — two changesets can publish the same XML `version` with different content, and the TRS version accumulator silently deduplicates by version string (`managers/trs.py:87-97`, note the `versions[tool_metadata["version"]] = metadata` overwrite). Nothing in the indexed data exposes this collision.

## 6. Realistic limitations and rough edges

- **Stale indexes**. The Whoosh indexes are built by a separate script (`scripts/tool_shed/build_ts_whoosh_index.py`) or an admin-only API call (`PUT /api/tools/build_search_index`). There is no hook from `upload_tar_and_set_metadata` or from `RepositoryMetadataManager.set_repository_metadata_due_to_new_tip` into the index. Freshness depends on cron. The docstrings literally say "you have to pre-create with scripts/tool_shed/build_ts_whoosh_index.sh manually" (`managers/repositories.py:113-115`).
- **Incremental build break-loop**. `build_index` breaks out of the repo loop on the first `full_last_updated` match (`shed_index.py:65-67`); any anomaly in `update_time` ordering or `full_last_updated` format can silently halt the incremental update partway through. A repo deleted since last index is not purged.
- **Wildcard wrapping**. Both searches rewrite the query as `*term*`. That disables Whoosh's analyzer-based stemming on the user's term, makes very short terms O(n) over the vocabulary, and prevents users from doing structured Whoosh syntax (boolean operators beyond what survives wrapping). `RepoSearch` additionally lowercases the term before parsing (`repo_search.py:87`); `ToolSearch` does not (`tool_search.py:61-64`), creating a case-sensitivity asymmetry between the two endpoints.
- **Categories are free text**. In the repo index, `categories` is a comma-joined string built from `Category.name.lower()` (`shed_index.py:101-105`). The reserved filter `category:'Climate Analysis'` (see doctest at `repo_search.py:187`) constructs a Whoosh `Term('categories', 'Climate Analysis')`, which against a comma-separated KEYWORD field matches if that exact value appears in the list — but the indexed form is lowercased, so `category:'Climate Analysis'` will silently miss and the user has to know to type lowercase. There's no schema validation — arbitrary `category:anything` is accepted.
- **`approved` boost is dead code**. `approved` is always stored as the literal string `"no"` (`shed_index.py:161`), despite `RepoWeighting.final` checking for `"yes"` to double the score (`repo_search.py:66`). No repo is ever scored as approved. `times_downloaded` is read from the `Repository` row.
- **`/api/ga4gh/trs/v2/tools` returns `[]`**. The list endpoint is a stub (`api2/tools.py:116-121`). There is no bulk-enumeration TRS endpoint.
- **TRS version dedup across revisions**. `get_repository_metadata_by_tool_version` overwrites duplicates (`managers/trs.py:87-97`); if a tool has version `1.0.0` across several changesets, only the last-iterated one is reflected in the TRS response.
- **Partial TRS payload**. `ToolVersion` fields `images`, `descriptor_type_version`, `name`, `meta_version`, `verified_source`, `signed`, `included_apps`, `is_production` are never populated (`managers/trs.py:134-143`). `ToolVersion.url` and `Tool.url` are the same string — there's no version-specific URL to fetch the descriptor from, and no `/tools/{id}/versions/{v}/GALAXY/descriptor` endpoint is implemented.
- **No containerfile / checksum / tests via TRS**. The spec's `/tools/{id}/versions/{v}/containerfile`, `/tests`, `/{type}/files` endpoints are not implemented.
- **Pagination**. `search_page` raises `ObjectNotFound("The requested page does not exist.")` rather than returning an empty page (`repo_search.py:138-139`, `tool_search.py:67-69`). The SQL `index_repositories` path returns a **bare list with no `total_results`, `next`, or `prev`** (`api2/repositories.py:182-192`, `managers/repositories.py:297-299`); only the opt-in `?page=&page_size=` path returns `PaginatedRepositoryIndexResults` with a count (`managers/repositories.py:302-316`). Filter-based listing with `filter=` uses `ILIKE '%…%'` across `User.username`, `Repository.name`, `Repository.description` — case-insensitive but with no phrase boundaries (`managers/repositories.py:837-845`).
- **`id` field type in tool index**. Declared as `TEXT`, not Whoosh `ID` (`tool_search.py:25`). Searches on `id` therefore tokenize — you can't pin a hit to an exact GUID.
- **No EDAM in shed indexes**. Tool XML `<edam_operations>`/`<edam_topics>` are parsed by Galaxy's metadata pipeline (stored in `RepositoryMetadata.metadata["tools"][i]`) but **not included in the Whoosh `tool_schema`** (`tool_search.py:21-31`). EDAM is only indexed in *Galaxy's* tool search, not the Tool Shed's. `load_one_dir` reads only `help`, `description`, `id`, `name`, `version` (`shed_index.py:182-198`).
- **Authentication**. Search endpoints do not require auth (`toolshed_search_on` is the only gate). `build_search_index` requires admin. Management endpoints (upload, delete/deprecate, allow_push, admins) require ownership (`can_manage_repo` in `managers/repositories.py:319-321`) or admin role.
- **Deleted/deprecated handling**. Deleted and deprecated repos are excluded from indexing (`shed_index.py:205-212`) and from DB queries for category listing (`_get_repository_by_name_and_owner` at `managers/repositories.py:812-822`). But *deprecating a repo does not trigger reindexing*; its hits persist until the next rebuild. `RepositoryIndexDeletedQueryParam` exists (`api2/__init__.py:282`) but only for the SQL-listing branch.
- **Rate limits**. None in this code; rate-limiting is deployment-level.
- **Custom encoding of identifiers**. TRS tool ids use `~` as a separator purely to dodge FastAPI's URL-decoding behavior on `/` (see comment at `trs_util.py:11-15`). Consumers must encode accordingly.

## 7. Endpoint reference table

| Method | Path | Key params | Returns | Notes |
|---|---|---|---|---|
| GET | `/api/repositories` | `q`, `filter`, `page`, `page_size`, `owner`, `name`, `category_id`, `deleted`, `sort_by` (`name\|create_time`), `sort_desc` | `RepositorySearchResults` when `q`, else `PaginatedRepositoryIndexResults` when `page`, else `list[Repository]` | `q` and `filter` mutually exclusive. `q` uses Whoosh; rest use SQL `ILIKE`. `api2/repositories.py:130-192` |
| GET | `/api/repositories/{id}` | — | `DetailedRepository` | encoded repo ID |
| GET | `/api/repositories/{id}/metadata` | `downloadable_only` | `dict` keyed `"{rev_num}:{hash}"` | per-revision metadata; also `/api_internal/.../metadata` returns typed `RepositoryMetadata` |
| GET | `/api/repositories/get_ordered_installable_revisions` | `owner`+`name` or `tsr_id` | `list[str]` of changeset hashes | canonical installable-revision list |
| GET | `/api/repositories/get_repository_revision_install_info` | `name`, `owner`, `changeset_revision` | `list[repo_dict, metadata_dict, repo_info_dict]` | 3-element list (legacy) |
| GET | `/api/repositories/install_info` | same as above | `InstallInfo` | modern typed form |
| GET | `/api/repositories/updates` | `owner`, `name`, `changeset_revision`, `hexlify` | string (hex-encoded dict) | whether a newer rev exists |
| GET | `/api/repositories/{id}/revisions/{rev}/readmes` | — | `RepositoryRevisionReadmes` | |
| POST | `/api/repositories` | `CreateRepositoryRequest` body | `Repository` | auth required |
| PUT | `/api/repositories/{id}` | `UpdateRepositoryRequest` | `DetailedRepository` | owner/admin |
| POST | `/api/repositories/{id}/changeset_revision` | multipart tar + `commit_message` | `RepositoryUpdate` | upload new revision |
| PUT/DELETE | `/api/repositories/{id}/deprecated` | — | 204 | owner/admin |
| GET | `/api/categories` | — | `list[Category]` | |
| GET | `/api/categories/{id}` | — | `Category` | |
| GET | `/api/categories/{id}/repositories` | `installable`, `sort_key`, `sort_order`, `page` | `RepositoriesByCategory` | |
| POST | `/api/categories` | body | `Category` | admin only |
| GET | `/api/tools` | `q` (required), `page`, `page_size` | tool search result dict | Whoosh tool index |
| PUT | `/api/tools/build_search_index` | — | `BuildSearchIndexResponse` | admin only |
| GET | `/api/tools/{tool_id}/versions/{tool_version}` | — | `ShedParsedTool` | expanded parsed tool; cached via `model_cache` |
| GET | `/api/tools/{tool_id}/versions/{tool_version}/parameter_request_schema` | — | JSON Schema | |
| GET | `/api/tools/{tool_id}/versions/{tool_version}/parameter_landing_request_schema` | — | JSON Schema | |
| GET | `/api/tools/{tool_id}/versions/{tool_version}/parameter_test_case_xml_schema` | — | JSON Schema | |
| GET | `/api/tools/{tool_id}/versions/{tool_version}/tool_source` | — | raw tool XML (text/plain) | `language` header |
| GET | `/api/ga4gh/trs/v2/service-info` | — | `Service` | |
| GET | `/api/ga4gh/trs/v2/toolClasses` | — | `[ToolClass]` | single class `galaxy_tool` |
| GET | `/api/ga4gh/trs/v2/tools` | — | `[]` | **stub — always empty** |
| GET | `/api/ga4gh/trs/v2/tools/{tool_id}` | — | `Tool` | `tool_id` = `owner~repo~tool_id` |
| GET | `/api/ga4gh/trs/v2/tools/{tool_id}/versions` | — | `list[ToolVersion]` | |

Mercurial access (needed for actual file fetching of a specific revision): each repository is also exposed at `/<owner>/<name>` through `lib/tool_shed/webapp/controllers/hg.py`, which serves the Mercurial HTTP protocol (`hg clone`, `hg pull`). This is how `InstallInfo`-driven clients materialize the content at a changeset.

---

## Sources consulted

- `lib/tool_shed/webapp/search/repo_search.py`
- `lib/tool_shed/webapp/search/tool_search.py`
- `lib/tool_shed/util/shed_index.py`
- `lib/tool_shed/webapp/api2/__init__.py`
- `lib/tool_shed/webapp/api2/repositories.py`
- `lib/tool_shed/webapp/api2/tools.py`
- `lib/tool_shed/webapp/api2/categories.py`
- `lib/tool_shed/managers/repositories.py`
- `lib/tool_shed/managers/tools.py`
- `lib/tool_shed/managers/trs.py`
- `lib/tool_shed_client/trs_util.py`
- `lib/tool_shed_client/schema/__init__.py`
- `lib/tool_shed_client/schema/trs.py`
- `lib/galaxy/tools/search/__init__.py`
- `lib/galaxy/webapps/galaxy/api/tools.py`
- `lib/galaxy/config/schemas/tool_shed_config_schema.yml`
- `scripts/tool_shed/build_ts_whoosh_index.py`
- `packages/core/src/client/toolshed.ts` (galaxy-tool-util)
