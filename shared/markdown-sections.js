// A markdown page cut at its heading lines, the way a section edit to a Galaxy page addresses it.
// Orbit's update_page bridge and the browser's galaxy-ops fork must cut a page identically: the
// same section edit has to write the same bytes in either shell, or a content_hash one shell
// computed after a write would never match what the other reads back. Fenced code is not special
// for the same reason -- the fork does not treat it so, and neither does Galaxy's page editor.
// browser/core/src/agent/parity.test.ts holds this module to the fork.

const HEADING = /^#{1,6}\s/;

/**
 * The page's sections in order. Each runs from its heading line to the line before the next
 * heading; text above the first heading is a section whose heading is "". Joining every
 * section's content with "\n" gives back the page.
 * @param {string | null | undefined} content
 * @returns {{ heading: string, content: string }[]}
 */
export function markdownSections(content) {
  if (!content) return [];
  /** @type {{ heading: string, content: string }[]} */
  const sections = [];
  let heading = "";
  /** @type {string[]} */
  let lines = [];
  content.split("\n").forEach((line, i) => {
    if (!HEADING.test(line)) {
      lines.push(line);
      return;
    }
    // A heading on the first line opens the first section rather than closing an empty one.
    if (i > 0) sections.push({ heading, content: lines.join("\n") });
    heading = line;
    lines = [line];
  });
  if (lines.length > 0) sections.push({ heading, content: lines.join("\n") });
  return sections;
}

/**
 * `original` with every section whose heading line is exactly `heading` replaced by `section`,
 * or with `section` appended when none has it. Every match is replaced because a page can repeat
 * a heading, and leaving one copy stale would be a silent half-edit.
 * @param {string | null | undefined} original
 * @param {string} heading
 * @param {string} section
 * @returns {string}
 */
export function applySectionEdit(original, heading, section) {
  let found = false;
  const parts = markdownSections(original).map((s) => {
    if (s.heading !== heading) return s.content;
    found = true;
    return section;
  });
  if (!found) parts.push(section);
  return parts.join("\n");
}

/**
 * The content of each section headed exactly `heading`, in page order: what a section edit
 * would replace.
 * @param {string | null | undefined} content
 * @param {string} heading
 * @returns {string[]}
 */
export function sectionsHeaded(content, heading) {
  return markdownSections(content)
    .filter((s) => s.heading === heading)
    .map((s) => s.content);
}
