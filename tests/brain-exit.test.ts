import { describe, it, expect } from "vitest";
import {
  EX_CONFIG,
  isConfigFailure,
  stderrTail,
  summarizeStartupFailure,
  appendStderr,
  STDERR_BUFFER_LIMIT,
} from "../shared/brain-exit.js";

/**
 * #439: Orbit treated every nonzero exit as a crash, so a missing credential
 * was retried three times and then reported as "crashed repeatedly" -- while
 * the brain's own explanation sat in a stderr buffer nobody read. These cover
 * the two decisions that fixes: is this worth retrying, and what do we show.
 */
describe("isConfigFailure", () => {
  it("claims only EX_CONFIG", () => {
    expect(EX_CONFIG).toBe(78);
    expect(isConfigFailure(78)).toBe(true);
    // 1 stays "something went wrong" -- an unhandled throw still earns a retry.
    expect(isConfigFailure(1)).toBe(false);
    expect(isConfigFailure(0)).toBe(false);
    expect(isConfigFailure(null)).toBe(false);
    expect(isConfigFailure(undefined)).toBe(false);
  });
});

describe("stderrTail", () => {
  it("keeps a whole short message intact", () => {
    const msg =
      'loom: provider "openai-codex" requires a sign-in.\n\n  * Sign in from Preferences.';
    expect(stderrTail(msg)).toBe(msg);
  });

  it("trims padding at the ends but keeps blank lines inside", () => {
    // The blank line separates the headline from the fix hint; losing it runs
    // the two together.
    expect(stderrTail("\n\nheadline\n\nhint\n\n")).toBe("headline\n\nhint");
  });

  it("takes the tail, since the fatal message is written last", () => {
    const noise = Array.from({ length: 50 }, (_, i) => `noise ${i}`).join("\n");
    const out = stderrTail(`${noise}\nloom: no credential`, { maxLines: 3 });
    expect(out).toBe("[...]\nnoise 48\nnoise 49\nloom: no credential");
    expect(out).not.toContain("noise 0");
  });

  it("marks truncation when the character cap bites", () => {
    const out = stderrTail("aaaa\nbbbb\ncccc", { maxChars: 6 });
    expect(out.startsWith("[...]")).toBe(true);
    expect(out).toContain("cccc");
  });

  it("caps a single line that is longer than the whole budget", () => {
    const out = stderrTail("x".repeat(500), { maxChars: 50 });
    expect(out).toBe(`[...]\n${"x".repeat(50)}`);
  });

  it("strips ANSI colour without eating bracketed prose", () => {
    // The regression guard: an unanchored pattern would swallow "[hint]".
    const coloured = "\u001b[31mloom: failed\u001b[0m see [hint] below";
    expect(stderrTail(coloured)).toBe("loom: failed see [hint] below");
  });

  it("answers empty for nothing usable", () => {
    expect(stderrTail("")).toBe("");
    expect(stderrTail("   \n\n  ")).toBe("");
    expect(stderrTail(undefined)).toBe("");
    expect(stderrTail(null)).toBe("");
  });
});

describe("summarizeStartupFailure", () => {
  it("prefers the brain's own words for the chat pane", () => {
    // The brain already knows which credential situation it hit and prints the
    // fix for that one; a generic shell message would be strictly worse.
    const stderr = 'The API key stored for "anthropic" could not be decrypted here.';
    expect(summarizeStartupFailure(EX_CONFIG, stderr).detail).toBe(stderr);
  });

  it("drops the argv0 prefix from the chat text too, not just the pill", () => {
    // The pill already stripped it, so leaving it on the detail showed one
    // sentence two different ways in the same window.
    const { summary, detail } = summarizeStartupFailure(
      EX_CONFIG,
      "loom: no LLM provider is configured.\n\n  * Open Preferences.",
    );
    expect(detail).toBe("No LLM provider is configured.\n\n  * Open Preferences.");
    expect(summary).toBe("No LLM provider is configured.");
  });

  it("leaves the wrapped continuation and hint untouched", () => {
    // Only line one carries the prefix; re-capitalizing further lines would
    // corrupt the brain's own formatting.
    const { detail } = summarizeStartupFailure(
      EX_CONFIG,
      "loom: the key could not be\ndecrypted here.\n\n  * export ANTHROPIC_API_KEY=...",
    );
    expect(detail).toBe(
      "The key could not be\ndecrypted here.\n\n  * export ANTHROPIC_API_KEY=...",
    );
  });

  it("unwraps the brain's terminal wrapping into one pill-sized line", () => {
    // The status pill renders a single run of text and its tooltip is taken
    // over by "Click to open Preferences", so line one alone would strand the
    // reader mid-sentence.
    const stderr = [
      'loom: the API key stored for provider "anthropic" could not be',
      "decrypted here, so no credential reached the agent.",
      "",
      "  * Export the key for this shell.",
    ].join("\n");
    const { summary } = summarizeStartupFailure(EX_CONFIG, stderr);
    expect(summary).toBe(
      'The API key stored for provider "anthropic" could not be decrypted here, so no credential reached the agent.',
    );
    // The fix hint is a separate paragraph -- chat's job, not the pill's.
    expect(summary).not.toContain("Export the key");
  });

  it("caps a runaway summary but keeps the detail whole", () => {
    const { summary, detail } = summarizeStartupFailure(EX_CONFIG, `loom: ${"a".repeat(400)}`);
    expect(summary.length).toBeLessThanOrEqual(163);
    expect(summary.endsWith("...")).toBe(true);
    // The detail keeps every character the brain wrote; only the "loom: "
    // prefix goes, and the letter it exposed is capitalized.
    expect(detail).toBe(`A${"a".repeat(399)}`);
  });

  it("falls back to a credential hint when a config exit says nothing", () => {
    const { summary, detail } = summarizeStartupFailure(EX_CONFIG, "");
    expect(summary).toContain("no usable LLM credential");
    expect(detail).toBe(summary);
  });

  it("names the code when an ordinary crash says nothing", () => {
    expect(summarizeStartupFailure(1, "").detail).toBe(
      "The agent exited with code 1 without reporting a reason.",
    );
  });
});

describe("appendStderr", () => {
  it("accumulates below the limit", () => {
    expect(appendStderr("one\n", "two\n")).toBe("one\ntwo\n");
    expect(appendStderr("", "first")).toBe("first");
  });

  it("discards from the front once the window is full", () => {
    // The end is the part that explains a failure, so the front is what goes.
    const out = appendStderr("x".repeat(100), "TAIL", 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith("TAIL")).toBe(true);
  });

  it("keeps a long-running session from growing without bound", () => {
    let buf = "";
    for (let i = 0; i < 500; i++) buf = appendStderr(buf, "pi: chatter on stderr\n");
    expect(buf.length).toBeLessThanOrEqual(STDERR_BUFFER_LIMIT);
  });

  it("survives a nullish buffer or chunk", () => {
    expect(appendStderr(undefined as never, "x")).toBe("x");
    expect(appendStderr("x", undefined as never)).toBe("x");
  });
});
