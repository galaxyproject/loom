/**
 * Section edits and malformed-id findings on Galaxy page markdown, pinned as literals. They were
 * held to the browser's galaxy-ops fork while the browser ran its own brain; with the fork gone,
 * the shared helpers' answers are written out here instead (the last two section cases are where
 * Orbit's cut was always the one kept: a section holds its subsections, fenced code holds no
 * headings).
 */
import { describe, expect, it } from "vitest";

import { applySectionEdit } from "../shared/markdown-sections.js";
import { malformedObjectIds } from "../shared/malformed-object-ids.js";

const SECTION_CASES: [string, string, string, string, string][] = [
  [
    "a heading the page has",
    "# T\n\n## Plan\nold\n\n## Results\nr\n",
    "## Plan",
    "## Plan\nnew\n",
    "# T\n\n## Plan\nnew\n\n## Results\nr\n",
  ],
  [
    "a heading the page lacks",
    "# T\n\n## Plan\nold\n",
    "## Methods",
    "## Methods\nm",
    "# T\n\n## Plan\nold\n\n## Methods\nm",
  ],
  [
    "a heading on the first line",
    "## Plan\nold\n## Next\nn",
    "## Plan",
    "## Plan\nnew",
    "## Plan\nnew\n## Next\nn",
  ],
  [
    "text above the first heading",
    "intro\n\n## Plan\nold",
    "## Plan",
    "## Plan\nnew\n\n",
    "intro\n\n## Plan\nnew\n\n",
  ],
  ["trailing blank lines", "## Plan\nold\n\n\n", "## Plan", "## Plan\nnew\n", "## Plan\nnew\n"],
  ["an empty page", "", "## Plan", "## Plan\nfirst", "## Plan\nfirst"],
  [
    "lines that only look like headings",
    "#tag\n####### seven\n## Plan\nold",
    "## Plan",
    "## Plan\nnew",
    "#tag\n####### seven\n## Plan\nnew",
  ],
  [
    "a near-miss heading line",
    "## Plan \nold\n## Plan\nkeep",
    "## Plan",
    "## Plan\nnew",
    "## Plan \nold\n## Plan\nnew",
  ],
  [
    "a section with subsections",
    "## Plan A\nq\n### Steps\n- [ ] 1\n## Plan B\nb",
    "## Plan A",
    "## Plan A\nq\n### Steps\n- [x] 1",
    "## Plan A\nq\n### Steps\n- [x] 1\n## Plan B\nb",
  ],
  [
    "a heading inside fenced code",
    "## Plan\n```\n## Plan\n```\nold",
    "## Plan",
    "## Plan\nnew",
    "## Plan\nnew",
  ],
];

const DIRECTIVE_CASES: [string, string[]][] = [
  ["plain prose naming history_dataset_id=3 outside any directive", []],
  ["```galaxy\nhistory_dataset_display(history_dataset_id=3)\n```\n", ["history_dataset_id=3"]],
  ["```galaxy\nhistory_dataset_display(history_dataset_id=f2db41e1fa331b3e)\n```\n", []],
  [
    "```galaxy\nhistory_dataset_display(history_dataset_id=F2DB41E1FA331B3E)\n```\n",
    ["history_dataset_id=F2DB41E1FA331B3E"],
  ],
  ["```galaxy\njob_metrics(job_id=1cd8e2f6b131e8911cd8e2f6b131e891)\n```\n", []],
  [
    "```galaxy\nworkflow_display(workflow_id=\"abc\", history_id='my-history')\n```\n",
    ["workflow_id=abc", "history_id=my-history"],
  ],
  ["```  galaxy title\ninvocation_time(invocation_id = 12)\n```\n", ["invocation_id=12"]],
  ["```python\nhistory_id=3\n```\n", []],
  [
    "See ${galaxy history_dataset_as_image(history_dataset_id=hid:7)} and ${galaxy job_parameters(job_id=1cd8e2f6b131e891)}.",
    ["history_dataset_id=hid:7"],
  ],
  [
    "```galaxy\nhistory_dataset_collection_display(history_dataset_collection_id=1, implicit_collection_jobs_id=2)\n```\n```galaxy\nhistory_link(history_id=3)\n```",
    ["history_dataset_collection_id=1", "implicit_collection_jobs_id=2", "history_id=3"],
  ],
  ["", []],
];

describe("a section edit on page markdown", () => {
  it.each(SECTION_CASES)(
    "writes what it always wrote, for %s",
    (_name, body, heading, section, expected) => {
      expect(applySectionEdit(body, heading, section)).toBe(expected);
    },
  );
});

describe("malformed ids in page directives", () => {
  it.each(DIRECTIVE_CASES)("finds what it always found in %j", (content, expected) => {
    expect(malformedObjectIds(content)).toEqual(expected);
  });

  it("finds some in the fixtures, so the cases are not vacuous", () => {
    expect(DIRECTIVE_CASES.flatMap(([, ids]) => ids).length).toBeGreaterThan(5);
  });
});
