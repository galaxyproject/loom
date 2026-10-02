/* global document */
// Isolated, illustrative fixture. This renderer performs no Galaxy or model calls.
const $ = (selector) => document.querySelector(selector);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const look = {
  recorded: "◇",
  queued: "◷",
  review: "◉",
  pending: "○",
  blocked: "!",
};
let snapshot;
let model;
let selected = "verify";

function link(artifact) {
  const node = el("a", "", `${artifact.label} ↗`);
  const url = new URL(artifact.url, document.baseURI);
  const fixturePage = new URL("./artifact.html", document.baseURI);
  if (url.origin !== fixturePage.origin || url.pathname !== fixturePage.pathname)
    throw new Error("Prototype links must point to the local artifact fixture");
  node.href = url.href;
  node.target = "_blank";
  node.rel = "noopener noreferrer";
  return node;
}

function scenario(name) {
  const data = structuredClone(snapshot);
  data.current = "verify";
  data.title = "Preparing reference cohorts";
  data.state = "review";
  data.label = "Verification pending";
  data.summary =
    "Galaxy finished the preparation job. The next milestone is verifying the outputs and the full input-package contract.";
  data.chat =
    "Galaxy returned the preparation outputs. The original archive upload succeeded after a datatype error. The reports still need inspection before I can say which cohorts are ready; the failed engine-parity test also needs a successful replacement.";
  data.disclosure =
    "All stages, counts, errors and results are illustrative fixtures. Artifact links open local example pages. This is not a live progress report.";
  data.freshness = "Example checkpoint: 19:49 · No live feed";
  data.provenance = "EXAMPLE DATA · 42 REFERENCE COHORTS";
  if (name === "queued") {
    Object.assign(data, {
      current: "prepare",
      state: "queued",
      label: "Waiting on Galaxy",
      summary: "The batch preparation job was accepted and is waiting for a Galaxy execution slot.",
      chat: "The original input archive is on Galaxy and the batch preparation job is queued. I need its validation outputs before assessing cohort readiness. The datatype workaround succeeded; the earlier script errors remain available in Activity.",
      freshness: "Example checkpoint: 19:42 · No live feed",
      disclosure:
        "Illustrative queued-job state. Later example completion evidence is deliberately excluded from this view.",
    });
    Object.assign(data.stages[2], {
      state: "queued",
      label: "Queued on Galaxy",
      summary:
        "Galaxy accepted the batch job. It had not started executing at this recorded status check.",
      evidence: "At 19:42:16 UTC, Galaxy returned job state queued with no exit code.",
      next: "Wait for the background job tracker to observe a state change, then inspect the validation outputs.",
      artifacts: [],
    });
    Object.assign(data.stages[3], {
      state: "pending",
      label: "Waiting for outputs",
      summary:
        "Output datasets have been allocated, but the job has not produced verified results.",
      evidence: "No completed validation outputs exist in this queued-job snapshot.",
      next: "Inspect the reports after successful execution; do not infer success from placeholder datasets.",
      artifacts: [],
    });
    Object.assign(data.stages[4], {
      summary:
        "The final package depends on execution, output inspection and collection verification.",
      evidence: "A final usable handoff has not been established at this point.",
      artifacts: [],
    });
    data.stages[0].artifacts = [];
  }
  if (name === "blocked") {
    Object.assign(data, {
      current: "prepare",
      state: "blocked",
      label: "One cohort blocked",
      title: "Preparing example cohorts",
      summary:
        "A cohort has missing sampling dates. Other independent cohorts can continue; this cohort cannot pass validation.",
      chat: "One example cohort cannot be prepared because its XML has no usable dates for several taxa. The original is preserved. I would check the author metadata and keep this cohort out of accepted inputs until the dates are established.",
      freshness: "Illustrative state · No real job or dataset is represented",
      provenance: "EXAMPLE ONLY · BLOCKED VALIDATION",
      history: null,
      artifacts: {},
      disclosure:
        "This scenario is invented to demonstrate a blocker and recovery action. It does not describe a real cohort.",
    });
    data.stages.forEach((stage) => {
      stage.artifacts = [];
      stage.evidence = "Illustrative state; no real execution evidence is attached.";
      stage.summary = "Example preparation stage.";
      stage.next = "Continue only when the preceding evidence supports this stage.";
    });
    Object.assign(data.stages[2], {
      state: "blocked",
      label: "Missing dates",
      summary:
        "Required sampling dates are missing for five taxa in an example cohort. This is a validation rejection, not a crashed Galaxy job.",
      next: "Look for dates in the author-deposited metadata. Preserve the original and continue unaffected cohorts. Do not invent dates or silently drop taxa.",
    });
    Object.assign(data.stages[3], { state: "pending", label: "Dependency blocked" });
    data.issues = [
      {
        id: "demo-dates",
        stage: "prepare",
        state: "blocked",
        time: "Example",
        title: "Five taxa have no usable sampling date",
        impact:
          "The example cohort cannot enter the point-date analysis. Other independent cohorts are unaffected.",
        action:
          "Check author-deposited metadata; retain the cohort as blocked until every required date is supported.",
        tool: "Validator example",
        excerpt: "Illustrative validation result: missing_sampling_date; affected_taxa_count: 5",
      },
    ];
  }
  if (name === "stale") {
    data.state = "pending";
    data.label = "Updates unavailable";
    data.summary =
      "Updates are unavailable in this example. The last recorded outputs remain visible; current progress is unknown.";
    data.freshness =
      "Example disconnection · Last example checkpoint: 19:49 · No current activity is inferred";
    data.provenance = "EXAMPLE DISCONNECTION · FIXTURE DATA";
    data.chat =
      "I cannot establish current progress from a disconnected feed. Activity retains the last recorded state and evidence until updates resume.";
    data.disclosure =
      "The connection loss, underlying stages, and errors are all illustrative fixtures.";
  }
  if (name === "empty") {
    Object.assign(data, {
      current: null,
      state: "pending",
      label: "No activity",
      title: "Analysis flow",
      summary: "No named work has been recorded in this example.",
      freshness: "Example empty state",
      provenance: "EXAMPLE ONLY",
      stages: [],
      issues: [],
      history: null,
      artifacts: {},
      chat: "The flow will appear as work is recorded. A separate plan is not needed just to show what happened.",
      disclosure: "Empty-state example. No analysis is started and no plan is generated.",
    });
  }
  return data;
}

