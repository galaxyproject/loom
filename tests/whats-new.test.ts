import { describe, it, expect } from "vitest";
import {
  parseChangelog,
  selectEntries,
  decideWhatsNew,
  releaseUrlFor,
  formatHighlightsText,
} from "../shared/whats-new.js";

const SAMPLE = `# Changelog

All notable changes are documented here.

## [0.5.0] - 2026-07-01

### Highlights

- Faster workflow invocation
- New thing two

### Added

- Internal-only note that must not appear

## [0.4.0] - 2026-06-10

### Highlights

- Gemini geo-block fixed
* Bulleted with an asterisk

## [0.3.5] - 2026-06-01

### Added

- A version with no Highlights section -- skipped
`;

describe("parseChangelog", () => {
  it("extracts only ### Highlights bullets, newest first", () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries.map((e) => e.version)).toEqual(["0.5.0", "0.4.0"]);
    expect(entries[0]).toEqual({
      version: "0.5.0",
      date: "2026-07-01",
      highlights: ["Faster workflow invocation", "New thing two"],
    });
    expect(entries[1].highlights).toEqual(["Gemini geo-block fixed", "Bulleted with an asterisk"]);
  });

  it("skips versions with no Highlights section", () => {
    expect(parseChangelog(SAMPLE).some((e) => e.version === "0.3.5")).toBe(false);
  });

  it("handles a missing date and CRLF line endings", () => {
    const entries = parseChangelog("## [1.0.0]\r\n\r\n### Highlights\r\n\r\n- One\r\n");
    expect(entries).toEqual([{ version: "1.0.0", date: undefined, highlights: ["One"] }]);
  });

  it("returns [] for empty or junk input", () => {
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("no headers here")).toEqual([]);
  });
});

describe("decideWhatsNew", () => {
  const all = parseChangelog(SAMPLE);

  it("fresh install: stamps silently, shows nothing", () => {
    expect(decideWhatsNew(all, undefined, "0.5.0", "accumulate")).toEqual({
      stamp: "0.5.0",
      entries: [],
    });
  });

  it("same version: no stamp, no entries", () => {
    expect(decideWhatsNew(all, "0.5.0", "0.5.0", "accumulate")).toEqual({
      stamp: null,
      entries: [],
    });
  });

  it("downgrade / dev: no stamp, no entries", () => {
    expect(decideWhatsNew(all, "0.5.0", "0.4.0", "accumulate")).toEqual({
      stamp: null,
      entries: [],
    });
  });

  it("single bump accumulates the running version's entry", () => {
    const d = decideWhatsNew(all, "0.4.0", "0.5.0", "accumulate");
    expect(d.stamp).toBe("0.5.0");
    expect(d.entries.map((e) => e.version)).toEqual(["0.5.0"]);
  });

  it("multi-version skip accumulates every entry in (lastSeen, running]", () => {
    const d = decideWhatsNew(all, "0.3.0", "0.5.0", "accumulate");
    expect(d.entries.map((e) => e.version)).toEqual(["0.5.0", "0.4.0"]);
  });

  it("latest mode returns only the running version's entry", () => {
    const d = decideWhatsNew(all, "0.3.0", "0.5.0", "latest");
    expect(d.entries.map((e) => e.version)).toEqual(["0.5.0"]);
  });
});

describe("selectEntries (latest, for /whatsnew)", () => {
  const all = parseChangelog(SAMPLE);
  it("returns the running version's entry regardless of lastSeen", () => {
    expect(selectEntries(all, undefined, "0.4.0", "latest").map((e) => e.version)).toEqual([
      "0.4.0",
    ]);
  });
  it("returns [] when the running version has no entry", () => {
    expect(selectEntries(all, undefined, "9.9.9", "latest")).toEqual([]);
  });
  it("returns [] when the running version is not valid semver", () => {
    expect(selectEntries(all, undefined, "dev", "latest")).toEqual([]);
  });
});

describe("releaseUrlFor", () => {
  it("builds the tag URL and tolerates a leading v", () => {
    expect(releaseUrlFor("0.5.0")).toBe(
      "https://github.com/galaxyproject/loom/releases/tag/v0.5.0",
    );
    expect(releaseUrlFor("v0.5.0")).toBe(
      "https://github.com/galaxyproject/loom/releases/tag/v0.5.0",
    );
  });
});

describe("formatHighlightsText", () => {
  it("renders a version header and indented bullets", () => {
    const text = formatHighlightsText([{ version: "0.5.0", highlights: ["A", "B"] }]);
    expect(text).toBe("What's new in 0.5.0\n  - A\n  - B");
  });
  it("returns an empty string for no entries", () => {
    expect(formatHighlightsText([])).toBe("");
  });
});
