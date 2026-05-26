/**
 * Tool-name confusables hint -- STOPGAP, see #100 + `confusables.ts`.
 *
 * Hooks `message_end` for tool-result messages. When pi-agent-core's
 * exact-match dispatch fails because the LLM emitted a Cyrillic/Greek
 * lookalike in the tool name, the resulting tool-result message carries
 * `Tool <bad-name> not found` from agent-loop.js. We fold confusables
 * against the active tool list and, if there's a real match, append a
 * "Did you mean X?" hint so the agent recovers in one turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findConfusablesMatch } from "./confusables";

const NOT_FOUND_RE = /^Tool\s+(\S+)\s+not found\b/;

export function registerConfusablesHint(pi: ExtensionAPI): void {
  pi.on("message_end", (event) => {
    const msg = event.message;
    if (msg.role !== "toolResult" || !msg.isError) return;

    const badName = msg.toolName;
    if (!badName) return;

    const textBlock = msg.content.find(
      (c): c is { type: "text"; text: string } =>
        c.type === "text" && typeof (c as { text?: unknown }).text === "string",
    );
    if (!textBlock || !NOT_FOUND_RE.test(textBlock.text)) return;

    const match = findConfusablesMatch(badName, pi.getActiveTools());
    if (!match) return;

    const hint = `Did you mean \`${match}\`? The tool name you called contains Unicode confusables (visually similar non-Latin characters).`;
    const updatedContent = msg.content.map((c) =>
      c === textBlock ? { ...textBlock, text: `${textBlock.text}\n\n${hint}` } : c,
    );

    return { message: { ...msg, content: updatedContent } };
  });
}
