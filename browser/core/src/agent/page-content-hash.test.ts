import { contentHash } from "@galaxyproject/galaxy-ops/browser";
import { describe, expect, it } from "vitest";

import { pageContentHash } from "../../../../shared/page-content-hash.js";

// Orbit's page record store versions a page with shared/page-content-hash.js; the model's own
// update_page goes through galaxy-ops and compares against its contentHash. The two must agree
// byte for byte, or a version Orbit took is refused by the tool and vice versa.
describe("pageContentHash", () => {
  const section = "## Results\n\n```galaxy\nhistory_dataset_display(history_dataset_id=abc)\n```\n";
  it.each([
    ["an empty page", ""],
    ["ascii markdown", "# Title\n\nplain text, *emphasis*, `code`\n"],
    ["astral code points", "dna \u{1F9EC} and a \u{1F600} face"],
    ["a multi-section page", `# Record\n\n## Plan\n\n- [ ] 1. step\n\n${section}\n${section}`],
  ])("matches galaxy-ops' contentHash for %s", (_name, body) => {
    expect(pageContentHash(body)).toBe(contentHash({ content_editor: body }));
  });
});