function selectStage(id, scroll = false) {
  selected = id;
  renderStages();
  renderDetail();
  if (scroll) $("#stage-detail").scrollIntoView({ block: "nearest" });
}

function renderStages() {
  $("#stage-flow").replaceChildren(
    ...model.stages.map((stage, index) => {
      const row = el("li");
      const button = el("button", "stage-node");
      button.type = "button";
      button.dataset.stage = stage.id;
      button.setAttribute("aria-pressed", String(selected === stage.id));
      button.setAttribute("aria-controls", "stage-detail");
      button.setAttribute("aria-label", `${stage.title}: ${stage.label}`);
      const top = el("span", "node-top");
      const glyph = el("span", `node-glyph ${stage.state}`, look[stage.state]);
      glyph.setAttribute("aria-hidden", "true");
      top.append(glyph, el("span", "node-ordinal", String(index + 1).padStart(2, "0")));
      button.append(
        top,
        el("span", "node-title", stage.title),
        el("span", `node-state ${stage.state}`, stage.label),
      );
      button.addEventListener("click", () => {
        selectStage(stage.id);
        $(`[data-stage="${stage.id}"]`).focus({ preventScroll: true });
      });
      row.append(button);
      return row;
    }),
  );
}

function issueCard(issue, showStage = false) {
  const card = el("article", `issue-card ${issue.state}`);
  card.dataset.issue = issue.id;
  const top = el("div", "issue-top");
  top.append(el("strong", "", issue.title), el("span", "issue-meta", issue.time));
  const status =
    issue.state === "recovered"
      ? "Workaround recorded"
      : issue.state === "blocked"
        ? "Blocked"
        : "Outcome unverified";
  card.append(
    top,
    el("p", "", `${status} · ${issue.impact}`),
    el("p", "issue-action", issue.action),
  );
  const details = el("details");
  details.append(el("summary", "", "Inspect recorded error"));
  details.append(
    el("pre", "", `${issue.tool}${issue.callId ? ` · ${issue.callId}` : ""}\n${issue.excerpt}`),
  );
  card.append(details);
  if (issue.artifact && model.artifacts[issue.artifact])
    card.append(link(model.artifacts[issue.artifact]));
  if (showStage) {
    const stage = model.stages.find((s) => s.id === issue.stage);
    const jump = el("button", "issue-jump", `Show stage: ${stage.title} →`);
    jump.type = "button";
    jump.addEventListener("click", () => {
      selectStage(stage.id, true);
      $("#stage-detail h2").focus({ preventScroll: true });
    });
    card.append(jump);
  }
  return card;
}

