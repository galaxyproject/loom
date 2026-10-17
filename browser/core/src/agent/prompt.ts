import { findingAWorkflow, invokingWorkflow } from "../../../../shared/galaxy-guidance.js";
import {
  activeModelBlock as sharedActiveModelBlock,
  artifactLinkGuidance,
  chatFormatting,
  currentDateBlock as sharedCurrentDateBlock,
  draftingAPlan,
  executingAStep,
  galaxyPageMarkdown,
  galaxyTerminology as sharedGalaxyTerminology,
  galaxyUnavailableBlock,
  gettingDataIn,
  noLocalShellBlock,
  operatingDiscipline,
  parameterReviewBlock,
  planConvention,
  recordWrites,
  sraImportGuidance,
  verificationBlock,
} from "../../../../shared/prompt-blocks.js";
import { DEFAULT_BRAND } from "./brand";

// System-prompt blocks, adopted from Orbit's `extensions/loom/context.ts`.

// loom: buildNoLocalShellBlock(). Shared text; what this shell has instead of a shell.
export const NO_LOCAL_SHELL = noLocalShellBlock({
  tools: "your Galaxy tools",
  instead: `\`run_python\` is a browser-side
scratchpad for inspecting and summarizing data, not a compute path: real work is a
Galaxy job, which is also what makes it reproducible.`,
});

// loom: buildGalaxyContextBlock(), the "Galaxy terminology" section. Shared text, under this shell's heading.
/** The Galaxy terms the agent should know, with a flavor's own bullets after the UDT one. */
export const galaxyTerminology = (more: string[] = []) => `## Galaxy

${sharedGalaxyTerminology({ more, invocationNote: "", routing: false })}`;

// loom: buildGalaxyContextBlock(), "Getting data into a Galaxy history". Shared text; this shell's routes.
export const GETTING_DATA_IN = gettingDataIn({
  staging: `Do **not** try to route the bytes through this
session: the browser is not a staging area, and a server-side fetch runs at datacenter
bandwidth.`,
  accessions: `An accession is not a URL. \`ena_runs\` turns an SRA/ENA accession into the exact FASTQ
URLs and says whether the run is paired; ENA's paths cannot be derived from the
accession, so read them there rather than constructing one.`,
  alternatives: [
    `- **There is no path from the user's disk.** \`upload_file\` reads only the browser
  filesystem \`run_python\` writes to; if the user has a file only on their machine,
  ask them to upload it through the Galaxy UI, then continue from the history.`,
  ],
});

// loom: sra-import-gate.ts, SRA_IMPORT_GUIDANCE. Shared text; this shell says when it applies.
export const IMPORTING_SRA = sraImportGuidance({
  before: `This is the route when the SRA importer wrapper (\`fastq_dump\`/\`fasterq_dump\`) is installed;
\`search_tools_by_name\` says whether it is. Where it is not, resolve the accessions with
\`ena_runs\` and fetch the URLs it returns.`,
  record: "the record",
  recording: "Record the returned job and collection ids.",
});

// loom: buildGalaxyContextBlock(), "Invoking a Galaxy workflow".
export const INVOKING_WORKFLOW = invokingWorkflow();

// loom: buildGalaxyContextBlock(), "Executing a Galaxy step". Shared text; this shell records runs itself and is told when they end.
export const EXECUTING_A_STEP = executingAStep({
  record: "record",
  approval: "",
  recording: `**Record it and move on.** After submitting with \`run_tool\` or \`invoke_workflow\`, say
what you submitted and that it is running, and note it in the record against the step it
belongs to. You are told when a run finishes or fails -- you do not need to sit here calling
\`get_job_details\` in a loop. A run that was cancelled or skipped sends no such message, and
neither does one that finishes after several of these in a row, so if the user speaks while
you are waiting on a run, check it yourself before answering about it.`,
  waiting: `- If a prerequisite is still running and no other authorized work is ready, give a
  concise status and yield.`,
  tail: `A tool that answered is not a result: a successful metadata request does not mean a dataset
has finished, and a successful tool response is not scientific success. Say what you verified,
what is running and what comes next -- each tool call already shows in the transcript as it
happens, so the words that earn their place are the ones a reader cannot get from the call
itself. Repeated reads of a resource the monitor is already watching are refused for two
minutes, because they cannot answer anything new.`,
});

// loom: buildGalaxyContextBlock(), "Finding a community workflow (IWC)".
export const FINDING_A_WORKFLOW = findingAWorkflow();

