import { describe, expect, it } from "vitest";

import { pageContentHash } from "../shared/page-content-hash.js";

// Orbit's page record store and its update_page bridge version a page with this hash, and a saved
// expect_hash compares against it, so a change here strands every version already handed out. It
// was held to the browser's galaxy-ops fork's contentHash while that fork shipped; these are the
// values both gave.
describe("pageContentHash", () => {
  const section = "## Results\n\n```galaxy\nhistory_dataset_display(history_dataset_id=abc)\n```\n";
  it.each([
    ["an empty page", "", "00001505"],
    ["ascii markdown", "# Title\n\nplain text, *emphasis*, `code`\n", "14b06f02"],
    ["astral code points", "dna \u{1F9EC} and a \u{1F600} face", "e0de7627"],
    [
      "a multi-section page",
      `# Record\n\n## Plan\n\n- [ ] 1. step\n\n${section}\n${section}`,
      "53f26584",
    ],
  ])("is unchanged for %s", async (_name, body, hash) => {
    expect(await pageContentHash(body)).toBe(hash);
  });
});
