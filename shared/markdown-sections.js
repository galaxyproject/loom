// A markdown page cut at its heading lines, the way a section edit to a Galaxy page addresses it.
// Orbit's update_page bridge, its stale-hash repair and the evidence gate all cut a page here, so
// a section edit writes, compares and is judged on the same bytes. A section holds its
// subsections, and a "# comment" in fenced code is not a heading: otherwise section_content that
// carries its own "### Steps" would leave the old one behind, and a fenced shell comment would
// cut a section mid-fence. section_content with no subsection headings of its own rewrites only
// the section's lead, the text above its first subsection, so an intro edit under a page's "#"
// title cannot wipe every plan beneath it. tests/page-markdown-fixtures.test.ts pins the cuts.

const HEADING = /^(#{1,6})\s/;
// A backtick fence's info string holds no backtick (CommonMark), so "```x``` is code" is prose.
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * Every heading outside fenced code, with the line span its section covers: from the heading to
 * the line before the next heading of the same or a higher level.
 * @param {string[]} lines
 * @returns {{ heading: string, level: number, start: number, end: number }[]}
 */
function headingSpans(lines) {
  /** @type {{ heading: string, level: number, start: number, end: number }[]} */
  const spans = [];
  /** @type {string | null} */
  let fence = null;
  lines.forEach((line, i) => {
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      return;
    }
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      fence = marker;
      return;
    }
    const level = HEADING.exec(line)?.[1].length;
    if (level === undefined) return;
    for (const open of spans) {
      if (open.end === lines.length - 1 && open.start < i && open.level >= level) open.end = i - 1;
    }
    spans.push({ heading: line, level, start: i, end: lines.length - 1 });
  });
  return spans;
}

/**
 * Why a section edit under `heading` cannot go ahead on `content`, or undefined when the page
 * holds that heading at most once. Replacing every match would overwrite one plan's "### Steps"
 * with another's, so a repeated heading is refused and the model is pointed at the unique heading
 * above it.
 * @param {string | null | undefined} content
 * @param {string} heading
 * @returns {string | undefined}
 */
export function repeatedHeadingRefusal(content, heading) {
  const spans = headingSpans((content ?? "").split("\n"));
  const matches = spans.filter((s) => s.heading === heading);
  if (matches.length < 2) return undefined;
  const parents = matches
    .map((m) => spans.filter((s) => s.start < m.start && s.end >= m.end && s.level < m.level).pop())
    .map((p) => (p ? JSON.stringify(p.heading) : null));
  const unique = parents.every((p, i) => p !== null && parents.indexOf(p) === i);
  return (
    `The page has ${matches.length} sections headed ${JSON.stringify(heading)}, so a section ` +
    `edit cannot tell which one you mean. ` +
    (unique
      ? `Send section_heading as the heading of the section that holds it (one of ${parents.join(", ")}) `
      : `Send section_heading as a heading the page holds once, above the one you mean, `) +
    `and section_content as that whole section, its subsections included.`
  );
}

/**
 * `original` with the section headed exactly `heading` replaced by `section`, subsections and
 * all, or with `section` appended when the page has no such heading. A `section` that carries no
 * heading below its first line replaces only the lead and keeps the old subsections. Throws when the heading is
 * repeated (see repeatedHeadingRefusal); callers refuse before getting here.
 * @param {string | null | undefined} original
 * @param {string} heading
 * @param {string} section
 * @returns {string}
 */
export function applySectionEdit(original, heading, section) {
  const refused = repeatedHeadingRefusal(original, heading);
  if (refused) throw new Error(refused);
  if (!original) return section;
  const lines = original.split("\n");
  const spans = headingSpans(lines);
  const span = spans.find((s) => s.heading === heading);
  if (!span) return `${original}\n${section}`;
  const child = spans.find((s) => s.start > span.start && s.start <= span.end);
  const leadOnly =
    child !== undefined && !headingSpans(section.split("\n")).some((s) => s.start > 0);
  const end = leadOnly ? child.start - 1 : span.end;
  return [
    ...(span.start > 0 ? [lines.slice(0, span.start).join("\n")] : []),
    section,
    ...(end < lines.length - 1 ? [lines.slice(end + 1).join("\n")] : []),
  ].join("\n");
}

/**
 * The content of each section headed exactly `heading`, subsections included, in page order:
 * what a section edit would replace.
 * @param {string | null | undefined} content
 * @param {string} heading
 * @returns {string[]}
 */
export function sectionsHeaded(content, heading) {
  if (!content) return [];
  const lines = content.split("\n");
  return headingSpans(lines)
    .filter((s) => s.heading === heading)
    .map((s) => lines.slice(s.start, s.end + 1).join("\n"));
}
