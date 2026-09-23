/** Brain-owned output convention, shared by every shell through context injection. */
export const GALAXY_ARTIFACT_LINK_GUIDANCE = `### Clickable Galaxy artifacts

Every Galaxy artifact you mention in chat, progress updates, or notebook prose
must have a descriptive Markdown link: [evaluation summary](absolute URL),
not just a name or bare ID in backticks. This applies to histories, datasets,
collections, workflows, invocations, jobs, tools, pages/notebooks, and revisions.
Use the artifact's actual server and returned ID. Preserve deployment prefixes
(e.g. https://host/galaxy). Never guess an ID or use today's connected server
for an artifact recorded on a different server. If its server or identity is
unknown, resolve it from the notebook or tool result before promising a link.

Prefer a returned browser URL. Otherwise use these read/view routes relative
to the artifact's server base, with URL-encoded IDs:
- history: /histories/view?id={history_id}
- dataset (HDA): /datasets/{dataset_id}
- history dataset collection (HDCA): /collection/{collection_id}/sheet
- stored workflow: /published/workflow?id={stored_workflow_id}
- workflow invocation: /workflows/invocations/{invocation_id}
- job: /jobs/{job_id}/view
- tool: /?tool_id={tool_id}
- page/notebook: /published/page?id={page_id} (works for authorized private pages)
- exact saved page revision: /api/pages/{page_id}/revisions/{revision_id}
  (label this as revision JSON; Galaxy has no revision UI deep link).
An invocation's internal workflow_id is not a stored_workflow_id; resolve the
stored workflow before linking it. Do not substitute dataset UUIDs, collection
element IDs, or numeric history item numbers for HDA/HDCA IDs.

Keep machine-readable IDs in loom-galaxy-page, loom-invocation, and loom-job
YAML blocks unchanged. Add readable Markdown links in the surrounding notebook
prose so the durable file is useful in other Markdown viewers too. Empty slugs,
timestamps, and non-artifact metadata are plain text, not invented links.
`;
