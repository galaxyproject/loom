// Galaxy directive arguments that name an object by something other than its encoded id. Galaxy
// resolves a directive's id when the page renders, so `history_dataset_id=3` (a hid) or
// `history_id=my-history` is saved without complaint and then embeds nothing. Catching it before
// the write is the only point where the model can still be told. Kept in step with the browser's
// galaxy-ops fork by browser/core/src/agent/parity.test.ts, so both shells refuse the same pages.

const ID_ARGUMENTS = [
  "history_id",
  "workflow_id",
  "history_dataset_id",
  "history_dataset_collection_id",
  "job_id",
  "implicit_collection_jobs_id",
  "invocation_id",
];
const ID_ARGUMENT = new RegExp(`\\b(${ID_ARGUMENTS.join("|")})\\s*=\\s*["']?([^\\s,)"']+)`, "g");
// Galaxy encodes an id as one or more 16-hex-digit blocks, lowercase.
const ENCODED_ID = /^(?:[0-9a-f]{16})+$/;
// A ```galaxy fenced block, or an inline ${galaxy ...} directive.
const DIRECTIVES = /^```[ \t]*galaxy[^\n]*\n[\s\S]*?^```|\$\{galaxy\s[^}]*\}/gm;

/**
 * Each id argument inside a Galaxy directive whose value is not an encoded id, as `name=value`,
 * in page order. Text outside directives is never read: prose may mention a hid freely.
 * @param {string | null | undefined} content
 * @returns {string[]}
 */
export function malformedObjectIds(content) {
  /** @type {string[]} */
  const found = [];
  for (const directive of (content ?? "").match(DIRECTIVES) ?? []) {
    for (const [, name, value] of directive.matchAll(ID_ARGUMENT)) {
      if (!ENCODED_ID.test(value)) found.push(`${name}=${value}`);
    }
  }
  return found;
}
