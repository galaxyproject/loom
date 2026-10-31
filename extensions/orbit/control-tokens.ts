/**
 * Harmony control tokens (`<|call|>`, `<|channel|>`...) that gpt-oss-family models sometimes leak
 * into a tool name or a result. A name cut at the first one is usually the tool meant; a result is
 * scrubbed of them before it is replayed, so the next request can't parse one as a call.
 */

const MARKER = "<|";

/** `name` up to the first control token. */
export const plainToolName = (name: string) => name.split(MARKER)[0].trim();

/** `text` without control tokens. */
export function withoutControlTokens(text: string): string {
  if (!text.includes(MARKER)) return text;
  return text
    .split(MARKER)
    .map((part, i) => {
      const end = part.indexOf("|>");
      return i && end >= 0 ? part.slice(end + 2) : part;
    })
    .join("");
}
