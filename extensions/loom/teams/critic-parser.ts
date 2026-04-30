export interface CriticVerdict {
  approved: boolean;
  critique: string;
}

/**
 * Extract the last well-formed `{approved, critique}` JSON object from a
 * critic response. Falls back to `{approved: false, critique: <input>}` if
 * no valid object is found.
 */
export function parseCriticResponse(text: string): CriticVerdict {
  const matches = findJsonObjects(text);
  for (let i = matches.length - 1; i >= 0; i--) {
    const raw = matches[i];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isValidVerdict(parsed)) {
        return { approved: parsed.approved, critique: parsed.critique };
      }
    } catch {
      // try the next earlier candidate
    }
  }
  return { approved: false, critique: text };
}

function isValidVerdict(v: unknown): v is CriticVerdict {
  return (
    typeof v === "object" &&
    v !== null &&
    "approved" in v &&
    typeof (v as CriticVerdict).approved === "boolean" &&
    "critique" in v &&
    typeof (v as CriticVerdict).critique === "string"
  );
}

/**
 * Scan `text` for substrings that start with `{` and are balanced with their
 * closing `}`. Ignores braces inside double-quoted strings.
 */
function findJsonObjects(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i++;
      continue;
    }
    const end = scanBalancedBrace(text, i);
    if (end < 0) {
      i++;
      continue;
    }
    out.push(text.slice(i, end + 1));
    i = end + 1;
  }
  return out;
}

function scanBalancedBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = false;
        continue;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
