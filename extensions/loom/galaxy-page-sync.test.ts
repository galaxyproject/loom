import { describe, it, expect } from "vitest";
import {
  parsePageSyncMode,
  pageSlugForHistory,
  pageTitleForHistory,
  strippedNotebookBody,
  hasBodyChanged,
} from "./galaxy-page-sync.js";

describe("parsePageSyncMode", () => {
  it("is auto only for the exact 'auto' value", () => {
    expect(parsePageSyncMode({ LOOM_GALAXY_PAGE_SYNC: "auto" })).toBe("auto");
    expect(parsePageSyncMode({ LOOM_GALAXY_PAGE_SYNC: "1" })).toBe("off");
    expect(parsePageSyncMode({})).toBe("off");
  });
});

describe("pageSlugForHistory / pageTitleForHistory", () => {
  it("derives a stable per-history slug", () => {
    expect(pageSlugForHistory("abc123")).toBe("orbit-abc123");
  });
  it("derives a readable title", () => {
    expect(pageTitleForHistory("abc12345xyz")).toContain("abc12345");
  });
});

describe("strippedNotebookBody / hasBodyChanged", () => {
  it("removes the binding block and untrusted markers", () => {
    const content = ["# Notebook", "body line", "```loom-galaxy-page", "page_id: p1", "```"].join(
      "\n",
    );
    const stripped = strippedNotebookBody(content);
    expect(stripped).toContain("body line");
    expect(stripped).not.toContain("loom-galaxy-page");
    expect(stripped).not.toContain("page_id");
  });

  it("treats identical stripped bodies as unchanged (breaks self-trigger loop)", () => {
    expect(hasBodyChanged("same", "same")).toBe(false);
    expect(hasBodyChanged("old", "new")).toBe(true);
    expect(hasBodyChanged(null, "first")).toBe(true);
  });
});
