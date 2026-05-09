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
      pendingSteps.push({
        line: i,
        raw: stepMatch[1],
        descriptionLength: measureStepDescription(stepMatch[1]),
      });
    }
  }

  return { title: latestPlanTitle, routing: latestPlanRouting, pendingSteps };
}

function measureStepDescription(raw: string): number {
  return raw
    .replace(/^\d+\.\s*/, "")
    .replace(/\*\*[^*]+\*\*/, "")
    .replace(/\{#[^}]+\}/, "")
    .replace(/^[\s\-:|]+/, "")
    .trim().length;
}