// loom: buildGalaxyContextBlock(), the "Drafting a new plan" section. Shared text, without a local step.
export const DRAFTING_A_PLAN = draftingAPlan({
  local: false,
  resume: `**When the user asks to pick up earlier work**, read the bound history first
(\`get_history_contents\`) so the proposal builds on what is actually there. This is for
resuming, not for every new plan.`,
});

// Whether Galaxy answered when the session started.
export const GALAXY_READY = "ok";
export const GALAXY_UNREACHABLE = "unreachable";

export type GalaxyStatus = typeof GALAXY_READY | typeof GALAXY_UNREACHABLE;

// loom: buildGalaxyContextBlock's NOT CONNECTED variant, shell-disabled branch. Shared text; this shell's cause.
export const GALAXY_UNAVAILABLE = galaxyUnavailableBlock({
  cause: "Galaxy did not answer, so no Galaxy tool or workflow can run in this session.",
  remedy: "say so plainly and ask the user to check that the server is up and reload the page",
});

// loom: buildOperatingDisciplineBlock(). Shared text; this shell's credentials and compaction.
export const OPERATING_DISCIPLINE = operatingDiscipline({
  record: "the record",
  credentials: `You do not need a key pasted to you: Galaxy is reached with the user's own
authenticated session, and the model key is held by the browser and supplied to you
as configuration. So a failing call is a permissions or configuration problem, not a
missing paste -- say what was denied, and point at Galaxy for a Galaxy permission or
at the provider settings for a model one.`,
  mechanism: `Compaction happens automatically when the
conversation outgrows the model's window: the oldest turns are replaced with a summary
before the request is sent. It is not something you trigger, and there is no tool for it.`,
  realMechanism: "and that compaction runs on its own.",
  exists: "A record edit exists only after `update_page` runs and returns success.",
  exportHint: "",
});

// loom: buildVerificationDisciplineBlock(). Shared text; no local file here, and runs announce themselves.
export const VERIFICATION = verificationBlock({
  record: "record",
  recordFile: "the record",
  local: false,
  runCheck: "verify once you are told it reached a terminal state,",
  await: "and inspect its outputs when it finishes",
  awaitJobs: "wait until its jobs finish",
  inspect: `\`get_dataset_details\` gives you state, datatype, size and
metadata without downloading; \`run_python\` can parse a peek when the check needs the
content itself`,
});

// loom: buildPlanConventionBlock(). Shared text; remote-only, no anchors, this shell's record and override.
export const PLAN_CONVENTION = planConvention({
  intro: `A plan is drafted in the conversation and, once approved, written into the record
(the \`notebook\` skill covers that). Multiple plans can coexist across a session.`,
  record: "record",
  recordFile: "the record",
  writeVerb: "write",
  shell: "The interface",
  local: false,
  omitAnchors: true,
  override: `If the user says "just run it" or otherwise waives the gate, that is a manual
override -- honor it.`,
  awaitRun: "once the run finishes, inspect the BAM outputs",
});

// loom: buildParameterReviewBlock(). Shared text; approval here means the plan's gate.
export const PARAMETER_REVIEW = parameterReviewBlock({
  approved: "proceed to the approval gate (see Plans and the approval gate)",
});

// loom: buildChatFormattingBlock(), the record wording retargeted to the page. Shared text.
export const CHAT_FORMATTING = chatFormatting({
  results: `Results live in the Galaxy
  history and in the artifact pane; rendered artifacts do not need restating in
  prose.`,
});

// loom: GALAXY_ARTIFACT_LINK_GUIDANCE. Shared text; the record and its directives are this shell's.
const artifactLinks = (root?: string) =>
  artifactLinkGuidance({ record: "record", blocks: "```galaxy directives", root });
export const ARTIFACT_LINKS = artifactLinks();

/** loom: buildChatFormattingBlock(), with the artifact-link convention at its tail. */
export function chatFormattingBlock(galaxyRoot?: string): string {
  if (!galaxyRoot) {
    return CHAT_FORMATTING;
  }
  return `${CHAT_FORMATTING}\n\n${artifactLinks(galaxyRoot)}`;
}

