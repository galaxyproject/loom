/**
 * The reproduction index: the one place ambient lesson injection is justified.
 *
 * A deterministic matcher reaches tool ids, hostnames, file extensions and the
 * wording of a plan step. It cannot answer "is this a reproduction of published
 * work?" -- and that is the motivating case with no failing tool result to
 * hook. Deposited metadata being incomplete is not an error; it is a silently
 * wrong answer three steps later.
 *
 * So, bounded: when the session looks like a reproduction, put the
 * `reproduction/*` lesson TITLES AND IDS -- a handful of lines, rebuilt each
 * turn on the per-turn channel, nothing in the cached prefix -- in front of
 * the model and let it pull bodies with `lessons_search`.
 *
 * Records nothing. It is an index that re-renders every turn, and a
 * `lesson.surfaced` row per listed title per turn would flood the activity log
 * and overstate what happened. The surfacing is recorded when the model
 * actually pulls a body.
 */

import { parseMostRecentPlan } from "../init-gate.js";
import { recordStore } from "../record-store";
import { getNotebookPath } from "../state";
import { isLessonsEnabled } from "./enabled";
import { isMatchable } from "./matcher";
import { getLessonStore } from "./store";
import { collapse } from "./text";
import type { Lesson } from "./types";
import { wrapLessons } from "./wrapper";

/** customType for the per-turn lesson index, beside the two in context.ts. */
export const LOOM_LESSONS_CONTEXT_TYPE = "loom-lessons-context";

const REPRODUCTION_PREFIX = "reproduction/";
const REPRODUCING = /reproduc/i;
const MAX_LINES = 10;

/**
 * The stage heuristic, such as it is: there is no phase-like session state, so
 * the only signals are what the user just said and what the latest plan is
 * called.
 */
export function looksLikeReproduction(lastUserText: string, planTitle: string | null): boolean {
  return REPRODUCING.test(lastUserText) || REPRODUCING.test(planTitle ?? "");
}

export async function currentPlanTitle(): Promise<string | null> {
  const notebook = getNotebookPath();
  if (!notebook) return null;
  try {
    return parseMostRecentPlan((await recordStore(notebook).read()).content)?.title ?? null;
  } catch {
    return null;
  }
}

export function renderReproductionIndex(lessons: readonly Lesson[]): string {
  const rows = lessons
    .filter((l) => l.id.startsWith(REPRODUCTION_PREFIX))
    .filter(isMatchable)
    .slice(0, MAX_LINES);
  if (rows.length === 0) return "";

  return wrapLessons(
    [
      "This session looks like a reproduction of published work. Lessons have",
      "been recorded about reproductions; here are their ids and titles only.",
      "",
      ...rows.map((l) => `- ${l.id} -- ${collapse(l.title)}`),
      "",
      "Read one in full by passing its id as the lessons_search query before",
      "relying on it. A title is not advice -- do not act on one without reading",
      'the lesson\'s "Check first" line.',
    ].join("\n"),
  );
}

export async function buildReproductionLessonsContext(lastUserText: string): Promise<string> {
  // The store is empty with the switch off; gating here also spares the record read.
  if (!isLessonsEnabled()) return "";
  if (!looksLikeReproduction(lastUserText, await currentPlanTitle())) return "";
  return renderReproductionIndex(getLessonStore().lessons);
}
