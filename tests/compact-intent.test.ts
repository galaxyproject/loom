import { describe, expect, it } from "vitest";
import { detectCompactIntent } from "../app/src/renderer/chat/compact-intent.js";

/**
 * Issue #171: users type "compact" into chat as plain text expecting the
 * conversation to shrink. The shell should detect that intent and nudge them
 * to the real `/compact` command. The detector must catch the real intent
 * (the two prompts from the bug report) without firing on bioinformatics
 * phrasing where "compact"/"reduce" mean something else.
 */
describe("detectCompactIntent", () => {
  describe("fires on real compaction intent", () => {
    const positives = [
      "compact",
      "Compact",
      "compact it",
      "compact now",
      "please compact",
      "compact conversation", // verbatim from the bug report
      "compact the conversation",
      "compact the context",
      "compact the chat",
      "Summarize everything up to this point in the notebook and compact the context so we can continue.", // verbatim from the bug report
      "reduce context",
      "can you reduce the context?",
      "shrink the conversation",
      "trim the chat context",
    ];
    for (const text of positives) {
      it(`fires on: ${JSON.stringify(text)}`, () => {
        expect(detectCompactIntent(text)).toBe(true);
      });
    }
  });

  describe("does not fire on unrelated or already-correct input", () => {
    const negatives = [
      "", // empty
      "/compact", // already the slash command
      "/compact keep the plan", // slash command with args
      "please run /compact for me", // references the command already
      "the assembly produced a compact genome", // compact = small genome
      "use a compact data structure", // compact = dense
      "compact the genome assembly", // compact + non-conversation object
      "reduce the number of reads to 1000", // reduce, but not the context
      "clear the Galaxy history", // history = Galaxy, not chat
      "summarize the results into the notebook", // summarize only, no compaction
      "what does compaction mean?", // a question, not a request
    ];
    for (const text of negatives) {
      it(`stays quiet on: ${JSON.stringify(text)}`, () => {
        expect(detectCompactIntent(text)).toBe(false);
      });
    }
  });
});
