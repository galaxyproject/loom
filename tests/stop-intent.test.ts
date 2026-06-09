import { describe, expect, it } from "vitest";
import { detectStopIntent } from "../app/src/renderer/chat/stop-intent.js";

/**
 * Issue #225: with a slow model, a tester tried to halt a long "thinking" turn
 * by typing "stop what you are doing" / "abort thinking" into chat. Those just
 * queued as the next prompt instead of stopping anything. The shell should read
 * a bare stop command typed during an active turn as an abort.
 *
 * The detector must catch the real intent (the two prompts from the bug report)
 * without firing on real instructions that merely contain "stop"/"abort"/
 * "cancel" -- including bioinformatics phrasing ("stop codon") and Galaxy
 * actions ("cancel the workflow invocation"). False negatives are cheap (the
 * now-labeled Stop button is still right there); false positives abort a turn
 * the user wanted, so we err quiet.
 */
describe("detectStopIntent", () => {
  describe("fires on a bare stop command", () => {
    const positives = [
      "stop",
      "Stop",
      "stop.",
      "stop!",
      "stop it",
      "stop now",
      "stop please",
      "please stop",
      "stop thinking", // verbatim-ish from the bug report ("abort thinking")
      "stop responding",
      "stop generating",
      "stop the response",
      "stop what you are doing", // verbatim from the bug report
      "stop what you're doing",
      "stop what you’re doing", // macOS smart-quote apostrophe (U+2019)
      "abort",
      "abort it",
      "abort thinking", // verbatim from the bug report
      "cancel",
      "halt",
      "STOP NOW",
      "  stop  ", // surrounding whitespace
    ];
    for (const text of positives) {
      it(`fires on: ${JSON.stringify(text)}`, () => {
        expect(detectStopIntent(text)).toBe(true);
      });
    }
  });

  describe("stays quiet on real instructions and unrelated input", () => {
    const negatives = [
      "", // empty
      "/stop", // a slash command, never a chat intent
      "stop the FastQC tool from running on every sample", // real instruction
      "cancel the workflow invocation in Galaxy", // real Galaxy action
      "cancel that job", // deictic + object: a Galaxy action, not a halt
      "stop that", // deictic "that" deliberately excluded
      "abort the upload and use the local file instead", // real instruction
      "how do I abort a running job?", // a question
      "find the stop codon in this sequence", // biology, not a command
      "don't stop until all samples are processed", // negated
      "the reads stop at position 50", // descriptive
      "please cancel my last galaxy job and rerun it", // real instruction
      "stop and summarize what you found so far", // continuation, not a pure halt
    ];
    for (const text of negatives) {
      it(`stays quiet on: ${JSON.stringify(text)}`, () => {
        expect(detectStopIntent(text)).toBe(false);
      });
    }
  });
});
