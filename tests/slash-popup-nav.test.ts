import { describe, expect, test } from "vitest";
import { shouldAcceptSlashCommandOnEnter } from "../app/src/renderer/slash-popup-nav.js";

// When the slash-command popup is open, Enter should accept the highlighted
// command and run it (Tab+Enter in one keystroke, issue #287). Opening the
// popup always highlights row 0, so the accept path is the normal case; the
// false cases below are the defensive guard (no items / out-of-range index)
// that lets Enter fall back to the normal submit path.
describe("shouldAcceptSlashCommandOnEnter", () => {
  test("accepts when the first row is highlighted", () => {
    expect(shouldAcceptSlashCommandOnEnter(0, 3)).toBe(true);
  });

  test("accepts when a later in-range row is highlighted", () => {
    expect(shouldAcceptSlashCommandOnEnter(2, 3)).toBe(true);
  });

  test("does not accept when nothing is highlighted (active -1)", () => {
    expect(shouldAcceptSlashCommandOnEnter(-1, 3)).toBe(false);
  });

  test("does not accept when there are no items", () => {
    expect(shouldAcceptSlashCommandOnEnter(0, 0)).toBe(false);
  });

  test("does not accept when the active index is past the last item", () => {
    expect(shouldAcceptSlashCommandOnEnter(3, 3)).toBe(false);
  });
});
