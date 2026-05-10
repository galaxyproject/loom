/**
 * Subset of extensions/loom/init-gate.ts's plan parser, scoped to what the
 * notebook assertions need. Once init-gate.ts is on main (PR #104) this can
 * be replaced with an import; in the meantime, behavior is intentionally
 * a faithful subset so scenarios written against this parser keep passing
 * after the swap.
 */

export type Routing = "local" | "galaxy" | "hybrid" | "remote" | "unknown";

export interface ParsedPlan {
  title: string;
  routing: Routing;
  pendingSteps: { line: number; raw: string; descriptionLength: number }[];
}

export function parseLatestPlan(content: string): ParsedPlan | null {
  const lines = content.split("\n");
  let latestPlanLine = -1;
  let latestPlanTitle = "";
  let latestPlanRouting: Routing = "unknown";

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(
      /^##\s+Plan\s+([^:]+):\s*(.+?)(?:\s*\[(local|galaxy|hybrid|remote)\])?\s*$/i,
    );
    if (m) {
      latestPlanLine = i;
      latestPlanTitle = `${m[1].trim()}: ${m[2].trim()}`;
      latestPlanRouting = (m[3]?.toLowerCase() as Routing) ?? "unknown";
    }
  }

  if (latestPlanLine === -1) return null;

  const pendingSteps: ParsedPlan["pendingSteps"] = [];
  for (let i = latestPlanLine + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    const stepMatch = lines[i].match(/^\s*-\s+\[\s\]\s+(.*)$/);
    if (stepMatch) {
      const subBullets = collectSubBullets(lines, i + 1);
      pendingSteps.push({
        line: i,
        raw: stepMatch[1],
        descriptionLength: measureStepDescription(stepMatch[1], subBullets),
      });
    }
  }

  return { title: latestPlanTitle, routing: latestPlanRouting, pendingSteps };
}

/**
 * Gather indented sub-bullet lines following the step's main line. Stops at
 * the next top-level `- [ ]` bullet, the next `##` section, a blank line that
 * terminates the step block, or end-of-content.
 */
function collectSubBullets(lines: string[], startIdx: number): string[] {
  const out: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) break;
    if (/^\s*-\s+\[[ x!]\]\s+/.test(line)) break; // next top-level step
    if (/^\s+-\s+/.test(line)) {
      out.push(line.replace(/^\s+-\s+/, "").trim());
      continue;
    }
    if (line.trim() === "") break;
    // any other shape (paragraph continuation) -- stop
    break;
  }
  return out;
}

/**
 * Measure the descriptive text attached to a step. Strips numeric prefix,
 * the bold-wrapped title, optional `{#anchor}`, and leading separators from
 * the main line; then concatenates indented sub-bullet content. Sub-bullets
 * count because some models put `Routing: <x>` and `Tool: <y>` there
 * instead of (or in addition to) a same-line description.
 */
function measureStepDescription(raw: string, subBullets: string[]): number {
  const sameLine = raw
    .replace(/^\d+\.\s*/, "")
    .replace(/\*\*[^*]+\*\*/, "")
    .replace(/\{#[^}]+\}/, "")
    .replace(/^[\s\-:|]+/, "")
    .trim();
  const subText = subBullets.join(" ").trim();
  return [sameLine, subText].filter(Boolean).join(" ").length;
}
