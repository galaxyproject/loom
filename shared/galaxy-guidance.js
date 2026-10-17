// Galaxy workflow guidance both shells put in the system prompt. The text is the browser's, byte for
// byte; `tool` maps a galaxy-mcp tool name to what the shell offers it as (the browser's bare
// name, Orbit's mcp__galaxy__ one).

/** @param {string} name */
const bare = (name) => name;

/** @param {{ tool?: (name: string) => string }} [options] @returns {string} */
export function findingAWorkflow({ tool = bare } = {}) {
  return `### Finding a community workflow (IWC)

When the user describes an analysis they want run on their data -- even as
a question ("which genes changed between my samples?") rather than a
request for a plan -- check the IWC registry before assembling tools by hand:

1. \`${tool("recommend_iwc_workflows")}({ intent, limit: 5 })\` with their goal in
   plain words. It ranks by word overlap and always returns something, so a
   ranked hit is a candidate, not a match.
2. \`${tool("get_iwc_workflow_details")}({ trs_id })\` on the plausible ones, for
   the **inputs**. Compare them with the data the user actually has (reads vs
   count tables, paired vs single-end, collection vs dataset). The right
   analysis with the wrong starting point is not a match -- though it may be
   the second half of one, after a workflow that produces its inputs.
3. Offer the one or two that fit, in plain language: what each does and what
   it needs from them. If none fit, say so and draft step-by-step.
4. Once they choose: \`${tool("import_workflow_from_iwc")}({ trs_id })\`, then invoke
   it as below.

\`${tool("search_iwc_workflows")}\` is plain keyword search for when the user
names a workflow or tool; it has no limit, so prefer recommend for a goal.`;
}

/** @param {{ tool?: (name: string) => string }} [options] @returns {string} */
export function invokingWorkflow({ tool = bare } = {}) {
  return `### Invoking a Galaxy workflow

Call \`${tool("get_workflow_input_template")}\` before \`${tool("invoke_workflow")}\`. Take the
\`inputs_template\` map out of what it returns -- that field, not the whole wrapper --
keep its keys, replace every placeholder (\`<value>\`, \`<dataset_id>\`,
\`<collection_id>\`) with a real value, and pass that map as \`inputs\`:

- Data **and** non-data slots both belong in \`inputs\`, keyed by step index: a
  collection slot takes \`{"src":"hdca","id":"<collection_id>"}\`, an
  integer/text/genome slot takes the bare scalar (\`5\`, \`"hg38"\`). Slots the template
  marks \`optional\` may be left out.
- Pass \`inputs_by="step_index|step_uuid"\` verbatim -- the pipe-separated form is one
  valid value, not a choice between two.
- **Don't route workflow inputs through \`params\`.** It is the legacy per-step
  tool-override map, typed \`dict[str, dict]\`, so a scalar value fails with
  \`Input should be a valid dictionary in ('body','parameters',<key>)\`. Re-keying by
  label, index, or uuid won't fix that -- the key was never the problem. Put the
  value in \`inputs\`.`;
}
