export const GTN_HOST: string;
export const GTN_BASE: string;
export const GTN_API: string;

export interface GtnTopic {
  name: string | null;
  title: string | null;
  summary: string | null;
}
export interface GtnTutorial {
  title: string | null;
  url: string;
  id: string | null;
  level: string | null;
  time_estimation: string | null;
  objectives: (string | null)[];
}

export function gtnPageText(html: string): string;
export function gtnTopics(
  data: unknown,
): { count: number; topics: GtnTopic[]; hint: string } | undefined;
export function gtnTutorials(
  data: unknown,
  query?: string,
):
  | { topic: string | null; count: number; query?: string; tutorials: GtnTutorial[]; hint: string }
  | undefined;
export function gtnUrl(
  url: string,
): { url: URL; problem?: never } | { url?: never; problem: string };