// loom: buildNotebookWriteBlock(), retargeted from notebook.md edits to the Galaxy page. Shared text.
export const RECORD_WRITES = recordWrites({
  heading: "## The record",
  record: "record",
  howToWrite: `that is an edit to **the
record**, this analysis's page on Galaxy. It accumulates over the analysis: **ad-hoc
exploration as much as planned work** -- the approved plan, tools you ran and why, what the
results showed, and what you concluded. Substantive work belongs there even when no plan
was drafted and nobody asked you to write it down.`,
  editing: [
    `- Call \`notebook_resume()\` **once, before your first write**. It opens this session's
  record page and returns its id, current content and \`content_hash\`.`,
    `- **Add to the record a section at a time.** \`update_page({ page_id, section_heading,
  section_content })\` replaces one section and leaves the rest of the page alone, which is
  what appending a finding or a step usually is. \`section_heading\` is the heading line
  itself, such as \`## Results\`, and \`section_content\` starts with it.`,
    `- **\`content\` replaces the whole page.** Reach for it only to restructure the record, and
  then send the existing content with your addition merged in, never the new part alone --
  passing only the new text discards everything already recorded.`,
    `- **Pass \`expect_hash\` from the read you based the edit on.** The write is refused if the
  record moved since, which is a conflict to re-read rather than an edit to force.`,
  ],
  visibility: "The content the record returns to you is",
  writeVerb: "call `update_page`",
  writeClaim: `**Do not claim the record was updated unless \`update_page\` returned.** Calling
\`notebook_resume\` binds the record; it does not write to it. If you did not call
\`update_page\`, say plainly that the record is not yet updated -- never write "logged in the
record" or "the plan has been recorded" when nothing was written. A record the user
believes in and that is empty is worse than no record.`,
});

// loom: GALAXY_PAGE_MARKDOWN_GUIDANCE, from galaxy-page-markdown-guidance.ts. Shared text; this shell's artifacts.
export const GALAXY_PAGE_MARKDOWN = galaxyPageMarkdown({
  heading: "## Writing a Galaxy page",
  // The prompt test refuses any named fence Galaxy would not render, so the offenders go unnamed.
  offenders: "",
  artifacts: `To put a chart or visualization from this session on the page, write \`{{artifact}}\` on its own
line, or \`{{artifact: <title>}}\` for an earlier one; the cell is built for you from what the
user saw. Never write that cell, or an embed of your own invention, yourself.`,
});

/** loom: buildCurrentDateBlock(). Shared text; the durable record here is the record. */
export function currentDateBlock(today: Date = new Date()): string {
  return sharedCurrentDateBlock(today, { record: "record" });
}

/** loom: buildActiveModelBlock(). Shared text; omitted with no model named, since the Galaxy proxy picks its own. */
export function activeModelBlock(model?: string, provider?: string): string {
  if (!model) {
    return "";
  }
  return sharedActiveModelBlock({ model, provider });
}

export interface PromptOptions {
  model?: string;
  provider?: string;
  galaxyStatus?: GalaxyStatus;
  /** A flavor's sections, placed right after the identity line. */
  afterIdentity?: string[];
  /** A flavor's own Galaxy terms, as bullets in the terminology list. */
  terminology?: string[];
  galaxyRoot?: string;
  /** What the agent is called: the brand's name. */
  name?: string;
}

function galaxyNotice(status: GalaxyStatus): string {
  return status === GALAXY_UNREACHABLE ? GALAXY_UNAVAILABLE : "";
}

export const identity = (name = DEFAULT_BRAND.name) => `You are ${name}.`;

export function systemText({
  name,
  model,
  provider,
  galaxyStatus = GALAXY_READY,
  afterIdentity = [],
  terminology = [],
  galaxyRoot,
}: PromptOptions = {}): string {
  // As loom does: the Galaxy guidance rides on the connection, whichever tools are granted.
  const galaxy = (block: string) => (galaxyStatus === GALAXY_READY ? block : "");
  return [
    identity(name),
    ...afterIdentity,
    activeModelBlock(model, provider),
    NO_LOCAL_SHELL,
    galaxyNotice(galaxyStatus),
    galaxy(galaxyTerminology(terminology)),
    galaxy(FINDING_A_WORKFLOW),
    galaxy(DRAFTING_A_PLAN),
    galaxy(GETTING_DATA_IN),
    galaxy(IMPORTING_SRA),
    galaxy(INVOKING_WORKFLOW),
    galaxy(EXECUTING_A_STEP),
    OPERATING_DISCIPLINE,
    VERIFICATION,
    PLAN_CONVENTION,
    PARAMETER_REVIEW,
    chatFormattingBlock(galaxyRoot),
    RECORD_WRITES,
    GALAXY_PAGE_MARKDOWN,
    currentDateBlock(),
  ]
    .filter(Boolean)
    .join("\n\n");
}