function renderDetail() {
  const stage = model.stages.find((s) => s.id === selected);
  if (!stage) return;
  const heading = el("div", "detail-heading");
  const title = el("h2", "", stage.title);
  title.tabIndex = -1;
  heading.append(title, el("span", `state-badge ${stage.state}`, stage.label));
  const evidence = el("div", "detail-row");
  evidence.append(el("span", "detail-label", "Evidence"), el("span", "", stage.evidence));
  const next = el("div", "next-check");
  next.append(el("strong", "", "Next check"), el("span", "", stage.next));
  const artifacts = el("div", "artifact-links");
  for (const key of stage.artifacts)
    if (model.artifacts[key]) artifacts.append(link(model.artifacts[key]));
  $("#stage-detail").replaceChildren(
    heading,
    el("p", "detail-lede", stage.summary),
    evidence,
    next,
    artifacts,
  );
  const issues = model.issues.filter((i) => i.stage === stage.id);
  if (issues.length) {
    const section = el("div", "stage-issues");
    section.append(
      el(
        "h3",
        "",
        `${issues.length} recorded ${issues.length === 1 ? "issue" : "issues"} in this stage`,
      ),
    );
    section.append(...issues.map((i) => issueCard(i)));
    $("#stage-detail").append(section);
  }
}

function renderIssues() {
  const visible = model.issues.filter(
    (i) => $("#include-recovered").checked || i.state !== "recovered",
  );
  const groups = [];
  for (const stage of model.stages) {
    const issues = visible.filter((i) => i.stage === stage.id);
    if (!issues.length) continue;
    groups.push(
      el("h3", "issues-group-title", stage.title),
      ...issues.map((i) => issueCard(i, true)),
    );
  }
  if (!groups.length) groups.push(el("p", "section-copy", "No issues match this view."));
  $("#issues-list").replaceChildren(...groups);
  $("#issue-count").textContent = `${visible.length} shown · ${model.issues.length} recorded`;
}

function render(name) {
  model = scenario(name);
  selected = model.current;
  $("#analysis-title").textContent = model.title;
  $("#provenance-label").textContent = model.provenance;
  $("#overall-state").className = `state-badge ${model.state}`;
  $("#overall-state").textContent = model.label;
  $("#current-summary").textContent = model.summary;
  $("#freshness").textContent = model.freshness;
  $("#freshness").className = `freshness ${name === "stale" ? "stale" : ""}`;
  $("#chat-summary").textContent = model.chat;
  $("#disclosure").textContent = model.disclosure;
  $("#footer-source").textContent =
    name === "returned" || name === "queued"
      ? "Example data · no live feed"
      : "Example data · no live feed";
  $("#empty-state").hidden = !!model.stages.length;
  $("#flow-work").hidden = !model.stages.length;
  $("#show-current").hidden = !model.stages.length;
  $("#issues-drawer").open = false;
  const recovered = model.issues.filter((i) => i.state === "recovered").length;
  const unverified = model.issues.filter((i) => i.state === "unknown").length;
  const blocked = model.issues.filter((i) => i.state === "blocked").length;
  const issueText = blocked
    ? `${blocked} blocker · the affected cohort cannot advance`
    : `${unverified} earlier errors need verification · ${recovered} upload workaround recorded`;
  const issueButton = el("button", "", "Inspect issues →");
  issueButton.type = "button";
  issueButton.addEventListener("click", () => {
    $("#issues-drawer").open = true;
    $("#issues-drawer").scrollIntoView({ block: "start" });
    $("#issues-drawer > summary").focus({ preventScroll: true });
  });
  $("#issue-strip").replaceChildren(el("span", "", issueText), issueButton);
  renderStages();
  renderDetail();
  renderIssues();
  const links = [];
  if (model.history) {
    const row = el("div", "galaxy-row");
    row.append(
      link({ label: model.history.name, url: model.history.url }),
      el("span", "", "Preparation history"),
    );
    links.push(row);
  } else
    links.push(el("p", "section-copy", "No real Galaxy artifacts are attached to this example."));
  $("#galaxy-links").replaceChildren(...links);
}

$("#theme").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme === "dark";
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  $("#theme").textContent = dark ? "Dark theme" : "Light theme";
});
$("#scenario").addEventListener("change", (e) => render(e.target.value));
$("#include-recovered").addEventListener("change", renderIssues);
$("#show-current").addEventListener("click", () => selectStage(model.current, true));
try {
  const response = await fetch("./fixture.json");
  if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`);
  snapshot = await response.json();
  render("returned");
} catch (error) {
  $("#current-summary").textContent = `The example preview could not load: ${error.message}`;
  $("#overall-state").textContent = "Preview unavailable";
  $("#flow-work").hidden = true;
  $("#scenario").disabled = true;
  $("#show-current").hidden = true;
  $("#disclosure").textContent =
    "The local example data could not be loaded. Serve the repository over HTTP and reload the preview.";
}
